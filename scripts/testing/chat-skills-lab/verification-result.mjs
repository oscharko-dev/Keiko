const countFields = [
  "observedTests",
  "passedTests",
  "assertionFailures",
  "runtimeFailures",
  "unclassifiedFailures",
  "skippedTests",
  "expectedFailureTests",
  "focusedTests",
  "retriedTests",
  "repeatedTests",
  "collectionErrors",
  "missingDiagnostics",
  "unhandledErrors",
];
const prohibitedFields = [
  "runtimeFailures",
  "unclassifiedFailures",
  "skippedTests",
  "expectedFailureTests",
  "focusedTests",
  "retriedTests",
  "repeatedTests",
  "collectionErrors",
  "missingDiagnostics",
  "unhandledErrors",
];

function isCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function assertionCountsMatch(result) {
  if (!Array.isArray(result.testResults)) return false;
  if (!result.testResults.every((suite) => Array.isArray(suite.assertionResults))) return false;
  const assertions = result.testResults.flatMap((suite) => suite.assertionResults);
  return (
    assertions.length === result.numTotalTests &&
    assertions.filter((test) => test.status === "passed").length === result.numPassedTests &&
    assertions.filter((test) => test.status === "failed").length === result.numFailedTests
  );
}

function completeObservation(result) {
  const observation = result?.qualification;
  if (observation?.schemaVersion !== 1 || !countFields.every((key) => isCount(observation[key])))
    return false;
  const totals = [
    result.numTotalTests,
    result.numPassedTests,
    result.numFailedTests,
    result.numPendingTests,
    result.numTodoTests,
  ];
  if (!totals.every(isCount) || !assertionCountsMatch(result)) return false;
  return countsAgree(result, observation);
}

function countsAgree(result, observation) {
  const failures =
    observation.assertionFailures + observation.runtimeFailures + observation.unclassifiedFailures;
  return (
    observation.observedTests === result.numTotalTests &&
    observation.passedTests === result.numPassedTests &&
    failures === result.numFailedTests &&
    observation.skippedTests === result.numPendingTests + result.numTodoTests &&
    observation.observedTests === observation.passedTests + failures + observation.skippedTests
  );
}

export function resultCounts(result) {
  const reportComplete = completeObservation(result);
  const report = result ?? {};
  const observation = report.qualification ?? {};
  return {
    tests: report.numTotalTests ?? 0,
    passed: report.numPassedTests ?? 0,
    failed: report.numFailedTests ?? 0,
    runtimeErrors: reportComplete
      ? observation.runtimeFailures + observation.collectionErrors + observation.unhandledErrors
      : null,
    reportComplete,
    cleanExecution: reportComplete && prohibitedFields.every((key) => observation[key] === 0),
    endReason: observation.endReason ?? null,
  };
}

export function qualifiedBaseline(baseline) {
  return (
    baseline.typechecks &&
    baseline.status === 0 &&
    baseline.tests > 0 &&
    baseline.cleanExecution &&
    baseline.passed === baseline.tests &&
    baseline.endReason === "passed"
  );
}

export function qualifiedPair(baseline, mutation) {
  return (
    qualifiedBaseline(baseline) &&
    mutation?.status === 1 &&
    mutation.typechecks &&
    mutation.cleanExecution &&
    mutation.tests === baseline.tests &&
    mutation.failed > 0 &&
    mutation.endReason === "failed"
  );
}
