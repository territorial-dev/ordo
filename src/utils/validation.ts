import { RecipeDefinition, StepDefinition } from "../types";

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export const validateRecipe = (definition: RecipeDefinition): void => {
  if (!definition.recipe || !Array.isArray(definition.recipe)) {
    throw new ValidationError(
      'Recipe definition must contain a "recipe" array'
    );
  }

  if (definition.recipe.length === 0) {
    throw new ValidationError("Recipe must contain at least one step");
  }

  const stepIds = new Set<string>();
  const artifactOutputs = new Set<string>();
  const allArtifacts = new Set<string>();

  // First pass: collect all step IDs and outputs
  for (const step of definition.recipe) {
    validateStep(step);

    if (stepIds.has(step.id)) {
      throw new ValidationError(`Duplicate step ID: ${step.id}`);
    }
    stepIds.add(step.id);

    for (const output of step.outputs) {
      if (artifactOutputs.has(output)) {
        throw new ValidationError(`Duplicate artifact output: ${output}`);
      }
      artifactOutputs.add(output);
      allArtifacts.add(output);
    }

    for (const input of step.inputs) {
      allArtifacts.add(input);
    }
  }

  // Second pass: validate all inputs are resolvable
  for (const step of definition.recipe) {
    for (const input of step.inputs) {
      if (!allArtifacts.has(input)) {
        throw new ValidationError(
          `Input artifact "${input}" in step "${step.id}" is not produced by any step`
        );
      }
    }
  }

  // Check for cycles (DFS with recursion stack)
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
      for (const input of step.inputs) {
        const producerStep = findProducerStep(input, definition.recipe);
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

  if (!Array.isArray(step.inputs)) {
    throw new ValidationError('Step must have an "inputs" array');
  }

  if (!Array.isArray(step.outputs)) {
    throw new ValidationError('Step must have an "outputs" array');
  }

  if (step.outputs.length === 0) {
    throw new ValidationError(
      `Step "${step.id}" must have at least one output`
    );
  }

  if (step.inputs.some((i) => typeof i !== "string")) {
    throw new ValidationError("Step inputs must be strings");
  }

  if (step.outputs.some((o) => typeof o !== "string")) {
    throw new ValidationError("Step outputs must be strings");
  }

  if (typeof step.params !== "object" || step.params === null) {
    throw new ValidationError('Step must have a "params" object');
  }
};

const findProducerStep = (
  artifactName: string,
  steps: StepDefinition[]
): StepDefinition | undefined => {
  return steps.find((step) => step.outputs.includes(artifactName));
};
