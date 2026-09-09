// Canonical body-free #3390 evidence for the real macOS Seatbelt confinement proof. The artifact
// joins one unskipped kernel/backend test run to one successful production-runtime spawn event;
// sampled socket counts are deliberately not treated as OS-enforcement evidence.

import { isDeepStrictEqual } from "node:util";

import { sha256 } from "./digest.mjs";

const COMMIT_SHA = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const RUN_ID = /^run-[A-Za-z0-9._-]{1,123}$/u;
const EVIDENCE_KIND = "keiko-runtime-gateway-confinement-v1";
const SCENARIO_ID = "egress-confinement-macos-arm64";
const REQUIRED_TEST_TITLES = [
  "denies an unapproved child executable while permitting the real Apple git chain",
  "denies a hostile loopback destination while permitting only the configured gateway port",
  "denies a hostile loopback destination from a forked grandchild while permitting the gateway port",
  "denies a hostile loopback destination while permitting the gateway port via spawnOwnedTree",
];

function exactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function field(value, key) {
  return value !== null && typeof value === "object" ? value[key] : undefined;
}

function nestedField(value, keys) {
  return keys.reduce((current, key) => field(current, key), value);
}

function requireUnskippedPassingTests(report) {
  if (
    report?.success !== true ||
    !Number.isSafeInteger(report.numTotalTests) ||
    report.numTotalTests <= 0 ||
    report.numPassedTests !== report.numTotalTests ||
    report.numFailedTests !== 0 ||
    report.numPendingTests !== 0 ||
    !Array.isArray(report.testResults)
  ) {
    throw new TypeError("confinement test report is not an unskipped passing run");
  }
  const passedTitles = new Set(
    report.testResults.flatMap((file) =>
      Array.isArray(file?.assertionResults)
        ? file.assertionResults
            .filter((assertion) => assertion?.status === "passed")
            .map((assertion) => assertion?.title)
        : [],
    ),
  );
  if (!REQUIRED_TEST_TITLES.every((title) => passedTitles.has(title))) {
    throw new TypeError("confinement test report is missing a required production assertion");
  }
}

