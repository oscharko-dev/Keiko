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
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { QualityIntelligence, type QualityIntelligence as QI } from "@oscharko-dev/keiko-contracts";
import { QualityIntelligenceReview } from "@oscharko-dev/keiko-quality-intelligence";
import { sha256Hex } from "@oscharko-dev/keiko-security";

type ReviewState = QI.QualityIntelligenceReviewState;

/** Redacts a payload leaf before it is persisted; `deepRedactStrings` preserves string→string. */
export type ReviewRedactor = (value: unknown) => unknown;

/**
 * Redact a display label before it lands in the persisted (append-only) audit log. Browser-supplied
 * labels are display metadata only, but they can still be secret-shaped and must be scrubbed at
 * persist time — the `.review.json` companion otherwise bypasses the QI persist redactor (Issue
 * #282 FIX M1). The live redactor maps string→string; the non-string fallback keeps the type honest.
 */
const redactLabel = (label: string, redact: ReviewRedactor): string => {
  const redacted = redact(label);
  return typeof redacted === "string" ? redacted : label;
};

export const QI_REVIEW_SCHEMA_VERSION = 1 as const;
const REVIEW_SUFFIX = ".review.json";
const REVIEW_LOCK_SUBDIR = ".review-locks";
const REVIEW_LOCK_ATTEMPTS = 40;
const REVIEW_LOCK_SLEEP_MS = 5;
const GENESIS_AUDIT_HASH = "0".repeat(64);
const MAX_REASON_LEN = 512;

const REVIEW_STATES: ReadonlySet<string> = new Set(
  QualityIntelligence.QUALITY_INTELLIGENCE_REVIEW_STATES,
);

export type QiReviewAction = QI.QualityIntelligenceReviewAction;

// An inline edit (Epic #712, Issue #726) is an auditable candidate action. Non-terminal candidates
// keep their review state; terminal candidates move to `changes-requested` with explicit
// revalidation/rejudge flags so approvals cannot silently survive post-review body changes.
export type QiAuditAction =
  QiReviewAction | "edit" | "regenerate-preserved" | "regenerate-reopened";

export type QiReviewAuditGovernanceFlag = "needs-revalidation" | "needs-rejudge";

export interface QiReviewActor {
  readonly actorId: string;
  readonly displayLabel: string;
  readonly source?: string;
  readonly kind?: "human" | "system";
}

export interface QiReviewAuditEntry {
  /** Monotone per-run sequence for new writes. Legacy entries may omit it. */
  readonly sequence?: number;
  /** Hash of the immediately preceding entry, or the genesis hash for the first entry. */
  readonly priorHashSha256Hex?: string;
  /** Hash of this entry with `entryHashSha256Hex` omitted. */
  readonly entryHashSha256Hex?: string;
  readonly at: string;
  readonly action: QiAuditAction;
  readonly scope: "run" | "candidate";
  readonly candidateId?: string;
  /**
   * Back-compat display label consumed by old UI/read paths. For new writes this is the
   * server-resolved actor display label, not an authority-bearing browser assertion.
   */
  readonly reviewerLabel: string;
  /** Server-authoritative principal used for governance checks. Missing on legacy records. */
  readonly actorId?: string;
  readonly actorDisplayLabel?: string;
  readonly actorSource?: string;
  readonly actorKind?: "human" | "system";
  /** Optional browser-supplied display label, persisted only as non-authoritative metadata. */
  readonly selfAssertedReviewerLabel?: string;
  /** Provenance when a review state was carried into a regenerated run. */
  readonly sourceRunId?: string;
  readonly sourceCandidateId?: string;
  /** Required for user-driven reopen actions; optional on legacy/system records. */
  readonly reason?: string;
  /** Visible governance follow-ups produced by system actions such as post-approval edits. */
  readonly governanceFlags?: readonly QiReviewAuditGovernanceFlag[];
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

const canonicaliseForHash = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicaliseForHash);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      const item = record[key];
      if (item !== undefined) out[key] = canonicaliseForHash(item);
    }
    return out;
  }
  return value;
};

const auditEntryForHash = (
  entry: QiReviewAuditEntry,
): Omit<QiReviewAuditEntry, "entryHashSha256Hex"> => {
  const { entryHashSha256Hex: _entryHashSha256Hex, ...hashable } = entry;
  void _entryHashSha256Hex;
  return hashable;
};

export const hashQiReviewAuditEntry = (entry: QiReviewAuditEntry): string =>
  sha256Hex(JSON.stringify(canonicaliseForHash(auditEntryForHash(entry))));

const priorHashForAuditLog = (auditLog: readonly QiReviewAuditEntry[]): string => {
  const previous = auditLog.at(-1);
  if (previous === undefined) return GENESIS_AUDIT_HASH;
  return previous.entryHashSha256Hex ?? hashQiReviewAuditEntry(previous);
};

