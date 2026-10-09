import type {
  CitationRepairDisposition,
  GroundedAnswerKind,
  GroundedCitationBehaviour,
} from "@oscharko-dev/keiko-contracts/bff-wire";
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
  type ActivityLogFields,
} from "@oscharko-dev/keiko-contracts/runtime/observability";

import { correlationIdOrUnknown } from "./correlation.js";
import {
  reconcileNumericCitations,
  reconcileInlineCitations,
  type CitationReconciliation,
  type PackCitationIndex,
  type InlineCitationReconciliationSummary,
} from "./grounded-faithfulness.js";
import { isNoEvidenceAnswerText } from "@oscharko-dev/keiko-contracts/runtime/no-evidence-answer";
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
    citationKind: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["numeric", "file"],
    },
    answerKind: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["answer", "refusal", "clarification", "insufficiency"],
    },
    citationRepairDisposition: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: [
        "not-needed",
        "applied",
        "rejected-content-changed",
        "failed",
        "skipped-budget",
        "skipped-capability",
      ],
    },
    citationBehaviour: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["cites", "cites-after-repair", "never"],
    },
    scopeIdentitySha256: { type: "string", dataClass: "digest", required: false, maxLength: 64 },
    queryIdentitySha256: { type: "string", dataClass: "digest", required: false, maxLength: 64 },
    followUpPass: { type: "integer", dataClass: "count", required: false },
    insufficiencyDeclaredCount: { type: "integer", dataClass: "count", required: false },
    declaredInScopeCount: { type: "integer", dataClass: "count", required: false },
    declaredUnreadInScopeCount: { type: "integer", dataClass: "count", required: false },
    declaredNotInScopeCount: { type: "integer", dataClass: "count", required: false },
    ambiguousMarkerCount: { type: "integer", dataClass: "count", required: false },
    droppedImplicitCount: { type: "integer", dataClass: "count", required: false },
    referenceCount: { type: "integer", dataClass: "count", required: true },
    attachedCount: { type: "integer", dataClass: "count", required: true },
    weakOverlapCount: { type: "integer", dataClass: "count", required: false },
    groupedMarkerCount: { type: "integer", dataClass: "count", required: false },
    danglingMarkerCount: { type: "integer", dataClass: "count", required: true },
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
  },
  diagnosticWhen: [
    { field: "danglingMarkerCount", positive: true },
    { field: "ambiguousMarkerCount", positive: true },
    { field: "declaredUnreadInScopeCount", positive: true },
  ],
  causal: "correlation",
  lifecycle: "end",
  analyzerProjection: "timeline",
  failureClasses: ["knowledge-citation-reconciliation"],
  proofIds: ["search.citations.reconciled.line"],
  releaseImpact: "patch",
});

export interface CitationReconciliationMetadata {
  readonly citationRepairDisposition?: CitationRepairDisposition | undefined;
  readonly answerKind?: GroundedAnswerKind | undefined;
  readonly citationBehaviour?: GroundedCitationBehaviour | undefined;
  readonly scopeIdentitySha256?: string | undefined;
  readonly queryIdentitySha256?: string | undefined;
  readonly followUpPass?: 0 | 1 | undefined;
  readonly insufficiencyDeclaredCount?: number | undefined;
  readonly declaredInScopeCount?: number | undefined;
  readonly declaredUnreadInScopeCount?: number | undefined;
  readonly declaredNotInScopeCount?: number | undefined;
}

function definedCitationMetadata(
  metadata: CitationReconciliationMetadata,
): Partial<ActivityLogFields<typeof SEARCH_CITATIONS_RECONCILED_OPERATION>> {
  return {
    ...(metadata.citationRepairDisposition === undefined
      ? {}
      : { citationRepairDisposition: metadata.citationRepairDisposition }),
    ...(metadata.answerKind === undefined ? {} : { answerKind: metadata.answerKind }),
    ...(metadata.citationBehaviour === undefined
      ? {}
      : { citationBehaviour: metadata.citationBehaviour }),
    ...(metadata.scopeIdentitySha256 === undefined
      ? {}
      : { scopeIdentitySha256: metadata.scopeIdentitySha256 }),
    ...(metadata.queryIdentitySha256 === undefined
      ? {}
      : { queryIdentitySha256: metadata.queryIdentitySha256 }),
    ...citationCountMetadata(metadata),
  };
}

