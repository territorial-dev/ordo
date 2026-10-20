-- Runner API: API keys with roles, leased step claims over HTTP, idempotent jobs,
-- capability matching, executor runner kinds. Everything here is additive.

CREATE TABLE IF NOT EXISTS {{schema}}.api_key (
  id            SERIAL PRIMARY KEY,
  name          text NOT NULL,
  role          text NOT NULL CHECK (role IN ('admin', 'scheduler', 'runner')),
  key_hash      text NOT NULL UNIQUE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  revoked_at    timestamptz,
  last_used_at  timestamptz
);

ALTER TABLE {{schema}}.step_executor
  ADD COLUMN IF NOT EXISTS runner        text NOT NULL DEFAULT 'n8n',
  ADD COLUMN IF NOT EXISTS executor_ref  text,
  ADD COLUMN IF NOT EXISTS requires      jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS max_attempts  int NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS lease_seconds int NOT NULL DEFAULT 300;

ALTER TABLE {{schema}}.step_executor
  ALTER COLUMN n8n_workflow DROP NOT NULL;

ALTER TABLE {{schema}}.step_executor
  ADD CONSTRAINT step_executor_runner_check CHECK (runner IN ('n8n', 'api'));

UPDATE {{schema}}.step_executor
  SET executor_ref = n8n_workflow
  WHERE executor_ref IS NULL;

-- n8n_workflow is a deprecated alias of executor_ref for n8n rows. n8n workflows read
-- the column by name straight from Postgres, so the two are kept in sync by trigger
-- until an Ordo major drops the old column.
CREATE OR REPLACE FUNCTION {{schema}}.step_executor_sync_ref() RETURNS trigger AS $$
BEGIN
  IF NEW.runner = 'n8n' THEN
    IF NEW.executor_ref IS NULL THEN
      NEW.executor_ref := NEW.n8n_workflow;
    END IF;
    IF NEW.n8n_workflow IS DISTINCT FROM NEW.executor_ref THEN
      IF TG_OP = 'UPDATE' AND NEW.executor_ref IS NOT DISTINCT FROM OLD.executor_ref THEN
        NEW.executor_ref := NEW.n8n_workflow;
      ELSE
        NEW.n8n_workflow := NEW.executor_ref;
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS step_executor_sync_ref ON {{schema}}.step_executor;
CREATE TRIGGER step_executor_sync_ref
  BEFORE INSERT OR UPDATE ON {{schema}}.step_executor
  FOR EACH ROW EXECUTE FUNCTION {{schema}}.step_executor_sync_ref();

ALTER TABLE {{schema}}.job
  ADD COLUMN IF NOT EXISTS idempotency_key   text,
  ADD COLUMN IF NOT EXISTS created_by_key_id int REFERENCES {{schema}}.api_key(id);

CREATE UNIQUE INDEX IF NOT EXISTS job_idempotency_key_idx
  ON {{schema}}.job (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

ALTER TABLE {{schema}}.job_step
  ADD COLUMN IF NOT EXISTS lease_token      text,
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS max_attempts     int,
  ADD COLUMN IF NOT EXISTS lease_seconds    int,
  ADD COLUMN IF NOT EXISTS requires         jsonb;

CREATE INDEX IF NOT EXISTS job_step_claimable_idx
  ON {{schema}}.job_step (status, step_type)
  WHERE status IN ('pending', 'blocked', 'running');