function parseActivityEvents(activityBytes) {
  return activityBytes
    .toString("utf8")
    .split(/\r?\n/u)
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

function observedSpawnEvent(activityBytes, correlationId) {
  const matches = parseActivityEvents(activityBytes).filter(
    (event) => event?.op === "runtime.confinement.spawned" && event.correlationId === correlationId,
  );
  if (matches.length !== 1) throw new TypeError("expected exactly one runtime confinement event");
  const event = matches[0];
  if (
    event.backend !== "seatbelt" ||
    event.profile !== "keiko-gateway" ||
    event.childExecutablePolicy !== "runtime-and-attested-git-only" ||
    ![
      event.policyDigest,
      event.authorityDigest,
      event.runtimeArtifactDigest,
      event.modelProfileDigest,
      event.treeBindingId,
      event.childExecutableDigest,
    ].every((value) => typeof value === "string" && SHA256.test(value))
  ) {
    throw new TypeError("runtime confinement event is incomplete or invalid");
  }
  return event;
}

function requireProductionRunBinding(input, activityDigest) {
  const report = input.realBinaryReport;
  const observation = input.managedObservation;
  const runtime = field(report, "runtime");
  const managedCatalog = field(report, "managedCatalog");
  const valid = [
    nestedField(report, ["journey", "exitCode"]) === 0,
    nestedField(report, ["activityLog", "status"]) === "retained",
    nestedField(report, ["activityLog", "sha256"]) === activityDigest,
    field(report, "sourceHead") === input.sourceCommitSha,
    nestedField(report, ["managedCatalog", "correlationId"]) === input.correlationId,
    field(observation, "schemaVersion") === 1,
    field(observation, "sourceHead") === input.sourceCommitSha,
    field(observation, "consumer") === "managed-opencode",
    field(observation, "terminalStatus") === "completed",
    nestedField(observation, ["runBinding", "correlationId"]) === input.correlationId,
    nestedField(observation, ["runBinding", "activityLogSha256"]) === activityDigest,
    isDeepStrictEqual(field(managedCatalog, "binding"), field(observation, "binding")),
    field(runtime, "name") === input.approvedRuntime.name,
    field(runtime, "version") === input.approvedRuntime.version,
    field(runtime, "target") === input.approvedRuntime.target,
  ].every(Boolean);
  if (!valid) {
    throw new TypeError(
      "runtime confinement evidence is not bound to one successful production run",
    );
  }
}

function runtimeProof(input, event) {
  const binding = input.managedObservation.binding;
  return {
    correlationId: input.correlationId,
    activityLogSha256: sha256(input.activityBytes),
    eventSha256: sha256(`${JSON.stringify(event)}\n`),
    backend: event.backend,
    profile: event.profile,
    childExecutablePolicy: event.childExecutablePolicy,
    policyDigest: event.policyDigest,
    authorityDigest: event.authorityDigest,
    runtimeArtifactDigest: event.runtimeArtifactDigest,
    modelProfileDigest: event.modelProfileDigest,
    treeBindingId: event.treeBindingId,
    childExecutableDigest: event.childExecutableDigest,
    runtimeName: input.approvedRuntime.name,
    runtimeVersion: input.approvedRuntime.version,
    runtimeTarget: input.approvedRuntime.target,
    catalogRevision: binding.catalogRevision,
    catalogProfileId: binding.profile.id,
    catalogProfileVersion: binding.profile.version,
    projectionDigest: binding.projectionDigest,
    handlerSetDigest: binding.handlerSetDigest,
  };
}

export function buildRuntimeGatewayConfinementArtifact(input) {
  if (
    !COMMIT_SHA.test(input.sourceCommitSha) ||
    input.platform !== "darwin" ||
    input.architecture !== "arm64" ||
    !RUN_ID.test(input.correlationId)
  ) {
    throw new TypeError("runtime confinement qualification identity is invalid");
  }
  requireUnskippedPassingTests(input.testReport);
  const activityDigest = sha256(input.activityBytes);
  requireProductionRunBinding(input, activityDigest);
  const event = observedSpawnEvent(input.activityBytes, input.correlationId);
  return {
    schemaVersion: 1,
    evidenceKind: EVIDENCE_KIND,
    scenarioId: SCENARIO_ID,
    evidenceClass: "production-functional",
    sourceCommitSha: input.sourceCommitSha,
    platformTarget: "macos-arm64",
    result: "passed",
    tests: {
      total: input.testReport.numTotalTests,
      passed: input.testReport.numPassedTests,
      failed: input.testReport.numFailedTests,
      skipped: input.testReport.numPendingTests,
      reportSha256: sha256(input.testReportBytes),
      assertions: REQUIRED_TEST_TITLES.map((_, index) => `confinement-proof-${String(index + 1)}`),
    },
    runtime: runtimeProof(input, event),
  };
}

function confinementIdentityIsValid(value, scenarioId) {
  return [
    value.schemaVersion === 1,
    value.evidenceKind === EVIDENCE_KIND,
    value.scenarioId === scenarioId,
    value.evidenceClass === "production-functional",
    COMMIT_SHA.test(value.sourceCommitSha),
    value.platformTarget === "macos-arm64",
    value.result === "passed",
  ].every(Boolean);
}

function confinementTestsAreValid(tests) {
  const expectedAssertions = REQUIRED_TEST_TITLES.map(
    (_, index) => `confinement-proof-${String(index + 1)}`,
  );
  return [
    exactKeys(tests, ["total", "passed", "failed", "skipped", "reportSha256", "assertions"]),
    Number.isSafeInteger(tests?.total),
    tests?.total > 0,
    tests?.passed === tests?.total,
    tests?.failed === 0,
    tests?.skipped === 0,
    SHA256.test(tests?.reportSha256),
    JSON.stringify(tests?.assertions) === JSON.stringify(expectedAssertions),
  ].every(Boolean);
}

function confinementRuntimeIsValid(runtime) {
  const digests = [
    field(runtime, "activityLogSha256"),
    field(runtime, "eventSha256"),
    field(runtime, "policyDigest"),
    field(runtime, "authorityDigest"),
    field(runtime, "runtimeArtifactDigest"),
    field(runtime, "modelProfileDigest"),
    field(runtime, "treeBindingId"),
    field(runtime, "childExecutableDigest"),
    field(runtime, "catalogRevision"),
    field(runtime, "projectionDigest"),
    field(runtime, "handlerSetDigest"),
  ];
  return [
    exactKeys(runtime, [
      "correlationId",
      "activityLogSha256",
      "eventSha256",
      "backend",
      "profile",
      "childExecutablePolicy",
      "policyDigest",
      "authorityDigest",
      "runtimeArtifactDigest",
      "modelProfileDigest",
      "treeBindingId",
      "childExecutableDigest",
      "runtimeName",
      "runtimeVersion",
      "runtimeTarget",
      "catalogRevision",
      "catalogProfileId",
      "catalogProfileVersion",
      "projectionDigest",
      "handlerSetDigest",
    ]),
    RUN_ID.test(field(runtime, "correlationId")),
    field(runtime, "backend") === "seatbelt",
    field(runtime, "profile") === "keiko-gateway",
    field(runtime, "childExecutablePolicy") === "runtime-and-attested-git-only",
    field(runtime, "runtimeName") === "opencode-compatible",
    /^\d+\.\d+\.\d+$/u.test(field(runtime, "runtimeVersion")),
    field(runtime, "runtimeTarget") === "macos-arm64",
    field(runtime, "catalogProfileId") === "opencode",
    field(runtime, "catalogProfileVersion") === 1,
    digests.every((digest) => typeof digest === "string" && SHA256.test(digest)),
  ].every(Boolean);
}

export function runtimeGatewayConfinementArtifactErrors(value, scenarioId = SCENARIO_ID) {
  if (
    !exactKeys(value, [
      "schemaVersion",
      "evidenceKind",
      "scenarioId",
      "evidenceClass",
      "sourceCommitSha",
      "platformTarget",
      "result",
      "tests",
      "runtime",
    ])
  ) {
    return ["artifact must have the closed runtime-confinement shape"];
  }
  return [
    ...(confinementIdentityIsValid(value, scenarioId) ? [] : ["artifact identity is invalid"]),
    ...(confinementTestsAreValid(value.tests) ? [] : ["test proof is invalid"]),
    ...(confinementRuntimeIsValid(value.runtime) ? [] : ["runtime proof is invalid"]),
  ];
}
