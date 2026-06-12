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
import { QualityIntelligenceReview } from "@oscharko-dev/keiko-quality-intelligence";

type ReviewState = QI.QualityIntelligenceReviewState;

/** Redacts a payload leaf before it is persisted; `deepRedactStrings` preserves string→string. */
export type ReviewRedactor = (value: unknown) => unknown;

/**
 * Redact a reviewer label before it lands in the persisted (append-only) audit log. The label is
 * user-supplied, so a secret-shaped value must be scrubbed at persist time — the `.review.json`
 * companion otherwise bypasses the QI persist redactor (Issue #282 FIX M1). The live redactor maps
 * string→string; the non-string fallback keeps the type honest without `any`.
 */
const redactLabel = (label: string, redact: ReviewRedactor): string => {
  const redacted = redact(label);
  return typeof redacted === "string" ? redacted : label;
};

export const QI_REVIEW_SCHEMA_VERSION = 1 as const;
const REVIEW_SUFFIX = ".review.json";

const REVIEW_STATES: ReadonlySet<string> = new Set(
  QualityIntelligence.QUALITY_INTELLIGENCE_REVIEW_STATES,
);

export type QiReviewAction = "approve" | "reject" | "request-changes" | "reopen" | "withdraw";

// An inline edit (Epic #712, Issue #726) is an auditable candidate action that does NOT transition
// review state — it records who edited which candidate when. The audit log carries it alongside the
// review decisions; `fromState`/`toState` are the candidate's current review state (unchanged).
export type QiAuditAction = QiReviewAction | "edit";

export interface QiReviewAuditEntry {
  readonly at: string;
  readonly action: QiAuditAction;
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

// FIX L1 (Issue #282) — candidate ids are arbitrary strings. Building the candidate-state map over a
// null-prototype object means a candidate literally named `__proto__` / `constructor` cannot collide
// with an Object.prototype member (no prototype-pollution, no spurious own-key reads). Behaviour is
// identical for normal ids.
const toNullProtoStates = (
  source: Readonly<Record<string, ReviewState>>,
): Record<string, ReviewState> => {
  const target = Object.create(null) as Record<string, ReviewState>;
  for (const [id, state] of Object.entries(source)) target[id] = state;
  return target;
};

const parseArtifact = (value: unknown): QiReviewStateArtifact | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (record.qiReviewSchemaVersion !== QI_REVIEW_SCHEMA_VERSION) return undefined;
  if (typeof record.runId !== "string" || !isReviewState(record.runState)) return undefined;
  if (typeof record.candidateStates !== "object" || record.candidateStates === null)
    return undefined;
  // Rehydrate candidateStates onto a null-proto object so a persisted `__proto__`/`constructor`
  // candidate id round-trips as an own key rather than the prototype member it was parsed into.
  const candidateStates = toNullProtoStates(
    record.candidateStates as Readonly<Record<string, ReviewState>>,
  );
  return { ...(value as QiReviewStateArtifact), candidateStates };
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

// FIX A (Issue #282) — legal-transition predicate, resurrecting the audited pure terminal-state
// check from keiko-quality-intelligence. A transition from `from` via `action` (target `to`) is
// legal iff:
//   * to !== from           (reject every no-op, including reopen-from-open), AND
//   * action === "reopen" OR the source state is not terminal.
// reopen is the deliberate, audited undo from any non-open state (changes-requested / approved /
// rejected / withdrawn → open). Every other action (approve / reject / request-changes / withdraw)
// is legal only from a non-terminal state — this blocks silent illegal flips (approve a rejected,
// reject an approved) while keeping re-decision possible via an explicit reopen.
const isLegalTransition = (from: ReviewState, action: QiReviewAction): boolean => {
  const to = ACTION_TARGET[action];
  if (to === from) return false;
  return action === "reopen" || !QualityIntelligenceReview.isTerminalReviewState(from);
};

/**
 * Thrown by `applyReviewDecision` when the requested action is not a legal transition from the
 * current review state. Nothing is persisted and no audit entry is appended — the append-only log
 * never attests a transition the audited domain declares illegal. The route maps this to a 409.
 */
export class QualityIntelligenceReviewTransitionRejected extends Error {
  readonly from: ReviewState;
  readonly action: QiReviewAction;
  readonly toState: ReviewState;

