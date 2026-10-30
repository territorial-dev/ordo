/**
 * Attempt history (migration 010): complete and fail write one job_step_attempt row in the
 * step's transaction, with the outcome told from the failure decision; the sweeper's lease
 * expiry is its own outcome. GET /steps/attempts reads it back; GET /steps/counts groups the
 * open steps by state.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockQuery, mockRelease } = vi.hoisted(() => ({ mockQuery: vi.fn(), mockRelease: vi.fn() }));

vi.mock('../../src/db/connection', () => ({
  getPool: () => ({ connect: async () => ({ query: mockQuery, release: mockRelease }), query: mockQuery }),
  getSchema: () => 'test',
}));

import { attemptOutcome, completeStep, failStep } from '../../src/services/runnerService';
import { parseFinishedAfter, stepAttempts, stepCounts, StepFilterError } from '../../src/services/stepService';

const sql = (c: unknown[]) => String(c[0]).replace(/\s+/g, ' ').trim();
const claimedAt = new Date('2026-10-30T17:00:00Z');

const stepRow = (over: Record<string, unknown> = {}) => ({
  job_id: 7, step_id: 'ingest', step_type: 'INGEST_ECMWF', status: 'running', attempt: 2,
  max_concurrency: null, requires: null, lease_seconds: null, lease_token: 'tok',
  step_max_attempts: 3, exec_requires: {}, exec_lease_seconds: 300, exec_max_attempts: 3,
  executor_ref: null, produces: {}, job_status: 'running', job_params: null, idempotency_key: 'k',
  claimed_by: 'pneuma', claimed_at: claimedAt,
  definition: { recipe: [{ id: 'ingest', type: 'INGEST_ECMWF', inputs: {}, outputs: {} }] },
  ...over,
});

/** Answers the step lock with `row`, the job-status reads with "running" and anything else empty. */
function db(row: Record<string, unknown>) {
  mockQuery.mockImplementation(async (text: string) => {
    if (text.includes('FOR UPDATE OF js')) return { rows: [row] };
    if (text.includes('SELECT status FROM test.job_step WHERE job_id')) return { rows: [{ status: 'pending' }] };
    if (text.includes('SELECT status FROM test.job WHERE')) return { rows: [{ status: 'running' }] };
    return { rows: [] };
  });
}

const attemptInserts = () =>
  mockQuery.mock.calls.filter((c) => sql(c).startsWith('INSERT INTO test.job_step_attempt'));

beforeEach(() => {
  mockQuery.mockReset();
  mockRelease.mockReset();
});

describe('attemptOutcome', () => {
  it('maps the failure decision, a swept lease apart', () => {
    expect(attemptOutcome('blocked', false)).toBe('wait');
    expect(attemptOutcome('failed', false)).toBe('failed');
    expect(attemptOutcome('failed', true)).toBe('failed');
    expect(attemptOutcome('pending', false)).toBe('retry');
    expect(attemptOutcome('pending', true)).toBe('lease_expired');
  });
});

describe('recording attempts', () => {
  it('records a success with the claim, inside the transaction', async () => {
    db(stepRow());
    await completeStep(7, 'ingest', { lease_token: 'tok', artifacts: {} });
    const rows = attemptInserts();
    expect(rows).toHaveLength(1);
    expect(rows[0][1]).toEqual([7, 'ingest', 'INGEST_ECMWF', 2, 'pneuma', 'success', null, claimedAt]);
    const calls = mockQuery.mock.calls.map(sql);
    expect(calls.indexOf('BEGIN')).toBeLessThan(calls.findIndex((c) => c.startsWith('INSERT INTO test.job_step_attempt')));
    expect(calls[calls.length - 1]).toBe('COMMIT');
  });

  it('records a retry, a final failure and a wait with the error text', async () => {
    db(stepRow({ attempt: 1 }));
    await failStep(7, 'ingest', { lease_token: 'tok', kind: 'error', error: 'GenericError: S3 timeout' });
    db(stepRow({ attempt: 3 }));
    await failStep(7, 'ingest', { lease_token: 'tok', kind: 'error', error: 'boom' });
    db(stepRow({ attempt: 1 }));
    await failStep(7, 'ingest', { lease_token: 'tok', kind: 'wait', error: 'throttled: 503 x6' });
    const rows = attemptInserts().map((c) => [c[1][5], c[1][6], c[1][3]]);
    expect(rows).toEqual([
      ['retry', 'GenericError: S3 timeout', 1],
      ['failed', 'boom', 3],
      ['wait', 'throttled: 503 x6', 1],
    ]);
  });

  it('records a swept lease as lease_expired', async () => {
    db(stepRow({ attempt: 1 }));
    await failStep(7, 'ingest', { lease_token: 'tok', kind: 'error', error: 'lease expired', retry: true }, true);
    expect(attemptInserts()[0][1][5]).toBe('lease_expired');
  });

  it('records nothing when the lease token does not match', async () => {
    db(stepRow({ lease_token: 'other' }));
    await expect(failStep(7, 'ingest', { lease_token: 'tok', kind: 'error' })).rejects.toThrow();
    expect(attemptInserts()).toHaveLength(0);
  });
});

