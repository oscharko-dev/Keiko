// Model-gateway activity-log PORT.
//
// ADR-0019 dependency direction: this package may depend on `keiko-contracts` and
// `keiko-security` only, so it must never import the BFF's logger — an edge from a domain
// package to `keiko-server` is exactly the inversion `arch:check` exists to reject. It declares
// the narrow sink shape it needs instead. The server's `ServerLogSink` satisfies that shape
// STRUCTURALLY (`ModelGatewayLogEvent` is a category/level-narrowed subset of `ServerLogEvent`),
// so the BFF wires the real sink through the existing options/deps objects and nothing here ever
// reaches upward.
//
// Every call site resolves the sink ONCE to `nullModelGatewayLogSink` when unwired and then calls
// `write` unconditionally. That is deliberate: an inline `log?.write(...)` at each site would add
// a branch to functions that are already at the cyclomatic-complexity ceiling, and the null sink
// costs one already-allocated no-op call.
//
// REDACTION IS THE CALLER'S CONTRACT, and this module keeps the two helpers that make it cheap to
// honour: `logEndpointHost` reduces a URL to `scheme://host:port` (no credentials, no path, no
// query — an `api-version` or a deployment id in a path is configuration an operator may see, but
// a query string is where callers historically leak tokens), and `logErrorKind` reads an error's
// `code`/`name` and NEVER its `message`, which is where provider bodies end up. No field written
// from this package may carry prompt text, document text, embedding inputs, vectors, response
// bodies, API keys, or headers — counts, sizes, statuses, durations, and closed-union decision
// labels only.

import { classifyErrorKind } from "@oscharko-dev/keiko-contracts/runtime/observability";

export type ModelGatewayLogLevel = "debug" | "info" | "warn" | "error";

// A narrowing of the server's category union. Kept to the three surfaces this package owns so a
// gateway line cannot claim a category an operator's grep would attribute to another subsystem.
export type ModelGatewayLogCategory = "gateway" | "embedding" | "http";

export interface ModelGatewayLogEvent {
  readonly level?: ModelGatewayLogLevel | undefined;
  readonly category: ModelGatewayLogCategory;
  readonly op: string;
  readonly correlationId?: string | undefined;
  readonly durationMs?: number | undefined;
  readonly status?: number | undefined;
  readonly errorKind?: string | undefined;
  readonly extra?: Readonly<Record<string, unknown>> | undefined;
}

export interface ModelGatewayLogSink {
  readonly write: (event: ModelGatewayLogEvent) => void;
  // Cheap level predicate — the ONLY way a below-threshold event can cost nothing here.
  //
  // The sink that ultimately receives these events applies a threshold (`KEIKO_LOG_LEVEL`,
  // default `info`) inside its own `write`, which is far too late: by then the call site has
  // already parsed a URL with `logEndpointHost`, allocated the `extra` record and allocated the
  // event, once per outbound call, only for the sink to drop the result. That is a permanent tax
  // on the hot path in exchange for lines nobody configured to see. With this predicate a
  // `debug` site asks first (`logLevelEnabled`) and materialises nothing when the answer is no.
  //
  // OPTIONAL on purpose: it is a narrowing hint, never a second source of truth. A sink that does
  // not expose one is treated as accepting every level, so an existing structural implementation
  // — including the server's `ServerLogSink` — stays assignable and behaves exactly as before,
  // and a sink that answers `true` here still has its own `write` threshold applied afterwards.
  // The predicate may therefore only ever SUPPRESS work, never authorise a line the sink itself
  // would refuse.
  readonly enabled?: ((level: ModelGatewayLogLevel) => boolean) | undefined;
}

// True when the sink might accept an event at this level. A sink without a predicate accepts
// everything (fail OPEN, deliberately: a missing hint must never silence instrumentation — the
// whole point of the log is that it is on by default).
export function logLevelEnabled(sink: ModelGatewayLogSink, level: ModelGatewayLogLevel): boolean {
  return sink.enabled?.(level) ?? true;
}

