import type {
  CurrentPdfCitationPreviewSnapshot,
  PdfCitationPreviewAuthorizationResponse,
  PdfCitationPreviewDisplay,
  PdfCitationPreviewReasonCode,
  PdfCitationPreviewSelection,
  PdfCitationPreviewStatusRequest,
  PdfCitationPreviewStatusResponse,
  StoredPdfCitationPreviewCitation,
} from "@oscharko-dev/keiko-contracts";
import { pdfCitationPreviewFailureState } from "@oscharko-dev/keiko-contracts";
import {
  createSqliteAuditSink,
  lookupCitationPreviewSnapshot,
  type CitationPreviewSnapshotLookup,
} from "@oscharko-dev/keiko-local-knowledge";

import type { UiHandlerDeps } from "./deps.js";
import { openStoreForDeps } from "./local-knowledge-grounded-qa.js";
import { normalizePreviewMarkerIndex, previewDisplay } from "./local-knowledge-preview-authority.js";

type PreviewOutcome =
  | { readonly kind: "available"; readonly display: PdfCitationPreviewDisplay }
  | {
      readonly kind: "rejected";
      readonly reason: PdfCitationPreviewReasonCode;
      readonly display?: PdfCitationPreviewDisplay;
    };

type RejectedPreviewOutcome = Extract<PreviewOutcome, { readonly kind: "rejected" }>;
type SelectedPreviewCitations =
  | { readonly kind: "selected"; readonly citations: readonly StoredPdfCitationPreviewCitation[] }
  | RejectedPreviewOutcome;

function reject(
  reason: PdfCitationPreviewReasonCode,
  display?: PdfCitationPreviewDisplay,
): RejectedPreviewOutcome {
  return { kind: "rejected", reason, ...(display !== undefined ? { display } : {}) };
}

function isRejected(
  outcome: PreviewOutcome,
): outcome is RejectedPreviewOutcome {
  return outcome.kind === "rejected";
}

function citationDisplay(
  stored: StoredPdfCitationPreviewCitation,
  current?: CurrentPdfCitationPreviewSnapshot,
): PdfCitationPreviewDisplay {
  return previewDisplay(resolveCitationDisplayInput(stored, current));
}

// The projection is intentionally flat so the preview display uses one normalized source of truth.
// eslint-disable-next-line complexity
function resolveCitationDisplayInput(
  stored: StoredPdfCitationPreviewCitation,
  current?: CurrentPdfCitationPreviewSnapshot,
): Pick<
  StoredPdfCitationPreviewCitation,
  "documentLabel" | "sourceLabel" | "pageNumber" | "pageLabel" | "characterStart" | "characterEnd"
> {
  const input: Pick<
    StoredPdfCitationPreviewCitation,
    "documentLabel" | "sourceLabel" | "pageNumber" | "pageLabel" | "characterStart" | "characterEnd"
  > = {
    documentLabel: current?.documentLabel ?? stored.documentLabel,
  };
  assignOptionalCitationField(input, "sourceLabel", stored.sourceLabel);
  assignOptionalCitationField(input, "pageNumber", current?.pageNumber ?? stored.pageNumber);
  assignOptionalCitationField(input, "pageLabel", current?.pageLabel ?? stored.pageLabel);
  assignOptionalCitationField(
    input,
    "characterStart",
    current?.characterStart ?? stored.characterStart,
  );
  assignOptionalCitationField(input, "characterEnd", current?.characterEnd ?? stored.characterEnd);
  return input;
}

function assignOptionalCitationField<
  K extends "sourceLabel" | "pageNumber" | "pageLabel" | "characterStart" | "characterEnd",
>(
  target: Pick<
    StoredPdfCitationPreviewCitation,
    "documentLabel" | "sourceLabel" | "pageNumber" | "pageLabel" | "characterStart" | "characterEnd"
  >,
  key: K,
  value: StoredPdfCitationPreviewCitation[K] | undefined,
): void {
  if (value !== undefined) {
    target[key] = value;
  }
}

function isLocalKnowledgeGroundingKind(kind: string): boolean {
  return kind === "local-knowledge" || kind === "hybrid";
}

function selectedCitations(
  citations: readonly StoredPdfCitationPreviewCitation[],
  marker: string | number | undefined,
  stableId: string | undefined,
): SelectedPreviewCitations {
  let selected = citations;
  if (marker !== undefined) {
    const markerIndex = normalizePreviewMarkerIndex(marker);
    if (markerIndex === undefined) {
      return reject("citation-not-found");
    }
    selected = selected.filter((citation) => citation.markerIndex === markerIndex);
    if (selected.length === 0) {
      return reject("citation-not-found");
    }
  }
  if (stableId !== undefined) {
    const stableMatches = selected.filter((citation) => citation.stableId === stableId);
    if (stableMatches.length === 0) {
      return reject("stable-id-mismatch", selected[0] === undefined ? undefined : citationDisplay(selected[0]));
    }
    selected = stableMatches;
  }
  return { kind: "selected", citations: selected };
}

