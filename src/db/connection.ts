import { Pool } from "pg";

let pool: Pool | null = null;

export const getPool = (): Pool => {
  if (!pool) {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      throw new Error("DATABASE_URL environment variable is required");
    }
    pool = new Pool({
      connectionString: databaseUrl,
    });
  }
  return pool;
};

export const getSchema = (): string => {
  const rawSchema = process.env.DB_SCHEMA ? process.env.DB_SCHEMA.trim() : "";
  const schema = rawSchema.length > 0 ? rawSchema : "ordo";
  const isValid = /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schema);
  if (!isValid) {
    throw new Error(
      "DB_SCHEMA must start with a letter or underscore and contain only letters, numbers, and underscores"
    );
  }
  return schema;
};

export const closePool = async (): Promise<void> => {
  if (pool) {
    await pool.end();
    pool = null;
  }
};
