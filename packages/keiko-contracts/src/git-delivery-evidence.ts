// Governed Git mutation EVIDENCE contracts (Issue #474, Epic #470). Ownership: the content-free,
// redacted-by-construction audit record produced for EVERY governed Git mutation attempt —
// succeeded, blocked, rejected, failed, recovery-required, or held for approval — plus the
// exportable audit packet that compliance and support workflows inspect without replaying raw logs
// or shell transcripts.
//
// This module is RETROSPECTIVE: it records what an attempt DID, after the #472 execution kernel ran
// its resolve -> preflight -> preview -> policy -> execute -> result lifecycle. It is disjoint from
// git-delivery.ts (the action model + risk + lifecycle envelope), git-delivery-policy.ts (the
// policy evaluator), git-delivery-provider.ts (provider-neutral state), and the PROSPECTIVE
// git-delivery-action-sheet.ts (the UI projection of what WOULD block and how to recover). It reuses
// the action sheet's recovery-action vocabulary and the core atom's recovery-strategy vocabulary
// rather than re-enumerating them, and adds only the missing retrospective axis: a three-way
// recovery DISPOSITION (retryable / user-fixable / policy-forbidden) that the prospective two-way
// GitDeliveryRemediationClass cannot express.
//
// Leaf-package rules (ADR-0019, ADR-0061): pure types, frozen const tables, and pure functions only.
// No IO, no clock, no crypto, no randomness. Relative imports end in ".js" and reference only the
// git-delivery sibling atoms — never a kernel (keiko-tools) type. The kernel's lifecycle-phase,
// status, and failure-category vocabularies are keiko-tools concerns; the keiko-tools evidence
// builder maps them onto the self-contained, mirrored vocabularies defined here so this contract
// stays a standalone, serialisable artifact.
//
// CONTENT-FREE invariant (AC2/AC5): records carry counts, flags, branch names, typed codes, and
// SHA-256 hashes ONLY. They never carry diff content, file paths, secrets, command strings, raw
// subprocess output, raw provider artifacts, or credential-bearing metadata. Remote identifiers,
// the provider-assigned external id, and the repository identity are stored as opaque SHA-256
// hashes; the approval token is recorded as a hash by the #471 contract and never appears here.

import type {
  GitDeliveryActionKind,
  GitDeliveryBlockReason,
  GitDeliveryExecutionErrorCode,
  GitDeliveryExecutionOutcome,
  GitDeliveryEvidenceRef,
  GitDeliveryPolicyDecision,
  GitDeliveryRecoveryStrategyHint,
  GitDeliveryRiskClass,
} from "./git-delivery.js";
import {
  isGitDeliveryActionKind,
  isGitDeliveryBlockReason,
  isGitDeliveryEvidenceRef,
  isGitDeliveryExecutionErrorCode,
  isGitDeliveryExecutionOutcome,
  isGitDeliveryRecoveryStrategyHint,
  isGitDeliveryRiskClass,
} from "./git-delivery.js";
import type { GitDeliveryRecoveryActionHint } from "./git-delivery-action-sheet.js";
import { isGitDeliveryRecoveryActionHint } from "./git-delivery-action-sheet.js";

// Pinned schema version. A breaking change adds a NEW literal member; this one is never mutated.
export const GIT_DELIVERY_EVIDENCE_SCHEMA_VERSION = "1" as const;

// ─── Outcome class (AC1) ──────────────────────────────────────────────────────────────
// The terminal disposition every governed mutation attempt is recorded under. Successful, blocked,
// rejected, and failed are the four AC1 classes; recovery-required (the repository needs a guided
// recovery before retry) and approval-required (a governance hold before execution) are the two
// further precise dispositions the #472 kernel distinguishes. Every attempt produces exactly one.

export type GitDeliveryEvidenceOutcomeClass =
  "succeeded" | "blocked" | "rejected" | "failed" | "recovery-required" | "approval-required";

export const GIT_DELIVERY_EVIDENCE_OUTCOME_CLASSES: readonly GitDeliveryEvidenceOutcomeClass[] = [
  "succeeded",
  "blocked",
  "rejected",
  "failed",
  "recovery-required",
  "approval-required",
] as const;

