import type {
  CurrentPdfCitationPreviewSnapshot,
  PdfCitationPreviewAuthorizationResponse,
  PdfCitationPreviewCitationStatus,
  PdfCitationPreviewDisplay,
  PdfCitationPreviewReasonCode,
  PdfCitationPreviewSelection,
  PdfCitationPreviewStatusRequest,
  PdfCitationPreviewStatusResponse,
  StoredPdfCitationPreviewCitation,
  KnowledgeSourceId,
} from "@oscharko-dev/keiko-contracts";
import { pdfCitationPreviewFailureState } from "@oscharko-dev/keiko-contracts";
import type {
  GroundedAnswer,
  LocalKnowledgeEvidenceCitation,
} from "@oscharko-dev/keiko-contracts/bff-wire";
import {
  createSqliteAuditSink,
  lookupCitationPreviewSnapshotForStoredCitation,
  type CitationPreviewSnapshotLookup,
} from "@oscharko-dev/keiko-local-knowledge";

import type { UiHandlerDeps } from "./deps.js";
import { openStoreForDeps } from "./local-knowledge-grounded-qa.js";
import {
  normalizePreviewMarkerIndex,
  previewDisplay,
} from "./local-knowledge-preview-authority.js";
import { probePdfPreviewSourceAvailability } from "./local-knowledge-preview-delivery.js";

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

interface PreviewStatusSeed {
  readonly marker: string;
  readonly markerIndex: number;
  readonly stableId: string;
}

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

export type PdfCitationPreviewDocumentAccessResult =
  { readonly kind: "ok" } | RejectedPreviewOutcome;

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
  const useCurrentAnchor =
    current === undefined || current.documentContentHash === stored.documentContentHash;
  const input: Pick<
    StoredPdfCitationPreviewCitation,
    "documentLabel" | "sourceLabel" | "pageNumber" | "pageLabel" | "characterStart" | "characterEnd"
  > = {
    documentLabel: current?.documentLabel ?? stored.documentLabel,
  };
  assignOptionalCitationField(input, "sourceLabel", stored.sourceLabel);
  assignOptionalCitationField(
    input,
    "pageNumber",
    useCurrentAnchor ? (current?.pageNumber ?? stored.pageNumber) : stored.pageNumber,
  );
  assignOptionalCitationField(
    input,
    "pageLabel",
    useCurrentAnchor ? (current?.pageLabel ?? stored.pageLabel) : stored.pageLabel,
  );
  assignOptionalCitationField(
    input,
    "characterStart",
    useCurrentAnchor ? (current?.characterStart ?? stored.characterStart) : stored.characterStart,
  );
  assignOptionalCitationField(
    input,
    "characterEnd",
    useCurrentAnchor ? (current?.characterEnd ?? stored.characterEnd) : stored.characterEnd,
  );
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
  selected = uniqueSelectedCitations(selected);
  if (stableId !== undefined) {
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

function citationSelectionKey(citation: StoredPdfCitationPreviewCitation): string {
  return JSON.stringify({
    stableId: citation.stableId,
    markerIndex: citation.markerIndex,
    capsuleId: citation.lineage.capsuleId,
    sourceId: citation.lineage.sourceId,
    documentId: citation.lineage.documentId,
    chunkId: citation.lineage.chunkId,
  });
}

function uniqueSelectedCitations(
  citations: readonly StoredPdfCitationPreviewCitation[],
): readonly StoredPdfCitationPreviewCitation[] {
  const byKey = new Map<string, StoredPdfCitationPreviewCitation>();
  for (const citation of citations) {
    byKey.set(citationSelectionKey(citation), citation);
  }
  return Array.from(byKey.values());
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
    current.lineage.documentId !== stored.lineage.documentId
  ) {
    return reject("lineage-mismatch", display);
  }
  if (
    current.lineage.chunkId !== stored.lineage.chunkId &&
    !storedSpanMatchesCurrentSnapshot(stored, current)
  ) {
    return reject("lineage-mismatch", display);
  }
  return undefined;
}

