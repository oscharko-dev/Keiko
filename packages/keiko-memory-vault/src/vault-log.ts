// Content-free activity-log seam for the memory-vault package (epic #3233, w4a-memory-vault-fingerprint).
//
// WHY THIS FILE EXISTS INSTEAD OF AN IMPORT
//
// Domain event and port contracts remain local rather than importing another domain's shape.
// The server composes the real sink. Only stateless safe delivery mechanics use the existing
// lower-level keiko-security dependency; no domain event schema or reporter moves there.
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
import { securityErrorKind, writeActivityLogPortEvent } from "@oscharko-dev/keiko-security";

import {
  activityLogEvent,
  activityLogEventWillBeRejected,
  normalizeKeikoFrame,
  defineActivityLogOperation,
  type RejectedActivityLogEvent,
  type ActivityLogEventEnvelope,
  type ActivityLogCompletenessState,
  type ActivityLogLossState,
} from "@oscharko-dev/keiko-contracts/runtime/observability";

import type { MemoryWriteContext } from "./types.js";

export type MemoryVaultLogLevel = "debug" | "info" | "warn" | "error";

export type MemoryVaultLogCategory = "memory" | "diagnostic";

// The closed set of ops this package ever emits.
export type MemoryVaultLogOp =
  | "sqlite.state-path.refused"
  | "memory-vault.store.opened"
  | "memory-vault.store.quarantined"
  | "memory-vault.store.encryption-migrated"
  | "memory-vault.store.encryption-checkpoint-degraded"
  | "memory-vault.log.sink-failed"
  | "memory-vault.write.rejected"
  | "memory-vault.write.capture-failed";

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
export type MemoryWriteMethod = "insert" | "update" | "update-batch" | "graph";

export interface MemoryVaultLogExtra {
  readonly method?: MemoryWriteMethod | undefined;
  readonly stage?: "caller-admission" | "physical-admission" | undefined;
  readonly reason?: "invalid-record" | "capture-unavailable" | undefined;
  readonly completeness?: ActivityLogCompletenessState | undefined;
  readonly loss?: ActivityLogLossState | undefined;
  readonly frames?: readonly string[] | undefined;
  readonly causeChain?: readonly string[] | undefined;
  readonly rejectionCount?: number | undefined;
  readonly admitted?: boolean | undefined;
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
  readonly parentCorrelationId?: string | undefined;
  readonly durationMs?: number | undefined;
  readonly status?: number | undefined;
  readonly errorKind?: string | undefined;
  readonly extra?: Readonly<MemoryVaultLogExtra> | undefined;
}

/** Normal producer vocabulary plus the exact rejected transport arm. */
export type MemoryVaultLogTransport = MemoryVaultLogEvent | RejectedActivityLogEvent;

export interface MemoryVaultErrorEvidence {
  readonly frames: readonly string[];
  readonly causeChain: readonly string[];
}

export interface MemoryVaultLogSink {
  readonly write: (event: MemoryVaultLogTransport) => void;
  readonly errorEvidence?: ((error: unknown) => MemoryVaultErrorEvidence) | undefined;
}

export interface MemoryPhysicalWriteAdmission {
  readonly sink: MemoryVaultLogSink | undefined;
  readonly method: MemoryWriteMethod;
  readonly context: MemoryWriteContext | undefined;
}

const NULL_SINK: MemoryVaultLogSink = {
  write(_event: MemoryVaultLogTransport): void {
    // Explicit no-op: the default whenever no caller wired a sink.
  },
};

export function nullMemoryVaultLogSink(): MemoryVaultLogSink {
  return NULL_SINK;
}

// Monotonic elapsed milliseconds, rounded to 3 decimals so a line stays stable in width.
// `performance.now()` rather than `Date.now()` so a clock step cannot produce a negative
// duration across a vault-open or an encryption sweep.
export function startMemoryVaultLogTimer(): () => number {
  const startedAt = performance.now();
  return (): number => Math.round((performance.now() - startedAt) * 1000) / 1000;
}

