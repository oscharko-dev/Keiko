// Content-free activity-log seam for the memory-vault package (epic #3233, w4a-memory-vault-fingerprint).
//
// WHY THIS FILE EXISTS INSTEAD OF AN IMPORT
//
// `packages/keiko-local-knowledge/src/knowledge-log.ts` and `packages/keiko-security/src/log-port.ts`
// already declare structurally identical seams. This file is NOT an import of either: ADR-0019
// forbids a domain package from depending on a SIBLING domain package, and `keiko-memory-vault`
// sits below `keiko-server` in the dependency direction, same as those two — pulling in a sibling
// package merely because the event shape matches would invert that arrow and hand this package's
// callers a dependency on an unrelated subsystem's failure modes. `keiko-memory-vault` therefore
// declares its own structural port, narrowed to the categories this package can legitimately emit.
// The server is the composition root that supplies the real implementation (`processServerLogSink`,
// `packages/keiko-server/src/process-log-sink.ts`); every call site degrades to a no-op when
// nothing is wired.
//
// The event shape is deliberately a STRUCTURAL SUBSET of the server's `ServerLogEvent` (same
// fields, same optionality), and `"memory"` is already a member of `ServerLogCategory` (added,
// per that file's own header, "for the vault/retrieval surface") — so a `ServerLogSink` is
// assignable to `MemoryVaultLogSink` with no adapter and no shared import, exactly the property
// `knowledge-log.ts` and `log-port.ts` document for their own ports.
//
// REDACTION IS STRUCTURAL, NOT A CALLER PROMISE
//
// A field here carries counts, durations, and shape-gated error kinds (ADR-0128 D6: identifiers,
// counts, and hashes only). A memory body, a tag, a scope coordinate, a vault key, and a
// filesystem path never reach a field on this event.
//
// `op` and `extra` are CLOSED, not `string` / `Record<string, unknown>` (Finding: Thread 8 —
// review flagged the previous open shape as a path by which a caller could send a memory body or
// filesystem path through this package boundary). Every literal below is one this package's own
// three producers (`db.ts`, `migrate-encrypt.ts`, `vault.ts`) already emit; a narrower union/
// interface is still assignable to `ServerLogEvent`'s `op: string` / `extra?: Record<string,
// unknown>`, so `processServerLogSink()` remains a valid `MemoryVaultLogSink` with no adapter.

import { createHash } from "node:crypto";

