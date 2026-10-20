/**
 * Capability matching between a step's `requires` and a worker's `capabilities`.
 * Both are flat objects. For each key in `requires`:
 *   - a number requires capabilities[key] >= value
 *   - a boolean or string requires equality
 *   - a list requires every element to be present in the capability list
 * A missing capability fails the match. Deliberately not a query language.
 */
export type Capabilities = Record<string, unknown>;

export const matchesCapabilities = (
  requires: Record<string, unknown> | null | undefined,
  capabilities: Capabilities | null | undefined,
): boolean => {
  if (!requires || typeof requires !== "object") return true;
  const caps = capabilities ?? {};
  for (const [key, required] of Object.entries(requires)) {
    const have = caps[key];
    if (have === undefined || have === null) return false;
    if (typeof required === "number") {
      if (typeof have !== "number" || have < required) return false;
    } else if (typeof required === "boolean" || typeof required === "string") {
      if (have !== required) return false;
    } else if (Array.isArray(required)) {
      if (!Array.isArray(have)) return false;
      for (const element of required) {
        if (!have.includes(element)) return false;
      }
    } else {
      return false;
    }
  }
  return true;
};