// ─── Recovery disposition (AC3) ─────────────────────────────────────────────────────────
// The three-way classification operators need to triage a non-successful attempt:
//   retryable        — transient; the same action can be retried as-is.
//   user-fixable     — the operator must change a repository or request condition before retrying.
//   policy-forbidden — governance forbids the action; it is not retryable without a policy change.
//   none             — a successful attempt; no recovery is needed.
// This is DATA on the failure category / error code / block reason, never inferred from a message.

export type GitDeliveryRecoveryDisposition =
  "retryable" | "user-fixable" | "policy-forbidden" | "none";

export const GIT_DELIVERY_RECOVERY_DISPOSITIONS: readonly GitDeliveryRecoveryDisposition[] = [
  "retryable",
  "user-fixable",
  "policy-forbidden",
  "none",
] as const;

// ─── Lifecycle phase (mirrors the kernel; self-contained — AC1) ──────────────────────────
// The furthest #472 lifecycle phase an attempt reached. Mirrors keiko-tools' GitMutationLifecyclePhase
// exactly; the keiko-tools evidence builder maps kernel phase -> this enum with an exhaustive switch
// so any divergence is a compile error. Recorded so a blocked attempt locates where enforcement
// halted without a string compare.

export type GitDeliveryEvidenceLifecyclePhase =
  "resolve" | "preflight" | "preview" | "policy" | "execute" | "result";

export const GIT_DELIVERY_EVIDENCE_LIFECYCLE_PHASES: readonly GitDeliveryEvidenceLifecyclePhase[] =
  ["resolve", "preflight", "preview", "policy", "execute", "result"] as const;

// ─── Recovery metadata (AC3 / Deliverable 3) ─────────────────────────────────────────────
// Composes the new three-way disposition with the REUSED prospective action-hint (#473) and
// recovery-strategy (#471) vocabularies, plus the typed codes that justify the disposition. Specific
// enough that an operator can tell a transient retry from a required fix from a policy denial.

export interface GitDeliveryRecoveryMetadata {
  readonly disposition: GitDeliveryRecoveryDisposition;
  // Present whenever a concrete recovery action applies (i.e. disposition !== "none"). Absent for a
  // successful attempt, which needs no recovery.
  readonly actionHint?: GitDeliveryRecoveryActionHint | undefined;
  readonly executionErrorCode?: GitDeliveryExecutionErrorCode | undefined;
  readonly blockReason?: GitDeliveryBlockReason | undefined;
  readonly suggestedRecoveryStrategy?: GitDeliveryRecoveryStrategyHint | undefined;
}

// ─── Content-free evidence sub-records ────────────────────────────────────────────────────

// Correlation back to the triggering workflow (AC1). The workflow run id is hashed so the ledger is
// correlatable without recording a raw, potentially sensitive identifier.
export interface GitDeliveryEvidenceCorrelation {
  readonly workflowRunIdHash: string; // SHA-256 hex
  readonly actionId: string;
  readonly attemptSequence?: number | undefined;
}

// Approval provenance (AC2). The token itself is never recorded — only its #471 hash. The approver
// id and timestamps are governance provenance and are retained.
export interface GitDeliveryEvidenceApproval {
  readonly required: boolean;
  readonly approvalTokenHash?: string | undefined;
  readonly approvedByUserId?: string | undefined;
  readonly approvedAtMs?: number | undefined;
  readonly expiresAtMs?: number | undefined;
}

// Content-free preview summary (AC1) projected from the kernel's GitDeliveryActionPreview.
export interface GitDeliveryEvidencePreviewSummary {
  readonly affectedBranchName?: string | undefined;
  readonly estimatedFileCount?: number | undefined;
  readonly estimatedBytesDelta?: number | undefined;
  readonly wouldCreateRemoteBranch: boolean;
  readonly wouldTriggerChecks: boolean;
}

// Execution summary (AC1), present only when the action actually executed. The provider external id
// is hashed (AC2) — never the raw PR number / commit SHA.
export interface GitDeliveryEvidenceExecution {
  readonly outcome: GitDeliveryExecutionOutcome;
  readonly durationMs: number;
  readonly errorCode?: GitDeliveryExecutionErrorCode | undefined;
  readonly attemptedUnitCount?: number | undefined;
  readonly succeededUnitCount?: number | undefined;
  readonly externalIdHash?: string | undefined; // SHA-256 hex of the opaque provider id
}

