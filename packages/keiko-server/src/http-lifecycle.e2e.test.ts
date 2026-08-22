// Wave 5 ACCEPTANCE TEST (epic #3233, ADR-0173 SS9/SS11) — end-to-end proof, against the REAL
// `createUiServer` (a genuine bound loopback socket, real route dispatch, real SSE framing), that
// this wave's four deliverables actually work together:
//
//   (a) a client that disconnects mid-response yields an `op: "request"` line with `aborted: true`,
//       the matched route TEMPLATE (never a raw-path guess), the query-parameter NAMES, and a
//       `responseBytes` field;
//   (b) an SSE stream that emits exactly 3 frames yields one `sse.stream.closed` line whose
//       `frameCount` is 3 and whose `bytesStreamed` equals the bytes the server actually wrote;
//   (c) `POST /api/diagnostics/client` round-trips a body-supplied `correlationId` into a log line
//       carrying the message under `extra.clientNote` — never the denylisted `extra.message` — and
//       enforces its own size/shape bounds (413 oversized, 400 malformed);
//   (d) a diagnostic raised from a git route whose QUERY carries a customer-named value (a git
//       working-tree path) never leaks that value — the diagnostic's `operation` is the DECLARED
//       route template, `"GET /api/git/diff"`, not anything derived from the live request.
//
// Every other Wave 5 file (`server.test.ts`, `client-diagnostics-routes.test.ts`) already covers
// its own unit/near-integration surface with fake req/res doubles or a direct handler call. This
// file is deliberately different: one real `net.Server`, real sockets, a real client that actually
// aborts a real TCP connection — the shape none of those narrower suites can prove.
//
// If an assertion below cannot pass because the wiring it depends on is missing, it is left exactly
// as written (never loosened) so a real gap fails loudly instead of a green suite hiding it.

import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";

import { buildCspHeader } from "./csp.js";
import { resetClientDiagnosticsIngestStateForTests } from "./client-diagnostics-routes.js";
import type { ServerDiagnosticRecord, ServerDiagnosticSink } from "./diagnostics-log.js";
import {
  buildRedactor,
  createInMemoryUiStore,
  createRunRegistry,
  QueueEventSink,
  type StreamEvent,
  type UiHandlerDeps,
} from "./index.js";
import {
  createBufferedServerLogSink,
  createServerLogger,
  resetServerLogger,
  setServerLogger,
  type BufferedServerLogSink,
  type ServerLogEvent,
} from "./observability/index.js";
import { UI_HOST } from "./server.js";
import { readyMessage } from "./sse.js";
import { closeUiTestServer, startUiTestServer } from "./ui-test-server/_support.js";

// `staticRoot` only has to exist: every request in this file targets an `/api/...` route, so
// `serveStatic` is never reached and nothing is ever read from this directory.
const staticRoot = tmpdir();

function baseUrl(port: number): string {
  return `http://${UI_HOST}:${String(port)}`;
}

function silentDiagnostics(): ServerDiagnosticSink {
  return { record: () => undefined };
}

// The minimal, fully-wired `UiHandlerDeps` every scenario below shares — a fresh in-memory store
// and run registry per test so no test can observe another's state. `diagnostics` defaults to a
// silent sink (the shipped default writes to stderr on every record, which would just be noise
// here); scenario (d) overrides it with a capturing one.
function minimalHandlerDeps(diagnostics?: ServerDiagnosticSink): UiHandlerDeps {
  return {
    config: undefined,
    configPresent: false,
    evidenceStore: { put: () => "", list: () => [], get: () => undefined, delete: () => undefined },
    env: {},
    redactor: buildRedactor({}),
    diagnostics: diagnostics ?? silentDiagnostics(),
    registry: createRunRegistry(),
    modelPortFactory: () => undefined,
    store: createInMemoryUiStore(),
  };
}

interface TestServerHandle {
  readonly server: Server;
  readonly port: number;
  readonly sink: BufferedServerLogSink;
}

