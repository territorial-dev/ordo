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

/**
 * Step statuses that a retry resets to `pending`: the failed step, the ones skipped because of
 * it, and the ones a cancel stopped.
 */
export const RETRY_RESET_STATUSES: ReadonlySet<string> = new Set(["failed", "skipped", "cancelled"]);

/**
 * Which steps a retry resets. Succeeded steps keep their artifacts, except the ones listed in
 * `redeliver`: a cancel withdraws what the job delivered, so a retried cancelled job runs again
 * the succeeded steps that produce a declared output, to deliver it again.
 */
export const stepsToReset = (
  steps: ReadonlyArray<{ step_id: string; status: string }>,
  redeliver: ReadonlySet<string> = new Set(),
): string[] =>
  steps
    .filter((s) => RETRY_RESET_STATUSES.has(s.status) || (s.status === "success" && redeliver.has(s.step_id)))
    .map((s) => s.step_id);

/** Job statuses a retry accepts. */
export const RETRYABLE_JOB_STATUSES: ReadonlySet<string> = new Set(["failed", "cancelled"]);

/** Whether a job in this status may be retried. */
export const canRetry = (jobStatus: string): boolean => RETRYABLE_JOB_STATUSES.has(jobStatus);

/** Job statuses a cancel accepts: the job is still open. */
export const CANCELLABLE_JOB_STATUSES: ReadonlySet<string> = new Set(["pending", "running"]);

/** Step statuses a cancel stops: everything that has not finished. */
export const CANCELLED_STEP_STATUSES: ReadonlySet<string> = new Set(["pending", "blocked", "running"]);

/** Why a job cannot be cancelled, or null when it can (a cancelled job is cancelled again as a no-op). */
export const cancelBlocker = (jobStatus: string): string | null => {
  if (CANCELLABLE_JOB_STATUSES.has(jobStatus) || jobStatus === "cancelled") return null;
  return `Job is ${jobStatus}, not pending or running`;
};

/** Step statuses under which nothing has run yet: a job made only of these may be deleted. */
export const DELETABLE_STEP_STATUSES: ReadonlySet<string> = new Set(["pending", "blocked"]);

/** Step statuses of a failed job that leave nothing behind: no artifact was ever recorded. */
export const DELETABLE_FAILED_STEP_STATUSES: ReadonlySet<string> = new Set([
  "pending",
  "blocked",
  "failed",
  "skipped",
  "cancelled",
]);

/**
 * Why a job cannot be deleted, or null when it can. An open job is deletable while none of its
 * steps has started: every step is `pending` or `blocked` (waiting for an input). A failed or
 * cancelled job is deletable while none of its steps succeeded or is running: it produced nothing, and a
 * client that knows it can never succeed (an input that will never exist) removes it instead of
 * leaving it failed for ever. A job with a succeeded step, and every finished job, stays, so no
 * artifact ever loses its record.
 */
export const deleteBlocker = (
  jobStatus: string,
  steps: ReadonlyArray<{ step_id: string; status: string }>,
): string | null => {
  if (jobStatus === "failed" || jobStatus === "cancelled") {
    const kept = steps.find((s) => !DELETABLE_FAILED_STEP_STATUSES.has(s.status));
    if (kept) return `Step ${kept.step_id} is ${kept.status}; a ${jobStatus} job is deleted only when no step succeeded`;
    return null;
  }
  if (jobStatus !== "pending" && jobStatus !== "running") {
    return `Job is ${jobStatus}, not pending or failed`;
  }
  const busy = steps.find((s) => !DELETABLE_STEP_STATUSES.has(s.status));
  if (busy) return `Step ${busy.step_id} is ${busy.status}, not pending`;
  return null;
};
