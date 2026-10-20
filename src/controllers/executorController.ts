import { Request, Response } from "express";
import {
  listStepExecutors,
  upsertStepExecutor,
} from "../services/stepExecutorService";
import { UpsertStepExecutorRequest } from "../types";

const executorView = (e: Awaited<ReturnType<typeof listStepExecutors>>[number]) => ({
  type: e.step_type,
  description: e.description,
  accepts: e.accepts,
  produces: e.produces,
  params: e.params,
  runner: e.runner,
  executor_ref: e.executor_ref,
  n8n_workflow: e.n8n_workflow,
  requires: e.requires,
  max_attempts: e.max_attempts,
  lease_seconds: e.lease_seconds,
});

export const listExecutorsHandler = async (
  _req: Request,
  res: Response
): Promise<void> => {
  try {
    const executors = await listStepExecutors();
    res.json(executors.map(executorView));
  } catch (error) {
    console.error("Error listing executors:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

const isStringMap = (value: unknown): value is Record<string, string> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.values(value).every((v) => typeof v === "string");

const isPositiveInt = (value: unknown): boolean =>
  typeof value === "number" && Number.isInteger(value) && value >= 1;

export const upsertExecutorHandler = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    const stepType = req.params.step_type;
    if (!stepType) {
      res.status(400).json({ error: "step_type is required" });
      return;
    }
    const body = (req.body ?? {}) as UpsertStepExecutorRequest;
    const runner = body.runner ?? "n8n";
    if (runner !== "n8n" && runner !== "api") {
      res.status(400).json({ error: 'runner must be "n8n" or "api"' });
      return;
    }
    if (req.auth?.role === "scheduler" && runner !== "api") {
      res.status(403).json({ error: 'The scheduler role may only upsert executors with runner "api"' });
      return;
    }
    const executorRef = body.executor_ref ?? body.n8n_workflow;
    if (typeof executorRef !== "string" || !executorRef) {
      res.status(400).json({ error: "executor_ref must be a non-empty string" });
      return;
    }
    if (!isStringMap(body.accepts) || !isStringMap(body.produces)) {
      res.status(400).json({ error: "accepts and produces must map slot names to artifact types" });
      return;
    }
    if (body.requires !== undefined && (typeof body.requires !== "object" || body.requires === null || Array.isArray(body.requires))) {
      res.status(400).json({ error: "requires must be an object" });
      return;
    }
    if (body.max_attempts !== undefined && !isPositiveInt(body.max_attempts)) {
      res.status(400).json({ error: "max_attempts must be a positive integer" });
      return;
    }
    if (body.lease_seconds !== undefined && !isPositiveInt(body.lease_seconds)) {
      res.status(400).json({ error: "lease_seconds must be a positive integer" });
      return;
    }
    const { executor, created } = await upsertStepExecutor(stepType, {
      ...body,
      runner,
      executor_ref: executorRef,
    });
    res.status(created ? 201 : 200).json({ ...executorView(executor), created });
  } catch (error) {
    console.error("Error upserting executor:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};
