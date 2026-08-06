import { getPool, getSchema } from "../db/connection";
import { JobStepDetailing } from "../types";

export const listJobStepDetailing = async (
  jobId?: number,
  stepId?: string,
): Promise<JobStepDetailing[]> => {
  const pool = getPool();
  const schema = getSchema();

  const conditions: string[] = [];
  const params: (number | string)[] = [];
  if (jobId !== undefined) {
    params.push(jobId);
    conditions.push(`job_id = $${params.length}`);
  }
  if (stepId !== undefined) {
    params.push(stepId);
    conditions.push(`step_id = $${params.length}`);
  }

  let query = `SELECT id, job_id, step_id, log, progress, updated_at
   FROM ${schema}.job_step_detailing`;
  if (conditions.length > 0) {
    query += ` WHERE ${conditions.join(" AND ")}`;
  }
  query += ` ORDER BY updated_at DESC`;

  const result = await pool.query(query, params.length ? params : undefined);
  return result.rows.map((row) => ({
    id: row.id,
    job_id: row.job_id,
    step_id: row.step_id,
    log: row.log,
    progress: row.progress,
    updated_at: row.updated_at,
  }));
};
