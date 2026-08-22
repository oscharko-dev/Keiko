// Content-free activity-log seam for the memory-consolidation package.
//
// WHY THIS FILE EXISTS INSTEAD OF AN IMPORT
//
// The server owns the process-wide logger and the file sink that writes `server.log`. This
// package sits BELOW `keiko-server` in the ADR-0019 dependency direction, so importing that
// logger would invert the arrow that `arch:check` enforces. The package therefore declares the
// structural shape it needs and accepts an optional sink through `ConsolidationOptions`; the
// server wires its own sink in at its own composition root, and every call site degrades to a
// no-op when nothing is wired.
//
// The event shape is deliberately a STRUCTURAL SUBSET of the server's `ServerLogEvent` — the
// same shape `packages/keiko-local-knowledge/src/knowledge-log.ts`'s `KnowledgeLogEvent` already
// uses — so a `ServerLogSink` is assignable to `ConsolidationLogSink` with no adapter and no
// shared import (AGENTS.md: "a domain package gets its own structural log-port copy, never a
// sibling import"). The category union is narrowed to the labels this package can legitimately
// emit.
//
// REDACTION IS STRUCTURAL, NOT A CALLER PROMISE
//
// A field here carries counts, closed-union reason labels, error kinds, and this package's own
// opaque identifiers. Memory bodies, summaries, reviewer notes, and any other record content
// never reach a field on this event.

import { classifyErrorKind } from "@oscharko-dev/keiko-contracts";

export type ConsolidationLogLevel = "debug" | "info" | "warn" | "error";

export type ConsolidationLogCategory = "consolidation" | "diagnostic";

export interface ConsolidationLogEvent {
  // Omitted means `info`, matching the server sink's own default.
  readonly level?: ConsolidationLogLevel | undefined;
  readonly category: ConsolidationLogCategory;
  readonly op: string;
  readonly correlationId?: string | undefined;
  readonly durationMs?: number | undefined;
  readonly status?: number | undefined;
  readonly errorKind?: string | undefined;
  readonly extra?: Readonly<Record<string, unknown>> | undefined;
}

export interface ConsolidationLogSink {
  readonly write: (event: ConsolidationLogEvent) => void;
}

const NULL_SINK: ConsolidationLogSink = {
  write(_event: ConsolidationLogEvent): void {
    // Explicit no-op: the default whenever no caller wired a sink.
  },
};

export function nullConsolidationLogSink(): ConsolidationLogSink {
  return NULL_SINK;
}

// The shape an error KIND may have is `classifyErrorKind` (ADR-0173 D11), imported from
// `keiko-contracts` rather than declared here, so this reducer and its siblings in
// `keiko-local-knowledge/src/knowledge-log.ts`, `keiko-server/src/observability/server-log.ts`
// and `keiko-model-gateway/src/observability.ts` cannot drift into accepting different things: an
// identifier, a taxonomy code, a constructor name — never a sentence.
//
// READING the property is itself a call into foreign code: an accessor, a Proxy `get` trap, or a
// `Object.defineProperty(error, "code", { get() { throw … } })` runs OUR stack frame while we are
// already mid-recovery from the failure being classified. An unreadable property degrades to the
// next candidate, exactly like a property whose value fails the shape gate.
function errorKindProperty(error: object, key: string): string | undefined {
  let value: unknown;
  try {
    value = (error as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
  return classifyErrorKind(value);
}

// Classification only: the coded `code`, else the constructor `name`, else "unknown". The
// message is NEVER read — a thrown error's message routinely carries a fragment of the content
// that failed to parse — and neither `code` nor `name` is trusted to be a code just because it is
// called one: both must pass `classifyErrorKind`'s shape gate first.
export function consolidationErrorKind(error: unknown): string {
  if (typeof error !== "object" || error === null) return "unknown";
  return errorKindProperty(error, "code") ?? errorKindProperty(error, "name") ?? "unknown";
}

// ─── Writing a line must never become the failure it describes ────────────────
//
// Mirrors `emitKnowledgeLogEvent`'s two-rule contract:
//   1. A sink failure must never surface to the consolidation run being logged — the sink is
//      foreign code supplied through options.
//   2. A permanently broken sink must never be invisible — it is reported once per sink instance,
//      never once per event, so a run with many fallbacks cannot flood stderr.
const REPORTED_FAILED_SINKS = new WeakSet<ConsolidationLogSink>();

export function emitConsolidationLogEvent(
  sink: ConsolidationLogSink | undefined,
  event: ConsolidationLogEvent,
): void {
  if (sink === undefined) return;
  try {
    sink.write(event);
  } catch (cause) {
    reportFailedConsolidationLogSink(sink, event.op, cause);
  }
}

function reportFailedConsolidationLogSink(
  sink: ConsolidationLogSink,
  droppedOp: string,
  cause: unknown,
): void {
  if (REPORTED_FAILED_SINKS.has(sink)) return;
  REPORTED_FAILED_SINKS.add(sink);
  const errorKind = consolidationErrorKind(cause);
  try {
    sink.write({
      level: "error",
      category: "diagnostic",
      op: "consolidation.log.sink-failed",
      errorKind,
      extra: { droppedOp },
    });
    return;
  } catch {
    // The transport refuses this shape too, so it is the transport that is down — fall through to
    // the only channel left.
  }
  warnFailedConsolidationLogSink(droppedOp, errorKind);
}

function warnFailedConsolidationLogSink(droppedOp: string, errorKind: string): void {
  try {
    process.emitWarning("Keiko activity log sink is failing; log lines are being dropped.", {
      type: "KeikoActivityLog",
      code: "KEIKO_LOG_SINK_FAILED",
      detail: `op=${droppedOp} errorKind=${errorKind}`,
    });
  } catch {
    // The process warning channel is the last one there is; a report beyond it does not exist.
  }
}
