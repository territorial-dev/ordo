import { RecipeDefinition, StepDefinition, StepDefinitionV2, StepExecutor } from "../types";
import { getStepExecutors } from "../services/stepExecutorService";

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

// -- v2 schema helpers --------------------------------------------------------

/** Returns true when a step uses the new schema (outputs is a Record, not an array). */
export const isNewSchemaStep = (step: unknown): step is StepDefinitionV2 => {
  if (step === null || typeof step !== "object") return false;
  const s = step as Record<string, unknown>;
  return (
    "outputs" in s &&
    !Array.isArray(s.outputs) &&
    typeof s.outputs === "object" &&
    s.outputs !== null
  );
};

/**
 * Returns true when ref is a valid namespaced artifact reference:
 *   job:<name>           – a top-level job artifact
 *   step:<stepId>.<slot> – the output slot of a specific step
 */
const NAMESPACED_REF_RE =
  /^(job:[A-Za-z0-9_-]+|step:[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/;

export const isNamespacedRef = (ref: string): boolean =>
  NAMESPACED_REF_RE.test(ref);

/** Normalises step outputs to a flat list of artifact names for flow analysis. */
const getOutputArtifactNames = (
  step: StepDefinition | StepDefinitionV2
): string[] => {
  if (Array.isArray(step.outputs)) {
    return step.outputs as string[];
  }
  return Object.values(step.outputs as Record<string, string>);
};

const validateStepV2 = (step: StepDefinitionV2): void => {
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
      `Step "${step.id}" outputs must be a map of slot names to artifact names (Record<string, string>)`
    );
  }
  // Validate inputs entries
  for (const [slot, artifact] of Object.entries(step.inputs)) {
    if (typeof slot !== "string" || typeof artifact !== "string") {
      throw new ValidationError(
        `Step "${step.id}" inputs must map slot names (strings) to artifact names (strings)`
      );
    }
  }
  // Validate outputs entries
  for (const [slot, artifact] of Object.entries(
    step.outputs as Record<string, string>
  )) {
    if (typeof slot !== "string") {
      throw new ValidationError(
        `Step "${step.id}" output slot names must be strings`
      );
    }
    if (typeof artifact !== "string") {
      throw new ValidationError(
        `Step "${step.id}" output artifact names must be strings (slot "${slot}")`
      );
    }
  }
  // Forbid concrete params
  if ("params" in step && (step as any).params !== undefined) {
    throw new ValidationError(
      'Step must not contain "params" (concrete values). Use "param_keys" to declare required parameters.'
    );
  }
  // param_keys: must be an array of unique strings if present
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
};

// -- main validate function ---------------------------------------------------

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
  const outputArtifacts = new Map<string, string>(); // artifact name -> step id

  // First pass: structural validation and collect step types
  for (const step of definition.recipe) {
    const anyStep = step as StepDefinition | StepDefinitionV2;
    if (isNewSchemaStep(anyStep)) {
      validateStepV2(anyStep);
    } else {
      validateStep(step);
    }

    if (stepIds.has(step.id)) {
      throw new ValidationError(`Duplicate step ID: ${step.id}`);
    }
    stepIds.add(step.id);

    // Check for duplicate output artifacts
    for (const output of getOutputArtifactNames(anyStep)) {
      if (outputArtifacts.has(output)) {
        const producerStepId = outputArtifacts.get(output)!;
        throw new ValidationError(
          `Duplicate output artifact "${output}": produced by both step "${producerStepId}" and step "${step.id}". Each artifact name must be unique.`
        );
      }
      outputArtifacts.set(output, step.id);
    }
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
    for (const output of getOutputArtifactNames(step as StepDefinition | StepDefinitionV2)) {
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
  const sortedSteps = topologicalSort(
    definition.recipe as Array<StepDefinition | StepDefinitionV2>
  );

  // Validate each step in dependency order
  for (const step of sortedSteps) {
    const executor = executorMap.get(step.type)!;

    // Rule 2: Inputs must match executor accepts (slot binding validation)
    validateInputsMatchAccepts(step, executor);

    // Rule 3: Outputs must match executor produces
    if (isNewSchemaStep(step)) {
      validateOutputsMatchProducesV2(step, executor);
    } else {
      validateOutputsMatchProduces(step as StepDefinition, executor);
    }

    // Rule 4: Artifact flow validation - all referenced artifacts must be available
    for (const artifactName of Object.values(step.inputs)) {
      if (!availableArtifacts.has(artifactName)) {
        throw new ValidationError(`Unresolved input artifact: ${artifactName}`);
      }
    }

    // Add outputs to available artifacts after validation
    for (const output of getOutputArtifactNames(step)) {
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
        const producerStep = findProducerStep(
          artifactName,
          definition.recipe as Array<StepDefinition | StepDefinitionV2>
        );
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
      'Step must have an "inputs" object (slot -> artifact mapping)',
    );
  }

  if (!Array.isArray(step.outputs)) {
    throw new ValidationError('Step must have an "outputs" array');
  }

  // Validate inputs object structure
  for (const [slot, artifact] of Object.entries(step.inputs)) {
    if (typeof slot !== "string" || typeof artifact !== "string") {
      throw new ValidationError(
        `Step "${step.id}" inputs must be a mapping of slot names (strings) to artifact names (strings)`,
      );
    }
  }

  if (step.outputs.some((o) => typeof o !== "string")) {
    throw new ValidationError("Step outputs must be strings");
  }

  // Parameter values are not part of recipe identity and do not affect recipe versioning.
  // Steps declare required params only via required_params; concrete values are provided at job creation.
  if ("params" in step && step.params !== undefined) {
    throw new ValidationError(
      'Step must not contain "params" (concrete values). Use "required_params" (array of param names) to declare required parameters.',
    );
  }
  if (step.required_params !== undefined) {
    if (!Array.isArray(step.required_params)) {
      throw new ValidationError(
        'Step "required_params" must be an array of strings',
      );
    }
    for (const p of step.required_params) {
      if (typeof p !== "string") {
        throw new ValidationError(
          'Step "required_params" must contain only strings',
        );
      }
    }
  }
};;

const validateInputsMatchAccepts = (
  step: StepDefinition | StepDefinitionV2,
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

const validateOutputsMatchProducesV2 = (
  step: StepDefinitionV2,
  executor: StepExecutor
): void => {
  const producesKeys = new Set(Object.keys(executor.produces));
  const stepOutputSlots = new Set(Object.keys(step.outputs));

  // Check for missing output slots (executor produces but step doesn't map)
  for (const requiredSlot of producesKeys) {
    if (!stepOutputSlots.has(requiredSlot)) {
      throw new ValidationError(
        `Step "${step.id}" missing required output slot: ${requiredSlot}`
      );
    }
  }

  // Check for extra output slots (step maps but executor doesn't produce)
  for (const declaredSlot of stepOutputSlots) {
    if (!producesKeys.has(declaredSlot)) {
      throw new ValidationError(
        `Step "${
          step.id
        }" has invalid output slot: ${declaredSlot}. Produced slots: ${Array.from(
          producesKeys
        ).join(", ")}`
      );
    }
  }
};

const topologicalSort = (
  steps: Array<StepDefinition | StepDefinitionV2>
): Array<StepDefinition | StepDefinitionV2> => {
  const sorted: Array<StepDefinition | StepDefinitionV2> = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();

  const visit = (step: StepDefinition | StepDefinitionV2): void => {
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
  steps: Array<StepDefinition | StepDefinitionV2>
): StepDefinition | StepDefinitionV2 | undefined => {
  return steps.find((step) =>
    getOutputArtifactNames(step).includes(artifactName)
  );
};
