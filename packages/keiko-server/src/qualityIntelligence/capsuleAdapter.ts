// capsuleAdapter.ts — capsule-corpus resolver seam for QI ingestion (Epic #710, Issue #717).
//
// Opens the Local Knowledge store lazily on the first call (once per resolver lifetime),
// then reads the full document corpus for any capsule OR capsule-set via the approved
// keiko-local-knowledge QI handoff seam. Store-open failures are handled by returning an empty
// array — the caller maps that to QI_CAPSULE_UNAVAILABLE. When uiDbPath is not set the resolver
// cannot be built (returns undefined); the ingestion layer then rejects capsule sources with
// QI_CAPSULE_UNAVAILABLE.
//
// #3532: the store is opened with the process-wide Activity Log port, like every other knowledge
// store open, so its recovery evidence reaches the log; and an open or read failure is no longer
// swallowed. It is reported once through the operator diagnostic path — content-free class, frames
// and cause chain only — before the resolver degrades to the empty result the caller maps to
// QI_CAPSULE_UNAVAILABLE.

import { dirname } from "node:path";
import {
  openKnowledgeStore,
  resolveKnowledgeStorePath,
  QualityIntelligenceHandoff,
} from "@oscharko-dev/keiko-local-knowledge";
import { correlationIdOrUnknown } from "../correlation.js";
import type { UiHandlerDeps } from "../deps.js";
import {
  emitServerDiagnostic,
  serverDiagnosticFromError,
  type ServerDiagnosticSummary,
} from "../diagnostics-log.js";
import { localKnowledgeProtectionOptions } from "../localKnowledgeKeyProvider.js";
import { processServerLogSink } from "../process-log-sink.js";

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
 *
 * `close` releases the underlying SQLite handle; must be called once per resolver lifetime (e.g. in
 * the finally block of executeQiRun) to prevent a handle leak per QI run.
 */
export interface CapsuleResolver {
  readonly capsule: (capsuleId: string) => readonly CapsuleDocumentText[];
  readonly capsuleSet: (capsuleSetId: string) => readonly CapsuleDocumentText[];
  readonly close: () => void;
}

const CAPSULE_STORE_OPEN_FAILED: ServerDiagnosticSummary =
  "Quality Intelligence could not open the knowledge store for a capsule source.";
const CAPSULE_STORE_READ_FAILED: ServerDiagnosticSummary =
  "Quality Intelligence could not read a capsule source from the knowledge store.";

function reportCapsuleStoreFailure(
  deps: UiHandlerDeps,
  correlationId: string,
  summary: ServerDiagnosticSummary,
  error: unknown,
): void {
  emitServerDiagnostic(
    deps.diagnostics,
    serverDiagnosticFromError({
      correlationId,
      operation: "quality-intelligence.capsule-source",
      source: "qi.capsule-adapter",
      error,
      summary,
      redact: () => "server-operation-failed",
    }),
  );
}

/**
 * Builds a CapsuleResolver that opens the LK store ONCE (per resolver) and returns the full corpus
 * text for any capsule or capsule-set. Returns `undefined` when `deps.uiDbPath` is not set.
 * Store-open errors produce a resolver whose methods always return `[]`; the open failure and any
 * read failure are reported on the operator diagnostic path under `correlationId`.
 */
export function makeCapsuleResolver(
  deps: UiHandlerDeps,
  correlationId?: string,
): CapsuleResolver | undefined {
  const uiDbPath = deps.uiDbPath;
  if (uiDbPath === undefined || uiDbPath.length === 0) return undefined;

  const dbPath = resolveKnowledgeStorePath({ runtimeStateDir: dirname(uiDbPath) });
  const protection = localKnowledgeProtectionOptions(deps.localKnowledgeKeyProvider);
  const diagnosticCorrelationId = correlationIdOrUnknown(correlationId);
  let store: ReturnType<typeof openKnowledgeStore> | null = null;
  let openFailed = false;

  const ensureStore = (): ReturnType<typeof openKnowledgeStore> | null => {
    if (openFailed) return null;
    if (store !== null) return store;
    try {
      const logSink = processServerLogSink();
      store = openKnowledgeStore(
        protection === undefined ? { dbPath, logSink } : { dbPath, protection, logSink },
      );
      return store;
    } catch (error) {
      openFailed = true;
      reportCapsuleStoreFailure(deps, diagnosticCorrelationId, CAPSULE_STORE_OPEN_FAILED, error);
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
    } catch (error) {
      reportCapsuleStoreFailure(deps, diagnosticCorrelationId, CAPSULE_STORE_READ_FAILED, error);
      return [];
    }
  };

  return {
    capsule: (capsuleId) => read(capsuleId, QualityIntelligenceHandoff.listCapsuleDocumentTexts),
    capsuleSet: (capsuleSetId) =>
      read(capsuleSetId, QualityIntelligenceHandoff.listCapsuleSetDocumentTexts),
    close: (): void => {
      store?.close();
    },
  };
}