function citationCountMetadata(
  metadata: CitationReconciliationMetadata,
): Partial<ActivityLogFields<typeof SEARCH_CITATIONS_RECONCILED_OPERATION>> {
  return {
    ...(metadata.followUpPass === undefined ? {} : { followUpPass: metadata.followUpPass }),
    ...(metadata.insufficiencyDeclaredCount === undefined
      ? {}
      : { insufficiencyDeclaredCount: metadata.insufficiencyDeclaredCount }),
    ...(metadata.declaredInScopeCount === undefined
      ? {}
      : { declaredInScopeCount: metadata.declaredInScopeCount }),
    ...(metadata.declaredUnreadInScopeCount === undefined
      ? {}
      : { declaredUnreadInScopeCount: metadata.declaredUnreadInScopeCount }),
    ...(metadata.declaredNotInScopeCount === undefined
      ? {}
      : { declaredNotInScopeCount: metadata.declaredNotInScopeCount }),
  };
}

export interface CitationReconciliationEvidence {
  // The answer text the markers were parsed from. Only counts derived from it are ever logged.
  readonly answer: string;
  readonly referenceCount: number;
  // Attached citation entries — one per in-range marker index, grouped markers expanded.
  readonly attachedIndices: readonly number[];
  // Attached entries whose claim shared little vocabulary with the excerpt (kept, not dropped).
  readonly weakOverlapCount?: number;
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
  metadata: CitationReconciliationMetadata = {},
): void {
  const summary = summarizeCitationReconciliation(evidence);
  getServerLogger().info(
    activityLogEvent(
      SEARCH_CITATIONS_RECONCILED_OPERATION,
      { correlationId: correlationIdOrUnknown(correlationId) },
      {
        ...definedCitationMetadata(metadata),
        outcome: summary.outcome,
        citationKind: "numeric",
        referenceCount: evidence.referenceCount,
        attachedCount: summary.attachedCount,
        ...(evidence.weakOverlapCount === undefined
          ? {}
          : { weakOverlapCount: evidence.weakOverlapCount }),
        groupedMarkerCount: summary.groupedMarkerCount,
        danglingMarkerCount: summary.danglingMarkerCount,
        completeness: "complete",
        loss: "none",
      },
    ),
  );
}

/** Reconcile file locations once and log only the resulting closed counts. */
export function reconcileAndLogInlineCitations(
  answer: string,
  index: PackCitationIndex,
  correlationId: string | undefined,
  metadata: CitationReconciliationMetadata = {},
): CitationReconciliation {
  return reconcileInlineCitations(answer, index, (summary) => {
    logInlineCitationSummary(summary, isNoEvidenceAnswerText(answer), correlationId, metadata);
  });
}

function logInlineCitationSummary(
  summary: InlineCitationReconciliationSummary,
  refusal: boolean,
  correlationId: string | undefined,
  metadata: CitationReconciliationMetadata,
): void {
  getServerLogger().info(
    activityLogEvent(
      SEARCH_CITATIONS_RECONCILED_OPERATION,
      { correlationId: correlationIdOrUnknown(correlationId) },
      {
        ...summary,
        ...definedCitationMetadata(metadata),
        outcome: outcomeFor(refusal, summary.attachedCount, summary.danglingMarkerCount),
        citationKind: "file",
        completeness: "complete",
        loss: "none",
      },
    ),
  );
}

// Why a Knowledge Pod answer does or does not carry the "support could not be verified" caveat,
// settled after the entailment stage: the citation line above is written before that decision, so
// two answers with identical citation counts could end with and without the caveat and the log
// could not tell them apart (PR #3678 review).
//   judge-undecided   — the entailment judge left a claim undecided (unavailable, over budget, or
//                       carrying bracketed prose it never read), and its own marker is the caveat;
//   no-judge          — a weakly supported citation and no entailment judge at all;
//   unjudged-citation — a weakly supported citation whose claim no judge call read.
export type CitationSupportCaveat = "none" | "judge-undecided" | "no-judge" | "unjudged-citation";

