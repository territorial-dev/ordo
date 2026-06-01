# Pipeline Authoring Guide

This guide explains how to define pipelines and register step executors in Ordo.

---

## 1. Introduction

Ordo is an orchestration control plane for artifact-based data pipelines. You define what should happen — which steps to run, in what order, and using which data — and a separate execution engine (such as n8n) carries out the actual work.

Pipelines in Ordo are expressed as **recipes**: directed acyclic graphs (DAGs) where nodes are processing steps and edges are artifacts flowing between them. Ordo validates the structure of those recipes, manages job state, and tracks every artifact produced. It does not move files, run commands, or make network requests on its own.

The key separation to keep in mind: **Ordo owns intent and state; your execution engine owns effects.**

---

## 2. Core Concepts

### Recipe

A recipe is a named, versioned pipeline definition. It describes which steps to run, how data flows between them, and which parameters each step requires. A recipe is reusable — you can run it as many times as you want by creating new jobs from it.

Recipes are identified by `name` + `version` together. Changing the graph structure means creating a new version.

### Job

A job is a single execution of a recipe. When you create a job, you provide the concrete inputs (files, datasets), parameter values, and optional output destinations. Ordo initializes all steps and artifacts in a pending state; execution workers pick up the work from there.

### Step

A step is one node in the DAG. Each step has:

- A unique **ID** within the recipe (a string you choose, e.g. `"reproject"`)
- A **type** that maps to a registered executor (e.g. `"REPROJECT_LAS"`)
- **Inputs**: which artifacts it consumes, mapped to executor slot names
- **Outputs**: which artifacts it produces, mapped to executor slot names
- **param_keys**: the names of parameters it expects at job creation (optional)

### Artifact

An artifact is a named, typed, URI-referenced data object. It could be a file in object storage, a directory, or any other addressable resource. Artifacts are the edges of the DAG — every piece of data that flows between steps is an artifact.

Artifacts have:
- A **name** (namespaced, see below)
- A **type** (a string like `"las"`, `"geotiff"`, `"json"`)
- A **URI** pointing to its location
- A **hash** for integrity checking
- Optional **metadata**

### step_executor

The `step_executor` table is a registry of step types. Each row defines a contract: what inputs a step type accepts and what outputs it produces. Recipes are validated against these contracts — you cannot reference a step type that isn't registered, and your slot bindings must match the executor definition exactly.

### Namespaced Artifact References

Every artifact name in Ordo uses a namespace prefix that encodes its origin:

| Prefix | Meaning | Example |
|---|---|---|
| `job:` | A job-level input, provided at job creation | `job:input_las` |
| `step:` | An artifact produced by a specific step's output slot | `step:reproject.output_las` |

The `step:<stepId>.<slot>` format is self-documenting: it tells you exactly which step and which output slot produced the artifact. This makes DAG edges readable without needing a separate diagram.

Bare artifact names (without a prefix) are rejected by validation.

---

## 3. Recipe Structure

A recipe is a JSON object with three top-level fields:

| Field | Type | Description |
|---|---|---|
| `name` | string | A stable identifier for this pipeline |
| `version` | string | A version string (e.g. `"1.0.0"`, `"2024-01"`) |
| `definition` | object | Contains the `recipe` array of steps |

Each step in the `recipe` array has:

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | Unique step ID within the recipe |
| `type` | string | yes | Must match a registered `step_executor` entry |
| `inputs` | object | yes | Slot name → namespaced artifact reference |
| `outputs` | object | yes | Slot name → namespaced artifact name |
| `param_keys` | array | no | Names of parameters required at job creation |
| `max_concurrency` | integer | no | Maximum number of simultaneous instances of this step across all jobs. Must be ≥ 1. Enforced by n8n's lock mechanism; Ordo stores and exposes the value. |

### Minimal Valid Recipe

```json
{
  "name": "thumbnail-generator",
  "version": "1.0.0",
  "definition": {
    "recipe": [
      {
        "id": "resize",
        "type": "RESIZE_IMAGE",
        "param_keys": ["width", "height"],
        "inputs": {
          "source_image": "job:input_image"
        },
        "outputs": {
          "resized_image": "step:resize.resized_image"
        }
      }
    ]
  }
}
```

