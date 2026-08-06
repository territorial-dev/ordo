import { Request, Response } from "express";
import { listJobStepDetailing } from "../services/jobStepDetailingService";

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

    const stepIdParam = req.query.step_id;
    const stepId =
      stepIdParam !== undefined ? String(stepIdParam) : undefined;

    const detailing = await listJobStepDetailing(jobId, stepId);
    res.json(detailing);
  } catch (error) {
    console.error("Error listing job step detailing:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};
