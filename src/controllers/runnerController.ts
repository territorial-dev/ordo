import { Request, Response } from "express";
import {
  claimStep,
  completeStep,
  ConflictError,
  failStep,
  heartbeatStep,
  RunnerRequestError,
} from "../services/runnerService";
import { ClaimRequest, CompleteRequest, FailRequest } from "../types";

const handleError = (res: Response, error: unknown, what: string): void => {
  if (error instanceof ConflictError) {
    res.status(409).json({ error: error.message });
    return;
  }
  if (error instanceof RunnerRequestError) {
    res.status(400).json({ error: error.message });
    return;
  }
  console.error(`Error on runner ${what}:`, error);
  res.status(500).json({ error: "Internal server error" });
};

const parseStepRef = (req: Request, res: Response): { jobId: number; stepId: string } | null => {
  const jobId = parseInt(req.params.job_id, 10);
  const stepId = req.params.step_id;
  if (isNaN(jobId) || !stepId) {
    res.status(400).json({ error: "Invalid job_id or step_id" });
    return null;
  }
  return { jobId, stepId };
};

export const claimHandler = async (req: Request, res: Response): Promise<void> => {
  try {
    const body = req.body as ClaimRequest;
    if (!body || typeof body.worker_id !== "string" || !body.worker_id) {
      res.status(400).json({ error: "worker_id must be a non-empty string" });
      return;
    }
    if (body.step_types !== undefined) {
      if (!Array.isArray(body.step_types) || body.step_types.some((t) => typeof t !== "string")) {
        res.status(400).json({ error: "step_types must be an array of strings" });
        return;
      }
    }
    if (body.capabilities !== undefined && (typeof body.capabilities !== "object" || body.capabilities === null || Array.isArray(body.capabilities))) {
      res.status(400).json({ error: "capabilities must be an object" });
      return;
    }
    const claimed = await claimStep(body);
    if (!claimed) {
      res.status(204).end();
      return;
    }
    res.json(claimed);
  } catch (error) {
    handleError(res, error, "claim");
  }
};

export const heartbeatHandler = async (req: Request, res: Response): Promise<void> => {
  const ref = parseStepRef(req, res);
  if (!ref) return;
  try {
    const { lease_token, progress, log } = req.body ?? {};
    if (typeof lease_token !== "string" || !lease_token) {
      res.status(400).json({ error: "lease_token is required" });
      return;
    }
    const result = await heartbeatStep(ref.jobId, ref.stepId, lease_token, progress, log);
    res.json(result);
  } catch (error) {
    handleError(res, error, "heartbeat");
  }
};

export const completeHandler = async (req: Request, res: Response): Promise<void> => {
  const ref = parseStepRef(req, res);
  if (!ref) return;
  try {
    const body = req.body as CompleteRequest;
    if (!body || typeof body.lease_token !== "string" || !body.lease_token) {
      res.status(400).json({ error: "lease_token is required" });
      return;
    }
    if (typeof body.artifacts !== "object" || body.artifacts === null || Array.isArray(body.artifacts)) {
      res.status(400).json({ error: "artifacts must be an object keyed by output slot" });
      return;
    }
    for (const [slot, artifact] of Object.entries(body.artifacts)) {
      if (!artifact || typeof artifact.type !== "string" || typeof artifact.uri !== "string" || typeof artifact.hash !== "string") {
        res.status(400).json({ error: `Invalid artifact "${slot}": must have type, uri, and hash as strings` });
        return;
      }
    }
    const result = await completeStep(ref.jobId, ref.stepId, body);
    res.json(result);
  } catch (error) {
    handleError(res, error, "complete");
  }
};

export const failHandler = async (req: Request, res: Response): Promise<void> => {
  const ref = parseStepRef(req, res);
  if (!ref) return;
  try {
    const body = req.body as FailRequest;
    if (!body || typeof body.lease_token !== "string" || !body.lease_token) {
      res.status(400).json({ error: "lease_token is required" });
      return;
    }
    if (body.kind !== "error" && body.kind !== "wait") {
      res.status(400).json({ error: 'kind must be "error" or "wait"' });
      return;
    }
    if (body.kind === "wait" && !(typeof body.cooldown_seconds === "number" && body.cooldown_seconds > 0)) {
      res.status(400).json({ error: "cooldown_seconds (positive number) is required for kind \"wait\"" });
      return;
    }
    const result = await failStep(ref.jobId, ref.stepId, body);
    res.json(result);
  } catch (error) {
    handleError(res, error, "fail");
  }
};
