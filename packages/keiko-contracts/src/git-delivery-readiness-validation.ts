// Private shared ordering invariant for the Git merge and pull-request readiness leaves.
// Callers retain their own blocker vocabulary, severity admission and readiness consistency.
export function isGitReadinessSeverityRanked(
  blockers: readonly { readonly severity: string }[],
): boolean {
  let sawAdvisory = false;
  const extent = blockers.length;
  for (let index = 0; index < extent; index += 1) {
    const blocker = blockers[index];
    if (blocker === undefined) return false;
    if (blocker.severity === "advisory") {
      sawAdvisory = true;
    } else if (sawAdvisory) {
      return false;
    }
  }
  return true;
}

/** An advisory may use only a code the owning readiness producer can actually emit as advisory. */
export function hasGitReadinessForbiddenAdvisory(
  blockers: readonly { readonly severity: string; readonly code: string }[],
  allowedCodes: ReadonlySet<string>,
): boolean {
  const extent = blockers.length;
  for (let index = 0; index < extent; index += 1) {
    const blocker = blockers[index];
    if (blocker?.severity === "advisory" && !allowedCodes.has(blocker.code)) return true;
  }
  return false;
}
