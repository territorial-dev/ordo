ALTER TABLE {{schema}}.job
  ADD COLUMN IF NOT EXISTS params jsonb DEFAULT '{}';
