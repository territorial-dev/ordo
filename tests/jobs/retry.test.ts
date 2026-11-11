import { describe, it, expect } from 'vitest';
import { canRetry, parsePriority, stepsToReset, PRIORITY_MAX, PRIORITY_MIN } from '../../src/utils/jobs';

describe('parsePriority', () => {
  it('treats undefined and null as not given', () => {
    expect(parsePriority(undefined)).toBeUndefined();
    expect(parsePriority(null)).toBeUndefined();
  });

  it('accepts integers within the range', () => {
    expect(parsePriority(0)).toBe(0);
    expect(parsePriority(-10)).toBe(-10);
    expect(parsePriority(PRIORITY_MAX)).toBe(PRIORITY_MAX);
    expect(parsePriority(PRIORITY_MIN)).toBe(PRIORITY_MIN);
  });

  it('rejects non-integers and out-of-range values', () => {
    expect(() => parsePriority('10')).toThrow(RangeError);
    expect(() => parsePriority(1.5)).toThrow(RangeError);
    expect(() => parsePriority(PRIORITY_MAX + 1)).toThrow(RangeError);
    expect(() => parsePriority(PRIORITY_MIN - 1)).toThrow(RangeError);
  });
});

describe('stepsToReset', () => {
  it('resets the failed step and the steps skipped because of it, keeps successes', () => {
    const steps = [
      { step_id: 'ingest', status: 'success' },
      { step_id: 'harmonize', status: 'failed' },
      { step_id: 'finalize', status: 'skipped' },
    ];
    expect(stepsToReset(steps)).toEqual(['harmonize', 'finalize']);
  });

  it('resets nothing when no step failed', () => {
    expect(stepsToReset([{ step_id: 'a', status: 'success' }])).toEqual([]);
  });
});

describe('canRetry', () => {
  it('a failed or cancelled job can be retried, nothing else', () => {
    expect(canRetry('failed')).toBe(true);
    expect(canRetry('cancelled')).toBe(true);
    for (const s of ['pending', 'running', 'success', 'completed', 'partial']) {
      expect(canRetry(s)).toBe(false);
    }
  });
});

describe('stepsToReset with cancelled steps and redelivery', () => {
  it('resets the steps a cancel stopped', () => {
    const steps = [
      { step_id: 'reproject', status: 'success' },
      { step_id: 'build_copc', status: 'cancelled' },
      { step_id: 'dataset_info', status: 'cancelled' },
    ];
    expect(stepsToReset(steps)).toEqual(['build_copc', 'dataset_info']);
  });

  it('also resets succeeded steps whose delivered output was withdrawn', () => {
    const steps = [
      { step_id: 'reproject', status: 'success' },
      { step_id: 'dataset_info', status: 'success' },
      { step_id: 'build_copc', status: 'cancelled' },
    ];
    expect(stepsToReset(steps, new Set(['dataset_info']))).toEqual(['dataset_info', 'build_copc']);
  });

  it('never resets a step listed for redelivery that did not succeed twice', () => {
    expect(stepsToReset([{ step_id: 'a', status: 'failed' }], new Set(['a']))).toEqual(['a']);
  });
});
