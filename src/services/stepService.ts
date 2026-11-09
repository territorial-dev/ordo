import { getPool, getSchema } from "../db/connection";

/**
 * Step-level reads for dashboards: the open steps by type and state, and the attempts that
 * ended (job_step_attempt, from migration 010). Read-only; nothing here changes a step.
 */

export type OpenStepState = "running" | "ready" | "waiting" | "cooling" | "blocked";

export interface StepCountRow {
  step_type: string;
  state: OpenStepState;
  priority: number;
  steps: number;
  retried: number;
}

/**
 * Open steps of open jobs by type, state and job priority. `ready` is what a claim could take
 * now (capabilities and max_concurrency aside); `waiting` has an upstream step that has not
 * succeeded; `cooling` is pending after a failure until `blocked_until`; `blocked` is a
 * `kind: wait` until `blocked_until`. `retried`: steps with an attempt before the current one.
 */
export const stepCounts = async (): Promise<{ generated_at: string; rows: StepCountRow[] }> => {
  const pool = getPool();
  const schema = getSchema();
  const result = await pool.query(
    `WITH open AS (
       SELECT js.job_id, js.step_id, js.step_type, js.status, js.attempt, js.blocked_until,
              j.priority, j.recipe_id
       FROM ${schema}.job_step js
       JOIN ${schema}.job j ON j.id = js.job_id
       WHERE j.status IN ('pending', 'running')
         AND js.status IN ('pending', 'running', 'blocked')
     ),
     unmet AS (
       SELECT DISTINCT o.job_id, o.step_id
       FROM open o
       JOIN ${schema}.recipe r ON r.id = o.recipe_id
       CROSS JOIN LATERAL jsonb_array_elements(r.definition->'recipe') s
       CROSS JOIN LATERAL jsonb_each_text(COALESCE(s->'inputs', '{}'::jsonb)) i
       JOIN ${schema}.job_step p
         ON p.job_id = o.job_id
        AND p.step_id = split_part(substr(i.value, 6), '.', 1)
       WHERE o.status <> 'running'
         AND s->>'id' = o.step_id
         AND i.value LIKE 'step:%'
         AND p.status <> 'success'
     )
     SELECT o.step_type,
            CASE
              WHEN o.status = 'running' THEN 'running'
              WHEN u.job_id IS NOT NULL THEN 'waiting'
              WHEN o.blocked_until IS NOT NULL AND o.blocked_until > now()
                THEN CASE WHEN o.status = 'blocked' THEN 'blocked' ELSE 'cooling' END
              WHEN o.status = 'blocked' AND o.blocked_until IS NULL THEN 'blocked'
              ELSE 'ready'
            END AS state,
            o.priority,
            COUNT(*)::int AS steps,
            COUNT(*) FILTER (WHERE o.attempt > CASE WHEN o.status = 'running' THEN 1 ELSE 0 END)::int AS retried
     FROM open o
     LEFT JOIN unmet u ON u.job_id = o.job_id AND u.step_id = o.step_id
     GROUP BY 1, 2, 3
     ORDER BY 3 DESC, 1, 2`,
  );
  return {
    generated_at: new Date().toISOString(),
    rows: result.rows.map((r) => ({
      step_type: r.step_type,
      state: r.state,
      priority: Number(r.priority),
      steps: Number(r.steps),
      retried: Number(r.retried),
    })),
  };
};

export class StepFilterError extends Error {}

export const ATTEMPTS_DEFAULT_HOURS = 48;
export const ATTEMPTS_MAX_DAYS = 14;

/** `finished_after` from a query string: default 48 h back, at most 14 days back. */
export function parseFinishedAfter(
  value: unknown,
  now: Date = new Date(),
  defaultHours: number = ATTEMPTS_DEFAULT_HOURS,
): string {
  if (value === undefined) return new Date(now.getTime() - defaultHours * 3_600_000).toISOString();
  const text = String(value);
  const t = Date.parse(text);
  if (Number.isNaN(t)) throw new StepFilterError(`finished_after must be an ISO timestamp, got ${JSON.stringify(text)}`);
  if (t < now.getTime() - ATTEMPTS_MAX_DAYS * 86_400_000) {
    throw new StepFilterError(`finished_after reaches at most ${ATTEMPTS_MAX_DAYS} days back`);
  }
  return new Date(t).toISOString();
}

/** The error's first clause: up to the first `:`, trimmed, at most 60 characters. */
export const REASON_SQL = `NULLIF(left(btrim(split_part(error, ':', 1)), 60), '')`;

export interface AttemptsReport {
  finished_after: string;
  hours: {
    hour: string;
    step_type: string;
    worker: string | null;
    outcome: string;
    reason: string | null;
    attempts: number;
    seconds: number;
  }[];
  durations: { step_type: string; successes: number; median_seconds: number; p90_seconds: number }[];
  recent: {
    finished_at: string;
    job_id: number;
    step_id: string;
    step_type: string;
    worker: string | null;
    outcome: string;
    attempt: number;
    error: string | null;
    idempotency_key: string | null;
  }[];
}

const seconds = `EXTRACT(EPOCH FROM (finished_at - COALESCE(claimed_at, finished_at)))`;