describe('GET /steps/attempts', () => {
  const now = new Date('2026-10-30T18:00:00Z');

  it('defaults to 48 hours and refuses more than 14 days or a malformed time', () => {
    expect(parseFinishedAfter(undefined, now)).toBe('2026-10-28T18:00:00.000Z');
    expect(parseFinishedAfter('2026-10-30T12:00:00Z', now)).toBe('2026-10-30T12:00:00.000Z');
    expect(() => parseFinishedAfter('2026-10-01T00:00:00Z', now)).toThrow(StepFilterError);
    expect(() => parseFinishedAfter('yesterday', now)).toThrow(StepFilterError);
  });

  it('shapes hours, durations and recent failures', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ hour: new Date('2026-10-30T17:00:00Z'), step_type: 'INGEST_ECMWF', worker: 'pneuma', outcome: 'wait', reason: 'throttled', attempts: 19, seconds: '3021.04' }] })
      .mockResolvedValueOnce({ rows: [{ step_type: 'INGEST_ECMWF', successes: 219, median_seconds: 366.04, p90_seconds: 900.26 }] })
      .mockResolvedValueOnce({ rows: [{ finished_at: new Date('2026-10-30T17:30:00Z'), job_id: 9, step_id: 'table', step_type: 'CALIB_TABLE', worker: 'disbelief', outcome: 'failed', attempt: 3, error: 'GenericError: x', idempotency_key: 'calib_table:x' }] });
    const report = await stepAttempts('2026-10-28T18:00:00.000Z');
    expect(report.hours).toEqual([{ hour: '2026-10-30T17:00:00.000Z', step_type: 'INGEST_ECMWF', worker: 'pneuma', outcome: 'wait', reason: 'throttled', attempts: 19, seconds: 3021 }]);
    expect(report.durations).toEqual([{ step_type: 'INGEST_ECMWF', successes: 219, median_seconds: 366, p90_seconds: 900.3 }]);
    expect(report.recent[0]).toMatchObject({ finished_at: '2026-10-30T17:30:00.000Z', outcome: 'failed', idempotency_key: 'calib_table:x' });
    for (const c of mockQuery.mock.calls) expect(c[1]).toEqual(['2026-10-28T18:00:00.000Z']);
    expect(sql(mockQuery.mock.calls[0])).toContain("split_part(error, ':', 1)");
    expect(sql(mockQuery.mock.calls[2])).toContain("a.outcome IN ('retry', 'failed', 'lease_expired')");
  });
});

describe('GET /steps/counts', () => {
  it('reads open steps of open jobs only and keeps the rows as numbers', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ step_type: 'FINALIZE_RUN', state: 'waiting', priority: '20', steps: '11186', retried: '0' }] });
    const out = await stepCounts();
    expect(out.rows).toEqual([{ step_type: 'FINALIZE_RUN', state: 'waiting', priority: 20, steps: 11186, retried: 0 }]);
    const text = sql(mockQuery.mock.calls[0]);
    expect(text).toContain("j.status IN ('pending', 'running')");
    expect(text).toContain("i.value LIKE 'step:%'");
  });
});
