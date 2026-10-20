import { describe, it, expect } from 'vitest';
import { decideFailure, isStepReady, producerOf } from '../../src/utils/readiness';
import { makeStep } from '../helpers/recipes';

describe('producerOf', () => {
  it('extracts the producer step of a step reference', () => {
    expect(producerOf('step:reproject.output_las')).toBe('reproject');
    expect(producerOf('job:raw')).toBeNull();
  });
});

describe('isStepReady', () => {
  it('is ready when it only reads job inputs', () => {
    const step = makeStep('a', 'single-io', { input: 'job:raw' }, { output: 'step:a.output' });
    expect(isStepReady(step, new Map())).toBe(true);
  });

  it('waits for upstream steps to succeed', () => {
    const step = makeStep('b', 'single-io', { input: 'step:a.output' }, { output: 'step:b.output' });
    expect(isStepReady(step, new Map([['a', 'running']]))).toBe(false);
    expect(isStepReady(step, new Map([['a', 'failed']]))).toBe(false);
    expect(isStepReady(step, new Map([['a', 'success']]))).toBe(true);
  });

  it('requires every upstream step', () => {
    const step = makeStep('c', 'double-in', { a: 'step:a.output', b: 'step:b.output' }, { result: 'step:c.result' });
    expect(isStepReady(step, new Map([['a', 'success'], ['b', 'pending']]))).toBe(false);
    expect(isStepReady(step, new Map([['a', 'success'], ['b', 'success']]))).toBe(true);
  });
});

describe('decideFailure', () => {
  it('wait always blocks and never fails', () => {
    expect(decideFailure('wait', 5, 1, true)).toEqual({ next: 'blocked' });
    expect(decideFailure('wait', 5, 1, false)).toEqual({ next: 'blocked' });
  });

  it('error fails when retries are exhausted or disabled', () => {
    expect(decideFailure('error', 1, 1, true)).toEqual({ next: 'failed' });
    expect(decideFailure('error', 3, 3, true)).toEqual({ next: 'failed' });
    expect(decideFailure('error', 1, 3, false)).toEqual({ next: 'failed' });
  });

  it('error returns the step to pending while attempts remain', () => {
    expect(decideFailure('error', 1, 3, true)).toEqual({ next: 'pending' });
    expect(decideFailure('error', 2, 3, true)).toEqual({ next: 'pending' });
  });
});
