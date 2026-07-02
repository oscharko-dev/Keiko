"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  PdfCitationPreviewCitationStatus,
  PdfCitationPreviewDisplay,
  PdfCitationPreviewOrigin,
  PdfCitationPreviewStatusState,
} from "@oscharko-dev/keiko-contracts";
import { normalizePdfCitationPreviewMarkerIndex } from "@oscharko-dev/keiko-contracts";
import { fetchPdfCitationPreviewStatus, openPdfCitationPreviewSession } from "@/lib/api";
import type { GroundedAnswer, LocalKnowledgeEvidenceCitation } from "@/lib/types";
import type { WorkspaceApi } from "./useWorkspace.types";
import {
  showPdfCitationPreviewFailure,
  showPdfCitationPreviewResult,
  type PdfCitationPreviewAnswerContext,
  type PdfCitationPreviewContextCitation,
} from "../widgets/cards/pdf-citation-preview-session";

export interface PdfCitationPreviewWindowApi {
  readonly add: WorkspaceApi["add"];
  readonly focus: WorkspaceApi["focus"];
  readonly update: WorkspaceApi["update"];
}

export type CitationPreviewAffordanceState = Extract<
  PdfCitationPreviewStatusState,
  "available" | "recoverable" | "blocked"
>;

export interface CitationPreviewAffordance {
  readonly citation: LocalKnowledgeEvidenceCitation;
  readonly display?: PdfCitationPreviewDisplay;
  readonly reason?: PdfCitationPreviewCitationStatus["reason"];
  readonly state: CitationPreviewAffordanceState;
}

export interface CitationPreviewController {
  readonly forCitation: (
    citation: LocalKnowledgeEvidenceCitation,
  ) => CitationPreviewAffordance | undefined;
  readonly forMarker: (marker: string | number) => CitationPreviewAffordance | undefined;
  readonly isOpening: (citation: LocalKnowledgeEvidenceCitation) => boolean;
  readonly openCitation: (
    citation: LocalKnowledgeEvidenceCitation,
    origin: PdfCitationPreviewOrigin,
  ) => Promise<string | null>;
}

const PDF_STATUS_CACHE_TTL_MS = 2000;
type PdfStatusResponse = Awaited<ReturnType<typeof fetchPdfCitationPreviewStatus>>;
const pdfStatusCache = new Map<
  string,
  { readonly expiresAt: number; readonly promise: Promise<PdfStatusResponse> }
>();

export function clearPdfCitationPreviewStatusCacheForTests(): void {
  pdfStatusCache.clear();
}

function fetchCachedPdfCitationPreviewStatus(input: {
  readonly chatId: string;
  readonly assistantMessageId: string;
}): Promise<PdfStatusResponse> {
  const key = `${input.chatId}\u0000${input.assistantMessageId}`;
  const now = Date.now();
  const cached = pdfStatusCache.get(key);
  if (cached !== undefined && cached.expiresAt > now) {
    return cached.promise;
  }
  const promise = fetchPdfCitationPreviewStatus(input).catch((error: unknown) => {
    pdfStatusCache.delete(key);
    throw error;
  });
  pdfStatusCache.set(key, { promise, expiresAt: now + PDF_STATUS_CACHE_TTL_MS });
  return promise;
}

interface CitationPreviewRenderSnapshot {
  readonly affordances: Record<string, CitationPreviewAffordance>;
  readonly answer: GroundedAnswer | undefined;
  readonly chatId: string | undefined;
  readonly citations: readonly LocalKnowledgeEvidenceCitation[];
  readonly windowId: string | undefined;
  readonly windows: PdfCitationPreviewWindowApi | undefined;
}

function normalizePreviewMarkerIndex(marker: string | number): number | undefined {
  return normalizePdfCitationPreviewMarkerIndex(marker);
}

export function knowledgeCitationsForAnswer(
  answer: GroundedAnswer | undefined,
): readonly LocalKnowledgeEvidenceCitation[] {
  if (answer === undefined) return [];
  if (answer.groundingKind === "local-knowledge") {
    return answer.citations;
  }
  if (answer.groundingKind === "hybrid") {
    return answer.knowledgeCitations;
  }
  return [];
}