// Starts a real `createUiServer` on an ephemeral loopback port with a fresh buffered log sink wired
// as BOTH `activityLog` (what `logRequestOnClose`/`server.ts` write to directly) and the process-wide
// `ServerLogger` (what `sse-write.ts`'s `sse.stream.closed` and `client-diagnostics-routes.ts`'s
// `client.diagnostic` go through via `getServerLogger()`) — the SAME underlying array, so one sink
// observes every line this wave's mechanisms produce, regardless of which of the two paths wrote it.
async function startTestServer(handlerDeps: UiHandlerDeps): Promise<TestServerHandle> {
  const sink = createBufferedServerLogSink();
  setServerLogger(createServerLogger({ sink, level: "debug" }));
  const started = await startUiTestServer({
    staticRoot,
    csp: buildCspHeader([]),
    handlerDeps,
    activityLog: sink,
  });
  return { server: started.server, port: started.port, sink };
}

// Polls the buffered sink for the first RAW event matching `predicate`. Real-socket teardown and
// the `res.on("close", ...)` handlers that emit these lines are asynchronous, so the line is not
// necessarily present the instant the client-side call resolves.
async function waitForEvent(
  sink: BufferedServerLogSink,
  predicate: (event: ServerLogEvent) => boolean,
  timeoutMs = 2000,
): Promise<ServerLogEvent> {
  const deadline = Date.now() + timeoutMs;
  let found = sink.events.find(predicate);
  while (found === undefined) {
    if (Date.now() > deadline) {
      throw new Error("timed out waiting for a matching activity log event");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
    found = sink.events.find(predicate);
  }
  return found;
}

function isHttpRequestLine(event: ServerLogEvent): boolean {
  return event.category === "http" && event.op === "request";
}

afterEach(() => {
  // Both the process-wide logger slot and the client-diagnostics rate limiter/drop-notice counter
  // are module-level state shared across every test in this file (and, for the logger, across the
  // whole worker) — reset unconditionally so one test's setup or a mid-test throw can never leak
  // into the next test's assertions.
  resetServerLogger();
  resetClientDiagnosticsIngestStateForTests();
});

describe("(a) client disconnect mid-response — real socket abort", () => {
  it("logs aborted:true with the matched route template, query-parameter names, and responseBytes", async () => {
    const handlerDeps = minimalHandlerDeps();
    const runId = randomUUID();
    // A running (never-terminated) sink keeps `/api/runs/:runId/events` open indefinitely once the
    // `ready` frame is sent — exactly what lets a real client abort mid-stream instead of racing a
    // response that would complete before the abort ever reaches the server.
    handlerDeps.registry.register({
      runId,
      fingerprint: "fp-mid-response-abort",
      modelId: "test-model",
      sink: new QueueEventSink(),
      cancel: () => undefined,
    });
    let started: TestServerHandle | undefined;
    try {
      started = await startTestServer(handlerDeps);
      const controller = new AbortController();
      const response = await fetch(
        `${baseUrl(started.port)}/api/runs/${runId}/events?foo=1&bar=2`,
        { signal: controller.signal },
      );
      const reader = response.body?.getReader();
      if (reader === undefined) {
        throw new Error("expected a readable SSE response body");
      }
      // Read the `ready` frame first: this proves the response genuinely started (headers sent,
      // bytes flowing) before the client tears the connection down, i.e. a true mid-response abort
      // rather than a pre-response cancel.
      await reader.read();
      controller.abort();
      await reader.cancel().catch(() => undefined);

      const event = await waitForEvent(started.sink, isHttpRequestLine);
      expect(event.extra?.aborted).toBe(true);
      expect(event.extra?.routeTemplate).toBe("/api/runs/:runId/events");
      expect(event.extra?.queryParamNames).toEqual(["bar", "foo"]);
      // A STREAMING route never calls `writeJson` (the only place `responseBytes` is computed), so
      // the field is present and reports the documented default rather than being silently absent.
      expect(event.extra?.responseBytes).toBe(0);
    } finally {
      if (started !== undefined) await closeUiTestServer(started.server);
      handlerDeps.store.close();
    }
  });
});

describe("(b) SSE terminal line — real frame/byte counters", () => {
  it("logs sse.stream.closed with frameCount 3 and bytesStreamed equal to the bytes actually written", async () => {
    const handlerDeps = minimalHandlerDeps();
    const runId = randomUUID();
    const eventSink = new QueueEventSink();
    for (let seq = 0; seq < 3; seq += 1) {
      const event: StreamEvent = {
        schemaVersion: "1",
        runId,
        fingerprint: "fp-three-frames",
        seq,
        ts: Date.now(),
        type: "workflow:progress",
      };
      eventSink.emit(event);
    }
    // Terminating the sink BEFORE any writer attaches means the real route (`openSseStream`)
    // replays exactly these 3 buffered events on connect, then ends the response itself — a
    // deterministic, real end-to-end SSE close with no reliance on wall-clock timing.
    eventSink.closeAll();
    handlerDeps.registry.register({
      runId,
      fingerprint: "fp-three-frames",
      modelId: "test-model",
      sink: eventSink,
      cancel: () => undefined,
    });
    let started: TestServerHandle | undefined;
    try {
      started = await startTestServer(handlerDeps);
      const response = await fetch(`${baseUrl(started.port)}/api/runs/${runId}/events`);
      const text = await response.text();

      const event = await waitForEvent(
        started.sink,
        (candidate) => candidate.op === "sse.stream.closed",
      );
      expect(event.extra?.frameCount).toBe(3);

      // The response is exactly [3 counted event frames][1 uncounted `ready` frame], in that order
      // (verified from `openSseStream`: buffer replay happens before the `ready` write). Deriving
      // the expected byte count from the REAL bytes the server sent — rather than recomputing the
      // SSE framing formula independently — means this assertion can never drift from whatever the
      // production frame format actually is.
      const totalBytes = Buffer.byteLength(text, "utf8");
      const readyBytes = Buffer.byteLength(readyMessage(), "utf8");
      expect(event.extra?.bytesStreamed).toBe(totalBytes - readyBytes);
    } finally {
      if (started !== undefined) await closeUiTestServer(started.server);
      handlerDeps.store.close();
    }
  });
});

describe("(c) POST /api/diagnostics/client — real ingest route", () => {
  it("round-trips a body-supplied correlationId under extra.clientNote, with no message key on the formatted line", async () => {
    const handlerDeps = minimalHandlerDeps();
    const correlationId = randomUUID();
    // Short and low-punctuation on purpose: `log-redaction.ts`'s generic prose guard collapses any
    // value with more than 3 spaces to `[redacted:shape]` regardless of field name — a real
    // constraint on the CONTENT this endpoint can log verbatim, orthogonal to the field-NAME fix
    // this test proves. A value this shape survives formatting unredacted, so the assertions below
    // can check the formatted line's exact content, not just its key names.
    const message = "sse-error readyState=2";
    let started: TestServerHandle | undefined;
    try {
      started = await startTestServer(handlerDeps);
      const response = await fetch(`${baseUrl(started.port)}/api/diagnostics/client`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Keiko-CSRF": "1" },
        body: JSON.stringify({
          message,
          clientTs: new Date().toISOString(),
          readyState: 2,
          correlationId,
          kind: "sse-error",
        }),
      });
      expect(response.status).toBe(204);

      const rawEvent = await waitForEvent(
        started.sink,
        (candidate) => candidate.op === "client.diagnostic",
      );
      // The raw (pre-format) event: proves the route's own code writes the field under the name
      // `clientNote`, never `message`.
      expect(rawEvent.extra?.clientNote).toBe(message);
      expect(rawEvent.correlationId).toBe(correlationId);

      // The FORMATTED line — what actually reaches disk in production — after redaction. If the
      // route had used `extra.message` instead, `message` would be DENIED and this same line would
      // carry `"message":"[redacted:key]"`; because it used `clientNote`, no `message` key exists at
      // all and the content survives intact.
      const lineIndex = started.sink.events.indexOf(rawEvent);
      const formattedLine = started.sink.lines()[lineIndex];
      if (formattedLine === undefined) {
        throw new Error("expected a formatted log line for the captured event");
      }
      const parsed = JSON.parse(formattedLine) as Record<string, unknown>;
      expect(parsed.clientNote).toBe(message);
      expect(parsed.correlationId).toBe(correlationId);
      expect("message" in parsed).toBe(false);
    } finally {
      if (started !== undefined) await closeUiTestServer(started.server);
      handlerDeps.store.close();
    }
  });

  it("rejects an oversized body with 413", async () => {
    const handlerDeps = minimalHandlerDeps();
    let started: TestServerHandle | undefined;
    try {
      started = await startTestServer(handlerDeps);
      const response = await fetch(`${baseUrl(started.port)}/api/diagnostics/client`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Keiko-CSRF": "1" },
        // Content need not be valid JSON: the bounded-body reader rejects on byte count while
        // streaming, before any JSON parsing is attempted.
        body: "a".repeat(10_000),
      });
      expect(response.status).toBe(413);
    } finally {
      if (started !== undefined) await closeUiTestServer(started.server);
      handlerDeps.store.close();
    }
  });

  it("rejects a malformed (schema-invalid) body with 400", async () => {
    const handlerDeps = minimalHandlerDeps();
    let started: TestServerHandle | undefined;
    try {
      started = await startTestServer(handlerDeps);
      const response = await fetch(`${baseUrl(started.port)}/api/diagnostics/client`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Keiko-CSRF": "1" },
        // Valid JSON, but missing the required `clientTs` field — fails
        // `isClientDiagnosticIngestRequest`, not JSON.parse.
        body: JSON.stringify({ message: "missing clientTs" }),
      });
      expect(response.status).toBe(400);
    } finally {
      if (started !== undefined) await closeUiTestServer(started.server);
      handlerDeps.store.close();
    }
  });
});

