/**
 * Progress calculation tests: merging job_step status with the latest
 * job_step_detailing entry for that step into a job-level percentage.
 * Pure-function tests against src/utils/progress.ts — no DB involved.
 */
import { describe, it, expect } from 'vitest';
import {
  extractDetailingPercent,
  stepProgressFraction,
  computeJobProgressPercentage,
} from '../../src/utils/progress';
import { JobStep, JobStepDetailing } from '../../src/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDetailing(progress: Record<string, any> | null): JobStepDetailing {
  return {
    id: 1,
    job_id: 1,
    step_id: 'step1',
    log: null,
    progress,
    updated_at: new Date(),
  };
}

function makeJobStep(overrides: Partial<JobStep> = {}): JobStep {
  return {
    job_id: 1,
    step_id: 'step1',
    step_type: 'single-io',
    status: 'pending',
    attempt: 0,
    claimed_by: null,
    claimed_at: null,
    started_at: null,
    finished_at: null,
    error: null,
    max_concurrency: null,
    last_detailing: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// extractDetailingPercent
// ---------------------------------------------------------------------------

describe('extractDetailingPercent', () => {
  it('returns 0 for null/undefined detailing', () => {
    expect(extractDetailingPercent(null)).toBe(0);
    expect(extractDetailingPercent(undefined)).toBe(0);
  });

  it('returns 0 when progress is null', () => {
    expect(extractDetailingPercent(makeDetailing(null))).toBe(0);
  });

  it('returns 0 when progress has no known key', () => {
    expect(extractDetailingPercent(makeDetailing({}))).toBe(0);
  });

  it('reads the "progress" key (live prod shape)', () => {
    expect(extractDetailingPercent(makeDetailing({ progress: 65 }))).toBe(65);
  });

  it('reads the "percent" key (README-documented shape)', () => {
    expect(extractDetailingPercent(makeDetailing({ percent: 40 }))).toBe(40);
  });

  it('reads the "percentage" key', () => {
    expect(extractDetailingPercent(makeDetailing({ percentage: 20 }))).toBe(20);
  });

  it('prioritizes "progress" over "percent" when both are present', () => {
    expect(extractDetailingPercent(makeDetailing({ progress: 65, percent: 10 }))).toBe(65);
  });

  it('clamps values above 100', () => {
    expect(extractDetailingPercent(makeDetailing({ progress: 150 }))).toBe(100);
  });

  it('clamps values below 0', () => {
    expect(extractDetailingPercent(makeDetailing({ progress: -5 }))).toBe(0);
  });

  it('ignores non-numeric values', () => {
    expect(extractDetailingPercent(makeDetailing({ progress: '65' }))).toBe(0);
  });

  it('tolerates extra sibling keys (live prod shape)', () => {
    expect(extractDetailingPercent(makeDetailing({ status: 'RUNNING', progress: 99 }))).toBe(99);
  });
});

// ---------------------------------------------------------------------------
// stepProgressFraction / computeJobProgressPercentage
// ---------------------------------------------------------------------------

describe('stepProgressFraction', () => {
  it('is 1 for a successful step', () => {
    expect(stepProgressFraction(makeJobStep({ status: 'success' }))).toBe(1);
  });

  it('is 0 for a running step with no detailing row', () => {
    expect(stepProgressFraction(makeJobStep({ status: 'running', last_detailing: null }))).toBe(0);
  });

  it('is percent/100 for a running step with a detailing row', () => {
    const step = makeJobStep({ status: 'running', last_detailing: makeDetailing({ progress: 50 }) });
    expect(stepProgressFraction(step)).toBe(0.5);
  });

  it('is 0 for pending, failed, and skipped, even with a stale detailing row', () => {
    const stale = makeDetailing({ progress: 90 });
    expect(stepProgressFraction(makeJobStep({ status: 'pending', last_detailing: stale }))).toBe(0);
    expect(stepProgressFraction(makeJobStep({ status: 'failed', last_detailing: stale }))).toBe(0);
    expect(stepProgressFraction(makeJobStep({ status: 'skipped', last_detailing: stale }))).toBe(0);
  });
});

describe('computeJobProgressPercentage', () => {
  it('returns 0 for an empty step list', () => {
    expect(computeJobProgressPercentage([])).toBe(0);
  });

  it('averages fractions across a mixed job', () => {
    const steps = [
      makeJobStep({ step_id: 'a', status: 'success' }),
      makeJobStep({ step_id: 'b', status: 'running', last_detailing: makeDetailing({ progress: 50 }) }),
      makeJobStep({ step_id: 'c', status: 'pending' }),
    ];
    // (100 + 50 + 0) / (3 * 100) = 0.5
    expect(computeJobProgressPercentage(steps)).toBeCloseTo(0.5);
  });

  it('matches the worked example: 1 success, 1 at 65%, 1 not started', () => {
    const steps = [
      makeJobStep({ step_id: 'a', status: 'success' }),
      makeJobStep({ step_id: 'b', status: 'running', last_detailing: makeDetailing({ progress: 65 }) }),
      makeJobStep({ step_id: 'c', status: 'pending' }),
    ];
    // (100 + 65 + 0) / (3 * 100) = 0.55
    expect(computeJobProgressPercentage(steps)).toBeCloseTo(0.55);
  });

  it('returns 1 when all steps succeeded', () => {
    const steps = [
      makeJobStep({ step_id: 'a', status: 'success' }),
      makeJobStep({ step_id: 'b', status: 'success' }),
    ];
    expect(computeJobProgressPercentage(steps)).toBe(1);
  });
});