function storedSpanMatchesCurrentSnapshot(
  stored: StoredPdfCitationPreviewCitation,
  current: CurrentPdfCitationPreviewSnapshot,
): boolean {
  return (
    stored.characterStart !== undefined &&
    stored.characterEnd !== undefined &&
    current.characterStart === stored.characterStart &&
    current.characterEnd === stored.characterEnd
  );
}

function evaluateStoredCitation(
  store: ReturnType<typeof openStoreForDeps>["store"],
  stored: StoredPdfCitationPreviewCitation,
): PreviewOutcome {
  const storedDisplay = citationDisplay(stored);
  const initialFailure = storedCitationPrecheck(stored, storedDisplay);
  if (initialFailure !== undefined) return initialFailure;
  const lookup = lookupCitationPreviewSnapshotForStoredCitation(store, stored);
  if (lookup.kind !== "ok") {
    return reject("lineage-missing", currentDisplayForLookup(stored, lookup));
  }
  const current = lookup.snapshot;
  const display = citationDisplay(stored, current);
  const currentFailure = currentSnapshotPrecheck(stored, current, display);
  if (currentFailure !== undefined) return currentFailure;
  const authority = { citation: stored, current };
  const source = probePdfPreviewSourceAvailability(store, authority);
  if (source.kind !== "ok") {
    return reject(source.reason, display);
  }
  return { kind: "available", display, authority };
}

function sameCitationAuthority(
  current: PdfCitationPreviewAuthority,
  expected: PdfCitationPreviewAuthority,
): boolean {
  const currentCitation = current.citation;
  const expectedCitation = expected.citation;
  return (
    currentCitation.stableId === expectedCitation.stableId &&
    currentCitation.markerIndex === expectedCitation.markerIndex &&
    currentCitation.documentContentHash === expectedCitation.documentContentHash &&
    currentCitation.documentMediaType === expectedCitation.documentMediaType &&
    currentCitation.lineage.capsuleId === expectedCitation.lineage.capsuleId &&
    currentCitation.lineage.sourceId === expectedCitation.lineage.sourceId &&
    currentCitation.lineage.documentId === expectedCitation.lineage.documentId &&
    currentCitation.lineage.chunkId === expectedCitation.lineage.chunkId
  );
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
    sourceIds: citations.map(
      (citation) => citation.lineage.sourceId,
    ) as readonly KnowledgeSourceId[],
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
):
  | RejectedPreviewOutcome
  | {
      readonly citations: readonly StoredPdfCitationPreviewCitation[] | undefined;
      readonly statusSeeds: readonly PreviewStatusSeed[];
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
  return {
    citations: deps.store.findGroundedPreviewCitations(assistantMessageId),
    statusSeeds: statusSeedsForGroundedAnswer(grounded),
  };
}

function localKnowledgeEvidenceCitations(
  grounded: GroundedAnswer,
): readonly LocalKnowledgeEvidenceCitation[] {
  if (grounded.groundingKind === "local-knowledge") return grounded.citations;
  if (grounded.groundingKind === "hybrid") return grounded.knowledgeCitations;
  return [];
}

function statusSeedsForGroundedAnswer(grounded: GroundedAnswer): readonly PreviewStatusSeed[] {
  return localKnowledgeEvidenceCitations(grounded).flatMap((citation) => {
    const markerIndex = normalizePreviewMarkerIndex(citation.marker);
    if (markerIndex === undefined) return [];
    return [{ stableId: citation.stableId, marker: citation.marker, markerIndex }];
  });
}

function passiveStatusState(result: PreviewOutcome): PdfCitationPreviewCitationStatus["state"] {
  if (result.kind === "available") {
    return "available";
  }
  if (result.reason === "document-not-pdf") {
    return "not-applicable";
  }
  return pdfCitationPreviewFailureState(result.reason);
}

function passiveCitationStatus(
  citation: StoredPdfCitationPreviewCitation,
  result: PreviewOutcome,
): PdfCitationPreviewCitationStatus {
  const state = passiveStatusState(result);
  return {
    stableId: citation.stableId,
    marker: citation.marker,
    markerIndex: citation.markerIndex,
    state,
    ...(result.kind === "available" ? { display: result.display } : {}),
    ...(result.kind === "rejected" && state !== "not-applicable" ? { reason: result.reason } : {}),
    ...(result.kind === "rejected" && result.display !== undefined
      ? { display: result.display }
      : {}),
  };
}

