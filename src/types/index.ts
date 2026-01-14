export interface StepDefinition {
  id: string;
  type: string;
  inputs: Record<string, string>; // slot name -> artifact name
  outputs: string[];
  params: Record<string, any>;
}

export interface RecipeDefinition {
  recipe: StepDefinition[];
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
    definition: RecipeDefinition;
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
}

export interface JobStatusResponse {
  job: Job;
  steps: JobStep[];
  artifacts: JobArtifact[];
}

export interface StepExecutor {
  step_type: string;
  n8n_workflow: string;
  accepts: Record<string, string>; // artifact name -> artifact type
  produces: Record<string, string>; // artifact name -> artifact type
}
