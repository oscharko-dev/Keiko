"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch } from "react";
import type {
  KnowledgeCitationEditorTargetRequest,
  PdfCitationPreviewCitationStatus,
} from "@oscharko-dev/keiko-contracts";
import type { ClientDiagnosticCitationActivation } from "@oscharko-dev/keiko-contracts/runtime/diagnostics";
import { normalizePdfCitationPreviewMarkerIndex } from "@oscharko-dev/keiko-contracts/runtime/local-knowledge-preview";
import { openKnowledgeCitationEditorTarget } from "@/lib/api";
import { newClientCorrelationId } from "@/lib/bff-correlation";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import { bffRequestErrorKind } from "@/lib/http";
import { clientErrorEvidence } from "@/lib/client-error-evidence";
import type { GroundedAnswer, LocalKnowledgeEvidenceCitation } from "@/lib/types";
import type { WorkspaceApi } from "./useWorkspace.types";

export type KnowledgeCitationEditorState = "idle" | "opening" | "opened" | "failed";
export interface KnowledgeCitationEditorController {
  readonly stateFor: (
    citation: LocalKnowledgeEvidenceCitation,
  ) => KnowledgeCitationEditorState | undefined;
  readonly openCitation: (citation: LocalKnowledgeEvidenceCitation) => Promise<void>;
}
interface EditorCitationInput {
  readonly answer: GroundedAnswer | undefined;
  readonly chatId: string | undefined;
  readonly statuses: readonly PdfCitationPreviewCitationStatus[];
  readonly openEditorFile: WorkspaceApi["openEditorFile"] | undefined;
}
interface EditorSnapshot extends EditorCitationInput {
  readonly eligible: ReadonlySet<string>;
  readonly generation: number;
}
interface EditorOwner {
  snapshot: EditorSnapshot;
  key: string;
  mounted: boolean;
  mountGeneration: number;
  readonly pending: Map<string, Promise<void>>;
}
interface EditorStates {
  readonly generation: number;
  readonly values: ReadonlyMap<string, KnowledgeCitationEditorState>;
}
interface EditorRequest {
  readonly owner: EditorOwner;
  readonly selection: KnowledgeCitationEditorTargetRequest;
  readonly correlationId: string;
  readonly isCurrent: () => boolean;
  readonly settle: (state: KnowledgeCitationEditorState) => void;
}

function citationIdentity(citation: LocalKnowledgeEvidenceCitation): string {
  const { capsuleId, sourceId, documentId, chunkId } = citation.lineage;
  return JSON.stringify([
    citation.stableId,
    citation.marker,
    capsuleId,
    sourceId,
    documentId,
    chunkId,
  ]);
}
function eligibleCitations({
  answer,
  statuses,
}: Pick<EditorCitationInput, "answer" | "statuses">): ReadonlySet<string> {
  let citations: readonly LocalKnowledgeEvidenceCitation[] = [];
  if (answer?.groundingKind === "local-knowledge") citations = answer.citations;
  if (answer?.groundingKind === "hybrid") citations = answer.knowledgeCitations;
  return new Set(
    citations.flatMap((citation) => {
      if (citation.htmlManual !== undefined) return [];
      const marker = normalizePdfCitationPreviewMarkerIndex(citation.marker);
      if (marker === undefined) return [];
      const matching = statuses.filter(
        (status) =>
          status.stableId === citation.stableId &&
          status.markerIndex === marker &&
          normalizePdfCitationPreviewMarkerIndex(status.marker) === marker,
      );
      // No marker-only fallback: the text action uses this exact saved citation identity.
      if (matching.length !== 1 || matching[0]?.editorOpenAvailable !== true) return [];
      return [citationIdentity(citation)];
    }),
  );
}
function activation(
  authorized: boolean,
  outcome: ClientDiagnosticCitationActivation["outcome"],
): ClientDiagnosticCitationActivation {
  return authorized
    ? { reason: "matched", outcome, rootCount: 1, matchCount: 1 }
    : { reason: "unmatched", outcome: "refused", rootCount: 0, matchCount: 0 };
}