  constructor(from: ReviewState, action: QiReviewAction, toState: ReviewState) {
    super(`Review transition ${from} → ${action} (${toState}) is not permitted.`);
    this.name = "QualityIntelligenceReviewTransitionRejected";
    this.from = from;
    this.action = action;
    this.toState = toState;
  }
}

export interface ApplyReviewDecisionInput {
  readonly runId: string;
  readonly evidenceDir: string;
  readonly action: QiReviewAction;
  readonly scope: "run" | "candidate";
  readonly candidateId?: string;
  readonly reviewerLabel: string;
  readonly now: string;
  /** Redacts the reviewer label before it lands in the persisted audit log (Issue #282 FIX M1). */
  readonly redact: ReviewRedactor;
}

const emptyArtifact = (runId: string, now: string): QiReviewStateArtifact => ({
  qiReviewSchemaVersion: QI_REVIEW_SCHEMA_VERSION,
  runId,
  runState: "open",
  candidateStates: toNullProtoStates({}),
  auditLog: [],
  lastUpdatedAt: now,
});

/**
 * Apply a review decision and persist the updated artifact. Validates transition legality first
 * (FIX A): an illegal transition throws `QualityIntelligenceReviewTransitionRejected` and persists
 * nothing — no audit entry is ever appended for a rejected transition. On success, appends an
 * append-only audit entry (with a redacted reviewer label, FIX M1) and returns the new artifact.
 * The caller is responsible for authorising the action.
 */
export const applyReviewDecision = (input: ApplyReviewDecisionInput): QiReviewStateArtifact => {
  const current =
    loadRunReviewState(input.runId, input.evidenceDir) ?? emptyArtifact(input.runId, input.now);
  const toState = ACTION_TARGET[input.action];
  const isCandidate = input.scope === "candidate" && input.candidateId !== undefined;
  const fromState = isCandidate
    ? candidateReviewStateOf(current, input.candidateId)
    : current.runState;
  if (!isLegalTransition(fromState, input.action)) {
    throw new QualityIntelligenceReviewTransitionRejected(fromState, input.action, toState);
  }
  const candidateStates = isCandidate
    ? Object.assign(toNullProtoStates(current.candidateStates), { [input.candidateId]: toState })
    : current.candidateStates;
  const audit: QiReviewAuditEntry = {
    at: input.now,
    action: input.action,
    scope: input.scope,
    ...(isCandidate ? { candidateId: input.candidateId } : {}),
    reviewerLabel: redactLabel(input.reviewerLabel, input.redact),
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

// ─── Inline-edit audit (Epic #712, Issue #726) ──────────────────────────────────

export interface AppendEditAuditInput {
  readonly runId: string;
  readonly evidenceDir: string;
  readonly candidateId: string;
  readonly reviewerLabel: string;
  readonly now: string;
  /** Redacts the reviewer label before it lands in the persisted audit log (Issue #282 FIX M1). */
  readonly redact: ReviewRedactor;
}

/**
 * Append an append-only `edit` audit entry for an inline candidate edit. Review state is NOT
 * transitioned — `fromState`/`toState` are the candidate's existing review state. The reviewer label
 * is redacted before persist (FIX M1). Persists and returns the updated review artifact (created
 * empty on first use).
 */
export const appendEditAudit = (input: AppendEditAuditInput): QiReviewStateArtifact => {
  const current =
    loadRunReviewState(input.runId, input.evidenceDir) ?? emptyArtifact(input.runId, input.now);
  const state = candidateReviewStateOf(current, input.candidateId);
  const audit: QiReviewAuditEntry = {
    at: input.now,
    action: "edit",
    scope: "candidate",
    candidateId: input.candidateId,
    reviewerLabel: redactLabel(input.reviewerLabel, input.redact),
    fromState: state,
    toState: state,
  };
  const next: QiReviewStateArtifact = {
    ...current,
    auditLog: [...current.auditLog, audit],
    lastUpdatedAt: input.now,
  };
  storeFor(input.evidenceDir).record(input.runId, next);
  return next;
};
