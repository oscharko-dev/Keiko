// Content-free activity-log seam for the security package (epic #2902, w4a-security-log-port).
//
// WHY THIS FILE EXISTS INSTEAD OF AN IMPORT
//
// `packages/keiko-local-knowledge/src/knowledge-log.ts` already declares a structurally identical
// seam. This file is NOT an import of it: ADR-0019 forbids a domain package from depending on a
// SIBLING domain package, and `keiko-security` sits at the leaf, depended upon by every store
// surface — pulling in `keiko-local-knowledge` merely because the event shape matches would invert
// that arrow and hand this package's callers a dependency on an unrelated subsystem's failure
// modes. `keiko-security` therefore declares its own structural port, narrowed to the categories
// this package can legitimately emit, and accepts an optional sink through the same options-object
// pattern every call site already threads test seams through. The server wires its own sink in at
// the composition root; every call site degrades to a no-op when nothing is wired.
//
// The event shape is deliberately a STRUCTURAL SUBSET of the server's `ServerLogEvent` (same
// fields, same optionality) so a `ServerLogSink` is assignable to `SecurityLogSink` with no
// adapter and no shared import — exactly the property `knowledge-log.ts` documents for its own
// port.
//
// REDACTION IS STRUCTURAL, NOT A CALLER PROMISE
//
// A field here carries counts, durations, and shape-gated error kinds (ADR-0128 D6: identifiers,
// counts, and hashes only). A keychain service/account name, a vault reference, a shard file path,
// and secret material never reach a field on this event.

import { classifyErrorKind } from "@oscharko-dev/keiko-contracts";

export type SecurityLogLevel = "debug" | "info" | "warn" | "error";

export type SecurityLogCategory = "security" | "diagnostic";

export interface SecurityLogEvent {
  // Omitted means `info`, matching the server sink's own default.
  readonly level?: SecurityLogLevel | undefined;
  readonly category: SecurityLogCategory;
  readonly op: string;
  readonly correlationId?: string | undefined;
  readonly durationMs?: number | undefined;
  readonly status?: number | undefined;
  readonly errorKind?: string | undefined;
  readonly extra?: Readonly<Record<string, unknown>> | undefined;
}

export interface SecurityLogSink {
  readonly write: (event: SecurityLogEvent) => void;
}

const NULL_SINK: SecurityLogSink = {
  write(_event: SecurityLogEvent): void {
    // Explicit no-op: the default whenever no caller wired a sink.
  },
};

export function nullSecurityLogSink(): SecurityLogSink {
  return NULL_SINK;
}

// Monotonic elapsed milliseconds, rounded to 3 decimals so a line stays stable in width.
// `performance.now()` rather than `Date.now()` so a clock step cannot produce a negative duration
// while a bounded keychain spawn is in flight.
export function startSecurityLogTimer(): () => number {
  const startedAt = performance.now();
  return (): number => Math.round((performance.now() - startedAt) * 1000) / 1000;
}

// The shape an error KIND may have is `classifyErrorKind` (ADR-0173 D11), imported from
// `keiko-contracts` rather than declared here, so this reducer and the ones in
// `knowledge-log.ts`, `keiko-server/src/observability/server-log.ts` and
// `keiko-model-gateway/src/observability.ts` cannot drift into accepting different things: an
// identifier, a taxonomy code, a constructor name — never a sentence.
//
// READING the property is itself a call into foreign code — `code`/`name` are ordinary properties
// on an object this layer did not build, so an accessor or Proxy trap can throw. Every call site
// classifies a cause while already handling a failure (a keychain spawn that just failed, a shard
// read that just threw), so a throw here would replace a diagnosable failure with a classification
// failure. An unreadable property degrades to the next candidate, exactly like a property whose
// value fails the shape gate.
function errorKindProperty(error: object, key: string): string | undefined {
  let value: unknown;
  try {
    value = (error as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
  return classifyErrorKind(value);
}

// Classification only: the coded `code`, else the constructor `name`, else "unknown". The message
// is NEVER read — a thrown error's message routinely carries a path or a fragment of the value
// that failed — and neither `code` nor `name` is trusted just because it is called one: both must
// pass `classifyErrorKind`'s shape gate first.
export function securityErrorKind(error: unknown): string {
  if (typeof error !== "object" || error === null) return "unknown";
  return errorKindProperty(error, "code") ?? errorKindProperty(error, "name") ?? "unknown";
}

// ─── Writing a line must never become the failure it describes ────────────────
//
// Same two rules as `knowledge-log.ts`, restated here because this package's callers sit on the
// same kind of failure path: `readMacosKeychainSecret` is on the boot-path key-resolution tier, and
// `readShardEnvelope` runs inside a per-entry read a caller is treating as "absent" on failure.
// Neither may have a logging failure replace the outcome it is reporting, and neither may go
// permanently silent without any signal reaching the operator.
//
//   1. A sink failure must never surface to the operation being logged.
//   2. A permanently broken sink must never be invisible.
//
// Both are satisfied by degrading in place — first a minimal envelope-only notice back through the
// same sink, then, only if that also throws, a single body-free `process.emitWarning` — reported
// once per sink instance via a `WeakSet` so a large batch of shard reads cannot flood stderr and a
// replaced sink is reported again.
const REPORTED_FAILED_SINKS = new WeakSet<SecurityLogSink>();

export function emitSecurityLogEvent(
  sink: SecurityLogSink | undefined,
  event: SecurityLogEvent,
): void {
  if (sink === undefined) return;
  try {
    sink.write(event);
  } catch (cause) {
    reportFailedSecurityLogSink(sink, event.op, cause);
  }
}

function reportFailedSecurityLogSink(
  sink: SecurityLogSink,
  droppedOp: string,
  cause: unknown,
): void {
  if (REPORTED_FAILED_SINKS.has(sink)) return;
  REPORTED_FAILED_SINKS.add(sink);
  const errorKind = securityErrorKind(cause);
  try {
    sink.write({
      level: "error",
      category: "diagnostic",
      op: "security.log.sink-failed",
      errorKind,
      extra: { droppedOp },
    });
    return;
  } catch {
    // The transport refuses this shape too, so it is the transport that is down — fall through to
    // the only channel left.
  }
  warnFailedSecurityLogSink(droppedOp, errorKind);
}

function warnFailedSecurityLogSink(droppedOp: string, errorKind: string): void {
  try {
    process.emitWarning("Keiko security log sink is failing; log lines are being dropped.", {
      type: "KeikoActivityLog",
      code: "KEIKO_LOG_SINK_FAILED",
      detail: `op=${droppedOp} errorKind=${errorKind}`,
    });
  } catch {
    // The process warning channel is the last one there is; a report beyond it does not exist.
  }
}
