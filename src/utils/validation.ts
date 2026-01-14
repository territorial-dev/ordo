import { RecipeDefinition, StepDefinition, StepExecutor } from "../types";
import { getStepExecutors } from "../services/stepExecutorService";

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export const validateRecipe = async (
  definition: RecipeDefinition,
  externalInputs: Set<string> = new Set()
): Promise<void> => {
  // Structural validation
  if (!definition.recipe || !Array.isArray(definition.recipe)) {
    throw new ValidationError(
      'Recipe definition must contain a "recipe" array'
    );
  }

  if (definition.recipe.length === 0) {
    throw new ValidationError("Recipe must contain at least one step");
  }

  const stepIds = new Set<string>();

  // First pass: structural validation and collect step types
  for (const step of definition.recipe) {
    validateStep(step);

    if (stepIds.has(step.id)) {
      throw new ValidationError(`Duplicate step ID: ${step.id}`);
    }
    stepIds.add(step.id);
  }

  // Collect all unique step types
  const stepTypes = Array.from(new Set(definition.recipe.map((s) => s.type)));

  // Query all step executors in one batch
  const executorMap = await getStepExecutors(stepTypes);

  // Rule 1: Step type must exist in step_executor
  for (const step of definition.recipe) {
    const executor = executorMap.get(step.type);
    if (!executor) {
      throw new ValidationError(`Unsupported step type: ${step.type}`);
    }
  }

  // Identify initial inputs (artifact names not produced by any step)
  // These are external inputs that will be provided at job creation
  const allOutputs = new Set<string>();
  for (const step of definition.recipe) {
    for (const output of step.outputs) {
      allOutputs.add(output);
    }
  }

  // Collect all artifact names referenced in inputs
  const allArtifactNames = new Set<string>();
  for (const step of definition.recipe) {
    for (const artifactName of Object.values(step.inputs)) {
      allArtifactNames.add(artifactName);
    }
  }

  // Initial inputs are artifact names that are referenced but not produced by any step
  const initialInputs = new Set<string>();
  for (const artifactName of allArtifactNames) {
    if (!allOutputs.has(artifactName)) {
      initialInputs.add(artifactName);
    }
  }

  // Merge provided external inputs with identified initial inputs
  // (externalInputs parameter allows job creation to specify which inputs are provided)
  const availableArtifacts = new Set<string>([
    ...externalInputs,
    ...initialInputs,
  ]);

  // Topological sort to validate in dependency order
  const sortedSteps = topologicalSort(definition.recipe);

  // Validate each step in dependency order
  for (const step of sortedSteps) {
    const executor = executorMap.get(step.type)!;

    // Rule 2: Inputs must match executor accepts (slot binding validation)
    validateInputsMatchAccepts(step, executor);

    // Rule 3: Outputs must match executor produces
    validateOutputsMatchProduces(step, executor);

    // Rule 4: Artifact flow validation - all referenced artifacts must be available
    for (const artifactName of Object.values(step.inputs)) {
      if (!availableArtifacts.has(artifactName)) {
        throw new ValidationError(`Unresolved input artifact: ${artifactName}`);
      }
    }

    // Add outputs to available artifacts after validation
    for (const output of step.outputs) {
      availableArtifacts.add(output);
    }
  }

  // Check for cycles (additional safety check)
  const visited = new Set<string>();
  const hasCycle = (stepId: string, recStack: Set<string>): boolean => {
    if (recStack.has(stepId)) {
      return true;
    }
    if (visited.has(stepId)) {
      return false;
    }

    visited.add(stepId);
    recStack.add(stepId);

    const step = definition.recipe.find((s) => s.id === stepId);
    if (step) {
      for (const artifactName of Object.values(step.inputs)) {
        const producerStep = findProducerStep(artifactName, definition.recipe);
        if (producerStep && hasCycle(producerStep.id, recStack)) {
          return true;
        }
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
};

const validateStep = (step: StepDefinition): void => {
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

  if (!Array.isArray(step.outputs)) {
    throw new ValidationError('Step must have an "outputs" array');
  }

  if (step.outputs.length === 0) {
    throw new ValidationError(
      `Step "${step.id}" must have at least one output`
    );
  }

  // Validate inputs object structure
  for (const [slot, artifact] of Object.entries(step.inputs)) {
    if (typeof slot !== "string" || typeof artifact !== "string") {
      throw new ValidationError(
        `Step "${step.id}" inputs must be a mapping of slot names (strings) to artifact names (strings)`
      );
    }
  }

  if (step.outputs.some((o) => typeof o !== "string")) {
    throw new ValidationError("Step outputs must be strings");
  }

  if (typeof step.params !== "object" || step.params === null) {
    throw new ValidationError('Step must have a "params" object');
  }
};

const validateInputsMatchAccepts = (
  step: StepDefinition,
  executor: StepExecutor
): void => {
  const acceptsKeys = new Set(Object.keys(executor.accepts));
  const stepInputSlots = new Set(Object.keys(step.inputs));

  // Check for missing inputs (executor requires but step doesn't bind)
  for (const requiredSlot of acceptsKeys) {
    if (!stepInputSlots.has(requiredSlot)) {
      throw new ValidationError(
        `Step "${step.id}" missing required input slot: ${requiredSlot}`
      );
    }
  }

  // Check for extra inputs (step binds but executor doesn't accept)
  for (const providedSlot of stepInputSlots) {
    if (!acceptsKeys.has(providedSlot)) {
      throw new ValidationError(
        `Step "${
          step.id
        }" has invalid input slot: ${providedSlot}. Accepted slots: ${Array.from(
          acceptsKeys
        ).join(", ")}`
      );
    }
  }
};

const validateOutputsMatchProduces = (
  step: StepDefinition,
  executor: StepExecutor
): void => {
  const producesKeys = new Set(Object.keys(executor.produces));
  const stepOutputs = new Set(step.outputs);

  // Check for missing outputs (executor produces but step doesn't declare)
  for (const requiredOutput of producesKeys) {
    if (!stepOutputs.has(requiredOutput)) {
      throw new ValidationError(
        `Step "${step.id}" missing required output: ${requiredOutput}`
      );
    }
  }

  // Check for extra outputs (step declares but executor doesn't produce)
  for (const declaredOutput of stepOutputs) {
    if (!producesKeys.has(declaredOutput)) {
      throw new ValidationError(
        `Step "${
          step.id
        }" has invalid output: ${declaredOutput}. Produced outputs: ${Array.from(
          producesKeys
        ).join(", ")}`
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
    if (visited.has(step.id)) {
      return;
    }

    visiting.add(step.id);

    // Visit dependencies first (based on artifact names, not slots)
    for (const artifactName of Object.values(step.inputs)) {
      const producerStep = findProducerStep(artifactName, steps);
      if (producerStep) {
        visit(producerStep);
      }
    }

    visiting.delete(step.id);
    visited.add(step.id);
    sorted.push(step);
  };

  for (const step of steps) {
    if (!visited.has(step.id)) {
      visit(step);
    }
  }

  return sorted;
};

const findProducerStep = (
  artifactName: string,
  steps: StepDefinition[]
): StepDefinition | undefined => {
  return steps.find((step) => step.outputs.includes(artifactName));
};
