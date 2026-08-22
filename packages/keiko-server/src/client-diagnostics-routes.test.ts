import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  handleClientDiagnosticIngest,
  resetClientDiagnosticsIngestStateForTests,
} from "./client-diagnostics-routes.js";
import {
  createBufferedServerLogSink,
  createServerLogger,
  resetServerLogger,
  setServerLogger,
  type BufferedServerLogSink,
  type ServerLogEvent,
} from "./observability/index.js";
import type { RouteContext } from "./routes.js";

const CORRELATION_ID = "diagnostics-route-test";
const CLIENT_TS = "2026-08-21T10:00:00.000Z";

function request(rawBody: string): IncomingMessage {
  const req = new IncomingMessage(new Socket());
  req.push(rawBody);
  req.push(null);
  return req;
}

function context(
  rawBody: string,
  correlationId: string | undefined = CORRELATION_ID,
): RouteContext {
  const req = request(rawBody);
  return {
    req,
    res: new ServerResponse(req),
    params: {},
    url: new URL("http://localhost/api/diagnostics/client"),
    correlationId,
  };
}

function captureServerLog(): BufferedServerLogSink {
  const sink = createBufferedServerLogSink();
  setServerLogger(createServerLogger({ sink, level: "debug" }));
  return sink;
}

// The bounded-body reader this route shares with every other route also writes its own
// `http.request.body.received`/`.rejected` lines, independent of whether this route's OWN report
// is accepted. Every assertion below is scoped to this route's own op, never the raw sink, so it
// stays correct regardless of what else the shared body reader logs.
function clientDiagnosticEvents(sink: BufferedServerLogSink): readonly ServerLogEvent[] {
  return sink.events.filter((event) => event.op === "client.diagnostic");
}

function clientDiagnosticLine(sink: BufferedServerLogSink): Record<string, unknown> {
  const index = sink.events.findIndex((event) => event.op === "client.diagnostic");
  expect(index).toBeGreaterThanOrEqual(0);
  const line = sink.lines()[index];
  expect(line).toBeDefined();
  return JSON.parse(line ?? "{}") as Record<string, unknown>;
}