const SEARCH_CITATIONS_SUPPORT_SETTLED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "search.citations.support-settled",
  category: "search",
  owner: "keiko-server",
  emitter: "grounded-citation-log.logCitationSupport",
  fields: {
    supportCaveat: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["none", "judge-undecided", "no-judge", "unjudged-citation"],
    },
    weakCitationCount: { type: "integer", dataClass: "count", required: true },
    hiddenProseClaimCount: { type: "integer", dataClass: "count", required: true },
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
  },
  diagnosticWhen: [
    { field: "supportCaveat", values: ["judge-undecided", "no-judge", "unjudged-citation"] },
  ],
  causal: "correlation",
  lifecycle: "end",
  analyzerProjection: "timeline",
  failureClasses: ["knowledge-citation-reconciliation"],
  proofIds: ["search.citations.support-settled.line"],
  releaseImpact: "patch",
});

export interface CitationSupportEvidence {
  readonly supportCaveat: CitationSupportCaveat;
  readonly weakCitationCount: number;
  // Cited claims whose bracketed prose the claim stripper removed before judging.
  readonly hiddenProseClaimCount: number;
}

/** Emit the settled support caveat of one Knowledge Pod answer. */
export function logCitationSupport(
  evidence: CitationSupportEvidence,
  correlationId: string | undefined,
): void {
  getServerLogger().info(
    activityLogEvent(
      SEARCH_CITATIONS_SUPPORT_SETTLED_OPERATION,
      { correlationId: correlationIdOrUnknown(correlationId) },
      {
        supportCaveat: evidence.supportCaveat,
        weakCitationCount: evidence.weakCitationCount,
        hiddenProseClaimCount: evidence.hiddenProseClaimCount,
        completeness: "complete",
        loss: "none",
      },
    ),
  );
}

// Whether a Knowledge Pod answer carried Keiko's own, labelled assessment (ADR-0144), under which
// operator policy, and how much of the answer it was — sizes only, never the text:
//   none            — no assessment block;
//   assessment      — a source-backed part and an assessment;
//   assessment-only — the assessment alone (nothing backed by the sources, e.g. no evidence);
//   neutralized     — the policy disabled it, so a block the model wrote became source-backed text.
export type AnswerAssessmentOutcome = "none" | "assessment" | "assessment-only" | "neutralized";

const SEARCH_ANSWER_ASSESSED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "search.answer.assessed",
  category: "search",
  owner: "keiko-server",
  emitter: "grounded-citation-log.logAnswerAssessment",
  fields: {
    policy: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["allowed", "disabled"],
    },
    outcome: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["none", "assessment", "assessment-only", "neutralized"],
    },
    sourceBackedChars: { type: "integer", dataClass: "count", required: true },
    assessmentChars: { type: "integer", dataClass: "count", required: true },
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
  },
  causal: "correlation",
  lifecycle: "end",
  analyzerProjection: "timeline",
  failureClasses: ["knowledge-citation-reconciliation"],
  proofIds: ["search.answer.assessed.line"],
  releaseImpact: "patch",
});

export interface AnswerAssessmentEvidence {
  readonly policy: "allowed" | "disabled";
  readonly sourceBacked: string;
  readonly assessment: string | undefined;
  readonly neutralized: boolean;
}

function assessmentOutcome(evidence: AnswerAssessmentEvidence): AnswerAssessmentOutcome {
  if (evidence.neutralized) return "neutralized";
  if (evidence.assessment === undefined) return "none";
  return evidence.sourceBacked.trim().length === 0 ? "assessment-only" : "assessment";
}

/** Emit the assessment line for one Knowledge Pod answer. */
export function logAnswerAssessment(
  evidence: AnswerAssessmentEvidence,
  correlationId: string | undefined,
): void {
  getServerLogger().info(
    activityLogEvent(
      SEARCH_ANSWER_ASSESSED_OPERATION,
      { correlationId: correlationIdOrUnknown(correlationId) },
      {
        policy: evidence.policy,
        outcome: assessmentOutcome(evidence),
        sourceBackedChars: evidence.sourceBacked.trim().length,
        assessmentChars: evidence.assessment?.length ?? 0,
        completeness: "complete",
        loss: "none",
      },
    ),
  );
}
