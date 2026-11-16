// A scope update that names a Knowledge Pod (or Pod Set) which does not exist, or is being deleted,
// must not bind it: the picker's list can be older than the store, and a chat bound to a vanished pod
// only fails later, at the turn. The check runs on the server, before any state changes (#4371).
//
// Only a source the update newly ADDS is judged. A source that is already bound and stays in the
// patch is left alone, so a pod that vanished after it was bound can neither block the rest of the
// scope nor be trapped in it: the person can always remove it.

import {
  getCapsule,
  getCapsuleSet,
  KnowledgeStoreError,
  type KnowledgeStore,
} from "@oscharko-dev/keiko-local-knowledge";
import type { KnowledgeScopeRefusalReason } from "./chat-scope-update-log.js";
import type { UiHandlerDeps } from "./deps.js";
import { openKnowledgeStoreForDeps } from "./local-knowledge-store-open.js";
import type { Chat, ChatLocalKnowledgeScope, UpdateChatPatch } from "./store/index.js";

export interface KnowledgeScopeRefusal {
  readonly reason: KnowledgeScopeRefusalReason;
  readonly status: 409 | 503;
  readonly code: "KNOWLEDGE_POD_UNAVAILABLE" | "KNOWLEDGE_STORE_UNAVAILABLE";
  readonly message: string;
}

const REFUSALS: Readonly<Record<KnowledgeScopeRefusalReason, KnowledgeScopeRefusal>> = {
  "knowledge-pod-missing": {
    reason: "knowledge-pod-missing",
    status: 409,
    code: "KNOWLEDGE_POD_UNAVAILABLE",
    message: "The selected Knowledge Pod no longer exists.",
  },
  "knowledge-pod-set-missing": {
    reason: "knowledge-pod-set-missing",
    status: 409,
    code: "KNOWLEDGE_POD_UNAVAILABLE",
    message: "The selected Knowledge Pod Set no longer exists.",
  },
  "knowledge-pod-deleting": {
    reason: "knowledge-pod-deleting",
    status: 409,
    code: "KNOWLEDGE_POD_UNAVAILABLE",
    message: "The selected Knowledge Pod is being deleted.",
  },
  "knowledge-store-unavailable": {
    reason: "knowledge-store-unavailable",
    status: 503,
    code: "KNOWLEDGE_STORE_UNAVAILABLE",
    message: "The Knowledge Pod store is unavailable, so the selection could not be checked.",
  },
};

function scopeKey(scope: ChatLocalKnowledgeScope): string {
  return scope.kind === "capsule"
    ? `capsule:${String(scope.capsuleId)}`
    : `set:${String(scope.capsuleSetId)}`;
}

type ScopeCarrier = Pick<Chat, "localKnowledgeScopes" | "localKnowledgeScope">;

function effectiveScopes(source: ScopeCarrier): readonly ChatLocalKnowledgeScope[] {
  return (
    source.localKnowledgeScopes ?? (source.localKnowledgeScope ? [source.localKnowledgeScope] : [])
  );
}

// The list supersedes the single field; `null` clears, which adds nothing.
function requestedScopes(patch: UpdateChatPatch): readonly ChatLocalKnowledgeScope[] {
  if (patch.localKnowledgeScopes !== undefined) return patch.localKnowledgeScopes ?? [];
  return patch.localKnowledgeScope ? [patch.localKnowledgeScope] : [];
}

function refusalForScope(
  store: KnowledgeStore,
  scope: ChatLocalKnowledgeScope,
): KnowledgeScopeRefusal | undefined {
  if (scope.kind === "capsule-set") {
    return getCapsuleSet(store, scope.capsuleSetId) === undefined
      ? REFUSALS["knowledge-pod-set-missing"]
      : undefined;
  }
  const capsule = getCapsule(store, scope.capsuleId);
  if (capsule === undefined) return REFUSALS["knowledge-pod-missing"];
  return capsule.lifecycleState === "deleting" ? REFUSALS["knowledge-pod-deleting"] : undefined;
}

export function refuseUnavailableKnowledgeScopes(
  deps: UiHandlerDeps,
  existing: Chat,
  patch: UpdateChatPatch,
): KnowledgeScopeRefusal | undefined {
  const bound = new Set(effectiveScopes(existing).map(scopeKey));
  const added = requestedScopes(patch).filter((scope) => !bound.has(scopeKey(scope)));
  if (added.length === 0) return undefined;
  let session: ReturnType<typeof openKnowledgeStoreForDeps>;
  try {
    session = openKnowledgeStoreForDeps(deps, { recover: false });
  } catch (error) {
    if (error instanceof KnowledgeStoreError) return REFUSALS["knowledge-store-unavailable"];
    throw error;
  }
  try {
    for (const scope of added) {
      const refusal = refusalForScope(session.store, scope);
      if (refusal !== undefined) return refusal;
    }
    return undefined;
  } finally {
    session.close();
  }
}
