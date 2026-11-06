-- step_is_ready(job_id, step_id): true when every upstream step this step reads from (a
-- `step:<id>.<slot>` input in the job's recipe) has succeeded. The one definition of readiness
-- in SQL, so a claim can leave waiting steps out of its candidate window instead of finding
-- them there: with a large backfill, a runner whose step types include the second step of a
-- recipe but not the first otherwise sees a window full of steps it cannot run and claims
-- nothing. Used by POST /runner/claim (1.14) and offered to n8n runners (USING_WITH_N8N.md);
-- GET /steps/counts applies the same rule set-wise. `job:` inputs never block. A plain SQL
-- function marked STABLE, so the planner inlines it into the claim query.
CREATE OR REPLACE FUNCTION {{schema}}.step_is_ready(p_job_id integer, p_step_id text)
RETURNS boolean
LANGUAGE sql STABLE
AS $$
  SELECT NOT EXISTS (
    SELECT 1
    FROM {{schema}}.job j
    JOIN {{schema}}.recipe r ON r.id = j.recipe_id
    CROSS JOIN LATERAL jsonb_array_elements(r.definition->'recipe') s
    CROSS JOIN LATERAL jsonb_each_text(COALESCE(s->'inputs', '{}'::jsonb)) i
    JOIN {{schema}}.job_step p
      ON p.job_id = j.id
     AND p.step_id = split_part(substr(i.value, 6), '.', 1)
    WHERE j.id = p_job_id
      AND s->>'id' = p_step_id
      AND i.value LIKE 'step:%'
      AND p.status <> 'success'
  )
$$;
