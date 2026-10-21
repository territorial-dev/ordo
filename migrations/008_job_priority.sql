-- Job priority: runners claim higher-priority jobs first; equal priority keeps the
-- creation order. Additive; existing jobs and n8n claims are unaffected (priority 0).

ALTER TABLE {{schema}}.job
  ADD COLUMN IF NOT EXISTS priority int NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS job_open_priority_idx
  ON {{schema}}.job (priority DESC, id)
  WHERE status IN ('pending', 'running');
