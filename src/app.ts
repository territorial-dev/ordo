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
import { authMiddleware } from "./middleware/auth";
import {
  createRecipeHandler,
  validateRecipeHandler,
} from "./controllers/recipeController";
import {
  createJobHandler,
  getJobStatusHandler,
} from "./controllers/jobController";
import { closePool } from "./db/connection";

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

// All other routes require authentication
app.use(authMiddleware);

// Recipe endpoints
app.post("/recipes/validate", validateRecipeHandler);
app.post("/recipes", createRecipeHandler);

// Job endpoints
app.post("/jobs", createJobHandler);
app.get("/jobs/:id", getJobStatusHandler);

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
  app.listen(PORT, () => {
    console.log(`MapPrism API server listening on port ${PORT}`);
  });
}

export default app;
