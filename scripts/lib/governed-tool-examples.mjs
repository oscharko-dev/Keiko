import { Buffer } from "node:buffer";
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
  if (!value || typeof value !== "object") return false;
  if (key === "profile")
    return ID.test(value.id) && Number.isSafeInteger(value.version) && value.version > 0;
  return (
    /^keiko\.[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/.test(value.canonicalId) &&
    Number.isSafeInteger(value.contractVersion) &&
    value.contractVersion > 0
  );
}
function validField(contract, key, value) {
  if (COUNT_FIELDS.has(key)) return Number.isSafeInteger(value) && value >= 0;
  if (DIGEST_FIELDS.has(key)) return typeof value === "string" && DIGEST.test(value);
  if (ID_FIELDS.has(key)) return typeof value === "string" && ID.test(value);
  if (key === "profile" || key === "toolRef") return validReference(key, value);
  return validEnumField(contract, key, value);
}
function validEnumField(contract, key, value) {
  if (key === "readiness") return contract.readiness.includes(value);
  if (key === "state") return value === "started";
  if (key === "effectStarted" || key === "truncated") return typeof value === "boolean";
  if (key === "budgetDisposition")
    return new Set(["committed", "released", "not-reserved"]).has(value);
  if (key === "frames" || key === "causeChain") return Array.isArray(value);
  return typeof value === "string";
}
function phaseProblems(contract, phase, value) {
  const errors = [];
  if (phase === "terminal" && !contract.statuses[value.status]?.includes(value.reason))
    errors.push("invalid terminal pair");
  if (phase !== "terminal" && value.status !== undefined) errors.push("premature terminal status");
  if (phase === "invocation-started" && value.reason !== "none")
    errors.push("invalid started reason");
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
  if (!page || typeof page !== "object") return false;
  const { truncated, reason, cursor } = page;
  if (typeof truncated !== "boolean" || !contract.pagination.reasons.includes(reason)) return false;
  if (!truncated && (reason !== "none" || cursor !== null)) return false;
  if (truncated && reason === "none") return false;
  return validCursor(cursor, contract.bounds.maxCursorBytes);
}
function validResultData(contract, value) {
  if (value.status === "completed") return value.data !== null && validPage(contract, value.page);
  return value.data === null && value.page === null;
}
function validResultPair(contract, value) {
  return value.schemaVersion === 1 && contract.statuses[value.status]?.includes(value.reason);
}
export function validateResultExample(contract, value) {
  if (!value || typeof value !== "object") return ["invalid result example"];
  const fields = contract.interfaces.ToolResultEnvelope.fields;
  const errors = [];
  if (Object.keys(value).length !== fields.length || fields.some((key) => !(key in value)))
    errors.push("result fields differ");
  if (!validResultPair(contract, value)) errors.push("invalid result pair");
  if (!validResultData(contract, value)) errors.push("invalid result data/page condition");
  if (typeof value.effectStarted !== "boolean") errors.push("invalid effect state");
  if (Buffer.byteLength(JSON.stringify(value)) > contract.bounds.maxResultBytes)
    errors.push("result too large");
  return errors;
}
