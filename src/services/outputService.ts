import { getPool, getSchema } from "../db/connection";
import { JobOutput } from "../types";

/** Composite id format: "jobId:artifactName" */
export function parseOutputId(
  compositeId: string,
): { jobId: number; artifactName: string } | null {
  const sep = compositeId.indexOf(":");
  if (sep === -1) return null;
  const jobId = parseInt(compositeId.slice(0, sep), 10);
  const artifactName = compositeId.slice(sep + 1);
  if (isNaN(jobId) || !artifactName) return null;
  return { jobId, artifactName };
}

export function toOutputId(jobId: number, artifactName: string): string {
  return `${jobId}:${artifactName}`;
}

export const listOutputs = async (
  jobId?: number,
): Promise<(JobOutput & { id: string })[]> => {
  const pool = getPool();
  const schema = getSchema();

  let query = `SELECT job_id, artifact_name, path, created_at
   FROM ${schema}.job_output`;
  const params: number[] = [];
  if (jobId !== undefined) {
    query += ` WHERE job_id = $1`;
    params.push(jobId);
  }
  query += ` ORDER BY job_id DESC, artifact_name`;

  const result = await pool.query(query, params.length ? params : undefined);
  return result.rows.map((row) => ({
    id: toOutputId(row.job_id, row.artifact_name),
    job_id: row.job_id,
    artifact_name: row.artifact_name,
    path: row.path,
    created_at: row.created_at,
  }));
};

export const getOutput = async (
  jobId: number,
  artifactName: string,
): Promise<(JobOutput & { id: string }) | null> => {
  const pool = getPool();
  const schema = getSchema();
  const result = await pool.query(
    `SELECT job_id, artifact_name, path, created_at
     FROM ${schema}.job_output
     WHERE job_id = $1 AND artifact_name = $2`,
    [jobId, artifactName],
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return {
    id: toOutputId(row.job_id, row.artifact_name),
    job_id: row.job_id,
    artifact_name: row.artifact_name,
    path: row.path,
    created_at: row.created_at,
  };
};
