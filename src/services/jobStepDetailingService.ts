import { getPool, getSchema } from "../db/connection";
import { JobStepDetailing } from "../types";

/** Composite id format: "jobId:stepId" */
export function parseJobStepDetailingId(
  compositeId: string,
): { jobId: number; stepId: string } | null {
  const sep = compositeId.indexOf(":");
  if (sep === -1) return null;
  const jobId = parseInt(compositeId.slice(0, sep), 10);
  const stepId = compositeId.slice(sep + 1);
  if (isNaN(jobId) || !stepId) return null;
  return { jobId, stepId };
}

export function toJobStepDetailingId(jobId: number, stepId: string): string {
  return `${jobId}:${stepId}`;
}

export const listJobStepDetailing = async (
  jobId?: number,
): Promise<(JobStepDetailing & { id: string })[]> => {
  const pool = getPool();
  const schema = getSchema();

  let query = `SELECT job_id, step_id, log, progress, updated_at
   FROM ${schema}.job_step_detailing`;
  const params: number[] = [];
  if (jobId !== undefined) {
    query += ` WHERE job_id = $1`;
    params.push(jobId);
  }
  query += ` ORDER BY job_id DESC, step_id`;

  const result = await pool.query(query, params.length ? params : undefined);
  return result.rows.map((row) => ({
    id: toJobStepDetailingId(row.job_id, row.step_id),
    job_id: row.job_id,
    step_id: row.step_id,
    log: row.log,
    progress: row.progress,
    updated_at: row.updated_at,
  }));
};

export const getJobStepDetailing = async (
  jobId: number,
  stepId: string,
): Promise<(JobStepDetailing & { id: string }) | null> => {
  const pool = getPool();
  const schema = getSchema();
  const result = await pool.query(
    `SELECT job_id, step_id, log, progress, updated_at
     FROM ${schema}.job_step_detailing
     WHERE job_id = $1 AND step_id = $2`,
    [jobId, stepId],
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return {
    id: toJobStepDetailingId(row.job_id, row.step_id),
    job_id: row.job_id,
    step_id: row.step_id,
    log: row.log,
    progress: row.progress,
    updated_at: row.updated_at,
  };
};
