import type { DatabaseSync } from "node:sqlite";
import {
  isDraftDeliveryRecord,
  type DraftDeliveryPhase,
  type DraftDeliveryRecord,
} from "@oscharko-dev/keiko-contracts/runtime/draft-delivery";
import { canonicalise } from "@oscharko-dev/keiko-security";
import type { VerifiedCommitResult } from "@oscharko-dev/keiko-contracts/runtime/verified-commit";
import {
  assertDraftDeliveryVerifiedSource,
  draftDeliveryLineageRecord,
  draftRecoveryTarget,
  draftDeliverySourceFromRow,
  hasDraftDeliveryPredecessorSource,
  localDraftDeliverySource,
} from "./codingRuntimeDraftDeliverySource.js";
import type { CodingRuntimeSnapshot } from "./codingRuntimeSnapshotStore.js";

const NEXT: Readonly<Record<DraftDeliveryPhase, ReadonlySet<DraftDeliveryPhase>>> = {
  "push-proposed": new Set(["pushing", "recovery-required"]),
  pushing: new Set(["pushed", "recovery-required"]),
  pushed: new Set(["pr-proposed", "push-proposed", "recovery-required"]),
  "pr-proposed": new Set(["creating-pr", "recovery-required"]),
  "creating-pr": new Set(["draft-created", "recovery-required"]),
  "draft-created": new Set(["push-proposed", "recovery-required"]),
  "recovery-required": new Set([
    "push-proposed",
    "pushed",
    "pr-proposed",
    "draft-created",
    "recovery-required",
  ]),
};

export function draftDeliveryFromRow(value: string | null): {
  readonly draftDelivery?: DraftDeliveryRecord;
} {
  if (value === null) return {};
  const parsed: unknown = JSON.parse(value);
  if (!isDraftDeliveryRecord(parsed)) throw new TypeError("invalid persisted draft delivery");
  return { draftDelivery: parsed };
}

export function assertDraftDeliveryForSnapshot(
  snapshot: CodingRuntimeSnapshot,
  value: DraftDeliveryRecord,
): void {
  if (!isDraftDeliveryRecord(value)) throw new TypeError("invalid draft delivery record");
  const target = value.binding;
  const issue = snapshot.issueBinding;
  const matches = [
    target.runId === snapshot.runId,
    target.workspaceDigest === snapshot.workspaceDigest,
    target.runtimeAuthorityDigest === snapshot.authorityDigest,
    target.issueBindingDigest === issue?.bindingDigest,
    target.remoteDigest === issue?.remoteDigest,
    target.issueIdDigest === issue?.issueIdDigest,
    target.issueNumber === issue?.issueNumber,
    target.baseRef === issue?.defaultBaseRef,
  ];
  if (!matches.every(Boolean)) throw new TypeError("draft delivery runtime binding mismatch");
}

function stableTarget(value: DraftDeliveryRecord): string {
  const revisionFields = new Set(["headSha", "baseSha", "verifiedCommitProposalId"]);
  return canonicalise(
    Object.fromEntries(Object.entries(value.binding).filter(([key]) => !revisionFields.has(key))),
  );
}

function assertTransition(
  current: DraftDeliveryRecord | undefined,
  next: DraftDeliveryRecord,
): void {
  if (current === undefined) {
    if (next.phase !== "push-proposed" || next.pullRequest !== undefined)
      throw new TypeError("draft delivery must start with a push proposal");
    return;
  }
  if (!NEXT[current.phase].has(next.phase))
    throw new TypeError("invalid draft delivery phase transition");
  assertTransitionTarget(current, next);
  assertTransitionPayload(current, next);
}

function assertTransitionTarget(current: DraftDeliveryRecord, next: DraftDeliveryRecord): void {
  if (stableTarget(current) !== stableTarget(next))
    throw new TypeError("draft delivery target changed");
  if (
    next.phase !== "push-proposed" &&
    canonicalise(current.binding) !== canonicalise(next.binding)
  )
    throw new TypeError("draft delivery revision changed without a new proposal");
  if (
    current.pullRequest !== undefined &&
    current.pullRequest.externalId !== next.pullRequest?.externalId
  )
    throw new TypeError("draft delivery cannot lose or replace its remote identity");
}

function assertTransitionPayload(current: DraftDeliveryRecord, next: DraftDeliveryRecord): void {
  if (next.phase === "pushing" || next.phase === "creating-pr") {
    if (next.proposalId !== current.proposalId || next.proposalDigest !== current.proposalDigest)
      throw new TypeError("draft delivery payload changed before dispatch");
  }
}

function assertRevision(
  current: DraftDeliveryRecord | undefined,
  value: DraftDeliveryRecord,
  expected: number | null,
): void {
  if ((current?.revision ?? null) !== expected || value.revision !== (expected ?? -1) + 1)
    throw new TypeError("stale draft delivery revision");
}

