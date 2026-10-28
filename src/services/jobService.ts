import { PoolClient } from "pg";
import { getPool, getSchema } from "../db/connection";
import {
  CreateJobRequest,
  Job,
  JobStep,
  JobArtifact,
  JobOutput,
  JobStatusResponse,
} from "../types";
import {
  getRecipe,
  createRecipe,
  getRecipeByNameAndVersion,
} from "./recipeService";
import {
  getLatestDetailingByStep,
  getLatestDetailingByStepBatch,
} from "./jobStepDetailingService";
import { ValidationError } from "../utils/validation";
import { computeJobProgressPercentage } from "../utils/progress";
import { canRetry, deleteBlocker } from "../utils/jobs";
import { ConflictError } from "./runnerService";

export interface CreateJobResult {
  id: number;
  created: boolean;
}

const findJobByIdempotencyKey = async (key: string): Promise<number | null> => {
  const pool = getPool();
  const schema = getSchema();
  const result = await pool.query(
    `SELECT id FROM ${schema}.job WHERE idempotency_key = $1`,
    [key],
  );
  return result.rows.length > 0 ? result.rows[0].id : null;
};

export const createJob = async (
  req: CreateJobRequest,
  createdByKeyId: number | null = null,
): Promise<CreateJobResult> => {
  const pool = getPool();
  const schema = getSchema();

  // A job with this idempotency key already exists: return it, create nothing.
  if (req.idempotency_key) {
    const existingId = await findJobByIdempotencyKey(req.idempotency_key);
    if (existingId !== null) {
      return { id: existingId, created: false };
    }
  }

  let recipeId: number;

  // Handle recipe creation/lookup
  if (req.recipe_id) {
    // Use existing recipe by ID
    const recipe = await getRecipe(req.recipe_id);
    if (!recipe) {
      throw new Error(`Recipe with id ${req.recipe_id} not found`);
    }
    recipeId = req.recipe_id;
  } else if (req.recipe) {
    // Find or create recipe by name and version
    let recipe = await getRecipeByNameAndVersion(
      req.recipe.name,
      req.recipe.version,
    );
    if (!recipe) {
      if (!req.recipe.definition) {
        throw new Error(
          `Recipe "${req.recipe.name}@${req.recipe.version}" not found`,
        );
      }
      // Create new recipe
      recipeId = await createRecipe({
        name: req.recipe.name,
        version: req.recipe.version,
        definition: req.recipe.definition,
      });
    } else {
      recipeId = recipe.id;
    }
  } else {
    throw new Error(
      "Either recipe_id or recipe (name, version, definition) must be provided",
    );
  }

  // Get the recipe for validation
  const recipe = await getRecipe(recipeId);
  if (!recipe) {
    throw new Error(`Recipe with id ${recipeId} not found`);
  }

  // Validate that all required initial inputs are provided
  const recipeSteps = recipe.definition.recipe;
  const allArtifactNames = new Set<string>();
  const allOutputs = new Set<string>();

  for (const step of recipeSteps) {
    // Collect artifact names from inputs (slot -> artifact mapping)
    for (const artifactName of Object.values(step.inputs)) {
      allArtifactNames.add(artifactName);
    }
    Object.values(step.outputs).forEach((o) => allOutputs.add(o));
  }

  // Initial inputs are artifact names that are not produced by any step
  const initialInputs = new Set<string>();
  for (const artifactName of allArtifactNames) {
    if (!allOutputs.has(artifactName)) {
      initialInputs.add(artifactName);
    }
  }

  // Check that all initial inputs are provided
  for (const requiredInput of initialInputs) {
    if (!req.inputs[requiredInput]) {
      throw new ValidationError(
        `Missing required initial input artifact: ${requiredInput}`,
      );
    }
  }

  // Check that no extra inputs are provided (only required initial inputs)
  const providedInputs = new Set(Object.keys(req.inputs));
  for (const providedInput of providedInputs) {
    if (!initialInputs.has(providedInput)) {
      throw new ValidationError(
        `Unexpected input artifact "${providedInput}": not required by recipe. Required inputs: ${Array.from(
          initialInputs,
        ).join(", ")}`,
      );
    }
  }

  // Validate job outputs if provided
  if (req.outputs) {
    const requestedOutputs = Object.keys(req.outputs);
    for (const artifactName of requestedOutputs) {
      if (!allOutputs.has(artifactName)) {
        throw new ValidationError(
          `Invalid job output "${artifactName}": artifact is not producible by recipe. Producible artifacts: ${Array.from(
            allOutputs,
          ).join(", ")}`,
        );
      }
    }
  }

  // Validate job params: for each step with required_params, required keys must be present
  const jobParams = req.params ?? {};
  for (const step of recipeSteps) {
    const requiredKeys = step.param_keys ?? [];
    if (requiredKeys.length === 0) {
      continue;
    }
    const provided = jobParams[step.id];
    for (const paramName of requiredKeys) {
      if (provided === undefined || !(paramName in provided)) {
        throw new ValidationError(
          `Missing required param "${paramName}" for step "${step.id}"`,
        );
      }
    }
  }

  // Validate on_exit params
  const onExit = recipe.definition.on_exit;
  if (onExit) {
    const requiredKeys = onExit.param_keys ?? [];
    const provided = jobParams[onExit.id];
    for (const paramName of requiredKeys) {
      if (provided === undefined || !(paramName in provided)) {
        throw new ValidationError(
          `Missing required param "${paramName}" for on_exit step "${onExit.id}"`,
        );
      }
    }
  }

  // Begin transaction
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Create job
    const jobParamsJson = JSON.stringify(jobParams);
    const jobResult = await client.query(
      `INSERT INTO ${schema}.job (recipe_id, status, params, idempotency_key, created_by_key_id, priority)
       VALUES ($1, 'pending', $2::jsonb, $3, $4, $5)
       RETURNING id`,
      [recipeId, jobParamsJson, req.idempotency_key ?? null, createdByKeyId, req.priority ?? 0],
    );
    const jobId = jobResult.rows[0].id;

    // Insert initial artifacts
    // Strip the "job:" namespace prefix before persisting — DB names are bare.
    // Identity in the DB is (name, producer_step); inputs always have producer_step=NULL.
    for (const [namespacedName, artifact] of Object.entries(req.inputs)) {
      const name = namespacedName.startsWith("job:")
        ? namespacedName.slice(4)
        : namespacedName;
      if (name.includes(":")) {
        throw new ValidationError(
          `Invalid artifact name "${namespacedName}": names stored in the database must not contain namespace prefixes`,
        );
      }
      await client.query(
        `INSERT INTO ${schema}.job_artifact
         (job_id, name, type, uri, hash, producer_step, metadata)
         VALUES ($1, $2, $3, $4, $5, NULL, $6)
         ON CONFLICT (job_id, name) DO NOTHING`,
        [
          jobId,
          name,
          artifact.type,
          artifact.uri,
          artifact.hash,
          artifact.metadata ? JSON.stringify(artifact.metadata) : null,
        ],
      );
    }

    // Insert all recipe steps as pending
    for (const step of recipeSteps) {
      await client.query(
        `INSERT INTO ${schema}.job_step
         (job_id, step_id, step_type, status, attempt, max_concurrency,
          max_attempts, lease_seconds, requires)
         VALUES ($1, $2, $3, 'pending', 0, $4, $5, $6, $7::jsonb)`,
        [
          jobId,
          step.id,
          step.type,
          step.max_concurrency ?? null,
          step.max_attempts ?? null,
          step.lease_seconds ?? null,
          step.requires ? JSON.stringify(step.requires) : null,
        ],
      );
    }

    // Insert job outputs if provided
    if (req.outputs) {
      for (const [artifactName, output] of Object.entries(req.outputs)) {
        await client.query(
          `INSERT INTO ${schema}.job_output (job_id, artifact_name, path)
           VALUES ($1, $2, $3)`,
          [jobId, artifactName, output.path],
        );
      }
    }

    await client.query("COMMIT");
    return { id: jobId, created: true };
  } catch (error) {
    await client.query("ROLLBACK");
    // Two schedulers raced on the same idempotency key: the other one won.
    if (
      req.idempotency_key &&
      (error as { code?: string }).code === "23505"
    ) {
      const existingId = await findJobByIdempotencyKey(req.idempotency_key);
      if (existingId !== null) {
        return { id: existingId, created: false };
      }
    }
    throw error;
  } finally {
    client.release();
  }
};