// NOTE on this scenario's fails-before status: verified by temporarily reverting
// `gitRoutes.ts` to its pre-Wave-5 `dev` content and re-running this file — this assertion
// PASSED against that baseline too. Pre-Wave-5, `gitReadErrorBody`'s `operation` was built from
// `` `GET ${ctx.url.pathname}` ``, and `URL.pathname` never includes the query string in either
// version — so for the two CURRENTLY declared, segment-free `/api/git/*` routes, the raw-pathname
// read and the new literal `GIT_DIFF_ROUTE_TEMPLATE` constant are byte-identical for every request
// that can actually reach this handler; there is no live request that makes them diverge. The
// Wave-5 change is real (confirmed by diff: a per-call-site literal constant replaces the
// `ctx.url.pathname` read) and the invariant this test locks in is real and worth pinning, but it
// is forward-looking defense-in-depth — the code's own comment says so ("a future dynamic segment
// on one of these routes could not smuggle a customer-chosen value through this diagnostic
// either") — not a fix to a currently reachable leak. Keeping this test as a regression PIN rather
// than removing it: it is what stops a future git route with a real `:param` segment from silently
// regressing back to reading `ctx.url.pathname`.
describe("(d) git route diagnostic — declared template, never the raw query value", () => {
  it('carries operation "GET /api/git/diff" and never the customer-named path from the query string', async () => {
    const records: ServerDiagnosticRecord[] = [];
    const handlerDeps = minimalHandlerDeps({ record: (record) => records.push(record) });
    // An absolute path: `isRootRelativeFileIdentifier` rejects it (BAD_PATH) before the handler
    // ever resolves a repository, so no real git repository is needed for this test at all. The
    // segment itself is the "customer-named" value the diagnostic must never echo.
    const customerSegment = "customer-secret-acme-corp";
    let started: TestServerHandle | undefined;
    try {
      started = await startTestServer(handlerDeps);
      const response = await fetch(
        `${baseUrl(started.port)}/api/git/diff?path=${encodeURIComponent(`/${customerSegment}/config.json`)}`,
      );
      expect(response.status).toBe(400);
      const body = (await response.json()) as { readonly error: { readonly code: string } };
      expect(body.error.code).toBe("BAD_PATH");

      expect(records).toHaveLength(1);
      const [record] = records;
      if (record === undefined) {
        throw new Error("expected exactly one diagnostic record");
      }
      expect(record.operation).toBe("GET /api/git/diff");
      expect(JSON.stringify(record)).not.toContain(customerSegment);
    } finally {
      if (started !== undefined) await closeUiTestServer(started.server);
      handlerDeps.store.close();
    }
  });
});
