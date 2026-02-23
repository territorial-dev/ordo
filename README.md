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
  "params": {
    "step_id": { "param_name": "value" }
  },
  "outputs": {
    "output_artifact": {
      "path": "final/storage/path"
    }
  }
}
```

(`params` is optional; keys are step IDs, values are param name → value for that step.)

**Request Fields:**
- `recipe_id` (optional): ID of an existing recipe
- `recipe` (optional): Recipe definition (name, version, definition) - used if `recipe_id` is not provided
- `inputs` (required): Object mapping artifact names to artifact metadata (type, uri, hash, optional metadata)
- `outputs` (optional): Object mapping artifact names to final destination paths. All artifact names must be producible by the recipe DAG.
- `params` (optional): Object mapping step IDs to param objects (param name → value). Supplies concrete parameter values for steps that declare `required_params` in the recipe. Parameter values are not part of recipe identity and do not affect recipe versioning.

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
    "error": null,
    "params": {}
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
- **Step parameters**: Steps must not contain `params` (concrete values). Steps may declare required parameter names via optional `required_params` (array of strings). Steps with no required params can omit `required_params`.
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

**Recipe vs job:** Recipes define pipeline structure (steps, inputs, outputs, and which parameters each step requires via `required_params`). Jobs supply concrete values at creation time: initial artifacts, optional outputs, and per-step parameter values in `params`. Parameter values are not part of recipe identity and do not affect recipe versioning.

**Upgrading existing recipes:** If you have recipes stored with the old shape (steps with `params` objects containing concrete values), run the one-off migration script once: `npx ts-node scripts/migrate-recipe-params.ts`. It rewrites each step's `params` to `required_params` (array of param names) so the new validation and job-level params work correctly.

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
          "required_params": ["source_epsg", "target_epsg"],
          "inputs": {
            "input_las": "input_las"
          },
          "outputs": ["output_las"]
        },
        {
          "id": "dem",
          "type": "GENERATE_DEM",
          "required_params": ["resolution"],
          "inputs": {
            "input_las": "output_las"
          },
          "outputs": ["output_dem"]
        },
        {
          "id": "hillshade",
          "type": "GENERATE_HILLSHADE",
          "required_params": ["azimuth", "altitude"],
          "inputs": {
            "input_dem": "output_dem"
          },
          "outputs": ["output_hillshade"]
        },
        {
          "id": "contours",
          "type": "GENERATE_CONTOURS",
          "required_params": ["interval"],
          "inputs": {
            "input_dem": "output_dem"
          },
          "outputs": ["output_contours"]
        },
        {
          "id": "ept",
          "type": "BUILD_EPT",
          "inputs": {
            "input_las": "output_las"
          },
          "outputs": ["output_ept"]
        }
      ]
    }
  },
  "params": {
    "reproject": { "source_epsg": "EPSG:2271", "target_epsg": "EPSG:3857" },
    "dem": { "resolution": 1 },
    "hillshade": { "azimuth": 315, "altitude": 45 },
    "contours": { "interval": 1 }
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

## New Recipe Format

Starting with schema v2, Ordo supports a more expressive recipe format. Legacy recipes continue to work without modification.

### Typed outputs

In the legacy format, `outputs` is a flat list of artifact names:

```json
"outputs": ["output_las"]
```

In the new format, `outputs` is a map of executor slot names to artifact names:

```json
"outputs": {
  "output_las": "step:reproject.output_las"
}
```

The key is the executor's output slot (matching `step_executor.produces`). The value is the artifact name assigned to that slot in the DAG. This mirrors the shape of `inputs` and makes contracts explicit on both sides of every step.

### param_keys

In the new format, use `param_keys` instead of `required_params` to declare which parameters a step requires:

```json
"param_keys": ["source_epsg", "target_epsg"]
```

`param_keys` must be an array of unique strings. Concrete values are still supplied at job creation via `params`, unchanged.

### Namespaced artifact references

Artifact names in the new format use a namespace prefix to make their origin explicit:

| Prefix | Meaning | Example |
|---|---|---|
| `job:` | A job-level input artifact | `job:input_las` |
| `step:` | An artifact produced by a specific step's output slot | `step:reproject.output_las` |

Use these namespaced references as artifact name values in both `inputs` and `outputs`. The `step:stepId.slot` form encodes the producing step and slot directly in the name, making DAG edges self-documenting.

### Example — new format (LiDAR pipeline)

The following is the [Example Pipeline](#example-pipeline) rewritten in the new format:

```json
{
  "recipe": {
    "name": "piney-dam-pipeline-example",
    "version": "2.0.0",
    "definition": {
      "recipe": [
        {
          "id": "reproject",
          "type": "REPROJECT_LAS",
          "param_keys": ["source_epsg", "target_epsg"],
          "inputs": {
            "input_las": "job:input_las"
          },
          "outputs": {
            "output_las": "step:reproject.output_las"
          }
        },
        {
          "id": "dem",
          "type": "GENERATE_DEM",
          "param_keys": ["resolution"],
          "inputs": {
            "input_las": "step:reproject.output_las"
          },
          "outputs": {
            "output_dem": "step:dem.output_dem"
          }
        },
        {
          "id": "hillshade",
          "type": "GENERATE_HILLSHADE",
          "param_keys": ["azimuth", "altitude"],
          "inputs": {
            "input_dem": "step:dem.output_dem"
          },
          "outputs": {
            "output_hillshade": "step:hillshade.output_hillshade"
          }
        },
        {
          "id": "contours",
          "type": "GENERATE_CONTOURS",
          "param_keys": ["interval"],
          "inputs": {
            "input_dem": "step:dem.output_dem"
          },
          "outputs": {
            "output_contours": "step:contours.output_contours"
          }
        },
        {
          "id": "ept",
          "type": "BUILD_EPT",
          "inputs": {
            "input_las": "step:reproject.output_las"
          },
          "outputs": {
            "output_ept": "step:ept.output_ept"
          }
        }
      ]
    }
  },
  "params": {
    "reproject": { "source_epsg": "EPSG:2271", "target_epsg": "EPSG:3857" },
    "dem": { "resolution": 1 },
    "hillshade": { "azimuth": 315, "altitude": 45 },
    "contours": { "interval": 1 }
  }
}
```

**What changed from the legacy format:**

- `outputs` is now a map: the key is the executor slot (`output_las`), the value is the artifact name assigned in the DAG.
- Artifact names use `job:` and `step:` prefixes. `job:input_las` means "the artifact named `input_las` provided at job creation". `step:reproject.output_las` means "the `output_las` slot produced by the `reproject` step".
- `param_keys` replaces `required_params`. The shape is identical (array of unique strings); only the field name changes.
- Concrete `params` at job creation are unchanged.

**Artifact flow with namespaced refs:**

1. `job:input_las` is provided at job creation
2. `reproject` binds `job:input_las` to its `input_las` slot and names its output `step:reproject.output_las`
3. `dem` and `ept` both reference `step:reproject.output_las` directly in their `inputs` — the producing step is clear from the name alone
4. `hillshade` and `contours` reference `step:dem.output_dem` (parallel execution, same as legacy)

**POST /recipes with new format:**

```json
{
  "name": "piney-dam-pipeline-example",
  "version": "2.0.0",
  "definition": {
    "recipe": [
      {
        "id": "reproject",
        "type": "REPROJECT_LAS",
        "param_keys": ["source_epsg", "target_epsg"],
        "inputs": { "input_las": "job:input_las" },
        "outputs": { "output_las": "step:reproject.output_las" }
      }
    ]
  }
}
```

**POST /jobs with new format:**

```json
{
  "recipe_id": 1,
  "inputs": {
    "job:input_las": {
      "type": "las",
      "uri": "s3://bucket/path/to/file.las",
      "hash": "abc123"
    }
  },
  "params": {
    "reproject": { "source_epsg": "EPSG:2271", "target_epsg": "EPSG:3857" }
  },
  "outputs": {
    "step:reproject.output_las": { "path": "final/storage/reprojected.las" }
  }
}
```

## Architecture

- **Controllers**: Thin request/response handlers
- **Services**: Business logic and database operations
- **Middleware**: Authentication
- **Utils**: Validation utilities
- **Types**: TypeScript interfaces

The API validates recipes, creates jobs, and initializes job steps. Execution is handled by n8n workers that interact directly with the database.
