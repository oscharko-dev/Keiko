// Evidence accounting is independent of execution. Local failures never become native denials.
import { createHash } from "node:crypto";

export const qualificationDigest = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function matchesNativeIdentity(identity, method, pathname) {
  const [expectedMethod, template] = identity.split(" ");
  if (method !== expectedMethod) return false;
  const expected = template.split("/");
  const actual = pathname.split("/");
  return (
    expected.length === actual.length &&
    expected.every((part, index) =>
      /^\{[A-Za-z][A-Za-z0-9_-]*\}$/u.test(part)
        ? actual[index].length > 0
        : part === actual[index],
    )
  );
}

function matchesBinding(identity, binding, dispatch) {
  if (binding?.identity !== identity || dispatch?.kind !== "settled") return false;
  const data = dispatch.result?.data;
  return (
    data?.operationBinding?.identity === identity &&
    data.operationBinding.contractDigest === binding.contractDigest
  );
}
function observedResponses(witness) {
  return (
    witness.blocked === 0 &&
    witness.responses.length > 0 &&
    witness.responses.every(
      (response) =>
        (response.truncated === false || response.statusOnly === true) &&
        Number.isInteger(response.status) &&
        response.status >= 100 &&
        response.status < 600,
    )
  );
}
/** A 400 counts only when the readback proved a sibling wildcard route answered for the path. */
const absentStatuses = (statuses, readback) =>
  statuses.every((status) => status === 404 || status === 405) ||
  (readback.routeShadowed === true && statuses.every((status) => status === 400));
function nativeRefusal(statuses, data, readback) {
  if (statuses.every((status) => status === 403) && data.reason === "permission-denied")
    return readback?.permissionDenied === true ? "denied" : "unknown";
  // A resource 404, transport failure or Keiko codec refusal does not prove missing capability.
  if (readback?.capabilityAbsent === true && absentStatuses(statuses, readback))
    return "unavailable";
  return undefined;
}
function successfulJournal(journal, outcome) {
  return (
    journal === undefined ||
    (journal.phase === "settled" &&
      new Set(["succeeded", "succeeded-unconfirmed"]).has(journal.outcome) &&
      journal.outcome === outcome)
  );
}
/**
 * A readback grades only when assertions actually held while it ran. The recipe's declared
 * `assertionCount` is a documentation hint: the driver measures the assertions that held, and a
 * readback that asserted nothing proves nothing however many it declares.
 */
function matchedReadback(readback) {
  return (
    readback?.matched === true &&
    Number.isSafeInteger(readback.measuredAssertionCount) &&
    readback.measuredAssertionCount > 0
  );
}
/**
 * The only non-2xx native statuses a recipe may declare as the documented answer for a read: the
 * plain 404 Jira gives while the addressed singleton does not exist (`GET /rest/api/2/reindex`
 * before any reindex task ran). 405 stays reserved for proven capability absence, other 4xx and 5xx
 * never grade as executable.
 */
const DOCUMENTED_NATIVE_STATUSES = new Set([404]);
function nativeSuccessStatuses(statuses, readback, mutation) {
  if (statuses.every((status) => status >= 200 && status < 300)) return true;
  const documented = readback?.documentedNativeStatuses;
  return (
    mutation !== true &&
    Array.isArray(documented) &&
    documented.length > 0 &&
    documented.every((status) => DOCUMENTED_NATIVE_STATUSES.has(status)) &&
    statuses.every((status) => documented.includes(status))
  );
}
/**
 * `priorPresence` counts only when the recipe measurably read, natively and before the dispatch,
 * the exact object the DELETE removed: a read path must equal the pathname the witness saw the
 * DELETE use. A read of any other object proves nothing about this deletion.
 */
const provenPriorPresence = (readback, witness) =>
  readback?.priorPresence === true &&
  Number.isSafeInteger(readback.measuredPresenceReads) &&
  readback.measuredPresenceReads > 0 &&
  Array.isArray(readback.presenceReadPaths) &&
  Array.isArray(witness?.responses) &&
  witness.responses.length > 0 &&
  witness.responses.every(
    (response) =>
      typeof response.path === "string" && readback.presenceReadPaths.includes(response.path),
  );
function observedReceipt(dispatch) {
  const receipt = dispatch.receipt;
  return (
    receipt?.status === dispatch.result.status &&
    receipt.effectStarted === true &&
    receipt.budgetDisposition === "committed"
  );
}
/**
 * The product never reads a post-write 404 as completed absence, so after a native 2xx DELETE its
 * own fresh read of the removed resource may answer "not-found" instead of "unavailable". "Not
 * found" proves a deletion only for an object the recipe itself proved present natively before the
 * DELETE (`readback.priorPresence`); without that proof the identity stays unknown. The product's
 * own disposition is never reinterpreted, and every other condition still applies.
 */
const unconfirmedReason = (identity, reason, readback, witness) =>
  reason === "unavailable" ||
  (identity.startsWith("DELETE ") &&
    reason === "not-found" &&
    provenPriorPresence(readback, witness));
