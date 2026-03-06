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

## Documentation

- [Pipeline Authoring Guide](PIPELINE-AUTHORING.md) — how to define pipelines, register executors, and create jobs
- [Using Ordo with n8n](USING_WITH_N8N.md) — execution engine setup and worker configuration

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
        "param_keys": ["param_name"],
        "inputs": {
          "input_slot": "job:artifact_name"
        },
        "outputs": {
          "output_slot": "step:step1.output_slot"
        }
      }
    ]
  }
}
```

**Note:** `inputs` maps executor slot names to namespaced artifact references (`job:<name>` for job-level inputs, `step:<stepId>.<slot>` for step outputs). `outputs` maps executor slot names to the artifact name assigned to that slot — use `step:<stepId>.<slot>` by convention.

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
          "input_slot": "job:artifact_name"
        },
        "outputs": {
          "output_slot": "step:step1.output_slot"
        }
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

You can also query by an array of IDs, for example: `/jobs/1,2,3`

The response will be an array of objects instead of a single object:

```
[
  {
    "job": {
      "id": 1,
      ...
    },
    "steps": [...],
    "artifacts": [...]
  },
  {
    "job": {
      "id": 2,
      ...
    },
    "steps": [...],
    "artifacts": [...]
  },
  {
    "job": {
      "id": 3,
      ...
    },
    "steps": [...],
    "artifacts": [...]
  },
]
```


### GET /health

Health check endpoint (no authentication required).

## Recipe Validation

Recipes are validated against `step_executor` contracts before they can be stored. The validation ensures that:

- **Step types exist**: Every step type must exist in the `{schema}.step_executor` table
- **Step parameters**: Steps must not contain `params` (concrete values). Steps may declare required parameter names via optional `param_keys` (array of unique strings). Steps with no required params can omit `param_keys`.
- **Input slot binding**: All input slots must exactly match the keys defined in `step_executor.accepts` (no missing, no extra). Each slot value must be a namespaced artifact reference.
- **Output slot binding**: All output slots must exactly match the keys defined in `step_executor.produces` (no missing, no extra). Each slot value must be a namespaced artifact name.
- **Namespaced artifact references**: All artifact names must use a namespace prefix — `job:<name>` for job-level inputs, `step:<stepId>.<slot>` for step-produced artifacts. Bare names are rejected.
- **Artifact flow is valid**: All referenced artifact names must be available (either from external inputs or produced by previous steps)
- **Artifact names are unique**: No two steps may assign the same artifact name.

**Slot binding model:**

```json
{
  "inputs": { "input_las": "step:reproject.output_las" },
  "outputs": { "output_dem": "step:dem.output_dem" }
}
```

`inputs` keys are executor input slots (from `step_executor.accepts`); values are namespaced artifact references. `outputs` keys are executor output slots (from `step_executor.produces`); values are the artifact names assigned to those slots.

Validation runs automatically on `POST /recipes` and can be tested independently via `POST /recipes/validate`. Errors include migration guidance when a legacy pattern is detected.

**Recipe vs job:** Recipes define pipeline structure (steps, slot bindings, and which parameters each step requires via `param_keys`). Jobs supply concrete values at creation time: initial artifacts (keyed by `job:<name>`), optional output destinations, and per-step parameter values in `params`. Parameter values are not part of recipe identity and do not affect versioning.

## Example Pipeline

The following demonstrates a complete LiDAR processing pipeline.

**Recipe (`POST /recipes`):**

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
      },
      {
        "id": "dem",
        "type": "GENERATE_DEM",
        "param_keys": ["resolution"],
        "inputs": { "input_las": "step:reproject.output_las" },
        "outputs": { "output_dem": "step:dem.output_dem" }
      },
      {
        "id": "hillshade",
        "type": "GENERATE_HILLSHADE",
        "param_keys": ["azimuth", "altitude"],
        "inputs": { "input_dem": "step:dem.output_dem" },
        "outputs": { "output_hillshade": "step:hillshade.output_hillshade" }
      },
      {
        "id": "contours",
        "type": "GENERATE_CONTOURS",
        "param_keys": ["interval"],
        "inputs": { "input_dem": "step:dem.output_dem" },
        "outputs": { "output_contours": "step:contours.output_contours" }
      },
      {
        "id": "ept",
        "type": "BUILD_EPT",
        "inputs": { "input_las": "step:reproject.output_las" },
        "outputs": { "output_ept": "step:ept.output_ept" }
      }
    ]
  }
}
```

