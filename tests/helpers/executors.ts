import { StepExecutor } from '../../src/types';

export function makeExecutor(
  stepType: string,
  accepts: Record<string, string>,
  produces: Record<string, string>,
): StepExecutor {
  return {
    step_type: stepType,
    n8n_workflow: `wf-${stepType}`,
    accepts,
    produces,
  };
}

export function executorMap(...execs: StepExecutor[]): Map<string, StepExecutor> {
  return new Map(execs.map((e) => [e.step_type, e]));
}

/** A step that accepts one input and produces one output */
export const SINGLE_IO = makeExecutor(
  'single-io',
  { input: 'pointcloud' },
  { output: 'model' },
);

/** A step that accepts two inputs and produces one output */
export const DOUBLE_IN = makeExecutor(
  'double-in',
  { a: 'pointcloud', b: 'model' },
  { result: 'report' },
);

/** A step that produces output without any input */
export const NO_INPUT = makeExecutor('no-input', {}, { out: 'data' });

/** A step that consumes input without producing output */
export const NO_OUTPUT = makeExecutor('no-output', { in: 'data' }, {});
