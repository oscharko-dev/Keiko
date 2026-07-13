export const SONAR_PROJECT_KEY = "oscharko-dev_Keiko";
export const SONAR_ORGANIZATION = "oscharko-dev";
export const SONAR_MAIN_BRANCH = "dev";
export const KEIKO_GATE_ID = "156389";
export const KEIKO_GATE_NAME = "Keiko Banking Grade";

export const KEIKO_REPOSITORY_GATE_CONTRACT = Object.freeze({
  nativeGateStatus: "OK",
  newCodeCoverageMinimum: 85,
  newCodeDuplicationMaximum: 3,
  newCodeHotspotReviewMinimum: 100,
  newViolationsMaximum: 0,
  overallHotspotReviewMinimum: 100,
  unresolvedPullRequestIssuesMaximum: 0,
});

export const KEIKO_GATE_CONDITIONS = Object.freeze([
  { error: "3", metric: "new_duplicated_lines_density", op: "GT" },
  { error: "85", metric: "new_coverage", op: "LT" },
  { error: "1", metric: "new_maintainability_rating", op: "GT" },
  { error: "1", metric: "new_reliability_rating", op: "GT" },
  { error: "1", metric: "new_security_rating", op: "GT" },
  { error: "100", metric: "new_security_hotspots_reviewed", op: "LT" },
  { error: "0", metric: "new_violations", op: "GT" },
  { error: "100", metric: "security_hotspots_reviewed", op: "LT" },
]);

function canonicalCondition(condition) {
  return `${String(condition.metric)}:${String(condition.op)}:${String(condition.error)}`;
}

function compareCanonicalConditions(left, right) {
  return left.localeCompare(right);
}

export function gateContractFailures(gate) {
  if (gate === undefined) return ["Keiko Banking Grade definition is missing."];
  const failures = [];
  if (String(gate.id) !== KEIKO_GATE_ID || gate.name !== KEIKO_GATE_NAME) {
    failures.push("Keiko Banking Grade identity does not match the governed contract.");
  }
  const expected = KEIKO_GATE_CONDITIONS.map(canonicalCondition).toSorted(
    compareCanonicalConditions,
  );
  const observed = (gate.conditions ?? [])
    .map(canonicalCondition)
    .toSorted(compareCanonicalConditions);
  if (JSON.stringify(observed) !== JSON.stringify(expected)) {
    failures.push("Keiko Banking Grade conditions drifted from the repository contract.");
  }
  return failures;
}

export function countAwareRateFailures({ count, rate, label, violates }) {
  if (count === undefined) return [`${label} applicability count is missing.`];
  if (count < 0) return [`${label} applicability count is invalid.`];
  if (count === 0) return [];
  if (rate === undefined)
    return [`${label} rate is missing despite a positive applicability count.`];
  if (rate < 0 || rate > 100) return [`${label} rate is invalid.`];
  return violates(rate) ? [`${label} condition failed at ${String(rate)}%.`] : [];
}
