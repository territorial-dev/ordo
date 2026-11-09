-- What an attempt used (memory, CPU, time), as the runner measured it: an optional object sent
-- with complete and fail, kept with the attempt row and read back by GET /steps/usage. Ordo
-- does not interpret it. Additive: nullable, older runners send nothing.
ALTER TABLE {{schema}}.job_step_attempt ADD COLUMN IF NOT EXISTS usage jsonb;
CREATE INDEX IF NOT EXISTS job_step_attempt_usage_idx
  ON {{schema}}.job_step_attempt (step_type, finished_at) WHERE usage IS NOT NULL;