export function recordDraftDelivery(
  db: DatabaseSync,
  read: (runId: string) => CodingRuntimeSnapshot | undefined,
  value: DraftDeliveryRecord,
  expectedRevision: number | null,
  recordedAt: string = new Date().toISOString(),
): CodingRuntimeSnapshot {
  if (!isDraftDeliveryRecord(value)) throw new TypeError("invalid draft delivery record");
  const snapshot = read(value.binding.runId);
  if (snapshot === undefined) throw new TypeError("draft delivery runtime was not found");
  assertDraftDeliveryForSnapshot(snapshot, value);
  const current = snapshot.draftDelivery;
  assertRevision(current, value, expectedRevision);
  assertTransition(current, value);
  const readSource = (row: CodingRuntimeSnapshot): VerifiedCommitResult | undefined =>
    draftDeliverySourceFromRow(row, sourceJson(db, row.runId));
  if (value.phase === "push-proposed")
    assertDraftDeliveryVerifiedSource(snapshot, value, read, readSource);
  const source = localDraftDeliverySource(snapshot, value, readSource(snapshot));
  return persistDraft(db, snapshot, value, source, recordedAt);
}

function sourceJson(db: DatabaseSync, runId: string): string | null {
  const row = db
    .prepare("SELECT draft_delivery_source_receipt FROM coding_runtime_snapshots WHERE run_id = ?")
    .get(runId) as { draft_delivery_source_receipt: string | null } | undefined;
  if (row === undefined) throw new TypeError("draft delivery source runtime was not found");
  return row.draft_delivery_source_receipt;
}

// Bumps `revision`/`updated_at` on the row like every other mutating transition (#3384 batch-1
// B5-6): the existing CAS predicate below already refuses a concurrent write, but without this the
// accepted write itself was a same-revision no-op a poller or SSE catch-up could miss.
function persistDraft(
  db: DatabaseSync,
  snapshot: CodingRuntimeSnapshot,
  value: DraftDeliveryRecord,
  source: VerifiedCommitResult | undefined,
  recordedAt: string,
): CodingRuntimeSnapshot {
  const current = snapshot.draftDelivery;
  const previous = current === undefined ? null : JSON.stringify(current);
  const previousSource = sourceJson(db, snapshot.runId);
  const update = db
    .prepare(
      "UPDATE coding_runtime_snapshots SET draft_delivery_record = ?, draft_delivery_source_receipt = ?, revision = revision + 1, updated_at = ? WHERE run_id = ? AND draft_delivery_record IS ? AND draft_delivery_source_receipt IS ?",
    )
    .run(
      JSON.stringify(value),
      source === undefined ? null : JSON.stringify(source),
      recordedAt,
      value.binding.runId,
      previous,
      previousSource,
    );
  if (Number(update.changes) !== 1) throw new TypeError("concurrent draft delivery update");
  return {
    ...snapshot,
    draftDelivery: value,
    revision: snapshot.revision + 1,
    updatedAt: recordedAt,
  };
}

function assertRecoveryStart(snapshot: CodingRuntimeSnapshot, value: DraftDeliveryRecord): void {
  if (
    snapshot.draftDelivery !== undefined ||
    value.revision !== 0 ||
    value.phase !== "recovery-required" ||
    value.reason !== "restart-reconciliation" ||
    snapshot.terminalAt !== undefined ||
    !new Set(["ready", "running", "awaiting-approval"]).has(snapshot.state)
  )
    throw new TypeError(
      "draft recovery requires a fresh accepted run and an observation-only record",
    );
}

function assertAcknowledgedPredecessor(prior: CodingRuntimeSnapshot): void {
  if (
    prior.state !== "recovery-required" ||
    prior.terminalAt === undefined ||
    prior.recoveryAcknowledgedAt === undefined
  )
    throw new TypeError("draft recovery predecessor was not acknowledged and released");
}

function assertRecoveryPredecessor(
  snapshot: CodingRuntimeSnapshot,
  read: (runId: string) => CodingRuntimeSnapshot | undefined,
  value: DraftDeliveryRecord,
): void {
  const lineage = draftDeliveryLineageRecord(snapshot, read);
  const source = lineage?.record;
  if (lineage === undefined || source === undefined)
    throw new TypeError("draft recovery predecessor does not match the accepted task");
  assertAcknowledgedPredecessor(lineage.snapshot);
  if (
    draftRecoveryTarget(source) !== draftRecoveryTarget(value) ||
    canonicalise(source.pullRequest) !== canonicalise(value.pullRequest)
  )
    throw new TypeError("draft recovery cannot change the historical remote intent");
  if (
    value.binding.envelopeDigest === source.binding.envelopeDigest ||
    value.proposalId === source.proposalId
  )
    throw new TypeError("draft recovery requires fresh authority and proposal identity");
}

/** Copies observations only; the caller must reconcile the provider before proposing any effect. */
export function adoptDraftDeliveryFromPredecessor(
  db: DatabaseSync,
  read: (runId: string) => CodingRuntimeSnapshot | undefined,
  value: DraftDeliveryRecord,
  recordedAt: string = new Date().toISOString(),
): CodingRuntimeSnapshot {
  if (!isDraftDeliveryRecord(value)) throw new TypeError("invalid draft delivery record");
  const snapshot = read(value.binding.runId);
  if (snapshot === undefined) throw new TypeError("draft recovery runtime was not found");
  assertDraftDeliveryForSnapshot(snapshot, value);
  assertRecoveryStart(snapshot, value);
  assertRecoveryPredecessor(snapshot, read, value);
  if (
    !hasDraftDeliveryPredecessorSource(snapshot, value, read, (row) =>
      draftDeliverySourceFromRow(row, sourceJson(db, row.runId)),
    )
  )
    throw new TypeError("draft recovery has no bounded verified predecessor source");
  return persistDraft(db, snapshot, value, undefined, recordedAt);
}