function settledNativeAcknowledgement(
  identity,
  dispatch,
  statuses,
  journal,
  mutation,
  readback,
  witness,
) {
  const data = dispatch.result.data;
  if (data.outcome === "succeeded") return dispatch.result.status === "completed";
  return (
    mutation === true &&
    dispatch.result.status === "failed" &&
    data.outcome === "succeeded-unconfirmed" &&
    unconfirmedReason(identity, data.reason, readback, witness) &&
    journal?.phase === "settled" &&
    journal.outcome === "succeeded-unconfirmed" &&
    statuses.every((status) => status === journal.httpStatus)
  );
}
function executableObservation(identity, dispatch, statuses, evidence) {
  const { readback, journal, mutation, witness } = evidence;
  return (
    settledNativeAcknowledgement(
      identity,
      dispatch,
      statuses,
      journal,
      mutation,
      readback,
      witness,
    ) &&
    nativeSuccessStatuses(statuses, readback, mutation) &&
    new Set(["succeeded", "succeeded-unconfirmed"]).has(dispatch.result.data.outcome) &&
    matchedReadback(readback) &&
    successfulJournal(journal, dispatch.result.data.outcome)
  );
}

/** Only a native refusal at the exact bound endpoint establishes denied/unavailable. */
export function classifyQualification({
  identity,
  binding,
  dispatch,
  journal,
  witness,
  readback,
  mutation,
}) {
  if (matchesBinding(identity, binding, dispatch) !== true || !observedResponses(witness))
    return "unknown";
  if (!observedReceipt(dispatch)) return "unknown";
  if (mutation && journal === undefined) return "unknown";
  const statuses = witness.responses.map((response) => response.status);
  const data = dispatch.result.data;
  const refusal = nativeRefusal(statuses, data, readback);
  if (refusal !== undefined) return refusal;
  return executableObservation(identity, dispatch, statuses, {
    readback,
    journal,
    mutation,
    witness,
  })
    ? "executable"
    : "unknown";
}

export function qualificationSummary(operations) {
  const counts = { executable: 0, denied: 0, unavailable: 0, deferred: 0, unknown: 0 };
  for (const operation of operations) {
    if (!Object.hasOwn(counts, operation.runtimeAvailability))
      throw new TypeError("Unknown qualification disposition");
    counts[operation.runtimeAvailability] += 1;
  }
  return counts;
}

/**
 * Reads whose native collection was empty under a reviewed declaration. They stay executable (the
 * governed call ran and matched) but are listed separately: they prove no projection of any row.
 */
export const executableVacuousCount = (operations) =>
  vacuousReads(operations.filter((operation) => operation.runtimeAvailability === "executable"))
    .length;

export function vacuousReads(operations) {
  return operations
    .filter((operation) => operation.readback?.vacuous === true)
    .map((operation) => operation.identity)
    .sort((left, right) => left.localeCompare(right, "en"));
}

/** A report covers one exact source, release and complete inventory; no cross-run pooling. */
export function isApprovedDeferred(row, decisions) {
  const decision = decisions.get(row.identity);
  return (
    row.runtimeAvailability === "deferred" &&
    decision !== undefined &&
    qualificationDigest(row.ownerDecision) === qualificationDigest(decision) &&
    Array.isArray(row.verificationReferences) &&
    row.verificationReferences.length === 1 &&
    row.verificationReferences[0] === decision.reference
  );
}
export function applyQualificationReport(ledger, report, sourceRevision, decisions = new Map()) {
  if (
    report.schemaVersion !== 1 ||
    report.sourceRevision !== sourceRevision ||
    report.inventoryDigest !== qualificationDigest(ledger.operations.map((row) => row.identity))
  )
    throw new TypeError("Qualification report is not bound to this inventory and source");
  const rows = new Map(report.operations.map((row) => [row.identity, row]));
  if (rows.size !== report.operations.length || rows.size !== ledger.operations.length)
    throw new TypeError("Qualification report has missing or duplicate identities");
  const operations = ledger.operations.map((row) => {
    const proof = rows.get(row.identity);
    if (!proof || proof.runtimeAvailability === "unknown")
      throw new TypeError("Incomplete qualification cannot replace the operation ledger");
    if (
      (!new Set(["executable", "denied", "unavailable"]).has(proof.runtimeAvailability) &&
        !isApprovedDeferred(proof, decisions)) ||
      !Array.isArray(proof.verificationReferences) ||
      proof.verificationReferences.length === 0
    )
      throw new TypeError("Native qualification requires verification references");
    return {
      ...row,
      runtimeAvailability: proof.runtimeAvailability,
      verificationReferences: [...proof.verificationReferences],
      ...(proof.runtimeAvailability === "deferred"
        ? { ownerDecision: { ...proof.ownerDecision } }
        : {}),
    };
  });
  return { ...ledger, operations };
}
