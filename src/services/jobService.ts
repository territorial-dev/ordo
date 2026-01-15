import { getPool, getSchema } from "../db/connection";
import {
  CreateJobRequest,
  Job,
  JobStep,
  JobArtifact,
  JobStatusResponse,
} from "../types";
import {
  getRecipe,
  createRecipe,
  getRecipeByNameAndVersion,
} from "./recipeService";

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
      req.recipe.version
    );
    if (!recipe) {
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
      "Either recipe_id or recipe (name, version, definition) must be provided"
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
    step.outputs.forEach((o) => allOutputs.add(o));
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
      throw new Error(
        `Missing required initial input artifact: ${requiredInput}`
      );
    }
  }

  // Check that no extra inputs are provided (only required initial inputs)
  const providedInputs = new Set(Object.keys(req.inputs));
  for (const providedInput of providedInputs) {
    if (!initialInputs.has(providedInput)) {
      throw new Error(
        `Unexpected input artifact "${providedInput}": not required by recipe. Required inputs: ${Array.from(
          initialInputs
        ).join(", ")}`
      );
    }
  }

  // Validate job outputs if provided
  if (req.outputs) {
    const requestedOutputs = Object.keys(req.outputs);
    for (const artifactName of requestedOutputs) {
      if (!allOutputs.has(artifactName)) {
        throw new Error(
          `Invalid job output "${artifactName}": artifact is not producible by recipe. Producible artifacts: ${Array.from(
            allOutputs
          ).join(", ")}`
        );
      }
    }
  }

  // Begin transaction
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Create job
    const jobResult = await client.query(
      `INSERT INTO ${schema}.job (recipe_id, status)
       VALUES ($1, 'pending')
       RETURNING id`,
      [recipeId]
    );
    const jobId = jobResult.rows[0].id;

    // Insert initial artifacts
    for (const [name, artifact] of Object.entries(req.inputs)) {
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
        ]
      );
    }

    // Insert all recipe steps as pending
    for (const step of recipeSteps) {
      await client.query(
        `INSERT INTO ${schema}.job_step
         (job_id, step_id, step_type, status, attempt)
         VALUES ($1, $2, $3, 'pending', 0)`,
        [jobId, step.id, step.type]
      );
    }

    // Insert job outputs if provided
    if (req.outputs) {
      for (const [artifactName, output] of Object.entries(req.outputs)) {
        await client.query(
          `INSERT INTO ${schema}.job_output (job_id, artifact_name, path)
           VALUES ($1, $2, $3)`,
          [jobId, artifactName, output.path]
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
};

export const getJobStatus = async (
  jobId: number
): Promise<JobStatusResponse | null> => {
  const pool = getPool();
  const schema = getSchema();

  // Get job
  const jobResult = await pool.query(
    `SELECT id, recipe_id, status, created_at, started_at, finished_at, error
     FROM ${schema}.job
     WHERE id = $1`,
    [jobId]
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

  return { job, steps, artifacts };
};
