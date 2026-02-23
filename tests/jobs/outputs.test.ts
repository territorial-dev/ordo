/**
 * Job output mapping validation tests.
 *
 * createJob allows callers to declare which produced artifacts should be
 * finalized after the job completes. The artifact names must reference
 * step-produced artifacts — not job inputs or non-existent names.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockGetRecipe = vi.fn();

vi.mock('../../src/db/connection', () => ({
  getPool: () => ({
    connect: () =>
      Promise.resolve({
        query: (sql: string) => {
          if (typeof sql === 'string' && sql.includes('RETURNING id')) {
            return Promise.resolve({ rows: [{ id: 99 }] });
          }
          return Promise.resolve({ rows: [] });
        },
        release: () => {},
      }),
  }),
  getSchema: () => 'test',
}));

vi.mock('../../src/services/recipeService', () => ({
  getRecipe: (...args: unknown[]) => mockGetRecipe(...args),
  createRecipe: () => Promise.resolve(1),
  getRecipeByNameAndVersion: () => Promise.resolve(null),
}));

// ---------------------------------------------------------------------------
// Module under test
// ---------------------------------------------------------------------------

import { createJob } from '../../src/services/jobService';
import { makeStep } from '../helpers/recipes';
import { Recipe } from '../../src/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRecipe(steps: ReturnType<typeof makeStep>[]): Recipe {
  return {
    id: 1,
    name: 'test-recipe',
    version: '1.0',
    created_at: new Date(),
    definition: { recipe: steps },
  };
}

const rawInput = { 'job:raw': { type: 'pointcloud', uri: 'file:///raw.las', hash: 'abc' } };

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('job output mapping validation', () => {
  it('succeeds with no outputs declared', async () => {
    const recipe = makeRecipe([
      makeStep('step1', 'single-io', { input: 'job:raw' }, { output: 'step:step1.output' }),
    ]);
    mockGetRecipe.mockResolvedValue(recipe);

    await expect(
      createJob({ recipe_id: 1, inputs: rawInput }),
    ).resolves.toBeTypeOf('number');
  });

  it('succeeds when outputs reference a valid step-produced artifact', async () => {
    const recipe = makeRecipe([
      makeStep('step1', 'single-io', { input: 'job:raw' }, { output: 'step:step1.output' }),
    ]);
    mockGetRecipe.mockResolvedValue(recipe);

    await expect(
      createJob({
        recipe_id: 1,
        inputs: rawInput,
        outputs: { 'step:step1.output': { path: '/dest/model.bin' } },
      }),
    ).resolves.toBeTypeOf('number');
  });

  it('rejects when an output references an artifact not producible by any step', async () => {
    const recipe = makeRecipe([
      makeStep('step1', 'single-io', { input: 'job:raw' }, { output: 'step:step1.output' }),
    ]);
    mockGetRecipe.mockResolvedValue(recipe);

    await expect(
      createJob({
        recipe_id: 1,
        inputs: rawInput,
        outputs: { 'step:nonexistent.result': { path: '/dest/result' } },
      }),
    ).rejects.toThrow('Invalid job output "step:nonexistent.result"');
  });

  it('rejects when an output references a job-level input artifact', async () => {
    // 'job:raw' is an input, not produced by any step — not a valid output
    const recipe = makeRecipe([
      makeStep('step1', 'single-io', { input: 'job:raw' }, { output: 'step:step1.output' }),
    ]);
    mockGetRecipe.mockResolvedValue(recipe);

    await expect(
      createJob({
        recipe_id: 1,
        inputs: rawInput,
        outputs: { 'job:raw': { path: '/dest/raw.las' } },
      }),
    ).rejects.toThrow('Invalid job output "job:raw"');
  });

  it('succeeds when multiple valid outputs are declared', async () => {
    const recipe = makeRecipe([
      makeStep('step1', 'single-io', { input: 'job:raw' }, { output: 'step:step1.output' }),
      makeStep('step2', 'single-io', { input: 'step:step1.output' }, { output: 'step:step2.output' }),
    ]);
    mockGetRecipe.mockResolvedValue(recipe);

    await expect(
      createJob({
        recipe_id: 1,
        inputs: rawInput,
        outputs: {
          'step:step1.output': { path: '/dest/intermediate' },
          'step:step2.output': { path: '/dest/final' },
        },
      }),
    ).resolves.toBeTypeOf('number');
  });

  it('rejects when at least one output in a multi-output declaration is invalid', async () => {
    const recipe = makeRecipe([
      makeStep('step1', 'single-io', { input: 'job:raw' }, { output: 'step:step1.output' }),
    ]);
    mockGetRecipe.mockResolvedValue(recipe);

    await expect(
      createJob({
        recipe_id: 1,
        inputs: rawInput,
        outputs: {
          'step:step1.output': { path: '/dest/ok' },       // valid
          'step:missing.output': { path: '/dest/bad' },     // invalid
        },
      }),
    ).rejects.toThrow('Invalid job output "step:missing.output"');
  });
});