function currentDisplayForLookup(
  stored: StoredPdfCitationPreviewCitation,
  lookup: CitationPreviewSnapshotLookup,
): PdfCitationPreviewDisplay | undefined {
  return lookup.kind === "ok" ? citationDisplay(stored, lookup.snapshot) : citationDisplay(stored);
}

function storedCitationPrecheck(
  stored: StoredPdfCitationPreviewCitation,
  display: PdfCitationPreviewDisplay,
): RejectedPreviewOutcome | undefined {
  if (display.anchorQuality === "unavailable") {
    return reject("page-provenance-missing", display);
  }
  if (stored.documentMediaType !== "application/pdf") {
    return reject("document-not-pdf", display);
  }
  return undefined;
}

function currentSnapshotPrecheck(
  stored: StoredPdfCitationPreviewCitation,
  current: CurrentPdfCitationPreviewSnapshot,
  display: PdfCitationPreviewDisplay,
): RejectedPreviewOutcome | undefined {
  if (
    current.lineage.sourceId !== stored.lineage.sourceId ||
    current.lineage.documentId !== stored.lineage.documentId ||
    current.lineage.chunkId !== stored.lineage.chunkId
  ) {
    return reject("lineage-mismatch", display);
  }
  if (current.documentMediaType !== "application/pdf") {
    return reject("document-not-pdf", display);
  }
  if (current.documentStatus !== "extracted") {
    return reject("document-not-ready", display);
  }
  if (current.documentContentHash !== stored.documentContentHash) {
    return reject("document-content-mismatch", display);
  }
  if (current.pageNumber === undefined) {
    return reject("page-provenance-missing", display);
  }
  if (stored.pageNumber !== undefined && current.pageNumber !== stored.pageNumber) {
    return reject("lineage-mismatch", display);
  }
  return undefined;
}

function evaluateStoredCitation(
  store: ReturnType<typeof openStoreForDeps>["store"],
  stored: StoredPdfCitationPreviewCitation,
): PreviewOutcome {
  const storedDisplay = citationDisplay(stored);
  const initialFailure = storedCitationPrecheck(stored, storedDisplay);
  if (initialFailure !== undefined) return initialFailure;
  const lookup = lookupCitationPreviewSnapshot(store, stored.lineage.capsuleId, stored.lineage.chunkId);
  if (lookup.kind !== "ok") {
    return reject("lineage-missing", currentDisplayForLookup(stored, lookup));
  }
  const current = lookup.snapshot;
  const display = citationDisplay(stored, current);
  const currentFailure = currentSnapshotPrecheck(stored, current, display);
  if (currentFailure !== undefined) return currentFailure;
  return { kind: "available", display };
}

function emitPreviewAudit(
  store: ReturnType<typeof openStoreForDeps>["store"],
  citation: StoredPdfCitationPreviewCitation,
  outcome: PreviewOutcome,
): void {
  const sink = createSqliteAuditSink(store);
  const base = {
    capsuleId: citation.lineage.capsuleId,
    sourceIds: [citation.lineage.sourceId] as const,
    chunkIds: [String(citation.lineage.chunkId)] as const,
    targetQuality: citationDisplay(citation).anchorQuality,
    occurredAt: Date.now(),
  };
  if (outcome.kind === "available") {
    sink.emit({ kind: "citation-preview-authorized", ...base });
    return;
  }
  const state = pdfCitationPreviewFailureState(outcome.reason);
  if (state === "recoverable") {
    sink.emit({ kind: "citation-preview-recoverable", reasonCode: outcome.reason, ...base });
    return;
  }
  if (state === "blocked") {
    sink.emit({ kind: "citation-preview-blocked", reasonCode: outcome.reason, ...base });
  }
}

function loadMessageContext(
  deps: UiHandlerDeps,
  chatId: string,
  assistantMessageId: string,
): RejectedPreviewOutcome | {
  readonly citations: readonly StoredPdfCitationPreviewCitation[] | undefined;
} {
  const message = deps.store.findMessageById(assistantMessageId);
  if (message?.role !== "assistant") {
    return reject("assistant-message-not-found");
  }
  if (message.chatId !== chatId) {
    return reject("assistant-message-chat-mismatch");
  }
  const grounded = message.groundedAnswer;
  if (grounded === undefined) {
    return reject("grounded-answer-missing");
  }
  if (!isLocalKnowledgeGroundingKind(grounded.groundingKind)) {
    return reject("not-local-knowledge-citation");
  }
  return { citations: deps.store.findGroundedPreviewCitations(assistantMessageId) };
}