// Content-free repository / branch context (AC2). Local branch names are retained (consistent with
// the #473 action-sheet projection); the repository identity and any remote ref are hashed.
export interface GitDeliveryEvidenceRepoContext {
  readonly repoIdHash?: string | undefined; // SHA-256 hex of the repository path/identity
  readonly targetBranchName?: string | undefined;
  readonly headDetached?: boolean | undefined;
  readonly stagedFileCount?: number | undefined;
  readonly unstagedFileCount?: number | undefined;
  readonly untrackedFileCount?: number | undefined;
  readonly remoteRefHash?: string | undefined; // SHA-256 hex of the remote alias/branch
}

// ─── Evidence record (AC1/AC2/AC3) ────────────────────────────────────────────────────────

export interface GitDeliveryEvidenceRecord {
  readonly schemaVersion: typeof GIT_DELIVERY_EVIDENCE_SCHEMA_VERSION;
  readonly evidenceId: string; // deterministic, content-free (SHA-256 derived)
  readonly actionKind: GitDeliveryActionKind;
  readonly riskClass: GitDeliveryRiskClass;
  readonly riskSeverity: number;
  readonly outcomeClass: GitDeliveryEvidenceOutcomeClass;
  readonly phaseReached: GitDeliveryEvidenceLifecyclePhase;
  readonly policyOutcome: GitDeliveryPolicyDecision["outcome"];
  readonly blockReason?: GitDeliveryBlockReason | undefined;
  readonly requiredApprovers?: readonly string[] | undefined;
  readonly correlation: GitDeliveryEvidenceCorrelation;
  readonly approval: GitDeliveryEvidenceApproval;
  readonly preview?: GitDeliveryEvidencePreviewSummary | undefined;
  readonly execution?: GitDeliveryEvidenceExecution | undefined;
  readonly repoContext: GitDeliveryEvidenceRepoContext;
  readonly recovery: GitDeliveryRecoveryMetadata;
  readonly recordedAtMs: number;
  readonly evidenceRef?: GitDeliveryEvidenceRef | undefined;
}

// ─── Audit packet (AC4 / Deliverable) ──────────────────────────────────────────────────────
// The exportable, structured evidence bundle compliance/support inspect without replaying logs. It
// carries the redacted records, per-class and per-disposition counts, and an honest static list of
// the trust-boundary limitations the export does not overcome.

export interface GitDeliveryAuditPacket {
  readonly schemaVersion: typeof GIT_DELIVERY_EVIDENCE_SCHEMA_VERSION;
  readonly generatedAtMs: number;
  readonly recordCount: number;
  readonly records: readonly GitDeliveryEvidenceRecord[];
  readonly outcomeClassCounts: Readonly<Record<GitDeliveryEvidenceOutcomeClass, number>>;
  readonly recoveryDispositionCounts: Readonly<Record<GitDeliveryRecoveryDisposition, number>>;
  readonly knownLimitations: readonly string[];
}

// ─── Deterministic recovery-disposition derivations (AC3) ────────────────────────────────────
// Total, exhaustive maps over the closed contract vocabularies. Adding a new execution error code or
// block reason forces a compile error here, so a disposition is never derived from a free-form
// message and a new code can never fall through to a silent default.

const RECOVERY_DISPOSITION_BY_EXECUTION_ERROR: Readonly<
  Record<GitDeliveryExecutionErrorCode, GitDeliveryRecoveryDisposition>
> = {
  // The remote refused the action: the operator must address the rejection (rebase, approval, etc.).
  "provider-rejected": "user-fixable",
  // The remote was unreachable: transient, safe to retry as-is.
  "network-failure": "retryable",
  // A merge/index conflict: the operator must resolve it before retrying.
  conflict: "user-fixable",
  // A stale precondition (e.g. non-fast-forward): the operator must re-resolve before retrying.
  "precondition-failed": "user-fixable",
  // A transient timeout: safe to retry.
  timeout: "retryable",
  // An internal fault: transient from the caller's view; safe to retry.
  "internal-error": "retryable",
} as const;