const nextAuditSequence = (auditLog: readonly QiReviewAuditEntry[]): number => {
  for (let index = auditLog.length - 1; index >= 0; index -= 1) {
    const sequence = auditLog[index]?.sequence;
    if (Number.isInteger(sequence) && sequence !== undefined) return sequence + 1;
  }
  return auditLog.length + 1;
};

const chainAuditEntry = (
  auditLog: readonly QiReviewAuditEntry[],
  entry: QiReviewAuditEntry,
): QiReviewAuditEntry => {
  const { sequence: _sequence, priorHashSha256Hex: _priorHash, ...unchained } = entry;
  void _sequence;
  void _priorHash;
  const linked: QiReviewAuditEntry = {
    ...unchained,
    sequence: nextAuditSequence(auditLog),
    priorHashSha256Hex: priorHashForAuditLog(auditLog),
  };
  return { ...linked, entryHashSha256Hex: hashQiReviewAuditEntry(linked) };
};

const stripAuditChainFields = (entry: QiReviewAuditEntry): QiReviewAuditEntry => {
  const {
    sequence: _sequence,
    priorHashSha256Hex: _priorHashSha256Hex,
    entryHashSha256Hex: _entryHashSha256Hex,
    ...unchained
  } = entry;
  void _sequence;
  void _priorHashSha256Hex;
  void _entryHashSha256Hex;
  return unchained;
};

const chainAuditLog = (entries: readonly QiReviewAuditEntry[]): readonly QiReviewAuditEntry[] => {
  const chained: QiReviewAuditEntry[] = [];
  for (const entry of entries) chained.push(chainAuditEntry(chained, stripAuditChainFields(entry)));
  return chained;
};

export type QiReviewAuditIntegrityIssueCode =
  | "MISSING_CHAIN_FIELD"
  | "SEQUENCE_NOT_MONOTONE"
  | "PRIOR_HASH_MISMATCH"
  | "ENTRY_HASH_MISMATCH"
  | "STATE_AUDIT_MISMATCH";

export interface QiReviewAuditIntegrityIssue {
  readonly index: number;
  readonly code: QiReviewAuditIntegrityIssueCode;
  readonly message: string;
}

export interface QiReviewAuditIntegrityReport {
  readonly ok: boolean;
  readonly issues: readonly QiReviewAuditIntegrityIssue[];
}

const hasAnyChainField = (entry: QiReviewAuditEntry): boolean =>
  entry.sequence !== undefined ||
  entry.priorHashSha256Hex !== undefined ||
  entry.entryHashSha256Hex !== undefined;

const addIntegrityIssue = (
  issues: QiReviewAuditIntegrityIssue[],
  index: number,
  code: QiReviewAuditIntegrityIssueCode,
  message: string,
): void => {
  issues.push({ index, code, message });
};

// Replays the audit log to derive the expected run + per-candidate review states. Extracted so
// verifyMaterializedReviewState stays under the cyclomatic-complexity bound.
function replayReviewAuditStates(artifact: QiReviewStateArtifact): {
  readonly runState: ReviewState;
  readonly candidateStates: ReturnType<typeof toNullProtoStates>;
} {
  let runState: ReviewState = "open";
  const candidateStates = toNullProtoStates({});
  for (const entry of artifact.auditLog) {
    if (entry.scope === "run") {
      runState = entry.toState;
      continue;
    }
    if (entry.candidateId === undefined) {
      continue;
    }
    candidateStates[entry.candidateId] = entry.toState;
    if (entry.action === "edit" && QualityIntelligence.isTerminalReviewState(runState)) {
      runState = entry.toState;
    }
  }
  return { runState, candidateStates };
}

function verifyMaterializedReviewState(
  artifact: QiReviewStateArtifact,
  issues: QiReviewAuditIntegrityIssue[],
): void {
  const { runState, candidateStates } = replayReviewAuditStates(artifact);
  if (artifact.runState !== runState) {
    addIntegrityIssue(
      issues,
      -1,
      "STATE_AUDIT_MISMATCH",
      "Materialized run review state does not match the audit log.",
    );
  }
  const allCandidateIds = new Set([
    ...Object.keys(candidateStates),
    ...Object.keys(artifact.candidateStates),
  ]);
  for (const candidateId of allCandidateIds) {
    const expected = candidateStates[candidateId] ?? "open";
    const actual = artifact.candidateStates[candidateId] ?? "open";
    if (actual !== expected) {
      addIntegrityIssue(
        issues,
        -1,
        "STATE_AUDIT_MISMATCH",
        "Materialized candidate review state does not match the audit log.",
      );
      return;
    }
  }
}

