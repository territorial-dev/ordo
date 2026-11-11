/**
 * Cancel and delivery (1.17): POST /jobs/:id/cancel stops a job's open steps, withdraws what it
 * delivered and makes the runner API answer 409 "Job <id> was cancelled"; complete records the
 * runner's `delivered` uris on job_output; retry of a cancelled job runs again what it must
 * deliver again.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockQuery, mockRelease } = vi.hoisted(() => ({ mockQuery: vi.fn(), mockRelease: vi.fn() }));

vi.mock('../../src/db/connection', () => ({
  getPool: () => ({ connect: async () => ({ query: mockQuery, release: mockRelease }), query: mockQuery }),
  getSchema: () => 'test',
}));

import { cancelJob, retryJob } from '../../src/services/jobService';
import { claimStep, completeStep, ConflictError, failStep, heartbeatStep, RunnerRequestError } from '../../src/services/runnerService';

const sql = (c: unknown[]) => String(c[0]).replace(/\s+/g, ' ').trim();
const calls = () => mockQuery.mock.calls.map(sql);
const claimedAt = new Date('2026-11-11T17:00:00Z');

const recipe = {
  recipe: [
    { id: 'reproject', type: 'REPROJECT_LAS', inputs: { las: 'job:las' }, outputs: { las: 'step:reproject.las' } },
    { id: 'build_copc', type: 'BUILD_COPC', inputs: { las: 'step:reproject.las' }, outputs: { copc: 'step:build_copc.copc' } },
    { id: 'dataset_info', type: 'DATASET_INFO', inputs: { las: 'step:reproject.las' }, outputs: { info: 'step:dataset_info.info' } },
  ],
};

beforeEach(() => {
  mockQuery.mockReset();
  mockRelease.mockReset();
});

describe('cancelJob', () => {
  function db(jobStatus: string) {
    mockQuery.mockImplementation(async (text: string) => {
      const t = text.replace(/\s+/g, ' ');
      if (t.includes('FROM test.job WHERE id = $1 FOR UPDATE')) return { rows: [{ id: 42, status: jobStatus }] };
      if (t.includes('FROM test.job_step WHERE job_id = $1 ORDER BY step_id FOR UPDATE')) {
        return {
          rows: [
            { step_id: 'build_copc', step_type: 'BUILD_COPC', status: 'running', attempt: 1, claimed_by: 'n8n-dev:479661', claimed_at: claimedAt },
            { step_id: 'dataset_info', step_type: 'DATASET_INFO', status: 'success', attempt: 1, claimed_by: 'x', claimed_at: claimedAt },
            { step_id: 'reproject', step_type: 'REPROJECT_LAS', status: 'success', attempt: 1, claimed_by: 'x', claimed_at: claimedAt },
          ],
        };
      }
      if (t.includes('UPDATE test.job_output o SET delivered_uri = NULL')) {
        return { rows: [{ artifact_name: 'step:dataset_info.info', path: 'results/42/metadata', delivered_uri: 'mapprism/results/42/metadata/info.json' }] };
      }
      return { rows: [] };
    });
  }

  it('cancels the open steps, records the running attempt, withdraws deliveries, in one transaction', async () => {
    db('running');
    const result = await cancelJob(42, 'wrong input');
    expect(result).toEqual({
      id: 42,
      status: 'cancelled',
      already_cancelled: false,
      steps_cancelled: ['build_copc'],
      running: [{ step_id: 'build_copc', step_type: 'BUILD_COPC', claimed_by: 'n8n-dev:479661' }],
      withdrawn: [{ artifact_name: 'step:dataset_info.info', path: 'results/42/metadata', delivered_uri: 'mapprism/results/42/metadata/info.json' }],
    });
    const attempt = mockQuery.mock.calls.find((c) => sql(c).startsWith('INSERT INTO test.job_step_attempt'))!;
    expect(attempt[1]).toEqual([42, 'build_copc', 'BUILD_COPC', 1, 'n8n-dev:479661', 'cancelled: wrong input', claimedAt]);
    const stepUpdate = mockQuery.mock.calls.find((c) => sql(c).startsWith("UPDATE test.job_step SET status = 'cancelled'"))!;
    expect(sql(stepUpdate)).toContain('lease_token = NULL');
    expect(stepUpdate[1]).toEqual([42, ['build_copc'], 'cancelled: wrong input']);
    const jobUpdate = mockQuery.mock.calls.find((c) => sql(c).startsWith("UPDATE test.job SET status = 'cancelled'"))!;
    expect(jobUpdate[1]).toEqual([42, 'cancelled: wrong input']);
    expect(calls()[0]).toBe('BEGIN');
    expect(calls()[calls().length - 1]).toBe('COMMIT');
  });

  it('is a no-op on a cancelled job', async () => {
    db('cancelled');
    const result = await cancelJob(42);
    expect(result?.already_cancelled).toBe(true);
    expect(calls().some((c) => c.startsWith('UPDATE'))).toBe(false);
  });

  it('refuses a finished job', async () => {
    db('success');
    await expect(cancelJob(42)).rejects.toThrow('Job is success, not pending or running');
    expect(calls()).toContain('ROLLBACK');
  });

  it('returns null for an unknown job', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    expect(await cancelJob(9)).toBeNull();
  });
});

describe('runner API on a cancelled job', () => {
  const row = {
    job_id: 42, step_id: 'build_copc', step_type: 'BUILD_COPC', status: 'cancelled', attempt: 1,
    max_concurrency: null, requires: null, lease_seconds: null, lease_token: null,
    step_max_attempts: null, exec_requires: {}, exec_lease_seconds: 300, exec_max_attempts: 2,
    executor_ref: 'Pu8vEWMNMPch6yZ9', produces: {}, job_status: 'cancelled', job_params: null,
    idempotency_key: null, claimed_by: 'n8n-dev:1', claimed_at: claimedAt, definition: recipe,
  };

  beforeEach(() => {
    mockQuery.mockImplementation(async (text: string) => {
      if (text.includes('FOR UPDATE OF js')) return { rows: [row] };
      if (text.includes('SELECT status FROM test.job WHERE')) return { rows: [{ status: 'cancelled' }] };
      return { rows: [] };
    });
  });

  it('complete, fail and heartbeat answer 409 "Job 42 was cancelled"', async () => {
    await expect(completeStep(42, 'build_copc', { lease_token: 'tok', artifacts: {} })).rejects.toThrow('Job 42 was cancelled');
    await expect(failStep(42, 'build_copc', { lease_token: 'tok', kind: 'error' })).rejects.toThrow(ConflictError);
    await expect(heartbeatStep(42, 'build_copc', 'tok', undefined, undefined)).rejects.toThrow('Job 42 was cancelled');
  });
});

describe('complete records deliveries', () => {
  const row = {
    job_id: 42, step_id: 'build_copc', step_type: 'BUILD_COPC', status: 'running', attempt: 1,
    max_concurrency: null, requires: null, lease_seconds: null, lease_token: 'tok',
    step_max_attempts: null, exec_requires: {}, exec_lease_seconds: 300, exec_max_attempts: 2,
    executor_ref: 'Pu8vEWMNMPch6yZ9', produces: {}, job_status: 'running', job_params: null,
    idempotency_key: null, claimed_by: 'n8n-dev:1', claimed_at: claimedAt, definition: recipe,
  };
  const artifacts = { copc: { type: 'copc', uri: 'mapprism/artifacts/job_42/build_copc/output.copc.laz', hash: 'md5:1' } };

  beforeEach(() => {
    mockQuery.mockImplementation(async (text: string) => {
      if (text.includes('FOR UPDATE OF js')) return { rows: [row] };
      if (text.includes('SELECT artifact_name, path FROM test.job_output')) {
        return { rows: [{ artifact_name: 'step:build_copc.copc', path: 'results/42/copc' }] };
      }
      if (text.includes('SELECT status FROM test.job_step WHERE job_id')) return { rows: [{ status: 'pending' }] };
      if (text.includes('SELECT status FROM test.job WHERE')) return { rows: [{ status: 'running' }] };
      return { rows: [] };
    });
  });

  it('writes delivered_uri for each delivered slot before marking the step success', async () => {
    await completeStep(42, 'build_copc', {
      lease_token: 'tok', artifacts, delivered: { copc: 'mapprism/results/42/copc/output.copc.laz' },
    });
    const all = calls();
    const delivered = mockQuery.mock.calls.find((c) => sql(c).startsWith('UPDATE test.job_output SET delivered_uri'))!;
    expect(delivered[1]).toEqual([42, 'step:build_copc.copc', 'mapprism/results/42/copc/output.copc.laz']);
    expect(all.findIndex((c) => c.startsWith('UPDATE test.job_output'))).toBeLessThan(
      all.findIndex((c) => c.startsWith("UPDATE test.job_step SET status = 'success'")),
    );
  });

  it('rejects a delivered slot the step does not produce, and changes nothing', async () => {
    await expect(
      completeStep(42, 'build_copc', { lease_token: 'tok', artifacts, delivered: { info: 'x' } }),
    ).rejects.toThrow(RunnerRequestError);
    expect(calls().some((c) => c.startsWith('UPDATE'))).toBe(false);
    expect(calls()).toContain('ROLLBACK');
  });

  it('still completes without delivered (older runners)', async () => {
    await completeStep(42, 'build_copc', { lease_token: 'tok', artifacts });
    expect(calls().some((c) => c.startsWith('UPDATE test.job_output'))).toBe(false);
    expect(calls()).toContain("UPDATE test.job_step SET status = 'success', finished_at = now(), error = NULL, lease_expires_at = NULL WHERE job_id = $1 AND step_id = $2");
  });
});

describe('retryJob of a cancelled job', () => {
  it('resets the cancelled steps and the succeeded producers of withdrawn outputs', async () => {
    mockQuery.mockImplementation(async (text: string) => {
      const t = text.replace(/\s+/g, ' ');
      if (t.includes('FROM test.job WHERE id = $1 FOR UPDATE')) return { rows: [{ id: 42, status: 'cancelled', priority: 0 }] };
      if (t.includes('SELECT step_id, status FROM test.job_step')) {
        return { rows: [
          { step_id: 'build_copc', status: 'cancelled' },
          { step_id: 'dataset_info', status: 'success' },
          { step_id: 'reproject', status: 'success' },
        ] };
      }
      if (t.includes('o.delivered_uri IS NULL')) {
        return { rows: [
          { artifact_name: 'step:build_copc.copc', definition: recipe },
          { artifact_name: 'step:dataset_info.info', definition: recipe },
        ] };
      }
      if (t.startsWith(" UPDATE test.job_step") || t.includes('UPDATE test.job_step SET status')) {
        return { rows: [{ step_id: 'build_copc' }, { step_id: 'dataset_info' }] };
      }
      return { rows: [] };
    });
    const result = await retryJob(42);
    const reset = mockQuery.mock.calls.find((c) => sql(c).startsWith("UPDATE test.job_step SET status = 'pending'"))!;
    expect(reset[1]).toEqual([42, ['build_copc', 'dataset_info']]);
    expect(result?.steps_reset).toEqual(['build_copc', 'dataset_info']);
  });

  it('a failed job keeps its succeeded steps whatever they delivered', async () => {
    mockQuery.mockImplementation(async (text: string) => {
      const t = text.replace(/\s+/g, ' ');
      if (t.includes('FROM test.job WHERE id = $1 FOR UPDATE')) return { rows: [{ id: 42, status: 'failed', priority: 0 }] };
      if (t.includes('SELECT step_id, status FROM test.job_step')) {
        return { rows: [{ step_id: 'build_copc', status: 'failed' }, { step_id: 'dataset_info', status: 'success' }] };
      }
      return { rows: [] };
    });
    await retryJob(42);
    expect(calls().some((c) => c.includes('o.delivered_uri IS NULL'))).toBe(false);
    const reset = mockQuery.mock.calls.find((c) => sql(c).startsWith("UPDATE test.job_step SET status = 'pending'"))!;
    expect(reset[1]).toEqual([42, ['build_copc']]);
  });
});

describe('claim tells the runner what to deliver', () => {
  it('returns the declared outputs the claimed step produces', async () => {
    const candidate = {
      job_id: 42, step_id: 'build_copc', step_type: 'BUILD_COPC', status: 'pending', attempt: 0,
      max_concurrency: null, requires: null, lease_seconds: null, lease_token: null,
      step_max_attempts: null, exec_requires: {}, exec_lease_seconds: 300, exec_max_attempts: 2,
      executor_ref: 'Pu8vEWMNMPch6yZ9', produces: {}, job_status: 'running', job_params: {},
      idempotency_key: null, claimed_by: null, claimed_at: null, definition: recipe,
    };
    mockQuery.mockImplementation(async (text: string) => {
      const t = text.replace(/\s+/g, ' ');
      if (t.includes('FOR UPDATE OF js SKIP LOCKED')) return { rows: [candidate] };
      if (t.includes('SELECT step_id, status FROM test.job_step WHERE job_id')) {
        return { rows: [{ step_id: 'reproject', status: 'success' }, { step_id: 'build_copc', status: 'pending' }] };
      }
      if (t.includes('RETURNING attempt, lease_expires_at')) return { rows: [{ attempt: 1, lease_expires_at: claimedAt }] };
      if (t.includes('FROM test.job_artifact WHERE job_id')) {
        return { rows: [{ name: 'step:reproject.las', type: 'las', uri: 'u', hash: 'h', metadata: null, producer_step: 'reproject' }] };
      }
      if (t.includes('SELECT artifact_name, path FROM test.job_output')) {
        return { rows: [
          { artifact_name: 'step:build_copc.copc', path: 'results/42/copc' },
          { artifact_name: 'step:dataset_info.info', path: 'results/42/metadata' },
        ] };
      }
      return { rows: [] };
    });
    const claimed = await claimStep({ worker_id: 'n8n-dev:1' });
    expect(claimed?.deliver).toEqual([{ slot: 'copc', artifact_name: 'step:build_copc.copc', path: 'results/42/copc' }]);
  });
});
