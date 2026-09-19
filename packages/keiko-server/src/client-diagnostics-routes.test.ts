import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  clientBindingDigest,
  clientDiagnosticNoteDigest,
  handleClientDiagnosticIngest,
  resetClientDiagnosticsIngestStateForTests,
} from "./client-diagnostics-routes.js";
import { UNKNOWN_CORRELATION_ID } from "./correlation.js";
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

function clientStageEvents(
  sink: BufferedServerLogSink,
  op: "client.stage.started" | "client.stage.settled",
): readonly ServerLogEvent[] {
  return sink.events.filter((event) => event.op === op);
}

function clientDiagnosticRejectedEvents(sink: BufferedServerLogSink): readonly ServerLogEvent[] {
  return sink.events.filter((event) => event.op === "client.diagnostic.rejected");
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
    expect(event?.errorKind).toBe("internal");
    expect(event?.extra).toMatchObject({
      clientKind: "boundary",
      completeness: "complete",
      loss: "none",
    });
  });

  it.each([
    ["boundary", "internal"],
    ["unhandled-rejection", "internal"],
    ["sse-error", "unavailable"],
    ["other", "unknown"],
  ] as const)("maps the closed %s client kind to %s", async (kind, errorKind) => {
    const sink = captureServerLog();
    const body = JSON.stringify({ message: "bounded client failure", clientTs: CLIENT_TS, kind });

    await expect(handleClientDiagnosticIngest(context(body))).resolves.toEqual({
      status: 204,
      body: null,
    });

    expect(clientDiagnosticEvents(sink)[0]).toMatchObject({
      errorKind,
      extra: { clientKind: kind },
    });
  });

  it("projects the hostile message only as a digest", async () => {
    const sink = captureServerLog();
    const message = "boundary caught TypeError";
    const body = JSON.stringify({ message, clientTs: CLIENT_TS });

    await handleClientDiagnosticIngest(context(body));

    const line = clientDiagnosticLine(sink);
    expect(line).not.toHaveProperty("message");
    expect(line).not.toHaveProperty("clientNote");
    expect(line.clientNoteDigest).toBe(clientDiagnosticNoteDigest(message));
    expect(JSON.stringify(line)).not.toContain(message);
  });

  it("preserves a validated git-change response identity on the originating timeline", async () => {
    const sink = captureServerLog();
    const body = JSON.stringify({
      message: "git-change description response",
      clientTs: CLIENT_TS,
      correlationId: "original-apply-request-id",
      gitChangeDescription: {
        action: "apply",
        disposition: "discarded",
        relationshipId: "rel-1",
        snapshotDigest: "a".repeat(64),
        proposalId: "prop-1",
        outcome: "observed",
      },
    });

    expect(await handleClientDiagnosticIngest(context(body))).toEqual({ status: 204, body: null });
    expect(clientDiagnosticLine(sink)).toMatchObject({
      op: "client.diagnostic",
      correlationId: "original-apply-request-id",
      action: "apply",
      disposition: "discarded",
      relationshipId: "rel-1",
      snapshotDigest: "a".repeat(64),
      proposalId: "prop-1",
      outcome: "observed",
    });
  });

  it("preserves the validated workspace trust identity on the originating timeline", async () => {
    const sink = captureServerLog();
    const body = JSON.stringify({
      message: "coding workbench repository trust bound",
      clientTs: CLIENT_TS,
      correlationId: "originating-run-correlation",
      workspaceTrustBinding: {
        repositoryId: "repository-a",
        workspaceId: "workspace-a",
      },
    });

    expect(await handleClientDiagnosticIngest(context(body))).toEqual({ status: 204, body: null });
    expect(clientDiagnosticLine(sink)).toMatchObject({
      op: "client.diagnostic",
      correlationId: "originating-run-correlation",
      repositoryId: "repository-a",
      workspaceId: "workspace-a",
    });
  });

  it("rejects an invalid correlationId and retains the validated ingest correlation", async () => {
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
    expect(clientDiagnosticEvents(sink)[0]?.correlationId).not.toBe("not valid!!");
    expect(clientDiagnosticEvents(sink)[0]?.correlationId).toBe(CORRELATION_ID);
  });

  it.each([
    [CORRELATION_ID, CORRELATION_ID],
    [undefined, UNKNOWN_CORRELATION_ID],
    ["invalid ingest!!", UNKNOWN_CORRELATION_ID],
  ])("correlates a report without an original request using %s", async (ingestId, expected) => {
    const sink = captureServerLog();
    const body = JSON.stringify({ message: "diff keyboard scroll", clientTs: CLIENT_TS });
    const ctx = { ...context(body), correlationId: ingestId };

    await handleClientDiagnosticIngest(ctx);

    expect(clientDiagnosticEvents(sink)[0]?.correlationId).toBe(expected);
    expect(clientDiagnosticLine(sink).correlationId).toBe(expected);
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

  it("digests a hostile message carrying an email address", async () => {
    const sink = captureServerLog();
    const body = JSON.stringify({
      message: "contact jane.doe@example.com for help",
      clientTs: CLIENT_TS,
    });

    await handleClientDiagnosticIngest(context(body));

    const line = clientDiagnosticLine(sink);
    expect(line.clientNoteDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(line)).not.toContain("jane.doe@example.com");
  });

  it("digests a hostile message carrying an API-key-shaped secret", async () => {
    const sink = captureServerLog();
    // The secret pattern is anchored at the start of the value, so the message must BEGIN with a
    // recognised key prefix rather than merely contain one.
    const body = JSON.stringify({ message: `sk-ant-${"a".repeat(40)}`, clientTs: CLIENT_TS });

    await handleClientDiagnosticIngest(context(body));

    const line = clientDiagnosticLine(sink);
    expect(line.clientNoteDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(line)).not.toContain("sk-ant-");
  });

  it("never persists an arbitrary sentence that passes the generic value guards", async () => {
    const sink = captureServerLog();
    const message = "transfer account 1234";

    await handleClientDiagnosticIngest(context(JSON.stringify({ message, clientTs: CLIENT_TS })));

    const line = clientDiagnosticLine(sink);
    expect(line.clientNoteDigest).toBe(clientDiagnosticNoteDigest(message));
    expect(JSON.stringify(line)).not.toContain(message);
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
    expect(
      sink.events.find((event) => event.op === "client.diagnostic.rate-limited")?.correlationId,
    ).toBe(CORRELATION_ID);
    expect(
      sink.events.find((event) => event.op === "client.diagnostic.rate-limited")?.extra,
    ).toMatchObject({ completeness: "complete", loss: "event-dropped" });
  });

  // #3557 review: a failure the page classified keeps its closed class instead of `unknown`.
  it("logs a message report's classified error kind in place of the kind-derived one", async () => {
    const sink = captureServerLog();
    const body = JSON.stringify({
      message: "[keiko] local app session ensure failed: TypeError",
      clientTs: CLIENT_TS,
      correlationId: "ui_session-ensure-0001",
      errorKind: "unavailable",
    });

    expect((await handleClientDiagnosticIngest(context(body))).status).toBe(204);

    expect(clientDiagnosticEvents(sink)[0]).toMatchObject({
      correlationId: "ui_session-ensure-0001",
      errorKind: "unavailable",
    });
  });

  // #3557 review: a restored window's binding outcome is typed evidence, never a message digest.
  describe("binding evidence", () => {
    function bindingEvents(
      sink: BufferedServerLogSink,
      op: "client.binding.resolved" | "client.binding.target-missing",
    ): readonly ServerLogEvent[] {
      return sink.events.filter((event) => event.op === op);
    }

    it("logs a missing target at warn with a closed error kind, under the list load's correlation id", async () => {
      const sink = captureServerLog();
      const body = JSON.stringify({
        kind: "binding",
        surface: "chat-window",
        windowRef: "chat-mfr3k2x1-1",
        outcome: "target-missing",
        referenceShape: "redacted",
        heuristicFlagged: false,
        correlationId: "ui_chat-list-load-0001",
      });

      expect(await handleClientDiagnosticIngest(context(body))).toEqual({
        status: 204,
        body: null,
      });

      const events = bindingEvents(sink, "client.binding.target-missing");
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        level: "warn",
        category: "diagnostic",
        errorKind: "unavailable",
        correlationId: "ui_chat-list-load-0001",
        extra: {
          surface: "chat-window",
          referenceShape: "redacted",
          heuristicFlagged: false,
          bindingDigest: clientBindingDigest("chat-mfr3k2x1-1"),
          completeness: "complete",
          loss: "none",
        },
      });
      // The window's own id reaches the log only as its digest.
      expect(JSON.stringify(events)).not.toContain("chat-mfr3k2x1-1");
      expect(clientDiagnosticEvents(sink)).toEqual([]);
    });

    it("logs a resolved binding whose reference the heuristic flags at info, without an error kind", async () => {
      const sink = captureServerLog();
      const body = JSON.stringify({
        kind: "binding",
        surface: "chat-window",
        windowRef: "chat-mfr3k2x1-1",
        outcome: "resolved",
        referenceShape: "uuid",
        heuristicFlagged: true,
      });

      expect(await handleClientDiagnosticIngest(context(body))).toEqual({
        status: 204,
        body: null,
      });

      const events = bindingEvents(sink, "client.binding.resolved");
      expect(events).toHaveLength(1);
      expect(events[0]?.level).toBe("info");
      expect(events[0]?.errorKind).toBeUndefined();
      // Without a client-supplied id, the ingest POST's own id applies.
      expect(events[0]?.correlationId).toBe(CORRELATION_ID);
      expect(events[0]?.extra).toMatchObject({ referenceShape: "uuid", heuristicFlagged: true });
    });

    it("falls back to the ingest id when the client-supplied id is not a safe correlation id", async () => {
      const sink = captureServerLog();
      const body = JSON.stringify({
        kind: "binding",
        surface: "chat-window",
        windowRef: "chat-mfr3k2x1-1",
        outcome: "target-missing",
        referenceShape: "uuid",
        heuristicFlagged: false,
        correlationId: "not a safe id",
      });

      await handleClientDiagnosticIngest(context(body));

      expect(bindingEvents(sink, "client.binding.target-missing")[0]?.correlationId).toBe(
        CORRELATION_ID,
      );
    });

    // #3557 review: two windows restored from one list answer stay apart by their window digest,
    // and a legacy verdict names every list load it depended on.
    it("gives each window its own digest and keeps the related list loads", async () => {
      const sink = captureServerLog();
      const windows = ["chat-mfr3k2x1-1", "chat-mfr3k2x1-2"];
      for (const windowRef of windows) {
        const body = JSON.stringify({
          kind: "binding",
          surface: "chat-window",
          windowRef,
          outcome: "resolved",
          referenceShape: "uuid",
          heuristicFlagged: false,
          correlationId: "ui_chat-list-load-0001",
          relatedCorrelationIds: ["ui_chat-list-load-0002", "not a safe id"],
          decidingLoadCount: 2,
        });
        expect((await handleClientDiagnosticIngest(context(body))).status).toBe(204);
      }

      const events = bindingEvents(sink, "client.binding.resolved");
      const digests = events.map((event) => event.extra?.bindingDigest);
      expect(digests).toEqual(windows.map((windowRef) => clientBindingDigest(windowRef)));
      expect(new Set(digests).size).toBe(2);
      // Only the safe related id survives, and a line naming its whole causal set is complete.
      expect(events[0]?.extra?.relatedCorrelationIds).toEqual(["ui_chat-list-load-0002"]);
      expect(events[0]?.extra).toMatchObject({ completeness: "complete", loss: "none" });
      expect(events[0]?.extra).not.toHaveProperty("decidingLoadCount");
    });

    // #3557 review: a deciding load the line cannot name is classified loss, never a quiet count.
    it("records the unnamed deciding loads as loss on a partial line", async () => {
      const sink = captureServerLog();
      const related = Array.from(
        { length: 63 },
        (_value, index) => `ui_chat-list-load-${String(index + 2).padStart(4, "0")}`,
      );
      const body = JSON.stringify({
        kind: "binding",
        surface: "chat-window",
        windowRef: "chat-mfr3k2x1-1",
        outcome: "target-missing",
        referenceShape: "uuid",
        heuristicFlagged: false,
        correlationId: "ui_chat-list-load-0001",
        relatedCorrelationIds: related,
        decidingLoadCount: 70,
      });

      await handleClientDiagnosticIngest(context(body));

      const [event] = bindingEvents(sink, "client.binding.target-missing");
      expect(event?.extra).toMatchObject({
        completeness: "partial",
        loss: "event-location-unknown",
        decidingLoadCount: 70,
      });
      expect(event?.extra?.relatedCorrelationIds).toHaveLength(63);
    });

    // #3557 review: a verdict decided by a load whose id the page does not know is not complete.
    it("records a deciding load without a known id as loss", async () => {
      const sink = captureServerLog();
      const body = JSON.stringify({
        kind: "binding",
        surface: "chat-window",
        windowRef: "chat-mfr3k2x1-1",
        outcome: "resolved",
        referenceShape: "uuid",
        heuristicFlagged: false,
        decidingLoadCount: 1,
      });

      await handleClientDiagnosticIngest(context(body));

      const [event] = bindingEvents(sink, "client.binding.resolved");
      expect(event?.extra).toMatchObject({
        completeness: "partial",
        loss: "event-location-unknown",
        decidingLoadCount: 1,
      });
    });

    // #3557 review: an id the server refuses, or one named twice, never counts as a named load.
    it("counts neither a refused primary id nor a duplicate as a named deciding load", async () => {
      const sink = captureServerLog();
      const reports = [
        { correlationId: "not a safe id", decidingLoadCount: 1 },
        { correlationId: "not a safe id" },
        {
          correlationId: "ui_chat-list-load-0001",
          relatedCorrelationIds: [
            "ui_chat-list-load-0001",
            "ui_chat-list-load-0002",
            "ui_chat-list-load-0002",
          ],
          decidingLoadCount: 3,
        },
      ];
      for (const report of reports) {
        const body = JSON.stringify({
          kind: "binding",
          surface: "chat-window",
          windowRef: "chat-mfr3k2x1-1",
          outcome: "target-missing",
          referenceShape: "uuid",
          heuristicFlagged: false,
          ...report,
        });
        expect((await handleClientDiagnosticIngest(context(body))).status).toBe(204);
      }

      const lines = bindingEvents(sink, "client.binding.target-missing").map(
        (event) => event.extra,
      );
      expect(lines).toEqual([
        expect.objectContaining({
          completeness: "partial",
          loss: "event-location-unknown",
          decidingLoadCount: 1,
        }),
        expect.objectContaining({
          completeness: "partial",
          loss: "event-location-unknown",
          decidingLoadCount: 1,
        }),
        expect.objectContaining({
          relatedCorrelationIds: ["ui_chat-list-load-0002"],
          completeness: "partial",
          loss: "event-location-unknown",
          decidingLoadCount: 3,
        }),
      ]);
    });

    // Distinct safe ids that name every deciding load make a complete line.
    it("keeps a line complete when its distinct safe ids name every deciding load", async () => {
      const sink = captureServerLog();
      const body = JSON.stringify({
        kind: "binding",
        surface: "chat-window",
        windowRef: "chat-mfr3k2x1-1",
        outcome: "target-missing",
        referenceShape: "uuid",
        heuristicFlagged: false,
        correlationId: "ui_chat-list-load-0001",
        relatedCorrelationIds: ["ui_chat-list-load-0002", "ui_chat-list-load-0002"],
        decidingLoadCount: 2,
      });

      await handleClientDiagnosticIngest(context(body));

      const [event] = bindingEvents(sink, "client.binding.target-missing");
      expect(event?.extra).toMatchObject({
        relatedCorrelationIds: ["ui_chat-list-load-0002"],
        completeness: "complete",
        loss: "none",
      });
      expect(event?.extra).not.toHaveProperty("decidingLoadCount");
    });

    it("refuses a binding report that carries a browser digest instead of the window reference", async () => {
      const sink = captureServerLog();
      const body = JSON.stringify({
        kind: "binding",
        surface: "chat-window",
        windowDigest: "a".repeat(64),
        outcome: "resolved",
        referenceShape: "uuid",
        heuristicFlagged: false,
      });

      expect((await handleClientDiagnosticIngest(context(body))).status).toBe(400);
      expect(bindingEvents(sink, "client.binding.resolved")).toEqual([]);
    });

    it("refuses a resolved binding for a redacted reference", async () => {
      const sink = captureServerLog();
      const body = JSON.stringify({
        kind: "binding",
        surface: "chat-window",
        windowRef: "chat-mfr3k2x1-1",
        outcome: "resolved",
        referenceShape: "redacted",
        heuristicFlagged: false,
      });

      expect((await handleClientDiagnosticIngest(context(body))).status).toBe(400);
      expect(bindingEvents(sink, "client.binding.resolved")).toEqual([]);
    });

    it("refuses a binding report that claims a heuristic flag for a non-UUID reference", async () => {
      const sink = captureServerLog();
      const body = JSON.stringify({
        kind: "binding",
        surface: "chat-window",
        windowRef: "chat-mfr3k2x1-1",
        outcome: "resolved",
        referenceShape: "opaque",
        heuristicFlagged: true,
      });

      expect((await handleClientDiagnosticIngest(context(body))).status).toBe(400);
      expect(bindingEvents(sink, "client.binding.resolved")).toEqual([]);
      expect(clientDiagnosticRejectedEvents(sink)[0]?.extra).toMatchObject({
        rejection: "invalid-shape",
      });
    });
  });

  // #3557: routine evidence (a dozen stage reports per page load) must never use up the budget a
  // failure report needs; each keeps its own sliding window.
  it("keeps a failure report admitted after a burst of routine stage evidence", async () => {
    const sink = captureServerLog();
    for (let ordinal = 1; ordinal <= 70; ordinal += 1) {
      const stage = { kind: "stage", stage: "window chunk", phase: "started", ordinal };
      await handleClientDiagnosticIngest(context(JSON.stringify(stage)));
    }
    const failure = JSON.stringify({
      message: "boundary caught TypeError",
      clientTs: CLIENT_TS,
      kind: "boundary",
    });

    expect(await handleClientDiagnosticIngest(context(failure))).toEqual({
      status: 204,
      body: null,
    });
    expect(clientDiagnosticEvents(sink)).toHaveLength(1);
    // The routine burst itself is still bounded, and its overflow is counted as a drop.
    expect(sink.events.filter((event) => event.op === "client.stage.started")).toHaveLength(60);
    expect(sink.events.some((event) => event.op === "client.diagnostic.rate-limited")).toBe(true);
  });

  // #3557 review: both phases of one mounted stage carry the client-minted id, so they join.
  it("logs both phases of a stage under the stage's own correlation id", async () => {
    const sink = captureServerLog();
    for (const body of [
      {
        kind: "stage",
        stage: "chat bind",
        phase: "started",
        ordinal: 4,
        correlationId: "ui_stage-0004",
      },
      {
        kind: "stage",
        stage: "chat bind",
        phase: "settled",
        ordinal: 4,
        durationMs: 12,
        correlationId: "ui_stage-0004",
      },
    ]) {
      await handleClientDiagnosticIngest(context(JSON.stringify(body)));
    }

    const stage = sink.events.filter((event) => event.op.startsWith("client.stage."));
    expect(stage.map((event) => [event.op, event.correlationId])).toEqual([
      ["client.stage.started", "ui_stage-0004"],
      ["client.stage.settled", "ui_stage-0004"],
    ]);
  });

  // #3557 review: the stale-session repair outcome joins the denied request's timeline.
  describe("session repair evidence", () => {
    it.each([
      ["replayed", "client.session-repair.recovered", "info", undefined],
      ["stream-repaired", "client.session-repair.recovered", "info", "run-events"],
      ["replay-failed", "client.session-repair.failed", "warn", undefined],
      ["replay-skipped", "client.session-repair.failed", "warn", undefined],
      ["repair-failed", "client.session-repair.failed", "warn", undefined],
      ["repair-failed", "client.session-repair.failed", "warn", "shared-event-source"],
    ] as const)("logs a %s outcome as %s at %s (stream %s)", async (outcome, op, level, stream) => {
      const sink = captureServerLog();
      const body = JSON.stringify({
        kind: "session-repair",
        outcome,
        correlationId: "ui_denied-read-0001",
        repairCorrelationId: "ui_session-repair-0001",
        stream,
      });

      expect((await handleClientDiagnosticIngest(context(body))).status).toBe(204);

      const events = sink.events.filter((event) => event.op === op);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        level,
        correlationId: "ui_denied-read-0001",
        extra: { outcome, repairCorrelationId: "ui_session-repair-0001" },
      });
      expect(events[0]?.extra?.stream).toBe(stream);
      expect(events[0]?.errorKind).toBe(
        level === "info"
          ? undefined
          : outcome === "replay-skipped"
            ? "authority-denied"
            : "unknown",
      );
      expect(clientDiagnosticEvents(sink)).toEqual([]);
    });

    // #3557 review: an acknowledged stream repair is a state on the streak's timeline, never the
    // recovery, and a routine report.
    it("logs an acknowledged stream repair as client.session-repair.acknowledged at info", async () => {
      const sink = captureServerLog();
      const body = JSON.stringify({
        kind: "session-repair",
        outcome: "repair-acknowledged",
        stream: "shared-event-source",
        correlationId: "ui_stream-streak-0003",
        repairCorrelationId: "ui_session-repair-0003",
      });

      expect((await handleClientDiagnosticIngest(context(body))).status).toBe(204);

      const events = sink.events.filter(
        (event) => event.op === "client.session-repair.acknowledged",
      );
      expect(events).toEqual([
        expect.objectContaining({
          level: "info",
          correlationId: "ui_stream-streak-0003",
          extra: expect.objectContaining({
            stream: "shared-event-source",
            repairCorrelationId: "ui_session-repair-0003",
          }) as unknown,
        }),
      ]);
      expect(events[0]?.errorKind).toBeUndefined();
      expect(
        sink.events.some((event) => event.op.startsWith("client.session-repair.recovered")),
      ).toBe(false);
    });

    // #3557 review: a stream repair is routine evidence, like a replayed read.
    it("keeps a failure report admitted after a burst of stream repairs", async () => {
      const sink = captureServerLog();
      for (let index = 1; index <= 61; index += 1) {
        const repair = {
          kind: "session-repair",
          outcome: "stream-repaired",
          stream: "run-events",
          correlationId: `ui_stream-streak-${String(index).padStart(4, "0")}`,
        };
        await handleClientDiagnosticIngest(context(JSON.stringify(repair)));
      }
      const failure = JSON.stringify({
        message: "boundary",
        clientTs: CLIENT_TS,
        kind: "boundary",
      });

      expect((await handleClientDiagnosticIngest(context(failure))).status).toBe(204);
      expect(clientDiagnosticEvents(sink)).toHaveLength(1);
    });
  });

  // #3557 review: a failed repair or replay keeps the class of the step that actually failed.
  it("logs the browser-classified failure of the repair step, not a blanket authority denial", async () => {
    const sink = captureServerLog();
    const body = JSON.stringify({
      kind: "session-repair",
      outcome: "replay-failed",
      correlationId: "ui_denied-read-0002",
      repairCorrelationId: "ui_session-repair-0002",
      errorKind: "unavailable",
    });

    await handleClientDiagnosticIngest(context(body));

    const [event] = sink.events.filter((line) => line.op === "client.session-repair.failed");
    expect(event).toMatchObject({ errorKind: "unavailable", extra: { outcome: "replay-failed" } });
  });

  // #3557 review: routine overflow must never hide a dropped failure report's own notice.
  it("gives each budget its own rate-limit notice, under the first dropped report of each", async () => {
    const sink = captureServerLog();
    for (let ordinal = 1; ordinal <= 61; ordinal += 1) {
      const stage = { kind: "stage", stage: "window chunk", phase: "started", ordinal };
      await handleClientDiagnosticIngest(
        context(JSON.stringify(stage), `ui_stage-${String(ordinal)}`),
      );
    }
    for (let index = 1; index <= 61; index += 1) {
      const failure = {
        message: `boundary ${String(index)}`,
        clientTs: CLIENT_TS,
        kind: "boundary",
      };
      await handleClientDiagnosticIngest(
        context(JSON.stringify(failure), `ui_failure-${String(index)}`),
      );
    }

    const notices = sink.events.filter((event) => event.op === "client.diagnostic.rate-limited");
    expect(notices.map((event) => [event.extra?.budget, event.correlationId])).toEqual([
      ["routine", "ui_stage-61"],
      ["failure", "ui_failure-61"],
    ]);
  });

  // KEIKO-3557: routine desktop-window stage evidence (`useWindowStageEvidence`) must ride its own
  // lifecycle operation at info, never the failure-shaped `client.diagnostic` at warn — that
  // misclassification is exactly what buried real failures in a live log's warning storm.
  describe("stage evidence", () => {
    it("logs a started stage report as client.stage.started, at info, with no errorKind", async () => {
      const sink = captureServerLog();
      const body = JSON.stringify({
        kind: "stage",
        stage: "chat bind",
        phase: "started",
        ordinal: 3,
      });

      const result = await handleClientDiagnosticIngest(context(body));

      expect(result).toEqual({ status: 204, body: null });
      const events = clientStageEvents(sink, "client.stage.started");
      expect(events).toHaveLength(1);
      const [event] = events;
      expect(event?.level).toBe("info");
      expect(event?.category).toBe("diagnostic");
      expect(event?.errorKind).toBeUndefined();
      expect(event?.correlationId).toBe(CORRELATION_ID);
      expect(event?.extra).toMatchObject({
        stage: "chat-bind",
        ordinal: 3,
        completeness: "complete",
        loss: "none",
      });
      // Never ALSO counted as the failure-shaped diagnostic line.
      expect(clientDiagnosticEvents(sink)).toEqual([]);
    });

    it("logs a settled stage report as client.stage.settled, at info, carrying durationMs", async () => {
      const sink = captureServerLog();
      const body = JSON.stringify({
        kind: "stage",
        stage: "window chunk",
        phase: "settled",
        ordinal: 7,
        durationMs: 42,
      });

      const result = await handleClientDiagnosticIngest(context(body));

      expect(result).toEqual({ status: 204, body: null });
      const events = clientStageEvents(sink, "client.stage.settled");
      expect(events).toHaveLength(1);
      const [event] = events;
      expect(event?.level).toBe("info");
      expect(event?.errorKind).toBeUndefined();
      expect(event?.durationMs).toBe(42);
      expect(event?.correlationId).toBe(CORRELATION_ID);
      expect(event?.extra).toMatchObject({
        stage: "window-chunk",
        ordinal: 7,
        completeness: "complete",
        loss: "none",
      });
    });

    it.each([
      ["an unknown stage", { kind: "stage", stage: "bogus", phase: "started", ordinal: 1 }],
      ["an unknown phase", { kind: "stage", stage: "chat bind", phase: "pending", ordinal: 1 }],
      [
        "an out-of-range durationMs",
        { kind: "stage", stage: "chat bind", phase: "settled", ordinal: 1, durationMs: -1 },
      ],
      [
        "an extra field",
        { kind: "stage", stage: "chat bind", phase: "started", ordinal: 1, extra: "value" },
      ],
    ])(
      "rejects a malformed stage report (%s) fail-closed and counts it",
      async (_label, payload) => {
        const sink = captureServerLog();

        const result = await handleClientDiagnosticIngest(context(JSON.stringify(payload)));

        expect(result.status).toBe(400);
        expect(clientStageEvents(sink, "client.stage.started")).toEqual([]);
        expect(clientStageEvents(sink, "client.stage.settled")).toEqual([]);
        expect(clientDiagnosticEvents(sink)).toEqual([]);
        expect(clientDiagnosticRejectedEvents(sink)).toHaveLength(1);
        expect(clientDiagnosticRejectedEvents(sink)[0]?.extra).toMatchObject({
          rejection: "invalid-shape",
        });
      },
    );

    it("still logs a plain message diagnostic at warn, exactly as before, alongside stage evidence", async () => {
      const sink = captureServerLog();
      const stageBody = JSON.stringify({
        kind: "stage",
        stage: "chat bind",
        phase: "started",
        ordinal: 1,
      });
      const messageBody = JSON.stringify({
        message: "boundary caught TypeError",
        clientTs: CLIENT_TS,
        kind: "boundary",
      });

      await handleClientDiagnosticIngest(context(stageBody));
      await handleClientDiagnosticIngest(context(messageBody));

      expect(clientStageEvents(sink, "client.stage.started")).toHaveLength(1);
      const diagnosticEvents = clientDiagnosticEvents(sink);
      expect(diagnosticEvents).toHaveLength(1);
      expect(diagnosticEvents[0]?.level).toBe("warn");
      expect(diagnosticEvents[0]?.errorKind).toBe("internal");
    });
  });
});
