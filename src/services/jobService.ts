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
import { ValidationError } from "../utils/validation";

export const createJob = async (req: CreateJobRequest): Promise<number> => {
  const pool = getPool();
  const schema = getSchema();

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

  // Begin transaction
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Create job
    const jobParamsJson = JSON.stringify(jobParams);
    const jobResult = await client.query(
      `INSERT INTO ${schema}.job (recipe_id, status, params)
       VALUES ($1, 'pending', $2::jsonb)
       RETURNING id`,
      [recipeId, jobParamsJson],
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
         (job_id, step_id, step_type, status, attempt)
         VALUES ($1, $2, $3, 'pending', 0)`,
        [jobId, step.id, step.type],
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
    return jobId;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};;

export const getJobStatus = async (
  jobId: number
): Promise<JobStatusResponse | null> => {
  const pool = getPool();
  const schema = getSchema();

  // Get job
  const jobResult = await pool.query(
    `SELECT id, recipe_id, status, created_at, started_at, finished_at, error, params
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
  };

  // Get steps
  const stepsResult = await pool.query(
    `SELECT job_id, step_id, step_type, status, attempt, claimed_by, claimed_at,
            started_at, finished_at, error
     FROM ${schema}.job_step
     WHERE job_id = $1
     ORDER BY step_id`,
    [jobId]
  );

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
    `SELECT job_id, artifact_name, path, created_at
     FROM ${schema}.job_output
     WHERE job_id = $1
     ORDER BY artifact_name`,
    [jobId]
  );

  const outputs: JobOutput[] = outputsResult.rows.map((row) => ({
    job_id: row.job_id,
    artifact_name: row.artifact_name,
    path: row.path,
    created_at: row.created_at,
  }));

  // Compute progress
  const completed_steps = steps.filter(
    (s) => s.status === "success" || s.status === "failed"
  ).length;
  const total_steps = steps.length;
  const progress = {
    percentage: total_steps > 0 ? completed_steps / total_steps : 0,
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
    `SELECT id, recipe_id, status, created_at, started_at, finished_at, error, params
     FROM ${schema}.job
     WHERE id = ANY($1::int[])`,
    [jobIds]
  );

  const stepsResult = await pool.query(
    `SELECT job_id, step_id, step_type, status, attempt, claimed_by, claimed_at,
            started_at, finished_at, error
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
    `SELECT job_id, artifact_name, path, created_at
     FROM ${schema}.job_output
     WHERE job_id = ANY($1::int[])
     ORDER BY job_id, artifact_name`,
    [jobIds]
  );

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
    };

    const steps = stepsByJob.get(job.id) ?? [];
    const artifacts = artifactsByJob.get(job.id) ?? [];
    const outputs = outputsByJob.get(job.id) ?? [];

    const completed_steps = steps.filter(
      (s) => s.status === "success" || s.status === "failed"
    ).length;
    const total_steps = steps.length;
    const progress = {
      percentage: total_steps > 0 ? completed_steps / total_steps : 0,
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

export const listJobs = async (): Promise<Job[]> => {
  const pool = getPool();
  const schema = getSchema();
  const result = await pool.query(
    `SELECT id, recipe_id, status, created_at, started_at, finished_at, error
     FROM ${schema}.job
     ORDER BY id DESC`,
  );
  return result.rows.map((row) => ({
    id: row.id,
    recipe_id: row.recipe_id,
    status: row.status,
    created_at: row.created_at,
    started_at: row.started_at,
    finished_at: row.finished_at,
    error: row.error,
  }));
};
