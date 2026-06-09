// capsuleAdapter.ts — capsule-corpus resolver seam for QI ingestion (Epic #710, Issue #717).
//
// Opens the Local Knowledge store lazily on the first call (once per resolver lifetime),
// then reads the full document corpus for any capsule id via listCapsuleDocumentTexts.
// Store-open failures are handled by returning an empty array — the caller maps that to
// QI_CAPSULE_UNAVAILABLE. When uiDbPath is not set the resolver cannot be built (returns
// undefined); the ingestion layer then rejects capsule sources with QI_CAPSULE_UNAVAILABLE.

import { dirname } from "node:path";
import {
  openKnowledgeStore,
  resolveKnowledgeStorePath,
  QualityIntelligenceHandoff,
} from "@oscharko-dev/keiko-local-knowledge";
import type { UiHandlerDeps } from "../deps.js";

export type CapsuleResolver = (
  capsuleId: string,
) => readonly { readonly documentId: string; readonly text: string }[];

/**
 * Builds a CapsuleResolver that opens the LK store ONCE (per resolver) and returns the
 * full corpus text for any capsule. Returns `undefined` when `deps.uiDbPath` is not set.
 * Store-open errors produce a resolver that always returns `[]`.
 */
export function makeCapsuleResolver(deps: UiHandlerDeps): CapsuleResolver | undefined {
  const uiDbPath = deps.uiDbPath;
  if (uiDbPath === undefined || uiDbPath.length === 0) return undefined;

  const dbPath = resolveKnowledgeStorePath({ runtimeStateDir: dirname(uiDbPath) });
  let store: ReturnType<typeof openKnowledgeStore> | null = null;
  let openFailed = false;

  const ensureStore = (): ReturnType<typeof openKnowledgeStore> | null => {
    if (openFailed) return null;
    if (store !== null) return store;
    try {
      store = openKnowledgeStore({ dbPath });
      return store;
    } catch {
      openFailed = true;
      return null;
    }
  };

  return (capsuleId: string) => {
    const s = ensureStore();
    if (s === null) return [];
    try {
      return QualityIntelligenceHandoff.listCapsuleDocumentTexts(s, capsuleId);
    } catch {
      return [];
    }
  };
}