export const getJobStatus = async (
  jobId: number
): Promise<JobStatusResponse | null> => {
  const pool = getPool();
  const schema = getSchema();

  // Get job
  const jobResult = await pool.query(
    `SELECT id, recipe_id, status, created_at, started_at, finished_at, error, params, idempotency_key, priority
     FROM ${schema}.job
     WHERE id = $1`,
    [jobId],
  );

  if (jobResult.rows.length === 0) {
    return null;
  }

  const jobRow = jobResult.rows[0];
  const job: Job = {
    id: jobRow.id,
    recipe_id: jobRow.recipe_id,
    status: jobRow.status,
    created_at: jobRow.created_at,
    started_at: jobRow.started_at,
    finished_at: jobRow.finished_at,
    error: jobRow.error,
    params: jobRow.params ?? {},
    idempotency_key: jobRow.idempotency_key ?? null,
    priority: jobRow.priority ?? 0,
  };

  // Get steps
  const stepsResult = await pool.query(
    `SELECT job_id, step_id, step_type, status, attempt, claimed_by, claimed_at,
            started_at, finished_at, error, max_concurrency,
            blocked_until, lease_expires_at, max_attempts, lease_seconds, requires
     FROM ${schema}.job_step
     WHERE job_id = $1
     ORDER BY step_id`,
    [jobId]
  );

  const detailingByStep = await getLatestDetailingByStep(jobId);

  const steps: JobStep[] = stepsResult.rows.map((row) => ({
    job_id: row.job_id,
    step_id: row.step_id,
    step_type: row.step_type,
    status: row.status,
    attempt: row.attempt,
    claimed_by: row.claimed_by,
    claimed_at: row.claimed_at,
    started_at: row.started_at,
    finished_at: row.finished_at,
    error: row.error,
    max_concurrency: row.max_concurrency,
    blocked_until: row.blocked_until ?? null,
    lease_expires_at: row.lease_expires_at ?? null,
    max_attempts: row.max_attempts ?? null,
    lease_seconds: row.lease_seconds ?? null,
    requires: row.requires ?? null,
    last_detailing: detailingByStep.get(row.step_id) ?? null,
  }));

  // Get artifacts
  const artifactsResult = await pool.query(
    `SELECT job_id, name, type, uri, hash, producer_step, metadata, created_at
     FROM ${schema}.job_artifact
     WHERE job_id = $1
     ORDER BY name`,
    [jobId]
  );

  const artifacts: JobArtifact[] = artifactsResult.rows.map((row) => ({
    job_id: row.job_id,
    name: row.name,
    type: row.type,
    uri: row.uri,
    hash: row.hash,
    producer_step: row.producer_step,
    metadata: row.metadata,
    created_at: row.created_at,
  }));

  // Get outputs
  const outputsResult = await pool.query(
    `SELECT job_id, artifact_name, path, delivered_uri, delivered_at, created_at
     FROM ${schema}.job_output
     WHERE job_id = $1
     ORDER BY artifact_name`,
    [jobId]
  );

  const outputs: JobOutput[] = outputsResult.rows.map((row) => ({
    job_id: row.job_id,
    artifact_name: row.artifact_name,
    path: row.path,
    delivered_uri: row.delivered_uri,
    delivered_at: row.delivered_at,
    created_at: row.created_at,
  }));

  // Compute progress
  const completed_steps = steps.filter(
    (s) => s.status === "success" || s.status === "failed"
  ).length;
  const total_steps = steps.length;
  const progress = {
    percentage: computeJobProgressPercentage(steps),
    completed_steps,
    total_steps,
  };

  // Compute job-level duration_ms
  const duration_ms =
    job.started_at && job.finished_at
      ? new Date(job.finished_at).getTime() - new Date(job.started_at).getTime()
      : null;

  // Build timeline sorted by started_at ascending
  const timeline = [...steps]
    .sort((a, b) => {
      if (!a.started_at && !b.started_at) return 0;
      if (!a.started_at) return 1;
      if (!b.started_at) return -1;
      return new Date(a.started_at).getTime() - new Date(b.started_at).getTime();
    })
    .map((s) => ({
      step: s.step_id,
      type: s.step_type,
      status: s.status,
      started_at: s.started_at,
      finished_at: s.finished_at,
      duration_ms:
        s.started_at && s.finished_at
          ? new Date(s.finished_at).getTime() - new Date(s.started_at).getTime()
          : null,
    }));

  return { job, progress, duration_ms, timeline, steps, artifacts, outputs };
};

