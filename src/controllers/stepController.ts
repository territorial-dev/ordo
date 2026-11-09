import { Request, Response } from "express";
import {
  parseFinishedAfter,
  parseUsageFilter,
  stepAttempts,
  stepCounts,
  StepFilterError,
  stepUsage,
} from "../services/stepService";

export const stepCountsHandler = async (_req: Request, res: Response): Promise<void> => {
  try {
    res.json(await stepCounts());
  } catch (error) {
    console.error("Error counting steps:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

export const stepAttemptsHandler = async (req: Request, res: Response): Promise<void> => {
  try {
    res.json(await stepAttempts(parseFinishedAfter(req.query.finished_after)));
  } catch (error) {
    if (error instanceof StepFilterError) {
      res.status(400).json({ error: error.message });
      return;
    }
    console.error("Error reading step attempts:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

export const stepUsageHandler = async (req: Request, res: Response): Promise<void> => {
  try {
    res.json(await stepUsage(parseUsageFilter(req.query as Record<string, unknown>)));
  } catch (error) {
    if (error instanceof StepFilterError) {
      res.status(400).json({ error: error.message });
      return;
    }
    console.error("Error reading step usage:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};
