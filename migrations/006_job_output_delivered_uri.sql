ALTER TABLE {{schema}}.job_output
  ADD COLUMN IF NOT EXISTS delivered_uri text,
  ADD COLUMN IF NOT EXISTS delivered_at timestamptz;