import {
  activityLogEvent,
  defineActivityLogOperation,
  recordActivityLogLoss,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { securityErrorKind } from "@oscharko-dev/keiko-security";

export type MemoryVaultLogLevel = "debug" | "info" | "warn" | "error";

export type MemoryVaultLogCategory = "memory" | "diagnostic";

// The closed set of ops this package ever emits.
export type MemoryVaultLogOp =
  | "sqlite.state-path.refused"
  | "memory-vault.store.opened"
  | "memory-vault.store.open-failed"
  | "memory-vault.store.quarantined"
  | "memory-vault.store.encryption-migrated"
  | "memory-vault.store.encryption-checkpoint-degraded"
  | "memory-vault.log.sink-failed";

// A closed mirror of cipher.ts's `VaultKeySource` ("env" | "keychain" | "keyfile"), duplicated
// rather than imported: cipher.ts imports from db.ts (for keyfile hardening) and db.ts imports
// from this file (to emit its own events), so an import here would complete a
// cipher.ts -> db.ts -> vault-log.ts -> cipher.ts cycle. The same accepted, documented-duplication
// tradeoff `ERROR_KIND_PATTERN` used across three packages before ADR-0173 consolidated it.
export type MemoryVaultLogKeySource = "env" | "keychain" | "keyfile";

// The closed, body-free `extra` schema: every field this package's producers have ever needed —
// the retained key-resolution tier, whether a quarantine reopen succeeded, the encryption sweep's
// scope transition and row count, the digest of an op a failed sink dropped, and the bounded-retry
// attempts + busy signal from a post-migration WAL checkpoint that could not fully truncate
// (#2906 KEIKO-0713 / KEIKO-0877). Never a memory body, a tag, a scope coordinate, a vault
// key, or a filesystem path.
export interface MemoryVaultLogExtra {
  readonly phase?: "open" | "migration" | "newer-schema" | undefined;
  readonly reason?: "vault-migration-failed" | undefined;
  readonly store?: "ui" | "memory-vault" | "local-knowledge" | undefined;
  readonly keySource?: MemoryVaultLogKeySource | undefined;
  readonly reopened?: boolean | undefined;
  readonly fromScope?: "plaintext" | undefined;
  readonly toScope?: "encrypted" | undefined;
  readonly rowsMigrated?: number | undefined;
  readonly droppedOpDigest?: string | undefined;
  readonly failureKind?: string | undefined;
  readonly attempts?: number | undefined;
  readonly busy?: boolean | undefined;
}

export interface MemoryVaultLogEvent {
  // Omitted means `info`, matching the server sink's own default.
  readonly level?: MemoryVaultLogLevel | undefined;
  readonly category: MemoryVaultLogCategory;
  readonly op: MemoryVaultLogOp;
  readonly correlationId?: string | undefined;
  readonly durationMs?: number | undefined;
  readonly status?: number | undefined;
  readonly errorKind?: string | undefined;
  readonly extra?: Readonly<MemoryVaultLogExtra> | undefined;
}

export interface MemoryVaultLogSink {
  readonly write: (event: MemoryVaultLogEvent) => void;
}

const NULL_SINK: MemoryVaultLogSink = {
  write(_event: MemoryVaultLogEvent): void {
    // Explicit no-op: the default whenever no caller wired a sink.
  },
};

export function nullMemoryVaultLogSink(): MemoryVaultLogSink {
  return NULL_SINK;
}

// The elapsed-time timer and the error-kind reducer are the security port's own: one definition of
// each, so the two ports cannot drift into measuring or classifying differently (ADR-0173 D11). A
// vault-open or an encryption sweep reads the same monotonic timer, and a thrown cause is reduced to
// an identifier, a taxonomy code or a constructor name — never a message.
export {
  securityErrorKind as memoryVaultErrorKind,
  startSecurityLogTimer as startMemoryVaultLogTimer,
} from "@oscharko-dev/keiko-security";

// ─── Writing a line must never become the failure it describes ────────────────
//
// Same two rules as `knowledge-log.ts`/`log-port.ts`, restated here because this package's callers
// sit on the same kind of failure path: a corrupt-DB quarantine and an encryption sweep both run
// while the caller is already mid-recovery or mid-migration. Neither may have a logging failure
// replace the outcome it is reporting, and neither may go permanently silent without any signal
// reaching the operator.
//
//   1. A sink failure must never surface to the operation being logged.
//   2. A permanently broken sink must never be invisible.
//
// Both are satisfied by degrading in place — first a minimal envelope-only notice back through the
// same sink, then, only if that also throws, a single body-free `process.emitWarning` — reported
// once per sink instance via a `WeakSet` so a batch of failures cannot flood stderr and a replaced
// sink is reported again.
const REPORTED_FAILED_SINKS = new WeakSet<MemoryVaultLogSink>();

const MEMORY_VAULT_LOG_SINK_FAILED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "memory-vault.log.sink-failed",
  category: "diagnostic",
  owner: "keiko-memory-vault",
  emitter: "vault-log.reportFailedMemoryVaultLogSink",
  fields: {
    droppedOpDigest: { type: "string", dataClass: "digest", required: true, maxLength: 16 },
    failureKind: { type: "string", dataClass: "error-kind", required: true, maxLength: 64 },
  },
  causal: "none",
  lifecycle: "loss",
  analyzerProjection: "capability",
  failureClasses: ["activity-log-sink"],
  proofIds: ["memory-vault.log.sink-failed.body-free"],
  releaseImpact: "patch",
});

function operationDigest(op: MemoryVaultLogOp): string {
  return createHash("sha256").update(op).digest("hex").slice(0, 16);
}

export function emitMemoryVaultLogEvent(
  sink: MemoryVaultLogSink | undefined,
  event: MemoryVaultLogEvent,
): void {
  if (sink === undefined) {
    // An unwired port loses the event it was handed; the loss is counted like any other (#3532).
    recordActivityLogLoss("port-unwired");
    return;
  }
  try {
    sink.write(event);
  } catch (cause) {
    // Every failure is a lost line and is counted in the process loss ledger; only the stderr
    // notice below is limited to once per sink.
    recordActivityLogLoss("port-sink-failed");
    reportFailedMemoryVaultLogSink(sink, event.op, cause);
  }
}

function reportFailedMemoryVaultLogSink(
  sink: MemoryVaultLogSink,
  droppedOp: MemoryVaultLogOp,
  cause: unknown,
): void {
  if (REPORTED_FAILED_SINKS.has(sink)) return;
  REPORTED_FAILED_SINKS.add(sink);
  const errorKind = securityErrorKind(cause);
  const droppedOpDigest = operationDigest(droppedOp);
  try {
    sink.write(
      activityLogEvent(
        MEMORY_VAULT_LOG_SINK_FAILED_OPERATION,
        { level: "error", errorKind: "unavailable" },
        { droppedOpDigest, failureKind: errorKind },
      ),
    );
    return;
  } catch {
    // The transport refuses this shape too, so it is the transport that is down — fall through to
    // the only channel left.
  }
  warnFailedMemoryVaultLogSink(droppedOpDigest, errorKind);
}

function warnFailedMemoryVaultLogSink(droppedOpDigest: string, errorKind: string): void {
  try {
    process.emitWarning("Keiko memory-vault log sink is failing; log lines are being dropped.", {
      type: "KeikoActivityLog",
      code: "KEIKO_LOG_SINK_FAILED",
      detail: `opDigest=${droppedOpDigest} errorKind=${errorKind}`,
    });
  } catch {
    // The process warning channel is the last one there is; a report beyond it does not exist.
  }
}
