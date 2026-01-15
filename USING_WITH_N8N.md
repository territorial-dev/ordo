# Using Ordo with n8n

Short summary: Ordo owns orchestration and state, while n8n executes steps. This guide describes how to wire n8n to Ordo and keep responsibilities clean. For an overview of Ordo itself, see the [main README](README.md).

Ordo is designed to work with n8n as an execution engine, not as a scheduler or control plane. In this setup, Ordo owns job state and orchestration, while n8n workers pull work from Ordo and perform the actual execution.

You are responsible for building and operating the n8n workflows themselves. Ordo provides the control plane, database structure, and job validation, but it does not ship or manage execution workflows.

## Architecture overview

At a high level:

- Ordo stores:
  - jobs
  - steps
  - artifacts
  - execution state
- n8n:
  - polls Ordo for runnable work
  - executes steps
  - produces artifacts
  - updates Ordo with results

There are two distinct n8n workflows:

1. Job Runner: executes individual job steps
2. Job Finalizer: finalizes completed jobs and delivers outputs

These workflows are independent and should not call each other.

## Prerequisites

- A running Ordo API and database
- n8n running in queue or multi-worker mode
- n8n workers with access to:
  - the Ordo database (read/write)
  - artifact storage (filesystem, MinIO, or S3)
  - required processing tools in the n8n worker image (PDAL, GDAL, etc.)

## Database access

n8n must be allowed to read and write directly to the Ordo database.

This is intentional.

Ordo acts as the control plane, and n8n workers:

- claim steps
- update execution state
- register produced artifacts

Future versions may decouple this via APIs or queues, but direct DB access is the current, supported model.

## Workflow 1: Job Runner

The Job Runner workflow executes one job step at a time.

Responsibilities:

1. Claims a runnable job step from Ordo
2. Validates required input artifacts are available
3. Executes the step (often via a sub-workflow)
4. Registers produced artifacts
5. Updates step and job state

It must not:

- finalize jobs
- move artifacts to final locations
- decide which artifacts are outputs

### Step claiming

The workflow starts by atomically claiming a runnable step:

- status is pending or blocked
- no unmet cooldown (blocked_until)
- row is locked using `FOR UPDATE SKIP LOCKED`

This ensures:

- multiple workers can run safely
- no step is executed twice

### Input resolution

Inputs are resolved using explicit slot bindings defined in the recipe:

```json
{
  "inputs": {
    "input_las": "output_las"
  }
}
```

The Job Runner:

- resolves artifact names to artifact records
- passes inputs to the executor by slot name
- fails or blocks the step if inputs are missing

### Execution

Each step type maps to an n8n sub-workflow.

The Job Runner:

- looks up the executor definition
- invokes the corresponding sub-workflow
- passes:
  - resolved inputs
  - step parameters
  - job and step identifiers

The sub-workflow performs computation and writes outputs to staging storage.

### Artifact registration

After execution, the Job Runner:

- records produced artifacts in `job_artifact`
- associates them with the producing step
- does not decide retention or final location

## Workflow 2: Job Finalizer

The Job Finalizer workflow is responsible for delivery and closure, not execution.

It should run:

- periodically (polling), or
- triggered by job status changes

Responsibilities:

1. Finds jobs with no remaining runnable steps
2. Determines final job outcome (success or partial)
3. Resolves declared job outputs
4. Copies output artifacts to stable locations
5. Finalizes the job

It must not:

- execute steps
- retry steps
- infer outputs
- mutate recipes

### Job selection

A job is eligible for finalization when:

- no job steps are pending, running, or blocked
- job status is not already terminal

### Output detection

Declared job outputs are stored in `job_output`.

For each job:

- fetch declared outputs
- fetch produced artifacts
- match by artifact name

Only artifacts explicitly declared as job outputs are delivered.

### Artifact delivery

For each declared output that exists:

- copy the artifact from staging to the final path
- mark the artifact as stable (no TTL)

All copies must be:

- idempotent
- retry-safe

Missing outputs result in a partial job.

### Job finalization

After delivery:

- update job status to success or partial
- set `finished_at`

Finalization is performed once per job.

## Logging and observability

- Full logs live outside the database (filesystem or object storage)
- n8n may write log tails and progress updates to Ordo tables
- Ordo remains the source of truth for job and step state

## Design principles to keep in mind

- Ordo validates intent, n8n performs effects
- Recipes define dataflow, jobs define delivery
- Steps always write to staging
- Finalization is a separate phase
- No execution logic lives in the API

Following these rules keeps the system predictable, debuggable, and scalable.
