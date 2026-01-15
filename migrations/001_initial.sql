CREATE TABLE IF NOT EXISTS {{schema}}.recipe (
  id           SERIAL PRIMARY KEY,
  name         text NOT NULL,
  version      text NOT NULL,
  definition   jsonb NOT NULL,
  created_at   timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS {{schema}}.job (
  id           SERIAL PRIMARY KEY,
  recipe_id    INTEGER REFERENCES {{schema}}.recipe(id),
  status       text NOT NULL,
  created_at   timestamptz DEFAULT now(),
  started_at   timestamptz,
  finished_at  timestamptz,
  error        text
);

CREATE TABLE IF NOT EXISTS {{schema}}.job_step (
  job_id      INTEGER REFERENCES {{schema}}.job(id),
  step_id     text NOT NULL,
  step_type   text NOT NULL,
  status      text NOT NULL,
  attempt     int DEFAULT 0,
  claimed_by  text,
  claimed_at  timestamptz,
  started_at  timestamptz,
  finished_at timestamptz,
  error       text,
  blocked_until timestamptz,

  PRIMARY KEY (job_id, step_id)
);

CREATE TABLE IF NOT EXISTS {{schema}}.job_artifact (
  job_id        INTEGER REFERENCES {{schema}}.job(id),
  name          text NOT NULL,
  type          text NOT NULL,
  uri           text NOT NULL,
  hash          text NOT NULL,
  producer_step text,
  metadata      jsonb,
  created_at    timestamptz DEFAULT now(),

  PRIMARY KEY (job_id, name)
);

CREATE TABLE IF NOT EXISTS {{schema}}.job_output (
  job_id        INTEGER REFERENCES {{schema}}.job(id),
  artifact_name text NOT NULL,
  path          text NOT NULL,
  created_at    timestamptz DEFAULT now(),

  PRIMARY KEY (job_id, artifact_name)
);

CREATE TABLE IF NOT EXISTS {{schema}}.step_executor (
  step_type     text PRIMARY KEY,
  n8n_workflow  text NOT NULL,
  accepts       jsonb NOT NULL,
  produces      jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS {{schema}}.job_step_detailing (
  job_id integer NOT NULL,
  step_id text NOT NULL,
  log text,
  progress jsonb,
  updated_at timestamptz DEFAULT now(),

  PRIMARY KEY (job_id, step_id),
  FOREIGN KEY (job_id, step_id)
    REFERENCES {{schema}}.job_step (job_id, step_id)
    ON DELETE CASCADE
);
