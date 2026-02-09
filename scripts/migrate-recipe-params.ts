/**
 * One-off script: rewrite stored recipe definitions from old shape (params object)
 * to new shape (required_params array of keys). Run once after deploying the
 * recipe schema change. Requires DATABASE_URL and optional DB_SCHEMA.
 *
 * Usage: npx ts-node scripts/migrate-recipe-params.ts
 */
import "dotenv/config";
import { getPool, getSchema, closePool } from "../src/db/connection";

interface OldStep {
  id: string;
  type: string;
  inputs: Record<string, string>;
  outputs: string[];
  params?: Record<string, unknown>;
  required_params?: string[];
}

interface RecipeDef {
  recipe: OldStep[];
}

function migrateStep(step: OldStep): OldStep {
  const out: OldStep = {
    id: step.id,
    type: step.type,
    inputs: step.inputs,
    outputs: step.outputs,
  };
  if (step.required_params !== undefined) {
    out.required_params = step.required_params;
  } else if (
    step.params !== undefined &&
    typeof step.params === "object" &&
    step.params !== null
  ) {
    out.required_params = Object.keys(step.params);
  }
  return out;
}

async function main(): Promise<void> {
  const pool = getPool();
  const schema = getSchema();
  const result = await pool.query(
    `SELECT id, definition FROM ${schema}.recipe`,
  );
  let updated = 0;
  for (const row of result.rows) {
    const def = row.definition as RecipeDef;
    if (!def?.recipe || !Array.isArray(def.recipe)) continue;
    let changed = false;
    const newRecipe = def.recipe.map((step) => {
      const migrated = migrateStep(step);
      if (
        ("params" in step && step.params !== undefined) ||
        JSON.stringify(migrated) !== JSON.stringify(step)
      ) {
        changed = true;
      }
      return migrated;
    });
    if (!changed) continue;
    await pool.query(
      `UPDATE ${schema}.recipe SET definition = $1::jsonb WHERE id = $2`,
      [JSON.stringify({ recipe: newRecipe }), row.id],
    );
    updated += 1;
    console.log(`Migrated recipe id=${row.id}`);
  }
  console.log(`Done. Updated ${updated} recipe(s).`);
  await closePool();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
