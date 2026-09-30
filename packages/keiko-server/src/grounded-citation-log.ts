// Body-free activity-log evidence for how a Knowledge Pod answer's inline citations were
// reconciled against the retrieved references (ADR-0173).
//
// Why this line exists: a customer's answer showed grouped markers as plain text, only some markers
// linked, a footer count far below the number of markers, and "1 unsupported citation" on a refusal.
// None of that was reconstructable from the log — the attacher dropped markers silently and the
// reconciliation left no trace. This line records the counts that decide what the reader sees, so
// the next defect of this class can be rebuilt from the customer's log file alone. It carries
// counts and one closed outcome only — never the answer, a marker literal, an excerpt or a path.

import { findCitationMarkerGroups } from "@oscharko-dev/keiko-contracts/runtime/citation-markers";
import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";

import { correlationIdOrUnknown } from "./correlation.js";
import { reconcileNumericCitations } from "./grounded-faithfulness.js";
import { getServerLogger } from "./observability/index.js";

export type CitationReconciliationOutcome =
  "cited" | "cited-with-dangling" | "dangling-only" | "uncited" | "refusal";

const SEARCH_CITATIONS_RECONCILED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "search.citations.reconciled",
  category: "search",
  owner: "keiko-server",
  emitter: "grounded-citation-log.logCitationReconciliation",
  fields: {
    outcome: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["cited", "cited-with-dangling", "dangling-only", "uncited", "refusal"],
    },
    referenceCount: { type: "integer", dataClass: "count", required: true },
    attachedCount: { type: "integer", dataClass: "count", required: true },
    weakOverlapCount: { type: "integer", dataClass: "count", required: true },
    groupedMarkerCount: { type: "integer", dataClass: "count", required: true },
    danglingMarkerCount: { type: "integer", dataClass: "count", required: true },
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
  },
  causal: "correlation",
  lifecycle: "end",
  analyzerProjection: "timeline",
  failureClasses: ["knowledge-citation-reconciliation"],
  proofIds: ["search.citations.reconciled.line"],
  releaseImpact: "patch",
});

export interface CitationReconciliationEvidence {
  // The answer text the markers were parsed from. Only counts derived from it are ever logged.
  readonly answer: string;
  readonly referenceCount: number;
  // Attached citation entries — one per in-range marker index, grouped markers expanded.
  readonly attachedIndices: readonly number[];
  // Attached entries whose claim shared little vocabulary with the excerpt (kept, not dropped).
  readonly weakOverlapCount: number;
  // The answer was enforced as a refusal ("nothing about this in the documents").
  readonly refusal: boolean;
}

export interface CitationReconciliationSummary {
  readonly outcome: CitationReconciliationOutcome;
  readonly attachedCount: number;
  readonly groupedMarkerCount: number;
  readonly danglingMarkerCount: number;
}

function outcomeFor(
  refusal: boolean,
  attachedCount: number,
  danglingMarkerCount: number,
): CitationReconciliationOutcome {
  if (refusal) return "refusal";
  if (attachedCount > 0) return danglingMarkerCount > 0 ? "cited-with-dangling" : "cited";
  return danglingMarkerCount > 0 ? "dangling-only" : "uncited";
}

/** The counts and closed outcome that describe how an answer's markers reconciled. */
export function summarizeCitationReconciliation(
  evidence: CitationReconciliationEvidence,
): CitationReconciliationSummary {
  const numeric = reconcileNumericCitations(evidence.answer, new Set(evidence.attachedIndices));
  const danglingMarkerCount = numeric.unsupportedMarkers.length;
  const attachedCount = evidence.attachedIndices.length;
  return {
    outcome: outcomeFor(evidence.refusal, attachedCount, danglingMarkerCount),
    attachedCount,
    groupedMarkerCount: findCitationMarkerGroups(evidence.answer).filter(
      (group) => group.entries.length > 1,
    ).length,
    danglingMarkerCount,
  };
}

/** Emit the citation reconciliation line for one Knowledge Pod answer. */
export function logCitationReconciliation(
  evidence: CitationReconciliationEvidence,
  correlationId: string | undefined,
): void {
  const summary = summarizeCitationReconciliation(evidence);
  getServerLogger().info(
    activityLogEvent(
      SEARCH_CITATIONS_RECONCILED_OPERATION,
      { correlationId: correlationIdOrUnknown(correlationId) },
      {
        outcome: summary.outcome,
        referenceCount: evidence.referenceCount,
        attachedCount: summary.attachedCount,
        weakOverlapCount: evidence.weakOverlapCount,
        groupedMarkerCount: summary.groupedMarkerCount,
        danglingMarkerCount: summary.danglingMarkerCount,
        completeness: "complete",
        loss: "none",
      },
    ),
  );
}