This recipe:
- Has one step (`resize`) of type `RESIZE_IMAGE`
- Consumes a job-level input artifact named `job:input_image` via the `source_image` slot
- Produces one artifact named `step:resize.resized_image` via the `resized_image` slot
- Requires two parameters at job creation: `width` and `height`

---

## 4. Artifact Wiring

### How Job Inputs Work

When you create a job, you supply the initial artifacts — the data that the first step(s) in the pipeline need. These are provided as a map of namespaced artifact name → artifact details:

```json
"inputs": {
  "job:input_image": {
    "type": "png",
    "uri": "s3://my-bucket/uploads/photo.png",
    "hash": "sha256:abc123..."
  }
}
```

The keys must exactly match the `job:` references declared in the recipe. Ordo validates that every required input is provided and that no unreferenced inputs are included.

### How Step Outputs Propagate

When a step completes, it registers the artifacts it produced. Those artifacts are then available for downstream steps to consume, matched by artifact name.

A downstream step references an upstream artifact by its full namespaced name:

```
"inputs": {
  "source_data": "step:resize.resized_image"
}
```

This wires the `resized_image` output of the `resize` step into the `source_data` input slot of the current step.

### Wiring Diagram

```
Job creation supplies:
  job:input_image  ──────────────────────────────► [resize]
                                                      │
                                              step:resize.resized_image
                                                      │
                                                      ▼
                                                  [compress]
                                                      │
                                          step:compress.compressed_image
                                                      │
                                                      ▼
                                                  [upload]
```

Each edge in the graph is an artifact with a namespaced name. The name encodes the producing step, so any step can reference any earlier artifact without ambiguity.

### Fan-Out

Multiple downstream steps can consume the same artifact:

```
step:reproject.output_las ──► [dem]
                          └──► [ept]
```

Both steps declare the same value in their `inputs`. Ordo resolves both references correctly and schedules them independently.

---

## 5. Parameters

### param_keys in Recipes

Recipes declare which parameters each step requires using `param_keys`. This is an array of parameter names — not values:

```json
{
  "id": "publish",
  "type": "PUBLISH_LAYER",
  "param_keys": ["workspace", "layer_name", "style"],
  "inputs": { ... },
  "outputs": { ... }
}
```

`param_keys` tells Ordo what to expect at job creation. It does not store any values. The same recipe can be run with different parameter values each time.

**Never put concrete values inside a recipe.** Recipes define structure; jobs supply values.

### Params Provided at Job Creation

When creating a job, supply concrete parameter values in the `params` field:

```json
"params": {
  "publish": {
    "workspace": "acme-corp",
    "layer_name": "q4-survey",
    "style": "dem_viridis"
  }
}
```

The key is the step ID; the value is an object mapping parameter name → value. Ordo validates that every key declared in `param_keys` has a corresponding value in `params`.

### Why Params Are Not Stored in Recipes

Parameters like workspace names, coordinate systems, and resolution values are execution-time decisions, not pipeline structure. Storing them in the recipe would create a new recipe version every time you change a parameter value. Instead:

- The recipe is stable and reusable
- Each job run supplies its own values
- Recipe versioning reflects structural changes only (new steps, changed connections)

### Example: Publishing Pipeline

A publishing pipeline that takes a GeoTIFF and publishes it to a map server:

```json
{
  "name": "raster-publishing",
  "version": "1.0.0",
  "definition": {
    "recipe": [
      {
        "id": "reproject",
        "type": "REPROJECT_RASTER",
        "param_keys": ["target_epsg"],
        "inputs": {
          "input_raster": "job:input_raster"
        },
        "outputs": {
          "output_raster": "step:reproject.output_raster"
        }
      },
      {
        "id": "publish",
        "type": "PUBLISH_LAYER",
        "param_keys": ["workspace", "layer_name"],
        "inputs": {
          "input_raster": "step:reproject.output_raster"
        },
        "outputs": {
          "published_layer": "step:publish.published_layer"
        }
      }
    ]
  }
}
```

Job creation for this recipe:

```json
{
  "recipe_id": 5,
  "inputs": {
    "job:input_raster": {
      "type": "geotiff",
      "uri": "s3://bucket/survey.tif",
      "hash": "sha256:def456..."
    }
  },
  "params": {
    "reproject": { "target_epsg": "EPSG:3857" },
    "publish": { "workspace": "acme", "layer_name": "survey-2024" }
  }
}
```

