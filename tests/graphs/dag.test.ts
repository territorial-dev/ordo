/**
 * DAG property tests: cycle detection, topological ordering, determinism.
 * These tests validate the graph construction logic in validateRecipe indirectly,
 * through carefully crafted recipe fixtures.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { validateRecipe } from '../../src/utils/validation';
import { executorMap, SINGLE_IO, DOUBLE_IN } from '../helpers/executors';
import { makeStep } from '../helpers/recipes';
import { RecipeDefinition } from '../../src/types';

vi.mock('../../src/services/stepExecutorService');

import * as stepExecutorService from '../../src/services/stepExecutorService';
const mockGetStepExecutors = vi.mocked(stepExecutorService.getStepExecutors);

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Topological ordering
// ---------------------------------------------------------------------------

describe('topological ordering', () => {
  it('accepts a valid DAG regardless of step declaration order', async () => {
    mockGetStepExecutors.mockResolvedValue(executorMap(SINGLE_IO));

    // Declare steps in reverse dependency order — still valid
    const recipe: RecipeDefinition = {
      recipe: [
        makeStep('step3', 'single-io', { input: 'step:step2.output' }, { output: 'step:step3.output' }),
        makeStep('step2', 'single-io', { input: 'step:step1.output' }, { output: 'step:step2.output' }),
        makeStep('step1', 'single-io', { input: 'job:raw' }, { output: 'step:step1.output' }),
      ],
    };

    await expect(validateRecipe(recipe)).resolves.toBeUndefined();
  });

  it('accepts a diamond-shaped DAG (fork then join)', async () => {
    mockGetStepExecutors.mockResolvedValue(executorMap(SINGLE_IO, DOUBLE_IN));

    // step1 → step2 \
    //                 → joiner
    // step1 → step3 /
    const recipe: RecipeDefinition = {
      recipe: [
        makeStep('step1', 'single-io', { input: 'job:raw' }, { output: 'step:step1.output' }),
        makeStep('step2', 'single-io', { input: 'step:step1.output' }, { output: 'step:step2.output' }),
        makeStep('step3', 'single-io', { input: 'step:step1.output' }, { output: 'step:step3.output' }),
        makeStep('joiner', 'double-in', { a: 'step:step2.output', b: 'step:step3.output' }, { result: 'step:joiner.result' }),
      ],
    };

    await expect(validateRecipe(recipe)).resolves.toBeUndefined();
  });

  it('accepts a wide DAG (many independent steps)', async () => {
    mockGetStepExecutors.mockResolvedValue(executorMap(SINGLE_IO));

    // 5 independent steps each consuming a job input
    const recipe: RecipeDefinition = {
      recipe: Array.from({ length: 5 }, (_, i) =>
        makeStep(`step${i}`, 'single-io', { input: `job:input${i}` }, { output: `step:step${i}.output` }),
      ),
    };

    await expect(validateRecipe(recipe)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Cycle detection
// ---------------------------------------------------------------------------

describe('cycle detection', () => {
  it('rejects a direct self-cycle (step references its own output as input)', async () => {
    // The artifact from step1 is referenced by step1 itself — this creates a cycle
    // because step1's output is also in the input, which topological sort catches.
    // Note: for a self-reference to construct, we need a double-in executor.
    mockGetStepExecutors.mockResolvedValue(executorMap(DOUBLE_IN));

    const recipe: RecipeDefinition = {
      recipe: [
        makeStep(
          'step1', 'double-in',
          { a: 'job:raw', b: 'step:step1.result' }, // b references own output
          { result: 'step:step1.result' },
        ),
      ],
    };

    await expect(validateRecipe(recipe)).rejects.toThrow('cycle');
  });

  it('rejects a two-step mutual cycle (A depends on B, B depends on A)', async () => {
    mockGetStepExecutors.mockResolvedValue(executorMap(SINGLE_IO));

    const recipe: RecipeDefinition = {
      recipe: [
        makeStep('stepA', 'single-io', { input: 'step:stepB.output' }, { output: 'step:stepA.output' }),
        makeStep('stepB', 'single-io', { input: 'step:stepA.output' }, { output: 'step:stepB.output' }),
      ],
    };

    await expect(validateRecipe(recipe)).rejects.toThrow('cycle');
  });

  it('rejects a three-step cycle (A → B → C → A)', async () => {
    mockGetStepExecutors.mockResolvedValue(executorMap(SINGLE_IO));

    const recipe: RecipeDefinition = {
      recipe: [
        makeStep('A', 'single-io', { input: 'step:C.output' }, { output: 'step:A.output' }),
        makeStep('B', 'single-io', { input: 'step:A.output' }, { output: 'step:B.output' }),
        makeStep('C', 'single-io', { input: 'step:B.output' }, { output: 'step:C.output' }),
      ],
    };

    await expect(validateRecipe(recipe)).rejects.toThrow('cycle');
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe('determinism', () => {
  it('produces the same validation result for the same recipe regardless of step order', async () => {
    mockGetStepExecutors.mockResolvedValue(executorMap(SINGLE_IO));

    const orderedRecipe: RecipeDefinition = {
      recipe: [
        makeStep('step1', 'single-io', { input: 'job:raw' }, { output: 'step:step1.output' }),
        makeStep('step2', 'single-io', { input: 'step:step1.output' }, { output: 'step:step2.output' }),
      ],
    };

    const reversedRecipe: RecipeDefinition = {
      recipe: [
        makeStep('step2', 'single-io', { input: 'step:step1.output' }, { output: 'step:step2.output' }),
        makeStep('step1', 'single-io', { input: 'job:raw' }, { output: 'step:step1.output' }),
      ],
    };

    const result1 = await validateRecipe(orderedRecipe);
    const result2 = await validateRecipe(reversedRecipe);

    expect(result1).toBeUndefined();
    expect(result2).toBeUndefined();
  });

  it('fails consistently for an invalid recipe regardless of how many times it runs', async () => {
    const alwaysEmpty = new Map();
    mockGetStepExecutors.mockResolvedValue(alwaysEmpty);

    const recipe: RecipeDefinition = {
      recipe: [makeStep('step1', 'missing-type', { input: 'job:raw' }, { output: 'step:step1.output' })],
    };

    // Run twice — should throw the same error both times
    await expect(validateRecipe(recipe)).rejects.toThrow('Unsupported step type: missing-type');
    await expect(validateRecipe(recipe)).rejects.toThrow('Unsupported step type: missing-type');
  });
});