**Job (`POST /jobs`):**

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
    "reproject": { "source_epsg": "EPSG:2271", "target_epsg": "EPSG:3857" },
    "dem": { "resolution": 1 },
    "hillshade": { "azimuth": 315, "altitude": 45 },
    "contours": { "interval": 1 }
  },
  "outputs": {
    "step:dem.output_dem": { "path": "final/dem.tif" },
    "step:hillshade.output_hillshade": { "path": "final/hillshade.tif" },
    "step:contours.output_contours": { "path": "final/contours.geojson" },
    "step:ept.output_ept": { "path": "final/ept" }
  }
}
```

**Artifact flow:**

1. `job:input_las` is provided at job creation
2. `reproject` binds `job:input_las` to its `input_las` slot and assigns `step:reproject.output_las` to the result
3. `dem` and `ept` both consume `step:reproject.output_las` — the producing step is visible in the name
4. `hillshade` and `contours` both consume `step:dem.output_dem` (parallel fan-out)
5. Job `outputs` reference artifact names by their full `step:<id>.<slot>` identifiers

**Why this design:**

- **Self-documenting edges**: `step:reproject.output_las` tells you exactly which step and slot produced the artifact — no external mapping needed
- **Explicit contracts**: Executors define slots; recipes bind named artifacts to slots on both sides
- **Safe fan-out**: Multiple downstream steps can reference the same `step:X.Y` artifact without ambiguity
- **Deterministic execution**: Workers know exactly which artifacts to consume and produce

## on_exit hook

A recipe can declare an optional `on_exit` step that runs after the job has been fully finalized — after all DAG steps have completed and all declared artifacts have been moved to their final storage destinations. It is not part of the DAG. Ordo validates it at recipe creation and validates its params at job creation. n8n reads it from the stored recipe definition when executing the finalization workflow.

### When it runs

After job completion and artifact finalization. The full artifact set is available: both initial inputs and all step outputs.

### Declaring on_exit

Add an `on_exit` object alongside the `recipe` array in the definition:

```json
{
  "name": "my-pipeline",
  "version": "1.0.0",
  "definition": {
    "recipe": [...],
    "on_exit": {
      "id": "notify",
      "type": "SEND_WEBHOOK",
      "inputs": {
        "payload": "step:dem.output_dem"
      },
      "param_keys": ["webhook_url"]
    }
  }
}
```

### Allowed fields

| Field | Required | Description |
|---|---|---|
| `id` | yes | Unique identifier for this hook (used as the key in job `params`) |
| `type` | yes | Executor type — must exist in `step_executor` |
| `inputs` | yes | Slot → namespaced artifact ref, same rules as regular step inputs |
| `param_keys` | no | Array of unique strings declaring required param names |

### Prohibited fields

- `outputs` — on_exit steps do not produce artifacts
- `depends_on` — on_exit is not wired into the DAG graph

### Input artifact references

`inputs` follows the same namespaced ref rules as regular steps (`job:<name>` or `step:<stepId>.<slot>`). The on_exit step can reference any artifact available in the DAG — both initial job inputs and outputs produced by any step.

### Supplying params at job creation

Provide params for the on_exit step under `params[on_exit.id]` in the job creation request:

```json
{
  "recipe_id": 1,
  "inputs": { ... },
  "params": {
    "step1": { "resolution": 1 },
    "notify": { "webhook_url": "https://example.com/hook" }
  }
}
```

### Example use cases

- Post-job webhooks to notify downstream systems
- Cache invalidation after artifact delivery
- Search index updates after finalization
- Triggering dependent pipelines

## Recipe Format

The current recipe format requires typed output maps and namespaced artifact references. The legacy format (array outputs, bare artifact names, `required_params`) is no longer accepted — submitting it returns a validation error with migration instructions.

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

## Migrating from the Legacy Format

The legacy recipe format is no longer accepted. Validation errors include the migration action needed.

### 1. Outputs: array → typed map

```json
// Before
"outputs": ["output_las"]

// After
"outputs": { "output_las": "step:reproject.output_las" }
```

The key is the executor output slot (unchanged from before). The value is the artifact name to assign — use `step:<stepId>.<slot>` by convention.

### 2. Input artifact references: bare name → namespaced

```json
// Before
"inputs": { "input_las": "output_las" }

// After — referencing a job-level input
"inputs": { "input_las": "job:input_las" }

// After — referencing a previous step's output
"inputs": { "input_las": "step:reproject.output_las" }
```

### 3. Parameter declaration: required_params → param_keys

```json
// Before
"required_params": ["source_epsg", "target_epsg"]

// After
"param_keys": ["source_epsg", "target_epsg"]
```

The shape is identical (array of unique strings). Rename the field only.

### 4. Job inputs: bare key → job: prefix

```json
// Before
"inputs": { "input_las": { "type": "las", "uri": "...", "hash": "..." } }

// After
"inputs": { "job:input_las": { "type": "las", "uri": "...", "hash": "..." } }
```

The `job:` key must match the artifact name referenced in the recipe's `inputs` values.

### 5. Job outputs: bare key → step: prefix

```json
// Before
"outputs": { "output_dem": { "path": "final/dem.tif" } }

// After
"outputs": { "step:dem.output_dem": { "path": "final/dem.tif" } }
```

The key must match the artifact name assigned in the recipe step's `outputs` map.

## Architecture

- **Controllers**: Thin request/response handlers
- **Services**: Business logic and database operations
- **Middleware**: Authentication
- **Utils**: Validation utilities
- **Types**: TypeScript interfaces

The API validates recipes, creates jobs, and initializes job steps. Execution is handled by n8n workers that interact directly with the database.
