import { getPool, getSchema } from "../db/connection";
import { JobArtifact } from "../types";

/** Composite id format: "jobId:name" */
export function parseArtifactId(
  compositeId: string,
): { jobId: number; name: string } | null {
  const sep = compositeId.indexOf(":");
  if (sep === -1) return null;
  const jobId = parseInt(compositeId.slice(0, sep), 10);
  const name = compositeId.slice(sep + 1);
  if (isNaN(jobId) || !name) return null;
  return { jobId, name };
}

export function toArtifactId(jobId: number, name: string): string {
  return `${jobId}:${name}`;
}

export const listArtifacts = async (
  jobId?: number,
): Promise<(JobArtifact & { id: string })[]> => {
  const pool = getPool();
  const schema = getSchema();

  let query = `SELECT job_id, name, type, uri, hash, producer_step, metadata, created_at
   FROM ${schema}.job_artifact`;
  const params: number[] = [];
  if (jobId !== undefined) {
    query += ` WHERE job_id = $1`;
    params.push(jobId);
  }
  query += ` ORDER BY job_id DESC, name`;

  const result = await pool.query(query, params.length ? params : undefined);
  return result.rows.map((row) => ({
    id: toArtifactId(row.job_id, row.name),
    job_id: row.job_id,
    name: row.name,
    type: row.type,
    uri: row.uri,
    hash: row.hash,
    producer_step: row.producer_step,
    metadata: row.metadata,
    created_at: row.created_at,
  }));
};

export const getArtifact = async (
  jobId: number,
  name: string,
): Promise<(JobArtifact & { id: string }) | null> => {
  const pool = getPool();
  const schema = getSchema();
  const result = await pool.query(
    `SELECT job_id, name, type, uri, hash, producer_step, metadata, created_at
     FROM ${schema}.job_artifact
     WHERE job_id = $1 AND name = $2`,
    [jobId, name],
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return {
    id: toArtifactId(row.job_id, row.name),
    job_id: row.job_id,
    name: row.name,
    type: row.type,
    uri: row.uri,
    hash: row.hash,
    producer_step: row.producer_step,
    metadata: row.metadata,
    created_at: row.created_at,
  };
};
