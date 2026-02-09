import { Request, Response } from "express";
import {
  listArtifacts,
  getArtifact,
  parseArtifactId,
} from "../services/artifactService";

export const listArtifactsHandler = async (
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
    const artifacts = await listArtifacts(jobId);
    res.json(artifacts);
  } catch (error) {
    console.error("Error listing artifacts:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

export const getArtifactHandler = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    const parsed = parseArtifactId(req.params.id);
    if (!parsed) {
      res.status(400).json({
        error: "Invalid artifact id; use format jobId:name (e.g. 5:point_cloud)",
      });
      return;
    }
    const artifact = await getArtifact(parsed.jobId, parsed.name);
    if (!artifact) {
      res.status(404).json({ error: "Artifact not found" });
      return;
    }
    res.json(artifact);
  } catch (error) {
    console.error("Error getting artifact:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};