---

## 6. Concurrency Control

### What max_concurrency Does

Some steps are resource-intensive — GPU workloads, large memory allocations, licensed software with seat limits. Running too many of them in parallel can exhaust capacity or degrade results.

`max_concurrency` is an optional integer on a recipe step that caps how many instances of that step may run simultaneously across all active jobs. A value of `2` means at most two workers may be executing that step at any given time.

This is a **hint to the execution engine**, not an Ordo-enforced constraint. Ordo validates the value at recipe creation and stores it on each `job_step` row at job creation. Enforcement is the responsibility of n8n's step-claiming logic.

### Setting max_concurrency

Add it to any step that needs a cap:

```json
{
  "id": "dem",
  "type": "GENERATE_DEM",
  "param_keys": ["resolution"],
  "max_concurrency": 2,
  "inputs": {
    "input_las": "step:reproject.output_las"
  },
  "outputs": {
    "output_dem": "step:dem.output_dem"
  }
}
```

Rules:
- Must be a positive integer (≥ 1)
- `0`, negative values, and floats are rejected at recipe validation
- Omitting the field means no cap (n8n will claim the step freely)

### Per-Step, Not Per-Recipe

Different steps in the same recipe can have different caps, or none at all:

```json
"recipe": [
  { "id": "reproject", "type": "REPROJECT_LAS", ... },
  { "id": "dem",       "type": "GENERATE_DEM", "max_concurrency": 2, ... },
  { "id": "ept",       "type": "BUILD_EPT",    "max_concurrency": 1, ... }
]
```

Here `reproject` runs freely, `dem` is capped at 2, and `ept` runs exclusively one at a time across all jobs.

---

## 7. Job Outputs

### What Job Outputs Are

Job outputs declare which artifacts produced by the pipeline should be delivered to a stable, final location after the job completes. They are optional — if you don't declare any, the pipeline still runs, but no finalization delivery occurs.

### Declaring Job Outputs

In the job creation request, add an `outputs` map:

```json
"outputs": {
  "step:dem.output_dem": { "path": "deliverables/2024/dam-survey/dem.tif" },
  "step:hillshade.output_hillshade": { "path": "deliverables/2024/dam-survey/hillshade.tif" }
}
```

Each key is the full namespaced artifact name that the recipe produces. The value declares the final destination path where the artifact should be delivered.

Ordo validates that every artifact name in `outputs` is actually producible by the recipe. You cannot declare an output for an artifact that no step produces.

### Delivery Semantics

Delivery is handled by your execution engine's finalizer workflow, not by Ordo directly. Ordo stores the declared output destinations and makes them queryable. The finalizer reads these declarations after all steps complete, copies the artifacts to the specified paths, and marks the job as complete.

This separation means:

- Steps always write to staging storage
- Job outputs define the final delivery mapping
- The orchestration layer (Ordo) and the delivery layer (your finalizer) remain independent

---

## 8. The step_executor Table

The `step_executor` table is where you register the step types your pipeline can use. Every `type` field in a recipe must have a corresponding row here, or validation will fail.

### Schema

| Column | Type | Description |
|---|---|---|
| `step_type` | text (PK) | The identifier used in recipe `type` fields |
| `n8n_workflow` | text | The execution workflow to invoke |
| `accepts` | jsonb | Input slots: `{ slot_name: artifact_type }` |
| `produces` | jsonb | Output slots: `{ slot_name: artifact_type }` |

### Registering an Executor

```sql
INSERT INTO ordo.step_executor (step_type, n8n_workflow, accepts, produces)
VALUES (
  'REPROJECT_LAS',
  'lidar/reproject-las',
  '{"input_las": "las"}',
  '{"output_las": "las"}'
);
```

```sql
INSERT INTO ordo.step_executor (step_type, n8n_workflow, accepts, produces)
VALUES (
  'GENERATE_DEM',
  'lidar/generate-dem',
  '{"input_las": "las"}',
  '{"output_dem": "geotiff"}'
);
```

```sql
INSERT INTO ordo.step_executor (step_type, n8n_workflow, accepts, produces)
VALUES (
  'GENERATE_HILLSHADE',
  'lidar/generate-hillshade',
  '{"input_dem": "geotiff"}',
  '{"output_hillshade": "geotiff"}'
);
```

