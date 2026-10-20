import { StepDefinition } from "../types";

/** Producer step id of a `step:<id>.<slot>` reference, or null for `job:` inputs. */
export const producerOf = (ref: string): string | null => {
  if (!ref.startsWith("step:")) return null;
  const body = ref.slice(5);
  const dot = body.indexOf(".");
  return dot === -1 ? body : body.slice(0, dot);
};

/**
 * A step is ready when every upstream step it reads from has succeeded.
 * Job-level inputs are registered at job creation and never block.
 */
export const isStepReady = (
  step: StepDefinition,
  statusByStep: Map<string, string>,
): boolean => {
  for (const ref of Object.values(step.inputs)) {
    const producer = producerOf(ref);
    if (producer === null) continue;
    if (statusByStep.get(producer) !== "success") return false;
  }
  return true;
};

export type FailureKind = "error" | "wait";

export type FailureDecision =
  | { next: "failed" }
  | { next: "pending" }
  | { next: "blocked" };

/**
 * What happens to a running step after `fail`.
 * `wait` never consumes an attempt and always blocks. `error` fails the step when
 * retries are disabled or the attempt counter (advanced on claim) reached max_attempts;
 * otherwise the step goes back to pending.
 */
export const decideFailure = (
  kind: FailureKind,
  attempt: number,
  maxAttempts: number,
  retry: boolean,
): FailureDecision => {
  if (kind === "wait") return { next: "blocked" };
  if (!retry || attempt >= maxAttempts) return { next: "failed" };
  return { next: "pending" };
};
