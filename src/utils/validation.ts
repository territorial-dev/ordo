import { OnExitStep, RecipeDefinition, StepDefinition, StepExecutor } from "../types";
import { getStepExecutors } from "../services/stepExecutorService";

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

/**
 * Returns true when ref is a valid namespaced artifact reference:
 *   job:<name>           – a job-level input artifact
 *   step:<stepId>.<slot> – an artifact produced by a specific step's output slot
 */
export const isNamespacedRef = (ref: string): boolean =>
  /^(job:[A-Za-z0-9_-]+|step:[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.test(ref);

export const validateRecipe = async (
  definition: RecipeDefinition,
  externalInputs: Set<string> = new Set()
): Promise<void> => {
  if (!definition.recipe || !Array.isArray(definition.recipe)) {
    throw new ValidationError(
      'Recipe definition must contain a "recipe" array'
    );
  }

  if (definition.recipe.length === 0) {
    throw new ValidationError("Recipe must contain at least one step");
  }

  const stepIds = new Set<string>();
  const outputArtifacts = new Map<string, string>(); // artifact name -> step id

  // First pass: structural validation and duplicate checks
  for (const step of definition.recipe) {
    validateStep(step);

    if (stepIds.has(step.id)) {
      throw new ValidationError(`Duplicate step ID: ${step.id}`);
    }
    stepIds.add(step.id);

    for (const artifactName of Object.values(step.outputs)) {
      if (outputArtifacts.has(artifactName)) {
        const producerStepId = outputArtifacts.get(artifactName)!;
        throw new ValidationError(
          `Duplicate output artifact "${artifactName}": produced by both step "${producerStepId}" and step "${step.id}". Each artifact name must be unique.`
        );
      }
      outputArtifacts.set(artifactName, step.id);
    }
  }

  // Collect all unique step types (including on_exit if present) and batch-fetch executors
  const stepTypeSet = new Set(definition.recipe.map((s) => s.type));
  if (definition.on_exit?.type) stepTypeSet.add(definition.on_exit.type);
  const stepTypes = Array.from(stepTypeSet);
  const executorMap = await getStepExecutors(stepTypes);

  // Rule 1: Step type must exist in step_executor
  for (const step of definition.recipe) {
    if (!executorMap.get(step.type)) {
      throw new ValidationError(`Unsupported step type: ${step.type}`);
    }
  }

  // Identify initial inputs: artifact names referenced in inputs but produced by no step
  const allOutputArtifacts = new Set<string>();
  for (const step of definition.recipe) {
    for (const artifactName of Object.values(step.outputs)) {
      allOutputArtifacts.add(artifactName);
    }
  }

  const initialInputs = new Set<string>();
  for (const step of definition.recipe) {
    for (const artifactName of Object.values(step.inputs)) {
      if (!allOutputArtifacts.has(artifactName)) {
        initialInputs.add(artifactName);
      }
    }
  }

  const availableArtifacts = new Set<string>([
    ...externalInputs,
    ...initialInputs,
  ]);

  // Topological sort, then validate each step in dependency order
  const sortedSteps = topologicalSort(definition.recipe);

  for (const step of sortedSteps) {
    const executor = executorMap.get(step.type)!;

    // Rule 2: Input slots must match executor accepts exactly
    validateInputsMatchAccepts(step, executor);

    // Rule 3: Output slots must match executor produces exactly
    validateOutputsMatchProduces(step, executor);

    // Rule 4: All referenced input artifacts must be available
    for (const artifactName of Object.values(step.inputs)) {
      if (!availableArtifacts.has(artifactName)) {
        throw new ValidationError(`Unresolved input artifact: ${artifactName}`);
      }
    }

    for (const artifactName of Object.values(step.outputs)) {
      availableArtifacts.add(artifactName);
    }
  }

  // Cycle detection (redundant with topo sort but kept as a safety net)
  const visited = new Set<string>();
  const hasCycle = (stepId: string, recStack: Set<string>): boolean => {
    if (recStack.has(stepId)) return true;
    if (visited.has(stepId)) return false;

    visited.add(stepId);
    recStack.add(stepId);

    const step = definition.recipe.find((s) => s.id === stepId);
    if (step) {
      for (const artifactName of Object.values(step.inputs)) {
        const producerStep = findProducerStep(artifactName, definition.recipe);
        if (producerStep && hasCycle(producerStep.id, recStack)) return true;
      }
    }

    recStack.delete(stepId);
    return false;
  };

  for (const step of definition.recipe) {
    if (!visited.has(step.id)) {
      if (hasCycle(step.id, new Set<string>())) {
        throw new ValidationError("Recipe contains a cycle");
      }
    }
  }

  // Validate on_exit hook if present
  if (definition.on_exit) {
    validateOnExitStep(definition.on_exit);

    const onExitExecutor = executorMap.get(definition.on_exit.type);
    if (!onExitExecutor) {
      throw new ValidationError(`Unsupported step type: ${definition.on_exit.type}`);
    }

    validateInputsMatchAccepts(
      definition.on_exit as unknown as StepDefinition,
      onExitExecutor,
    );

    for (const artifactName of Object.values(definition.on_exit.inputs)) {
      if (!availableArtifacts.has(artifactName)) {
        throw new ValidationError(
          `on_exit step input references unavailable artifact: ${artifactName}`,
        );
      }
    }
  }
};

const validateStep = (step: StepDefinition): void => {
  // Detect legacy array outputs and give a clear migration error
  if (Array.isArray((step as any).outputs)) {
    const stepId = step.id ?? "(unknown)";
    throw new ValidationError(
      `Step "${stepId}" uses the legacy array outputs format. ` +
      `Migrate to a typed map: "outputs": { "slot_name": "step:${stepId}.slot_name" }. ` +
      `Each key is an executor output slot; each value is the artifact name for that slot.`
    );
  }

  if (!step.id || typeof step.id !== "string") {
    throw new ValidationError('Step must have a string "id"');
  }

  if (!step.type || typeof step.type !== "string") {
    throw new ValidationError('Step must have a string "type"');
  }

  if (
    typeof step.inputs !== "object" ||
    step.inputs === null ||
    Array.isArray(step.inputs)
  ) {
    throw new ValidationError(
      'Step must have an "inputs" object (slot -> artifact mapping)'
    );
  }

  if (
    typeof step.outputs !== "object" ||
    step.outputs === null ||
    Array.isArray(step.outputs)
  ) {
    throw new ValidationError(
      `Step "${step.id}" outputs must be a map of slot names to artifact names: ` +
      `"outputs": { "slot_name": "step:${step.id}.slot_name" }`
    );
  }

  // Detect legacy required_params
  if ("required_params" in step && (step as any).required_params !== undefined) {
    throw new ValidationError(
      `Step "${step.id}" uses deprecated "required_params". ` +
      `Rename it to "param_keys". No other changes are needed for this field.`
    );
  }

  // Forbid concrete params inside the recipe
  if ("params" in step && (step as any).params !== undefined) {
    throw new ValidationError(
      `Step "${step.id}" must not contain "params" (concrete values). ` +
      `Use "param_keys" to declare required parameter names; supply concrete values at job creation.`
    );
  }

  // Validate inputs: slot and artifact names, and namespaced refs
  for (const [slot, artifact] of Object.entries(step.inputs)) {
    if (typeof slot !== "string" || typeof artifact !== "string") {
      throw new ValidationError(
        `Step "${step.id}" inputs must map slot names (strings) to artifact names (strings)`
      );
    }
    if (!isNamespacedRef(artifact)) {
      throw new ValidationError(
        `Step "${step.id}" input slot "${slot}" has unqualified artifact reference "${artifact}". ` +
        `Use "job:<name>" for job-level inputs or "step:<stepId>.<slot>" for step outputs. ` +
        `Example: "job:${artifact}" or "step:<producer_step_id>.${slot}"`
      );
    }
  }

  // Validate outputs: slot and artifact names, and namespaced refs
  for (const [slot, artifact] of Object.entries(step.outputs)) {
    if (typeof slot !== "string" || typeof artifact !== "string") {
      throw new ValidationError(
        `Step "${step.id}" outputs must map slot names (strings) to artifact names (strings)`
      );
    }
    if (!isNamespacedRef(artifact)) {
      throw new ValidationError(
        `Step "${step.id}" output slot "${slot}" has unqualified artifact name "${artifact}". ` +
        `Use the "step:<stepId>.<slot>" format: "step:${step.id}.${slot}"`
      );
    }
  }

  // Validate param_keys: must be an array of unique strings
  if (step.param_keys !== undefined) {
    if (!Array.isArray(step.param_keys)) {
      throw new ValidationError(
        `Step "${step.id}" param_keys must be an array of strings`
      );
    }
    const seen = new Set<string>();
    for (const k of step.param_keys) {
      if (typeof k !== "string") {
        throw new ValidationError(
          `Step "${step.id}" param_keys must contain only strings`
        );
      }
      if (seen.has(k)) {
        throw new ValidationError(
          `Step "${step.id}" param_keys contains duplicate key: "${k}"`
        );
      }
      seen.add(k);
    }
  }

  if (step.max_concurrency !== undefined) {
    if (
      typeof step.max_concurrency !== 'number' ||
      !Number.isInteger(step.max_concurrency) ||
      step.max_concurrency < 1
    ) {
      throw new ValidationError(
        `Step "${step.id}" max_concurrency must be a positive integer (>= 1)`
      );
    }
  }
};

const validateOnExitStep = (step: OnExitStep | any): void => {
  if (Array.isArray(step)) {
    throw new ValidationError(
      "on_exit must be a single step object, not an array",
    );
  }

  if (!step.id || typeof step.id !== "string") {
    throw new ValidationError('on_exit step must have a string "id"');
  }

  if (!step.type || typeof step.type !== "string") {
    throw new ValidationError('on_exit step must have a string "type"');
  }

  if (
    typeof step.inputs !== "object" ||
    step.inputs === null ||
    Array.isArray(step.inputs)
  ) {
    throw new ValidationError(
      'on_exit step must have an "inputs" object (slot -> artifact mapping)',
    );
  }

  if ("outputs" in step && step.outputs !== undefined) {
    throw new ValidationError("on_exit step must not declare outputs");
  }

  if ("depends_on" in step && step.depends_on !== undefined) {
    throw new ValidationError("on_exit step must not declare depends_on");
  }

  for (const [slot, artifact] of Object.entries(step.inputs)) {
    if (typeof slot !== "string" || typeof artifact !== "string") {
      throw new ValidationError(
        `on_exit step inputs must map slot names (strings) to artifact names (strings)`,
      );
    }
    if (!isNamespacedRef(artifact as string)) {
      throw new ValidationError(
        `on_exit step input slot "${slot}" has unqualified artifact reference "${artifact}". ` +
        `Use "job:<name>" for job-level inputs or "step:<stepId>.<slot>" for step outputs.`,
      );
    }
  }

  if (step.param_keys !== undefined) {
    if (!Array.isArray(step.param_keys)) {
      throw new ValidationError(
        "on_exit step param_keys must be an array of strings",
      );
    }
    const seen = new Set<string>();
    for (const k of step.param_keys) {
      if (typeof k !== "string") {
        throw new ValidationError(
          "on_exit step param_keys must contain only strings",
        );
      }
      if (seen.has(k)) {
        throw new ValidationError(
          `on_exit step param_keys contains duplicate key: "${k}"`,
        );
      }
      seen.add(k);
    }
  }
};

const validateInputsMatchAccepts = (
  step: StepDefinition,
  executor: StepExecutor
): void => {
  const acceptsKeys = new Set(Object.keys(executor.accepts));
  const stepInputSlots = new Set(Object.keys(step.inputs));

  for (const requiredSlot of acceptsKeys) {
    if (!stepInputSlots.has(requiredSlot)) {
      throw new ValidationError(
        `Step "${step.id}" missing required input slot: ${requiredSlot}`
      );
    }
  }

  for (const providedSlot of stepInputSlots) {
    if (!acceptsKeys.has(providedSlot)) {
      throw new ValidationError(
        `Step "${step.id}" has invalid input slot: ${providedSlot}. ` +
        `Accepted slots: ${Array.from(acceptsKeys).join(", ")}`
      );
    }
  }
};

const validateOutputsMatchProduces = (
  step: StepDefinition,
  executor: StepExecutor
): void => {
  const producesKeys = new Set(Object.keys(executor.produces));
  const stepOutputSlots = new Set(Object.keys(step.outputs));

  for (const requiredSlot of producesKeys) {
    if (!stepOutputSlots.has(requiredSlot)) {
      throw new ValidationError(
        `Step "${step.id}" missing required output slot: ${requiredSlot}`
      );
    }
  }

  for (const declaredSlot of stepOutputSlots) {
    if (!producesKeys.has(declaredSlot)) {
      throw new ValidationError(
        `Step "${step.id}" has invalid output slot: ${declaredSlot}. ` +
        `Produced slots: ${Array.from(producesKeys).join(", ")}`
      );
    }
  }
};

const topologicalSort = (steps: StepDefinition[]): StepDefinition[] => {
  const sorted: StepDefinition[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();

  const visit = (step: StepDefinition): void => {
    if (visiting.has(step.id)) {
      throw new ValidationError("Recipe contains a cycle");
    }
    if (visited.has(step.id)) return;

    visiting.add(step.id);

    for (const artifactName of Object.values(step.inputs)) {
      const producerStep = findProducerStep(artifactName, steps);
      if (producerStep) visit(producerStep);
    }

    visiting.delete(step.id);
    visited.add(step.id);
    sorted.push(step);
  };

  for (const step of steps) {
    if (!visited.has(step.id)) visit(step);
  }

  return sorted;
};

const findProducerStep = (
  artifactName: string,
  steps: StepDefinition[]
): StepDefinition | undefined => {
  return steps.find((step) => Object.values(step.outputs).includes(artifactName));
};
