import { Request, Response } from "express";
import {
  listJobStepDetailing,
  getJobStepDetailing,
  parseJobStepDetailingId,
} from "../services/jobStepDetailingService";

export const listJobStepDetailingHandler = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    const jobIdParam = req.query.job_id;
    const jobId =
      jobIdParam !== undefined
        ? parseInt(String(jobIdParam), 10)
        : undefined;
    if (jobIdParam !== undefined && isNaN(jobId as number)) {
      res.status(400).json({ error: "Invalid job_id query parameter" });
      return;
    }
    const detailing = await listJobStepDetailing(jobId);
    res.json(detailing);
  } catch (error) {
    console.error("Error listing job step detailing:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

export const getJobStepDetailingHandler = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    const parsed = parseJobStepDetailingId(req.params.id);
    if (!parsed) {
      res.status(400).json({
        error:
          "Invalid detailing id; use format jobId:stepId (e.g. 5:reproject)",
      });
      return;
    }
    const detailing = await getJobStepDetailing(parsed.jobId, parsed.stepId);
    if (!detailing) {
      res.status(404).json({ error: "Detailing not found" });
      return;
    }
    res.json(detailing);
  } catch (error) {
    console.error("Error getting job step detailing:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};