// Reports the unchained-entry-after-chained-entries violation, if any. Extracted so
// verifyQiReviewAuditIntegrity stays under the cognitive-complexity bound.
const checkUnchainedAuditEntry = (
  issues: QiReviewAuditIntegrityIssue[],
  index: number,
  sawChainedEntry: boolean,
): void => {
  if (!sawChainedEntry) return;
  addIntegrityIssue(
    issues,
    index,
    "MISSING_CHAIN_FIELD",
    "Unchained audit entry appears after chained entries.",
  );
};

const checkAuditSequence = (
  issues: QiReviewAuditIntegrityIssue[],
  index: number,
  entry: QiReviewAuditEntry,
): void => {
  const expectedSequence = index + 1;
  if (entry.sequence === expectedSequence) return;
  addIntegrityIssue(
    issues,
    index,
    "SEQUENCE_NOT_MONOTONE",
    `Expected audit sequence ${String(expectedSequence)}, got ${String(entry.sequence)}.`,
  );
};

const expectedPriorHashAt = (auditLog: readonly QiReviewAuditEntry[], index: number): string => {
  const prior = auditLog[index - 1];
  if (prior === undefined) return GENESIS_AUDIT_HASH;
  return prior.entryHashSha256Hex ?? hashQiReviewAuditEntry(prior);
};

const checkAuditPriorHash = (
  issues: QiReviewAuditIntegrityIssue[],
  index: number,
  entry: QiReviewAuditEntry,
  auditLog: readonly QiReviewAuditEntry[],
): void => {
  if (entry.priorHashSha256Hex === expectedPriorHashAt(auditLog, index)) return;
  addIntegrityIssue(
    issues,
    index,
    "PRIOR_HASH_MISMATCH",
    "Audit entry prior hash does not match the previous entry.",
  );
};

const checkAuditEntryHash = (
  issues: QiReviewAuditIntegrityIssue[],
  index: number,
  entry: QiReviewAuditEntry,
): void => {
  const expectedHash = hashQiReviewAuditEntry(entry);
  if (entry.entryHashSha256Hex === expectedHash) return;
  addIntegrityIssue(
    issues,
    index,
    "ENTRY_HASH_MISMATCH",
    "Audit entry hash does not match its content.",
  );
};

// Runs the sequence/prior-hash/entry-hash checks for a chained audit entry. Extracted so
// verifyQiReviewAuditIntegrity stays under the cognitive-complexity bound.
const checkChainedAuditEntry = (
  artifact: QiReviewStateArtifact,
  issues: QiReviewAuditIntegrityIssue[],
  index: number,
  entry: QiReviewAuditEntry,
): void => {
  checkAuditSequence(issues, index, entry);
  checkAuditPriorHash(issues, index, entry, artifact.auditLog);
  checkAuditEntryHash(issues, index, entry);
};

export const verifyQiReviewAuditIntegrity = (
  artifact: QiReviewStateArtifact,
): QiReviewAuditIntegrityReport => {
  const issues: QiReviewAuditIntegrityIssue[] = [];
  let sawChainedEntry = false;
  for (let index = 0; index < artifact.auditLog.length; index += 1) {
    const entry = artifact.auditLog[index];
    if (entry === undefined) continue;
    if (!hasAnyChainField(entry)) {
      checkUnchainedAuditEntry(issues, index, sawChainedEntry);
      continue;
    }
    sawChainedEntry = true;
    checkChainedAuditEntry(artifact, issues, index, entry);
  }
  verifyMaterializedReviewState(artifact, issues);
  return { ok: issues.length === 0, issues };
};

const storeFor = (evidenceDir: string): ContainedJsonArtifactStore<QiReviewStateArtifact> =>
  createNodeContainedJsonArtifactStore(evidenceDir, REVIEW_SUFFIX, { parse: parseArtifact });

export class QualityIntelligenceReviewIntegrityError extends Error {
  readonly issues: readonly QiReviewAuditIntegrityIssue[];

  constructor(issues: readonly QiReviewAuditIntegrityIssue[]) {
    super("Quality Intelligence review artifact failed integrity validation.");
    this.name = "QualityIntelligenceReviewIntegrityError";
    this.issues = issues;
  }
}

export const loadRunReviewState = (
  runId: string,
  evidenceDir: string,
): QiReviewStateArtifact | undefined => {
  const artifact = storeFor(evidenceDir).load(runId);
  if (artifact === undefined) return undefined;
  const integrity = verifyQiReviewAuditIntegrity(artifact);
  if (!integrity.ok) throw new QualityIntelligenceReviewIntegrityError(integrity.issues);
  return artifact;
};

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

const TRANSITION_EVENT: Readonly<
  Record<QiReviewAction, QualityIntelligenceReview.QualityIntelligenceReviewTransitionEvent>
