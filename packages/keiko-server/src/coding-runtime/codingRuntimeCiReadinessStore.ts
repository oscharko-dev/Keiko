import type { DatabaseSync } from "node:sqlite";
import { canonicalise, sha256Hex } from "@oscharko-dev/keiko-security";
import {
  isReadinessSnapshot,
  type ReadinessSnapshot,
} from "@oscharko-dev/keiko-contracts/runtime/git-delivery-provider";
import type { DraftDeliveryRecord } from "@oscharko-dev/keiko-contracts/runtime/draft-delivery";
import type {
  CodingRuntimeSnapshot,
  CodingRuntimeSnapshotStore,
} from "./codingRuntimeSnapshotStore.js";

export interface CiObservationTicket {
  readonly runId: string;
  readonly revision: number;
  readonly draftDigest: string;
  readonly authorityDigest: string;
}
export interface CodingRuntimeCiReadinessStore {
  begin(runId: string): CiObservationTicket;
  invalidate(runId: string): boolean;
  complete(ticket: CiObservationTicket, readiness: ReadinessSnapshot): boolean;
  get(runId: string): ReadinessSnapshot | undefined;
}
function live(snapshot: CodingRuntimeSnapshot | undefined): snapshot is CodingRuntimeSnapshot {
  return (
    snapshot !== undefined &&
    (snapshot.state === "running" || snapshot.state === "awaiting-approval") &&
    snapshot.terminalAt === undefined
  );
}
function draftDigest(draft: DraftDeliveryRecord): string {
  return sha256Hex(canonicalise(draft));
}
export function readinessMatchesDraft(
  readiness: ReadinessSnapshot,
  draft: DraftDeliveryRecord | undefined,
): boolean {
  if (draft?.pullRequest === undefined) return false;
  const binding = draft.binding;
  return [
    readiness.runId === binding.runId,
    readiness.remoteDigest === binding.remoteDigest,
    readiness.repository.toLowerCase() === binding.repository.toLowerCase(),
    readiness.prNumber === draft.pullRequest.number,
    readiness.baseRef === binding.baseRef,
    readiness.headRef === binding.headRef,
    readiness.headSha === binding.headSha,
  ].every(Boolean);
}
export function ciReadinessFromRow(value: string | null): {
  readonly ciReadiness?: ReadinessSnapshot;
} {
  if (value === null) return {};
  const parsed: unknown = JSON.parse(value);
  if (!isReadinessSnapshot(parsed)) throw new TypeError("Invalid persisted CI readiness");
  return { ciReadiness: parsed };
}
function begin(
  db: DatabaseSync,
  snapshots: Pick<CodingRuntimeSnapshotStore, "get">,
  runId: string,
): CiObservationTicket {
  const current = snapshots.get(runId);
  if (!live(current) || current.draftDelivery?.pullRequest === undefined)
    throw new TypeError("CI observation has no live confirmed draft");
  const row = db
    .prepare(
      `UPDATE coding_runtime_snapshots SET ci_observation_revision = ci_observation_revision + 1
    WHERE run_id = ? AND ci_observation_revision < 999999
    AND draft_delivery_record = ? AND authority_digest = ?
    AND state IN ('running', 'awaiting-approval') AND terminal_at IS NULL
    RETURNING ci_observation_revision`,
    )
    .get(runId, JSON.stringify(current.draftDelivery), current.authorityDigest) as
    { ci_observation_revision: number } | undefined;
  if (row === undefined) throw new TypeError("CI observation capacity exhausted");
  return Object.freeze({
    runId,
    revision: row.ci_observation_revision,
    draftDigest: draftDigest(current.draftDelivery),
    authorityDigest: current.authorityDigest,
  });
}
function complete(
  db: DatabaseSync,
  snapshots: Pick<CodingRuntimeSnapshotStore, "get">,
  ticket: CiObservationTicket,
  readiness: ReadinessSnapshot,
): boolean {
  if (!isReadinessSnapshot(readiness)) throw new TypeError("Invalid CI readiness result");
  const current = snapshots.get(ticket.runId);
  if (
    !live(current) ||
    current.draftDelivery === undefined ||
    current.authorityDigest !== ticket.authorityDigest
  )
    return false;
  if (
    draftDigest(current.draftDelivery) !== ticket.draftDigest ||
    !readinessMatchesDraft(readiness, current.draftDelivery)
  )
    return false;
  const encoded = JSON.stringify(readiness);
  if (Buffer.byteLength(encoded, "utf8") > 8192)
    throw new TypeError("CI readiness result exceeds storage bound");
  return (
    db
      .prepare(
        `UPDATE coding_runtime_snapshots SET ci_readiness_record = ?,
    ci_observation_revision = ci_observation_revision + 1 WHERE run_id = ?
    AND ci_observation_revision = ? AND ci_observation_revision < 1000000
    AND draft_delivery_record = ? AND authority_digest = ?
    AND state IN ('running', 'awaiting-approval') AND terminal_at IS NULL`,
      )
      .run(
        encoded,
        ticket.runId,
        ticket.revision,
        JSON.stringify(current.draftDelivery),
        current.authorityDigest,
      ).changes === 1
  );
}
export function createCodingRuntimeCiReadinessStore(
  db: DatabaseSync,
  snapshots: Pick<CodingRuntimeSnapshotStore, "get">,
): CodingRuntimeCiReadinessStore {
  return {
    begin: (runId) => begin(db, snapshots, runId),
    invalidate: (runId): boolean =>
      db
        .prepare(
          `UPDATE coding_runtime_snapshots SET ci_readiness_record = NULL,
        ci_observation_revision = ci_observation_revision + 1 WHERE run_id = ?
        AND ci_observation_revision < 1000000
        AND state IN ('running', 'awaiting-approval') AND terminal_at IS NULL`,
        )
        .run(runId).changes === 1,
    complete: (ticket, readiness) => complete(db, snapshots, ticket, readiness),
    get: (runId): ReadinessSnapshot | undefined => {
      const current = snapshots.get(runId);
      if (current === undefined) return undefined;
      const row = db
        .prepare("SELECT ci_readiness_record FROM coding_runtime_snapshots WHERE run_id = ?")
        .get(runId) as { ci_readiness_record: string | null };
      const readiness = ciReadinessFromRow(row.ci_readiness_record).ciReadiness;
      return readiness !== undefined && readinessMatchesDraft(readiness, current.draftDelivery)
        ? readiness
        : undefined;
    },
  };
}
