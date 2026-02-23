import { RecipeDefinition, StepDefinition } from '../../src/types';

export function makeStep(
  id: string,
  type: string,
  inputs: Record<string, string>,
  outputs: Record<string, string>,
  param_keys?: string[],
): StepDefinition {
  return { id, type, inputs, outputs, ...(param_keys ? { param_keys } : {}) };
}

/** Single-step recipe: consumes one job input, produces one artifact */
export function singleStepRecipe(): RecipeDefinition {
  return {
    recipe: [
      makeStep(
        'step1', 'single-io',
        { input: 'job:raw' },
        { output: 'step:step1.output' },
      ),
    ],
  };
}

/** Two-step linear chain: step1 → step2 */
export function linearChainRecipe(): RecipeDefinition {
  return {
    recipe: [
      makeStep('step1', 'single-io', { input: 'job:raw' }, { output: 'step:step1.output' }),
      makeStep('step2', 'single-io', { input: 'step:step1.output' }, { output: 'step:step2.output' }),
    ],
  };
}

/** Fork: step1 produces an artifact consumed by step2 and step3 independently */
export function forkRecipe(): RecipeDefinition {
  return {
    recipe: [
      makeStep('step1', 'single-io', { input: 'job:raw' }, { output: 'step:step1.output' }),
      makeStep('step2', 'single-io', { input: 'step:step1.output' }, { output: 'step:step2.output' }),
      makeStep('step3', 'single-io', { input: 'step:step1.output' }, { output: 'step:step3.output' }),
    ],
  };
}

/** Join: two job inputs feed step1 (double-in) */
export function joinRecipe(): RecipeDefinition {
  return {
    recipe: [
      makeStep(
        'joiner', 'double-in',
        { a: 'job:points', b: 'job:mesh' },
        { result: 'step:joiner.result' },
      ),
    ],
  };
}

/** Two-step recipe with param_keys on both steps */
export function paramRecipe(
  step1Keys: string[] = [],
  step2Keys: string[] = [],
): RecipeDefinition {
  return {
    recipe: [
      makeStep('step1', 'single-io', { input: 'job:raw' }, { output: 'step:step1.output' }, step1Keys),
      makeStep('step2', 'single-io', { input: 'step:step1.output' }, { output: 'step:step2.output' }, step2Keys),
    ],
  };
}
