// Epic #532 — bridge the desktop window-connector to the governed relationship engine.
//
// When the user draws a Files↔Chat edge in the workspace, that connection IS a `reads-context`
// relationship (a chat reads the context of a workspace folder, per taxonomy.md). The older
// connector layer only persisted the folder onto the chat's connectedScopes for grounding; this
// helper additionally records the connection in the relationship engine so the green edge becomes
// a validated, audited, queryable relationship — one governed model instead of two parallel ones.
//
// It is strictly best-effort and fire-and-forget: a failure here (engine unreachable, endpoint not
// yet live, validation denial) must NEVER break the scope bind that actually makes grounding work.

import { createRelationship, RelationshipApiError } from "./api";

// Deterministic, regex-safe (`[A-Za-z0-9._-]{8,64}`) idempotency key per (chat, folder) pair, so
// reconnecting the same folder dedups to one relationship within the idempotency window instead of
// piling up duplicates. FNV-1a over the pair; collision-resistant enough for this UI gesture.
function stableKey(chatId: string, workspacePath: string): string {
  let h = 2166136261;
  const input = `${chatId}|${workspacePath}`;
  for (let i = 0; i < input.length; i += 1) {
    h = Math.imul(h ^ input.charCodeAt(i), 16777619);
  }
  return `rc-${(h >>> 0).toString(36)}-${(input.length & 0xffff).toString(36)}`;
}

export function recordReadsContextRelationship(chatId: string, workspacePath: string): void {
  if (chatId.length === 0 || workspacePath.length === 0) return;
  void createRelationship(
    {
      type: "reads-context",
      source: { kind: "chat", id: chatId },
      target: { kind: "workspace-path", id: workspacePath },
    },
    stableKey(chatId, workspacePath),
  ).catch((error: unknown) => {
    // Swallow: the connection still works for grounding even if the governance record fails. A
    // RelationshipApiError (e.g. a future cardinality/policy change) is an expected, non-fatal path.
    if (!(error instanceof RelationshipApiError) && !(error instanceof Error)) {
      // Non-Error rejection — nothing actionable; ignore.
    }
  });
}
