// capsuleAdapter.ts — capsule-corpus resolver seam for QI ingestion (Epic #710, Issue #717).
//
// Opens the Local Knowledge store lazily on the first call (once per resolver lifetime),
// then reads the full document corpus for any capsule OR capsule-set via the approved
// keiko-local-knowledge QI handoff seam. Store-open failures are handled by returning an empty
// array — the caller maps that to QI_CAPSULE_UNAVAILABLE. When uiDbPath is not set the resolver
// cannot be built (returns undefined); the ingestion layer then rejects capsule sources with
// QI_CAPSULE_UNAVAILABLE.

import { dirname } from "node:path";
import {
  openKnowledgeStore,
  resolveKnowledgeStorePath,
  QualityIntelligenceHandoff,
} from "@oscharko-dev/keiko-local-knowledge";
import type { UiHandlerDeps } from "../deps.js";

/** One indexed document's id + full normalized text, read through the LK QI handoff seam. */
export interface CapsuleDocumentText {
  readonly documentId: string;
  readonly text: string;
}

/**
 * Resolves the full corpus text for a connected Local Knowledge connector. `capsule` reads a single
 * capsule; `capsuleSet` fans out over a capsule-set's members. Both share one lazily-opened store
 * handle and return `[]` on any failure (unknown id, store-open error) so the ingestion layer maps
 * the empty result to a coded, user-actionable QI_CAPSULE_UNAVAILABLE error.
 */
export interface CapsuleResolver {
  readonly capsule: (capsuleId: string) => readonly CapsuleDocumentText[];
  readonly capsuleSet: (capsuleSetId: string) => readonly CapsuleDocumentText[];
}

/**
 * Builds a CapsuleResolver that opens the LK store ONCE (per resolver) and returns the full corpus
 * text for any capsule or capsule-set. Returns `undefined` when `deps.uiDbPath` is not set.
 * Store-open errors produce a resolver whose methods always return `[]`.
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

  const read = (
    id: string,
    reader: (
      s: ReturnType<typeof openKnowledgeStore>,
      id: string,
    ) => readonly CapsuleDocumentText[],
  ): readonly CapsuleDocumentText[] => {
    const s = ensureStore();
    if (s === null) return [];
    try {
      return reader(s, id);
    } catch {
      return [];
    }
  };

  return {
    capsule: (capsuleId) => read(capsuleId, QualityIntelligenceHandoff.listCapsuleDocumentTexts),
    capsuleSet: (capsuleSetId) =>
      read(capsuleSetId, QualityIntelligenceHandoff.listCapsuleSetDocumentTexts),
  };
}
