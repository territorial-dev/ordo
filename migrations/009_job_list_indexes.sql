-- Filters on GET /jobs and GET /jobs/counts: finished_after and created_after read these
-- columns; additive, harmless for clients that never filter.
CREATE INDEX IF NOT EXISTS job_finished_at_idx ON {{schema}}.job (finished_at);
CREATE INDEX IF NOT EXISTS job_created_at_idx ON {{schema}}.job (created_at);
