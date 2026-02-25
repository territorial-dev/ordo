ALTER TABLE {{schema}}.step_executor
  ADD COLUMN IF NOT EXISTS description text,
  ADD COLUMN IF NOT EXISTS params jsonb;
