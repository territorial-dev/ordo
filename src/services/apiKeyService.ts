import { createHash, randomBytes } from "crypto";
import { getPool, getSchema } from "../db/connection";
import { ApiKeyRecord, Role } from "../types";

export const ROLES: Role[] = ["admin", "scheduler", "runner"];

export const hashKey = (key: string): string =>
  createHash("sha256").update(key).digest("hex");

const generateKey = (role: Role): string =>
  `ordo_${role}_${randomBytes(30).toString("base64url")}`;

export const createApiKey = async (
  name: string,
  role: Role,
): Promise<ApiKeyRecord & { key: string }> => {
  const pool = getPool();
  const schema = getSchema();
  const key = generateKey(role);
  const result = await pool.query(
    `INSERT INTO ${schema}.api_key (name, role, key_hash)
     VALUES ($1, $2, $3)
     RETURNING id, name, role, created_at, revoked_at, last_used_at`,
    [name, role, hashKey(key)],
  );
  return { ...rowToRecord(result.rows[0]), key };
};

export const listApiKeys = async (): Promise<ApiKeyRecord[]> => {
  const pool = getPool();
  const schema = getSchema();
  const result = await pool.query(
    `SELECT id, name, role, created_at, revoked_at, last_used_at
     FROM ${schema}.api_key ORDER BY id`,
  );
  return result.rows.map(rowToRecord);
};

export const revokeApiKey = async (id: number): Promise<boolean> => {
  const pool = getPool();
  const schema = getSchema();
  const result = await pool.query(
    `UPDATE ${schema}.api_key SET revoked_at = now()
     WHERE id = $1 AND revoked_at IS NULL
     RETURNING id`,
    [id],
  );
  return result.rows.length > 0;
};

/** Resolves a bearer token to an active key, or null. */
export const authenticateKey = async (
  token: string,
): Promise<ApiKeyRecord | null> => {
  const pool = getPool();
  const schema = getSchema();
  const result = await pool.query(
    `SELECT id, name, role, created_at, revoked_at, last_used_at
     FROM ${schema}.api_key
     WHERE key_hash = $1 AND revoked_at IS NULL`,
    [hashKey(token)],
  );
  if (result.rows.length === 0) return null;
  return rowToRecord(result.rows[0]);
};

const lastTouched = new Map<number, number>();
const TOUCH_INTERVAL_MS = 60_000;

/** Records key usage at most once a minute per key; never blocks the request. */
export const touchApiKey = (id: number): void => {
  const now = Date.now();
  const previous = lastTouched.get(id) ?? 0;
  if (now - previous < TOUCH_INTERVAL_MS) return;
  lastTouched.set(id, now);
  const pool = getPool();
  const schema = getSchema();
  pool
    .query(`UPDATE ${schema}.api_key SET last_used_at = now() WHERE id = $1`, [id])
    .catch((error) => console.error("Failed to touch api key:", error));
};

const rowToRecord = (row: any): ApiKeyRecord => ({
  id: row.id,
  name: row.name,
  role: row.role,
  created_at: row.created_at,
  revoked_at: row.revoked_at,
  last_used_at: row.last_used_at,
});