export function gitDeliveryRecoveryDispositionForExecutionError(
  code: GitDeliveryExecutionErrorCode,
): GitDeliveryRecoveryDisposition {
  return RECOVERY_DISPOSITION_BY_EXECUTION_ERROR[code];
}

const RECOVERY_DISPOSITION_BY_BLOCK_REASON: Readonly<
  Record<GitDeliveryBlockReason, GitDeliveryRecoveryDisposition>
> = {
  // A policy pack denied the action: forbidden until the policy changes.
  "policy-pack-blocked": "policy-forbidden",
  // The branch is protected: forbidden under current governance.
  "protected-branch": "policy-forbidden",
  // A required provider capability is absent: forbidden under the active environment.
  "provider-capability-absent": "policy-forbidden",
  // The approval grant expired: the operator can obtain a fresh approval.
  "approval-expired": "user-fixable",
  // The action exceeds the risk-class ceiling: forbidden until the ceiling changes.
  "risk-class-ceiling": "policy-forbidden",
  // Fail-closed deny with no applicable rule: forbidden until a rule permits it.
  "no-applicable-rule": "policy-forbidden",
} as const;

export function gitDeliveryRecoveryDispositionForBlockReason(
  reason: GitDeliveryBlockReason,
): GitDeliveryRecoveryDisposition {
  return RECOVERY_DISPOSITION_BY_BLOCK_REASON[reason];
}

// ─── Audit packet builder (AC4) ──────────────────────────────────────────────────────────────
// Pure aggregation of redacted records into the exportable packet. The honest, static limitations
// list states what the export does NOT overcome (the trust-boundary text mirrors EvidenceReport).

export const GIT_DELIVERY_AUDIT_PACKET_KNOWN_LIMITATIONS: readonly string[] = [
  "Records are content-free by construction: sensitive identifiers are hashed in the builder, and " +
    "diff content, file paths, command output, and secrets are never recorded. The persist- and " +
    "export-time redactors are a defence-in-depth backstop that scrubs secret-SHAPED strings and " +
    "configured literals only — they do not redact arbitrary free-form text, so any new raw field " +
    "must be hashed at the builder rather than relied upon to be redacted.",
  "Remote identifiers, the provider external id, and the repository identity are stored as SHA-256 " +
    "hashes that are irreversible to preimage; low-entropy inputs (e.g. a remote alias or a " +
    "repository path) may remain confirmable by an operator who enumerates candidate values.",
  "Local branch names and approver user ids are retained in clear text as deliberate governance " +
    "provenance (which branch was acted on, who approved); they are not secrets and are not hashed.",
  "Provider-side outcomes (merge-block reasons, remote rejections) are produced only by the " +
    "provider execution slices; a local-only deployment records local-kernel outcomes.",
  "Workflow correlation uses a hashed run id supplied by the caller; correlation across a server " +
    "restart depends on the caller re-supplying a stable run id.",
] as const;

function emptyOutcomeClassCounts(): Record<GitDeliveryEvidenceOutcomeClass, number> {
  return {
    succeeded: 0,
    blocked: 0,
    rejected: 0,
    failed: 0,
    "recovery-required": 0,
    "approval-required": 0,
  };
}

function emptyDispositionCounts(): Record<GitDeliveryRecoveryDisposition, number> {
  return { retryable: 0, "user-fixable": 0, "policy-forbidden": 0, none: 0 };
}

export function buildGitDeliveryAuditPacket(
  records: readonly GitDeliveryEvidenceRecord[],
  generatedAtMs: number,
  extraLimitations: readonly string[] = [],
): GitDeliveryAuditPacket {
  const outcomeClassCounts = emptyOutcomeClassCounts();
  const recoveryDispositionCounts = emptyDispositionCounts();
  for (const record of records) {
    outcomeClassCounts[record.outcomeClass] += 1;
    recoveryDispositionCounts[record.recovery.disposition] += 1;
  }
  return {
    schemaVersion: GIT_DELIVERY_EVIDENCE_SCHEMA_VERSION,
    generatedAtMs,
    recordCount: records.length,
    records,
    outcomeClassCounts,
    recoveryDispositionCounts,
    knownLimitations: [...GIT_DELIVERY_AUDIT_PACKET_KNOWN_LIMITATIONS, ...extraLimitations],
  };
}