/** Attempts that ended since `finishedAfter`: per hour, durations of successes, newest failures (waits are not failures). */
export const stepAttempts = async (finishedAfter: string): Promise<AttemptsReport> => {
  const pool = getPool();
  const schema = getSchema();
  const [hours, durations, recent] = await Promise.all([
    pool.query(
      `SELECT date_trunc('hour', finished_at) AS hour, step_type, worker, outcome,
              CASE WHEN outcome = 'success' THEN NULL ELSE ${REASON_SQL} END AS reason,
              COUNT(*)::int AS attempts, SUM(${seconds})::float AS seconds
       FROM ${schema}.job_step_attempt
       WHERE finished_at >= $1
       GROUP BY 1, 2, 3, 4, 5
       ORDER BY 1, 2, 3, 4, 5`,
      [finishedAfter],
    ),
    pool.query(
      `SELECT step_type, COUNT(*)::int AS successes,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY ${seconds})::float AS median_seconds,
              percentile_cont(0.9) WITHIN GROUP (ORDER BY ${seconds})::float AS p90_seconds
       FROM ${schema}.job_step_attempt
       WHERE finished_at >= $1 AND outcome = 'success'
       GROUP BY 1
       ORDER BY 1`,
      [finishedAfter],
    ),
    pool.query(
      `SELECT a.finished_at, a.job_id, a.step_id, a.step_type, a.worker, a.outcome, a.attempt,
              left(a.error, 500) AS error, j.idempotency_key
       FROM ${schema}.job_step_attempt a
       JOIN ${schema}.job j ON j.id = a.job_id
       WHERE a.finished_at >= $1 AND a.outcome IN ('retry', 'failed', 'lease_expired')
       ORDER BY a.finished_at DESC, a.id DESC
       LIMIT 50`,
      [finishedAfter],
    ),
  ]);
  const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v));
  return {
    finished_after: finishedAfter,
    hours: hours.rows.map((r) => ({
      hour: iso(r.hour),
      step_type: r.step_type,
      worker: r.worker ?? null,
      outcome: r.outcome,
      reason: r.reason ?? null,
      attempts: Number(r.attempts),
      seconds: Math.round(Number(r.seconds) * 10) / 10,
    })),
    durations: durations.rows.map((r) => ({
      step_type: r.step_type,
      successes: Number(r.successes),
      median_seconds: Math.round(Number(r.median_seconds) * 10) / 10,
      p90_seconds: Math.round(Number(r.p90_seconds) * 10) / 10,
    })),
    recent: recent.rows.map((r) => ({
      finished_at: iso(r.finished_at),
      job_id: Number(r.job_id),
      step_id: r.step_id,
      step_type: r.step_type,
      worker: r.worker ?? null,
      outcome: r.outcome,
      attempt: Number(r.attempt),
      error: r.error ?? null,
      idempotency_key: r.idempotency_key ?? null,
    })),
  };
};

export const USAGE_DEFAULT_HOURS = 7 * 24;
export const USAGE_DEFAULT_LIMIT = 10_000;
export const USAGE_MAX_LIMIT = 50_000;

export interface UsageFilter {
  finished_after: string;
  step_types: string[];
  worker: string | null;
  limit: number;
}

/** GET /steps/usage query: `finished_after` (default 7 days back, at most 14), `step_type` (one or a comma list), `worker`, `limit`. */
export function parseUsageFilter(query: Record<string, unknown>, now: Date = new Date()): UsageFilter {
  const finished_after = parseFinishedAfter(query.finished_after, now, USAGE_DEFAULT_HOURS);
  const step_types =
    query.step_type === undefined
      ? []
      : String(query.step_type).split(",").map((t) => t.trim()).filter((t) => t.length > 0);
  const worker = query.worker === undefined || query.worker === "" ? null : String(query.worker);
  let limit = USAGE_DEFAULT_LIMIT;
  if (query.limit !== undefined) {
    limit = Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > USAGE_MAX_LIMIT) {
      throw new StepFilterError(`limit must be an integer from 1 to ${USAGE_MAX_LIMIT}`);
    }
  }
  return { finished_after, step_types, worker, limit };
}

export interface UsageRow {
  finished_at: string;
  job_id: number;
  step_id: string;
  step_type: string;
  worker: string | null;
  outcome: string;
  attempt: number;
  seconds: number;
  usage: Record<string, any>;
}

/** Attempts that carried a `usage` object, newest first, up to `limit`. */
export const stepUsage = async (
  filter: UsageFilter,
): Promise<{ finished_after: string; limit: number; truncated: boolean; rows: UsageRow[] }> => {
  const pool = getPool();
  const schema = getSchema();
  const params: unknown[] = [filter.finished_after];
  let where = "finished_at >= $1 AND usage IS NOT NULL";
  if (filter.step_types.length > 0) {
    params.push(filter.step_types);
    where += ` AND step_type = ANY($${params.length}::text[])`;
  }
  if (filter.worker !== null) {
    params.push(filter.worker);
    where += ` AND worker = $${params.length}`;
  }
  params.push(filter.limit + 1);
  const result = await pool.query(
    `SELECT finished_at, job_id, step_id, step_type, worker, outcome, attempt,
            ${seconds}::float AS seconds, usage
     FROM ${schema}.job_step_attempt
     WHERE ${where}
     ORDER BY finished_at DESC, id DESC
     LIMIT $${params.length}`,
    params,
  );
  const truncated = result.rows.length > filter.limit;
  const rows = result.rows.slice(0, filter.limit).map((r) => ({
    finished_at: r.finished_at instanceof Date ? r.finished_at.toISOString() : String(r.finished_at),
    job_id: Number(r.job_id),
    step_id: r.step_id,
    step_type: r.step_type,
    worker: r.worker ?? null,
    outcome: r.outcome,
    attempt: Number(r.attempt),
    seconds: Math.round(Number(r.seconds) * 10) / 10,
    usage: r.usage,
  }));
  return { finished_after: filter.finished_after, limit: filter.limit, truncated, rows };
};