### How Contracts Relate to Recipes

When you register a step, you define its slot contract. When you write a recipe step, you bind artifact names to those slots. Ordo validates that the slots match exactly — no missing slots, no extra slots.

If `GENERATE_DEM` defines `accepts: { "input_las": "las" }`, then every recipe step of type `GENERATE_DEM` must have exactly one input, on the slot named `input_las`. Using any other slot name, or omitting this slot, will fail validation.

This contract enforcement prevents silent misconfigurations. If an executor changes its interface, recipes that depend on it will fail validation immediately.

---

## 9. Designing a New Step

Use this checklist when adding a new step type to your system.

### 1. Define Inputs

List every piece of data the step needs. For each input, decide:
- The **slot name**: a stable identifier used in recipe bindings
- The **artifact type**: what kind of data this is (e.g. `"las"`, `"geotiff"`, `"json"`)

Example: a contour generation step needs a DEM raster.
→ Slot: `input_dem`, type: `geotiff`

### 2. Define Outputs

List every artifact the step produces. For each output, decide:
- The **slot name**: what the executor will call this output
- The **artifact type**: what kind of data it produces

Example: contour generation produces a vector file.
→ Slot: `output_contours`, type: `geojson`

### 3. Choose param_keys

Identify which values should be runtime parameters (supplied per job), not hardcoded in the executor:
- Values that vary per run (e.g. contour interval, target CRS, output resolution)
- Values that affect results but not pipeline structure

Example: contour interval is a parameter.
→ `param_keys: ["interval"]`

### 4. Implement the Executor

Build the execution workflow that:
- Accepts inputs by slot name
- Uses parameter values passed at runtime
- Writes outputs to staging storage
- Returns the URIs and hashes of produced artifacts

Keep the executor stateless and idempotent where possible.

### 5. Register the step_executor Row

```sql
INSERT INTO ordo.step_executor (step_type, n8n_workflow, accepts, produces)
VALUES (
  'GENERATE_CONTOURS',
  'lidar/generate-contours',
  '{"input_dem": "geotiff"}',
  '{"output_contours": "geojson"}'
);
```

Once registered, the step type can be used in any recipe.

---

## 10. Best Practices

### Use Stable Step IDs

Step IDs are referenced by name in `params` and can appear in logs and tooling. Choose descriptive, stable identifiers:

```
Good:   "reproject", "generate_dem", "build_ept"
Avoid:  "step1", "s2", "tmp"
```

Once a recipe is in use, changing a step ID is a breaking change and requires a new recipe version.

### Use Deterministic Output Naming

Output artifact names encode the step ID and slot. If you rename a step or slot, all downstream references break. Treat step IDs and slot names as stable public interfaces once deployed.

### Keep Params Execution-Focused

Only declare `param_keys` for values that:
- Vary between job runs
- Are not derivable from the inputs themselves
- Represent choices made at dispatch time

Avoid using params to pass data that should be an artifact. If a downstream step needs a file, wire it as an artifact, not a parameter.

### Avoid Side-Effect Ambiguity

Each step should produce artifacts as its only observable output. Steps that post to external APIs, send notifications, or mutate shared state without producing an artifact create gaps in the audit trail. If a step has a side effect, consider wrapping the result (e.g. a delivery receipt) as an output artifact.

### Version Recipes When the Graph Changes

Create a new recipe version when:
- You add, remove, or rename a step
- You change how artifacts flow between steps
- You change what inputs or outputs a step uses

Do not create a new version for:
- Changes to parameter values (those are supplied per job)
- Changes inside an executor that don't affect its slot contract

---

## 11. Common Mistakes

### Unnamespaced Artifact References

**Wrong:**
```json
"inputs": { "input_las": "output_las" }
```

**Right:**
```json
"inputs": { "input_las": "job:input_las" }
// or
"inputs": { "input_las": "step:reproject.output_las" }
```

Every artifact reference must include a `job:` or `step:` prefix. Bare names are rejected.

### Output Name Reuse

**Wrong:** Two different steps assign the same artifact name:

```json
{ "outputs": { "result": "step:step_a.result" } },
{ "outputs": { "result": "step:step_b.result" } }
```

**Right:** Every artifact name in the DAG must be unique. Use distinct names for each step's outputs.

### Params Inside Recipes

