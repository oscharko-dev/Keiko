// Scenario verdict of the requirements scorecard (epic #4173, #4174). Pure, so it is testable
// without a laboratory: a scenario is green only when every obligation of the catalog is covered
// by a passing check and a green end-to-end journey took part.

/**
 * The obligations a scenario defers to a follow-up issue. An obligation may be deferred only with
 * the number of that issue, and never while the scenario still lists it as its own.
 */
export function deferredObligations(scenario) {
  const deferred = scenario.deferred ?? [];
  for (const entry of deferred) {
    if (typeof entry?.obligation !== "string" || entry.obligation === "") {
      throw new TypeError(`${scenario.id}: a deferred obligation needs a name`);
    }
    if (!Number.isSafeInteger(entry.issue) || entry.issue <= 0) {
      throw new TypeError(
        `${scenario.id}: ${entry.obligation} is deferred without an issue number`,
      );
    }
    if (scenario.obligations.includes(entry.obligation)) {
      throw new TypeError(`${scenario.id}: ${entry.obligation} is both required and deferred`);
    }
  }
  return deferred.map(({ obligation, issue }) => ({ obligation, issue }));
}

/** The scorecard's evidence cell lines of one scenario result: checks, uncovered, deferred. */
export function evidenceLines(result) {
  return [
    ...result.checks.map((check) => `${check.layer}: ${check.detail}`),
    ...(result.uncovered.length > 0 && result.checks.length > 0
      ? [`uncovered: ${result.uncovered.join(", ")}`]
      : []),
    ...(result.deferred ?? []).map(
      ({ obligation, issue }) => `deferred to #${issue}: ${obligation}`,
    ),
  ];
}

/**
 * Grades one scenario from its checks.
 *  - unchecked:  no check exists
 *  - red:        any check failed (a red model-free probe is red even beside an invalid journey)
 *  - invalid:    a check the laboratory cannot trust (lab error, model unavailable, gateway
 *                failure) and no model-free probe is red; never graded as a product failure
 *  - green:      every obligation is covered by a passing check AND the end-to-end journey is
 *                green; probes covering everything beside an `unverified` journey stay partial
 *  - partial:    a journey ran but obligations remain uncovered or it could not verify its
 *                evidence (`unverified` covers nothing)
 *  - probe-only: only model-free probes ran
 * A check lists the obligations it verifies in `covers`; unknown names fail closed.
 */
export function scenarioVerdict(scenario, checks) {
  const deferred = deferredObligations(scenario);
  if (checks.length === 0) {
    return { status: "unchecked", covered: [], uncovered: [...scenario.obligations], deferred };
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
  const base = { covered: [...covered].sort(), uncovered, deferred };
  if (checks.some((check) => check.layer === "probe" && check.status === "red"))
    return { status: "red", ...base };
  if (checks.some((check) => check.status === "invalid")) return { status: "invalid", ...base };
  if (checks.some((check) => check.status === "red")) return { status: "red", ...base };
  const journey = checks.find((check) => check.layer === "journey");
  if (journey === undefined) return { status: "probe-only", ...base };
  const green = uncovered.length === 0 && journey.status === "green";
  return { status: green ? "green" : "partial", ...base };
}