export const getJobsBatch = async (
  jobIds: number[]
): Promise<Map<number, JobStatusResponse>> => {
  const pool = getPool();
  const schema = getSchema();

  const jobsResult = await pool.query(
    `SELECT id, recipe_id, status, created_at, started_at, finished_at, error, params, idempotency_key, priority
     FROM ${schema}.job
     WHERE id = ANY($1::int[])`,
    [jobIds]
  );

  const stepsResult = await pool.query(
    `SELECT job_id, step_id, step_type, status, attempt, claimed_by, claimed_at,
            started_at, finished_at, error, max_concurrency,
            blocked_until, lease_expires_at, max_attempts, lease_seconds, requires
     FROM ${schema}.job_step
     WHERE job_id = ANY($1::int[])
     ORDER BY job_id, step_id`,
    [jobIds]
  );

  const artifactsResult = await pool.query(
    `SELECT job_id, name, type, uri, hash, producer_step, metadata, created_at
     FROM ${schema}.job_artifact
     WHERE job_id = ANY($1::int[])
     ORDER BY job_id, name`,
    [jobIds]
  );

  const outputsResult = await pool.query(
    `SELECT job_id, artifact_name, path, delivered_uri, delivered_at, created_at
     FROM ${schema}.job_output
     WHERE job_id = ANY($1::int[])
     ORDER BY job_id, artifact_name`,
    [jobIds]
  );

  const detailingByJob = await getLatestDetailingByStepBatch(jobIds);

  const stepsByJob = new Map<number, JobStep[]>();
  for (const row of stepsResult.rows) {
    if (!stepsByJob.has(row.job_id)) stepsByJob.set(row.job_id, []);
    stepsByJob.get(row.job_id)!.push({
      job_id: row.job_id,
      step_id: row.step_id,
      step_type: row.step_type,
      status: row.status,
      attempt: row.attempt,
      claimed_by: row.claimed_by,
      claimed_at: row.claimed_at,
      started_at: row.started_at,
      finished_at: row.finished_at,
      error: row.error,
      max_concurrency: row.max_concurrency,
      blocked_until: row.blocked_until ?? null,
      lease_expires_at: row.lease_expires_at ?? null,
      max_attempts: row.max_attempts ?? null,
      lease_seconds: row.lease_seconds ?? null,
      requires: row.requires ?? null,
      last_detailing: detailingByJob.get(row.job_id)?.get(row.step_id) ?? null,
    });
  }

  const artifactsByJob = new Map<number, JobArtifact[]>();
  for (const row of artifactsResult.rows) {
    if (!artifactsByJob.has(row.job_id)) artifactsByJob.set(row.job_id, []);
    artifactsByJob.get(row.job_id)!.push({
      job_id: row.job_id,
      name: row.name,
      type: row.type,
      uri: row.uri,
      hash: row.hash,
      producer_step: row.producer_step,
      metadata: row.metadata,
      created_at: row.created_at,
    });
  }

  const outputsByJob = new Map<number, JobOutput[]>();
  for (const row of outputsResult.rows) {
    if (!outputsByJob.has(row.job_id)) outputsByJob.set(row.job_id, []);
    outputsByJob.get(row.job_id)!.push({
      job_id: row.job_id,
      artifact_name: row.artifact_name,
      path: row.path,
      delivered_uri: row.delivered_uri,
      delivered_at: row.delivered_at,
      created_at: row.created_at,
    });
  }

  const result = new Map<number, JobStatusResponse>();

  for (const row of jobsResult.rows) {
    const job: Job = {
      id: row.id,
      recipe_id: row.recipe_id,
      status: row.status,
      created_at: row.created_at,
      started_at: row.started_at,
      finished_at: row.finished_at,
      error: row.error,
      params: row.params ?? {},
      idempotency_key: row.idempotency_key ?? null,
      priority: row.priority ?? 0,
    };

    const steps = stepsByJob.get(job.id) ?? [];
    const artifacts = artifactsByJob.get(job.id) ?? [];
    const outputs = outputsByJob.get(job.id) ?? [];

    const completed_steps = steps.filter(
      (s) => s.status === "success" || s.status === "failed"
    ).length;
    const total_steps = steps.length;
    const progress = {
      percentage: computeJobProgressPercentage(steps),
      completed_steps,
      total_steps,
    };

    const duration_ms =
      job.started_at && job.finished_at
        ? new Date(job.finished_at).getTime() - new Date(job.started_at).getTime()
        : null;

    const timeline = [...steps]
      .sort((a, b) => {
        if (!a.started_at && !b.started_at) return 0;
        if (!a.started_at) return 1;
        if (!b.started_at) return -1;
        return new Date(a.started_at).getTime() - new Date(b.started_at).getTime();
      })
      .map((s) => ({
        step: s.step_id,
        type: s.step_type,
        status: s.status,
        started_at: s.started_at,
        finished_at: s.finished_at,
        duration_ms:
          s.started_at && s.finished_at
            ? new Date(s.finished_at).getTime() - new Date(s.started_at).getTime()
            : null,
      }));

    result.set(job.id, { job, progress, duration_ms, timeline, steps, artifacts, outputs });
  }

  return result;
};