function openingKey(
  chatId: string,
  assistantMessageId: string,
  citation: LocalKnowledgeEvidenceCitation,
): string {
  const markerIndex = normalizePreviewMarkerIndex(citation.marker);
  return `${chatId}:${assistantMessageId}:${String(markerIndex ?? citation.marker)}:${citation.stableId}`;
}

function nextOpeningKeys(
  current: ReadonlySet<string>,
  key: string,
  opening: boolean,
): ReadonlySet<string> {
  const next = new Set(current);
  if (opening) {
    next.add(key);
  } else {
    next.delete(key);
  }
  return next;
}

function buildAffordanceMap(
  citations: readonly LocalKnowledgeEvidenceCitation[],
  statuses: readonly PdfCitationPreviewCitationStatus[],
): Record<string, CitationPreviewAffordance> {
  const byStableId = new Map(citations.map((citation) => [citation.stableId, citation]));
  const markerCitationKeys = new Map<number, Set<string>>();
  for (const citation of citations) {
    const markerIndex = normalizePreviewMarkerIndex(citation.marker);
    if (markerIndex === undefined) continue;
    const keys = markerCitationKeys.get(markerIndex) ?? new Set<string>();
    keys.add(citation.stableId);
    markerCitationKeys.set(markerIndex, keys);
  }
  const uniqueByMarkerIndex = new Map<number, LocalKnowledgeEvidenceCitation>();
  for (const citation of citations) {
    const markerIndex = normalizePreviewMarkerIndex(citation.marker);
    if (markerIndex === undefined || markerCitationKeys.get(markerIndex)?.size !== 1) continue;
    uniqueByMarkerIndex.set(markerIndex, citation);
  }
  const affordances: Record<string, CitationPreviewAffordance> = {};
  for (const status of statuses) {
    if (status.state === "not-applicable") continue;
    const citation = byStableId.get(status.stableId) ?? uniqueByMarkerIndex.get(status.markerIndex);
    if (citation === undefined) continue;
    affordances[citation.stableId] = {
      citation,
      state: status.state,
      ...(status.display === undefined ? {} : { display: status.display }),
      ...(status.reason === undefined ? {} : { reason: status.reason }),
    };
  }
  return affordances;
}

function citationContextItem(
  citation: LocalKnowledgeEvidenceCitation,
  affordance: CitationPreviewAffordance,
): PdfCitationPreviewContextCitation | undefined {
  if (affordance.state !== "available" || affordance.display === undefined) return undefined;
  return {
    citation: {
      stableId: citation.stableId,
      marker: citation.marker,
      label: citation.label,
      ...(citation.source === undefined ? {} : { source: citation.source }),
    },
    display: affordance.display,
  };
}

function answerLocalPreviewContext(
  activeCitation: LocalKnowledgeEvidenceCitation,
  citations: readonly LocalKnowledgeEvidenceCitation[],
  affordances: Record<string, CitationPreviewAffordance>,
): readonly PdfCitationPreviewContextCitation[] {
  const seenStableIds = new Set<string>();
  return citations.flatMap((citation) => {
    if (citation.lineage.documentId !== activeCitation.lineage.documentId) {
      return [];
    }
    if (seenStableIds.has(citation.stableId)) {
      return [];
    }
    const affordance = affordances[citation.stableId];
    if (affordance === undefined) {
      return [];
    }
    const contextItem = citationContextItem(citation, affordance);
    if (contextItem !== undefined) {
      seenStableIds.add(citation.stableId);
    }
    return contextItem === undefined ? [] : [contextItem];
  });
}

