import { Request, Response } from "express";
import { listStepExecutors } from "../services/stepExecutorService";

export const listExecutorsHandler = async (
  _req: Request,
  res: Response
): Promise<void> => {
  try {
    const executors = await listStepExecutors();
    res.json(
      executors.map((e) => ({
        type: e.step_type,
        description: e.description,
        accepts: e.accepts,
        produces: e.produces,
        params: e.params,
      }))
    );
  } catch (error) {
    console.error("Error listing executors:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};