> = {
  approve: "approve",
  reject: "reject",
  "request-changes": "request-changes",
  reopen: "revise",
  withdraw: "withdraw",
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

export type QualityIntelligenceReviewGovernanceRejectedCode =
  | QualityIntelligenceReview.QualityIntelligenceFourEyesViolationCode
  | "UNVERIFIED_PRIOR_ACTOR"
  | "REOPEN_REASON_REQUIRED"
  | "REOPEN_ACTOR_REQUIRED";

export class QualityIntelligenceReviewGovernanceRejected extends Error {
  readonly code: QualityIntelligenceReviewGovernanceRejectedCode;
  readonly action: QiReviewAction;
  readonly candidateId: string;

  constructor(
    code: QualityIntelligenceReviewGovernanceRejectedCode,
    action: QiReviewAction,
    candidateId: string,
    detail: string,
  ) {
    super(
      `[${code}] ${action} candidate "${candidateId}" rejected by review governance: ${detail}`,
    );
    this.name = "QualityIntelligenceReviewGovernanceRejected";
    this.code = code;
    this.action = action;
    this.candidateId = candidateId;
  }
}

export class QualityIntelligenceReviewCandidateNotFound extends Error {
  readonly candidateId: string;

  constructor(candidateId: string) {
    super(`Candidate "${candidateId}" is not part of this Quality Intelligence run.`);
    this.name = "QualityIntelligenceReviewCandidateNotFound";
    this.candidateId = candidateId;
  }
}

export class QualityIntelligenceReviewRunApprovalRejected extends Error {
  readonly unapprovedCandidateIds: readonly string[];

  constructor(unapprovedCandidateIds: readonly string[]) {
    super(
      `Run approval rejected because ${String(unapprovedCandidateIds.length)} candidate(s) are not approved.`,
    );
    this.name = "QualityIntelligenceReviewRunApprovalRejected";
    this.unapprovedCandidateIds = unapprovedCandidateIds;
  }
}

export class QualityIntelligenceReviewWriteConflict extends Error {
  readonly runId: string;

  constructor(runId: string) {
    super(`Timed out waiting for the review-state write lock for run "${runId}".`);
    this.name = "QualityIntelligenceReviewWriteConflict";
    this.runId = runId;
  }
}

export interface ApplyReviewDecisionInput {
  readonly runId: string;
  readonly evidenceDir: string;
  readonly action: QiReviewAction;
  readonly scope: "run" | "candidate";
  readonly candidateId?: string;
  /** Candidate ids loaded from the immutable candidates artifact for store-level governance checks. */
  readonly candidateIds?: readonly string[];
  /** Optional browser/display label; never used as the authoritative reviewer identity. */
  readonly reviewerLabel?: string;
  readonly actor?: QiReviewActor;
  readonly reason?: string;
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

const normaliseAuditLabel = (value: string | undefined, fallback: string): string => {
  const label = value?.trim() ?? "";
  return label.length > 0 ? label.slice(0, 80) : fallback;
};

const normaliseActorId = (value: string | undefined): string => {
  const actorId = value?.trim() ?? "";
  return actorId.length > 0 ? actorId.slice(0, 128) : "local:reviewer";
};

const resolvedActor = (
  input: Pick<ApplyReviewDecisionInput, "actor" | "reviewerLabel">,
): QiReviewActor => {
  const displayLabel = normaliseAuditLabel(
    input.actor?.displayLabel ?? input.reviewerLabel,
    "reviewer",
  );
  return {
    actorId: normaliseActorId(input.actor?.actorId ?? `legacy:${displayLabel.toLowerCase()}`),
    displayLabel,
    source: input.actor?.source ?? "legacy-review-label",
    kind: input.actor?.kind ?? "human",
  };
};

const sleepSync = (ms: number): void => {
  const buffer = new SharedArrayBuffer(4);
  const view = new Int32Array(buffer);
  Atomics.wait(view, 0, 0, ms);
};

// GEN-PERF-PERSISTENCE-007 — the review-artifact critical section is synchronous (its callers are
// exported sync functions), so the poll cannot yield the event loop. Instead we make the wait
// UNNECESSARY when the lock is ownerless/dead: record the holder PID and reclaim the lock
// immediately when that PID is not alive (crashed writer, or a stale/test-created lock), rather than
// exhausting all REVIEW_LOCK_ATTEMPTS busy-waits and then failing. A lock held by a LIVE process is
// still honoured (we retry with the short sleep), preserving cross-writer serialisation.
const readReviewLockPid = (lockPath: string): number | undefined => {
  try {
    const pid = Number.parseInt(readFileSync(lockPath, "utf8").trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
};

const reviewLockOwnerIsDead = (lockPath: string): boolean => {
  const pid = readReviewLockPid(lockPath);
  if (pid === undefined) return true;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "EPERM";
  }
};

const stampReviewLockOwner = (fd: number): void => {
  try {
    writeSync(fd, `${String(process.pid)}\n`);
    fsyncSync(fd);
  } catch {
    // Best-effort ownership stamp; the lock still works without it.
  }
};

// Closes and removes a lock handle that failed mid-acquisition. Extracted so
// withReviewArtifactLock stays under the cognitive-complexity bound.
const cleanupFailedLockHandle = (fd: number | undefined, lockPath: string): void => {
  if (fd === undefined) return;
  try {
    closeSync(fd);
  } catch {
    // Ignore close failures while unwinding a failed lock holder.
  }
  rmSync(lockPath, { force: true });
};

// Only EEXIST ("another writer already holds the lock") is retryable; anything else is a real
// failure and must propagate unchanged.
const assertRetryableLockError = (error: unknown): void => {
  if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
};

// Reclaim a dead/ownerless lock immediately instead of busy-waiting; a live foreign holder still
// gets the short poll so real cross-writer contention stays serialised.
const reclaimDeadReviewLock = (lockPath: string): boolean => {
  if (!reviewLockOwnerIsDead(lockPath)) return false;
  rmSync(lockPath, { force: true });
  return true;
};

const withReviewArtifactLock = <T>(evidenceDir: string, runId: string, operation: () => T): T => {
  const lockDir = join(evidenceDir, "qi", REVIEW_LOCK_SUBDIR);
  const lockPath = join(lockDir, `${sha256Hex(runId).slice(0, 32)}.lock`);
  mkdirSync(lockDir, { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < REVIEW_LOCK_ATTEMPTS; attempt += 1) {
    let fd: number | undefined;
    try {
      fd = openSync(lockPath, "wx", 0o600);
      stampReviewLockOwner(fd);
      try {
        return operation();
      } finally {
        closeSync(fd);
        rmSync(lockPath, { force: true });
      }
    } catch (error) {
      cleanupFailedLockHandle(fd, lockPath);
      assertRetryableLockError(error);
      if (reclaimDeadReviewLock(lockPath)) continue;
      sleepSync(REVIEW_LOCK_SLEEP_MS);
    }
  }
  throw new QualityIntelligenceReviewWriteConflict(runId);
};

const normaliseAuditReason = (value: string | undefined): string | undefined => {
  const reason = value?.trim() ?? "";
  return reason.length > 0 ? reason.slice(0, MAX_REASON_LEN) : undefined;
};

const assertKnownCandidate = (input: ApplyReviewDecisionInput): void => {
  if (input.scope !== "candidate") return;
  const candidateId = input.candidateId?.trim();
  if (candidateId === undefined || candidateId.length === 0) {
    throw new QualityIntelligenceReviewCandidateNotFound("");
  }
  if (input.candidateIds !== undefined && !input.candidateIds.includes(candidateId)) {
    throw new QualityIntelligenceReviewCandidateNotFound(candidateId);
  }
};

const assertRunApprovalCandidates = (
  current: QiReviewStateArtifact,
  input: ApplyReviewDecisionInput,
): void => {
  if (input.scope !== "run" || input.action !== "approve" || input.candidateIds === undefined) {
    return;
  }
  const unapproved = input.candidateIds.filter(
    (candidateId) => candidateReviewStateOf(current, candidateId) !== "approved",
  );
  if (unapproved.length > 0) throw new QualityIntelligenceReviewRunApprovalRejected(unapproved);
};

const assertReopenGovernance = (
  input: ApplyReviewDecisionInput,
  actor: QiReviewActor,
  reason: string | undefined,
): void => {
  if (input.action !== "reopen") return;
  const subject = input.candidateId ?? "__run__";
  if (input.actor === undefined || actor.actorId.trim().length === 0) {
    throw new QualityIntelligenceReviewGovernanceRejected(
      "REOPEN_ACTOR_REQUIRED",
      input.action,
      subject,
      "Reopen requires a server-resolved actor.",
    );
  }
  if (reason === undefined) {
    throw new QualityIntelligenceReviewGovernanceRejected(
      "REOPEN_REASON_REQUIRED",
      input.action,
      subject,
      "Reopen requires a non-empty reason.",
    );
  }
};

const applyPureTransition = (
  fromState: ReviewState,
  action: QiReviewAction,
  actor: QiReviewActor,
  at: string,
): ReviewState => {
  try {
    return QualityIntelligenceReview.applyReviewTransition(
      fromState,
      TRANSITION_EVENT[action],
      actor.actorId,
      at,
    ).state;
  } catch (error) {
    if (error instanceof QualityIntelligenceReview.QualityIntelligenceReviewTransitionError) {
      throw new QualityIntelligenceReviewTransitionRejected(
        fromState,
        action,
        QualityIntelligence.QUALITY_INTELLIGENCE_REVIEW_ACTION_TARGET[action],
      );
    }
    throw error;
  }
};

const reviewRecordId = (parts: readonly string[]): QI.QualityIntelligenceReviewRecordId =>
  QualityIntelligence.asQualityIntelligenceReviewRecordId(
    `qi-review-${sha256Hex(parts.join("|")).slice(0, 32)}`,
  );

const reviewRecordFromAudit = (
  runId: string,
  entry: QiReviewAuditEntry,
  reviewerKind: QI.QualityIntelligenceReviewerKind,
): QI.QualityIntelligenceReviewRecord | undefined => {
  if (entry.actorId === undefined) return undefined;
  return {
    id: reviewRecordId([runId, entry.candidateId ?? "run", entry.at, entry.action, entry.actorId]),
    runId: QualityIntelligence.asQualityIntelligenceRunId(runId),
    reviewerKind,
    reviewerLabel: entry.actorId,
    state: entry.toState,
    createdAt: entry.at,
    lastUpdatedAt: entry.at,
  };
};

const reviewRecordFromActor = (
  runId: string,
  candidateId: string,
  action: QiReviewAction,
  actor: QiReviewActor,
  at: string,
): QI.QualityIntelligenceReviewRecord => ({
  id: reviewRecordId([runId, candidateId, at, action, actor.actorId]),
  runId: QualityIntelligence.asQualityIntelligenceRunId(runId),
  reviewerKind: "human-reviewer",
  reviewerLabel: actor.actorId,
  state: QualityIntelligence.QUALITY_INTELLIGENCE_REVIEW_ACTION_TARGET[action],
  createdAt: at,
  lastUpdatedAt: at,
});

const latestHumanEditForCandidate = (
  artifact: QiReviewStateArtifact,
  candidateId: string,
): QiReviewAuditEntry | undefined => {
  for (let index = artifact.auditLog.length - 1; index >= 0; index -= 1) {
    const entry = artifact.auditLog[index];
    if (
      entry?.scope === "candidate" &&
      entry.candidateId === candidateId &&
      entry.action === "edit" &&
      (entry.actorKind ?? "human") === "human"
    ) {
      return entry;
    }
  }
  return undefined;
};

const assertApprovalFourEyes = (
  current: QiReviewStateArtifact,
  input: ApplyReviewDecisionInput,
  actor: QiReviewActor,
): void => {
  if (
    input.action !== "approve" ||
    input.scope !== "candidate" ||
    input.candidateId === undefined
  ) {
    return;
  }
  const authorEntry = latestHumanEditForCandidate(current, input.candidateId);
  if (authorEntry === undefined) return;
  const authorRecord = reviewRecordFromAudit(input.runId, authorEntry, "human-author");
  if (authorRecord === undefined) {
    throw new QualityIntelligenceReviewGovernanceRejected(
      "UNVERIFIED_PRIOR_ACTOR",
      input.action,
      input.candidateId,
      "The latest candidate edit predates actor-bound audit entries.",
    );
  }
  try {
    QualityIntelligenceReview.assertFourEyesPair(
      authorRecord,
      reviewRecordFromActor(input.runId, input.candidateId, input.action, actor, input.now),
    );
  } catch (error) {
    if (error instanceof QualityIntelligenceReview.QualityIntelligenceFourEyesViolationError) {
      throw new QualityIntelligenceReviewGovernanceRejected(
        error.code,
        input.action,
        input.candidateId,
        error.message,
      );
    }
    throw error;
  }
};

const auditActorFields = (
  actor: QiReviewActor,
  reviewerLabel: string | undefined,
  redact: ReviewRedactor,
): Pick<
  QiReviewAuditEntry,
  | "reviewerLabel"
  | "actorId"
  | "actorDisplayLabel"
  | "actorSource"
  | "actorKind"
  | "selfAssertedReviewerLabel"
> => {
  const actorDisplayLabel = redactLabel(actor.displayLabel, redact);
  const displayLabel = normaliseAuditLabel(reviewerLabel, "");
  return {
    reviewerLabel: actorDisplayLabel,
    actorId: actor.actorId,
    actorDisplayLabel,
    ...(actor.source !== undefined ? { actorSource: actor.source } : {}),
    actorKind: actor.kind ?? "human",
    ...(displayLabel.length > 0
      ? { selfAssertedReviewerLabel: redactLabel(displayLabel, redact) }
      : {}),
  };
};

/**
 * Apply a review decision and persist the updated artifact. Validates transition legality first
 * (FIX A): an illegal transition throws `QualityIntelligenceReviewTransitionRejected` and persists
 * nothing — no audit entry is ever appended for a rejected transition. On success, appends an
 * append-only audit entry (with a redacted reviewer label, FIX M1) and returns the new artifact.
 * The caller is responsible for authorising the action.
 */
export const applyReviewDecision = (input: ApplyReviewDecisionInput): QiReviewStateArtifact => {
  return withReviewArtifactLock(input.evidenceDir, input.runId, () => {
    const current =
      loadRunReviewState(input.runId, input.evidenceDir) ?? emptyArtifact(input.runId, input.now);
    assertKnownCandidate(input);
    assertRunApprovalCandidates(current, input);
    const actor = resolvedActor(input);
    const reason = normaliseAuditReason(input.reason);
    assertReopenGovernance(input, actor, reason);
    const isCandidate = input.scope === "candidate" && input.candidateId !== undefined;
    const fromState = isCandidate
      ? candidateReviewStateOf(current, input.candidateId)
      : current.runState;
    const toState = applyPureTransition(fromState, input.action, actor, input.now);
    assertApprovalFourEyes(current, input, actor);
    const candidateStates = isCandidate
      ? Object.assign(toNullProtoStates(current.candidateStates), { [input.candidateId]: toState })
      : current.candidateStates;
    const audit: QiReviewAuditEntry = {
      at: input.now,
      action: input.action,
      scope: input.scope,
      ...(isCandidate ? { candidateId: input.candidateId } : {}),
      ...auditActorFields(actor, input.reviewerLabel, input.redact),
      ...(reason !== undefined ? { reason: redactLabel(reason, input.redact) } : {}),
      fromState,
      toState,
    };
    const next: QiReviewStateArtifact = {
      qiReviewSchemaVersion: QI_REVIEW_SCHEMA_VERSION,
      runId: input.runId,
      runState: isCandidate ? current.runState : toState,
      candidateStates,
      auditLog: [...current.auditLog, chainAuditEntry(current.auditLog, audit)],
      lastUpdatedAt: input.now,
    };
    storeFor(input.evidenceDir).record(input.runId, next);
    return next;
  });
};

// ─── Inline-edit audit (Epic #712, Issue #726) ──────────────────────────────────

export interface AppendEditAuditInput {
  readonly runId: string;
  readonly evidenceDir: string;
  readonly candidateId: string;
  readonly reviewerLabel: string;
  readonly actor?: QiReviewActor;
  readonly now: string;
  /** Redacts the reviewer label before it lands in the persisted audit log (Issue #282 FIX M1). */
  readonly redact: ReviewRedactor;
}

/**
 * Append an append-only `edit` audit entry for an inline candidate edit. Display labels are redacted
 * before persist (FIX M1). Edits to terminal candidates reopen review by moving the candidate to
 * `changes-requested` with visible revalidation/rejudge flags. Persists and returns the updated
 * review artifact (created empty on first use). Run-level terminal approvals are treated as an
 * effective approval of every candidate, so editing any candidate invalidates the run approval too.
 */
export const appendEditAudit = (input: AppendEditAuditInput): QiReviewStateArtifact => {
  return withReviewArtifactLock(input.evidenceDir, input.runId, () => {
    const current =
      loadRunReviewState(input.runId, input.evidenceDir) ?? emptyArtifact(input.runId, input.now);
    const actor = resolvedActor(input);
    const candidateState = candidateReviewStateOf(current, input.candidateId);
    const runState = runReviewStateOf(current);
    const state = QualityIntelligence.isTerminalReviewState(candidateState)
      ? candidateState
      : QualityIntelligence.isTerminalReviewState(runState)
        ? runState
        : candidateState;
    const terminalEdit = QualityIntelligence.isTerminalReviewState(state);
    const toState: ReviewState = terminalEdit ? "changes-requested" : state;
    const audit: QiReviewAuditEntry = {
      at: input.now,
      action: "edit",
      scope: "candidate",
      candidateId: input.candidateId,
      ...auditActorFields(actor, input.reviewerLabel, input.redact),
      ...(terminalEdit
        ? {
            reason: "candidate-edited-after-terminal-review",
            governanceFlags: ["needs-revalidation", "needs-rejudge"] as const,
          }
        : {}),
      fromState: state,
      toState,
    };
    const candidateStates = terminalEdit
      ? Object.assign(toNullProtoStates(current.candidateStates), { [input.candidateId]: toState })
      : current.candidateStates;
    const runStateAfterEdit =
      terminalEdit && QualityIntelligence.isTerminalReviewState(current.runState)
        ? toState
        : current.runState;
    const next: QiReviewStateArtifact = {
      ...current,
      runState: runStateAfterEdit,
      candidateStates,
      auditLog: [...current.auditLog, chainAuditEntry(current.auditLog, audit)],
      lastUpdatedAt: input.now,
    };
    storeFor(input.evidenceDir).record(input.runId, next);
    return next;
  });
};

export interface MigrateReviewStateForRegenerationInput {
  readonly oldRunId: string;
  readonly newRunId: string;
  readonly evidenceDir: string;
  readonly preservedCandidateIds: readonly string[];
  readonly staleCandidateIds: readonly string[];
  readonly now: string;
  readonly redact: ReviewRedactor;
}

const hasExplicitCandidateState = (artifact: QiReviewStateArtifact, candidateId: string): boolean =>
  Object.prototype.hasOwnProperty.call(artifact.candidateStates, candidateId);

const hasCandidateAudit = (artifact: QiReviewStateArtifact, candidateId: string): boolean =>
  artifact.auditLog.some(
    (entry) => entry.scope === "candidate" && entry.candidateId === candidateId,
  );

const regenerationActor: QiReviewActor = {
  actorId: "system:quality-intelligence-regenerate-stale",
  displayLabel: "Quality Intelligence regeneration",
  source: "server-system",
  kind: "system",
};

const regenerationAudit = (args: {
  readonly action: "regenerate-preserved" | "regenerate-reopened";
  readonly now: string;
  readonly candidateId: string;
  readonly oldRunId: string;
  readonly fromState: ReviewState;
  readonly toState: ReviewState;
  readonly redact: ReviewRedactor;
}): QiReviewAuditEntry => ({
  at: args.now,
  action: args.action,
  scope: "candidate",
  candidateId: args.candidateId,
  ...auditActorFields(regenerationActor, undefined, args.redact),
  sourceRunId: args.oldRunId,
  sourceCandidateId: args.candidateId,
  fromState: args.fromState,
  toState: args.toState,
});

/**
 * Carry review state from an immutable source run into a newly materialised regenerate-stale run.
 * Fresh/preserved candidates keep their candidate review state and candidate audit entries in the
 * new run's companion artifact. Stale candidates deliberately do not carry approvals forward; when
 * a stale candidate had prior review state/audit, the new run records an explicit reopened audit
 * event so the loss of approval is visible instead of silently disappearing with the old run id.
 */
export const migrateReviewStateForRegeneration = (
  input: MigrateReviewStateForRegenerationInput,
  // eslint-disable-next-line max-lines-per-function, complexity
): QiReviewStateArtifact | undefined => {
  const oldArtifact = loadRunReviewState(input.oldRunId, input.evidenceDir);
  if (oldArtifact === undefined) return undefined;
  const preserved = new Set(input.preservedCandidateIds);
  const stale = new Set(input.staleCandidateIds);
  const candidateStates = toNullProtoStates({});
  const migratedAudit: QiReviewAuditEntry[] = [];
  for (const entry of oldArtifact.auditLog) {
    if (
      entry.scope === "candidate" &&
      entry.candidateId !== undefined &&
      preserved.has(entry.candidateId)
    ) {
      migratedAudit.push({ ...stripAuditChainFields(entry), sourceRunId: input.oldRunId });
    }
  }
  for (const candidateId of preserved) {
    const state = candidateReviewStateOf(oldArtifact, candidateId);
    if (hasExplicitCandidateState(oldArtifact, candidateId)) {
      candidateStates[candidateId] = state;
    }
    if (
      hasExplicitCandidateState(oldArtifact, candidateId) ||
      hasCandidateAudit(oldArtifact, candidateId)
    ) {
      migratedAudit.push(
        regenerationAudit({
          action: "regenerate-preserved",
          now: input.now,
          candidateId,
          oldRunId: input.oldRunId,
          fromState: state,
          toState: state,
          redact: input.redact,
        }),
      );
    }
  }
  for (const candidateId of stale) {
    const state = candidateReviewStateOf(oldArtifact, candidateId);
    if (
      state !== "open" ||
      hasExplicitCandidateState(oldArtifact, candidateId) ||
      hasCandidateAudit(oldArtifact, candidateId)
    ) {
      migratedAudit.push(
        regenerationAudit({
          action: "regenerate-reopened",
          now: input.now,
          candidateId,
          oldRunId: input.oldRunId,
          fromState: state,
          toState: "open",
          redact: input.redact,
        }),
      );
    }
  }
  if (Object.keys(candidateStates).length === 0 && migratedAudit.length === 0) return undefined;
  const next: QiReviewStateArtifact = {
    qiReviewSchemaVersion: QI_REVIEW_SCHEMA_VERSION,
    runId: input.newRunId,
    runState: "open",
    candidateStates,
    auditLog: chainAuditLog(migratedAudit),
    lastUpdatedAt: input.now,
  };
  withReviewArtifactLock(input.evidenceDir, input.newRunId, () => {
    storeFor(input.evidenceDir).record(input.newRunId, next);
  });
  return next;
};
