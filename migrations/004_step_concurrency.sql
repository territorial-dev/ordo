ALTER TABLE {{schema}}.job_step
  ADD COLUMN IF NOT EXISTS max_concurrency integer