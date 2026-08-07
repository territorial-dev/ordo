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

/** Most recent job_step_detailing row per step_id, for a single job. */
export const getLatestDetailingByStep = async (
  jobId: number,
): Promise<Map<string, JobStepDetailing>> => {
  const pool = getPool();
  const schema = getSchema();

  const result = await pool.query(
    `SELECT DISTINCT ON (step_id) id, job_id, step_id, log, progress, updated_at
     FROM ${schema}.job_step_detailing
     WHERE job_id = $1
     ORDER BY step_id, updated_at DESC`,
    [jobId],
  );

  const byStep = new Map<string, JobStepDetailing>();
  for (const row of result.rows) {
    byStep.set(row.step_id, {
      id: row.id,
      job_id: row.job_id,
      step_id: row.step_id,
      log: row.log,
      progress: row.progress,
      updated_at: row.updated_at,
    });
  }
  return byStep;
};

/** Most recent job_step_detailing row per (job_id, step_id), across many jobs. */
export const getLatestDetailingByStepBatch = async (
  jobIds: number[],
): Promise<Map<number, Map<string, JobStepDetailing>>> => {
  const pool = getPool();
  const schema = getSchema();

  const result = await pool.query(
    `SELECT DISTINCT ON (job_id, step_id) id, job_id, step_id, log, progress, updated_at
     FROM ${schema}.job_step_detailing
     WHERE job_id = ANY($1::int[])
     ORDER BY job_id, step_id, updated_at DESC`,
    [jobIds],
  );

  const byJob = new Map<number, Map<string, JobStepDetailing>>();
  for (const row of result.rows) {
    if (!byJob.has(row.job_id)) byJob.set(row.job_id, new Map());
    byJob.get(row.job_id)!.set(row.step_id, {
      id: row.id,
      job_id: row.job_id,
      step_id: row.step_id,
      log: row.log,
      progress: row.progress,
      updated_at: row.updated_at,
    });
  }
  return byJob;
};
