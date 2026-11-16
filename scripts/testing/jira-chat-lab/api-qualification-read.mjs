// Independent lab reads shared by the API qualification case tables: every oracle goes straight to
// Jira with the lab actor's credentials, never through Keiko.
import assert, { plumbingAssert, recordNativeRead } from "./api-qualification-assert.mjs";
import { basicAuth, labRequest } from "./lab-client.mjs";

/**
 * The declared `assertionCount` is a documentation hint only: the driver adds the measured count of
 * assertions that actually held, and only that measurement can grade an identity executable.
 */
export const proof = (assertionCount) => ({ matched: true, assertionCount });
/**
 * A proof for a native status other than 2xx that Jira documents for this exact state, e.g. the
 * plain 404 of `GET /rest/api/2/reindex` while no reindex task exists. It is valid only together
 * with an oracle that independently read the same native status and proved the state (the
 * grader additionally requires the dispatch witness to have observed exactly these statuses).
 */
export const documentedStatusProof = (assertionCount, documentedNativeStatuses) => ({
  ...proof(assertionCount),
  documentedNativeStatuses: [...documentedNativeStatuses],
});

/** The independent oracle could not read Jira as the lab actor: a lab fault, never a product one. */
export class NativeReadError extends Error {
  constructor(shape, status) {
    super(`Native read ${shape} answered ${status}`);
    this.name = "NativeReadError";
    this.nativeStatus = status;
  }
}
/**
 * The proof of a DELETE whose product read answers "not found": the recipe read the removed object
 * natively before the DELETE and reads it absent afterwards (api-qualification-evidence.mjs).
 */
export const deletionProof = (assertionCount) => ({
  ...proof(assertionCount),
  priorPresence: true,
});

export async function read(context, path) {
  const response = await labRequest(
    context.session,
    "GET",
    path,
    basicAuth(context.session, context.actor),
  );
  // The message names the route shape and status only; identifiers and query values stay out.
  const shape = path.split("?")[0].replace(/\d+/gu, "#");
  if (response.status !== 200) throw new NativeReadError(shape, response.status);
  recordNativeRead(path);
  return response.value;
}

/** Reads one record by the numeric id Keiko returned and checks the native record carries it. */
export async function readRecord(context, id, path) {
  plumbingAssert.match(id, /^[1-9][0-9]*$/u);
  const value = await read(context, path);
  plumbingAssert.equal(String(value.id), id);
  return value;
}

/** Asserts no listed native record carries the id. */
export function assertNoRecord(rows, id) {
  assert.equal(
    rows.some((row) => String(row.id) === id),
    false,
  );
  return proof(1);
}
