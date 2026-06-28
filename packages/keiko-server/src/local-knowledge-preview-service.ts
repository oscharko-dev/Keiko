import type {
  CurrentPdfCitationPreviewSnapshot,
  PdfCitationPreviewAuthorizationResponse,
  PdfCitationPreviewDisplay,
  PdfCitationPreviewReasonCode,
  PdfCitationPreviewSelection,
  PdfCitationPreviewStatusRequest,
  PdfCitationPreviewStatusResponse,
  StoredPdfCitationPreviewCitation,
  KnowledgeSourceId,
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
  | {
      readonly kind: "available";
      readonly display: PdfCitationPreviewDisplay;
      readonly authority: PdfCitationPreviewAuthority;
    }
  | {
      readonly kind: "rejected";
      readonly reason: PdfCitationPreviewReasonCode;
      readonly display?: PdfCitationPreviewDisplay;
      readonly citations?: readonly StoredPdfCitationPreviewCitation[];
    };

type RejectedPreviewOutcome = Extract<PreviewOutcome, { readonly kind: "rejected" }>;
type SelectedPreviewCitations =
  | { readonly kind: "selected"; readonly citations: readonly StoredPdfCitationPreviewCitation[] }
  | RejectedPreviewOutcome;

export interface PdfCitationPreviewAuthority {
  readonly citation: StoredPdfCitationPreviewCitation;
  readonly current?: CurrentPdfCitationPreviewSnapshot;
}

export type PdfCitationPreviewAuthorizationResult =
  | {
      readonly outcome: "authorized";
      readonly display: PdfCitationPreviewDisplay;
      readonly authority: PdfCitationPreviewAuthority;
    }
  | RejectedPreviewOutcome;

function reject(
  reason: PdfCitationPreviewReasonCode,
  display?: PdfCitationPreviewDisplay,
  citations?: readonly StoredPdfCitationPreviewCitation[],
): RejectedPreviewOutcome {
  return {
    kind: "rejected",
    reason,
    ...(display !== undefined ? { display } : {}),
    ...(citations !== undefined ? { citations } : {}),
  };
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
  if (stableId !== undefined && selected.length === 1) {
    const stableMatches = selected.filter((citation) => citation.stableId === stableId);
    if (stableMatches.length === 0) {
      return reject(
        "stable-id-mismatch",
        selected[0] === undefined ? undefined : citationDisplay(selected[0]),
        selected,
      );
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
  return { kind: "available", display, authority: { citation: stored, current } };
}

function emitPreviewAudit(
  store: ReturnType<typeof openStoreForDeps>["store"],
  citations: readonly StoredPdfCitationPreviewCitation[],
  outcome: PreviewOutcome,
): void {
  if (citations.length === 0) return;
  const sink = createSqliteAuditSink(store);
  const firstCitation = citations[0];
  if (firstCitation === undefined) return;
  const base = {
    capsuleId: firstCitation.lineage.capsuleId,
    sourceIds: citations.map((citation) => citation.lineage.sourceId) as readonly KnowledgeSourceId[],
    chunkIds: citations.map((citation) => String(citation.lineage.chunkId)) as readonly string[],
    targetQuality: citationDisplay(firstCitation).anchorQuality,
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
  for (const result of results) {
    if (result.kind === "available") {
      return { state: "available", display: result.display, matchedCitationCount };
    }
  }
  const recoverable = firstRejectedByState(results, "recoverable");
  return recoverable !== undefined
    ? rejectedStatus("recoverable", recoverable, matchedCitationCount)
    : rejectedStatus("blocked", firstRejectedByState(results, "blocked"), matchedCitationCount);
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
    const results: PreviewOutcome[] = [];
    for (const citation of selected.citations) {
      const outcome = evaluateStoredCitation(session.store, citation);
      results.push(outcome);
      if (outcome.kind === "available") {
        return { state: "available", display: outcome.display, matchedCitationCount: selected.citations.length };
      }
    }
    return aggregateStatus(results, selected.citations.length);
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

function emitAuthorizationAuditIfPossible(
  deps: UiHandlerDeps,
  citations: readonly StoredPdfCitationPreviewCitation[],
  outcome: PreviewOutcome | RejectedPreviewOutcome,
): void {
  if (citations.length === 0) return;
  const session = openStoreForDeps(deps);
  try {
    emitPreviewAudit(session.store, citations, outcome);
  } finally {
    session.close();
  }
}

export function authorizePdfCitationPreview(
  deps: UiHandlerDeps,
  input: PdfCitationPreviewSelection,
): PdfCitationPreviewAuthorizationResult {
  const loaded = loadMessageContext(deps, input.chatId, input.assistantMessageId);
  if ("kind" in loaded) {
    return loaded;
  }
  if (loaded.citations === undefined) {
    return reject("preview-metadata-missing");
  }
  const selected = selectedCitations(loaded.citations, input.marker, input.stableId);
  if (selected.kind !== "selected") {
    if (selected.citations !== undefined && selected.citations.length > 0) {
      emitAuthorizationAuditIfPossible(deps, selected.citations, selected);
    }
    return selected;
  }
  if (selected.citations.length !== 1) {
    const failure = reject(
      "citation-not-found",
      selected.citations[0] === undefined ? undefined : citationDisplay(selected.citations[0]),
      selected.citations,
    );
    emitAuthorizationAuditIfPossible(deps, selected.citations, failure);
    return failure;
  }
  const citation = selected.citations[0];
  if (citation === undefined) {
    const failure = reject("citation-not-found");
    return failure;
  }
  const session = openStoreForDeps(deps);
  try {
    const outcome = evaluateStoredCitation(session.store, citation);
    emitPreviewAudit(session.store, [citation], outcome);
    return outcome.kind === "available"
      ? { outcome: "authorized", display: outcome.display, authority: outcome.authority }
      : outcome;
  } finally {
    session.close();
  }
}

export function projectPdfCitationPreviewAuthorizationResponse(
  result: PdfCitationPreviewAuthorizationResult,
): PdfCitationPreviewAuthorizationResponse {
  if ("kind" in result) {
    return rejectedAuthorizationResponse(result);
  }
  return { outcome: "authorized", display: result.display };
}