async function executeEditorRequest(request: EditorRequest): Promise<void> {
  let authorized = false;
  request.settle("opening");
  try {
    const response = await openKnowledgeCitationEditorTarget(
      request.selection,
      request.correlationId,
    );
    if (!request.isCurrent()) return;
    authorized = response.outcome === "authorized";
    const result =
      response.outcome === "authorized"
        ? request.owner.snapshot.openEditorFile?.(response.target)
        : undefined;
    const opened = result?.ok === true;
    request.settle(opened ? "opened" : "failed");
    reportClientDiagnostic("[keiko] citation activation settled", {
      correlationId: request.correlationId,
      citationActivation: activation(authorized, opened ? "opened" : "open-refused"),
    });
  } catch (error) {
    if (!request.isCurrent()) return;
    request.settle("failed");
    reportClientDiagnostic("[keiko] citation activation settled", {
      correlationId: request.correlationId,
      citationActivation: activation(authorized, "open-refused"),
    });
    reportClientDiagnostic("[keiko] knowledge citation editor target failed", {
      correlationId: request.correlationId,
      errorKind: bffRequestErrorKind(error),
      errorEvidence: clientErrorEvidence(error),
    });
  }
}
function requestLifecycle(
  owner: EditorOwner,
  identity: string,
  setStates: Dispatch<(previous: EditorStates) => EditorStates>,
): Pick<EditorRequest, "isCurrent" | "settle"> {
  const { generation } = owner.snapshot;
  const mountGeneration = owner.mountGeneration;
  const isCurrent = (): boolean =>
    owner.mounted &&
    owner.mountGeneration === mountGeneration &&
    owner.snapshot.generation === generation &&
    owner.snapshot.eligible.has(identity);
  return {
    isCurrent,
    settle: (state): void => {
      if (!isCurrent()) return;
      setStates((previous) => ({
        generation,
        values: new Map([
          ...(previous.generation === generation ? previous.values : []),
          [identity, state],
        ]),
      }));
    },
  };
}
async function openEditorCitation(
  owner: EditorOwner,
  citation: LocalKnowledgeEvidenceCitation,
  setStates: Dispatch<(previous: EditorStates) => EditorStates>,
): Promise<void> {
  const { chatId, answer, eligible, generation, openEditorFile } = owner.snapshot;
  const identity = citationIdentity(citation);
  if (
    !owner.mounted ||
    chatId === undefined ||
    answer === undefined ||
    openEditorFile === undefined ||
    !eligible.has(identity)
  )
    return;
  const key = `${generation}:${owner.mountGeneration}:${identity}`;
  const pending = owner.pending.get(key);
  if (pending !== undefined) return pending;
  const request = executeEditorRequest({
    owner,
    ...requestLifecycle(owner, identity, setStates),
    selection: {
      chatId,
      assistantMessageId: answer.assistantMessageId,
      marker: citation.marker,
      stableId: citation.stableId,
    },
    correlationId: newClientCorrelationId(),
  }).finally(() => owner.pending.delete(key));
  owner.pending.set(key, request);
  return request;
}

/** Status grants an affordance only; every explicit click resolves its saved citation again. */
export function useKnowledgeCitationEditorController(
  input: EditorCitationInput,
): KnowledgeCitationEditorController | undefined {
  const { answer, statuses } = input;
  const eligible = useMemo(() => eligibleCitations({ answer, statuses }), [answer, statuses]);
  const key = JSON.stringify([input.chatId, input.answer?.assistantMessageId, [...eligible]]);
  const owner = useRef<EditorOwner>({
    snapshot: { ...input, eligible, generation: 0 },
    key,
    mounted: true,
    mountGeneration: 0,
    pending: new Map(),
  });
  const generation = owner.current.snapshot.generation + (owner.current.key === key ? 0 : 1);
  owner.current.key = key;
  owner.current.snapshot = { ...input, eligible, generation };
  const [states, setStates] = useState<EditorStates>({ generation, values: new Map() });
  useEffect(() => {
    const active = owner.current;
    active.mounted = true;
    active.mountGeneration += 1;
    return (): void => {
      active.mounted = false;
    };
  }, []);
  const openCitation = useCallback(
    (citation: LocalKnowledgeEvidenceCitation): Promise<void> =>
      openEditorCitation(owner.current, citation, setStates),
    [],
  );
  if (
    input.chatId === undefined ||
    input.answer === undefined ||
    input.openEditorFile === undefined
  )
    return undefined;
  return {
    stateFor: (citation): KnowledgeCitationEditorState | undefined => {
      const identity = citationIdentity(citation);
      if (!eligible.has(identity)) return undefined;
      return states.generation === generation ? (states.values.get(identity) ?? "idle") : "idle";
    },
    openCitation,
  };
}
