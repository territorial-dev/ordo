/**
 * DELETE /jobs/finished?key_prefix=…&older_than_days=N: retention of finished jobs. The prefix
 * and a minimum age are required, only finished statuses are accepted, the job rows are locked
 * oldest finished first up to a limit, a job with a running step is skipped, and every row of a
 * deleted job goes in one transaction, counted per table.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockQuery, mockRelease } = vi.hoisted(() => ({ mockQuery: vi.fn(), mockRelease: vi.fn() }));

vi.mock('../../src/db/connection', () => ({
  getPool: () => ({ connect: async () => ({ query: mockQuery, release: mockRelease }) }),
  getSchema: () => 'test',
}));

import {
  deleteFinishedJobs,
  FINISHED_JOB_STATUSES,
  JobFilterError,
  parseFinishedJobsFilter,
  RETENTION_DEFAULT_LIMIT,
} from '../../src/services/jobService';

const sqlCalls = () => mockQuery.mock.calls.map((c) => String(c[0]).replace(/\s+/g, ' ').trim());

beforeEach(() => {
  mockQuery.mockReset();
  mockRelease.mockReset();
});

describe('parseFinishedJobsFilter', () => {
  it('requires a key prefix and an age', () => {
    expect(() => parseFinishedJobsFilter({ older_than_days: '30' })).toThrow(/key_prefix is required/);
    expect(() => parseFinishedJobsFilter({ key_prefix: ' , ', older_than_days: '30' })).toThrow(/key_prefix is required/);
    expect(() => parseFinishedJobsFilter({ key_prefix: 'radar:' })).toThrow(/older_than_days is required/);
  });

  it('refuses an age under one day or not a whole number of days', () => {
    for (const days of ['0', '-3', '0.5', 'abc', '']) {
      expect(() => parseFinishedJobsFilter({ key_prefix: 'radar:', older_than_days: days })).toThrow(JobFilterError);
    }
  });

  it('defaults to every finished status and a limit of 1000', () => {
    expect(parseFinishedJobsFilter({ key_prefix: 'radar:,ingest_ecmwf:', older_than_days: '30' })).toEqual({
      key_prefix: ['radar:', 'ingest_ecmwf:'],
      older_than_days: 30,
      status: ['success', 'failed', 'cancelled', 'partial'],
      limit: RETENTION_DEFAULT_LIMIT,
    });
    expect(FINISHED_JOB_STATUSES).toEqual(['success', 'failed', 'cancelled', 'partial']);
  });

  it('narrows to the given finished statuses and refuses open ones', () => {
    expect(parseFinishedJobsFilter({ key_prefix: 'radar:', older_than_days: '7', status: 'success,cancelled' }).status)
      .toEqual(['success', 'cancelled']);
    for (const status of ['pending', 'running', 'success,running']) {
      expect(() => parseFinishedJobsFilter({ key_prefix: 'radar:', older_than_days: '7', status })).toThrow(/must be finished/);
    }
  });

  it('takes a limit from 1 to 10000', () => {
    expect(parseFinishedJobsFilter({ key_prefix: 'radar:', older_than_days: '7', limit: '500' }).limit).toBe(500);
    for (const limit of ['0', '10001', '2.5']) {
      expect(() => parseFinishedJobsFilter({ key_prefix: 'radar:', older_than_days: '7', limit })).toThrow(/limit/);
    }
  });
});

describe('deleteFinishedJobs', () => {
  const filter = { key_prefix: ['radar_frame:'], older_than_days: 30, status: ['success', 'failed'], limit: 3 };

  it('refuses to run without a prefix or an age, before touching the database', async () => {
    await expect(deleteFinishedJobs({ ...filter, key_prefix: [] })).rejects.toBeInstanceOf(JobFilterError);
    await expect(deleteFinishedJobs({ ...filter, older_than_days: 0 })).rejects.toBeInstanceOf(JobFilterError);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('locks old finished jobs, skips one with a running step and deletes the rest with every row', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 4 }, { id: 9 }, { id: 2 }] })
      .mockResolvedValueOnce({
        rows: [
          { job_id: 2, status: 'success' },
          { job_id: 4, status: 'success' },
          { job_id: 9, status: 'failed' },
          { job_id: 9, status: 'running' },
        ],
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 5 }) // attempts
      .mockResolvedValueOnce({ rows: [], rowCount: 2 }) // detailing
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // outputs
      .mockResolvedValueOnce({ rows: [], rowCount: 3 }) // artifacts
      .mockResolvedValueOnce({ rows: [], rowCount: 2 }) // steps
      .mockResolvedValue({ rows: [], rowCount: 2 });
    const result = await deleteFinishedJobs(filter);
    expect(result).toEqual({
      deleted: 2,
      rows: { job_step: 2, job_step_attempt: 5, job_step_detailing: 2, job_artifact: 3, job_output: 1 },
      skipped: 1,
      more: true,
    });
    const sql = sqlCalls();
    expect(sql[0]).toBe('BEGIN');
    expect(sql[1]).toBe(
      'SELECT j.id FROM test.job j WHERE j.status = ANY($1::text[]) AND j.idempotency_key LIKE ANY($2::text[]) ' +
        'AND j.finished_at < now() - make_interval(days => $3::int) ' +
        "AND NOT EXISTS (SELECT 1 FROM test.job_step s WHERE s.job_id = j.id AND s.status = 'running') " +
        'ORDER BY j.finished_at, j.id LIMIT $4 FOR UPDATE',
    );
    expect(mockQuery.mock.calls[1][1]).toEqual([['success', 'failed'], ['radar\\_frame:%'], 30, 3]);
    expect(sql[2]).toMatch(/FROM test\.job_step WHERE job_id = ANY\(\$1::int\[\]\) ORDER BY job_id, step_id FOR UPDATE$/);
    expect(mockQuery.mock.calls[2][1]).toEqual([[4, 9, 2]]);
    expect(sql.slice(3, 9)).toEqual([
      'DELETE FROM test.job_step_attempt WHERE job_id = ANY($1::int[])',
      'DELETE FROM test.job_step_detailing WHERE job_id = ANY($1::int[])',
      'DELETE FROM test.job_output WHERE job_id = ANY($1::int[])',
      'DELETE FROM test.job_artifact WHERE job_id = ANY($1::int[])',
      'DELETE FROM test.job_step WHERE job_id = ANY($1::int[])',
      'DELETE FROM test.job WHERE id = ANY($1::int[])',
    ]);
    for (const call of mockQuery.mock.calls.slice(3, 9)) expect(call[1]).toEqual([[4, 2]]);
    expect(sql[9]).toBe('COMMIT');
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it('says there is no more when fewer jobs than the limit matched', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 1 }] })
      .mockResolvedValueOnce({ rows: [{ job_id: 1, status: 'success' }] })
      .mockResolvedValue({ rows: [], rowCount: 1 });
    const result = await deleteFinishedJobs(filter);
    expect(result.deleted).toBe(1);
    expect(result.more).toBe(false);
  });

  it('commits an empty result when nothing is old enough', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] }).mockResolvedValue({ rows: [] });
    expect(await deleteFinishedJobs(filter)).toEqual({
      deleted: 0,
      rows: { job_step: 0, job_step_attempt: 0, job_step_detailing: 0, job_artifact: 0, job_output: 0 },
      skipped: 0,
      more: false,
    });
    expect(sqlCalls()).toEqual(['BEGIN', expect.stringMatching(/FOR UPDATE$/), 'COMMIT']);
  });

  it('rolls back and deletes nothing more when a delete fails', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 1 }] })
      .mockResolvedValueOnce({ rows: [{ job_id: 1, status: 'success' }] })
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue({ rows: [] });
    await expect(deleteFinishedJobs(filter)).rejects.toThrow('boom');
    const sql = sqlCalls();
    expect(sql[sql.length - 1]).toBe('ROLLBACK');
    expect(sql.filter((q) => q.startsWith('DELETE'))).toHaveLength(1);
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });
});
