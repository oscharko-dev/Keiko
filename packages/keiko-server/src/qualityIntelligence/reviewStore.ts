// Quality Intelligence review-state companion store (Epic #270, Issue #282).
//
// The run manifest is immutable evidence; the candidate artifact is the generated body. The MUTABLE
// human-review/lifecycle decisions (per-candidate + run-level approve / reject / request-changes,
// plus an append-only audit log) live in a third companion artifact `<runId>.review.json`, managed
// through the generic contained JSON artifact store from keiko-evidence. Default state is "open" —
// nothing is approved by default (#282 AC). All reads tolerate a missing artifact.

import {
  createNodeContainedJsonArtifactStore,
  type ContainedJsonArtifactStore,
} from "@oscharko-dev/keiko-evidence";
import { QualityIntelligence, type QualityIntelligence as QI } from "@oscharko-dev/keiko-contracts";

type ReviewState = QI.QualityIntelligenceReviewState;

export const QI_REVIEW_SCHEMA_VERSION = 1 as const;
const REVIEW_SUFFIX = ".review.json";

const REVIEW_STATES: ReadonlySet<string> = new Set(
  QualityIntelligence.QUALITY_INTELLIGENCE_REVIEW_STATES,
);

export type QiReviewAction = "approve" | "reject" | "request-changes" | "reopen" | "withdraw";

export interface QiReviewAuditEntry {
  readonly at: string;
  readonly action: QiReviewAction;
  readonly scope: "run" | "candidate";
  readonly candidateId?: string;
  readonly reviewerLabel: string;
  readonly fromState: ReviewState;
  readonly toState: ReviewState;
}

export interface QiReviewStateArtifact {
  readonly qiReviewSchemaVersion: typeof QI_REVIEW_SCHEMA_VERSION;
  readonly runId: string;
  readonly runState: ReviewState;
  readonly candidateStates: Readonly<Record<string, ReviewState>>;
  readonly auditLog: readonly QiReviewAuditEntry[];
  readonly lastUpdatedAt: string;
}

const isReviewState = (value: unknown): value is ReviewState =>
  typeof value === "string" && REVIEW_STATES.has(value);

const parseArtifact = (value: unknown): QiReviewStateArtifact | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (record.qiReviewSchemaVersion !== QI_REVIEW_SCHEMA_VERSION) return undefined;
  if (typeof record.runId !== "string" || !isReviewState(record.runState)) return undefined;
  if (typeof record.candidateStates !== "object" || record.candidateStates === null)
    return undefined;
  return value as QiReviewStateArtifact;
};

const storeFor = (evidenceDir: string): ContainedJsonArtifactStore<QiReviewStateArtifact> =>
  createNodeContainedJsonArtifactStore(evidenceDir, REVIEW_SUFFIX, { parse: parseArtifact });

export const loadRunReviewState = (
  runId: string,
  evidenceDir: string,
): QiReviewStateArtifact | undefined => storeFor(evidenceDir).load(runId);

export const runReviewStateOf = (artifact: QiReviewStateArtifact | undefined): ReviewState =>
  artifact?.runState ?? "open";

export const candidateReviewStateOf = (
  artifact: QiReviewStateArtifact | undefined,
  candidateId: string,
): ReviewState => {
  const state = artifact?.candidateStates[candidateId];
  return isReviewState(state) ? state : "open";
};

// ─── Mutation (used by the review-action route, Issue #282) ─────────────────────

const ACTION_TARGET: Readonly<Record<QiReviewAction, ReviewState>> = {
  approve: "approved",
  reject: "rejected",
  "request-changes": "changes-requested",
  reopen: "open",
  withdraw: "withdrawn",
};

export interface ApplyReviewDecisionInput {
  readonly runId: string;
  readonly evidenceDir: string;
  readonly action: QiReviewAction;
  readonly scope: "run" | "candidate";
  readonly candidateId?: string;
  readonly reviewerLabel: string;
  readonly now: string;
}

const emptyArtifact = (runId: string, now: string): QiReviewStateArtifact => ({
  qiReviewSchemaVersion: QI_REVIEW_SCHEMA_VERSION,
  runId,
  runState: "open",
  candidateStates: {},
  auditLog: [],
  lastUpdatedAt: now,
});

/**
 * Apply a review decision and persist the updated artifact. Pure transition + append-only audit
 * entry; returns the new artifact. The caller is responsible for authorising the action.
 */
export const applyReviewDecision = (input: ApplyReviewDecisionInput): QiReviewStateArtifact => {
  const current =
    loadRunReviewState(input.runId, input.evidenceDir) ?? emptyArtifact(input.runId, input.now);
  const toState = ACTION_TARGET[input.action];
  const isCandidate = input.scope === "candidate" && input.candidateId !== undefined;
  const fromState = isCandidate
    ? candidateReviewStateOf(current, input.candidateId)
    : current.runState;
  const candidateStates = isCandidate
    ? { ...current.candidateStates, [input.candidateId]: toState }
    : current.candidateStates;
  const audit: QiReviewAuditEntry = {
    at: input.now,
    action: input.action,
    scope: input.scope,
    ...(isCandidate ? { candidateId: input.candidateId } : {}),
    reviewerLabel: input.reviewerLabel,
    fromState,
    toState,
  };
  const next: QiReviewStateArtifact = {
    qiReviewSchemaVersion: QI_REVIEW_SCHEMA_VERSION,
    runId: input.runId,
    runState: isCandidate ? current.runState : toState,
    candidateStates,
    auditLog: [...current.auditLog, audit],
    lastUpdatedAt: input.now,
  };
  storeFor(input.evidenceDir).record(input.runId, next);
  return next;
};
