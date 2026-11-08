import {
  isSqliteCorruptionError,
  sqliteErrorLike,
} from "@oscharko-dev/keiko-security/sqlite-corruption";
import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { MemoryStorageError } from "./errors.js";
import { emitMemoryVaultLogEvent, type MemoryVaultLogSink } from "./vault-log.js";

const OPEN_FAILED = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "memory-vault.store.open-failed",
  category: "diagnostic",
  owner: "keiko-memory-vault",
  emitter: "migration-failure.classifyMemoryVaultOpenFailure",
  fields: {
    phase: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["open", "migration", "newer-schema"],
    },
    reason: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["vault-migration-failed"],
    },
  },
  causal: "none",
  lifecycle: "failure",
  analyzerProjection: "failure-cluster",
  failureClasses: ["memory-vault-open"],
  proofIds: ["memory-vault.store.open-failed.migration"],
  releaseImpact: "patch",
});

function openFailureMessage(error: unknown, phase: "open" | "migration" | "newer-schema"): string {
  if (phase === "newer-schema") return "Memory vault schema is newer than this binary supports.";
  const code = sqliteErrorLike(error).errcode;
  if (code === 5 || code === 6)
    return "The memory vault is busy or locked and could not be opened.";
  return "The memory vault could not be opened or migrated.";
}

/** Corruption keeps its existing quarantine owner; every other storage failure stays body-free. */
export function classifyMemoryVaultOpenFailure(
  error: unknown,
  phase: "open" | "migration" | "newer-schema",
  sink?: MemoryVaultLogSink,
): never {
  if (isSqliteCorruptionError(error)) throw error;
  if (
    error instanceof MemoryStorageError &&
    (error.code === "vault-unreadable" || error.code === "vault-migration-failed")
  )
    throw error;
  emitMemoryVaultLogEvent(
    sink,
    activityLogEvent(
      OPEN_FAILED,
      { level: "error", errorKind: "unavailable" },
      {
        phase,
        reason: "vault-migration-failed",
      },
    ),
  );
  throw new MemoryStorageError("vault-migration-failed", openFailureMessage(error, phase));
}
