/**
 * Job input artifact validation tests.
 *
 * createJob computes which artifacts are "initial inputs" (referenced by steps
 * but not produced by any step) and enforces that the caller supplies exactly
 * those artifacts — no more, no less.
 *
 * Also verifies the persistence invariant: artifact names stored in the DB
 * must be bare (no namespace prefix). The "job:" prefix is stripped before INSERT.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockGetRecipe = vi.fn();

// Use vi.hoisted so mockClientQuery is available inside the vi.mock factory.
const { mockClientQuery } = vi.hoisted(() => {
  const mockClientQuery = vi.fn().mockImplementation(async (sql: string) => {
    if (typeof sql === 'string' && sql.includes('RETURNING id')) {
      return { rows: [{ id: 99 }] };
    }
    return { rows: [] };
  });
  return { mockClientQuery };
});

vi.mock('../../src/db/connection', () => ({
  getPool: () => ({
    connect: () =>
      Promise.resolve({
        query: mockClientQuery,
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

/** Returns the [sql, params] pair from the first job_artifact INSERT call. */
function findArtifactInsert(): [string, unknown[]] | undefined {
  for (const call of mockClientQuery.mock.calls) {
    const [sql, params] = call as [string, unknown[]];
    if (typeof sql === 'string' && sql.includes('job_artifact') && sql.includes('INSERT')) {
      return [sql, params];
    }
  }
  return undefined;
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Input presence / exclusivity tests
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

// ---------------------------------------------------------------------------
// Persistence invariant: names stored in DB must be bare (no namespace prefix)
// ---------------------------------------------------------------------------

describe('artifact name persistence', () => {
  it('strips the job: prefix before inserting into job_artifact', async () => {
    const recipe = makeRecipe([
      makeStep('step1', 'single-io', { input: 'job:raw' }, { output: 'step:step1.output' }),
    ]);
    mockGetRecipe.mockResolvedValue(recipe);

    await createJob({ recipe_id: 1, inputs: { 'job:raw': artifact() } });

    const insert = findArtifactInsert();
    expect(insert, 'expected a job_artifact INSERT call').toBeDefined();

    const params = insert![1];
    expect(params).toContain('raw');         // bare name is persisted
    expect(params).not.toContain('job:raw'); // namespace prefix is gone
  });

  it('strips the job: prefix for multiple inputs', async () => {
    const recipe = makeRecipe([
      makeStep('joiner', 'double-in', { a: 'job:points', b: 'job:mesh' }, { result: 'step:joiner.result' }),
    ]);
    mockGetRecipe.mockResolvedValue(recipe);

    await createJob({
      recipe_id: 1,
      inputs: {
        'job:points': artifact('pointcloud'),
        'job:mesh': artifact('mesh'),
      },
    });

    const insertCalls = mockClientQuery.mock.calls.filter(
      ([sql]: [string]) => typeof sql === 'string' && sql.includes('job_artifact') && sql.includes('INSERT'),
    ) as [string, unknown[]][];

    expect(insertCalls).toHaveLength(2);

    const persistedNames = insertCalls.map(([, params]) => (params as unknown[])[1]);
    expect(persistedNames).toContain('points');
    expect(persistedNames).toContain('mesh');
    expect(persistedNames).not.toContain('job:points');
    expect(persistedNames).not.toContain('job:mesh');
  });

  it('throws if a name still contains a colon after stripping', async () => {
    // A name like "job:step:bad" strips to "step:bad" which still has a colon — guard fires.
    const recipe = makeRecipe([
      makeStep('step1', 'single-io', { input: 'job:step:bad' }, { output: 'step:step1.output' }),
    ]);
    mockGetRecipe.mockResolvedValue(recipe);

    await expect(
      createJob({ recipe_id: 1, inputs: { 'job:step:bad': artifact() } }),
    ).rejects.toThrow('must not contain namespace prefixes');
  });
});
