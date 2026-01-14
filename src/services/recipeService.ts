import { getPool } from "../db/connection";
import { CreateRecipeRequest, Recipe } from "../types";
import { validateRecipe, ValidationError } from "../utils/validation";

export const createRecipe = async (
  req: CreateRecipeRequest
): Promise<number> => {
  // Validate recipe with empty external inputs (inputs provided at job creation)
  await validateRecipe(req.definition, new Set());

  const pool = getPool();
  const result = await pool.query(
    `INSERT INTO mapprism2.recipe (name, version, definition)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [req.name, req.version, JSON.stringify(req.definition)]
  );

  return result.rows[0].id;
};

export const getRecipe = async (id: number): Promise<Recipe | null> => {
  const pool = getPool();
  const result = await pool.query(
    `SELECT id, name, version, definition, created_at
     FROM mapprism2.recipe
     WHERE id = $1`,
    [id]
  );

  if (result.rows.length === 0) {
    return null;
  }

  const row = result.rows[0];
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    definition: row.definition,
    created_at: row.created_at,
  };
};

export const getRecipeByNameAndVersion = async (
  name: string,
  version: string
): Promise<Recipe | null> => {
  const pool = getPool();
  const result = await pool.query(
    `SELECT id, name, version, definition, created_at
     FROM mapprism2.recipe
     WHERE name = $1 AND version = $2`,
    [name, version]
  );

  if (result.rows.length === 0) {
    return null;
  }

  const row = result.rows[0];
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    definition: row.definition,
    created_at: row.created_at,
  };
};
