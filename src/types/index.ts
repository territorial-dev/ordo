export interface StepDefinition {
  id: string;
  type: string;
  inputs: Record<string, string>;  // slot name -> namespaced artifact name (job:<n> or step:<id>.<slot>)
  outputs: Record<string, string>; // slot name -> namespaced artifact name (step:<id>.<slot>)
  param_keys?: string[];
  max_concurrency?: number;
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
  status: "pending" | "running" | "completed" | "failed" | "partial";
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  error: string | null;
  params?: Record<string, Record<string, any>>; // step_id -> param name -> value
}

export interface JobStep {
  job_id: number;
  step_id: string;
  step_type: string;
  status: "pending" | "running" | "success" | "failed" | "skipped";
  attempt: number;
  claimed_by: string | null;
  claimed_at: Date | null;
  started_at: Date | null;
  finished_at: Date | null;
  error: string | null;
  max_concurrency: number | null;
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

export interface StepExecutor {
  step_type: string;
  n8n_workflow: string;
  accepts: Record<string, string>; // slot name -> artifact type
  produces: Record<string, string>; // slot name -> artifact type
  description?: string | null;
  params?: Record<string, any> | null;
}
