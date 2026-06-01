import { describe, it, expect, vi, beforeEach } from 'vitest';
import { validateRecipe, ValidationError } from '../../src/utils/validation';
import { executorMap, makeExecutor, SINGLE_IO, DOUBLE_IN, NO_INPUT, NO_OUTPUT } from '../helpers/executors';
import { singleStepRecipe, linearChainRecipe, forkRecipe, joinRecipe, makeStep } from '../helpers/recipes';
import { RecipeDefinition } from '../../src/types';

vi.mock('../../src/services/stepExecutorService');

import * as stepExecutorService from '../../src/services/stepExecutorService';
const mockGetStepExecutors = vi.mocked(stepExecutorService.getStepExecutors);

/** Set the mock to return a map containing the given executors. */
function withExecutors(...types: typeof SINGLE_IO[]) {
  mockGetStepExecutors.mockResolvedValue(executorMap(...types));
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Valid recipes
// ---------------------------------------------------------------------------

describe('valid recipes', () => {
  it('accepts a minimal single-step recipe', async () => {
    withExecutors(SINGLE_IO);
    await expect(validateRecipe(singleStepRecipe())).resolves.toBeUndefined();
  });

  it('accepts a two-step linear chain', async () => {
    withExecutors(SINGLE_IO);
    await expect(validateRecipe(linearChainRecipe())).resolves.toBeUndefined();
  });

  it('accepts a forking recipe (one step feeds two downstream steps)', async () => {
    withExecutors(SINGLE_IO);
    await expect(validateRecipe(forkRecipe())).resolves.toBeUndefined();
  });

  it('accepts a joining recipe (two job inputs into one step)', async () => {
    withExecutors(DOUBLE_IN);
    await expect(validateRecipe(joinRecipe())).resolves.toBeUndefined();
  });

  it('accepts a step with no inputs (no-input executor)', async () => {
    withExecutors(NO_INPUT);
    const recipe: RecipeDefinition = {
      recipe: [makeStep('gen', 'no-input', {}, { out: 'step:gen.out' })],
    };
    await expect(validateRecipe(recipe)).resolves.toBeUndefined();
  });

  it('accepts a step with no outputs (no-output executor)', async () => {
    withExecutors(NO_OUTPUT);
    const recipe: RecipeDefinition = {
      recipe: [makeStep('sink', 'no-output', { in: 'job:data' }, {})],
    };
    await expect(validateRecipe(recipe)).resolves.toBeUndefined();
  });

  it('accepts steps given in reverse dependency order (topological sort handles it)', async () => {
    withExecutors(SINGLE_IO);
    // step2 listed first even though it depends on step1
    const recipe: RecipeDefinition = {
      recipe: [
        makeStep('step2', 'single-io', { input: 'step:step1.output' }, { output: 'step:step2.output' }),
        makeStep('step1', 'single-io', { input: 'job:raw' }, { output: 'step:step1.output' }),
      ],
    };
    await expect(validateRecipe(recipe)).resolves.toBeUndefined();
  });

  it('accepts a step with valid param_keys', async () => {
    withExecutors(SINGLE_IO);
    const recipe: RecipeDefinition = {
      recipe: [
        makeStep('step1', 'single-io', { input: 'job:raw' }, { output: 'step:step1.output' }, ['threshold', 'mode']),
      ],
    };
    await expect(validateRecipe(recipe)).resolves.toBeUndefined();
  });

  it('resolves artifacts when externalInputs set covers referenced job inputs', async () => {
    withExecutors(SINGLE_IO);
    // The recipe references 'job:raw', pass it as externalInput
    await expect(
      validateRecipe(singleStepRecipe(), new Set(['job:raw'])),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Structural validation
// ---------------------------------------------------------------------------

describe('structural validation', () => {
  it('rejects a missing recipe key', async () => {
    const bad = {} as RecipeDefinition;
    await expect(validateRecipe(bad)).rejects.toThrow('must contain a "recipe" array');
  });

  it('rejects a non-array recipe value', async () => {
    const bad = { recipe: 'not-an-array' } as unknown as RecipeDefinition;
    await expect(validateRecipe(bad)).rejects.toThrow('must contain a "recipe" array');
  });

  it('rejects an empty recipe array', async () => {
    await expect(validateRecipe({ recipe: [] })).rejects.toThrow(
      'Recipe must contain at least one step',
    );
  });

  it('rejects duplicate step IDs', async () => {
    withExecutors(SINGLE_IO);
    const recipe: RecipeDefinition = {
      recipe: [
        makeStep('step1', 'single-io', { input: 'job:raw' }, { output: 'step:step1.output' }),
        makeStep('step1', 'single-io', { input: 'job:raw' }, { output: 'step:step1.dup' }),
      ],
    };
    await expect(validateRecipe(recipe)).rejects.toThrow('Duplicate step ID: step1');
  });

  it('rejects duplicate output artifact names across steps', async () => {
    withExecutors(SINGLE_IO);
    const recipe: RecipeDefinition = {
      recipe: [
        makeStep('step1', 'single-io', { input: 'job:raw' }, { output: 'step:shared.output' }),
        makeStep('step2', 'single-io', { input: 'job:raw' }, { output: 'step:shared.output' }),
      ],
    };
    await expect(validateRecipe(recipe)).rejects.toThrow('Duplicate output artifact "step:shared.output"');
  });

  it('rejects an unsupported step type', async () => {
    mockGetStepExecutors.mockResolvedValue(new Map()); // no executors registered
    const recipe: RecipeDefinition = {
      recipe: [makeStep('step1', 'unknown-type', { input: 'job:raw' }, { output: 'step:step1.output' })],
    };
    await expect(validateRecipe(recipe)).rejects.toThrow('Unsupported step type: unknown-type');
  });
});

// ---------------------------------------------------------------------------
// Step-level structural validation
// ---------------------------------------------------------------------------

describe('step-level validation', () => {
  it('rejects a step with legacy array outputs', async () => {
    const recipe = {
      recipe: [
        {
          id: 'step1',
          type: 'single-io',
          inputs: { input: 'job:raw' },
          outputs: ['step:step1.output'], // legacy array format
        },
      ],
    } as unknown as RecipeDefinition;
    await expect(validateRecipe(recipe)).rejects.toThrow('legacy array outputs format');
  });

  it('rejects a step with legacy required_params', async () => {
    const recipe = {
      recipe: [
        {
          id: 'step1',
          type: 'single-io',
          inputs: { input: 'job:raw' },
          outputs: { output: 'step:step1.output' },
          required_params: ['threshold'],
        },
      ],
    } as unknown as RecipeDefinition;
    await expect(validateRecipe(recipe)).rejects.toThrow('uses deprecated "required_params"');
  });

  it('rejects a step with concrete params embedded in the recipe', async () => {
    const recipe = {
      recipe: [
        {
          id: 'step1',
          type: 'single-io',
          inputs: { input: 'job:raw' },
          outputs: { output: 'step:step1.output' },
          params: { threshold: 0.5 },
        },
      ],
    } as unknown as RecipeDefinition;
    await expect(validateRecipe(recipe)).rejects.toThrow('must not contain "params"');
  });

  it('rejects a step missing its id', async () => {
    const recipe = {
      recipe: [{ type: 'single-io', inputs: { input: 'job:raw' }, outputs: { output: 'step:x.output' } }],
    } as unknown as RecipeDefinition;
    await expect(validateRecipe(recipe)).rejects.toThrow('must have a string "id"');
  });

  it('rejects a step missing its type', async () => {
    const recipe = {
      recipe: [{ id: 'step1', inputs: { input: 'job:raw' }, outputs: { output: 'step:step1.output' } }],
    } as unknown as RecipeDefinition;
    await expect(validateRecipe(recipe)).rejects.toThrow('must have a string "type"');
  });

  it('rejects a step with a non-object inputs field', async () => {
    const recipe = {
      recipe: [{ id: 'step1', type: 'single-io', inputs: ['job:raw'], outputs: { output: 'step:step1.output' } }],
    } as unknown as RecipeDefinition;
    await expect(validateRecipe(recipe)).rejects.toThrow('"inputs" object');
  });

  it('rejects a step with a non-object outputs field', async () => {
    const recipe = {
      recipe: [{ id: 'step1', type: 'single-io', inputs: { input: 'job:raw' }, outputs: 'step:step1.output' }],
    } as unknown as RecipeDefinition;
    await expect(validateRecipe(recipe)).rejects.toThrow('outputs must be a map');
  });
});

// ---------------------------------------------------------------------------
// Namespaced reference validation (within steps)
// ---------------------------------------------------------------------------

describe('namespaced reference validation in steps', () => {
  it('rejects an unqualified artifact reference in inputs', async () => {
    const recipe = {
      recipe: [
        {
          id: 'step1',
          type: 'single-io',
          inputs: { input: 'raw' },            // bare name — not namespaced
          outputs: { output: 'step:step1.output' },
        },
      ],
    } as unknown as RecipeDefinition;
    await expect(validateRecipe(recipe)).rejects.toThrow('unqualified artifact reference "raw"');
  });

  it('rejects an unqualified artifact name in outputs', async () => {
    const recipe = {
      recipe: [
        {
          id: 'step1',
          type: 'single-io',
          inputs: { input: 'job:raw' },
          outputs: { output: 'model' },        // bare name — not namespaced
        },
      ],
    } as unknown as RecipeDefinition;
    await expect(validateRecipe(recipe)).rejects.toThrow('unqualified artifact name "model"');
  });
});

// ---------------------------------------------------------------------------
// Slot binding validation (requires executor mock)
// ---------------------------------------------------------------------------

describe('slot binding validation', () => {
  it('rejects a step missing a required input slot', async () => {
    withExecutors(SINGLE_IO);
    // SINGLE_IO requires slot 'input', but recipe provides nothing
    const recipe: RecipeDefinition = {
      recipe: [makeStep('step1', 'single-io', {}, { output: 'step:step1.output' })],
    };
    await expect(validateRecipe(recipe)).rejects.toThrow(
      'Step "step1" missing required input slot: input',
    );
  });

  it('rejects a step providing an unknown input slot', async () => {
    withExecutors(SINGLE_IO);
    const recipe: RecipeDefinition = {
      recipe: [
        makeStep(
          'step1', 'single-io',
          { input: 'job:raw', extra: 'job:other' }, // 'extra' is not in SINGLE_IO accepts
          { output: 'step:step1.output' },
        ),
      ],
    };
    await expect(validateRecipe(recipe)).rejects.toThrow('Step "step1" has invalid input slot: extra');
  });

  it('rejects a step missing a required output slot', async () => {
    withExecutors(SINGLE_IO);
    // SINGLE_IO requires slot 'output', but recipe provides nothing
    const recipe: RecipeDefinition = {
      recipe: [makeStep('step1', 'single-io', { input: 'job:raw' }, {})],
    };
    await expect(validateRecipe(recipe)).rejects.toThrow(
      'Step "step1" missing required output slot: output',
    );
  });

  it('rejects a step declaring an unknown output slot', async () => {
    withExecutors(SINGLE_IO);
    const recipe: RecipeDefinition = {
      recipe: [
        makeStep(
          'step1', 'single-io',
          { input: 'job:raw' },
          { output: 'step:step1.output', extra: 'step:step1.extra' }, // 'extra' not in SINGLE_IO produces
        ),
      ],
    };
    await expect(validateRecipe(recipe)).rejects.toThrow('Step "step1" has invalid output slot: extra');
  });
});

// ---------------------------------------------------------------------------
// Artifact wiring
// ---------------------------------------------------------------------------

describe('artifact wiring', () => {
  it('resolves job-level input artifacts (job: namespace)', async () => {
    withExecutors(DOUBLE_IN);
    // Both inputs come from job-level
    await expect(validateRecipe(joinRecipe())).resolves.toBeUndefined();
  });

  it('resolves step-produced artifacts in downstream steps (step: namespace)', async () => {
    withExecutors(SINGLE_IO);
    // step2 consumes artifact produced by step1
    await expect(validateRecipe(linearChainRecipe())).resolves.toBeUndefined();
  });

  it('resolves artifacts across a multi-step chain (cross-step propagation)', async () => {
    withExecutors(SINGLE_IO);
    // step3 consumes step2's output, which consumes step1's output
    const recipe: RecipeDefinition = {
      recipe: [
        makeStep('step1', 'single-io', { input: 'job:raw' }, { output: 'step:step1.output' }),
        makeStep('step2', 'single-io', { input: 'step:step1.output' }, { output: 'step:step2.output' }),
        makeStep('step3', 'single-io', { input: 'step:step2.output' }, { output: 'step:step3.output' }),
      ],
    };
    await expect(validateRecipe(recipe)).resolves.toBeUndefined();
  });

  it('treats a step-namespaced artifact with no producer as an implicit external input (recipe-level)', async () => {
    // The recipe validator computes any artifact not produced by a step as an
    // "initial input" — it is implicitly valid at recipe validation time.
    // The error surfaces later at job creation when the caller must supply it.
    withExecutors(SINGLE_IO);
    const recipe: RecipeDefinition = {
      recipe: [
        makeStep(
          'step1', 'single-io',
          { input: 'step:nonexistent.output' }, // no step produces this → becomes external input
          { output: 'step:step1.output' },
        ),
      ],
    };
    await expect(validateRecipe(recipe)).resolves.toBeUndefined();
  });

  it('rejects a step referencing a downstream artifact (ordering violation)', async () => {
    withExecutors(SINGLE_IO);
    // step1 tries to consume step2's output, but step2 depends on step1 — cycle
    const recipe: RecipeDefinition = {
      recipe: [
        makeStep('step1', 'single-io', { input: 'step:step2.output' }, { output: 'step:step1.output' }),
        makeStep('step2', 'single-io', { input: 'step:step1.output' }, { output: 'step:step2.output' }),
      ],
    };
    await expect(validateRecipe(recipe)).rejects.toThrow('cycle');
  });
});

// ---------------------------------------------------------------------------
// param_keys validation
// ---------------------------------------------------------------------------

describe('param_keys validation', () => {
  it('rejects non-array param_keys', async () => {
    const recipe = {
      recipe: [
        {
          id: 'step1',
          type: 'single-io',
          inputs: { input: 'job:raw' },
          outputs: { output: 'step:step1.output' },
          param_keys: 'threshold', // should be array
        },
      ],
    } as unknown as RecipeDefinition;
    await expect(validateRecipe(recipe)).rejects.toThrow('param_keys must be an array');
  });

  it('rejects duplicate keys in param_keys', async () => {
    const recipe = {
      recipe: [
        {
          id: 'step1',
          type: 'single-io',
          inputs: { input: 'job:raw' },
          outputs: { output: 'step:step1.output' },
          param_keys: ['threshold', 'threshold'],
        },
      ],
    } as unknown as RecipeDefinition;
    await expect(validateRecipe(recipe)).rejects.toThrow('contains duplicate key: "threshold"');
  });

  it('rejects non-string entries in param_keys', async () => {
    const recipe = {
      recipe: [
        {
          id: 'step1',
          type: 'single-io',
          inputs: { input: 'job:raw' },
          outputs: { output: 'step:step1.output' },
          param_keys: [42],
        },
      ],
    } as unknown as RecipeDefinition;
    await expect(validateRecipe(recipe)).rejects.toThrow('param_keys must contain only strings');
  });
});

// ---------------------------------------------------------------------------
// max_concurrency validation
// ---------------------------------------------------------------------------

describe('max_concurrency validation', () => {
  it('accepts a step with a valid max_concurrency', async () => {
    withExecutors(SINGLE_IO);
    const recipe: RecipeDefinition = {
      recipe: [makeStep('step1', 'single-io', { input: 'job:raw' }, { output: 'step:step1.output' }, undefined, 3)],
    };
    await expect(validateRecipe(recipe)).resolves.toBeUndefined();
  });

  it('accepts max_concurrency of 1 (minimum valid value)', async () => {
    withExecutors(SINGLE_IO);
    const recipe: RecipeDefinition = {
      recipe: [makeStep('step1', 'single-io', { input: 'job:raw' }, { output: 'step:step1.output' }, undefined, 1)],
    };
    await expect(validateRecipe(recipe)).resolves.toBeUndefined();
  });

  it('accepts a step without max_concurrency (no regression)', async () => {
    withExecutors(SINGLE_IO);
    await expect(validateRecipe(singleStepRecipe())).resolves.toBeUndefined();
  });

  it('rejects max_concurrency of 0', async () => {
    const recipe = {
      recipe: [{
        id: 'step1', type: 'single-io',
        inputs: { input: 'job:raw' }, outputs: { output: 'step:step1.output' },
        max_concurrency: 0,
      }],
    } as unknown as RecipeDefinition;
    await expect(validateRecipe(recipe)).rejects.toThrow('positive integer');
  });

  it('rejects a negative max_concurrency', async () => {
    const recipe = {
      recipe: [{
        id: 'step1', type: 'single-io',
        inputs: { input: 'job:raw' }, outputs: { output: 'step:step1.output' },
        max_concurrency: -1,
      }],
    } as unknown as RecipeDefinition;
    await expect(validateRecipe(recipe)).rejects.toThrow('positive integer');
  });

  it('rejects a float max_concurrency', async () => {
    const recipe = {
      recipe: [{
        id: 'step1', type: 'single-io',
        inputs: { input: 'job:raw' }, outputs: { output: 'step:step1.output' },
        max_concurrency: 1.5,
      }],
    } as unknown as RecipeDefinition;
    await expect(validateRecipe(recipe)).rejects.toThrow('positive integer');
  });

  it('rejects a string max_concurrency (runtime guard)', async () => {
    const recipe = {
      recipe: [{
        id: 'step1', type: 'single-io',
        inputs: { input: 'job:raw' }, outputs: { output: 'step:step1.output' },
        max_concurrency: '3',
      }],
    } as unknown as RecipeDefinition;
    await expect(validateRecipe(recipe)).rejects.toThrow('positive integer');
  });
});

// ---------------------------------------------------------------------------
// on_exit hook validation
// ---------------------------------------------------------------------------

describe('on_exit', () => {
  /** Executor that accepts one metadata input and produces nothing */
  const ON_EXIT_EXEC = makeExecutor('on-exit-webhook', { metadata: 'json' }, {});

  it('passes when on_exit is absent', async () => {
    withExecutors(SINGLE_IO);
    await expect(validateRecipe(singleStepRecipe())).resolves.toBeUndefined();
  });

  it('rejects on_exit as an array', async () => {
    withExecutors(SINGLE_IO);
    const recipe = {
      recipe: [makeStep('step1', 'single-io', { input: 'job:raw' }, { output: 'step:step1.output' })],
      on_exit: [{ id: 'notify', type: 'on-exit-webhook', inputs: {} }],
    } as unknown as RecipeDefinition;
    await expect(validateRecipe(recipe)).rejects.toThrow('on_exit must be a single step object, not an array');
  });

  it('rejects on_exit with an outputs field', async () => {
    withExecutors(SINGLE_IO, ON_EXIT_EXEC);
    const recipe = {
      recipe: [makeStep('step1', 'single-io', { input: 'job:raw' }, { output: 'step:step1.output' })],
      on_exit: { id: 'notify', type: 'on-exit-webhook', inputs: {}, outputs: {} },
    } as unknown as RecipeDefinition;
    await expect(validateRecipe(recipe)).rejects.toThrow('on_exit step must not declare outputs');
  });

  it('rejects on_exit with a depends_on field', async () => {
    withExecutors(SINGLE_IO, ON_EXIT_EXEC);
    const recipe = {
      recipe: [makeStep('step1', 'single-io', { input: 'job:raw' }, { output: 'step:step1.output' })],
      on_exit: { id: 'notify', type: 'on-exit-webhook', inputs: {}, depends_on: ['step1'] },
    } as unknown as RecipeDefinition;
    await expect(validateRecipe(recipe)).rejects.toThrow('on_exit step must not declare depends_on');
  });

  it('rejects on_exit with an unknown type', async () => {
    withExecutors(SINGLE_IO);
    const recipe: RecipeDefinition = {
      recipe: [makeStep('step1', 'single-io', { input: 'job:raw' }, { output: 'step:step1.output' })],
      on_exit: { id: 'notify', type: 'unknown-webhook', inputs: {} },
    };
    await expect(validateRecipe(recipe)).rejects.toThrow('Unsupported step type: unknown-webhook');
  });

  it('rejects on_exit with an invalid input slot (not in executor accepts)', async () => {
    withExecutors(SINGLE_IO, ON_EXIT_EXEC);
    const recipe: RecipeDefinition = {
      recipe: [makeStep('step1', 'single-io', { input: 'job:raw' }, { output: 'step:step1.output' })],
      // metadata (required) is provided; bad_slot is extra and unknown
      on_exit: { id: 'notify', type: 'on-exit-webhook', inputs: { metadata: 'step:step1.output', bad_slot: 'step:step1.output' } },
    };
    await expect(validateRecipe(recipe)).rejects.toThrow('has invalid input slot: bad_slot');
  });

  it('rejects on_exit input referencing an artifact not in the DAG', async () => {
    withExecutors(SINGLE_IO, ON_EXIT_EXEC);
    const recipe: RecipeDefinition = {
      recipe: [makeStep('step1', 'single-io', { input: 'job:raw' }, { output: 'step:step1.output' })],
      on_exit: { id: 'notify', type: 'on-exit-webhook', inputs: { metadata: 'step:nonexistent.output' } },
    };
    await expect(validateRecipe(recipe)).rejects.toThrow('on_exit step input references unavailable artifact: step:nonexistent.output');
  });

  it('accepts on_exit referencing a step output that exists in the DAG', async () => {
    withExecutors(SINGLE_IO, ON_EXIT_EXEC);
    const recipe: RecipeDefinition = {
      recipe: [makeStep('step1', 'single-io', { input: 'job:raw' }, { output: 'step:step1.output' })],
      on_exit: { id: 'notify', type: 'on-exit-webhook', inputs: { metadata: 'step:step1.output' } },
    };
    await expect(validateRecipe(recipe)).resolves.toBeUndefined();
  });

  it('accepts on_exit with no inputs when executor accepts none', async () => {
    withExecutors(NO_INPUT);
    const recipe: RecipeDefinition = {
      recipe: [makeStep('gen', 'no-input', {}, { out: 'step:gen.out' })],
      on_exit: { id: 'notify', type: 'no-input', inputs: {} },
    };
    await expect(validateRecipe(recipe)).resolves.toBeUndefined();
  });

  it('accepts on_exit with valid param_keys', async () => {
    withExecutors(SINGLE_IO, ON_EXIT_EXEC);
    const recipe: RecipeDefinition = {
      recipe: [makeStep('step1', 'single-io', { input: 'job:raw' }, { output: 'step:step1.output' })],
      on_exit: {
        id: 'notify',
        type: 'on-exit-webhook',
        inputs: { metadata: 'step:step1.output' },
        param_keys: ['webhook_url', 'secret'],
      },
    };
    await expect(validateRecipe(recipe)).resolves.toBeUndefined();
  });
});
