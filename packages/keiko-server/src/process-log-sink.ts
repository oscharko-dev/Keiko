// The process-wide activity log, exposed as the SINK shape the domain packages accept.
//
// WHY AN ADAPTER RATHER THAN A DIRECT IMPORT
//
// ADR-0019 keeps `keiko-local-knowledge` and `keiko-model-gateway` below the BFF, so neither may
// import `getServerLogger`. Each declares the narrow structural port it needs instead
// (`KnowledgeLogSink`, `ModelGatewayLogSink`), whose event type is a subset of `ServerLogEvent`.
// The server is the composition root that supplies the real implementation, and this module is
// that supply: ONE adapter shared by every BFF composition site, so an indexing run, a knowledge
// store open, a Gateway instance and an embedding request all land in the same `server.log`
// instead of each growing its own half-wired variant.
//
// WHY THE LOGGER IS RESOLVED PER WRITE
//
// `getServerLogger()` memoises whatever it can build the first time it is called — a null sink
// while `KEIKO_STATE_DIR` is still unset, and the CLI replaces it with the real one via
// `setServerLogger` once the state directory is known. Capturing the logger in a module-level
// constant would freeze whichever instance happened to exist when this module was first imported
// and silently discard every line from the deep call sites this adapter exists to serve. The cost
// of resolving per write is one nullish check.
//
// WHY THE LEVEL PREDICATE IS PART OF THE SHAPE
//
// `ModelGatewayLogSink.enabled` is an optional narrowing hint: a `debug` site asks first and
// materialises no URL parse, no `extra` record and no event when the answer is no. A sink without
// it fails open, which is correct but pays that cost on every outbound call. Answering from the
// logger's own threshold makes a suppressed debug site free while keeping the logger's `write`
// threshold the single source of truth — the predicate can only ever suppress work, never
// authorise a line the logger itself would refuse.

import type {
  ConsolidationLogEvent,
  ConsolidationLogSink,
} from "@oscharko-dev/keiko-memory-consolidation";
import {
  DEFAULT_SERVER_LOG_LEVEL,
  getServerLogger,
  type ServerLogEvent,
  type ServerLogLevel,
  type ServerLogSink,
} from "./observability/index.js";

// `ServerLogSink` plus the optional level predicate the model-gateway port reads. Declared here
// rather than on `ServerLogSink` because the predicate is a consumer-side optimisation, not part
// of what it means to be a server log transport.
export interface ProcessServerLogSink extends ServerLogSink {
  readonly enabled: (level: ServerLogLevel) => boolean;
}

const PROCESS_SERVER_LOG_SINK: ProcessServerLogSink = {
  write(event: ServerLogEvent): void {
    // The logger applies the threshold, merges any bound context, and swallows a sink failure so
    // a log line can never become a new failure mode for the operation being logged.
    getServerLogger().log(event.level ?? DEFAULT_SERVER_LOG_LEVEL, event);
  },
  enabled(level: ServerLogLevel): boolean {
    return getServerLogger().isLevelEnabled(level);
  },
};

/**
 * The activity-log sink every BFF composition site hands to a domain package. Structurally
 * satisfies `KnowledgeLogSink` and `ModelGatewayLogSink` without either package importing the
 * server.
 */
export function processServerLogSink(): ProcessServerLogSink {
  return PROCESS_SERVER_LOG_SINK;
}

/**
 * The `keiko-memory-consolidation` package's log port, stamped with the caller's own
 * correlationId. `ConsolidationLogEvent` carries no jobId/run-id field of its own (see that
 * package's `log-port.ts`) and `ConsolidationOptions` deliberately stays a pure, caller-agnostic
 * options bag — so the composition root injects the correlation id here rather than widening the
 * package's public shape. A `logSummaryFallback` line that already carries its own
 * `correlationId` (none does today, but the port allows one) is left untouched; only an absent one
 * is stamped, so a future producer-set id is never silently overwritten.
 */
export function consolidationLogSinkFor(correlationId: string): ConsolidationLogSink {
  const sink = processServerLogSink();
  return {
    write(event: ConsolidationLogEvent): void {
      sink.write({ ...event, correlationId: event.correlationId ?? correlationId });
    },
  };
}