describe("POST /api/diagnostics/client", () => {
  beforeEach(() => {
    resetClientDiagnosticsIngestStateForTests();
  });

  afterEach(() => {
    resetServerLogger();
    resetClientDiagnosticsIngestStateForTests();
  });

  // The FATAL-FLAW FIX (all three design-panel judges independently flagged it): the field is
  // exactly what lets an agent join a browser crash report to the specific failed server request
  // it describes — the ORIGINAL request's correlation id, never this POST's own.
  it("accepts a well-formed report, always with 204, and round-trips a valid correlationId", async () => {
    const sink = captureServerLog();
    const body = JSON.stringify({
      message: "boundary caught TypeError",
      clientTs: CLIENT_TS,
      readyState: 2,
      correlationId: "original-request-correlation-id",
      kind: "boundary",
    });

    const result = await handleClientDiagnosticIngest(context(body));

    expect(result).toEqual({ status: 204, body: null });
    const events = clientDiagnosticEvents(sink);
    expect(events).toHaveLength(1);
    const [event] = events;
    expect(event?.category).toBe("diagnostic");
    expect(event?.correlationId).toBe("original-request-correlation-id");
    expect(event?.errorKind).toBe("boundary");
  });

  // FATAL-FLAW FIX #2 (graft from the reuse-maximal design): `"message"` is on
  // `log-redaction.ts`'s DENIED_FIELD_NAMES and would collapse to `[redacted:key]` even though the
  // value is already bounded — the wire field named `message` must never reach the log line under
  // that same name.
  it("projects the wire field literally named 'message' onto extra.clientNote, never extra.message", async () => {
    const sink = captureServerLog();
    const body = JSON.stringify({ message: "boundary caught TypeError", clientTs: CLIENT_TS });

    await handleClientDiagnosticIngest(context(body));

    const line = clientDiagnosticLine(sink);
    expect(line).not.toHaveProperty("message");
    expect(line.clientNote).toBe("boundary caught TypeError");
  });

  it("drops an invalid correlationId instead of rejecting the whole report", async () => {
    const sink = captureServerLog();
    // Fails `isValidCorrelationId`'s alphabet (spaces and `!` are not in [A-Za-z0-9._-]), but is a
    // conforming wire STRING, so the contract guard alone must not be trusted for this field.
    const body = JSON.stringify({
      message: "unhandled rejection",
      clientTs: CLIENT_TS,
      correlationId: "not valid!!",
    });

    const result = await handleClientDiagnosticIngest(context(body));

    expect(result).toEqual({ status: 204, body: null });
    expect(clientDiagnosticEvents(sink)[0]?.correlationId).toBeUndefined();
  });

  it("rejects an oversized body with 413 and never reaches the logger", async () => {
    const sink = captureServerLog();
    // Comfortably over MAX_CLIENT_DIAGNOSTIC_BODY_BYTES (4096) in raw bytes, so the bounded reader
    // itself rejects the body before JSON parsing or shape validation ever runs.
    const body = JSON.stringify({ message: "x".repeat(5_000), clientTs: CLIENT_TS });

    const result = await handleClientDiagnosticIngest(context(body));

    expect(result.status).toBe(413);
    expect(clientDiagnosticEvents(sink)).toEqual([]);
  });

  it("rejects a message over the 200-character wire bound with 400", async () => {
    const sink = captureServerLog();
    const body = JSON.stringify({ message: "y".repeat(201), clientTs: CLIENT_TS });

    const result = await handleClientDiagnosticIngest(context(body));

    expect(result.status).toBe(400);
    expect(clientDiagnosticEvents(sink)).toEqual([]);
  });

  it("rejects malformed JSON with 400", async () => {
    const sink = captureServerLog();

    const result = await handleClientDiagnosticIngest(context("{not json"));

    expect(result.status).toBe(400);
    expect(clientDiagnosticEvents(sink)).toEqual([]);
  });

  it("rejects a body missing the required clientTs field with 400", async () => {
    const sink = captureServerLog();
    const body = JSON.stringify({ message: "no timestamp" });

    const result = await handleClientDiagnosticIngest(context(body));

    expect(result.status).toBe(400);
    expect(clientDiagnosticEvents(sink)).toEqual([]);
  });

  it("redacts a hostile message carrying an email address", async () => {
    const sink = captureServerLog();
    const body = JSON.stringify({
      message: "contact jane.doe@example.com for help",
      clientTs: CLIENT_TS,
    });

    await handleClientDiagnosticIngest(context(body));

    expect(clientDiagnosticLine(sink).clientNote).toBe("[redacted:personal]");
  });

  it("redacts a hostile message carrying an API-key-shaped secret", async () => {
    const sink = captureServerLog();
    // The secret pattern is anchored at the start of the value, so the message must BEGIN with a
    // recognised key prefix rather than merely contain one.
    const body = JSON.stringify({ message: `sk-ant-${"a".repeat(40)}`, clientTs: CLIENT_TS });

    await handleClientDiagnosticIngest(context(body));

    expect(clientDiagnosticLine(sink).clientNote).toBe("[redacted:secret]");
  });

  // Regression for the confusable-shape trust-boundary finding: a parsed JSON body that happens to
  // look like this route's own internal `RouteResult` sentinel (a numeric `status` plus a `body`
  // key) must never be echoed back verbatim, and must still go through shape validation, the rate
  // limiter, and the logger like any other malformed report.
  it("never reflects a client body shaped like {status, body} as the route's own response", async () => {
    const sink = captureServerLog();
    const body = JSON.stringify({ status: 200, body: { secret: "attacker-controlled" } });

    const result = await handleClientDiagnosticIngest(context(body));

    expect(result).not.toEqual({ status: 200, body: { secret: "attacker-controlled" } });
    expect(result.status).toBe(400);
    expect(clientDiagnosticEvents(sink)).toEqual([]);
  });

  it("never forges an out-of-range status code from a client body shaped like a RouteResult", async () => {
    const body = JSON.stringify({ status: 599, body: "arbitrary" });

    const result = await handleClientDiagnosticIngest(context(body));

    expect(result.status).toBe(400);
  });

  it("drops the 61st report within the same rolling minute, still answering 204", async () => {
    const sink = captureServerLog();
    const results: number[] = [];
    for (let index = 0; index < 61; index += 1) {
      const body = JSON.stringify({
        message: `report number ${String(index)}`,
        clientTs: CLIENT_TS,
      });
      const result = await handleClientDiagnosticIngest(context(body));
      results.push(result.status);
    }

    expect(results.every((status) => status === 204)).toBe(true);
    expect(sink.events.filter((event) => event.op === "client.diagnostic")).toHaveLength(60);
    expect(
      sink.events.filter((event) => event.op === "client.diagnostic.rate-limited"),
    ).toHaveLength(1);
  });
});
