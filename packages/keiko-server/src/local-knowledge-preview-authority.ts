import { createHash } from "node:crypto";
import type {
  RetrievalReference,
  PdfCitationPreviewDisplay,
  StoredPdfCitationPreviewCitation,
} from "@oscharko-dev/keiko-contracts";
import { pdfCitationPreviewAnchorQuality } from "@oscharko-dev/keiko-contracts";
import {
  lookupCitationPreviewSnapshot,
  type KnowledgeStore,
} from "@oscharko-dev/keiko-local-knowledge";

const LABEL_WHITESPACE = /\s+/gu;
const MAX_LABEL_CHARS = 160;

export interface PreviewAuthorityInput {
  readonly marker: string;
  readonly sourceLabel?: string;
  readonly reference: RetrievalReference;
}

function normalizeLabel(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const compact = value.replace(LABEL_WHITESPACE, " ").trim();
  if (compact.length === 0) return undefined;
  return compact.slice(0, MAX_LABEL_CHARS);
}

export function normalizePreviewMarkerIndex(value: string | number): number | undefined {
  if (typeof value === "number") {
    return Number.isInteger(value) && value > 0 ? value : undefined;
  }
  const trimmed = value.trim();
  const match = /^[[［【]?(\d+)[\]］】]?$/u.exec(trimmed);
  if (match?.[1] === undefined) return undefined;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export function previewDisplay(
  citation: Pick<
    StoredPdfCitationPreviewCitation,
    "documentLabel" | "sourceLabel" | "pageNumber" | "pageLabel" | "characterStart" | "characterEnd"
  >,
): PdfCitationPreviewDisplay {
  const normalized = {
    documentLabel: citation.documentLabel,
    ...(citation.sourceLabel !== undefined ? { sourceLabel: citation.sourceLabel } : {}),
    ...(citation.pageNumber !== undefined ? { pageNumber: citation.pageNumber } : {}),
    ...(citation.pageLabel !== undefined ? { pageLabel: citation.pageLabel } : {}),
  };
  return {
    ...normalized,
    anchorQuality: pdfCitationPreviewAnchorQuality({
      ...normalized,
      ...(citation.characterStart !== undefined ? { characterStart: citation.characterStart } : {}),
      ...(citation.characterEnd !== undefined ? { characterEnd: citation.characterEnd } : {}),
    }),
  };
}

export function buildStoredPreviewCitations(
  store: KnowledgeStore,
  inputs: readonly PreviewAuthorityInput[],
): readonly StoredPdfCitationPreviewCitation[] {
  const snapshotCache = new Map<string, ReturnType<typeof lookupCitationPreviewSnapshot>>();
  const citations: StoredPdfCitationPreviewCitation[] = [];
  for (const input of inputs) {
    const citation = buildStoredPreviewCitation(store, input, snapshotCache);
    if (citation === undefined) continue;
    citations.push(citation);
  }
  return citations;
}

function buildStoredPreviewCitation(
  store: KnowledgeStore,
  input: PreviewAuthorityInput,
  snapshotCache: Map<string, ReturnType<typeof lookupCitationPreviewSnapshot>>,
): StoredPdfCitationPreviewCitation | undefined {
  const markerIndex = normalizePreviewMarkerIndex(input.marker);
  if (markerIndex === undefined) return undefined;
  const cacheKey = `${String(input.reference.capsuleId)}|${String(input.reference.chunkId)}`;
  const snapshot =
    snapshotCache.get(cacheKey) ??
    lookupCitationPreviewSnapshot(store, input.reference.capsuleId, input.reference.chunkId);
  snapshotCache.set(cacheKey, snapshot);
  if (snapshot.kind !== "ok") return undefined;
  const documentLabel = normalizeLabel(snapshot.snapshot.documentLabel) ?? "document";
  const sourceLabel = normalizeLabel(input.sourceLabel);
  return {
    stableId: createHash("sha256")
      .update(
        `${input.marker}|${String(input.reference.capsuleId)}|${String(input.reference.chunkId)}`,
      )
      .digest("hex")
      .slice(0, 16),
    marker: input.marker,
    markerIndex,
    documentLabel,
    ...(sourceLabel !== undefined ? { sourceLabel } : {}),
    lineage: snapshot.snapshot.lineage,
    documentMediaType: snapshot.snapshot.documentMediaType,
    documentContentHash: snapshot.snapshot.documentContentHash,
    ...(snapshot.snapshot.pageNumber !== undefined
      ? { pageNumber: snapshot.snapshot.pageNumber }
      : {}),
    ...(snapshot.snapshot.pageLabel !== undefined
      ? { pageLabel: snapshot.snapshot.pageLabel }
      : {}),
    ...(snapshot.snapshot.characterStart !== undefined
      ? { characterStart: snapshot.snapshot.characterStart }
      : {}),
    ...(snapshot.snapshot.characterEnd !== undefined
      ? { characterEnd: snapshot.snapshot.characterEnd }
      : {}),
  };
}
