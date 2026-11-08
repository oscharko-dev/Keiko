// Independent lab reads shared by the API qualification case tables: every oracle goes straight to
// Jira with the lab actor's credentials, never through Keiko.
import assert from "node:assert/strict";
import { basicAuth, labRequest } from "./lab-client.mjs";

export const proof = (assertionCount) => ({ matched: true, assertionCount });

export async function read(context, path) {
  const response = await labRequest(
    context.session,
    "GET",
    path,
    basicAuth(context.session, context.actor),
  );
  assert.equal(response.status, 200);
  return response.value;
}

/** Reads one record by the numeric id Keiko returned and checks the native record carries it. */
export async function readRecord(context, id, path) {
  assert.match(id, /^[1-9][0-9]*$/u);
  const value = await read(context, path);
  assert.equal(String(value.id), id);
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
