// Scenario verdict of the requirements scorecard (epic #4173, #4174). Pure, so it is testable
// without a laboratory: a scenario is green only when every obligation of the catalog is covered
// by a passing check and an end-to-end journey took part.

/**
 * Grades one scenario from its checks.
 *  - unchecked:  no check exists
 *  - red:        any check failed
 *  - green:      every obligation is covered by a passing check, one of them an end-to-end journey
 *  - partial:    a journey ran but obligations remain uncovered
 *  - probe-only: only model-free probes ran
 * A check lists the obligations it verifies in `covers`; unknown names fail closed.
 */
export function scenarioVerdict(scenario, checks) {
  if (checks.length === 0) {
    return { status: "unchecked", covered: [], uncovered: [...scenario.obligations] };
  }
  const known = new Set(scenario.obligations);
  const unknown = checks.flatMap((check) =>
    (check.covers ?? []).filter((name) => !known.has(name)),
  );
  if (unknown.length > 0) {
    throw new TypeError(`${scenario.id}: checks cover unknown obligations ${unknown.join(", ")}`);
  }
  const covered = new Set(
    checks.filter((check) => check.status === "green").flatMap((check) => check.covers ?? []),
  );
  const uncovered = scenario.obligations.filter((name) => !covered.has(name));
  const base = { covered: [...covered].sort(), uncovered };
  if (checks.some((check) => check.status === "red")) return { status: "red", ...base };
  if (!checks.some((check) => check.layer === "journey")) return { status: "probe-only", ...base };
  return { status: uncovered.length === 0 ? "green" : "partial", ...base };
}
