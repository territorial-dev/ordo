import { PoolClient } from "pg";
import { randomBytes } from "crypto";
import { getPool, getSchema } from "../db/connection";
import {
  ClaimRequest,
  ClaimedStep,
  CompleteRequest,
  FailRequest,
  StepDefinition,
} from "../types";
import { matchesCapabilities } from "../utils/capabilities";
import { decideFailure, isStepReady, producerOf } from "../utils/readiness";

/** Raised for lease mismatches and state conflicts; mapped to HTTP 409. */
export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}

/** Raised for malformed runner requests; mapped to HTTP 400. */
export class RunnerRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunnerRequestError";
  }
}

const CANDIDATE_LIMIT = 50;

interface StepRow {
  job_id: number;
  step_id: string;
  step_type: string;
  status: string;
  attempt: number;
  max_concurrency: number | null;
  requires: Record<string, unknown> | null;
  lease_seconds: number | null;
  lease_token: string | null;
  exec_requires: Record<string, unknown>;
  exec_lease_seconds: number;
  exec_max_attempts: number;
  step_max_attempts: number | null;
  executor_ref: string | null;
  produces: Record<string, string>;
  job_status: string;
  job_params: Record<string, Record<string, any>> | null;
  idempotency_key: string | null;
  definition: { recipe: StepDefinition[] };
}

const STEP_SELECT = (schema: string) => `
  SELECT js.job_id, js.step_id, js.step_type, js.status, js.attempt, js.max_concurrency,
         js.requires, js.lease_seconds, js.lease_token, js.max_attempts AS step_max_attempts,
         se.requires AS exec_requires, se.lease_seconds AS exec_lease_seconds,
         se.max_attempts AS exec_max_attempts, se.executor_ref, se.produces,
         j.status AS job_status, j.params AS job_params, j.idempotency_key, r.definition
  FROM ${schema}.job_step js
  JOIN ${schema}.step_executor se ON se.step_type = js.step_type
  JOIN ${schema}.job j ON j.id = js.job_id
  JOIN ${schema}.recipe r ON r.id = j.recipe_id`;

const stepDefinition = (row: StepRow): StepDefinition => {
  const def = row.definition?.recipe?.find((s) => s.id === row.step_id);
  if (!def) {
    throw new Error(`Step "${row.step_id}" not found in recipe of job ${row.job_id}`);
  }
  return def;
};

// ---------------------------------------------------------------------------
// claim
// ---------------------------------------------------------------------------

