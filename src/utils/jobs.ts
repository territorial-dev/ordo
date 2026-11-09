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

/** Step statuses under which nothing has run yet: a job made only of these may be deleted. */
export const DELETABLE_STEP_STATUSES: ReadonlySet<string> = new Set(["pending", "blocked"]);

/** Step statuses of a failed job that leave nothing behind: no artifact was ever recorded. */
export const DELETABLE_FAILED_STEP_STATUSES: ReadonlySet<string> = new Set([
  "pending",
  "blocked",
  "failed",
  "skipped",
]);

/**
 * Why a job cannot be deleted, or null when it can. An open job is deletable while none of its
 * steps has started: every step is `pending` or `blocked` (waiting for an input). A failed job
 * is deletable while none of its steps succeeded or is running: it produced nothing, and a
 * client that knows it can never succeed (an input that will never exist) removes it instead of
 * leaving it failed for ever. A job with a succeeded step, and every finished job, stays, so no
 * artifact ever loses its record.
 */
export const deleteBlocker = (
  jobStatus: string,
  steps: ReadonlyArray<{ step_id: string; status: string }>,
): string | null => {
  if (jobStatus === "failed") {
    const kept = steps.find((s) => !DELETABLE_FAILED_STEP_STATUSES.has(s.status));
    if (kept) return `Step ${kept.step_id} is ${kept.status}; a failed job is deleted only when no step succeeded`;
    return null;
  }
  if (jobStatus !== "pending" && jobStatus !== "running") {
    return `Job is ${jobStatus}, not pending or failed`;
  }
  const busy = steps.find((s) => !DELETABLE_STEP_STATUSES.has(s.status));
  if (busy) return `Step ${busy.step_id} is ${busy.status}, not pending`;
  return null;
};
