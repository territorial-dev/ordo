/**
 * DELETE /jobs/:id and DELETE /jobs?key_prefix=…: a job is deletable only while none of its
 * steps has started; the single form answers 409 (ConflictError) otherwise, the bulk form skips
 * those jobs and refuses to run without a key prefix. Rows go in dependency order, in one
 * transaction, after locking the step rows.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockQuery, mockRelease } = vi.hoisted(() => ({ mockQuery: vi.fn(), mockRelease: vi.fn() }));

vi.mock('../../src/db/connection', () => ({
  getPool: () => ({ connect: async () => ({ query: mockQuery, release: mockRelease }) }),
  getSchema: () => 'test',
}));

import { deleteBlocker, DELETABLE_STEP_STATUSES } from '../../src/utils/jobs';
import { deleteJob, deleteJobs, JobFilterError } from '../../src/services/jobService';
import { ConflictError } from '../../src/services/runnerService';

const sqlCalls = () => mockQuery.mock.calls.map((c) => String(c[0]).replace(/\s+/g, ' ').trim());

beforeEach(() => {
  mockQuery.mockReset();
  mockRelease.mockReset();
});

describe('deleteBlocker', () => {
  it('allows a pending job whose steps are pending or blocked', () => {
    expect(DELETABLE_STEP_STATUSES).toEqual(new Set(['pending', 'blocked']));
    expect(deleteBlocker('pending', [{ step_id: 'a', status: 'pending' }, { step_id: 'b', status: 'blocked' }])).toBeNull();
    expect(deleteBlocker('running', [{ step_id: 'a', status: 'pending' }])).toBeNull();
  });

  it('names the first step that has started or finished', () => {
    expect(deleteBlocker('running', [{ step_id: 'a', status: 'success' }, { step_id: 'b', status: 'running' }]))
      .toBe('Step a is success, not pending');
    expect(deleteBlocker('pending', [{ step_id: 'a', status: 'running' }])).toBe('Step a is running, not pending');
  });

  it('refuses finished jobs whatever their steps say', () => {
    for (const status of ['success', 'completed', 'failed', 'partial']) {
      expect(deleteBlocker(status, [{ step_id: 'a', status: 'pending' }])).toBe(`Job is ${status}, not pending`);
    }
  });
});

describe('deleteJob', () => {
  it('locks the job and its steps, deletes rows in dependency order and commits', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 7, status: 'pending', idempotency_key: 'ingest:x' }] })
      .mockResolvedValueOnce({ rows: [{ step_id: 'ingest', status: 'pending' }, { step_id: 'finalize', status: 'pending' }] })
      .mockResolvedValue({ rows: [] });
    const result = await deleteJob(7);
    expect(result).toEqual({ id: 7, idempotency_key: 'ingest:x', deleted: true });
    const sql = sqlCalls();
    expect(sql[0]).toBe('BEGIN');
    expect(sql[1]).toMatch(/FROM test\.job WHERE id = \$1 FOR UPDATE$/);
    expect(sql[2]).toMatch(/FROM test\.job_step WHERE job_id = \$1 ORDER BY step_id FOR UPDATE$/);
    expect(sql.slice(3, 7)).toEqual([
      'DELETE FROM test.job_output WHERE job_id = ANY($1::int[])',
      'DELETE FROM test.job_artifact WHERE job_id = ANY($1::int[])',
      'DELETE FROM test.job_step WHERE job_id = ANY($1::int[])',
      'DELETE FROM test.job WHERE id = ANY($1::int[])',
    ]);
    expect(mockQuery.mock.calls[3][1]).toEqual([[7]]);
    expect(sql[7]).toBe('COMMIT');
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it('returns null for an unknown job and rolls back', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] }).mockResolvedValue({ rows: [] });
    expect(await deleteJob(99)).toBeNull();
    expect(sqlCalls()).toEqual(['BEGIN', expect.stringMatching(/FROM test\.job WHERE id = \$1 FOR UPDATE/), 'ROLLBACK']);
  });

  it('throws ConflictError and deletes nothing when a step has started', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 7, status: 'running', idempotency_key: null }] })
      .mockResolvedValueOnce({ rows: [{ step_id: 'ingest', status: 'running' }] })
      .mockResolvedValue({ rows: [] });
    await expect(deleteJob(7)).rejects.toBeInstanceOf(ConflictError);
    const sql = sqlCalls();
    expect(sql.some((q) => q.startsWith('DELETE'))).toBe(false);
    expect(sql[sql.length - 1]).toBe('ROLLBACK');
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });
});

describe('deleteJobs', () => {
  it('refuses to run without a key prefix, before touching the database', async () => {
    await expect(deleteJobs({})).rejects.toBeInstanceOf(JobFilterError);
    await expect(deleteJobs({ status: 'pending' })).rejects.toBeInstanceOf(JobFilterError);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('deletes the jobs whose steps are all pending and counts the others as skipped', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 1, status: 'pending' }, { id: 2, status: 'running' }, { id: 3, status: 'pending' }] })
      .mockResolvedValueOnce({
        rows: [
          { job_id: 1, step_id: 'a', status: 'pending' },
          { job_id: 2, step_id: 'a', status: 'success' },
          { job_id: 2, step_id: 'b', status: 'pending' },
          { job_id: 3, step_id: 'a', status: 'blocked' },
        ],
      })
      .mockResolvedValue({ rows: [] });
    const result = await deleteJobs({ key_prefix: ['ingest_ecmwf:202402'], status: 'pending', limit: 5, order: 'asc' });
    expect(result).toEqual({ deleted: [1, 3], skipped: 1 });
    const sql = sqlCalls();
    expect(sql[1]).toBe(
      'SELECT id, status FROM test.job WHERE status = ANY($1::text[]) AND idempotency_key LIKE ANY($2::text[]) ORDER BY id FOR UPDATE',
    );
    expect(mockQuery.mock.calls[1][1]).toEqual([['pending'], ['ingest\\_ecmwf:202402%']]);
    expect(sql[2]).toMatch(/FROM test\.job_step WHERE job_id = ANY\(\$1::int\[\]\) ORDER BY job_id, step_id FOR UPDATE$/);
    expect(mockQuery.mock.calls[3]).toEqual(['DELETE FROM test.job_output WHERE job_id = ANY($1::int[])', [[1, 3]]]);
    expect(sql[sql.length - 1]).toBe('COMMIT');
  });

  it('commits an empty result when nothing matches', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] }).mockResolvedValue({ rows: [] });
    expect(await deleteJobs({ key_prefix: ['nothing:'] })).toEqual({ deleted: [], skipped: 0 });
    expect(sqlCalls()).toEqual(['BEGIN', expect.stringMatching(/FOR UPDATE$/), 'COMMIT']);
  });
});
