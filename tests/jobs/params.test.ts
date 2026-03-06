/**
 * Job parameter validation tests.
 *
 * createJob validates that all param_keys declared on a recipe step are present
 * in the job-level params object. These tests exercise that logic using a
 * lightweight mock for the database and recipe service.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — defined before importing the module under test
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
// Module under test (imported after mocks are registered)
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

/** Minimal valid input satisfying a recipe with a single job:raw input */
const singleInput = {
  'job:raw': { type: 'pointcloud', uri: 'file:///raw.las', hash: 'abc123' },
};

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('job param validation', () => {
  it('succeeds when all required param_keys are provided', async () => {
    const recipe = makeRecipe([
      makeStep('step1', 'single-io', { input: 'job:raw' }, { output: 'step:step1.output' }, ['threshold']),
    ]);
    mockGetRecipe.mockResolvedValue(recipe);

    await expect(
      createJob({
        recipe_id: 1,
        inputs: singleInput,
        params: { step1: { threshold: 0.5 } },
      }),
    ).resolves.toBeTypeOf('number');
  });

  it('rejects when a required param is missing', async () => {
    const recipe = makeRecipe([
      makeStep('step1', 'single-io', { input: 'job:raw' }, { output: 'step:step1.output' }, ['threshold', 'mode']),
    ]);
    mockGetRecipe.mockResolvedValue(recipe);

    await expect(
      createJob({
        recipe_id: 1,
        inputs: singleInput,
        params: { step1: { threshold: 0.5 } }, // missing 'mode'
      }),
    ).rejects.toThrow('Missing required param "mode" for step "step1"');
  });

  it('rejects when no params are provided for a step with param_keys', async () => {
    const recipe = makeRecipe([
      makeStep('step1', 'single-io', { input: 'job:raw' }, { output: 'step:step1.output' }, ['threshold']),
    ]);
    mockGetRecipe.mockResolvedValue(recipe);

    await expect(
      createJob({
        recipe_id: 1,
        inputs: singleInput,
        // no params at all
      }),
    ).rejects.toThrow('Missing required param "threshold" for step "step1"');
  });

  it('rejects when the step entry in params is present but the key is missing', async () => {
    const recipe = makeRecipe([
      makeStep('step1', 'single-io', { input: 'job:raw' }, { output: 'step:step1.output' }, ['alpha', 'beta']),
    ]);
    mockGetRecipe.mockResolvedValue(recipe);

    await expect(
      createJob({
        recipe_id: 1,
        inputs: singleInput,
        params: { step1: { alpha: 1 } }, // beta missing
      }),
    ).rejects.toThrow('Missing required param "beta" for step "step1"');
  });

  it('succeeds when a step has no param_keys and no params are supplied', async () => {
    const recipe = makeRecipe([
      makeStep('step1', 'single-io', { input: 'job:raw' }, { output: 'step:step1.output' }),
    ]);
    mockGetRecipe.mockResolvedValue(recipe);

    await expect(
      createJob({ recipe_id: 1, inputs: singleInput }),
    ).resolves.toBeTypeOf('number');
  });

  it('enforces param_keys isolation: missing param on second step is caught', async () => {
    const recipe = makeRecipe([
      makeStep('step1', 'single-io', { input: 'job:raw' }, { output: 'step:step1.output' }, ['k1']),
      makeStep('step2', 'single-io', { input: 'step:step1.output' }, { output: 'step:step2.output' }, ['k2']),
    ]);
    mockGetRecipe.mockResolvedValue(recipe);

    await expect(
      createJob({
        recipe_id: 1,
        inputs: singleInput,
        params: { step1: { k1: 'v' } }, // step2.k2 missing
      }),
    ).rejects.toThrow('Missing required param "k2" for step "step2"');
  });

  it('succeeds when extra keys are provided alongside required ones', async () => {
    // Extra keys in params are not rejected — only absence of required keys is an error
    const recipe = makeRecipe([
      makeStep('step1', 'single-io', { input: 'job:raw' }, { output: 'step:step1.output' }, ['required']),
    ]);
    mockGetRecipe.mockResolvedValue(recipe);

    await expect(
      createJob({
        recipe_id: 1,
        inputs: singleInput,
        params: { step1: { required: 'yes', extra: 'ignored' } },
      }),
    ).resolves.toBeTypeOf('number');
  });
});

// ---------------------------------------------------------------------------
// on_exit param validation
// ---------------------------------------------------------------------------

describe('on_exit param validation', () => {
  function makeRecipeWithOnExit(
    steps: ReturnType<typeof makeStep>[],
    onExitParamKeys?: string[],
  ): Recipe {
    return {
      id: 1,
      name: 'test-recipe',
      version: '1.0',
      created_at: new Date(),
      definition: {
        recipe: steps,
        on_exit: {
          id: 'notify',
          type: 'on-exit-webhook',
          inputs: { metadata: 'step:step1.output' },
          ...(onExitParamKeys ? { param_keys: onExitParamKeys } : {}),
        },
      },
    };
  }

  it('rejects when on_exit param_keys are declared but not provided', async () => {
    const recipe = makeRecipeWithOnExit(
      [makeStep('step1', 'single-io', { input: 'job:raw' }, { output: 'step:step1.output' })],
      ['webhook_url'],
    );
    mockGetRecipe.mockResolvedValue(recipe);

    await expect(
      createJob({ recipe_id: 1, inputs: singleInput }),
    ).rejects.toThrow('Missing required param "webhook_url" for on_exit step "notify"');
  });

  it('rejects when only some on_exit param_keys are provided', async () => {
    const recipe = makeRecipeWithOnExit(
      [makeStep('step1', 'single-io', { input: 'job:raw' }, { output: 'step:step1.output' })],
      ['webhook_url', 'secret'],
    );
    mockGetRecipe.mockResolvedValue(recipe);

    await expect(
      createJob({
        recipe_id: 1,
        inputs: singleInput,
        params: { notify: { webhook_url: 'https://example.com' } }, // missing 'secret'
      }),
    ).rejects.toThrow('Missing required param "secret" for on_exit step "notify"');
  });

  it('succeeds when all on_exit param_keys are provided', async () => {
    const recipe = makeRecipeWithOnExit(
      [makeStep('step1', 'single-io', { input: 'job:raw' }, { output: 'step:step1.output' })],
      ['webhook_url'],
    );
    mockGetRecipe.mockResolvedValue(recipe);

    await expect(
      createJob({
        recipe_id: 1,
        inputs: singleInput,
        params: { notify: { webhook_url: 'https://example.com' } },
      }),
    ).resolves.toBeTypeOf('number');
  });

  it('succeeds when on_exit has no param_keys and no params are supplied', async () => {
    const recipe = makeRecipeWithOnExit([
      makeStep('step1', 'single-io', { input: 'job:raw' }, { output: 'step:step1.output' }),
    ]);
    mockGetRecipe.mockResolvedValue(recipe);

    await expect(
      createJob({ recipe_id: 1, inputs: singleInput }),
    ).resolves.toBeTypeOf('number');
  });
});