// Security's `securityErrorKind` (ADR-0173 D11) owns the guarded `code`/`name` reads and
// canonical Contracts shape gate shared by Knowledge, Consolidation, Vault and Gateway:
// an identifier, a taxonomy code, a constructor name — never a sentence.
//
// READING the property is itself a call into foreign code — `code`/`name` are ordinary properties
// on an object this layer did not build, so an accessor or Proxy trap can throw. Every call site
// classifies a cause while already handling a failure (a corrupt DB open, a migration sweep that
// just threw), so a throw here would replace a diagnosable failure with a classification failure.
// An unreadable property degrades to the next candidate, exactly like a property whose value fails
// the shape gate.

// Classification only: the coded `code`, else the constructor `name`, else "unknown". The message
// is NEVER read — a thrown error's message routinely carries a path or a fragment of the value
// that failed — and neither `code` nor `name` is trusted just because it is called one: both must
// pass `classifyErrorKind`'s shape gate first.
export function memoryVaultErrorKind(error: unknown): string {
  return securityErrorKind(error);
}

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

function operationDigest(op: MemoryVaultLogTransport["op"]): string {
  return createHash("sha256").update(op).digest("hex").slice(0, 16);
}

export function emitMemoryVaultLogEvent(
  sink: MemoryVaultLogSink | undefined,
  event: MemoryVaultLogTransport,
): void {
  writeActivityLogPortEvent(sink, event, (failedSink, failedEvent, cause): void => {
    reportFailedMemoryVaultLogSink(failedSink, failedEvent.op, cause);
  });
}

function reportFailedMemoryVaultLogSink(
  sink: MemoryVaultLogSink,
  droppedOp: MemoryVaultLogTransport["op"],
  cause: unknown,
): void {
  if (REPORTED_FAILED_SINKS.has(sink)) return;
  REPORTED_FAILED_SINKS.add(sink);
  const errorKind = memoryVaultErrorKind(cause);
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

const MEMORY_WRITE_REJECTED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "memory-vault.write.rejected",
  category: "memory",
  owner: "keiko-memory-vault",
  emitter: "vault-log.emitMemoryWriteRejected",
  fields: {
    method: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["insert", "update", "update-batch", "graph"],
    },
    stage: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["caller-admission", "physical-admission"],
    },
    reason: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["invalid-record"],
    },
    rejectionCount: { type: "integer", dataClass: "count", required: true },
    admitted: { type: "boolean", dataClass: "closed-enum", required: true },
  },
  causal: "correlation",
  lifecycle: "failure",
  analyzerProjection: "timeline",
  diagnosticWhen: [{ field: "admitted", values: [false] }],
  failureClasses: ["memory-write-validation"],
  proofIds: ["memory-vault.write.rejected.initial-admission"],
  releaseImpact: "patch",
});

function writeRefusalEnvelope(context: MemoryWriteContext | undefined): ActivityLogEventEnvelope {
  return {
    level: "warn",
    errorKind: "validation-failed",
    get correlationId(): string | undefined {
      return context?.correlationId;
    },
    get parentCorrelationId(): string | undefined {
      return context?.parentCorrelationId;
    },
  };
}

export function emitMemoryWriteRejected(
  sink: MemoryVaultLogSink | undefined,
  method: MemoryWriteMethod,
  context: MemoryWriteContext | undefined,
  stage: "caller-admission" | "physical-admission" = "caller-admission",
): void {
  emitMemoryVaultLogEvent(
    sink,
    activityLogEvent(MEMORY_WRITE_REJECTED_OPERATION, writeRefusalEnvelope(context), {
      method,
      stage,
      reason: "invalid-record",
      rejectionCount: 1,
      admitted: false,
    }),
  );
}

