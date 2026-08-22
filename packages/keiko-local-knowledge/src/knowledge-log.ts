// Content-free activity-log seam for the local-knowledge package.
//
// WHY THIS FILE EXISTS INSTEAD OF AN IMPORT
//
// The server owns the process-wide logger and the file sink that writes `server.log`. This
// package sits BELOW `keiko-server` in the ADR-0019 dependency direction, so importing that
// logger would invert the arrow that `arch:check` enforces. The package therefore declares the
// structural shape it needs and accepts an optional sink through an options object the caller
// already passes; the server wires its own sink in at the composition root, and every call site
// degrades to a no-op when nothing is wired.
//
// The event shape is deliberately a STRUCTURAL SUBSET of the server's `ServerLogEvent`, so a
// `ServerLogSink` is assignable to `KnowledgeLogSink` with no adapter and no shared import. The
// category union is narrowed to the labels this package can legitimately emit — a routing label
// this layer cannot produce would only be a typo waiting to happen.
//
// REDACTION IS STRUCTURAL, NOT A CALLER PROMISE
//
// A field here carries counts, byte sizes, durations, HTTP statuses, error kinds, and the
// store's own opaque identifiers (ADR-0128 D6: identifiers, counts, and hashes only). Chunk
// text, document text, extracted content, prompts, embeddings, api keys, endpoints, and
// absolute filesystem paths never reach a field on this event.

import { classifyErrorKind } from "@oscharko-dev/keiko-contracts";

export type KnowledgeLogLevel = "debug" | "info" | "warn" | "error";

export type KnowledgeLogCategory = "embedding" | "indexing" | "search" | "diagnostic";

export interface KnowledgeLogEvent {
  // Omitted means `info`, matching the server sink's own default.
  readonly level?: KnowledgeLogLevel | undefined;
  readonly category: KnowledgeLogCategory;
  readonly op: string;
  readonly correlationId?: string | undefined;
  readonly durationMs?: number | undefined;
  readonly status?: number | undefined;
  readonly errorKind?: string | undefined;
  readonly extra?: Readonly<Record<string, unknown>> | undefined;
}

export interface KnowledgeLogSink {
  readonly write: (event: KnowledgeLogEvent) => void;
}

const NULL_SINK: KnowledgeLogSink = {
  write(_event: KnowledgeLogEvent): void {
    // Explicit no-op: the default whenever no caller wired a sink.
  },
};

export function nullKnowledgeLogSink(): KnowledgeLogSink {
  return NULL_SINK;
}

// Monotonic elapsed milliseconds, rounded to 3 decimals so a line stays stable in width.
// `performance.now()` rather than `Date.now()` so a clock step cannot produce a negative
// duration in the middle of a long indexing run.
export function startKnowledgeLogTimer(): () => number {
  const startedAt = performance.now();
  return (): number => Math.round((performance.now() - startedAt) * 1000) / 1000;
}

// The shape an error KIND may have is `classifyErrorKind` (ADR-0173 D11), imported from
// `keiko-contracts` rather than declared here, so this reducer and the ones in
// `keiko-server/src/observability/server-log.ts` and `keiko-model-gateway/src/observability.ts`
// cannot drift into accepting different things: an identifier, a taxonomy code, a constructor
// name — never a sentence.
//
// Reading `code`/`name` instead of `message` is only HALF the guard, and this reducer used to ship
// with the other half missing. Neither property is reserved by the language: a provider client is
// free to construct `Object.assign(new Error(), { code: "input rejected: <the rejected text>" })`,
// and an aggregation layer routinely copies a remote `error.code` string straight out of a JSON
// body. Without a shape gate that sentence — including one echoing the very input that was
// rejected — was written verbatim into `errorKind`, which is an ENVELOPE field and therefore the
// one place a value is read before `extra` is redacted.

