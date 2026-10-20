import { getPool, getSchema } from "../db/connection";
import { StepExecutor, UpsertStepExecutorRequest } from "../types";

const COLUMNS = `step_type, n8n_workflow, accepts, produces, description, params,
                 runner, executor_ref, requires, max_attempts, lease_seconds`;

const rowToExecutor = (row: any): StepExecutor => ({
  step_type: row.step_type,
  n8n_workflow: row.n8n_workflow ?? null,
  accepts: row.accepts,
  produces: row.produces,
  description: row.description ?? null,
  params: row.params ?? null,
  runner: row.runner ?? "n8n",
  executor_ref: row.executor_ref ?? null,
  requires: row.requires ?? {},
  max_attempts: row.max_attempts ?? 1,
  lease_seconds: row.lease_seconds ?? 300,
});

export const getStepExecutor = async (
  stepType: string
): Promise<StepExecutor | null> => {
  const pool = getPool();
  const schema = getSchema();
  const result = await pool.query(
    `SELECT ${COLUMNS} FROM ${schema}.step_executor WHERE step_type = $1`,
    [stepType]
  );
  if (result.rows.length === 0) {
    return null;
  }
  return rowToExecutor(result.rows[0]);
};

export const listStepExecutors = async (): Promise<StepExecutor[]> => {
  const pool = getPool();
  const schema = getSchema();
  const result = await pool.query(
    `SELECT ${COLUMNS} FROM ${schema}.step_executor ORDER BY step_type`
  );
  return result.rows.map(rowToExecutor);
};

export const getStepExecutors = async (
  stepTypes: string[]
): Promise<Map<string, StepExecutor>> => {
  if (stepTypes.length === 0) {
    return new Map();
  }
  const pool = getPool();
  const schema = getSchema();
  const result = await pool.query(
    `SELECT ${COLUMNS} FROM ${schema}.step_executor WHERE step_type = ANY($1)`,
    [stepTypes]
  );
  const executorMap = new Map<string, StepExecutor>();
  for (const row of result.rows) {
    executorMap.set(row.step_type, rowToExecutor(row));
  }
  return executorMap;
};

/** Inserts or updates an executor row. Returns the stored row and whether it was created. */
export const upsertStepExecutor = async (
  stepType: string,
  req: UpsertStepExecutorRequest,
): Promise<{ executor: StepExecutor; created: boolean }> => {
  const pool = getPool();
  const schema = getSchema();
  const runner = req.runner ?? "n8n";
  const executorRef = req.executor_ref ?? req.n8n_workflow ?? null;
  const result = await pool.query(
    `INSERT INTO ${schema}.step_executor
       (step_type, runner, executor_ref, n8n_workflow, accepts, produces, description, params,
        requires, max_attempts, lease_seconds)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8::jsonb, $9::jsonb, $10, $11)
     ON CONFLICT (step_type) DO UPDATE SET
       runner = EXCLUDED.runner,
       executor_ref = EXCLUDED.executor_ref,
       n8n_workflow = EXCLUDED.n8n_workflow,
       accepts = EXCLUDED.accepts,
       produces = EXCLUDED.produces,
       description = EXCLUDED.description,
       params = EXCLUDED.params,
       requires = EXCLUDED.requires,
       max_attempts = EXCLUDED.max_attempts,
       lease_seconds = EXCLUDED.lease_seconds
     RETURNING ${COLUMNS}, (xmax = 0) AS created`,
    [
      stepType,
      runner,
      executorRef,
      runner === "n8n" ? executorRef : null,
      JSON.stringify(req.accepts),
      JSON.stringify(req.produces),
      req.description ?? null,
      req.params ? JSON.stringify(req.params) : null,
      JSON.stringify(req.requires ?? {}),
      req.max_attempts ?? 1,
      req.lease_seconds ?? 300,
    ],
  );
  const row = result.rows[0];
  return { executor: rowToExecutor(row), created: row.created === true };
};
