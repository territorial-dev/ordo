/**
 * GET /jobs filters and GET /jobs/counts: a query string becomes a filter (or a 400), the
 * filter becomes one parameterised WHERE clause, and no filter keeps the old behaviour
 * (every job, newest first, no LIMIT).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }));

vi.mock('../../src/db/connection', () => ({
  getPool: () => ({ query: mockQuery }),
  getSchema: () => 'test',
}));

import {
  countJobs,
  JobFilterError,
  jobWhere,
  listJobs,
  parseJobFilter,
} from '../../src/services/jobService';

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [] });
});

describe('parseJobFilter', () => {
  it('reads every filter and normalises timestamps', () => {
    expect(
      parseJobFilter({
        status: 'pending,running',
        key_prefix: ['ingest_ecmwf:20261027', 'ingest_ecmwf:20261026'],
        finished_after: '2026-10-26T12:00:00Z',
        created_after: '2026-10-01',
        order: 'ASC',
        limit: '50',
      }),
    ).toEqual({
      status: ['pending', 'running'],
      key_prefix: ['ingest_ecmwf:20261027', 'ingest_ecmwf:20261026'],
      finished_after: '2026-10-26T12:00:00.000Z',
      created_after: '2026-10-01T00:00:00.000Z',
      order: 'asc',
      limit: 50,
    });
  });

  it('keeps a single status a string and an empty query empty', () => {
    expect(parseJobFilter({ status: 'failed' })).toEqual({ status: 'failed' });
    expect(parseJobFilter({})).toEqual({});
  });

  it.each([
    [{ limit: '0' }],
    [{ limit: '100001' }],
    [{ limit: 'ten' }],
    [{ order: 'sideways' }],
    [{ finished_after: 'yesterday' }],
    [{ status: '' }],
    [{ key_prefix: Array.from({ length: 101 }, (_, i) => `k${i}`) }],
  ])('refuses %j', (query) => {
    expect(() => parseJobFilter(query)).toThrow(JobFilterError);
  });
});

describe('jobWhere', () => {
  it('is empty without a filter', () => {
    expect(jobWhere({})).toEqual({ where: '', params: [] });
  });

  it('escapes LIKE wildcards in key prefixes', () => {
    const { where, params } = jobWhere({ key_prefix: ['a_b%c\\d'] });
    expect(where).toBe(' WHERE idempotency_key LIKE ANY($1::text[])');
    expect(params).toEqual([['a\\_b\\%c\\\\d%']]);
  });
});

describe('listJobs', () => {
  it('without a filter lists every job newest first, with no LIMIT (as before)', async () => {
    await listJobs();
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('FROM test.job ORDER BY id DESC');
    expect(sql).not.toContain('LIMIT');
    expect(params).toBeUndefined();
  });

  it('combines filters with AND, orders and limits', async () => {
    await listJobs({
      status: ['success', 'failed'],
      finished_after: '2026-10-25T00:00:00.000Z',
      order: 'asc',
      limit: 10,
    });
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('WHERE status = ANY($1::text[]) AND finished_at >= $2 ORDER BY id ASC LIMIT $3');
    expect(params).toEqual([['success', 'failed'], '2026-10-25T00:00:00.000Z', 10]);
  });

  it('still answers the idempotency key lookup', async () => {
    mockQuery.mockResolvedValue({
      rows: [{ id: 7, recipe_id: 1, status: 'pending', created_at: 'c', started_at: null, finished_at: null, error: null, idempotency_key: 'k', priority: 20 }],
    });
    const jobs = await listJobs({ idempotency_key: 'k' });
    expect(mockQuery.mock.calls[0][1]).toEqual(['k']);
    expect(jobs[0]).toMatchObject({ id: 7, idempotency_key: 'k', priority: 20 });
  });
});

describe('countJobs', () => {
  it('counts per status, zero for the statuses with no job, and ignores limit', async () => {
    mockQuery.mockResolvedValue({ rows: [{ status: 'pending', n: 3692 }, { status: 'failed', n: 4 }] });
    const counts = await countJobs({ key_prefix: ['ingest_ecmwf:'], limit: 5 });
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toBe('SELECT status, COUNT(*)::int AS n FROM test.job WHERE idempotency_key LIKE ANY($1::text[]) GROUP BY status');
    expect(params).toEqual([['ingest\\_ecmwf:%']]);
    expect(counts).toEqual({ total: 3696, by_status: { pending: 3692, running: 0, success: 0, failed: 4 } });
  });
});
