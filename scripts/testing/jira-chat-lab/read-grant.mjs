import assert from "node:assert/strict";

/**
 * The read grant a user turn's transcript carries. The server establishes it itself when the person
 * has connected the Pod or MCP server to the Chat (owner decision 2026-11-02); a human never decides
 * it, so a grant is never `pending` and no consent route exists.
 */
export function establishedReadGrant(user) {
  const grant = user?.toolTranscript?.readGrant;
  if (grant === undefined) return undefined;
  assert.notEqual(grant.state, "pending", "A read grant must never wait for a human decision");
  assert.equal(grant.state, "granted", "A read grant is established by the server");
  return grant;
}

/** True when the Chat window shows a card that asks the person to allow reading. */
export async function consentCardCount(region) {
  return region.getByRole("button", { name: "Allow reading", exact: true }).count();
}
