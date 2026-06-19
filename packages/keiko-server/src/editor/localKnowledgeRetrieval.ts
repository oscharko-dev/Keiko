// Shared query-only Local Knowledge retrieval for the editor coding-context service (Issue #1211).
// Both the context-pack provider and the /api/editor/local-knowledge/retrieve route run the same
// governed four-step dance — resolve scope, check capsule ready-state, build the embedding adapter
// (identity-consistency enforced), run retrieval WITHOUT answer generation — so it lives here once
// rather than as a parallel implementation. Callers own the KnowledgeStore lifecycle and map the
// discriminated outcome to their surface (omission vs RouteResult).

import type {
  CapsuleSetId,
  KnowledgeCapsuleId,
  RetrievalReference,
} from "@oscharko-dev/keiko-contracts";
import type { ChatLocalKnowledgeScope } from "@oscharko-dev/keiko-contracts/bff-wire";
import { runLocalKnowledgeRetrieval } from "@oscharko-dev/keiko-local-knowledge";
import type { KnowledgeStore } from "@oscharko-dev/keiko-local-knowledge";
import type { UiHandlerDeps } from "../deps.js";
import type { RouteResult } from "../routes.js";
import {
  createEmbeddingAdapter,
  scopeStateFailure,
  selectedCapsulesForScope,
} from "../local-knowledge-grounded-qa.js";

export type EditorLocalKnowledgeOutcome =
  | {
      readonly kind: "ok";
      readonly references: readonly RetrievalReference[];
      readonly noEvidence: boolean;
      readonly reason: string | undefined;
    }
  | { readonly kind: "conflict"; readonly routeResult: RouteResult }
  | { readonly kind: "not-ready"; readonly reason: string; readonly message: string };

// Builds a typed Local Knowledge scope from plain string ids. Exactly one id must be present; the
// connectedAtMs field is irrelevant to retrieval (it is a chat-binding timestamp) so it is zeroed.
export function buildLocalKnowledgeScope(
  capsuleId: string | undefined,
  capsuleSetId: string | undefined,
): ChatLocalKnowledgeScope | undefined {
  if ((capsuleId === undefined) === (capsuleSetId === undefined)) {
    return undefined;
  }
  if (capsuleId !== undefined) {
    return { kind: "capsule", capsuleId: capsuleId as KnowledgeCapsuleId, connectedAtMs: 0 };
  }
  return { kind: "capsule-set", capsuleSetId: capsuleSetId as CapsuleSetId, connectedAtMs: 0 };
}

export async function retrieveEditorLocalKnowledge(
  deps: UiHandlerDeps,
  store: KnowledgeStore,
  scope: ChatLocalKnowledgeScope,
  queryText: string,
  signal: AbortSignal,
): Promise<EditorLocalKnowledgeOutcome> {
  const selected = selectedCapsulesForScope(scope, store);
  if ("status" in selected) {
    return { kind: "conflict", routeResult: selected };
  }
  const stateFailure = scopeStateFailure(selected);
  if (stateFailure !== undefined) {
    return { kind: "not-ready", reason: stateFailure.reason, message: stateFailure.message };
  }
  const adapter = createEmbeddingAdapter(deps, selected.capsules);
  if ("status" in adapter) {
    return { kind: "conflict", routeResult: adapter };
  }
  const retrieval = await runLocalKnowledgeRetrieval(
    { store, embeddingAdapter: adapter, signal },
    {
      text: queryText,
      ...(scope.kind === "capsule" ? { capsuleId: scope.capsuleId } : {}),
      ...(scope.kind === "capsule-set" ? { capsuleSetId: scope.capsuleSetId } : {}),
    },
  );
  return {
    kind: "ok",
    references: retrieval.references,
    noEvidence: retrieval.noEvidence,
    reason: retrieval.reason,
  };
}
