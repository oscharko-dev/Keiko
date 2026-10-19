import { JsonReporter } from "vitest/node";
import { Buffer } from "node:buffer";
import { TextDecoder } from "node:util";

const runtimeNames = new Set([
  "TypeError",
  "ReferenceError",
  "SyntaxError",
  "RangeError",
  "EvalError",
  "URIError",
  "AggregateError",
]);

function isAssertion(error) {
  if (error.name === "AssertionError") return true;
  const matcher = error.__vitest_error_context__?.assertionName;
  if (typeof matcher === "string" && matcher.length > 0) return true;
  return (
    error.name === "TestingLibraryElementError" &&
    typeof error.stack === "string" &&
    error.stack.includes("/@testing-library/dom/")
  );
}

function failureKind(errors) {
  if (!Array.isArray(errors) || errors.length === 0) return "unclassifiedFailures";
  if (errors.some((error) => runtimeNames.has(error.name))) return "runtimeFailures";
  return errors.every(isAssertion) ? "assertionFailures" : "unclassifiedFailures";
}

function optionInLineage(test, predicate) {
  for (let current = test; current !== undefined; current = current.parent) {
    if (current.options !== undefined && predicate(current.options)) return true;
  }
  return false;
}

function observeTest(observation, test) {
  const result = test.result();
  const diagnostic = test.diagnostic();
  observation.observedTests++;
  if (result.state === "passed") observation.passedTests++;
  else if (result.state === "failed") observation[failureKind(result.errors)]++;
  else observation.skippedTests++;
  if (diagnostic === undefined) observation.missingDiagnostics++;
  observeTestOptions(observation, test, diagnostic);
}

function observeTestOptions(observation, test, diagnostic) {
  if (optionInLineage(test, (options) => options.fails === true))
    observation.expectedFailureTests++;
  if (optionInLineage(test, (options) => options.mode === "only")) observation.focusedTests++;
  if (diagnostic?.retryCount > 0 || optionInLineage(test, (options) => Boolean(options.retry)))
    observation.retriedTests++;
  if (diagnostic?.repeatCount > 0 || optionInLineage(test, (options) => Boolean(options.repeats)))
    observation.repeatedTests++;
}

export function observeQualification(testModules, unhandledErrors, endReason) {
  const observation = {
    schemaVersion: 1,
    endReason,
    observedTests: 0,
    passedTests: 0,
    assertionFailures: 0,
    runtimeFailures: 0,
    unclassifiedFailures: 0,
    skippedTests: 0,
    expectedFailureTests: 0,
    focusedTests: 0,
    retriedTests: 0,
    repeatedTests: 0,
    collectionErrors: 0,
    missingDiagnostics: 0,
    unhandledErrors: Array.isArray(unhandledErrors) ? unhandledErrors.length : null,
  };
  for (const module of testModules) {
    observation.collectionErrors += module.errors().length;
    for (const suite of module.children.allSuites())
      observation.collectionErrors += suite.errors().length;
    for (const test of module.children.allTests()) observeTest(observation, test);
  }
  return observation;
}

// Private verifier output only: public qualification evidence retains counts and digests.
const DIAGNOSTIC_BYTE_LIMIT = 8192;

function errorDescription(error) {
  if (error === null || typeof error !== "object") return "";
  if (typeof error.stack === "string" && error.stack.length > 0) return error.stack;
  if (typeof error.message !== "string" || error.message.length === 0) return "";
  return typeof error.name === "string" && error.name.length > 0
    ? `${error.name}: ${error.message}`
    : error.message;
}

function* nonTestErrors(testModules, unhandledErrors) {
  yield* unhandledErrors;
  for (const module of testModules) {
    yield* module.errors();
    for (const suite of module.children.allSuites()) yield* suite.errors();
  }
}

function appendDiagnostic(state, description) {
  if (description.length === 0) return true;
  const separator = state.text.length === 0 ? "" : "\n\n";
  const remaining = DIAGNOSTIC_BYTE_LIMIT - Buffer.byteLength(state.text) - separator.length;
  if (remaining <= 0) {
    state.truncated = true;
    return false;
  }
  const bytes = Buffer.from(description.slice(0, DIAGNOSTIC_BYTE_LIMIT));
  const text = new TextDecoder().decode(bytes.subarray(0, remaining), { stream: true });
  if (text.length === 0) {
    state.truncated = true;
    return false;
  }
  state.text += separator + text;
  state.capturedErrorCount++;
  state.truncated = description.length > text.length;
  return !state.truncated;
}

function observePrivateDiagnostics(testModules, unhandledErrors, qualification) {
  const errorCount =
    qualification.unhandledErrors === null
      ? null
      : qualification.unhandledErrors + qualification.collectionErrors;
  const state = { text: "", capturedErrorCount: 0, truncated: false };
  if (Array.isArray(unhandledErrors)) {
    for (const error of nonTestErrors(testModules, unhandledErrors)) {
      if (!appendDiagnostic(state, errorDescription(error))) break;
    }
  }
  return {
    schemaVersion: 1,
    errorCount,
    ...state,
    complete: errorCount !== null && state.capturedErrorCount === errorCount && !state.truncated,
  };
}

export default class QualificationReporter extends JsonReporter {
  constructor() {
    super({ outputFile: "result.json" });
  }

  async onTestRunEnd(testModules, unhandledErrors, reason) {
    this.qualification = observeQualification(testModules, unhandledErrors, reason);
    this.qualificationDiagnostics = observePrivateDiagnostics(
      testModules,
      unhandledErrors,
      this.qualification,
    );
    await super.onTestRunEnd(testModules);
  }

  async writeReport(report) {
    await super.writeReport(
      JSON.stringify({
        ...JSON.parse(report),
        qualification: this.qualification,
        qualificationDiagnostics: this.qualificationDiagnostics,
      }),
    );
  }
}