// ─── Local guard helpers ─────────────────────────────────────────────────────────────────────

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(isString);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUndefinedOr<T>(check: (v: unknown) => v is T): (v: unknown) => v is T | undefined {
  return (v: unknown): v is T | undefined => v === undefined || check(v);
}

function isInSet<T extends string>(set: readonly T[]): (v: unknown) => v is T {
  return (v: unknown): v is T => isString(v) && (set as readonly string[]).includes(v);
}

const POLICY_OUTCOMES: readonly GitDeliveryPolicyDecision["outcome"][] = [
  "allowed",
  "blocked",
  "approval-gated",
  "constrained",
] as const;

// ─── Enum guards ───────────────────────────────────────────────────────────────────────────────

export const isGitDeliveryEvidenceOutcomeClass = isInSet(GIT_DELIVERY_EVIDENCE_OUTCOME_CLASSES);
export const isGitDeliveryRecoveryDisposition = isInSet(GIT_DELIVERY_RECOVERY_DISPOSITIONS);
export const isGitDeliveryEvidenceLifecyclePhase = isInSet(GIT_DELIVERY_EVIDENCE_LIFECYCLE_PHASES);
const isGitDeliveryPolicyOutcome = isInSet(POLICY_OUTCOMES);

// ─── Structural guards ───────────────────────────────────────────────────────────────────────
// Decomposed per sub-record so each guard stays well under the complexity ceiling and the on-read
// ledger can fail closed on any malformed record.

export function isGitDeliveryRecoveryMetadata(
  value: unknown,
): value is GitDeliveryRecoveryMetadata {
  return (
    isRecord(value) &&
    isGitDeliveryRecoveryDisposition(value.disposition) &&
    isUndefinedOr(isGitDeliveryRecoveryActionHint)(value.actionHint) &&
    isUndefinedOr(isGitDeliveryExecutionErrorCode)(value.executionErrorCode) &&
    isUndefinedOr(isGitDeliveryBlockReason)(value.blockReason) &&
    isUndefinedOr(isGitDeliveryRecoveryStrategyHint)(value.suggestedRecoveryStrategy)
  );
}

function isEvidenceCorrelation(value: unknown): value is GitDeliveryEvidenceCorrelation {
  return (
    isRecord(value) &&
    isString(value.workflowRunIdHash) &&
    isString(value.actionId) &&
    isUndefinedOr(isFiniteNumber)(value.attemptSequence)
  );
}

function isEvidenceApproval(value: unknown): value is GitDeliveryEvidenceApproval {
  return (
    isRecord(value) &&
    isBoolean(value.required) &&
    isUndefinedOr(isString)(value.approvalTokenHash) &&
    isUndefinedOr(isString)(value.approvedByUserId) &&
    isUndefinedOr(isFiniteNumber)(value.approvedAtMs) &&
    isUndefinedOr(isFiniteNumber)(value.expiresAtMs)
  );
}

function isEvidencePreview(value: unknown): value is GitDeliveryEvidencePreviewSummary {
  return (
    isRecord(value) &&
    isUndefinedOr(isString)(value.affectedBranchName) &&
    isUndefinedOr(isFiniteNumber)(value.estimatedFileCount) &&
    isUndefinedOr(isFiniteNumber)(value.estimatedBytesDelta) &&
    isBoolean(value.wouldCreateRemoteBranch) &&
    isBoolean(value.wouldTriggerChecks)
  );
}

function isEvidenceExecution(value: unknown): value is GitDeliveryEvidenceExecution {
  return (
    isRecord(value) &&
    isGitDeliveryExecutionOutcome(value.outcome) &&
    isFiniteNumber(value.durationMs) &&
    isUndefinedOr(isGitDeliveryExecutionErrorCode)(value.errorCode) &&
    isUndefinedOr(isFiniteNumber)(value.attemptedUnitCount) &&
    isUndefinedOr(isFiniteNumber)(value.succeededUnitCount) &&
    isUndefinedOr(isString)(value.externalIdHash)
  );
}