**Wrong:**
```json
{
  "id": "reproject",
  "params": { "target_epsg": "EPSG:3857" }
}
```

**Right:** Recipes must not contain concrete parameter values. Declare what is needed:

```json
{
  "id": "reproject",
  "param_keys": ["target_epsg"]
}
```

Supply values in the job creation request under `params`.

### Executor Drift

If you change an executor's slot names or add/remove slots without updating the `step_executor` row, existing recipes will fail validation. Keep `step_executor` in sync with your actual executor implementations. Treat the `accepts` and `produces` columns as a contract that must be updated alongside the executor itself.

---

## 12. Full Example Pipeline

This example defines a complete LiDAR processing pipeline that reprojects a point cloud and generates three derivative products in parallel.

### Step Executors

Register these rows in `step_executor` before using the recipe:

```sql
INSERT INTO ordo.step_executor (step_type, n8n_workflow, accepts, produces)
VALUES (
  'REPROJECT_LAS',
  'lidar/reproject',
  '{"input_las": "las"}',
  '{"output_las": "las"}'
);

INSERT INTO ordo.step_executor (step_type, n8n_workflow, accepts, produces)
VALUES (
  'GENERATE_DEM',
  'lidar/dem',
  '{"input_las": "las"}',
  '{"output_dem": "geotiff"}'
);

INSERT INTO ordo.step_executor (step_type, n8n_workflow, accepts, produces)
VALUES (
  'GENERATE_HILLSHADE',
  'lidar/hillshade',
  '{"input_dem": "geotiff"}',
  '{"output_hillshade": "geotiff"}'
);

INSERT INTO ordo.step_executor (step_type, n8n_workflow, accepts, produces)
VALUES (
  'GENERATE_CONTOURS',
  'lidar/contours',
  '{"input_dem": "geotiff"}',
  '{"output_contours": "geojson"}'
);

INSERT INTO ordo.step_executor (step_type, n8n_workflow, accepts, produces)
VALUES (
  'BUILD_EPT',
  'lidar/ept',
  '{"input_las": "las"}',
  '{"output_ept": "ept"}'
);
```

### Recipe

```json
POST /recipes

{
  "name": "lidar-standard-pipeline",
  "version": "1.0.0",
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
}
```

### Artifact Flow

```
job:input_las
      │
      ▼
  [reproject]  (params: source_epsg, target_epsg)
      │
      └── step:reproject.output_las
                │
                ├────────────────────────────────► [ept]
                │                                    │
                │                         step:ept.output_ept
                │
                ▼
             [dem]  (params: resolution)
                │
                └── step:dem.output_dem
                          │
                          ├─────────────────► [hillshade]  (params: azimuth, altitude)
                          │                       │
                          │              step:hillshade.output_hillshade
                          │
                          └─────────────────► [contours]  (params: interval)
                                                  │
                                       step:contours.output_contours
```

Steps `hillshade`, `contours`, and `ept` can all run in parallel once their inputs are available.

### Job Creation

```json
POST /jobs

{
  "recipe_id": 1,
  "inputs": {
    "job:input_las": {
      "type": "las",
      "uri": "s3://survey-bucket/2024/dam-site/raw.las",
      "hash": "sha256:7f4a2b..."
    }
  },
  "params": {
    "reproject": {
      "source_epsg": "EPSG:2271",
      "target_epsg": "EPSG:3857"
    },
    "dem": {
      "resolution": 0.5
    },
    "hillshade": {
      "azimuth": 315,
      "altitude": 45
    },
    "contours": {
      "interval": 0.5
    }
  },
  "outputs": {
    "step:dem.output_dem": {
      "path": "deliverables/2024/dam-site/dem.tif"
    },
    "step:hillshade.output_hillshade": {
      "path": "deliverables/2024/dam-site/hillshade.tif"
    },
    "step:contours.output_contours": {
      "path": "deliverables/2024/dam-site/contours.geojson"
    },
    "step:ept.output_ept": {
      "path": "deliverables/2024/dam-site/ept"
    }
  }
}
```

The `ept` step has no `param_keys`, so it is omitted from `params`. The `reproject` step output (`step:reproject.output_las`) is consumed by both `dem` and `ept` — fan-out works by reference, with no duplication.

---

*For execution engine setup and worker configuration, see [USING_WITH_N8N.md](USING_WITH_N8N.md).*
