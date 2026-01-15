# Ordo

## Why Ordo exists

I built Ordo to solve a gap I kept running into between workflow execution and job orchestration.

Tools like n8n are great at executing steps, integrating systems, and handling side effects. What they do not give you is a durable, contract-driven control plane for complex, long-running jobs where dataflow, validation, and lifecycle really matter. I kept needing something that could sit above execution, stay simple, and still be strict.

Ordo is that layer.

Right now, Ordo is primarily designed to work with n8n as the execution engine, where n8n workers pull work from Ordo and perform the actual computation and I/O. That said, n8n is an implementation detail, not a requirement. The orchestration model itself is intentionally generic and should apply just as well to other runners.

## What Ordo does

Ordo focuses on orchestration, not execution.

It:
- validates job definitions and recipes before anything runs,
- enforces explicit input and output contracts between steps,
- models workflows as deterministic, artifact-based DAGs,
- tracks jobs, steps, and artifacts as first-class state,
- separates computation from delivery and finalization,
- and acts as a single, queryable source of truth for job state.

It assumes execution happens elsewhere and keeps its own responsibilities narrow on purpose.

## What Ordo does not do

Ordo does not:
- execute steps itself,
- manage workers or infrastructure,
- provide a workflow editor or UI,
- try to replace tools like n8n, Airflow, or Argo,
- or perform storage and file operations directly.

Those problems are better handled by execution engines and infrastructure, not by the orchestration core.

## Where Ordo might go next

Today, Ordo integrates closely with n8n, including direct database-based job claiming. That is a pragmatic choice, not a fundamental constraint.

Over time, I expect Ordo to evolve toward:
- decoupling job retrieval and management from direct database access,
- supporting queue- or API-based runners,
- running multiple execution backends side by side,
- and standing on its own as a reusable control plane for heterogeneous job execution.

Those are natural extensions, not prerequisites.

## Setup

1. Install dependencies:

```bash
npm install
```

2. Create a `.env` file (copy from `.env.example`):

```bash
API_TOKEN=your-secret-token-here
DATABASE_URL=postgresql://user:password@localhost:5432/ordo
DB_SCHEMA=ordo
PORT=3000
```

`DB_SCHEMA` defaults to `ordo` when unset or empty. Ordo runs migrations on startup and creates the schema and tables if they do not exist.

3. Build the project:

```bash
npm run build
```

4. Start the server:

```bash
npm start
```

For development with auto-reload:

```bash
npm run dev
```

## API Endpoints

All endpoints (except `/health`) require Bearer token authentication via the `Authorization` header.

### POST /recipes

Register a new recipe.

**Request:**

```json
{
  "name": "example-recipe",
  "version": "1.0.0",
  "definition": {
    "recipe": [
      {
        "id": "step1",
        "type": "PROCESS_TYPE",
        "inputs": {
          "input_slot": "artifact_name"
        },
        "outputs": ["output_artifact"],
        "params": {}
      }
    ]
  }
}
```

**Note:** The `inputs` field is an object mapping executor slot names to artifact names. The key is the executor's input slot (from `step_executor.accepts`), and the value is the artifact name to bind to that slot.

**Response:**

```json
{
  "id": 1
}
```

### POST /recipes/validate

Validate a recipe definition without creating it. Useful for checking recipe validity before registration.

**Request:**

```json
{
  "definition": {
    "recipe": [
      {
        "id": "step1",
        "type": "PROCESS_TYPE",
        "inputs": {
          "input_slot": "artifact_name"
        },
        "outputs": ["output_artifact"],
        "params": {}
      }
    ]
  }
}
```

**Response (valid):**

```json
{
  "valid": true
}
```

**Response (invalid):**

```json
{
  "valid": false,
  "error": "Unsupported step type: INVALID_TYPE"
}
```

### POST /jobs

Create a job from a recipe.

**Request:**

```json
{
  "recipe_id": 1,
  "inputs": {
    "input_artifact": {
      "type": "las",
      "uri": "s3://bucket/path/to/file.las",
      "hash": "abc123",
      "metadata": {}
    }
  },
  "outputs": {
    "output_artifact": {
      "path": "final/storage/path"
    }
  }
}
```

**Request Fields:**
- `recipe_id` (optional): ID of an existing recipe
- `recipe` (optional): Recipe definition (name, version, definition) - used if `recipe_id` is not provided
- `inputs` (required): Object mapping artifact names to artifact metadata (type, uri, hash, optional metadata)
- `outputs` (optional): Object mapping artifact names to final destination paths. All artifact names must be producible by the recipe DAG.

**Response:**

```json
{
  "id": 1
}
```

**Job-Level Outputs:**

Job-level outputs declare which artifacts should be finalized after a job completes. The API validates that all requested outputs exist in the recipe's producible artifact set, but does not copy, move, or interact with storage. All file operations are performed by n8n workflows after job completion.

