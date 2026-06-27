import type { DocumentStatus } from "./local-knowledge-records.js";
import type { ChunkId, DocumentId, KnowledgeCapsuleId, KnowledgeSourceId } from "./local-knowledge.js";

export type PdfCitationPreviewAnchorQuality = "page-only" | "approximate" | "unavailable";

export const PDF_CITATION_PREVIEW_ANCHOR_QUALITIES = [
  "page-only",
  "approximate",
  "unavailable",
] as const;

export type PdfCitationPreviewReasonCode =
  | "assistant-message-not-found"
  | "assistant-message-chat-mismatch"
  | "grounded-answer-missing"
  | "not-local-knowledge-citation"
  | "citation-not-found"
  | "stable-id-mismatch"
  | "preview-metadata-missing"
  | "lineage-missing"
  | "lineage-mismatch"
  | "document-not-pdf"
  | "document-not-ready"
  | "document-content-mismatch"
  | "page-provenance-missing";

export const PDF_CITATION_PREVIEW_REASON_CODES = [
  "assistant-message-not-found",
  "assistant-message-chat-mismatch",
  "grounded-answer-missing",
  "not-local-knowledge-citation",
  "citation-not-found",
  "stable-id-mismatch",
  "preview-metadata-missing",
  "lineage-missing",
  "lineage-mismatch",
  "document-not-pdf",
  "document-not-ready",
  "document-content-mismatch",
  "page-provenance-missing",
] as const;

export type PdfCitationPreviewFailureState = "not-applicable" | "recoverable" | "blocked";

export const PDF_CITATION_PREVIEW_FAILURE_STATES = [
  "not-applicable",
  "recoverable",
  "blocked",
] as const;

export type PdfCitationPreviewStatusState =
  | "not-applicable"
  | "available"
  | "recoverable"
  | "blocked";

export const PDF_CITATION_PREVIEW_STATUS_STATES = [
  "not-applicable",
  "available",
  "recoverable",
  "blocked",
] as const;

export interface StoredPdfCitationPreviewLineage {
  readonly capsuleId: KnowledgeCapsuleId;
  readonly sourceId: KnowledgeSourceId;
  readonly documentId: DocumentId;
  readonly chunkId: ChunkId;
}

export interface StoredPdfCitationPreviewCitation {
  readonly stableId: string;
  readonly marker: string;
  readonly markerIndex: number;
  readonly documentLabel: string;
  readonly sourceLabel?: string;
  readonly lineage: StoredPdfCitationPreviewLineage;
  readonly documentMediaType: string;
  readonly documentContentHash: string;
  readonly pageNumber?: number;
  readonly pageLabel?: string;
  readonly characterStart?: number;
  readonly characterEnd?: number;
}

export interface CurrentPdfCitationPreviewSnapshot {
  readonly lineage: StoredPdfCitationPreviewLineage;
  readonly documentLabel: string;
  readonly documentMediaType: string;
  readonly documentContentHash: string;
  readonly documentStatus: DocumentStatus;
  readonly pageNumber?: number;
  readonly pageLabel?: string;
  readonly characterStart?: number;
  readonly characterEnd?: number;
}

export interface PdfCitationPreviewDisplay {
  readonly documentLabel: string;
  readonly sourceLabel?: string;
  readonly pageNumber?: number;
  readonly pageLabel?: string;
  readonly anchorQuality: PdfCitationPreviewAnchorQuality;
}

export interface PdfCitationPreviewSelection {
  readonly chatId: string;
  readonly assistantMessageId: string;
  readonly marker: string | number;
  readonly stableId?: string;
}

export interface PdfCitationPreviewStatusRequest {
  readonly chatId: string;
  readonly assistantMessageId: string;
  readonly marker?: string | number;
  readonly stableId?: string;
}

export interface PdfCitationPreviewAuthorized {
  readonly outcome: "authorized";
  readonly display: PdfCitationPreviewDisplay;
}

export interface PdfCitationPreviewRejected {
  readonly outcome: "rejected";
  readonly state: PdfCitationPreviewFailureState;
  readonly reason: PdfCitationPreviewReasonCode;
  readonly display?: PdfCitationPreviewDisplay;
}

export type PdfCitationPreviewAuthorizationResponse =
  | PdfCitationPreviewAuthorized
  | PdfCitationPreviewRejected;

export interface PdfCitationPreviewStatusResponse {
  readonly state: PdfCitationPreviewStatusState;
  readonly reason?: PdfCitationPreviewReasonCode;
  readonly display?: PdfCitationPreviewDisplay;
  readonly matchedCitationCount: number;
}

export function pdfCitationPreviewFailureState(
  reason: PdfCitationPreviewReasonCode,
): PdfCitationPreviewFailureState {
  if (
    reason === "preview-metadata-missing" ||
    reason === "document-not-ready" ||
    reason === "document-content-mismatch" ||
    reason === "page-provenance-missing"
  ) {
    return "recoverable";
  }
  if (
    reason === "grounded-answer-missing" ||
    reason === "not-local-knowledge-citation"
  ) {
    return "not-applicable";
  }
  return "blocked";
}

export function pdfCitationPreviewAnchorQuality(
  citation: Pick<
    StoredPdfCitationPreviewCitation,
    "pageNumber" | "characterStart" | "characterEnd"
  >,
): PdfCitationPreviewAnchorQuality {
  if (citation.pageNumber === undefined) {
    return "unavailable";
  }
  if (
    citation.characterStart !== undefined &&
    citation.characterEnd !== undefined &&
    citation.characterEnd > citation.characterStart
  ) {
    return "approximate";
  }
  return "page-only";
}
