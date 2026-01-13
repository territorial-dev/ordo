import { Request, Response } from "express";
import { createRecipe, getRecipe } from "../services/recipeService";
import { CreateRecipeRequest } from "../types";
import { ValidationError } from "../utils/validation";

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