- **Recipe-level outputs**: Used only to link steps in the DAG, always written to staging storage
- **Job-level outputs**: Declared at job creation, reference artifact names produced by recipe steps, define final destination paths, imply stable/no-TTL retention

### GET /jobs/:id

Get job status, steps, and artifacts.

**Response:**

```json
{
  "job": {
    "id": 1,
    "recipe_id": 1,
    "status": "pending",
    "created_at": "2024-01-01T00:00:00Z",
    "started_at": null,
    "finished_at": null,
    "error": null
  },
  "steps": [...],
  "artifacts": [...]
}
```

### GET /health

Health check endpoint (no authentication required).

## Recipe Validation

Recipes are validated against `step_executor` contracts before they can be stored. The validation ensures that:

- **Step types exist**: Every step type must exist in the `{schema}.step_executor` table
- **Input slot binding**: All input slots must exactly match the keys defined in `step_executor.accepts` (no missing, no extra). Each slot must be bound to an artifact name.
- **Outputs match executor contracts**: All outputs must exactly match the keys defined in `step_executor.produces` (no renamed, no additional)
- **Artifact flow is valid**: All referenced artifact names must be available (either from external inputs or produced by previous steps)
- **Artifact names are immutable**: Output artifact names must flow unchanged into downstream steps (no aliasing or renaming)

**Explicit Slot Binding Model:**

The recipe uses explicit slot binding to connect artifacts to executor input slots:

```json
{
  "inputs": {
    "input_las": "output_las"
  }
}
```

This means: "Bind artifact `output_las` to executor slot `input_las`". The key is the executor's input slot name (from `step_executor.accepts`), and the value is the artifact name (which may be an external input or produced by a previous step).

Validation happens automatically when creating a recipe via `POST /recipes`, and can be tested independently using `POST /recipes/validate`. Invalid recipes are rejected early with clear, actionable error messages.

## Example Pipeline

The following example demonstrates a complete pipeline for processing LiDAR data:

```json
{
  "recipe": {
    "name": "piney-dam-pipeline-example",
    "version": "1.0.0",
    "definition": {
      "recipe": [
        {
          "id": "reproject",
          "type": "REPROJECT_LAS",
          "params": {
            "source_epsg": "EPSG:2271",
            "target_epsg": "EPSG:3857"
          },
          "inputs": {
            "input_las": "input_las"
          },
          "outputs": ["output_las"]
        },
        {
          "id": "dem",
          "type": "GENERATE_DEM",
          "params": {
            "resolution": 1
          },
          "inputs": {
            "input_las": "output_las"
          },
          "outputs": ["output_dem"]
        },
        {
          "id": "hillshade",
          "type": "GENERATE_HILLSHADE",
          "params": {
            "azimuth": 315,
            "altitude": 45
          },
          "inputs": {
            "input_dem": "output_dem"
          },
          "outputs": ["output_hillshade"]
        },
        {
          "id": "contours",
          "type": "GENERATE_CONTOURS",
          "params": {
            "interval": 1
          },
          "inputs": {
            "input_dem": "output_dem"
          },
          "outputs": ["output_contours"]
        },
        {
          "id": "ept",
          "type": "BUILD_EPT",
          "params": {},
          "inputs": {
            "input_las": "output_las"
          },
          "outputs": ["output_ept"]
        }
      ]
    }
  }
}
```

**Artifact Flow:**

1. External input `input_las` is provided at job creation
2. `reproject` step binds `input_las` to its `input_las` slot and produces `output_las`
3. `dem` step binds `output_las` to its `input_las` slot and produces `output_dem`
4. `hillshade` and `contours` steps both bind `output_dem` to their `input_dem` slots (parallel execution)
5. `ept` step binds `output_las` to its `input_las` slot and produces `output_ept`

**Note:** Each artifact name must be unique across all steps. No two steps can produce the same artifact name.

**Explicit Slot Binding:**

The recipe uses explicit slot binding to connect artifacts to executor input slots. For example:

```json
{
  "inputs": {
    "input_las": "output_las"
  }
}
```

This means: "Bind artifact `output_las` (produced by a previous step) to executor slot `input_las`". The key is the executor's input slot name (from `step_executor.accepts`), and the value is the artifact name.

**Why This Design:**

- **Explicit contracts**: Executors define slots, recipes bind artifacts to slots - no guessing
- **Type safety**: The system can verify artifact types match step requirements
- **Deterministic execution**: Workers know exactly which artifacts to consume and produce
- **Safe DAG execution**: No ambiguity about artifact identity across the pipeline
- **Scales cleanly**: Supports fan-in, fan-out, multiple inputs of same type, and future optional inputs

This design enables safe, parallel execution of DAG-based pipelines where workers pull work directly from PostgreSQL.

## Architecture

- **Controllers**: Thin request/response handlers
- **Services**: Business logic and database operations
- **Middleware**: Authentication
- **Utils**: Validation utilities
- **Types**: TypeScript interfaces

The API validates recipes, creates jobs, and initializes job steps. Execution is handled by n8n workers that interact directly with the database.
