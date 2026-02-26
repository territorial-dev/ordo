import { Request, Response } from "express";
import { createJob, getJobStatus, getJobsBatch, listJobs } from "../services/jobService";
import { CreateJobRequest } from "../types";
import { ValidationError } from "../utils/validation";

export const createJobHandler = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    const body = req.body as CreateJobRequest;

    // Validate that either recipe_id or recipe is provided
    if (!body.recipe_id && !body.recipe) {
      res.status(400).json({
        error:
          "Either recipe_id or recipe (name, version, definition) must be provided",
      });
      return;
    }

    if (body.recipe_id && typeof body.recipe_id !== "number") {
      res.status(400).json({ error: "recipe_id must be a number" });
      return;
    }

    if (body.recipe) {
      if (!body.recipe.name || !body.recipe.version) {
        res.status(400).json({
          error: "recipe must have name and version",
        });
        return;
      }
    }

    if (
      !body.inputs ||
      typeof body.inputs !== "object" ||
      Array.isArray(body.inputs)
    ) {
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

    // Validate outputs structure if provided
    if (body.outputs !== undefined) {
      if (typeof body.outputs !== "object" || Array.isArray(body.outputs)) {
        res.status(400).json({ error: "outputs must be an object" });
        return;
      }

      for (const [artifactName, output] of Object.entries(body.outputs)) {
        if (!output.path || typeof output.path !== "string") {
          res.status(400).json({
            error: `Invalid output "${artifactName}": must have path as a string`,
          });
          return;
        }
      }
    }

    // Validate params structure if provided (step_id -> param name -> value)
    if (body.params !== undefined) {
      if (
        typeof body.params !== "object" ||
        body.params === null ||
        Array.isArray(body.params)
      ) {
        res.status(400).json({ error: "params must be an object" });
        return;
      }
      for (const stepParams of Object.values(body.params)) {
        if (
          typeof stepParams !== "object" ||
          stepParams === null ||
          Array.isArray(stepParams)
        ) {
          res
            .status(400)
            .json({
              error:
                "params must map step IDs to objects (param name -> value)",
            });
          return;
        }
      }
    }

    const jobId = await createJob(body);
    res.status(201).json({ id: jobId });
  } catch (error) {
    if (error instanceof ValidationError) {
      res.status(400).json({ error: error.message });
      return;
    }
    if (error instanceof Error && error.message.includes("not found")) {
      res.status(404).json({ error: error.message });
      return;
    }
    console.error("Error creating job:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

export const listJobsHandler = async (
  _req: Request,
  res: Response,
): Promise<void> => {
  try {
    const jobs = await listJobs();
    res.json(jobs);
  } catch (error) {
    console.error("Error listing jobs:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

export const getBatchJobStatusHandler = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const raw = req.params.ids;
  const parts = raw.split(",");
  const jobIds: number[] = [];

  for (const part of parts) {
    const trimmed = part.trim();
    if (!/^\d+$/.test(trimmed)) {
      res.status(400).json({ error: `Invalid job ID: "${trimmed}"` });
      return;
    }
    const id = parseInt(trimmed, 10);
    if (id <= 0) {
      res.status(400).json({ error: `Job ID must be a positive integer: "${trimmed}"` });
      return;
    }
    jobIds.push(id);
  }

  if (jobIds.length < 2) {
    res.status(400).json({ error: "Batch endpoint requires at least 2 job IDs" });
    return;
  }

  if (jobIds.length > 100) {
    res.status(400).json({ error: "Cannot request more than 100 job IDs at once" });
    return;
  }

  try {
    const statusMap = await getJobsBatch(jobIds);
    const response = jobIds.map((id) => {
      const status = statusMap.get(id);
      return status ? { id, found: true, ...status } : { id, found: false };
    });
    res.json(response);
  } catch (error) {
    console.error("Error getting batch job status:", error);
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

