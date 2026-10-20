export interface StepDefinition {
  id: string;
  type: string;
  inputs: Record<string, string>;  // slot name -> namespaced artifact name (job:<n> or step:<id>.<slot>)
  outputs: Record<string, string>; // slot name -> namespaced artifact name (step:<id>.<slot>)
  param_keys?: string[];
  max_concurrency?: number;
  /** Overrides of the executor defaults for api-runner steps. */
  max_attempts?: number;
  lease_seconds?: number;
  requires?: Record<string, unknown>;
}

export interface OnExitStep {
  id: string;
  type: string;
  inputs: Record<string, string>; // slot name -> namespaced artifact ref
  param_keys?: string[];
}

export interface RecipeDefinition {
  recipe: StepDefinition[];
  on_exit?: OnExitStep;
}

export interface Recipe {
  id: number;
  name: string;
  version: string;
  definition: RecipeDefinition;
  created_at: Date;
}

export interface Job {
  id: number;
  recipe_id: number;
  /** "success" is written by the runner API and the n8n finalizer; "completed" is the legacy spelling. */
  status: "pending" | "running" | "success" | "completed" | "failed" | "partial";
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  error: string | null;
  params?: Record<string, Record<string, any>>; // step_id -> param name -> value
  idempotency_key?: string | null;
}

export interface JobStep {
  job_id: number;
  step_id: string;
  step_type: string;
  status: "pending" | "running" | "blocked" | "success" | "failed" | "skipped";
  attempt: number;
  claimed_by: string | null;
  claimed_at: Date | null;
  started_at: Date | null;
  finished_at: Date | null;
  error: string | null;
  max_concurrency: number | null;
  blocked_until?: Date | null;
  lease_expires_at?: Date | null;
  max_attempts?: number | null;
  lease_seconds?: number | null;
  requires?: Record<string, unknown> | null;
  /** Most recent job_step_detailing row for this step (by updated_at), or null if none exists. */
  last_detailing: JobStepDetailing | null;
}

export interface JobArtifact {
  job_id: number;
  name: string;
  type: string;
  uri: string;
  hash: string;
  producer_step: string | null;
  metadata: Record<string, any> | null;
  created_at: Date;
}

export interface JobOutput {
  job_id: number;
  artifact_name: string;
  path: string;
  /** Object key the finalizer actually wrote (a prefix ending in "/" for folder artifacts); null until delivered. */
  delivered_uri: string | null;
  delivered_at: Date | null;
  created_at: Date;
}

export interface JobStepDetailing {
  id: number;
  job_id: number;
  step_id: string;
  log: string | null;
  progress: Record<string, any> | null;
  updated_at: Date;
}

export interface CreateRecipeRequest {
  name: string;
  version: string;
  definition: RecipeDefinition;
}

export interface CreateJobRequest {
  recipe_id?: number;
  recipe?: {
    name: string;
    version: string;
    definition?: RecipeDefinition;
  };
  inputs: Record<
    string,
    {
      type: string;
      uri: string;
      hash: string;
      metadata?: Record<string, any>;
    }
  >;
  outputs?: Record<
    string,
    {
      path: string;
    }
  >;
  /** Optional. Keys are step IDs, values are param name -> value for that step. */
  params?: Record<string, Record<string, any>>;
  /** Optional. Unique per job; a repeat returns the existing job instead of creating another. */
  idempotency_key?: string;
}

export interface JobProgress {
  percentage: number;
  completed_steps: number;
  total_steps: number;
}

export interface JobTimelineEntry {
  step: string;
  type: string;
  status: JobStep["status"];
  started_at: Date | null;
  finished_at: Date | null;
  duration_ms: number | null;
}

export interface JobStatusResponse {
  job: Job;
  progress: JobProgress;
  duration_ms: number | null;
  timeline: JobTimelineEntry[];
  steps: JobStep[];
  artifacts: JobArtifact[];
  outputs: JobOutput[];
}

export type RunnerKind = "n8n" | "api";

export interface StepExecutor {
  step_type: string;
  /** Deprecated alias of executor_ref for n8n rows; null for api rows. */
  n8n_workflow: string | null;
  accepts: Record<string, string>; // slot name -> artifact type
  produces: Record<string, string>; // slot name -> artifact type
  description?: string | null;
  params?: Record<string, any> | null;
  runner?: RunnerKind;
  /** n8n: the workflow name. api: the runner's entrypoint, e.g. ara.steps.ingest_ecmwf. */
  executor_ref?: string | null;
  requires?: Record<string, unknown>;
  max_attempts?: number;
  lease_seconds?: number;
}

export interface UpsertStepExecutorRequest {
  runner?: RunnerKind;
  executor_ref?: string;
  n8n_workflow?: string;
  accepts: Record<string, string>;
  produces: Record<string, string>;
  description?: string | null;
  params?: Record<string, any> | null;
  requires?: Record<string, unknown>;
  max_attempts?: number;
  lease_seconds?: number;
}

export type Role = "admin" | "scheduler" | "runner";

export interface AuthContext {
  role: Role;
  keyId: number | null;
  keyName: string;
}

export interface ApiKeyRecord {
  id: number;
  name: string;
  role: Role;
  created_at: Date;
  revoked_at: Date | null;
  last_used_at: Date | null;
}

export interface ClaimRequest {
  worker_id: string;
  capabilities?: Record<string, unknown>;
  step_types?: string[];
  lease_seconds?: number;
}

export interface ClaimedStep {
  job_id: number;
  step_id: string;
  step_type: string;
  attempt: number;
  lease_token: string;
  lease_expires_at: Date;
  lease_seconds: number;
  executor_ref: string | null;
  inputs: Record<string, { type: string; uri: string; hash: string; metadata: Record<string, any> | null }>;
  params: Record<string, any>;
  job: { id: number; idempotency_key: string | null; params: Record<string, Record<string, any>> };
  credentials: null;
}

export interface CompleteRequest {
  lease_token: string;
  artifacts: Record<string, { type: string; uri: string; hash: string; metadata?: Record<string, any> }>;
}

export interface FailRequest {
  lease_token: string;
  kind: "error" | "wait";
  error?: string;
  retry?: boolean;
  cooldown_seconds?: number;
}
