import { Buffer } from "node:buffer";
import { isErrorKind } from "../../packages/keiko-contracts/dist/observability.js";
import { redactLogFields } from "../../packages/keiko-server/dist/observability/log-redaction.js";
// Validation of documentation examples. Runtime validation stays with #3406/#3413.
const DIGEST = /^[a-f0-9]{64}$/;
const ID = /^[a-zA-Z0-9_.-]{1,128}$/;
const COUNT_FIELDS = new Set(["durationMs", "inputBytes", "outputBytes", "resultCount"]);
const DIGEST_FIELDS = new Set([
  "catalogRevision",
  "projectionDigest",
  "descriptorDigest",
  "handlerSetDigest",
]);
const ID_FIELDS = new Set([
  "correlationId",
  "parentCorrelationId",
  "invocationId",
  "reservationId",
  "settlementId",
]);
function forbiddenEvidence(value, forbidden, depth = 0) {
  if (depth > 16) return true;
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(
    ([key, child]) => forbidden.includes(key) || forbiddenEvidence(child, forbidden, depth + 1),
  );
}
function validReference(key, value) {
  if (key === "profile")
    return (
      exactRecord(value, ["id", "version"]) &&
      typeof value.id === "string" &&
      ID.test(value.id) &&
      Number.isSafeInteger(value.version) &&
      value.version > 0
    );
  return (
    exactRecord(value, ["canonicalId", "contractVersion"]) &&
    typeof value.canonicalId === "string" &&
    /^keiko\.[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/.test(value.canonicalId) &&
    Number.isSafeInteger(value.contractVersion) &&
    value.contractVersion > 0
  );
}
function validIdentifier(key, value) {
  return (
    (key === "reservationId" && value === null) || (typeof value === "string" && ID.test(value))
  );
}
function validField(contract, key, value) {
  if (COUNT_FIELDS.has(key)) return Number.isSafeInteger(value) && value >= 0;
  if (DIGEST_FIELDS.has(key)) return typeof value === "string" && DIGEST.test(value);
  if (ID_FIELDS.has(key)) return validIdentifier(key, value);
  if (key === "profile" || key === "toolRef") return validReference(key, value);
  return validEnumField(contract, key, value);
}
function validEnumField(contract, key, value) {
  if (key === "readiness") return contract.readiness.includes(value);
  if (key === "state") return value === "started";
  if (key === "effectStarted" || key === "truncated") return typeof value === "boolean";
  if (key === "budgetDisposition")
    return new Set(["committed", "released", "not-reserved"]).has(value);
  if (key === "errorKind") return isErrorKind(value);
  if (key === "frames" || key === "causeChain") return validDiagnosticArray(key, value);
  return typeof value === "string";
}
function validDiagnosticArray(key, value) {
  if (!Array.isArray(value)) return false;
  if (value.length === 0) return true;
  const redacted = redactLogFields({ [key]: value })?.[key];
  return (
    Array.isArray(redacted) &&
    value.length === redacted.length &&
    value.every((item, index) => item === redacted[index])
  );
}
function terminalProblems(value) {
  const errors = [];
  if (
    value.status === "failed" &&
    (!isErrorKind(value.errorKind) ||
      !validDiagnosticArray("frames", value.frames) ||
      !validDiagnosticArray("causeChain", value.causeChain))
  )
    errors.push("missing or invalid structured failure diagnostics");
  if (!validSettlement(value)) errors.push("invalid settlement accounting");
  return errors;
}
function validSettlement(value) {
  if (value.budgetDisposition === "not-reserved")
    return value.effectStarted === false && value.reservationId === null;
  if (typeof value.reservationId !== "string" || !ID.test(value.reservationId)) return false;
  return value.effectStarted === (value.budgetDisposition === "committed");
}
function startedProblems(value) {
  const errors = [];
  if (value.reason !== "none") errors.push("invalid started reason");
  if (value.reservationId === null) errors.push("missing started reservation");
  return errors;
}
function phaseProblems(contract, phase, value) {
  const errors = [];
  if (phase === "terminal") {
    errors.push(...terminalProblems(value));
    if (!validStatusReason(contract, value)) errors.push("invalid terminal pair");
    return errors;
  }
  if (value.status !== undefined) errors.push("premature terminal status");
  if (phase === "invocation-started") errors.push(...startedProblems(value));
  if (phase === "discarded" && value.reason !== "late-completion")
    errors.push("invalid discarded reason");
  return errors;
}
export function validateEvidenceExample(contract, phase, value) {
  const definition = contract.phases[phase];
  if (!definition || !value || typeof value !== "object") return ["invalid phase example"];
  const errors = phaseProblems(contract, phase, value);
  if (Object.keys(value).some((key) => !contract.evidenceAllowed.includes(key)))
    errors.push("forbidden evidence field");
  if (forbiddenEvidence(value, contract.evidenceForbidden)) errors.push("forbidden evidence field");
  if (definition.required.some((key) => value[key] === undefined))
    errors.push("missing phase field");
  if (value.op !== definition.op) errors.push("wrong operation");
  if (Object.entries(value).some(([key, field]) => !validField(contract, key, field)))
    errors.push("invalid field type");
  return errors;
}

function validCursor(cursor, maxBytes) {
  return cursor === null || (typeof cursor === "string" && Buffer.byteLength(cursor) <= maxBytes);
}
function validPage(contract, page) {
  if (!exactRecord(page, ["truncated", "reason", "cursor"])) return false;
  const { truncated, reason, cursor } = page;
  if (typeof truncated !== "boolean" || !contract.pagination.reasons.includes(reason)) return false;
  if (!truncated && (reason !== "none" || cursor !== null)) return false;
  if (truncated && reason === "none") return false;
  return validCursor(cursor, contract.bounds.maxCursorBytes);
}
function validResultData(contract, value) {
  if (value.status === "completed")
    return value.data !== undefined && value.data !== null && validPage(contract, value.page);
  return value.data === null && value.page === null;
}
function validStatusReason(contract, value) {
  if (!Object.hasOwn(contract.statuses, value.status)) return false;
  return contract.statuses[value.status].includes(value.reason);
}
function validResultPair(contract, value) {
  return value.schemaVersion === 1 && validStatusReason(contract, value);
}
function exactRecord(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}
function validResultIdentity(contract, value) {
  if (!validField(contract, "invocationId", value.invocationId)) return false;
  const unresolved = value.status !== "completed" && value.effectStarted === false;
  if (value.toolRef === null) return unresolved && value.projectionDigest === null;
  if (!validReference("toolRef", value.toolRef)) return false;
  return (
    (unresolved && value.projectionDigest === null) ||
    validField(contract, "projectionDigest", value.projectionDigest)
  );
}
function validMetrics(value) {
  return (
    exactRecord(value, [...COUNT_FIELDS]) &&
    Object.values(value).every((count) => Number.isSafeInteger(count) && count >= 0)
  );
}
export function validateResultExample(contract, value) {
  if (!value || typeof value !== "object") return ["invalid result example"];
  const errors = [];
  if (!exactRecord(value, contract.interfaces.ToolResultEnvelope.fields))
    errors.push("result fields differ");
  if (!validResultPair(contract, value)) errors.push("invalid result pair");
  if (!validResultIdentity(contract, value)) errors.push("invalid result identity fields");
  if (!validMetrics(value.metrics)) errors.push("invalid result metrics");
  if (!validResultData(contract, value)) errors.push("invalid result data/page condition");
  if (typeof value.effectStarted !== "boolean") errors.push("invalid effect state");
  if (Buffer.byteLength(JSON.stringify(value)) > contract.bounds.maxResultBytes)
    errors.push("result too large");
  return errors;
}