function isEvidenceRepoContext(value: unknown): value is GitDeliveryEvidenceRepoContext {
  return (
    isRecord(value) &&
    isUndefinedOr(isString)(value.repoIdHash) &&
    isUndefinedOr(isString)(value.targetBranchName) &&
    isUndefinedOr(isBoolean)(value.headDetached) &&
    isUndefinedOr(isFiniteNumber)(value.stagedFileCount) &&
    isUndefinedOr(isFiniteNumber)(value.unstagedFileCount) &&
    isUndefinedOr(isFiniteNumber)(value.untrackedFileCount) &&
    isUndefinedOr(isString)(value.remoteRefHash)
  );
}

// Identity fields of a record (split from classification + nested checks to keep each guard within
// the complexity ceiling).
function hasValidEvidenceIdentity(value: Record<string, unknown>): boolean {
  return (
    value.schemaVersion === GIT_DELIVERY_EVIDENCE_SCHEMA_VERSION &&
    isString(value.evidenceId) &&
    isGitDeliveryActionKind(value.actionKind) &&
    isGitDeliveryRiskClass(value.riskClass) &&
    isFiniteNumber(value.riskSeverity) &&
    isFiniteNumber(value.recordedAtMs)
  );
}

// Classification fields of a record.
function hasValidEvidenceClassification(value: Record<string, unknown>): boolean {
  return (
    isGitDeliveryEvidenceOutcomeClass(value.outcomeClass) &&
    isGitDeliveryEvidenceLifecyclePhase(value.phaseReached) &&
    isGitDeliveryPolicyOutcome(value.policyOutcome) &&
    isUndefinedOr(isGitDeliveryBlockReason)(value.blockReason) &&
    isUndefinedOr(isStringArray)(value.requiredApprovers)
  );
}

// Nested-section fields of a record.
function hasValidEvidenceSections(value: Record<string, unknown>): boolean {
  return (
    isEvidenceCorrelation(value.correlation) &&
    isEvidenceApproval(value.approval) &&
    isUndefinedOr(isEvidencePreview)(value.preview) &&
    isUndefinedOr(isEvidenceExecution)(value.execution) &&
    isEvidenceRepoContext(value.repoContext) &&
    isGitDeliveryRecoveryMetadata(value.recovery) &&
    isUndefinedOr(isGitDeliveryEvidenceRef)(value.evidenceRef)
  );
}

export function isGitDeliveryEvidenceRecord(value: unknown): value is GitDeliveryEvidenceRecord {
  return (
    isRecord(value) &&
    hasValidEvidenceIdentity(value) &&
    hasValidEvidenceClassification(value) &&
    hasValidEvidenceSections(value)
  );
}

function isOutcomeClassCounts(
  value: unknown,
): value is Readonly<Record<GitDeliveryEvidenceOutcomeClass, number>> {
  return (
    isRecord(value) &&
    GIT_DELIVERY_EVIDENCE_OUTCOME_CLASSES.every((cls) => isFiniteNumber(value[cls]))
  );
}

function isDispositionCounts(
  value: unknown,
): value is Readonly<Record<GitDeliveryRecoveryDisposition, number>> {
  return (
    isRecord(value) && GIT_DELIVERY_RECOVERY_DISPOSITIONS.every((d) => isFiniteNumber(value[d]))
  );
}

export function isGitDeliveryAuditPacket(value: unknown): value is GitDeliveryAuditPacket {
  return (
    isRecord(value) &&
    value.schemaVersion === GIT_DELIVERY_EVIDENCE_SCHEMA_VERSION &&
    isFiniteNumber(value.generatedAtMs) &&
    isFiniteNumber(value.recordCount) &&
    Array.isArray(value.records) &&
    value.recordCount === value.records.length &&
    value.records.every(isGitDeliveryEvidenceRecord) &&
    isOutcomeClassCounts(value.outcomeClassCounts) &&
    isDispositionCounts(value.recoveryDispositionCounts) &&
    isStringArray(value.knownLimitations)
  );
}
