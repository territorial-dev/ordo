import { describe, it, expect } from 'vitest';
import { checkDelivered, deliverablesForStep, producersOf } from '../../src/utils/delivery';
import { cancelBlocker, CANCELLED_STEP_STATUSES, deleteBlocker } from '../../src/utils/jobs';
import { parseCancelReason, CANCEL_REASON_MAX } from '../../src/controllers/jobController';

const copc = { id: 'build_copc', type: 'BUILD_COPC', inputs: { las: 'step:reproject.las' }, outputs: { copc: 'step:build_copc.copc' } };
const info = { id: 'dataset_info', type: 'DATASET_INFO', inputs: { las: 'step:reproject.las' }, outputs: { info: 'step:dataset_info.info' } };
const reproject = { id: 'reproject', type: 'REPROJECT_LAS', inputs: { las: 'job:las' }, outputs: { las: 'step:reproject.las' } };

describe('deliverablesForStep', () => {
  const outputs = [
    { artifact_name: 'step:build_copc.copc', path: 'results/42/copc' },
    { artifact_name: 'step:dataset_info.info', path: 'results/42/metadata' },
  ];

  it('lists the declared outputs the step produces, by slot', () => {
    expect(deliverablesForStep(copc, outputs)).toEqual([
      { slot: 'copc', artifact_name: 'step:build_copc.copc', path: 'results/42/copc' },
    ]);
  });

  it('is empty for a step none of whose outputs is declared', () => {
    expect(deliverablesForStep(reproject, outputs)).toEqual([]);
  });

  it('is empty when the job declares no outputs', () => {
    expect(deliverablesForStep(copc, [])).toEqual([]);
  });
});

describe('checkDelivered', () => {
  const deliver = [{ slot: 'copc', artifact_name: 'step:build_copc.copc', path: 'results/42/copc' }];

  it('accepts nothing at all, so older runners keep working', () => {
    expect(checkDelivered(undefined, deliver)).toBeNull();
    expect(checkDelivered(null, deliver)).toBeNull();
  });

  it('accepts a deliverable slot with a uri, and a subset of the slots', () => {
    expect(checkDelivered({ copc: 'mapprism/results/42/copc/output.copc.laz' }, deliver)).toBeNull();
    expect(checkDelivered({}, deliver)).toBeNull();
  });

  it('rejects a slot the step does not deliver', () => {
    expect(checkDelivered({ info: 'x' }, deliver)).toMatch(/not a declared output of this step/);
    expect(checkDelivered({ copc: 'x' }, [])).toMatch(/deliverable: none/);
  });

  it('rejects malformed values', () => {
    expect(checkDelivered([], deliver)).toMatch(/object keyed by output slot/);
    expect(checkDelivered('x', deliver)).toMatch(/object keyed by output slot/);
    expect(checkDelivered({ copc: '' }, deliver)).toMatch(/non-empty string/);
    expect(checkDelivered({ copc: 3 }, deliver)).toMatch(/non-empty string/);
  });
});

describe('producersOf', () => {
  it('finds the steps that produce the given artifacts', () => {
    expect(producersOf([reproject, copc, info], ['step:dataset_info.info'])).toEqual(new Set(['dataset_info']));
    expect(producersOf([reproject, copc, info], [])).toEqual(new Set());
  });
});

describe('cancelBlocker', () => {
  it('lets an open job be cancelled, and a cancelled one again as a no-op', () => {
    for (const s of ['pending', 'running', 'cancelled']) expect(cancelBlocker(s)).toBeNull();
  });

  it('refuses a finished job', () => {
    for (const s of ['success', 'completed', 'failed', 'partial']) {
      expect(cancelBlocker(s)).toBe(`Job is ${s}, not pending or running`);
    }
  });

  it('stops every step that has not finished', () => {
    expect(CANCELLED_STEP_STATUSES).toEqual(new Set(['pending', 'blocked', 'running']));
  });
});

describe('deleteBlocker for cancelled jobs', () => {
  it('deletes a cancelled job none of whose steps succeeded', () => {
    expect(deleteBlocker('cancelled', [{ step_id: 'a', status: 'cancelled' }, { step_id: 'b', status: 'failed' }])).toBeNull();
  });

  it('keeps a cancelled job with a succeeded step', () => {
    expect(deleteBlocker('cancelled', [{ step_id: 'a', status: 'success' }])).toBe(
      'Step a is success; a cancelled job is deleted only when no step succeeded',
    );
  });
});

describe('parseCancelReason', () => {
  it('is optional and trimmed', () => {
    expect(parseCancelReason(undefined)).toBeUndefined();
    expect(parseCancelReason(null)).toBeUndefined();
    expect(parseCancelReason('   ')).toBeUndefined();
    expect(parseCancelReason(' wrong file ')).toBe('wrong file');
  });

  it('rejects non-strings and long reasons', () => {
    expect(() => parseCancelReason(3)).toThrow(RangeError);
    expect(() => parseCancelReason('x'.repeat(CANCEL_REASON_MAX + 1))).toThrow(RangeError);
  });
});
