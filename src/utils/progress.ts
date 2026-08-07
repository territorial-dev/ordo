import { JobStep, JobStepDetailing } from "../types";

/**
 * Extracts a 0-100 percent value from a job_step_detailing row's free-form
 * `progress` jsonb. The shape is written by n8n, not enforced by Ordo, so
 * known keys are checked in priority order: "progress" (live shape), then
 * "percent" (README-documented shape), then "percentage". Returns 0 if no
 * candidate key holds a finite number. Result is clamped to [0, 100].
 */
export const extractDetailingPercent = (
  detailing: JobStepDetailing | null | undefined,
): number => {
  const raw = detailing?.progress;
  if (!raw || typeof raw !== "object") return 0;

  const candidates = ["progress", "percent", "percentage"] as const;
  for (const key of candidates) {
    const value = (raw as Record<string, unknown>)[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return Math.min(100, Math.max(0, value));
    }
  }
  return 0;
};

/**
 * Per-step progress fraction, in [0, 1]:
 * - "success" -> 1
 * - "running" -> extractDetailingPercent(step.last_detailing) / 100
 * - anything else (pending/failed/skipped) -> 0
 */
export const stepProgressFraction = (step: JobStep): number => {
  if (step.status === "success") return 1;
  if (step.status === "running") return extractDetailingPercent(step.last_detailing) / 100;
  return 0;
};

/** Job-level percentage: average of per-step fractions across all steps. */
export const computeJobProgressPercentage = (steps: JobStep[]): number => {
  if (steps.length === 0) return 0;
  const sum = steps.reduce((acc, step) => acc + stepProgressFraction(step), 0);
  return sum / steps.length;
};