export const JOB_STATUSES = ["pending", "running", "success", "failed"] as const;
export const MAX_LIST_LIMIT = 100_000;

/**
 * Filters for `GET /jobs` and `GET /jobs/counts`. Every field is optional and they combine
 * with AND; without any, the list is every job, newest first, as before.
 */
export interface ListJobsFilter {
  idempotency_key?: string;
  /** One status or several (any of). */
  status?: string | string[];
  /** Idempotency key starts with any of these. */
  key_prefix?: string[];
  /** ISO timestamps, inclusive. */
  created_after?: string;
  finished_after?: string;
  /** By id; default "desc" (newest first). */
  order?: "asc" | "desc";
  /** At most this many rows; absent means no limit. */
  limit?: number;
}

export class JobFilterError extends Error {}

function listOf(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : [value];
  return raw
    .flatMap((v) => String(v).split(","))
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

function timestamp(name: string, value: unknown): string {
  const text = String(value);
  if (Number.isNaN(Date.parse(text))) {
    throw new JobFilterError(`${name} must be an ISO timestamp, got ${JSON.stringify(text)}`);
  }
  return new Date(text).toISOString();
}

/** The filter from a request's query string; throws JobFilterError on a malformed value. */
export function parseJobFilter(query: Record<string, unknown>): ListJobsFilter {
  const filter: ListJobsFilter = {};
  if (query.idempotency_key !== undefined) filter.idempotency_key = String(query.idempotency_key);
  if (query.status !== undefined) {
    const statuses = listOf(query.status);
    if (statuses.length === 0) throw new JobFilterError("status is empty");
    filter.status = statuses.length === 1 ? statuses[0] : statuses;
  }
  if (query.key_prefix !== undefined) {
    const prefixes = listOf(query.key_prefix);
    if (prefixes.length === 0) throw new JobFilterError("key_prefix is empty");
    if (prefixes.length > 100) throw new JobFilterError("at most 100 key prefixes");
    filter.key_prefix = prefixes;
  }
  if (query.created_after !== undefined) filter.created_after = timestamp("created_after", query.created_after);
  if (query.finished_after !== undefined) filter.finished_after = timestamp("finished_after", query.finished_after);
  if (query.order !== undefined) {
    const order = String(query.order).toLowerCase();
    if (order !== "asc" && order !== "desc") throw new JobFilterError("order must be asc or desc");
    filter.order = order;
  }
  if (query.limit !== undefined) {
    const limit = Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
      throw new JobFilterError(`limit must be an integer from 1 to ${MAX_LIST_LIMIT}`);
    }
    filter.limit = limit;
  }
  return filter;
}

