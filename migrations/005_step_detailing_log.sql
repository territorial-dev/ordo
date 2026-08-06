ALTER TABLE {{schema}}.job_step_detailing
  DROP CONSTRAINT IF EXISTS job_step_detailing_pkey;

ALTER TABLE {{schema}}.job_step_detailing
  ADD COLUMN IF NOT EXISTS id SERIAL;

ALTER TABLE {{schema}}.job_step_detailing
  ADD PRIMARY KEY (id);
