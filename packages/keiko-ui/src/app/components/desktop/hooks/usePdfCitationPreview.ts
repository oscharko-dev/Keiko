"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  PdfCitationPreviewCitationStatus,
  PdfCitationPreviewDisplay,
  PdfCitationPreviewOrigin,
  PdfCitationPreviewStatusState,
} from "@oscharko-dev/keiko-contracts";
import { fetchPdfCitationPreviewStatus, openPdfCitationPreviewSession } from "@/lib/api";
import type { GroundedAnswer, LocalKnowledgeEvidenceCitation } from "@/lib/types";
import type { WorkspaceApi } from "./useWorkspace.types";
import { showPdfCitationPreviewResult } from "../widgets/cards/pdf-citation-preview-session";

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

function normalizePreviewMarkerIndex(marker: string | number): number | undefined {
  if (typeof marker === "number") {
    return Number.isInteger(marker) && marker > 0 ? marker : undefined;
  }
  const trimmed = marker.trim();
  const match = /^(?:\[(\d+)\]|【(\d+)】|［(\d+)］|(\d+))$/u.exec(trimmed);
  if (match === null) return undefined;
  const parsed = Number.parseInt(
    match[1] ?? match[2] ?? match[3] ?? match[4] ?? "",
    10,
  );
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
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
  const affordances: Record<string, CitationPreviewAffordance> = {};
  for (const status of statuses) {
    if (status.state === "not-applicable") continue;
    const citation = byStableId.get(status.stableId);
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

export function usePdfCitationPreviewController({
  answer,
  chatId,
  windows,
}: {
  readonly answer: GroundedAnswer | undefined;
  readonly chatId: string | undefined;
  readonly windows: PdfCitationPreviewWindowApi | undefined;
}): CitationPreviewController | undefined {
  const citations = useMemo(() => knowledgeCitationsForAnswer(answer), [answer]);
  const [affordances, setAffordances] = useState<Record<string, CitationPreviewAffordance>>({});
  const [openingKeys, setOpeningKeys] = useState<ReadonlySet<string>>(new Set());
  const pendingOpensRef = useRef(new Map<string, Promise<string | null>>());

  useEffect(() => {
    if (chatId === undefined || answer === undefined || citations.length === 0) {
      setAffordances({});
      return;
    }

    let cancelled = false;
    void fetchPdfCitationPreviewStatus({
      chatId,
      assistantMessageId: answer.assistantMessageId,
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
  }, [answer, chatId, citations]);

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
        .then((response) =>
          showPdfCitationPreviewResult(windows, response, {
            currentPage: response.display?.pageNumber,
          }),
        )
        .finally(() => {
          pendingOpensRef.current.delete(key);
          setOpeningKeys((current) => nextOpeningKeys(current, key, false));
        });

      pendingOpensRef.current.set(key, request);
      return request;
    },
    [answer, chatId, windows],
  );

  if (chatId === undefined || answer === undefined || citations.length === 0 || windows === undefined) {
    return undefined;
  }

  return {
    forCitation,
    forMarker,
    isOpening,
    openCitation,
  };
}