function passiveSelectionFailureStatuses(
  failure: RejectedPreviewOutcome,
): readonly PdfCitationPreviewCitationStatus[] {
  return (failure.citations ?? []).map((citation) => passiveCitationStatus(citation, failure));
}

function previewMetadataMissingStatuses(
  seeds: readonly PreviewStatusSeed[],
  input: PdfCitationPreviewStatusRequest,
): readonly PdfCitationPreviewCitationStatus[] {
  const markerIndex =
    input.marker === undefined ? undefined : normalizePreviewMarkerIndex(input.marker);
  return seeds
    .filter((seed) => markerIndex === undefined || seed.markerIndex === markerIndex)
    .filter((seed) => input.stableId === undefined || seed.stableId === input.stableId)
    .map((seed) => ({
      stableId: seed.stableId,
      marker: seed.marker,
      markerIndex: seed.markerIndex,
      state: "recoverable" as const,
      reason: "preview-metadata-missing" as const,
    }));
}

function loadFailureStatus(
  failure: RejectedPreviewOutcome,
  input: PdfCitationPreviewStatusRequest,
): readonly PdfCitationPreviewCitationStatus[] {
  if (input.marker === undefined || input.stableId === undefined) return [];
  const markerIndex = normalizePreviewMarkerIndex(input.marker);
  if (markerIndex === undefined) return [];
  const state = pdfCitationPreviewFailureState(failure.reason);
  return [
    {
      stableId: input.stableId,
      marker: String(input.marker),
      markerIndex,
      state: state === "not-applicable" ? "not-applicable" : state,
      ...(state === "not-applicable" ? {} : { reason: failure.reason }),
    },
  ];
}

export function getPdfCitationPreviewStatus(
  deps: UiHandlerDeps,
  input: PdfCitationPreviewStatusRequest,
): PdfCitationPreviewStatusResponse {
  const loaded = loadMessageContext(deps, input.chatId, input.assistantMessageId);
  if ("kind" in loaded) {
    return { citations: loadFailureStatus(loaded, input) };
  }
  if (loaded.citations === undefined || loaded.citations.length === 0) {
    return { citations: previewMetadataMissingStatuses(loaded.statusSeeds, input) };
  }
  const selected = selectedCitations(loaded.citations, input.marker, input.stableId);
  if (selected.kind !== "selected") {
    return { citations: passiveSelectionFailureStatuses(selected) };
  }
  const session = openStoreForDeps(deps);
  try {
    return {
      citations: selected.citations.map((citation) =>
        passiveCitationStatus(citation, evaluateStoredCitation(session.store, citation)),
      ),
    };
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

export function verifyPdfCitationPreviewDocumentAccess(
  deps: UiHandlerDeps,
  input: PdfCitationPreviewSelection,
  expected: PdfCitationPreviewAuthority,
): PdfCitationPreviewDocumentAccessResult {
  const loaded = loadMessageContext(deps, input.chatId, input.assistantMessageId);
  if ("kind" in loaded) {
    return loaded;
  }
  if (loaded.citations === undefined) {
    return reject("preview-metadata-missing");
  }
  const selected = selectedCitations(loaded.citations, input.marker, input.stableId);
  if (selected.kind !== "selected") {
    return selected;
  }
  if (selected.citations.length !== 1) {
    return reject(
      "citation-not-found",
      selected.citations[0] === undefined ? undefined : citationDisplay(selected.citations[0]),
      selected.citations,
    );
  }
  const citation = selected.citations[0];
  if (citation === undefined) {
    return reject("citation-not-found");
  }
  const selectedAuthority: PdfCitationPreviewAuthority = { citation };
  if (!sameCitationAuthority(selectedAuthority, expected)) {
    return reject("lineage-mismatch", citationDisplay(citation), [citation]);
  }
  return { kind: "ok" };
}

export function projectPdfCitationPreviewAuthorizationResponse(
  result: PdfCitationPreviewAuthorizationResult,
): PdfCitationPreviewAuthorizationResponse {
  if ("kind" in result) {
    return rejectedAuthorizationResponse(result);
  }
  return { outcome: "authorized", display: result.display };
}
