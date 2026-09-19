import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
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
    ["voice-dialogue", "internal"],
    ["other", "unknown"],
  ] as const)("maps the closed %s client kind to %s", async (kind, errorKind) => {
    const sink = captureServerLog();
    const body = JSON.stringify({
      message: "bounded client failure",
      clientTs: CLIENT_TS,
      kind,
      ...(kind === "voice-dialogue" ? { voiceDialogueStage: "delivery-failed" } : {}),
    });

    await expect(handleClientDiagnosticIngest(context(body))).resolves.toEqual({
      status: 204,
      body: null,
    });

    expect(clientDiagnosticEvents(sink)[0]).toMatchObject({
      errorKind,
      extra: { clientKind: kind },
    });
  });

  it.each([
    ["delivery-cancelled", "cancelled"],
    ["delivery-rejected", "unavailable"],
    ["delivery-failed", "internal"],
    ["capture-renewal-failed", "internal"],
  ])("distinguishes %s as %s", async (stage, errorKind) => {
    const sink = captureServerLog();
    await handleClientDiagnosticIngest(
      context(
        JSON.stringify({
          message: "bounded delivery outcome",
          clientTs: CLIENT_TS,
          kind: "voice-dialogue",
          voiceDialogueStage: stage,
        }),
      ),
    );
    expect(clientDiagnosticEvents(sink)[0]?.errorKind).toBe(errorKind);
    expect(clientDiagnosticEvents(sink)[0]?.extra).toMatchObject({ voiceDialogueStage: stage });
  });

  it.each([-1, 1.5, 1_000_000_000, "7"])(
    "rejects malformed layout coordinates %s",
    async (listStart) => {
      const sink = captureServerLog();
      const result = await handleClientDiagnosticIngest(
        context(
          JSON.stringify({
            message: "layout",
            clientTs: CLIENT_TS,
            kind: "markdown-layout",
            markdownLayout: { listStart, listIndex: 0, depth: 0 },
          }),
        ),
      );
      expect(result.status).toBe(400);
      expect(sink.events.filter((event) => event.op === "client.markdown.layout")).toHaveLength(0);
    },
  );

  it("joins a body-free voice dialogue stage to the originating chat request", async () => {
    const sink = captureServerLog();
    const correlationId = "original-voice-chat-request-id";
    const body = JSON.stringify({
      message: "[keiko] batch voice dialogue (stage=delivery-failed)",
      clientTs: CLIENT_TS,
      correlationId,
      kind: "voice-dialogue",
      voiceDialogueStage: "delivery-failed",
    });

    await expect(handleClientDiagnosticIngest(context(body))).resolves.toEqual({
      status: 204,
      body: null,
    });
    expect(clientDiagnosticEvents(sink)[0]).toMatchObject({
      correlationId,
      errorKind: "internal",
      extra: { clientKind: "voice-dialogue", voiceDialogueStage: "delivery-failed" },
    });
    const line = clientDiagnosticLine(sink);
    expect(line).toMatchObject({ correlationId, voiceDialogueStage: "delivery-failed" });
    expect(JSON.stringify(line)).not.toContain("batch voice dialogue");
  });

  it.each([
    "started",
    "turn-submitted",
    "answer-ready",
    "playback-settled",
    "interrupted",
    "stopped",
  ] as const)(
    "records successful voice stage %s as timeline evidence without a failure",
    async (voiceDialogueStage) => {
      const sink = captureServerLog();
      await handleClientDiagnosticIngest(
        context(
          JSON.stringify({
            message: "private content must never be retained",
            clientTs: CLIENT_TS,
            kind: "voice-dialogue",
            correlationId: "voice-turn-correlation",
            voiceDialogueStage,
          }),
        ),
      );
      expect(clientDiagnosticEvents(sink)).toHaveLength(0);
      expect(sink.events).toContainEqual(
        expect.objectContaining({
          level: "info",
          op: "voice.dialogue.stage",
          correlationId: "voice-turn-correlation",
        }),
      );
      const event = sink.events.find((entry) => entry.op === "voice.dialogue.stage");
      expect(event?.extra).toMatchObject({ voiceDialogueStage });
      expect(event?.errorKind).toBeUndefined();
      expect(sink.lines().join("\n")).not.toContain("private content");
    },
  );

  it.each([
    ["capture-bound-reached", "vad-unavailable", undefined],
    ["capture-bound-reached", "speech-observed", undefined],
    ["capture-bound-reached", "renewal-unsupported", undefined],
    ["capture-renewal-failed", "replacement-start-failed", "invalid-state"],
    ["capture-renewal-failed", "replacement-start-failed", "type-error"],
    ["capture-renewal-failed", "replacement-start-failed", "range-error"],
    ["capture-renewal-failed", "previous-stop-failed", "not-supported"],
    ["capture-renewal-failed", "replacement-stop-failed", "other"],
  ] as const)(
    "persists capture decision %s / %s",
    async (voiceDialogueStage, voiceCaptureReason, voiceCaptureError) => {
      const sink = captureServerLog();
      await handleClientDiagnosticIngest(
        context(
          JSON.stringify({
            message: "private microphone detail",
            clientTs: CLIENT_TS,
            kind: "voice-dialogue",
            correlationId: "dialogue-session",
            voiceDialogueStage,
            voiceCaptureReason,
            voiceCaptureError,
          }),
        ),
      );
      expect(sink.events).toContainEqual(
        expect.objectContaining({
          correlationId: "dialogue-session",
          extra: expect.objectContaining({ voiceDialogueStage, voiceCaptureReason }) as unknown,
        }),
      );
      const lines: unknown[] = sink.lines().map((line): unknown => JSON.parse(line));
      expect(lines).toContainEqual(
        expect.objectContaining({
          correlationId: "dialogue-session",
          voiceDialogueStage,
          voiceCaptureReason,
          ...(voiceCaptureError === undefined ? {} : { voiceCaptureError }),
        }),
      );
      expect(sink.lines().join("")).not.toContain("private microphone detail");
    },
  );

  it("retains the coding run parent on markdown layout evidence", async () => {
    const sink = captureServerLog();
    await handleClientDiagnosticIngest(
      context(
        JSON.stringify({
          message: "layout",
          clientTs: CLIENT_TS,
          kind: "markdown-layout",
          correlationId: "message-1",
          parentCorrelationId: "coding-run-1",
          markdownLayout: { listStart: 5, listIndex: 0, depth: 0 },
        }),
      ),
    );
    expect(sink.events).toContainEqual(
      expect.objectContaining({
        op: "client.markdown.layout",
        correlationId: "message-1",
        parentCorrelationId: "coding-run-1",
      }),
    );
  });

  it("persists a short message identity on the coding run timeline", async () => {
    const sink = captureServerLog();
    await handleClientDiagnosticIngest(
      context(
        JSON.stringify({
          message: "layout",
          clientTs: CLIENT_TS,
          kind: "markdown-layout",
          correlationId: "coding-run-1",
          markdownLayout: { messageId: "msg_1", listStart: 5, listIndex: 0, depth: 0 },
        }),
      ),
    );
    const lines: unknown[] = sink.lines().map((line): unknown => JSON.parse(line));
    expect(lines).toContainEqual(
      expect.objectContaining({
        op: "client.markdown.layout",
        correlationId: "coding-run-1",
        messageId: "msg_1",
      }),
    );
  });

  it("persists a closed module load failure without leaking the failing URL", async () => {
    const sink = captureServerLog();
    await handleClientDiagnosticIngest(
      context(
        JSON.stringify({
          message: "private chunk URL",
          clientTs: CLIENT_TS,
          kind: "other",
          correlationId: "git-sync-load-1",
          moduleLoadFailure: "git-sync",
        }),
      ),
    );
    expect(clientDiagnosticLine(sink)).toMatchObject({
      correlationId: "git-sync-load-1",
      moduleLoadFailure: "git-sync",
    });
    expect(sink.lines().join("")).not.toContain("private chunk URL");
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
});
