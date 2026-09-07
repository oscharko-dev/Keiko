import type { DraftDeliveryRecord } from "@oscharko-dev/keiko-contracts/runtime/draft-delivery";
import {
  isVerifiedCommitResult,
  type VerifiedCommitResult,
} from "@oscharko-dev/keiko-contracts/runtime/verified-commit";
import { canonicalise } from "@oscharko-dev/keiko-security";
import type { CodingRuntimeSnapshot } from "./codingRuntimeSnapshotStore.js";

type SnapshotReader = (runId: string) => CodingRuntimeSnapshot | undefined;
type SourceReader = (snapshot: CodingRuntimeSnapshot) => VerifiedCommitResult | undefined;
export const DRAFT_DELIVERY_RECOVERY_MAX_PREDECESSORS = 32;
const FRESH_AUTHORITY_FIELDS = new Set(["runId", "runtimeAuthorityDigest", "envelopeDigest"]);

export function draftRecoveryTarget(record: DraftDeliveryRecord): string {
  return canonicalise(
    Object.fromEntries(
      Object.entries(record.binding).filter(([key]) => !FRESH_AUTHORITY_FIELDS.has(key)),
    ),
  );
}

export function sameDraftRecoveryTask(
  current: CodingRuntimeSnapshot,
  prior: CodingRuntimeSnapshot,
): boolean {
  return (
    current.taskDigest === prior.taskDigest &&
    current.workspaceDigest === prior.workspaceDigest &&
    canonicalise(current.issueBinding) === canonicalise(prior.issueBinding)
  );
}

export interface DraftDeliveryLineageRecord {
  readonly snapshot: CodingRuntimeSnapshot;
  readonly record: DraftDeliveryRecord;
}

/** Finds the nearest same-task draft without copying its predecessor authority into this run. */
export function draftDeliveryLineageRecord(
  initial: CodingRuntimeSnapshot,
  read: SnapshotReader,
): DraftDeliveryLineageRecord | undefined {
  let current: CodingRuntimeSnapshot | undefined = initial;
  const seen = new Set<string>();
  for (let depth = 0; depth < DRAFT_DELIVERY_RECOVERY_MAX_PREDECESSORS; depth += 1) {
    if (current === undefined || seen.has(current.runId)) return undefined;
    seen.add(current.runId);
    if (!sameDraftRecoveryTask(initial, current)) return undefined;
    if (current.draftDelivery !== undefined) {
      return { snapshot: current, record: current.draftDelivery };
    }
    current = current.predecessorRunId === undefined ? undefined : read(current.predecessorRunId);
  }
  return undefined;
}

function matchesVerifiedCommit(
  snapshot: CodingRuntimeSnapshot,
  record: DraftDeliveryRecord,
  commit: VerifiedCommitResult | undefined,
): boolean {
  if (commit === undefined) return false;
  const target = record.binding;
  return [
    commit.status === "succeeded",
    commit.runId === snapshot.runId,
    commit.runtimeAuthorityDigest === snapshot.authorityDigest,
    commit.runtimeAuthorityDigest === target.runtimeAuthorityDigest,
    commit.proposalId === target.verifiedCommitProposalId,
    commit.headSha === target.headSha,
    commit.baseSha === target.baseSha,
    commit.envelopeDigest === target.envelopeDigest,
    commit.repositoryDigest === target.remoteDigest,
    commit.workspaceDigest === target.workspaceDigest,
    commit.issueBindingDigest === target.issueBindingDigest,
  ].every(Boolean);
}

/** Internal SQL-only proof: never accepted from create(), a client, or an adopted run. */
export function draftDeliverySourceFromRow(
  snapshot: CodingRuntimeSnapshot,
  value: string | null,
): VerifiedCommitResult | undefined {
  if (value === null) return undefined;
  if (value.length > 8192) throw new TypeError("oversized persisted draft delivery source");
  const parsed: unknown = JSON.parse(value);
  if (
    !isVerifiedCommitResult(parsed) ||
    snapshot.draftDelivery === undefined ||
    !matchesVerifiedCommit(snapshot, snapshot.draftDelivery, parsed)
  )
    throw new TypeError("invalid persisted draft delivery source");
  return parsed;
}

export function localDraftDeliverySource(
  snapshot: CodingRuntimeSnapshot,
  record: DraftDeliveryRecord,
  source: VerifiedCommitResult | undefined,
): VerifiedCommitResult | undefined {
  if (matchesVerifiedCommit(snapshot, record, snapshot.verifiedCommitResult))
    return snapshot.verifiedCommitResult;
  return matchesVerifiedCommit(snapshot, record, source) ? source : undefined;
}

/** Only a recorded, bounded predecessor chain can carry historical verified provenance. */
export function hasDraftDeliveryPredecessorSource(
  current: CodingRuntimeSnapshot,
  target: DraftDeliveryRecord,
  read: SnapshotReader,
  readSource: SourceReader,
): boolean {
  let runId = current.predecessorRunId;
  const seen = new Set([current.runId]);
  for (let depth = 0; depth < DRAFT_DELIVERY_RECOVERY_MAX_PREDECESSORS; depth += 1) {
    if (runId === undefined || seen.has(runId)) return false;
    seen.add(runId);
    const prior = read(runId);
    const record = prior?.draftDelivery;
    if (prior === undefined || !sameDraftRecoveryTask(current, prior)) return false;
    if (record !== undefined) {
      if (draftRecoveryTarget(record) !== draftRecoveryTarget(target)) return false;
      if (localDraftDeliverySource(prior, record, readSource(prior)) !== undefined) return true;
    }
    runId = prior.predecessorRunId;
  }
  return false;
}

export function assertDraftDeliveryVerifiedSource(
  snapshot: CodingRuntimeSnapshot,
  value: DraftDeliveryRecord,
  read: SnapshotReader,
  readSource: SourceReader,
): void {
  if (localDraftDeliverySource(snapshot, value, readSource(snapshot)) !== undefined) return;
  if (
    snapshot.draftDelivery !== undefined &&
    draftRecoveryTarget(snapshot.draftDelivery) === draftRecoveryTarget(value) &&
    hasDraftDeliveryPredecessorSource(snapshot, value, read, readSource)
  )
    return;
  throw new TypeError(
    "draft delivery requires the current verified commit or its adopted predecessor",
  );
}