// Frozen so a caller cannot swap the no-op for something that records, and shared so an unwired
// call site allocates nothing beyond the event it is about to discard. Its predicate refuses every
// level, so a gated site wired to no sink at all does not even build the event it would discard.
export const nullModelGatewayLogSink: ModelGatewayLogSink = Object.freeze({
  write(_event: ModelGatewayLogEvent): void {
    // Explicit no-op: the default for every unwired call site.
  },
  enabled(_level: ModelGatewayLogLevel): boolean {
    return false;
  },
});

// ONE choke point, not 36 call sites. Every consumer in this package obtains its sink here, so
// isolating the write once covers `gateway.ts`, `http.ts`, `resilience.ts` and the embedding
// adapter without any of them remembering to guard. A caller-supplied sink is foreign code on the
// hot path of every outbound call: if it throws, the failure it reports would REPLACE the provider
// error the operation was about to surface, which is the exact inversion this whole change exists
// to prevent. `keiko-local-knowledge` solved the same class in `emitKnowledgeLogEvent`; this is its
// counterpart, deliberately behaving the same way.
export function resolveLogSink(sink: ModelGatewayLogSink | undefined): ModelGatewayLogSink {
  return sink === undefined ? nullModelGatewayLogSink : isolateLogSink(sink);
}

// ONCE PER SINK, not once per line: a dead sink during an indexing run writes many lines per
// document and would turn a degraded log into a flooded stderr. A `WeakSet` keyed on the sink
// instance keeps that per-sink rather than per-process, so a replaced sink is reported again, a
// test double never inherits another test's state, and nothing is retained.
const REPORTED_FAILED_SINKS = new WeakSet<ModelGatewayLogSink>();

function isolateLogSink(sink: ModelGatewayLogSink): ModelGatewayLogSink {
  return {
    write(event: ModelGatewayLogEvent): void {
      try {
        sink.write(event);
      } catch (cause) {
        reportFailedLogSink(sink, event.op, cause);
      }
    },
    enabled(level: ModelGatewayLogLevel): boolean {
      // The predicate is foreign code too, and a throwing one must not decide the request either.
      // Failing OPEN here is deliberate: a sink that cannot answer still gets offered the event,
      // and the isolated `write` above absorbs whatever happens next.
      try {
        return logLevelEnabled(sink, level);
      } catch {
        return true;
      }
    },
  };
}

function reportFailedLogSink(sink: ModelGatewayLogSink, droppedOp: string, cause: unknown): void {
  if (REPORTED_FAILED_SINKS.has(sink)) return;
  REPORTED_FAILED_SINKS.add(sink);
  const errorKind = logErrorKind(cause);
  try {
    sink.write({
      level: "error",
      category: "gateway",
      op: "gateway.log.sink-failed",
      errorKind,
      extra: { droppedOp },
    });
    return;
  } catch {
    // The transport refuses this shape too, so it is the transport that is down.
  }
  try {
    process.emitWarning("Keiko activity log sink is failing; log lines are being dropped.", {
      type: "KeikoActivityLog",
      code: "KEIKO_LOG_SINK_FAILED",
      detail: `op=${droppedOp} errorKind=${errorKind}`,
    });
  } catch {
    // The process warning channel is the last one there is.
  }
}

// The caller's correlation id, carried INTO this package on a request.
//
// Every line this package writes describes one outbound call, and during an indexing run there
// are many in flight at once against the same endpoint and the same model. Without an id per
// call, `embedding.batch.dispatch` x N followed by one `…fetch.completed` tells an operator that
// something is stuck but not WHICH request is stuck — the exact question the field incident
// ("0 of 1 documents, 0 of 36 vectors", six minutes, no error) turns on. The id is produced by
// the caller that owns the enclosing run, so a gateway line and the knowledge-indexing line that
// caused it join on one grep of one file.
//
// An object rather than a bare string because it is a CONTEXT: a future field (a job id, a step
// label) is additive here and would otherwise be a second parameter at every call site.
export interface ModelGatewayLogContext {
  readonly correlationId?: string | undefined;
}

