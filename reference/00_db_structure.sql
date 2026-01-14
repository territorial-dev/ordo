CREATE TABLE mapprism2.recipe (
  id           SERIAL PRIMARY KEY,
  name         text NOT NULL,
  version      text NOT NULL,
  definition   jsonb NOT NULL,
  created_at   timestamptz DEFAULT now()
);

CREATE TABLE mapprism2.job (
  id           SERIAL PRIMARY KEY,
  recipe_id    INTEGER REFERENCES mapprism2.recipe(id),
  status       text NOT NULL, -- pending | running | completed | failed | partial
  created_at   timestamptz DEFAULT now(),
  started_at   timestamptz,
  finished_at  timestamptz,
  error        text
);

CREATE TABLE mapprism2.job_step (
  job_id      INTEGER REFERENCES mapprism2.job(id),
  step_id     text NOT NULL,
  step_type   text NOT NULL,
  status      text NOT NULL, -- pending | running | success | failed | skipped
  attempt     int DEFAULT 0,
  claimed_by  text, -- NULL if not claimed
  claimed_at  timestamptz, -- NULL if not claimed
  started_at  timestamptz,
  finished_at timestamptz,
  error       text,
  blocked_until timestamptz,

  PRIMARY KEY (job_id, step_id)
);

CREATE TABLE mapprism2.job_artifact (
  job_id        INTEGER REFERENCES mapprism2.job(id),
  name          text NOT NULL,
  type          text NOT NULL, -- las | tif | vector | ept | etc
  uri           text NOT NULL,
  hash          text NOT NULL,
  producer_step text, -- NULL for initial inputs
  metadata      jsonb,
  created_at    timestamptz DEFAULT now(),

  PRIMARY KEY (job_id, name)
);

CREATE TABLE mapprism2.step_executor (
  step_type     text PRIMARY KEY,
  n8n_workflow  text NOT NULL,
  accepts       jsonb NOT NULL,
  produces      jsonb NOT NULL
);