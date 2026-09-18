import type { DatabaseSync } from "node:sqlite";
import {
  isVerifiedCommitResult,
  type VerifiedCommitResult,
} from "@oscharko-dev/keiko-contracts/runtime/verified-commit";
import { activityLogEvent } from "@oscharko-dev/keiko-contracts/runtime/observability";
import type { CodingRuntimeSnapshot } from "./codingRuntimeSnapshotStore.js";
import { processServerLogSink } from "../process-log-sink.js";
import { causeChain, keikoStackFrames } from "../observability/stack-frames.js";
import { GIT_VERIFIED_COMMIT_AUTHORITY_OPERATION } from "./codingRuntimeActivityOperations.js";

class VerifiedCommitRuntimeBindingError extends TypeError {}

export function assertVerifiedCommitRuntimeBinding(
  snapshot: CodingRuntimeSnapshot,
  result: VerifiedCommitResult,
): void {
  const valid = [
    result.runId === snapshot.runId,
    result.workspaceDigest === snapshot.workspaceDigest,
    result.runtimeAuthorityDigest === snapshot.authorityDigest,
    result.issueBindingDigest === snapshot.issueBinding?.bindingDigest,
  ];
  if (!valid.every(Boolean)) {
    throw new VerifiedCommitRuntimeBindingError("verified commit runtime binding mismatch");
  }
}

/** Internal durable HEAD provenance; proposals and recovery outcomes never replace success. */
export function readLastSuccessfulVerifiedCommit(
  db: DatabaseSync,
  snapshot: CodingRuntimeSnapshot | undefined,
): VerifiedCommitResult | undefined {
  if (snapshot === undefined) return undefined;
  try {
    return readRetained(db, snapshot);
  } catch (error) {
    processServerLogSink().write(
      activityLogEvent(
        GIT_VERIFIED_COMMIT_AUTHORITY_OPERATION,
        {
          level: "warn",
          correlationId: snapshot.runId,
          errorKind:
            error instanceof VerifiedCommitRuntimeBindingError
              ? "conflict"
              : error instanceof TypeError || error instanceof SyntaxError
                ? "validation-failed"
                : "internal",
        },
        {
          phase: "read",
          runId: snapshot.runId,
          frames: keikoStackFrames(error),
          causeChain: causeChain(error),
        },
      ),
    );
    throw error;
  }
}

function readRetained(
  db: DatabaseSync,
  snapshot: CodingRuntimeSnapshot,
): VerifiedCommitResult | undefined {
  const row = db
    .prepare(
      "SELECT last_successful_verified_commit FROM coding_runtime_snapshots WHERE run_id = ?",
    )
    .get(snapshot.runId) as { readonly last_successful_verified_commit: string | null } | undefined;
  if (row === undefined) return undefined;
  const encoded = row.last_successful_verified_commit;
  if (encoded === null) return legacySuccess(snapshot);
  if (encoded.length > 8192) throw new TypeError("oversized persisted verified commit authority");
  const parsed: unknown = JSON.parse(encoded);
  if (!isVerifiedCommitResult(parsed) || parsed.status !== "succeeded")
    throw new TypeError("invalid persisted verified commit authority");
  assertVerifiedCommitRuntimeBinding(snapshot, parsed);
  return parsed;
}

function legacySuccess(snapshot: CodingRuntimeSnapshot): VerifiedCommitResult | undefined {
  const receipt = snapshot.verifiedCommitResult;
  if (!isVerifiedCommitResult(receipt) || receipt.status !== "succeeded") return undefined;
  assertVerifiedCommitRuntimeBinding(snapshot, receipt);
  return receipt;
}