// Binds a correlation id to a sink so every event written through it carries the id, instead of
// each of the ~30 `write` sites in this package having to remember a field it cannot obtain
// locally (most of them are helpers several frames below the request object). One wrapper per
// request path — never per event — so the cost is one allocation on a code path that is about to
// open a socket.
//
// Two deliberate properties:
//   * An id already on the event WINS. `gateway.ts` stamps its own per-call request id on events
//     it builds itself, and a wrapper that overwrote it would silently retag another subsystem's
//     line.
//   * No id means no wrapper: the sink is returned unchanged, so an unwired or uncorrelated
//     caller keeps its exact previous behaviour down to the object identity.
//
// `enabled` is delegated through `logLevelEnabled` rather than copied, so a sink implementing the
// predicate as a method keeps its `this`, and a sink without one still fails open.
export function withCorrelationId(
  sink: ModelGatewayLogSink,
  correlationId: string | undefined,
): ModelGatewayLogSink {
  if (correlationId === undefined) {
    return sink;
  }
  return {
    write(event: ModelGatewayLogEvent): void {
      sink.write(event.correlationId === undefined ? { ...event, correlationId } : event);
    },
    enabled(level: ModelGatewayLogLevel): boolean {
      return logLevelEnabled(sink, level);
    },
  };
}

// Monotonic elapsed milliseconds. `performance.now` rather than `Date.now` so a wall-clock step
// (NTP, suspend/resume) cannot produce a negative or absurd duration in the one field an operator
// uses to find a wedge. Three decimals keeps sub-millisecond decisions visible without printing
// float noise.
export function logTimer(): () => number {
  const started = performance.now();
  return (): number => Math.round((performance.now() - started) * 1000) / 1000;
}

// `code` and `name` are PROVIDER-CONTROLLED strings — a gateway, an SDK or a hostile response body
// decides them, not this repository — and `errorKind` is an envelope field, so it bypasses the
// `extra` redaction entirely and is only length/prose-checked at the far end. A non-conforming
// `code` is not hypothetical: SDKs routinely set it to a sentence ("The request body was rejected:
// …"), which is a provider message reaching the log through the one field guaranteed to be
// exempt from field-name policy. `classifyErrorKind` (ADR-0173 D11) is the identical shape gate
// `keiko-server` and `keiko-local-knowledge` apply, imported from `keiko-contracts` rather than
// restated here so the three surfaces cannot drift into accepting different things: an
// identifier, a code, a taxonomy label — never a sentence.
//
// Reading `code`/`name` also runs foreign code: an accessor, or a Proxy `get` trap, both of which
// can throw. Every caller classifies a cause while it is already handling a failure — a retry
// ladder mid-`catch`, a resilience event mid-construction — so a throw here would escape ahead of
// any sink guard and replace the real failure with an unrelated "hostile accessor" crash. An
// unreadable property is an unclassifiable one and must degrade to the next candidate.
function errorKindProperty(error: object, key: string): string | undefined {
  let value: unknown;
  try {
    value = (error as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
  return classifyErrorKind(value);
}

// The error's KIND, never its text. A provider's `message` routinely carries the rejected body,
// the endpoint, or an echoed prompt fragment, so it is not read here at all — the taxonomy code
// (`PROXY_BLOCKED_BY_POLICY`, `RATE_LIMIT`, …) is what an operator greps for anyway.
export function logErrorKind(error: unknown): string {
  if (typeof error !== "object" || error === null) {
    return "unknown";
  }
  return errorKindProperty(error, "code") ?? errorKindProperty(error, "name") ?? "unknown";
}

// `scheme://host:port` and nothing else. Credentials, path, query, and fragment are dropped rather
// than redacted so a future URL shape cannot leak through a pattern this function failed to
// anticipate. An unparseable input yields undefined instead of echoing the raw string back.
export function logEndpointHost(url: string | URL | undefined): string | undefined {
  if (url === undefined) {
    return undefined;
  }
  try {
    const parsed = typeof url === "string" ? new URL(url) : url;
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return undefined;
  }
}