export const claimStep = async (req: ClaimRequest): Promise<ClaimedStep | null> => {
  const pool = getPool();
  const schema = getSchema();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const stepTypes =
      Array.isArray(req.step_types) && req.step_types.length > 0 ? req.step_types : null;

    const candidates = await client.query(
      `${STEP_SELECT(schema)}
       WHERE se.runner = 'api'
         AND j.status IN ('pending', 'running')
         AND (js.status = 'pending'
              OR (js.status = 'blocked' AND js.blocked_until IS NOT NULL AND js.blocked_until <= now()))
         AND ($1::text[] IS NULL OR js.step_type = ANY($1::text[]))
       ORDER BY js.job_id, js.step_id
       LIMIT ${CANDIDATE_LIMIT}
       FOR UPDATE OF js SKIP LOCKED`,
      [stepTypes],
    );

    const statusCache = new Map<number, Map<string, string>>();
    const runningCache = new Map<string, number>();

    let chosen: StepRow | null = null;
    let chosenDef: StepDefinition | null = null;
    for (const row of candidates.rows as StepRow[]) {
      const def = stepDefinition(row);

      if (!matchesCapabilities(row.requires ?? row.exec_requires, req.capabilities)) continue;

      if (!statusCache.has(row.job_id)) {
        const statuses = await client.query(
          `SELECT step_id, status FROM ${schema}.job_step WHERE job_id = $1`,
          [row.job_id],
        );
        statusCache.set(
          row.job_id,
          new Map(statuses.rows.map((s) => [s.step_id, s.status])),
        );
      }
      if (!isStepReady(def, statusCache.get(row.job_id)!)) continue;

      if (row.max_concurrency !== null) {
        if (!runningCache.has(row.step_type)) {
          const running = await client.query(
            `SELECT count(*)::int AS n FROM ${schema}.job_step
             WHERE step_type = $1 AND status = 'running'`,
            [row.step_type],
          );
          runningCache.set(row.step_type, running.rows[0].n);
        }
        if (runningCache.get(row.step_type)! >= row.max_concurrency) continue;
      }

      chosen = row;
      chosenDef = def;
      break;
    }

    if (!chosen || !chosenDef) {
      await client.query("COMMIT");
      return null;
    }

    const leaseSeconds =
      chosen.lease_seconds ??
      (typeof req.lease_seconds === "number" && req.lease_seconds > 0
        ? Math.floor(req.lease_seconds)
        : chosen.exec_lease_seconds);
    const leaseToken = randomBytes(24).toString("base64url");

    const updated = await client.query(
      `UPDATE ${schema}.job_step
       SET status = 'running', claimed_by = $3, claimed_at = now(), started_at = now(),
           attempt = attempt + 1, lease_token = $4, lease_seconds = $5,
           lease_expires_at = now() + ($5::int * interval '1 second'),
           blocked_until = NULL, error = NULL, finished_at = NULL
       WHERE job_id = $1 AND step_id = $2
       RETURNING attempt, lease_expires_at`,
      [chosen.job_id, chosen.step_id, req.worker_id, leaseToken, leaseSeconds],
    );

    await client.query(
      `UPDATE ${schema}.job
       SET status = 'running', started_at = COALESCE(started_at, now())
       WHERE id = $1 AND status = 'pending'`,
      [chosen.job_id],
    );

    const inputs = await resolveInputs(client, schema, chosen.job_id, chosenDef);

    await client.query("COMMIT");

    const jobParams = chosen.job_params ?? {};
    return {
      job_id: chosen.job_id,
      step_id: chosen.step_id,
      step_type: chosen.step_type,
      attempt: updated.rows[0].attempt,
      lease_token: leaseToken,
      lease_expires_at: updated.rows[0].lease_expires_at,
      lease_seconds: leaseSeconds,
      executor_ref: chosen.executor_ref,
      inputs,
      params: jobParams[chosen.step_id] ?? {},
      job: { id: chosen.job_id, idempotency_key: chosen.idempotency_key, params: jobParams },
      credentials: null,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

/**
 * Resolves a step's input slots to registered artifacts. `job:<name>` inputs are stored
 * bare (producer NULL); step outputs are stored under their full `step:<id>.<slot>` name
 * by the runner API, or under the bare slot with producer_step by legacy runners.
 */
const resolveInputs = async (
  client: PoolClient,
  schema: string,
  jobId: number,
  def: StepDefinition,
): Promise<ClaimedStep["inputs"]> => {
  const artifacts = await client.query(
    `SELECT name, type, uri, hash, metadata, producer_step
     FROM ${schema}.job_artifact WHERE job_id = $1`,
    [jobId],
  );
  const byName = new Map<string, any>();
  const byProducerSlot = new Map<string, any>();
  for (const a of artifacts.rows) {
    byName.set(a.name, a);
    if (a.producer_step) byProducerSlot.set(`${a.producer_step}.${a.name}`, a);
  }

  const inputs: ClaimedStep["inputs"] = {};
  for (const [slot, ref] of Object.entries(def.inputs)) {
    let found: any = null;
    if (ref.startsWith("job:")) {
      found = byName.get(ref.slice(4)) ?? byName.get(ref);
    } else {
      found = byName.get(ref);
      if (!found) {
        const producer = producerOf(ref);
        const outSlot = ref.slice(ref.indexOf(".") + 1);
        found = byProducerSlot.get(`${producer}.${outSlot}`);
      }
    }
    if (!found) {
      throw new Error(`Input "${ref}" for slot "${slot}" is not registered on job ${jobId}`);
    }
    inputs[slot] = { type: found.type, uri: found.uri, hash: found.hash, metadata: found.metadata ?? null };
  }
  return inputs;
};

// ---------------------------------------------------------------------------
// heartbeat
// ---------------------------------------------------------------------------

export const heartbeatStep = async (
  jobId: number,
  stepId: string,
  leaseToken: string,
  progress: Record<string, any> | undefined,
  log: string | undefined,
): Promise<{ lease_expires_at: Date }> => {
  const pool = getPool();
  const schema = getSchema();
  const result = await pool.query(
    `UPDATE ${schema}.job_step
     SET lease_expires_at = now() + (COALESCE(lease_seconds, 300) * interval '1 second')
     WHERE job_id = $1 AND step_id = $2 AND lease_token = $3 AND status = 'running'
     RETURNING lease_expires_at`,
    [jobId, stepId, leaseToken],
  );
  if (result.rows.length === 0) {
    throw new ConflictError("Lease token does not match the current lease");
  }
  if (progress !== undefined || log !== undefined) {
    await pool.query(
      `INSERT INTO ${schema}.job_step_detailing (job_id, step_id, log, progress)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [jobId, stepId, log ?? null, progress !== undefined ? JSON.stringify(progress) : null],
    );
  }
  return { lease_expires_at: result.rows[0].lease_expires_at };
};

// ---------------------------------------------------------------------------
// complete
// ---------------------------------------------------------------------------

const lockStep = async (
  client: PoolClient,
  schema: string,
  jobId: number,
  stepId: string,
): Promise<StepRow | null> => {
  const result = await client.query(
    `${STEP_SELECT(schema)} WHERE js.job_id = $1 AND js.step_id = $2 FOR UPDATE OF js`,
    [jobId, stepId],
  );
  return (result.rows[0] as StepRow) ?? null;
};

const sameArtifact = (a: any, b: any): boolean =>
  a.type === b.type && a.uri === b.uri && a.hash === b.hash;

export const completeStep = async (
  jobId: number,
  stepId: string,
  req: CompleteRequest,
): Promise<{ job_status: string }> => {
  const pool = getPool();
  const schema = getSchema();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const row = await lockStep(client, schema, jobId, stepId);
    if (!row) throw new RunnerRequestError(`Step ${jobId}/${stepId} not found`);
    if (row.lease_token !== req.lease_token) {
      throw new ConflictError("Lease token does not match the current lease");
    }
    const def = stepDefinition(row);

    const expectedSlots = Object.keys(def.outputs);
    const givenSlots = Object.keys(req.artifacts ?? {});
    for (const slot of expectedSlots) {
      if (!givenSlots.includes(slot)) throw new RunnerRequestError(`Missing artifact for output slot "${slot}"`);
    }
    for (const slot of givenSlots) {
      if (!expectedSlots.includes(slot)) throw new RunnerRequestError(`Unknown output slot "${slot}"`);
    }

    if (row.status === "success") {
      // Idempotent repeat: identical artifacts change nothing, different ones conflict.
      const existing = await client.query(
        `SELECT name, type, uri, hash FROM ${schema}.job_artifact
         WHERE job_id = $1 AND producer_step = $2`,
        [jobId, stepId],
      );
      const byName = new Map(existing.rows.map((a) => [a.name, a]));
      for (const [slot, artifact] of Object.entries(req.artifacts)) {
        const previous = byName.get(def.outputs[slot]);
        if (!previous || !sameArtifact(previous, artifact)) {
          throw new ConflictError(`Step already completed with different artifacts (slot "${slot}")`);
        }
      }
      const job = await client.query(`SELECT status FROM ${schema}.job WHERE id = $1`, [jobId]);
      await client.query("COMMIT");
      return { job_status: job.rows[0].status };
    }
    if (row.status !== "running") {
      throw new ConflictError(`Step is ${row.status}, not running`);
    }

    for (const [slot, artifact] of Object.entries(req.artifacts)) {
      await client.query(
        `INSERT INTO ${schema}.job_artifact (job_id, name, type, uri, hash, producer_step, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
         ON CONFLICT (job_id, name) DO UPDATE
           SET type = EXCLUDED.type, uri = EXCLUDED.uri, hash = EXCLUDED.hash,
               producer_step = EXCLUDED.producer_step, metadata = EXCLUDED.metadata`,
        [
          jobId,
          def.outputs[slot],
          artifact.type,
          artifact.uri,
          artifact.hash,
          stepId,
          artifact.metadata ? JSON.stringify(artifact.metadata) : null,
        ],
      );
    }

    await client.query(
      `UPDATE ${schema}.job_step
       SET status = 'success', finished_at = now(), error = NULL, lease_expires_at = NULL
       WHERE job_id = $1 AND step_id = $2`,
      [jobId, stepId],
    );

    const jobStatus = await finalizeJobIfDone(client, schema, jobId);
    await client.query("COMMIT");
    return { job_status: jobStatus };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

/** Marks the job terminal when no step can still run. Returns the job status. */
const finalizeJobIfDone = async (
  client: PoolClient,
  schema: string,
  jobId: number,
): Promise<string> => {
  const steps = await client.query(
    `SELECT status FROM ${schema}.job_step WHERE job_id = $1`,
    [jobId],
  );
  const statuses: string[] = steps.rows.map((s) => s.status);
  const open = statuses.some((s) => s === "pending" || s === "running" || s === "blocked");
  if (open) {
    const job = await client.query(`SELECT status FROM ${schema}.job WHERE id = $1`, [jobId]);
    return job.rows[0].status;
  }
  const final = statuses.every((s) => s === "success") ? "success" : "failed";
  await client.query(
    `UPDATE ${schema}.job SET status = $2, finished_at = COALESCE(finished_at, now()) WHERE id = $1`,
    [jobId, final],
  );
  return final;
};

// ---------------------------------------------------------------------------
// fail
// ---------------------------------------------------------------------------

export const failStep = async (
  jobId: number,
  stepId: string,
  req: FailRequest,
): Promise<{ step_status: string; job_status: string; attempt: number }> => {
  const pool = getPool();
  const schema = getSchema();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const row = await lockStep(client, schema, jobId, stepId);
    if (!row) throw new RunnerRequestError(`Step ${jobId}/${stepId} not found`);
    if (row.lease_token !== req.lease_token) {
      throw new ConflictError("Lease token does not match the current lease");
    }
    if (row.status !== "running") {
      throw new ConflictError(`Step is ${row.status}, not running`);
    }

    const maxAttempts = row.step_max_attempts ?? row.exec_max_attempts;
    const retry = req.retry !== false;
    const decision = decideFailure(req.kind, row.attempt, maxAttempts, retry);
    const cooldown =
      typeof req.cooldown_seconds === "number" && req.cooldown_seconds > 0
        ? Math.floor(req.cooldown_seconds)
        : null;
    const message = req.error ?? (req.kind === "wait" ? "waiting" : "failed");

    let attempt = row.attempt;
    let jobStatus = row.job_status;

    if (decision.next === "blocked") {
      // A wait does not consume an attempt.
      attempt = Math.max(0, row.attempt - 1);
      await client.query(
        `UPDATE ${schema}.job_step
         SET status = 'blocked', attempt = $3, error = $4, lease_token = NULL, lease_expires_at = NULL,
             blocked_until = now() + ($5::int * interval '1 second')
         WHERE job_id = $1 AND step_id = $2`,
        [jobId, stepId, attempt, message, cooldown ?? 300],
      );
    } else if (decision.next === "pending") {
      await client.query(
        `UPDATE ${schema}.job_step
         SET status = 'pending', error = $3, lease_token = NULL, lease_expires_at = NULL,
             blocked_until = CASE WHEN $4::int IS NULL THEN NULL ELSE now() + ($4::int * interval '1 second') END
         WHERE job_id = $1 AND step_id = $2`,
        [jobId, stepId, message, cooldown],
      );
    } else {
      await client.query(
        `UPDATE ${schema}.job_step
         SET status = 'failed', error = $3, finished_at = now(), lease_token = NULL, lease_expires_at = NULL
         WHERE job_id = $1 AND step_id = $2`,
        [jobId, stepId, message],
      );
      await client.query(
        `UPDATE ${schema}.job_step SET status = 'skipped', finished_at = now()
         WHERE job_id = $1 AND status IN ('pending', 'blocked')`,
        [jobId],
      );
      await client.query(
        `UPDATE ${schema}.job SET error = $2 WHERE id = $1`,
        [jobId, `step ${stepId}: ${message}`],
      );
      jobStatus = await finalizeJobIfDone(client, schema, jobId);
    }

    await client.query("COMMIT");
    return { step_status: decision.next, job_status: jobStatus, attempt };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

// ---------------------------------------------------------------------------
// sweeper
// ---------------------------------------------------------------------------

/** Fails running steps whose lease expired, as `kind: error`, retryable. Returns the count. */
export const sweepExpiredLeases = async (): Promise<number> => {
  const pool = getPool();
  const schema = getSchema();
  const expired = await pool.query(
    `SELECT job_id, step_id, lease_token FROM ${schema}.job_step
     WHERE status = 'running' AND lease_token IS NOT NULL AND lease_expires_at < now()`,
  );
  let swept = 0;
  for (const row of expired.rows) {
    try {
      await failStep(row.job_id, row.step_id, {
        lease_token: row.lease_token,
        kind: "error",
        error: "lease expired",
        retry: true,
      });
      swept += 1;
    } catch (error) {
      if (!(error instanceof ConflictError)) {
        console.error(`Sweeper: failed on ${row.job_id}/${row.step_id}:`, error);
      }
    }
  }
  return swept;
};

export const startSweeper = (intervalSeconds: number): NodeJS.Timeout | null => {
  if (!(intervalSeconds > 0)) {
    console.log("Sweeper: disabled");
    return null;
  }
  const timer = setInterval(async () => {
    try {
      const swept = await sweepExpiredLeases();
      if (swept > 0) console.log(`Sweeper: released ${swept} expired lease(s)`);
    } catch (error) {
      console.error("Sweeper error:", error);
    }
  }, intervalSeconds * 1000);
  timer.unref();
  console.log(`Sweeper: every ${intervalSeconds}s`);
  return timer;
};