/** `LIKE` treats % and _ as wildcards; a key prefix must match literally. */
function likePrefix(prefix: string): string {
  return prefix.replace(/[\\%_]/g, (c) => `\\${c}`) + "%";
}

/** The WHERE clause (with a leading space, or empty) and its parameters for a filter. */
export function jobWhere(filter: ListJobsFilter): { where: string; params: unknown[] } {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (filter.idempotency_key !== undefined) {
    params.push(filter.idempotency_key);
    conditions.push(`idempotency_key = $${params.length}`);
  }
  if (filter.status !== undefined) {
    const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
    params.push(statuses);
    conditions.push(`status = ANY($${params.length}::text[])`);
  }
  if (filter.key_prefix && filter.key_prefix.length > 0) {
    params.push(filter.key_prefix.map(likePrefix));
    conditions.push(`idempotency_key LIKE ANY($${params.length}::text[])`);
  }
  if (filter.created_after !== undefined) {
    params.push(filter.created_after);
    conditions.push(`created_at >= $${params.length}`);
  }
  if (filter.finished_after !== undefined) {
    params.push(filter.finished_after);
    conditions.push(`finished_at >= $${params.length}`);
  }
  return { where: conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "", params };
}

export const listJobs = async (filter: ListJobsFilter = {}): Promise<Job[]> => {
  const pool = getPool();
  const schema = getSchema();
  const { where, params } = jobWhere(filter);
  let tail = ` ORDER BY id ${filter.order === "asc" ? "ASC" : "DESC"}`;
  if (filter.limit !== undefined) {
    params.push(filter.limit);
    tail += ` LIMIT $${params.length}`;
  }
  const result = await pool.query(
    `SELECT id, recipe_id, status, created_at, started_at, finished_at, error, idempotency_key, priority
     FROM ${schema}.job${where}${tail}`,
    params.length ? params : undefined,
  );
  return result.rows.map((row) => ({
    id: row.id,
    recipe_id: row.recipe_id,
    status: row.status,
    created_at: row.created_at,
    started_at: row.started_at,
    finished_at: row.finished_at,
    error: row.error,
    idempotency_key: row.idempotency_key ?? null,
    priority: row.priority ?? 0,
  }));
};

