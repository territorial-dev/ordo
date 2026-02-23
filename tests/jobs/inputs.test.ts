/**
 * Job input artifact validation tests.
 *
 * createJob computes which artifacts are "initial inputs" (referenced by steps
 * but not produced by any step) and enforces that the caller supplies exactly
 * those artifacts — no more, no less.
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

function artifact(type = 'pointcloud') {
  return { type, uri: 'file:///data', hash: 'sha256:abc' };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('job input artifact validation', () => {
  it('succeeds when exactly the required initial inputs are provided', async () => {
    const recipe = makeRecipe([
      makeStep('step1', 'single-io', { input: 'job:raw' }, { output: 'step:step1.output' }),
    ]);
    mockGetRecipe.mockResolvedValue(recipe);

    await expect(
      createJob({ recipe_id: 1, inputs: { 'job:raw': artifact() } }),
    ).resolves.toBeTypeOf('number');
  });

  it('rejects when a required initial input is missing', async () => {
    const recipe = makeRecipe([
      makeStep('step1', 'single-io', { input: 'job:raw' }, { output: 'step:step1.output' }),
    ]);
    mockGetRecipe.mockResolvedValue(recipe);

    await expect(
      createJob({ recipe_id: 1, inputs: {} }),
    ).rejects.toThrow('Missing required initial input artifact: job:raw');
  });

  it('rejects when an extra input artifact is provided', async () => {
    const recipe = makeRecipe([
      makeStep('step1', 'single-io', { input: 'job:raw' }, { output: 'step:step1.output' }),
    ]);
    mockGetRecipe.mockResolvedValue(recipe);

    await expect(
      createJob({
        recipe_id: 1,
        inputs: {
          'job:raw': artifact(),
          'job:extra': artifact('model'), // not referenced by any step
        },
      }),
    ).rejects.toThrow('Unexpected input artifact "job:extra"');
  });

  it('succeeds when a recipe requires multiple job inputs and all are provided', async () => {
    const recipe = makeRecipe([
      makeStep('joiner', 'double-in', { a: 'job:points', b: 'job:mesh' }, { result: 'step:joiner.result' }),
    ]);
    mockGetRecipe.mockResolvedValue(recipe);

    await expect(
      createJob({
        recipe_id: 1,
        inputs: {
          'job:points': artifact('pointcloud'),
          'job:mesh': artifact('mesh'),
        },
      }),
    ).resolves.toBeTypeOf('number');
  });

  it('rejects when one of multiple required inputs is missing', async () => {
    const recipe = makeRecipe([
      makeStep('joiner', 'double-in', { a: 'job:points', b: 'job:mesh' }, { result: 'step:joiner.result' }),
    ]);
    mockGetRecipe.mockResolvedValue(recipe);

    await expect(
      createJob({
        recipe_id: 1,
        inputs: { 'job:points': artifact('pointcloud') }, // 'job:mesh' missing
      }),
    ).rejects.toThrow('Missing required initial input artifact: job:mesh');
  });

  it('does not treat step-produced artifacts as required job inputs', async () => {
    // step2 consumes step1's output — that artifact is internal, not a job input
    const recipe = makeRecipe([
      makeStep('step1', 'single-io', { input: 'job:raw' }, { output: 'step:step1.output' }),
      makeStep('step2', 'single-io', { input: 'step:step1.output' }, { output: 'step:step2.output' }),
    ]);
    mockGetRecipe.mockResolvedValue(recipe);

    // Only 'job:raw' should be required — step:step1.output is internal
    await expect(
      createJob({ recipe_id: 1, inputs: { 'job:raw': artifact() } }),
    ).resolves.toBeTypeOf('number');
  });

  it('rejects when an internal artifact is provided as if it were a job input', async () => {
    const recipe = makeRecipe([
      makeStep('step1', 'single-io', { input: 'job:raw' }, { output: 'step:step1.output' }),
      makeStep('step2', 'single-io', { input: 'step:step1.output' }, { output: 'step:step2.output' }),
    ]);
    mockGetRecipe.mockResolvedValue(recipe);

    await expect(
      createJob({
        recipe_id: 1,
        inputs: {
          'job:raw': artifact(),
          'step:step1.output': artifact('model'), // internal artifact injected externally
        },
      }),
    ).rejects.toThrow('Unexpected input artifact "step:step1.output"');
  });
});