export function usePdfCitationPreviewController({
  answer,
  chatId,
  windowId,
  windows,
}: {
  readonly answer: GroundedAnswer | undefined;
  readonly chatId: string | undefined;
  readonly windowId?: string | undefined;
  readonly windows: PdfCitationPreviewWindowApi | undefined;
}): CitationPreviewController | undefined {
  const assistantMessageId = answer?.assistantMessageId;
  const citations = useMemo(() => knowledgeCitationsForAnswer(answer), [answer]);
  const [affordances, setAffordances] = useState<Record<string, CitationPreviewAffordance>>({});
  const [openingKeys, setOpeningKeys] = useState<ReadonlySet<string>>(new Set());
  const pendingOpensRef = useRef(new Map<string, Promise<string | null>>());
  const latestSnapshotRef = useRef<CitationPreviewRenderSnapshot>({
    affordances,
    answer,
    chatId,
    citations,
    windowId,
    windows,
  });
  latestSnapshotRef.current = {
    affordances,
    answer,
    chatId,
    citations,
    windowId,
    windows,
  };

  useEffect(() => {
    if (chatId === undefined || assistantMessageId === undefined || citations.length === 0) {
      setAffordances({});
      return;
    }

    let cancelled = false;
    void fetchCachedPdfCitationPreviewStatus({
      chatId,
      assistantMessageId,
    }).then(
      (response) => {
        if (cancelled) return;
        setAffordances(buildAffordanceMap(citations, response.citations));
      },
      () => {
        if (cancelled) return;
        setAffordances({});
      },
    );

    return () => {
      cancelled = true;
    };
  }, [assistantMessageId, chatId, citations]);

  const forCitation = useCallback(
    (citation: LocalKnowledgeEvidenceCitation): CitationPreviewAffordance | undefined =>
      affordances[citation.stableId],
    [affordances],
  );

  const forMarker = useCallback(
    (marker: string | number): CitationPreviewAffordance | undefined => {
      const markerIndex = normalizePreviewMarkerIndex(marker);
      if (markerIndex === undefined) return undefined;
      return citations
        .map((citation) => affordances[citation.stableId])
        .find(
          (affordance) =>
            affordance !== undefined &&
            normalizePreviewMarkerIndex(affordance.citation.marker) === markerIndex,
        );
    },
    [affordances, citations],
  );

  const isOpening = useCallback(
    (citation: LocalKnowledgeEvidenceCitation): boolean => {
      if (chatId === undefined || answer === undefined) return false;
      return openingKeys.has(openingKey(chatId, answer.assistantMessageId, citation));
    },
    [answer, chatId, openingKeys],
  );

  const openCitation = useCallback(
    async (
      citation: LocalKnowledgeEvidenceCitation,
      origin: PdfCitationPreviewOrigin,
    ): Promise<string | null> => {
      if (chatId === undefined || answer === undefined || windows === undefined) {
        return null;
      }

      const key = openingKey(chatId, answer.assistantMessageId, citation);
      const existing = pendingOpensRef.current.get(key);
      if (existing !== undefined) {
        return existing;
      }

      setOpeningKeys((current) => nextOpeningKeys(current, key, true));
      const request = openPdfCitationPreviewSession({
        chatId,
        assistantMessageId: answer.assistantMessageId,
        marker: citation.marker,
        stableId: citation.stableId,
        origin,
      })
        .then((response) => {
          const latest = latestSnapshotRef.current;
          const latestAnswer = latest.answer;
          if (
            latest.chatId !== chatId ||
            latestAnswer === undefined ||
            latestAnswer.assistantMessageId !== answer.assistantMessageId ||
            latest.windows === undefined
          ) {
            return null;
          }
          const latestCitation = latest.citations.find(
            (candidate) => candidate.stableId === citation.stableId,
          );
          if (latestCitation === undefined) {
            return null;
          }
          const sameDocumentCitations = answerLocalPreviewContext(
            latestCitation,
            latest.citations,
            latest.affordances,
          );
          const context: PdfCitationPreviewAnswerContext | undefined =
            sameDocumentCitations.length === 0
              ? undefined
              : {
                  activeStableId: latestCitation.stableId,
                  citations: sameDocumentCitations,
                  origin: {
                    assistantMessageId: latestAnswer.assistantMessageId,
                    chatId,
                    ...(latest.windowId === undefined ? {} : { chatWindowId: latest.windowId }),
                    marker: latestCitation.marker,
                    representation: origin,
                  },
                };
          if (response.outcome === "authorized") {
            return showPdfCitationPreviewResult(latest.windows, response, {
              ...(context === undefined ? {} : { context }),
              currentPage: response.display.pageNumber,
            });
          }
          return showPdfCitationPreviewFailure(latest.windows, response);
        })
        .finally(() => {
          pendingOpensRef.current.delete(key);
          setOpeningKeys((current) => nextOpeningKeys(current, key, false));
        });

      pendingOpensRef.current.set(key, request);
      return request;
    },
    [answer, chatId, windows],
  );

  if (
    chatId === undefined ||
    answer === undefined ||
    citations.length === 0 ||
    windows === undefined
  ) {
    return undefined;
  }

  return {
    forCitation,
    forMarker,
    isOpening,
    openCitation,
  };
}
