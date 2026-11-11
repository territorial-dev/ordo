import { StepDefinition } from "../types";

/**
 * Delivery of a job's declared outputs by the runner, at the end of the step that produces them.
 *
 * A job declares outputs (`job_output`: artifact name -> destination path). The claim tells the
 * runner which of them the claimed step produces (`deliver`); the runner copies each one to its
 * path before calling `complete`, and reports where it wrote it (`delivered`, keyed by output
 * slot). Ordo records that as `job_output.delivered_uri`. Storage stays the runner's job.
 */

export interface Deliverable {
  /** The step's output slot that produces the artifact. */
  slot: string;
  /** The artifact's name in the recipe (`step:<id>.<slot>`), as declared in the job's outputs. */
  artifact_name: string;
  /** The requested destination (a directory). */
  path: string;
}

/** The job's declared outputs that this step produces, in the step's slot order. */
export const deliverablesForStep = (
  def: StepDefinition,
  outputs: ReadonlyArray<{ artifact_name: string; path: string }>,
): Deliverable[] => {
  const pathByName = new Map(outputs.map((o) => [o.artifact_name, o.path]));
  const result: Deliverable[] = [];
  for (const [slot, artifactName] of Object.entries(def.outputs ?? {})) {
    const path = pathByName.get(artifactName);
    if (path !== undefined) result.push({ slot, artifact_name: artifactName, path });
  }
  return result;
};

/**
 * Checks a `delivered` object from `complete`: optional; when present, an object keyed by
 * deliverable slots of the step, each value a non-empty string (where the runner wrote it).
 * Returns the error message, or null when valid.
 */
export const checkDelivered = (
  delivered: unknown,
  deliverables: ReadonlyArray<Deliverable>,
): string | null => {
  if (delivered === undefined || delivered === null) return null;
  if (typeof delivered !== "object" || Array.isArray(delivered)) {
    return "delivered must be an object keyed by output slot";
  }
  const slots = new Set(deliverables.map((d) => d.slot));
  for (const [slot, uri] of Object.entries(delivered as Record<string, unknown>)) {
    if (!slots.has(slot)) {
      const allowed = slots.size > 0 ? Array.from(slots).join(", ") : "none";
      return `delivered slot "${slot}" is not a declared output of this step (deliverable: ${allowed})`;
    }
    if (typeof uri !== "string" || uri.length === 0) {
      return `delivered "${slot}" must be a non-empty string`;
    }
  }
  return null;
};

/** Steps of a recipe that produce at least one of the given artifact names. */
export const producersOf = (
  recipe: ReadonlyArray<StepDefinition>,
  artifactNames: ReadonlyArray<string>,
): Set<string> => {
  const wanted = new Set(artifactNames);
  const steps = new Set<string>();
  for (const step of recipe) {
    if (Object.values(step.outputs ?? {}).some((name) => wanted.has(name))) steps.add(step.id);
  }
  return steps;
};
