/** Pure helpers for job priority and retry, kept out of the services so they can be unit tested. */

export const PRIORITY_MIN = -1000;
export const PRIORITY_MAX = 1000;

/**
 * Validates a `priority` value from a request body. Undefined and null mean "not given"
 * (the caller keeps the default or the current value). Anything else must be an integer
 * within [PRIORITY_MIN, PRIORITY_MAX].
 */
export const parsePriority = (value: unknown): number | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new RangeError("priority must be an integer");
  }
  if (value < PRIORITY_MIN || value > PRIORITY_MAX) {
    throw new RangeError(`priority must be between ${PRIORITY_MIN} and ${PRIORITY_MAX}`);
  }
  return value;
};

/** Step statuses that a retry resets to `pending`: the failed step and the ones skipped because of it. */
export const RETRY_RESET_STATUSES: ReadonlySet<string> = new Set(["failed", "skipped"]);

/** Which steps of a failed job a retry resets. Succeeded steps keep their artifacts. */
export const stepsToReset = (steps: ReadonlyArray<{ step_id: string; status: string }>): string[] =>
  steps.filter((s) => RETRY_RESET_STATUSES.has(s.status)).map((s) => s.step_id);

/** Whether a job in this status may be retried. */
export const canRetry = (jobStatus: string): boolean => jobStatus === "failed";