const MEMORY_WRITE_CAPTURE_FAILED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "memory-vault.write.capture-failed",
  category: "memory",
  owner: "keiko-memory-vault",
  emitter: "vault-log.emitMemoryWriteCaptureFailureEvent",
  fields: {
    method: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["insert", "update", "update-batch", "graph"],
    },
    stage: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["physical-admission"],
    },
    reason: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["capture-unavailable"],
    },
    rejectionCount: { type: "integer", dataClass: "count", required: true },
    admitted: { type: "boolean", dataClass: "closed-enum", required: true },
    frames: {
      type: "string-array",
      dataClass: "safe-platform-class",
      required: false,
      maxLength: 512,
      maxItems: 8,
    },
    causeChain: {
      type: "string-array",
      dataClass: "error-kind",
      required: false,
      maxLength: 128,
      maxItems: 5,
    },
  },
  causal: "correlation",
  lifecycle: "failure",
  analyzerProjection: "timeline",
  diagnosticWhen: [{ field: "admitted", values: [false] }],
  failureClasses: ["memory-write-capture"],
  proofIds: ["memory-vault.write.capture-failed.physical-admission"],
  releaseImpact: "patch",
});

function capturedEvidenceArray(
  values: readonly string[],
  maximum: number,
): readonly string[] | undefined {
  if (!Array.isArray(values)) return undefined;
  const length: unknown = values.length;
  if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0 || length > maximum)
    return undefined;
  const captured: string[] = [];
  for (let index = 0; index < length; index += 1) {
    const value: unknown = values[index];
    if (typeof value !== "string") return undefined;
    captured.push(value);
  }
  return Object.freeze(captured);
}

function memoryCaptureEvidence(
  sink: MemoryVaultLogSink | undefined,
  error: unknown,
): MemoryVaultErrorEvidence | undefined {
  const provider = sink?.errorEvidence;
  if (provider === undefined) return undefined;
  const evidence = provider.call(sink, error);
  const fields = MEMORY_WRITE_CAPTURE_FAILED_OPERATION.fields;
  const frames = capturedEvidenceArray(evidence.frames, fields.frames.maxItems);
  const causes = capturedEvidenceArray(evidence.causeChain, fields.causeChain.maxItems);
  if (frames === undefined || causes === undefined || frames.length === 0) return undefined;
  if (frames.some((frame) => normalizeKeikoFrame(frame) === undefined)) return undefined;
  return { frames, causeChain: causes };
}

export function emitMemoryWriteCaptureFailed(
  sink: MemoryVaultLogSink | undefined,
  method: MemoryWriteMethod,
  context: MemoryWriteContext | undefined,
  error: unknown,
): void {
  let evidence: MemoryVaultErrorEvidence | undefined;
  try {
    evidence = memoryCaptureEvidence(sink, error);
  } catch {
    emitMemoryWriteCaptureFailureEvent(sink, method, context, undefined);
    return;
  }
  emitMemoryWriteCaptureFailureEvent(sink, method, context, evidence);
}

function emitMemoryWriteCaptureFailureEvent(
  sink: MemoryVaultLogSink | undefined,
  method: MemoryWriteMethod,
  context: MemoryWriteContext | undefined,
  evidence: MemoryVaultErrorEvidence | undefined,
): void {
  const envelope: ActivityLogEventEnvelope = {
    level: "error",
    errorKind: "internal",
    get correlationId(): string | undefined {
      return context?.correlationId;
    },
    get parentCorrelationId(): string | undefined {
      return context?.parentCorrelationId;
    },
  };
  const fields = {
    method,
    stage: "physical-admission",
    reason: "capture-unavailable",
    rejectionCount: 1,
    admitted: false,
    loss: "none",
  } as const;
  const event = activityLogEvent(MEMORY_WRITE_CAPTURE_FAILED_OPERATION, envelope, {
    ...fields,
    completeness: evidence === undefined ? "partial" : "complete",
    ...(evidence === undefined ? {} : { frames: evidence.frames, causeChain: evidence.causeChain }),
  });
  emitMemoryVaultLogEvent(
    sink,
    activityLogEventWillBeRejected(event)
      ? activityLogEvent(MEMORY_WRITE_CAPTURE_FAILED_OPERATION, envelope, {
          ...fields,
          completeness: "partial",
        })
      : event,
  );
}
