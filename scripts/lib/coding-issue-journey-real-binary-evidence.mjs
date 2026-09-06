// Closed, body-free #3390 projection of the existing real-binary journey report. The runner owns
// the completeness decision; this leaf owns only the shape accepted by the shared receipt reader.

const COMMIT_SHA = /^[a-f0-9]{40}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const EVIDENCE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SEMVER = /^\d+\.\d+\.\d+$/u;

function exactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function identityIsValid(value) {
  return [
    value.schemaVersion === 1,
    value.evidenceKind === "keiko-code-task-real-binary-v1",
    value.scenarioId === "real-binary-lane",
    value.evidenceClass === "production-functional",
    COMMIT_SHA.test(value.sourceCommitSha),
    value.platformTarget === "macos-arm64",
    value.result === "passed",
  ].every(Boolean);
}

function runtimeIsValid(value) {
  return (
    exactKeys(value, ["name", "version", "target"]) &&
    value.name === "opencode-compatible" &&
    SEMVER.test(value.version) &&
    value.target === "macos-arm64"
  );
}

function runIsValid(value) {
  return (
    exactKeys(value, ["correlationId", "activityLogSha256"]) &&
    EVIDENCE_ID.test(value.correlationId) &&
    SHA256.test(value.activityLogSha256)
  );
}

function limitsAreValid(value) {
  return (
    exactKeys(value, [
      "contextWindow",
      "outputTokens",
      "gatewayRequestCount",
      "gatewayCatalogBindingRequestCount",
    ]) &&
    value.contextWindow === 32_768 &&
    value.outputTokens === 4_096 &&
    Number.isSafeInteger(value.gatewayRequestCount) &&
    value.gatewayRequestCount > 0 &&
    value.gatewayCatalogBindingRequestCount === value.gatewayRequestCount
  );
}

function h1SearchIsValid(value) {
  const keys = [
    "toolCallId",
    "hitCount",
    "pathDigest",
    "snippetDigest",
    "startLine",
    "endLine",
    "readTargetDerivedFromResult",
  ];
  if (!exactKeys(value, keys)) return false;
  return [
    value.toolCallId === "h1-real-binary-search",
    Number.isSafeInteger(value.hitCount),
    value.hitCount === 1,
    SHA256.test(value.pathDigest),
    SHA256.test(value.snippetDigest),
    Number.isSafeInteger(value.startLine),
    value.startLine > 0,
    Number.isSafeInteger(value.endLine),
    value.endLine >= value.startLine,
    value.readTargetDerivedFromResult === true,
  ].every(Boolean);
}

function catalogBindingIsValid(value) {
  return (
    exactKeys(value, ["catalogRevision", "profile", "projectionDigest", "handlerSetDigest"]) &&
    SHA256.test(value.catalogRevision) &&
    exactKeys(value.profile, ["id", "version"]) &&
    value.profile.id === "opencode" &&
    value.profile.version === 1 &&
    SHA256.test(value.projectionDigest) &&
    SHA256.test(value.handlerSetDigest)
  );
}

function managedCatalogIsValid(value) {
  const proof = value?.proof;
  return (
    exactKeys(value, ["binding", "settlementCount", "proof"]) &&
    catalogBindingIsValid(value.binding) &&
    Number.isSafeInteger(value.settlementCount) &&
    value.settlementCount > 0 &&
    exactKeys(proof, ["kind", "searchSettled", "boundedReadSettled", "causalHandoff"]) &&
    proof.kind === "managed-search-read" &&
    proof.searchSettled === true &&
    proof.boundedReadSettled === true &&
    proof.causalHandoff === true
  );
}

export function realBinaryScenarioArtifactErrors(value) {
  if (
    !exactKeys(value, [
      "schemaVersion",
      "evidenceKind",
      "scenarioId",
      "evidenceClass",
      "sourceCommitSha",
      "platformTarget",
      "result",
      "runtime",
      "run",
      "limits",
      "missingPayload",
      "h1Search",
      "managedCatalog",
    ])
  ) {
    return ["artifact must have the closed real-binary shape"];
  }
  const validations = [
    [identityIsValid(value), "artifact identity is invalid"],
    [runtimeIsValid(value.runtime), "runtime identity is invalid"],
    [runIsValid(value.run), "run binding is invalid"],
    [limitsAreValid(value.limits), "effective limits are invalid"],
    [
      exactKeys(value.missingPayload, ["unavailableReason"]) &&
        value.missingPayload.unavailableReason === "payload-missing",
      "missing-payload proof is invalid",
    ],
    [h1SearchIsValid(value.h1Search), "H1 search handoff is invalid"],
    [managedCatalogIsValid(value.managedCatalog), "managed catalog proof is invalid"],
  ];
  return validations.filter(([valid]) => !valid).map(([, message]) => message);
}
