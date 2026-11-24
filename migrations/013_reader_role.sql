-- reader: a key that may call the read routes (GET) a scheduler may call, and nothing that
-- writes. The role check from 007 gains the value; existing rows and roles are unchanged.
-- The inline check from 007 is named by Postgres (api_key_role_check); any check on the
-- role column is dropped by lookup so a differently named one cannot survive beside the new one.
DO $$
DECLARE
  c record;
BEGIN
  FOR c IN
    SELECT con.conname
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
    WHERE nsp.nspname = lower('{{schema}}')
      AND rel.relname = 'api_key'
      AND con.contype = 'c'
      AND pg_get_constraintdef(con.oid) LIKE '%role%'
  LOOP
    EXECUTE format('ALTER TABLE %I.api_key DROP CONSTRAINT %I', lower('{{schema}}'), c.conname);
  END LOOP;
END
$$;

ALTER TABLE {{schema}}.api_key
  ADD CONSTRAINT api_key_role_check CHECK (role IN ('admin', 'scheduler', 'runner', 'reader'));
