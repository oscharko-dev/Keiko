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
        response.truncated === false &&
        Number.isInteger(response.status) &&
        response.status >= 100 &&
        response.status < 600,
    )
  );
}
function nativeRefusal(statuses, data, readback) {
  if (statuses.every((status) => status === 403) && data.reason === "permission-denied")
    return readback?.permissionDenied === true ? "denied" : "unknown";
  // A resource 404, transport failure or Keiko codec refusal does not prove missing capability.
  if (
    statuses.every((status) => status === 404 || status === 405) &&
    readback?.capabilityAbsent === true
  )
    return "unavailable";
  return undefined;
}
function successfulJournal(journal) {
  return (
    journal === undefined ||
    (journal.phase === "settled" &&
      new Set(["succeeded", "succeeded-unconfirmed"]).has(journal.outcome))
  );
}
function matchedReadback(readback) {
  return (
    readback?.matched === true &&
    Number.isSafeInteger(readback.assertionCount) &&
    readback.assertionCount > 0
  );
}
function observedReceipt(dispatch) {
  const receipt = dispatch.receipt;
  return (
    receipt?.status === dispatch.result.status &&
    receipt.effectStarted === true &&
    receipt.budgetDisposition === "committed"
  );
}
function executableObservation(dispatch, statuses, readback, journal) {
  return (
    dispatch.result.status === "completed" &&
    statuses.every((status) => status >= 200 && status < 300) &&
    new Set(["succeeded", "succeeded-unconfirmed"]).has(dispatch.result.data.outcome) &&
    matchedReadback(readback) &&
    successfulJournal(journal)
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
  return executableObservation(dispatch, statuses, readback, journal) ? "executable" : "unknown";
}

export function qualificationSummary(operations) {
  const counts = { executable: 0, denied: 0, unavailable: 0, unknown: 0 };
  for (const operation of operations) {
    if (!Object.hasOwn(counts, operation.runtimeAvailability))
      throw new TypeError("Unknown qualification disposition");
    counts[operation.runtimeAvailability] += 1;
  }
  return counts;
}

/** A report covers one exact source, release and complete inventory; no cross-run pooling. */
export function applyQualificationReport(ledger, report, sourceRevision) {
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
      !new Set(["executable", "denied", "unavailable"]).has(proof.runtimeAvailability) ||
      !Array.isArray(proof.verificationReferences) ||
      proof.verificationReferences.length === 0
    )
      throw new TypeError("Native qualification requires verification references");
    return {
      ...row,
      runtimeAvailability: proof.runtimeAvailability,
      verificationReferences: [...proof.verificationReferences],
    };
  });
  return { ...ledger, operations };
}
