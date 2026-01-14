import { getPool } from "../db/connection";
import { StepExecutor } from "../types";

export const getStepExecutor = async (
  stepType: string
): Promise<StepExecutor | null> => {
  const pool = getPool();
  const result = await pool.query(
    `SELECT step_type, n8n_workflow, accepts, produces
     FROM mapprism2.step_executor
     WHERE step_type = $1`,
    [stepType]
  );

  if (result.rows.length === 0) {
    return null;
  }

  const row = result.rows[0];
  return {
    step_type: row.step_type,
    n8n_workflow: row.n8n_workflow,
    accepts: row.accepts,
    produces: row.produces,
  };
};

export const getStepExecutors = async (
  stepTypes: string[]
): Promise<Map<string, StepExecutor>> => {
  if (stepTypes.length === 0) {
    return new Map();
  }

  const pool = getPool();
  const result = await pool.query(
    `SELECT step_type, n8n_workflow, accepts, produces
     FROM mapprism2.step_executor
     WHERE step_type = ANY($1)`,
    [stepTypes]
  );

  const executorMap = new Map<string, StepExecutor>();
  for (const row of result.rows) {
    executorMap.set(row.step_type, {
      step_type: row.step_type,
      n8n_workflow: row.n8n_workflow,
      accepts: row.accepts,
      produces: row.produces,
    });
  }

  return executorMap;
};
