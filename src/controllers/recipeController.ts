import { Request, Response } from "express";
import { createRecipe, getRecipe } from "../services/recipeService";
import { CreateRecipeRequest, RecipeDefinition } from "../types";
import { validateRecipe, ValidationError } from "../utils/validation";

export const createRecipeHandler = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    const body = req.body as CreateRecipeRequest;

    if (!body.name || !body.version || !body.definition) {
      res.status(400).json({
        error: "Missing required fields: name, version, definition",
      });
      return;
    }

    const recipeId = await createRecipe(body);
    res.status(201).json({ id: recipeId });
  } catch (error) {
    if (error instanceof ValidationError) {
      res.status(400).json({ error: error.message });
      return;
    }
    console.error("Error creating recipe:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

export const validateRecipeHandler = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    const body = req.body as { definition: RecipeDefinition };

    if (!body.definition) {
      res.status(400).json({
        error: "Missing required field: definition",
      });
      return;
    }

    // Validate with empty external inputs (inputs provided at job creation)
    await validateRecipe(body.definition, new Set());
    res.status(200).json({ valid: true });
  } catch (error) {
    if (error instanceof ValidationError) {
      res.status(200).json({ valid: false, error: error.message });
      return;
    }
    console.error("Error validating recipe:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};