function firstRejectedByState(
  results: readonly PreviewOutcome[],
  state: "recoverable" | "blocked",
): RejectedPreviewOutcome | undefined {
  return results.find(
    (result) =>
      result.kind === "rejected" && pdfCitationPreviewFailureState(result.reason) === state,
  ) as RejectedPreviewOutcome | undefined;
}

function aggregateStatus(
  results: readonly PreviewOutcome[],
  matchedCitationCount: number,
): PdfCitationPreviewStatusResponse {
  const available = availableStatus(results, matchedCitationCount);
  if (available !== undefined) return available;
  const recoverable = firstRejectedByState(results, "recoverable");
  return recoverable !== undefined
    ? rejectedStatus("recoverable", recoverable, matchedCitationCount)
    : rejectedStatus("blocked", firstRejectedByState(results, "blocked"), matchedCitationCount);
}

function availableStatus(
  results: readonly PreviewOutcome[],
  matchedCitationCount: number,
): PdfCitationPreviewStatusResponse | undefined {
  const available = results.find((result) => result.kind === "available");
  return available?.kind === "available"
    ? { state: "available", display: available.display, matchedCitationCount }
    : undefined;
}

function rejectedStatus(
  state: "recoverable" | "blocked",
  failure: RejectedPreviewOutcome | undefined,
  matchedCitationCount: number,
): PdfCitationPreviewStatusResponse {
  return {
    state: failure === undefined && state === "blocked" ? "not-applicable" : state,
    ...(failure === undefined ? {} : { reason: failure.reason }),
    ...(failure?.display === undefined ? {} : { display: failure.display }),
    matchedCitationCount,
  };
}

export function getPdfCitationPreviewStatus(
  deps: UiHandlerDeps,
  input: PdfCitationPreviewStatusRequest,
): PdfCitationPreviewStatusResponse {
  const loaded = loadMessageContext(deps, input.chatId, input.assistantMessageId);
  if ("kind" in loaded) {
    return {
      state: pdfCitationPreviewFailureState(loaded.reason),
      reason: loaded.reason,
      ...(loaded.display !== undefined ? { display: loaded.display } : {}),
      matchedCitationCount: 0,
    };
  }
  if (loaded.citations === undefined) {
    return { state: "recoverable", reason: "preview-metadata-missing", matchedCitationCount: 0 };
  }
  if (loaded.citations.length === 0) {
    return { state: "not-applicable", reason: "not-local-knowledge-citation", matchedCitationCount: 0 };
  }
  const selected = selectedCitations(loaded.citations, input.marker, input.stableId);
  if (selected.kind !== "selected") {
    const failure = selected;
    return {
      state: pdfCitationPreviewFailureState(failure.reason),
      reason: failure.reason,
      ...(failure.display !== undefined ? { display: failure.display } : {}),
      matchedCitationCount: 0,
    };
  }
  const session = openStoreForDeps(deps);
  try {
    return aggregateStatus(
      selected.citations.map((citation) => evaluateStoredCitation(session.store, citation)),
      selected.citations.length,
    );
  } finally {
    session.close();
  }
}

function rejectedAuthorizationResponse(
  failure: RejectedPreviewOutcome,
): PdfCitationPreviewAuthorizationResponse {
  return {
    outcome: "rejected",
    state: pdfCitationPreviewFailureState(failure.reason),
    reason: failure.reason,
    ...(failure.display !== undefined ? { display: failure.display } : {}),
  };
}

export function authorizePdfCitationPreview(
  deps: UiHandlerDeps,
  input: PdfCitationPreviewSelection,
): PdfCitationPreviewAuthorizationResponse {
  const loaded = loadMessageContext(deps, input.chatId, input.assistantMessageId);
  if ("kind" in loaded) {
    return rejectedAuthorizationResponse(loaded);
  }
  if (loaded.citations === undefined) {
    return {
      outcome: "rejected",
      state: "recoverable",
      reason: "preview-metadata-missing",
    };
  }
  const selected = selectedCitations(loaded.citations, input.marker, input.stableId);
  if (selected.kind !== "selected") {
    return rejectedAuthorizationResponse(selected);
  }
  if (selected.citations.length !== 1) {
    return rejectedAuthorizationResponse(
      reject(
        "citation-not-found",
        selected.citations[0] === undefined ? undefined : citationDisplay(selected.citations[0]),
      ),
    );
  }
  const citation = selected.citations[0];
  if (citation === undefined) {
    return rejectedAuthorizationResponse(reject("citation-not-found"));
  }
  const session = openStoreForDeps(deps);
  try {
    const outcome = evaluateStoredCitation(session.store, citation);
    emitPreviewAudit(session.store, citation, outcome);
    if (outcome.kind === "available") {
      return { outcome: "authorized", display: outcome.display };
    }
    if (!isRejected(outcome)) {
      throw new Error("Preview authorization returned a non-rejected failure outcome.");
    }
    return rejectedAuthorizationResponse(outcome);
  } finally {
    session.close();
  }
}
