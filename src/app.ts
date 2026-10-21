import dotenv from "dotenv";
dotenv.config();

// Validate required environment variables
if (!process.env.API_TOKEN) {
  console.error("ERROR: API_TOKEN environment variable is required");
  process.exit(1);
}

if (!process.env.DATABASE_URL) {
  console.error("ERROR: DATABASE_URL environment variable is required");
  process.exit(1);
}

import express, { Request, Response } from "express";
import morgan from "morgan";
import { authMiddleware, requireRole } from "./middleware/auth";
import {
  createJobHandler,
  listJobsHandler,
  getJobStatusHandler,
  getBatchJobStatusHandler,
  retryJobHandler,
} from "./controllers/jobController";
import {
  listRecipesHandler,
  getRecipeHandler,
  createRecipeHandler,
  validateRecipeHandler,
} from "./controllers/recipeController";
import {
  listArtifactsHandler,
  getArtifactHandler,
} from "./controllers/artifactController";
import {
  listOutputsHandler,
  getOutputHandler,
} from "./controllers/outputController";
import {
  listExecutorsHandler,
  upsertExecutorHandler,
} from "./controllers/executorController";
import { listJobStepDetailingHandler } from "./controllers/jobStepDetailingController";
import {
  createKeyHandler,
  listKeysHandler,
  revokeKeyHandler,
} from "./controllers/keyController";
import {
  claimHandler,
  completeHandler,
  failHandler,
  heartbeatHandler,
} from "./controllers/runnerController";
import { closePool } from "./db/connection";
import { runMigrations } from "./db/migrations";
import { startSweeper } from "./services/runnerService";
import { version } from "../package.json";

const app = express();
const PORT = process.env.PORT || 3000;

// Request logging
morgan.token("timestamp", () => {
  return new Date().toISOString();
});

app.use(
  morgan(
    ":timestamp :method :url :status :response-time ms - :res[content-length]"
  )
);

app.use(express.json());

// Health check (no auth required)
app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok" });
});

// All other routes require authentication. API_TOKEN is the admin key; other
// keys come from the api_key table with a role (admin, scheduler, runner).
app.use(authMiddleware);

// Runner API: leased step execution over HTTP (runner role)
app.post("/runner/claim", requireRole("runner"), claimHandler);
app.post("/runner/steps/:job_id/:step_id/heartbeat", requireRole("runner"), heartbeatHandler);
app.post("/runner/steps/:job_id/:step_id/complete", requireRole("runner"), completeHandler);
app.post("/runner/steps/:job_id/:step_id/fail", requireRole("runner"), failHandler);

// Key management (admin only)
app.post("/keys", requireRole(), createKeyHandler);
app.get("/keys", requireRole(), listKeysHandler);
app.delete("/keys/:id", requireRole(), revokeKeyHandler);

// Executor registration (admin, or scheduler for runner "api")
app.put("/step-executors/:step_type", requireRole("scheduler"), upsertExecutorHandler);

// A runner may read the job it holds
app.get("/jobs/:id([0-9]+)", requireRole("scheduler", "runner"), getJobStatusHandler);

// Everything below: admin and scheduler
app.use(requireRole("scheduler"));

// Recipe endpoints
app.get("/recipes", listRecipesHandler);
app.get("/recipes/:id", getRecipeHandler);
app.post("/recipes/validate", validateRecipeHandler);
app.post("/recipes", createRecipeHandler);

// Job endpoints
app.get("/jobs", listJobsHandler);
app.get("/jobs/:ids([0-9,]+,[0-9,]+)", getBatchJobStatusHandler);
app.post("/jobs", createJobHandler);
app.post("/jobs/:id([0-9]+)/retry", retryJobHandler);

// Artifact endpoints
app.get("/artifacts", listArtifactsHandler);
app.get("/artifacts/:id", getArtifactHandler);

// Output endpoints
app.get("/outputs", listOutputsHandler);
app.get("/outputs/:id", getOutputHandler);

// Executor endpoints
app.get("/executors", listExecutorsHandler);

// Job step detailing endpoints (read-only; written by n8n and by runner heartbeats)
// Filter by job_id and/or step_id via query params; always ordered by updated_at.
app.get("/detailing", listJobStepDetailingHandler);

// Error handling middleware
app.use(
  (err: Error, _req: Request, res: Response, _next: express.NextFunction) => {
    console.error("Unhandled error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
);

// Graceful shutdown
process.on("SIGTERM", async () => {
  console.log("SIGTERM received, closing database pool...");
  await closePool();
  process.exit(0);
});

process.on("SIGINT", async () => {
  console.log("SIGINT received, closing database pool...");
  await closePool();
  process.exit(0);
});

if (require.main === module) {
  (async () => {
    try {
      await runMigrations();
      startSweeper(parseInt(process.env.SWEEPER_INTERVAL_SECONDS ?? "60", 10));
      app.listen(PORT, () => {
        console.log(`Ordo v${version} listening on port ${PORT}`);
      });
    } catch (error) {
      console.error("Failed to run migrations:", error);
      process.exit(1);
    }
  })();
}

export default app;
