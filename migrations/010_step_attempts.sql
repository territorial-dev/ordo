-- One row per attempt that ended (complete, fail, lease expiry), so a client can count
-- retries, waits and lost leases that the step row overwrites. Additive: nothing reads it
-- but GET /steps/attempts. Deleting a job (or its steps) deletes its attempts.
CREATE TABLE IF NOT EXISTS {{schema}}.job_step_attempt (
  id bigserial PRIMARY KEY,
  job_id integer NOT NULL,
  step_id text NOT NULL,
  step_type text NOT NULL,
  attempt integer NOT NULL,
  worker text,
  outcome text NOT NULL,
  error text,
  claimed_at timestamptz,
  finished_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (job_id, step_id) REFERENCES {{schema}}.job_step (job_id, step_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS job_step_attempt_finished_at_idx ON {{schema}}.job_step_attempt (finished_at);
CREATE INDEX IF NOT EXISTS job_step_attempt_step_idx ON {{schema}}.job_step_attempt (job_id, step_id);