export interface JobCounts {
  total: number;
  by_status: Record<string, number>;
}

/** How many jobs match the filter, per status (`order` and `limit` are ignored). */
export const countJobs = async (filter: ListJobsFilter = {}): Promise<JobCounts> => {
  const pool = getPool();
  const schema = getSchema();
  const { where, params } = jobWhere({ ...filter, order: undefined, limit: undefined });
  const result = await pool.query(
    `SELECT status, COUNT(*)::int AS n FROM ${schema}.job${where} GROUP BY status`,
    params.length ? params : undefined,
  );
  const by_status: Record<string, number> = Object.fromEntries(JOB_STATUSES.map((s) => [s, 0]));
  let total = 0;
  for (const row of result.rows) {
    by_status[row.status] = Number(row.n);
    total += Number(row.n);
  }
  return { total, by_status };
};

export interface RetryJobResult {
  id: number;
  status: "pending";
  priority: number;
  steps_reset: string[];
}

/**
 * Requeues a failed job under its own id and idempotency key: the failed step and the steps
 * skipped because of it go back to `pending` with the attempt counter cleared; succeeded
 * steps keep their artifacts, so the job resumes where it broke. Returns null when the job
 * does not exist and throws ConflictError when it is not failed.
 */
export const retryJob = async (
  jobId: number,
  priority?: number,
): Promise<RetryJobResult | null> => {
  const pool = getPool();
  const schema = getSchema();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const job = await client.query(
      `SELECT id, status, priority FROM ${schema}.job WHERE id = $1 FOR UPDATE`,
      [jobId],
    );
    if (job.rows.length === 0) {
      await client.query("ROLLBACK");
      return null;
    }
    if (!canRetry(job.rows[0].status)) {
      throw new ConflictError(`Job is ${job.rows[0].status}, not failed`);
    }
    const reset = await client.query(
      `UPDATE ${schema}.job_step
       SET status = 'pending', attempt = 0, error = NULL, claimed_by = NULL, claimed_at = NULL,
           started_at = NULL, finished_at = NULL, lease_token = NULL, lease_expires_at = NULL,
           blocked_until = NULL
       WHERE job_id = $1 AND status IN ('failed', 'skipped')
       RETURNING step_id`,
      [jobId],
    );
    const newPriority = priority ?? job.rows[0].priority ?? 0;
    await client.query(
      `UPDATE ${schema}.job
       SET status = 'pending', error = NULL, started_at = NULL, finished_at = NULL, priority = $2
       WHERE id = $1`,
      [jobId, newPriority],
    );
    await client.query("COMMIT");
    return {
      id: jobId,
      status: "pending",
      priority: newPriority,
      steps_reset: reset.rows.map((r) => r.step_id),
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

export interface DeleteJobResult {
  id: number;
  idempotency_key: string | null;
  deleted: true;
}

/** Removes a job's rows in dependency order; `job_step_detailing` cascades from `job_step`. */
async function deleteJobRows(client: PoolClient, schema: string, jobIds: number[]): Promise<void> {
  if (jobIds.length === 0) return;
  for (const table of ["job_output", "job_artifact", "job_step"]) {
    await client.query(`DELETE FROM ${schema}.${table} WHERE job_id = ANY($1::int[])`, [jobIds]);
  }
  await client.query(`DELETE FROM ${schema}.job WHERE id = ANY($1::int[])`, [jobIds]);
}

/**
 * Deletes a job none of whose steps has started (every step `pending` or `blocked`). The step
 * rows are locked `FOR UPDATE` first, so a runner claiming at the same moment skips them
 * (`claim` uses `SKIP LOCKED`) or, if it already holds them, finishes before the check runs
 * and the check sees the step running. Returns null when the job does not exist and throws
 * ConflictError when it cannot be deleted.
 */
export const deleteJob = async (jobId: number): Promise<DeleteJobResult | null> => {
  const pool = getPool();
  const schema = getSchema();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const job = await client.query(
      `SELECT id, status, idempotency_key FROM ${schema}.job WHERE id = $1 FOR UPDATE`,
      [jobId],
    );
    if (job.rows.length === 0) {
      await client.query("ROLLBACK");
      return null;
    }
    const steps = await client.query(
      `SELECT step_id, status FROM ${schema}.job_step WHERE job_id = $1 ORDER BY step_id FOR UPDATE`,
      [jobId],
    );
    const blocker = deleteBlocker(job.rows[0].status, steps.rows);
    if (blocker) throw new ConflictError(blocker);
    await deleteJobRows(client, schema, [jobId]);
    await client.query("COMMIT");
    return { id: jobId, idempotency_key: job.rows[0].idempotency_key ?? null, deleted: true };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

export interface DeleteJobsResult {
  /** Ids of the jobs deleted, ascending. */
  deleted: number[];
  /** Jobs matching the filter that were left alone because a step had started or finished. */
  skipped: number;
}

/**
 * Bulk form of deleteJob for `DELETE /jobs?key_prefix=…`: deletes every matching job none of
 * whose steps has started and counts the rest as skipped, in one transaction. `key_prefix` is
 * required so a call can never empty the table by accident; `order` and `limit` are ignored.
 */
export const deleteJobs = async (filter: ListJobsFilter): Promise<DeleteJobsResult> => {
  if (!filter.key_prefix || filter.key_prefix.length === 0) {
    throw new JobFilterError("key_prefix is required to delete jobs in bulk");
  }
  const pool = getPool();
  const schema = getSchema();
  const { where, params } = jobWhere({ ...filter, order: undefined, limit: undefined });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const jobs = await client.query(
      `SELECT id, status FROM ${schema}.job${where} ORDER BY id FOR UPDATE`,
      params,
    );
    const ids: number[] = jobs.rows.map((r) => Number(r.id));
    if (ids.length === 0) {
      await client.query("COMMIT");
      return { deleted: [], skipped: 0 };
    }
    const steps = await client.query(
      `SELECT job_id, step_id, status FROM ${schema}.job_step WHERE job_id = ANY($1::int[])
       ORDER BY job_id, step_id FOR UPDATE`,
      [ids],
    );
    const stepsByJob = new Map<number, { step_id: string; status: string }[]>();
    for (const row of steps.rows) {
      const list = stepsByJob.get(Number(row.job_id)) ?? [];
      list.push({ step_id: row.step_id, status: row.status });
      stepsByJob.set(Number(row.job_id), list);
    }
    const deletable = jobs.rows
      .filter((r) => deleteBlocker(r.status, stepsByJob.get(Number(r.id)) ?? []) === null)
      .map((r) => Number(r.id));
    await deleteJobRows(client, schema, deletable);
    await client.query("COMMIT");
    return { deleted: deletable, skipped: ids.length - deletable.length };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};
