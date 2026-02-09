import { Request, Response } from "express";
import {
  listOutputs,
  getOutput,
  parseOutputId,
} from "../services/outputService";

export const listOutputsHandler = async (
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
    const outputs = await listOutputs(jobId);
    res.json(outputs);
  } catch (error) {
    console.error("Error listing outputs:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

export const getOutputHandler = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    const parsed = parseOutputId(req.params.id);
    if (!parsed) {
      res.status(400).json({
        error:
          "Invalid output id; use format jobId:artifactName (e.g. 5:point_cloud)",
      });
      return;
    }
    const output = await getOutput(parsed.jobId, parsed.artifactName);
    if (!output) {
      res.status(404).json({ error: "Output not found" });
      return;
    }
    res.json(output);
  } catch (error) {
    console.error("Error getting output:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};