// READING the property is itself a call into foreign code. `code` and `name` are ordinary
// properties on an object this layer did not build: an accessor, a Proxy `get` trap, or a
// `Object.defineProperty(error, "code", { get() { throw … } })` runs OUR stack frame. Every call
// site classifies the cause while it is handling a failure — inside a catch that is mid-recovery,
// about to rethrow, or accounting a retry — and the event is built BEFORE the write is attempted,
// so a throw here escapes ahead of any sink guard and replaces a diagnosable store or indexing
// failure with an accessor failure. An unreadable property is simply an unclassifiable one: it
// degrades to the next candidate, exactly like a property whose value fails the shape gate.
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
// message is NEVER read — a thrown error's message routinely carries a path, an endpoint, or a
// fragment of the content that failed to parse — and neither `code` nor `name` is trusted to be a
// code just because it is called one: both must pass `classifyErrorKind`'s shape gate first. A
// `code` that fails the shape falls through to `name`, and a failing `name` falls through to
// "unknown", so a prose-carrying property degrades to a classification instead of leaking.
export function knowledgeErrorKind(error: unknown): string {
  if (typeof error !== "object" || error === null) return "unknown";
  return errorKindProperty(error, "code") ?? errorKindProperty(error, "name") ?? "unknown";
}

// ─── Writing a line must never become the failure it describes ────────────────
//
// Every write in this package goes through this one function, because two rules pull in opposite
// directions and BOTH hold.
//
//   1. A sink failure must never surface to the operation being logged. The sink is foreign code:
//      the server's file sink can hit a full disk, a pod wrapper can be half-wired, a test double
//      can throw outright. Several call sites sit inside a catch block that is mid-recovery
//      (`store.ts` quarantine) or about to rethrow the cause the caller must see (`store.ts`
//      encryption), and others sit inside a retry ladder whose accounting a throw would corrupt
//      (`embedding-batcher.ts`) or a per-document loop (`orchestrator.ts`). Evidence about a
//      failure must never replace the failure.
//   2. A permanently broken sink must never be invisible. Swallowing every write outright leaves
//      an operator with exactly the picture the six-minute silent indexing run gave them: nothing.
//
// Both are satisfied by degrading in place rather than throwing, and reporting the degradation
// once per sink instance:
//
//   * the same sink is first offered a minimal, envelope-only notice. The likelier failure is one
//     SHAPE the transport could not take, not a dead transport, and that notice then lands in
//     `server.log` beside the run it belongs to — which is where an operator is already looking.
//   * if even that throws, the transport itself is down, so the report goes out on the one channel
//     that is not the broken one: a single `process.emitWarning`. It is body-free — an op label
//     this package owns as a literal, and a shape-gated error kind — and it is the reason a dead
//     activity log announces itself instead of being inferred from silence.
//
// ONCE PER SINK, not once per line: a dead sink during a large indexing run would otherwise emit a
// warning per chunk and turn a degraded log into a flooded stderr. The report says the log is
// degraded; the log itself, once repaired, is where the detail lives. Keying a `WeakSet` on the
// sink instance keeps that per-sink rather than per-process, so a replaced sink is reported again,
// a test double never inherits another test's state, and nothing is retained.
const REPORTED_FAILED_SINKS = new WeakSet<KnowledgeLogSink>();

export function emitKnowledgeLogEvent(
  sink: KnowledgeLogSink | undefined,
  event: KnowledgeLogEvent,
): void {
  if (sink === undefined) return;
  try {
    sink.write(event);
  } catch (cause) {
    reportFailedKnowledgeLogSink(sink, event.op, cause);
  }
}

function reportFailedKnowledgeLogSink(
  sink: KnowledgeLogSink,
  droppedOp: string,
  cause: unknown,
): void {
  if (REPORTED_FAILED_SINKS.has(sink)) return;
  REPORTED_FAILED_SINKS.add(sink);
  const errorKind = knowledgeErrorKind(cause);
  try {
    sink.write({
      level: "error",
      category: "diagnostic",
      op: "knowledge.log.sink-failed",
      errorKind,
      extra: { droppedOp },
    });
    return;
  } catch {
    // The transport refuses this shape too, so it is the transport that is down — fall through to
    // the only channel left.
  }
  warnFailedKnowledgeLogSink(droppedOp, errorKind);
}

function warnFailedKnowledgeLogSink(droppedOp: string, errorKind: string): void {
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
