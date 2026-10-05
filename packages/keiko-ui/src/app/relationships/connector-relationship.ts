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

import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import { clientErrorEvidence } from "@/lib/client-error-evidence";
import { bffRequestErrorKind } from "@/lib/http";
import { ApiError } from "@/lib/api-shared-primitives";

// Deterministic, regex-safe (`[A-Za-z0-9._-]{8,64}`) idempotency key per (chat, folder) pair, so
// reconnecting the same folder dedups to one relationship within the idempotency window instead of
// piling up duplicates. FNV-1a over the pair; collision-resistant enough for this UI gesture.
function stableKey(chatId: string, workspacePath: string): string {
  let h = 2166136261;
  const input = `${chatId}|${workspacePath}`;
  for (let i = 0; i < input.length; i += 1) {
    h = Math.imul(h ^ (input.codePointAt(i) ?? 0), 16777619);
  }
  return `rc-${(h >>> 0).toString(36)}-${(input.length & 0xffff).toString(36)}`;
}

function relationshipRecordErrorKind(
  error: unknown,
  api: typeof import("./api") | undefined,
): ReturnType<typeof bffRequestErrorKind> {
  if (api !== undefined && error instanceof api.RelationshipApiError)
    return bffRequestErrorKind(
      new ApiError(error.code, "Relationship request failed.", error.status),
    );
  return bffRequestErrorKind(error);
}

async function persistReadsContextRelationship(
  chatId: string,
  workspacePath: string,
  correlationId: string,
): Promise<void> {
  let api: typeof import("./api") | undefined;
  try {
    api = await import("./api");
    await api.createRelationship(
      {
        type: "reads-context",
        source: { kind: "chat", id: chatId },
        target: { kind: "workspace-path", id: workspacePath },
      },
      stableKey(chatId, workspacePath),
    );
  } catch (error) {
    reportClientDiagnostic("Files relationship recording failed.", {
      kind: "other",
      correlationId,
      errorKind: relationshipRecordErrorKind(error, api),
      errorEvidence: clientErrorEvidence(error),
    });
  }
}

export function recordReadsContextRelationship(
  chatId: string,
  workspacePath: string,
  correlationId: string,
): void {
  if (chatId.length === 0 || workspacePath.length === 0) return;
  void persistReadsContextRelationship(chatId, workspacePath, correlationId);
}

// Issue #3400 (epic #3384) — a git-change target does NOT use this best-effort, fire-and-forget
// pattern. Unlike the Files↔Chat edge above (recorded here AFTER an already-successful client-side
// scope bind), a git-change relationship is a server-issued fact: the server resolves the trusted
// repository, captures the immutable snapshot, creates the `reads-context` relationship, AND
// persists the resulting `ChatGitChangeScope` onto the chat row in ONE atomic call
// (`POST /api/git-change/connect`, `@/lib/api`'s `connectGitChangeToChat`). Calling
// `recordReadsContextRelationship`-style client-side creation for a git-change target would
// double-create the relationship and let the browser author a target it cannot validate — exactly
// what the architecture invariants forbid ("the browser sends only a server-issued scope
// reference"). The Git-window connect affordance calls `connectGitChangeToChat` directly; nothing
// in this file wraps it.
