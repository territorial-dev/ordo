import { Request, Response } from "express";
import { createJob, getJobStatus } from "../services/jobService";
import { CreateJobRequest } from "../types";

export const createJobHandler = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    const body = req.body as CreateJobRequest;

    // Validate that either recipe_id or recipe is provided
    if (!body.recipe_id && !body.recipe) {
      res.status(400).json({
        error: "Either recipe_id or recipe (name, version, definition) must be provided",
      });
      return;
    }

    if (body.recipe_id && typeof body.recipe_id !== "number") {
      res.status(400).json({ error: "recipe_id must be a number" });
      return;
    }

    if (body.recipe) {
      if (!body.recipe.name || !body.recipe.version || !body.recipe.definition) {
        res.status(400).json({
          error: "recipe must have name, version, and definition",
        });
        return;
      }
    }

    if (!body.inputs || typeof body.inputs !== "object" || Array.isArray(body.inputs)) {
      res.status(400).json({ error: "inputs must be an object" });
      return;
    }

    // Validate input artifacts structure
    for (const [name, artifact] of Object.entries(body.inputs)) {
      if (
        !artifact.type ||
        !artifact.uri ||
        !artifact.hash ||
        typeof artifact.type !== "string" ||
        typeof artifact.uri !== "string" ||
        typeof artifact.hash !== "string"
      ) {
        res.status(400).json({
          error: `Invalid artifact "${name}": must have type, uri, and hash as strings`,
        });
        return;
      }
    }

    const jobId = await createJob(body);
    res.status(201).json({ id: jobId });
  } catch (error) {
    if (error instanceof Error) {
      if (error.message.includes("not found")) {
        res.status(404).json({ error: error.message });
        return;
      }
      if (
        error.message.includes("Missing required") ||
        error.message.includes("Unexpected input") ||
        error.message.includes("must be provided")
      ) {
        res.status(400).json({ error: error.message });
        return;
      }
    }
    console.error("Error creating job:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

export const getJobStatusHandler = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    const jobId = parseInt(req.params.id, 10);

    if (isNaN(jobId)) {
      res.status(400).json({ error: "Invalid job ID" });
      return;
    }

    const status = await getJobStatus(jobId);

    if (!status) {
      res.status(404).json({ error: "Job not found" });
      return;
    }

    res.json(status);
  } catch (error) {
    console.error("Error getting job status:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};
