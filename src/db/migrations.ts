import { getPool, getSchema } from "./connection";
import { promises as fs } from "fs";
import path from "path";

export const runMigrations = async (): Promise<void> => {
  const pool = getPool();
  const schema = getSchema();

  console.log(`Migrations: checking schema "${schema}"...`);
  await pool.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
  await pool.query(
    `CREATE TABLE IF NOT EXISTS ${schema}.migrations (
      id SERIAL PRIMARY KEY,
      name text NOT NULL UNIQUE,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`
  );

  const appliedResult = await pool.query(
    `SELECT name FROM ${schema}.migrations`
  );
  const applied = new Set<string>(appliedResult.rows.map((row) => row.name));

  const migrationsDir = path.resolve(__dirname, "../../migrations");
  const entries = await fs.readdir(migrationsDir);
  const migrationFiles = entries
    .filter((entry) => entry.endsWith(".sql"))
    .sort((a, b) => a.localeCompare(b));

  let appliedCount = 0;
  for (const fileName of migrationFiles) {
    if (applied.has(fileName)) {
      continue;
    }

    const filePath = path.join(migrationsDir, fileName);
    const rawSql = await fs.readFile(filePath, "utf8");
    const sql = rawSql.split("{{schema}}").join(schema);
    const statements = sql
      .split(";")
      .map((statement: string) => statement.trim())
      .filter((statement: string) => statement.length > 0);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const statement of statements) {
        await client.query(statement);
      }
      await client.query(
        `INSERT INTO ${schema}.migrations (name) VALUES ($1)`,
        [fileName]
      );
      await client.query("COMMIT");
      appliedCount += 1;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  if (migrationFiles.length === 0) {
    console.log("Migrations: no migration files found.");
  } else if (appliedCount === 0) {
    console.log("Migrations: up to date.");
  } else {
    console.log(`Migrations: applied ${appliedCount} file(s).`);
  }
};
