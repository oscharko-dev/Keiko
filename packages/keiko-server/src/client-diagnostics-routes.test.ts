import { activityLogLossCounters } from "@oscharko-dev/keiko-contracts/runtime/observability";
import {
  resetServerLogger,
  setSupportIncidentTriggerForTests,
  drainSupportIncidentCandidates,
} from "../../../tests/support/activity-log-test-support.js";
import {
  createBufferedServerLogSink,
  type BufferedServerLogSink,
} from "../../../tests/support/buffered-server-log.js";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  expectActivityLogProof,
  formatActivityLogProofLine,
  readPersistedActivityLog,
} from "../../../tests/support/activity-log-proof.js";
import {
  clientBindingDigest,
  clientDiagnosticNoteDigest,
  handleClientDiagnosticIngest,
  resetClientDiagnosticsIngestStateForTests,
} from "./client-diagnostics-routes.js";
import { UNKNOWN_CORRELATION_ID } from "./correlation.js";
import { createServerLogger, setServerLogger, type ServerLogEvent } from "./observability/index.js";
import type { RouteContext } from "./routes.js";
import {
  redactLogFields,
  formatRegisteredServerLogLine,
  serverLogProcessIdentity,
  createActivityLogSink,
  listSupportIncidents,
} from "@oscharko-dev/keiko-activity-log";
import { analyzeLogText } from "@oscharko-dev/keiko-activity-log/reader";

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

// PR #3625 review: routine git-client settlements (discarded-succeeded, retry-recovered,
// retry-superseded) and the manual retry attempt line, each their own operation.
function gitOperationEvent(
  sink: BufferedServerLogSink,
  op: "client.git-operation.settled" | "client.git-operation.attempted",
): ServerLogEvent {
  const event = sink.events.find((candidate) => candidate.op === op);
  expect(event, `expected exactly one ${op} event`).toBeDefined();
  return event ?? { category: "diagnostic", op };
}

function expectCompleteGitTimeline(events: readonly ServerLogEvent[]): void {
  const identity = serverLogProcessIdentity();
  const lines = events.map((event, index) =>
    formatRegisteredServerLogLine(event, new Date(), { ...identity, seq: index + 1 }),
  );
  const report = analyzeLogText(lines.join(""));
  expect(report.sufficiency).toMatchObject({ status: "complete", reasons: [] });
}

function clientDiagnosticRejectedEvents(sink: BufferedServerLogSink): readonly ServerLogEvent[] {
  return sink.events.filter((event) => event.op === "client.diagnostic.rejected");
}

// PR #3625 review (KeikoSelect.tsx finding): a select menu's Escape dismissal, its own operation.
function selectDismissedEvent(sink: BufferedServerLogSink): ServerLogEvent {
  const event = sink.events.find((candidate) => candidate.op === "client.select.dismissed");
  expect(event, "expected exactly one client.select.dismissed event").toBeDefined();
  return event ?? { category: "diagnostic", op: "client.select.dismissed" };
}

describe("POST /api/diagnostics/client", () => {
  beforeEach(() => {
    resetClientDiagnosticsIngestStateForTests();
  });

  afterEach(() => {
    resetServerLogger();
    resetClientDiagnosticsIngestStateForTests();
  });

  it.each([
    "scope-refusal-restored",
    "scope-refusal-skipped-owner",
    "scope-refusal-skipped-draft",
    "scope-refusal-skipped-unproven",
  ])("records %s as correlated body-free composer evidence", async (composerActivity) => {
    const sink = captureServerLog();
    await handleClientDiagnosticIngest(
      context(
        JSON.stringify({
          message: "PRIVATE_REFUSED_DRAFT_CANARY",
          clientTs: CLIENT_TS,
          composerActivity,
          correlationId: "scope-refusal-correlation",
        }),
      ),
    );
    const event = sink.events.find((entry) => entry.op === "client.composer.activity");
    expect(event).toMatchObject({
      level: "info",
      correlationId: "scope-refusal-correlation",
      extra: { activity: composerActivity, completeness: "complete", loss: "none" },
    });
    expectActivityLogProof(
      "client.composer.activity.line",
      formatActivityLogProofLine(event ?? {}),
    );
    expect(clientDiagnosticEvents(sink)).toHaveLength(0);
    expect(JSON.stringify(sink.events)).not.toContain("PRIVATE_REFUSED_DRAFT_CANARY");
  });

  it("projects routine Composer evidence separately and keeps code failure stages reconstructible", async () => {
    const sink = captureServerLog();
    for (let index = 0; index < 30; index += 1) {
      await handleClientDiagnosticIngest(
        context(
          JSON.stringify({
            message: "PRIVATE_PROMPT_CANARY",
            clientTs: CLIENT_TS,
            composerActivity: "initialized",
            composerFocusIndicator: "keyboard",
          }),
        ),
      );
    }
    await handleClientDiagnosticIngest(
      context(
        JSON.stringify({
          message: "PRIVATE_ERROR_CANARY",
          clientTs: CLIENT_TS,
          kind: "other",
          composerCodeStage: "runtime",
        }),
      ),
    );
    const routine = sink.events.find((event) => event.op === "client.composer.activity");
    expect(routine).toMatchObject({
      level: "info",
      extra: { activity: "initialized", focusIndicator: "keyboard" },
    });
    expect(routine?.errorKind).toBeUndefined();
    expectActivityLogProof(
      "client.composer.activity.line",
      formatActivityLogProofLine(routine ?? {}),
    );
    expect(clientDiagnosticEvents(sink)).toHaveLength(1);
    expect(clientDiagnosticEvents(sink)[0]?.extra?.composerCodeStage).toBe("runtime");
    expectCompleteGitTimeline(sink.events);
    expect(JSON.stringify(sink.events)).not.toContain("PRIVATE_PROMPT_CANARY");
    expect(JSON.stringify(sink.events)).not.toContain("PRIVATE_ERROR_CANARY");
  });
  it.each([
    { composerActivity: "unsafe-content" },
    { composerActivity: "initialized", kind: "other" },
    { composerActivity: "initialized", composerFocusIndicator: "hostile" },
    { composerActivity: "text-copied", composerFocusIndicator: "keyboard" },
    { composerFocusIndicator: "keyboard" },
    { composerCodeStage: "unsafe-content" },
  ])("rejects hostile or failure-masking Composer metadata: %j", async (metadata) => {
    const sink = captureServerLog();
    const result = await handleClientDiagnosticIngest(
      context(JSON.stringify({ message: "canary", clientTs: CLIENT_TS, ...metadata })),
    );
    expect(result.status).toBe(400);
    expect(sink.events.some((event) => event.op === "client.composer.activity")).toBe(false);
  });

  it("keeps routine voice stages out of the failure admission budget", async () => {
    const sink = captureServerLog();
    for (let index = 0; index < 30; index += 1) {
      const result = await handleClientDiagnosticIngest(
        context(
          JSON.stringify({
            message: "PRIVATE_VOICE_CANARY",
            clientTs: CLIENT_TS,
            kind: "voice-dialogue",
            voiceDialogueStage: "turn-submitted",
          }),
        ),
      );
      expect(result.status).toBe(204);
    }
    const failure = await handleClientDiagnosticIngest(
      context(
        JSON.stringify({
          message: "PRIVATE_FAILURE_CANARY",
          clientTs: CLIENT_TS,
          kind: "voice-dialogue",
          voiceDialogueStage: "delivery-failed",
        }),
      ),
    );
    expect(failure.status).toBe(204);
    expect(clientDiagnosticEvents(sink)).toHaveLength(1);
    expect(JSON.stringify(sink.events)).not.toContain("PRIVATE_VOICE_CANARY");
    expect(JSON.stringify(sink.events)).not.toContain("PRIVATE_FAILURE_CANARY");
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
    ["capture-renewal-failed", "replacement-create-failed", "type-error"],
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

  it("writes the preview correlation and closed issue-provenance refusal without content", async () => {
    const sink = captureServerLog();
    await handleClientDiagnosticIngest(
      context(
        JSON.stringify({
          message: "private issue content",
          clientTs: CLIENT_TS,
          correlationId: "ui_issue-preview-0001",
          errorKind: "validation-failed",
          codingIssueOutcome: "multiple-issues",
        }),
      ),
    );
    const lines: unknown[] = sink.lines().map((line): unknown => JSON.parse(line));
    expect(lines).toContainEqual(
      expect.objectContaining({
        op: "client.diagnostic",
        correlationId: "ui_issue-preview-0001",
        errorKind: "validation-failed",
        codingIssueOutcome: "multiple-issues",
      }),
    );
    expect(sink.lines().join("")).not.toContain("private issue content");
    expect(sink.lines().join("")).not.toContain("server-log.write-failed");
  });

  it("logs a client load timeout at error so the registered incident trigger can retain it", async () => {
    const sink = captureServerLog();
    await handleClientDiagnosticIngest(
      context(
        JSON.stringify({
          message: "desktop editor widget chunk: stalled",
          clientTs: CLIENT_TS,
          correlationId: "ui_editor-stall-0001",
          errorKind: "timeout",
        }),
      ),
    );
    expect(clientDiagnosticEvents(sink)).toEqual([
      expect.objectContaining({
        level: "error",
        op: "client.diagnostic",
        correlationId: "ui_editor-stall-0001",
        errorKind: "timeout",
      }),
    ]);
  });

  it("creates a retained local incident for a browser timeout through the production log sink", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "keiko-client-timeout-"));
    setSupportIncidentTriggerForTests(true);
    const sink = createActivityLogSink(stateDir, { level: "debug" });
    setServerLogger(createServerLogger({ sink, level: "debug" }));
    try {
      await handleClientDiagnosticIngest(
        context(
          JSON.stringify({
            message: "desktop editor widget chunk: stalled",
            clientTs: CLIENT_TS,
            correlationId: "ui_retained-timeout-0001",
            errorKind: "timeout",
          }),
        ),
      );
      drainSupportIncidentCandidates();
      const incidents = listSupportIncidents(stateDir);
      expect(incidents).toHaveLength(1);
      expect(incidents[0]?.trigger).toBe("registered-failure");
      expect(incidents[0]?.fingerprint.op).toBe("client.diagnostic");
      expect(incidents[0]?.fingerprint.errorKind).toBe("timeout");
      expect(incidents[0]?.correlation.rootCorrelationId).toBe("ui_retained-timeout-0001");
      expect(incidents[0]?.pin.status).toBe("pinned");
    } finally {
      setSupportIncidentTriggerForTests(undefined);
      resetServerLogger();
      sink.close?.();
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it.each(["voice-dialogue", "markdown-layout"])(
    "keeps history fields off the incompatible %s operation",
    async (kind) => {
      const sink = captureServerLog();
      await handleClientDiagnosticIngest(
        context(
          JSON.stringify({
            message: "specialized event",
            clientTs: CLIENT_TS,
            kind,
            correlationId: "mixed-fields",
            codingIssueOutcome: "multiple-issues",
            ...(kind === "voice-dialogue" ? { voiceDialogueStage: "started" } : {}),
            codingHistoryScope: {
              reason: "activation-cancelled",
              taskId: "task-1",
              requestedScopeId: "scope-1",
              currentScopeId: "scope-2",
            },
          }),
        ),
      );
      const op = kind === "voice-dialogue" ? "voice.dialogue.stage" : "client.markdown.layout";
      const lines = sink
        .lines()
        .map((line): Record<string, unknown> => JSON.parse(line) as Record<string, unknown>);
      expect(lines).toContainEqual(expect.objectContaining({ op, correlationId: "mixed-fields" }));
      expect(lines.some((line) => line.op === "server-log.write-failed")).toBe(false);
      expect(lines.find((line) => line.op === op)).not.toHaveProperty("historyScopeReason");
      expect(lines.find((line) => line.op === op)).not.toHaveProperty("codingIssueOutcome");
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

  it.each(["ChunkLoadError", "TypeError"])(
    "persists module failure class %s and safe causes/frames",
    async (errorClass) => {
      const sink = captureServerLog();
      const frames = ["dist/ui/static/_next/static/chunks/1wntg-7ptuw73.js:12:345"];
      await handleClientDiagnosticIngest(
        context(
          JSON.stringify({
            message: "private URL",
            clientTs: CLIENT_TS,
            kind: "other",
            correlationId: "chunk-failure-id",
            moduleLoadFailure: "git-sync",
            errorEvidence: { errorClass, frames, causeChain: ["TypeError"] },
          }),
        ),
      );
      expect(clientDiagnosticLine(sink)).toMatchObject({
        correlationId: "chunk-failure-id",
        errorClass,
        frames: redactLogFields({ frames })?.frames,
        causeChain: ["TypeError"],
        errorKind: errorClass === "ChunkLoadError" ? "unavailable" : "internal",
      });
      expect(sink.lines().join("")).not.toContain("private URL");
    },
  );

  it("persists a recorder failure with its original cause location", async () => {
    const sink = captureServerLog();
    const frames = ["dist/ui/static/_next/static/chunks/1wntg-7ptuw73.js:30:567"];
    await handleClientDiagnosticIngest(
      context(
        JSON.stringify({
          message: "private device",
          clientTs: CLIENT_TS,
          kind: "voice-dialogue",
          correlationId: "recorder-session",
          voiceDialogueStage: "capture-renewal-failed",
          voiceCaptureReason: "replacement-create-failed",
          voiceCaptureError: "type-error",
          errorEvidence: {
            errorClass: "DictationRecorderError",
            frames,
            causeChain: ["TypeError"],
          },
        }),
      ),
    );
    expect(clientDiagnosticLine(sink)).toMatchObject({
      correlationId: "recorder-session",
      voiceCaptureReason: "replacement-create-failed",
      frames: redactLogFields({ frames })?.frames,
      causeChain: ["TypeError"],
    });
    expect(sink.lines().join("")).not.toContain("private device");
  });

  it("does not persist a secret disguised as a production chunk basename", async () => {
    const sink = captureServerLog();
    const basename = ["customer", "apikey", "1234"].join("");
    await handleClientDiagnosticIngest(
      context(
        JSON.stringify({
          message: "browser failure",
          clientTs: CLIENT_TS,
          errorEvidence: {
            errorClass: "TypeError",
            frames: [`dist/ui/static/_next/static/chunks/${basename}.js:1:2`],
            causeChain: [],
          },
        }),
      ),
    );
    expect(clientDiagnosticLine(sink)).toHaveProperty("frames");
    expect(sink.lines().join("")).not.toContain(basename);
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

  it.each(["workspace-a", `local:${"a".repeat(64)}`])(
    "preserves the validated workspace trust identity %s on the originating timeline",
    async (workspaceId) => {
      const sink = captureServerLog();
      const body = JSON.stringify({
        message: "coding workbench repository trust bound",
        clientTs: CLIENT_TS,
        correlationId: "originating-run-correlation",
        workspaceTrustBinding: {
          repositoryId: "repository-a",
          workspaceId,
        },
      });

      expect(await handleClientDiagnosticIngest(context(body))).toEqual({
        status: 204,
        body: null,
      });
      expect(clientDiagnosticLine(sink)).toMatchObject({
        op: "client.diagnostic",
        correlationId: "originating-run-correlation",
        repositoryId: "repository-a",
        workspaceId,
      });
    },
  );

  // PR #3625 review: routine settlements — an add-repository result discarded after it actually
  // succeeded, a manual retry that recovered or was superseded — are routed to their own
  // lifecycle-appropriate `client.git-operation.settled` at info with no `errorKind`, never the
  // failure-shaped `client.diagnostic` (KEIKO-3557's stage fix, applied to this one outcome).
  it("persists a discarded-succeeded git-client operation as client.git-operation.settled", async () => {
    const sink = captureServerLog();
    const body = JSON.stringify({
      message: "git-client: add-repository discarded: repository-clone succeeded",
      clientTs: CLIENT_TS,
      correlationId: "ui_repo-discarded-0001",
      kind: "other",
      gitClientOperation: { operation: "repository-clone", outcome: "discarded-succeeded" },
    });

    expect(await handleClientDiagnosticIngest(context(body))).toEqual({ status: 204, body: null });
    expect(clientDiagnosticEvents(sink)).toHaveLength(0);
    const event = gitOperationEvent(sink, "client.git-operation.settled");
    expect(event.level).toBe("info");
    expect(event.errorKind).toBeUndefined();
    const record = expectActivityLogProof(
      "client.git-operation.settled.line",
      formatActivityLogProofLine(event),
    );
    expect(record).toMatchObject({
      operation: "repository-clone",
      outcome: "discarded-succeeded",
      completeness: "complete",
      loss: "none",
    });
  });

  it.each([
    ["repository-register", "succeeded"],
    ["repository-clone", "succeeded"],
    ["repository-clone", "discarded-succeeded"],
    ["repository-register", "discarded-succeeded"],
    ["repository-register", "failed"],
    ["repository-clone", "failed"],
    ["repository-register", "discarded-failed"],
    ["repository-clone", "discarded-failed"],
  ])("reconstructs the %s lifecycle when %s", async (operation, settlement) => {
    const sink = captureServerLog();
    for (const outcome of ["started", settlement]) {
      const body = JSON.stringify({
        message: "git-client: add-repository lifecycle",
        clientTs: CLIENT_TS,
        kind: "other",
        correlationId: "ui_repository-0001",
        gitClientOperation: { operation, outcome },
        ...(outcome.endsWith("failed") ? { errorKind: "internal" } : {}),
      });
      expect(await handleClientDiagnosticIngest(context(body, `ingest-${outcome}`))).toEqual({
        status: 204,
        body: null,
      });
    }
    const started = gitOperationEvent(sink, "client.git-operation.attempted");
    const settled = gitOperationEvent(sink, "client.git-operation.settled");
    expect(started).toMatchObject({
      correlationId: "ui_repository-0001",
      level: "info",
      extra: { operation },
    });
    expect(settled).toMatchObject({
      correlationId: "ui_repository-0001",
      level: "info",
      extra: { operation, outcome: settlement },
    });
    expectActivityLogProof(
      "client.git-operation.attempted.line",
      formatActivityLogProofLine(started),
    );
    expectActivityLogProof(
      "client.git-operation.settled.line",
      formatActivityLogProofLine(settled),
    );
    expectCompleteGitTimeline([started, settled]);
    if (settlement.endsWith("succeeded")) expect(clientDiagnosticEvents(sink)).toHaveLength(0);
    else
      expect(clientDiagnosticLine(sink)).toMatchObject({
        correlationId: "ui_repository-0001",
        gitClientOperation: operation,
        gitClientOperationOutcome: settlement,
        errorKind: "internal",
      });
  });

  describe.each(["repository-clone", "repository-register"])(
    "%s join-key rejection",
    (operation) => {
      it.each(["started", "succeeded", "failed"])(
        "rejects malformed %s IDs without unjoinable events",
        async (outcome) => {
          const sink = captureServerLog();
          const body = JSON.stringify({
            message: "git-client: add-repository lifecycle",
            clientTs: CLIENT_TS,
            correlationId: "x",
            gitClientOperation: { operation, outcome },
          });
          expect((await handleClientDiagnosticIngest(context(body))).status).toBe(400);
          expect(
            sink.events.filter((event) => event.op.startsWith("client.git-operation.")),
          ).toEqual([]);
          expect(clientDiagnosticRejectedEvents(sink)).toEqual([
            expect.objectContaining({
              correlationId: CORRELATION_ID,
              extra: expect.objectContaining({ rejection: "invalid-shape" }) as unknown,
            }),
          ]);
        },
      );
    },
  );

  it.each(["discarded-succeeded", "discarded-failed"])(
    "refuses an uncorrelated %s settlement after a correlated start",
    async (outcome) => {
      const sink = captureServerLog();
      const body = { message: "git-client lifecycle", clientTs: CLIENT_TS };
      expect(
        (
          await handleClientDiagnosticIngest(
            context(
              JSON.stringify({
                ...body,
                correlationId: "ui_repo-0001",
                gitClientOperation: { operation: "repository-clone", outcome: "started" },
              }),
            ),
          )
        ).status,
      ).toBe(204);
      expect(
        (
          await handleClientDiagnosticIngest(
            context(
              JSON.stringify({
                ...body,
                gitClientOperation: { operation: "repository-clone", outcome },
              }),
            ),
          )
        ).status,
      ).toBe(400);
      expect(sink.events.filter((event) => event.op === "client.git-operation.settled")).toEqual(
        [],
      );
      expect(clientDiagnosticRejectedEvents(sink)).toHaveLength(1);
    },
  );

  it.each([
    "started",
    "succeeded",
    "failed",
    "discarded-succeeded",
    "discarded-failed",
    "select",
    "markdown",
    "voice",
    "failure",
  ])("records client delivery loss exactly once for %s reports", async (outcome) => {
    captureServerLog();
    const before = activityLogLossCounters()["client-post-throttled"];
    const metadata =
      outcome === "select"
        ? { selectDismissal: { reason: "escape", focus: "trigger" } }
        : outcome === "markdown"
          ? { kind: "markdown-layout" }
          : outcome === "voice"
            ? { kind: "voice-dialogue", voiceDialogueStage: "started" }
            : outcome === "failure"
              ? {}
              : { gitClientOperation: { operation: "repository-clone", outcome } };
    const body = JSON.stringify({
      message: "client report",
      clientTs: CLIENT_TS,
      correlationId: "ui_repo-0001",
      loss: { postsThrottled: 5 },
      ...metadata,
    });
    expect((await handleClientDiagnosticIngest(context(body))).status).toBe(204);
    expect(activityLogLossCounters()["client-post-throttled"] - before).toBe(5);
  });

  // Retain the loss-preservation pin across server throttling: a 429 leaves counts with the
  // browser until a later report is admitted, rather than acknowledging unbounded input.
  it.each(["routine", "failure"])(
    "preserves refused loss for later %s admission",
    async (budget) => {
      const sink = captureServerLog();
      const before = activityLogLossCounters()["client-post-throttled"];
      const lossBefore = activityLogLossCounters();
      const now = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
      const metadata =
        budget === "routine" ? { selectDismissal: { reason: "escape", focus: "trigger" } } : {};
      const report = { message: "report", clientTs: CLIENT_TS, ...metadata };
      try {
        for (let index = 0; index < 60; index += 1) {
          expect((await handleClientDiagnosticIngest(context(JSON.stringify(report)))).status).toBe(
            204,
          );
        }
        const refused = JSON.stringify({ ...report, loss: { postsThrottled: 1_000_000 } });
        for (let index = 0; index < 3; index += 1) {
          expect((await handleClientDiagnosticIngest(context(refused))).status).toBe(429);
        }
        expect(activityLogLossCounters()["client-post-throttled"]).toBe(before);
        expect(
          sink.events.filter((event) => event.op === "client.diagnostic.rate-limited"),
        ).toHaveLength(1);
        now.mockReturnValue(1_700_000_060_001);
        const retried = JSON.stringify({ ...report, loss: { postsThrottled: 5 } });
        expect((await handleClientDiagnosticIngest(context(retried))).status).toBe(204);
        expect(activityLogLossCounters()["client-post-throttled"] - before).toBe(5);
        const lossAfter = activityLogLossCounters();
        expect(lossAfter["client-rate-suppressed"] - lossBefore["client-rate-suppressed"]).toBe(3);
        expect(lossAfter["client-post-failed"]).toBe(lossBefore["client-post-failed"]);
        // Three refused reports plus five previously lost reports, with no duplicate category.
        expect(
          Object.values(lossAfter).reduce((sum, count) => sum + count, 0) -
            Object.values(lossBefore).reduce((sum, count) => sum + count, 0),
        ).toBe(8);
      } finally {
        now.mockRestore();
      }
    },
  );

  it("records a superseded checkout selection as correlated routine evidence", async () => {
    const sink = captureServerLog();
    const body = JSON.stringify({
      message: "[keiko] coding workbench checkout selection superseded",
      clientTs: CLIENT_TS,
      correlationId: "checkout-attempt-123",
      kind: "other",
      gitClientOperation: { operation: "checkout-selection", outcome: "discarded-succeeded" },
    });

    expect(await handleClientDiagnosticIngest(context(body))).toEqual({ status: 204, body: null });
    expect(clientDiagnosticEvents(sink)).toHaveLength(0);
    const event = gitOperationEvent(sink, "client.git-operation.settled");
    expect(event).toMatchObject({
      level: "info",
      correlationId: "checkout-attempt-123",
      extra: { operation: "checkout-selection", outcome: "discarded-succeeded" },
    });
    expectActivityLogProof("client.git-operation.settled.line", formatActivityLogProofLine(event));
  });

  // A manual retry that recovers carries the SAME id its attempt line minted, so the two join on
  // one timeline (PR #3625 review).
  it("persists a recovered manual retry as client.git-operation.settled with its correlation id", async () => {
    const sink = captureServerLog();
    const body = JSON.stringify({
      message: "git-client: manual status-read retry-recovered",
      clientTs: CLIENT_TS,
      correlationId: "ui_git-retry-0001",
      kind: "other",
      gitClientOperation: { operation: "status-read", outcome: "retry-recovered" },
    });

    expect(await handleClientDiagnosticIngest(context(body))).toEqual({ status: 204, body: null });
    const event = gitOperationEvent(sink, "client.git-operation.settled");
    const record = expectActivityLogProof(
      "client.git-operation.settled.line",
      formatActivityLogProofLine(event),
    );
    expect(record).toMatchObject({
      correlationId: "ui_git-retry-0001",
      operation: "status-read",
      outcome: "retry-recovered",
    });
  });

  // A manual retry superseded by a newer automatic read before it settled is discarded evidence,
  // never a failure of the read itself — routine, and joinable to its attempt (PR #3625 review).
  it("persists a superseded manual retry as client.git-operation.settled", async () => {
    const sink = captureServerLog();
    const body = JSON.stringify({
      message: "git-client: manual branches-read retry-superseded",
      clientTs: CLIENT_TS,
      correlationId: "ui_git-retry-0002",
      kind: "other",
      gitClientOperation: { operation: "branches-read", outcome: "retry-superseded" },
    });

    expect(await handleClientDiagnosticIngest(context(body))).toEqual({ status: 204, body: null });
    const event = gitOperationEvent(sink, "client.git-operation.settled");
    const record = expectActivityLogProof(
      "client.git-operation.settled.line",
      formatActivityLogProofLine(event),
    );
    expect(record).toMatchObject({
      correlationId: "ui_git-retry-0002",
      operation: "branches-read",
      outcome: "retry-superseded",
    });
  });

  // The attempt line is sent the moment Retry is clicked, minting its own correlation id — before
  // any settlement exists (PR #3625 review).
  it("persists a manual retry attempt as client.git-operation.attempted", async () => {
    const sink = captureServerLog();
    const body = JSON.stringify({
      kind: "git-retry-attempt",
      operation: "summary-read",
      correlationId: "ui_git-retry-0003",
    });

    expect(await handleClientDiagnosticIngest(context(body))).toEqual({ status: 204, body: null });
    const event = gitOperationEvent(sink, "client.git-operation.attempted");
    expect(event.level).toBe("info");
    const record = expectActivityLogProof(
      "client.git-operation.attempted.line",
      formatActivityLogProofLine(event),
    );
    expect(record).toMatchObject({
      correlationId: "ui_git-retry-0003",
      operation: "summary-read",
      completeness: "complete",
      loss: "none",
    });
  });

  // A resolved (HTTP 200) unavailable response's closed reason travels only alongside retry-failed,
  // and only reaches `client.diagnostic` — never the routine `client.git-operation.settled` above
  // (PR #3625 review, GitClientWindow.tsx finding).
  it("preserves the closed unavailable reason on a resolved retry-failed settlement", async () => {
    const sink = captureServerLog();
    const body = JSON.stringify({
      message: "git-client: manual status-read retry-failed (unavailable)",
      clientTs: CLIENT_TS,
      correlationId: "ui_git-retry-0004",
      errorKind: "unavailable",
      kind: "other",
      gitClientOperation: {
        operation: "status-read",
        outcome: "retry-failed",
        reason: "git-error",
      },
    });

    expect(await handleClientDiagnosticIngest(context(body))).toEqual({ status: 204, body: null });
    expect(clientDiagnosticLine(sink)).toMatchObject({
      op: "client.diagnostic",
      correlationId: "ui_git-retry-0004",
      errorKind: "unavailable",
      gitClientOperation: "status-read",
      gitClientOperationOutcome: "retry-failed",
      gitClientOperationReason: "git-error",
    });
  });

  // The contracts guard already refuses a reason on any other outcome (diagnostics.test.ts); this
  // pins the same fail-closed behaviour through the real route, never silently dropping the reason.
  it("rejects a reason attached to a recovered retry, fail-closed", async () => {
    const sink = captureServerLog();
    const body = JSON.stringify({
      message: "git-client: manual status-read retry-recovered",
      clientTs: CLIENT_TS,
      gitClientOperation: {
        operation: "status-read",
        outcome: "retry-recovered",
        reason: "git-error",
      },
    });

    expect((await handleClientDiagnosticIngest(context(body))).status).toBe(400);
    expect(clientDiagnosticEvents(sink)).toHaveLength(0);
    expect(sink.events.some((event) => event.op.startsWith("client.git-operation."))).toBe(false);
  });

  // The failed counterpart: before this fix a discarded failure returned silently client-side and
  // reached the server not at all — this line is the regression pin for that gap.
  it("preserves a discarded-failed git-client operation settlement with its correlation id and error kind", async () => {
    const sink = captureServerLog();
    const body = JSON.stringify({
      message: "git-client: add-repository discarded: repository-register failed",
      clientTs: CLIENT_TS,
      correlationId: "corr-register-discard-1",
      errorKind: "internal",
      kind: "other",
      gitClientOperation: { operation: "repository-register", outcome: "discarded-failed" },
    });

    expect(await handleClientDiagnosticIngest(context(body))).toEqual({ status: 204, body: null });
    expect(clientDiagnosticLine(sink)).toMatchObject({
      op: "client.diagnostic",
      correlationId: "corr-register-discard-1",
      errorKind: "internal",
      gitClientOperation: "repository-register",
      gitClientOperationOutcome: "discarded-failed",
    });
  });

  it("rejects a git-client operation whose outcome belongs to the other family, fail-closed", async () => {
    const sink = captureServerLog();
    const body = JSON.stringify({
      message: "git-client: add-repository discarded",
      clientTs: CLIENT_TS,
      correlationId: "ui_repo-0001",
      gitClientOperation: { operation: "repository-clone", outcome: "retry-recovered" },
    });

    expect((await handleClientDiagnosticIngest(context(body))).status).toBe(400);
    expect(clientDiagnosticEvents(sink)).toHaveLength(0);
  });

  // A message report is a failure budget by default, except when its `gitClientOperation.outcome`
  // is not a failure — that spends the routine budget instead, exactly like a binding that resolved
  // or a session repair that recovered, so a burst of these can never starve a genuine failure
  // report's own budget (mirrors the session-repair burst test below).
  it("keeps the failure budget available after a burst of discarded-succeeded settlements", async () => {
    const sink = captureServerLog();
    const settled = JSON.stringify({
      message: "git-client: add-repository discarded: repository-clone succeeded",
      clientTs: CLIENT_TS,
      correlationId: "ui_repo-discarded-0001",
      gitClientOperation: { operation: "repository-clone", outcome: "discarded-succeeded" },
    });
    for (let index = 1; index <= 61; index += 1) {
      await handleClientDiagnosticIngest(context(settled));
    }
    expect(sink.events.some((event) => event.op === "client.diagnostic.rejected")).toBe(false);

    const failure = JSON.stringify({ message: "boundary", clientTs: CLIENT_TS, kind: "boundary" });
    expect((await handleClientDiagnosticIngest(context(failure))).status).toBe(204);
    expect(
      clientDiagnosticEvents(sink).some((event) => event.extra?.clientKind === "boundary"),
    ).toBe(true);
    // The routine burst itself stays bounded: its overflow is one routine rate-limit notice, and
    // the failure budget was never touched.
    const notices = sink.events.filter((event) => event.op === "client.diagnostic.rate-limited");
    expect(notices.map((event) => event.extra?.budget)).toEqual(["routine"]);
  });

  // PR #3625 review (KeikoSelect.tsx finding): an open menu consumes Escape wherever focus sits —
  // the trigger, the search box, or an option — instead of leaving it to the workspace's own Escape
  // shortcut. This is the only line that shows which surface an operator's Escape actually
  // dismissed, at info with no errorKind, never the failure-shaped client.diagnostic.
  it("persists a select dismissal as client.select.dismissed, at info, with no errorKind", async () => {
    const sink = captureServerLog();
    const body = JSON.stringify({
      message: "[keiko] select menu dismissed by Escape (focus=trigger)",
      clientTs: CLIENT_TS,
      correlationId: "ui_select-dismiss-0001",
      kind: "other",
      selectDismissal: { reason: "escape", focus: "trigger" },
    });

    expect(await handleClientDiagnosticIngest(context(body))).toEqual({ status: 204, body: null });
    expect(clientDiagnosticEvents(sink)).toHaveLength(0);
    const event = selectDismissedEvent(sink);
    expect(event.level).toBe("info");
    expect(event.errorKind).toBeUndefined();
    const record = expectActivityLogProof(
      "client.select.dismissed.line",
      formatActivityLogProofLine(event),
    );
    expect(record).toMatchObject({
      correlationId: "ui_select-dismiss-0001",
      reason: "escape",
      focus: "trigger",
      completeness: "complete",
      loss: "none",
    });
  });

  // PR #3678 review: the catalog's availability counts used to ride only the message, which ingest
  // reduces to a digest. They are now their own counted line, at warn, joined to the report.
  it("persists the knowledge catalog counts as client.knowledge-catalog.unavailable", async () => {
    const sink = captureServerLog();
    const knowledgeCatalog = {
      podCount: 1,
      readyPodCount: 0,
      setCount: 0,
      boundCount: 1,
      missingCount: 0,
      notReadyCount: 1,
    };
    const body = JSON.stringify({
      message: "Keiko knowledge catalog offers no usable pod.",
      clientTs: CLIENT_TS,
      correlationId: "ui_catalog-unavailable-0001",
      knowledgeCatalog,
    });

    expect(await handleClientDiagnosticIngest(context(body))).toEqual({ status: 204, body: null });
    expect(clientDiagnosticEvents(sink)).toHaveLength(0);
    const event = sink.events.find(
      (candidate) => candidate.op === "client.knowledge-catalog.unavailable",
    );
    expect(event?.level).toBe("warn");
    const record = expectActivityLogProof(
      "client.knowledge-catalog.unavailable.line",
      formatActivityLogProofLine(event ?? {}),
    );
    expect(record).toMatchObject({
      correlationId: "ui_catalog-unavailable-0001",
      ...knowledgeCatalog,
      completeness: "complete",
      loss: "none",
    });
  });

  // PR #3678 review: the copy button's changed transformation must be reconstructable: one line per
  // copy with its outcome and marker counts, and a failed copy with its error kind and frames.
  it("persists a chat answer copy and its failure as client.answer.copied", async () => {
    const sink = captureServerLog();
    const answerCopy = { grounded: true, strippedGroupCount: 2, keptGroupCount: 1 };
    const copied = JSON.stringify({
      message: "Keiko chat answer copied.",
      clientTs: CLIENT_TS,
      correlationId: "ui_answer-copy-0001",
      answerCopy: { outcome: "copied", ...answerCopy },
    });
    const failed = JSON.stringify({
      message: "Keiko chat answer copy failed.",
      clientTs: CLIENT_TS,
      correlationId: "ui_answer-copy-0002",
      errorKind: "unavailable",
      errorEvidence: { errorClass: "Error", frames: [], causeChain: ["Error"] },
      answerCopy: { outcome: "failed", ...answerCopy },
    });

    expect(await handleClientDiagnosticIngest(context(copied))).toEqual({
      status: 204,
      body: null,
    });
    expect(await handleClientDiagnosticIngest(context(failed))).toEqual({
      status: 204,
      body: null,
    });
    expect(clientDiagnosticEvents(sink)).toHaveLength(0);
    const lines = sink.events.filter((candidate) => candidate.op === "client.answer.copied");
    expect(lines.map((line) => line.level)).toEqual(["info", "warn"]);
    const record = expectActivityLogProof(
      "client.answer.copied.line",
      formatActivityLogProofLine(lines[0] ?? {}),
    );
    expect(record).toMatchObject({
      correlationId: "ui_answer-copy-0001",
      outcome: "copied",
      ...answerCopy,
    });
    expect(lines[1]).toMatchObject({
      correlationId: "ui_answer-copy-0002",
      errorKind: "unavailable",
      extra: { outcome: "failed", errorClass: "Error", causeChain: ["Error"] },
    });
  });

  it.each([
    "restored",
    "owned-elsewhere",
    "released",
    "blocked-ambiguous",
    "fingerprint-absent",
    "conflict-retried",
    "ack-missing",
    "acknowledged",
    "ack-invalidated",
    "automatic-suppressed",
    "timeout-blocked",
    "timeout-recovered",
    "timeout-rejected",
    "request-superseded",
  ])(
    "persists the closed Files ownership decision %s as routine causal evidence",
    async (decision) => {
      const sink = captureServerLog();
      const filesScopeDecision = {
        decision,
        sourceCount: 1,
        candidateCount: 2,
        bindingFingerprint: "a".repeat(64),
      };
      expect(
        await handleClientDiagnosticIngest(
          context(
            JSON.stringify({
              message: "Keiko Files scope ownership decision.",
              clientTs: CLIENT_TS,
              correlationId: "ui_scope-decision-0001",
              filesScopeDecision,
            }),
          ),
        ),
      ).toEqual({ status: 204, body: null });
      expect(clientDiagnosticEvents(sink)).toHaveLength(0);
      const event = sink.events.find((candidate) => candidate.op === "client.files-scope.decision");
      if (event === undefined) throw new TypeError("Missing scope ownership decision evidence");
      const record = expectActivityLogProof(
        "client.files-scope.decision.line",
        formatActivityLogProofLine(event),
      );
      expect(record).toMatchObject({
        level: "info",
        correlationId: "ui_scope-decision-0001",
        ...filesScopeDecision,
        completeness: "complete",
        loss: "none",
      });
      expect(record).not.toHaveProperty("errorKind");
      expect(record).not.toHaveProperty("messageDigest");
    },
  );
  it.each(["local-knowledge", "git-change"])(
    "persists the closed %s grounding queue surface under the original correlation",
    async (mutationSurface) => {
      const sink = captureServerLog();
      const filesScopeDecision = { decision: "timeout-rejected", mutationSurface };
      expect(
        await handleClientDiagnosticIngest(
          context(
            JSON.stringify({
              message: "Keiko grounding mutation queue decision.",
              clientTs: CLIENT_TS,
              correlationId: "ui_queue-decision-0001",
              filesScopeDecision,
            }),
          ),
        ),
      ).toEqual({ status: 204, body: null });
      const event = sink.events.find((record) => record.op === "client.files-scope.decision");
      expect(
        expectActivityLogProof(
          "client.files-scope.decision.line",
          formatActivityLogProofLine(event ?? {}),
        ),
      ).toMatchObject({
        ...filesScopeDecision,
        correlationId: "ui_queue-decision-0001",
        completeness: "complete",
        loss: "none",
      });
      expect(event?.errorKind).toBeUndefined();
      expect(clientDiagnosticEvents(sink)).toHaveLength(0);
    },
  );
  it("keeps browser-declared artifact loss separate from loss of the routine diagnostic", async () => {
    const sink = captureServerLog();
    await handleClientDiagnosticIngest(
      context(
        JSON.stringify({
          message: "Keiko support report prepared locally.",
          clientTs: CLIENT_TS,
          correlationId: "ui_server-preparation-123",
          supportReportPreparation: {
            reportBytes: 1024,
            evidenceScope: "server",
            completeness: "partial",
            loss: "event-dropped",
          },
        }),
      ),
    );
    const event = sink.events.find((item) => item.op === "client.support-report.prepared");
    expect(event?.extra).toMatchObject({
      completeness: "complete",
      loss: "none",
      reportCompleteness: "partial",
      reportLoss: "event-dropped",
    });
    expect(analyzeLogText(formatActivityLogProofLine(event ?? {})).sufficiency.status).toBe(
      "complete",
    );
  });
  it("persists failed local preparation as routine causal evidence without inventing an artifact", async () => {
    const sink = captureServerLog();
    expect(
      await handleClientDiagnosticIngest(
        context(
          JSON.stringify({
            message: "Keiko local support report preparation failed.",
            clientTs: CLIENT_TS,
            correlationId: "ui_support-local-failed-0001",
            supportReportPreparation: {
              outcome: "failed",
              errorKind: "unavailable",
              durationMs: 12,
            },
          }),
        ),
      ),
    ).toEqual({ status: 204, body: null });
    expect(clientDiagnosticEvents(sink)).toHaveLength(0);
    expect(sink.events.some((event) => event.op === "client.support-report.prepared")).toBe(false);
    const event = sink.events.find(
      (item) => item.op === "client.support-report.preparation-failed",
    );
    const record = expectActivityLogProof(
      "client.support-report.preparation-failed.line",
      formatActivityLogProofLine(event ?? {}),
    );
    expect(record).toMatchObject({
      level: "info",
      correlationId: "ui_support-local-failed-0001",
      preparationErrorKind: "unavailable",
      durationMs: 12,
      completeness: "complete",
      loss: "none",
    });
    expect(record).not.toHaveProperty("reportBytes");
    expect(record).not.toHaveProperty("errorKind");
    expect(record).not.toHaveProperty("messageDigest");
    expect(analyzeLogText(formatActivityLogProofLine(event ?? {})).sufficiency.status).toBe(
      "complete",
    );
  });

  it.each(["service-unavailable", "client-only-selected", "correlation-unavailable"] as const)(
    "persists local report preparation as routine evidence without inventing a failure: %s",
    async (availabilityReason) => {
      const sink = captureServerLog();
      const supportReportPreparation = {
        reportBytes: 1024,
        evidenceScope: "client-only",
        completeness: "complete",
        loss: "none",
        availabilityReason,
      };
      expect(
        await handleClientDiagnosticIngest(
          context(
            JSON.stringify({
              message: "Keiko support report prepared locally.",
              clientTs: CLIENT_TS,
              correlationId: "ui_support-preparation-0001",
              supportReportPreparation,
            }),
          ),
        ),
      ).toEqual({ status: 204, body: null });
      expect(clientDiagnosticEvents(sink)).toHaveLength(0);
      const event = sink.events.find(
        (candidate) => candidate.op === "client.support-report.prepared",
      );
      const record = expectActivityLogProof(
        "client.support-report.prepared.line",
        formatActivityLogProofLine(event ?? {}),
      );
      expect(record).toMatchObject({
        level: "info",
        correlationId: "ui_support-preparation-0001",
        ...supportReportPreparation,
      });
      expect(record).not.toHaveProperty("errorKind");
      expect(record).not.toHaveProperty("messageDigest");
    },
  );

  it("persists browser report initiation without claiming an OS save or creating a failure incident", async () => {
    const sink = captureServerLog();
    const body = JSON.stringify({
      message: "Keiko support download initiated.",
      clientTs: CLIENT_TS,
      correlationId: "ui_support-download-0001",
      supportReportDelivery: "manual",
    });
    expect(await handleClientDiagnosticIngest(context(body))).toEqual({ status: 204, body: null });
    expect(clientDiagnosticEvents(sink)).toHaveLength(0);
    const event = sink.events.find(
      (candidate) => candidate.op === "client.support-report.download-started",
    );
    const record = expectActivityLogProof(
      "client.support-report.download-started.line",
      formatActivityLogProofLine(event ?? {}),
    );
    expect(record).toMatchObject({
      level: "info",
      correlationId: "ui_support-download-0001",
      deliveryMode: "manual",
      completeness: "complete",
      loss: "none",
    });
    expect(record).not.toHaveProperty("errorKind");
    expect(record).not.toHaveProperty("reportJson");
    expect(analyzeLogText(formatActivityLogProofLine(event ?? {})).sufficiency.status).toBe(
      "complete",
    );
  });

  // PR #3678 review: the read-aloud preparation keeps a bracketed path and drops grounded markers;
  // its counts land on their own line under the synthesis request's correlation.
  it("persists a read-aloud preparation as client.answer.speech-prepared", async () => {
    const sink = captureServerLog();
    const answerSpeech = { grounded: true, strippedGroupCount: 1, keptGroupCount: 0 };
    const body = JSON.stringify({
      message: "Keiko chat answer prepared for speech.",
      clientTs: CLIENT_TS,
      correlationId: "ui_answer-speech-0001",
      answerSpeech,
    });

    expect(await handleClientDiagnosticIngest(context(body))).toEqual({ status: 204, body: null });
    expect(clientDiagnosticEvents(sink)).toHaveLength(0);
    const event = sink.events.find((candidate) => candidate.op === "client.answer.speech-prepared");
    expect(event?.level).toBe("info");
    const record = expectActivityLogProof(
      "client.answer.speech-prepared.line",
      formatActivityLogProofLine(event ?? {}),
    );
    expect(record).toMatchObject({
      correlationId: "ui_answer-speech-0001",
      ...answerSpeech,
      completeness: "complete",
      loss: "none",
    });
  });

  it("rejects a read-aloud report with an unknown field or an unbounded count", async () => {
    for (const answerSpeech of [
      { grounded: true, strippedGroupCount: 1, keptGroupCount: 0, text: "spoken" },
      { grounded: true, strippedGroupCount: -1, keptGroupCount: 0 },
    ]) {
      const body = JSON.stringify({
        message: "Keiko chat answer prepared for speech.",
        clientTs: CLIENT_TS,
        answerSpeech,
      });
      const result = await handleClientDiagnosticIngest(context(body));
      expect(result.status).toBe(400);
    }
  });

  it("persists every closed focus location on its own client.select.dismissed line", async () => {
    for (const focus of ["trigger", "search", "option", "menu"] as const) {
      const sink = captureServerLog();
      const body = JSON.stringify({
        message: `[keiko] select menu dismissed by Escape (focus=${focus})`,
        clientTs: CLIENT_TS,
        kind: "other",
        selectDismissal: { reason: "escape", focus },
      });

      expect(await handleClientDiagnosticIngest(context(body))).toEqual({
        status: 204,
        body: null,
      });
      expect(selectDismissedEvent(sink).extra).toMatchObject({ reason: "escape", focus });
      const record = expectActivityLogProof(
        "client.select.dismissed.line",
        formatActivityLogProofLine(selectDismissedEvent(sink)),
      );
      expect(record).toMatchObject({ reason: "escape", focus });
    }
  });

  // A select dismissal has no failure variant at all — Escape either closes an open menu or the
  // report is never sent — so it always spends the routine budget, exactly like a burst of
  // discarded-succeeded git-client settlements above, and can never starve a genuine failure report.
  it("keeps the failure budget available after a burst of select dismissals", async () => {
    const sink = captureServerLog();
    const dismissed = JSON.stringify({
      message: "[keiko] select menu dismissed by Escape (focus=option)",
      clientTs: CLIENT_TS,
      kind: "other",
      selectDismissal: { reason: "escape", focus: "option" },
    });
    for (let index = 1; index <= 61; index += 1) {
      await handleClientDiagnosticIngest(context(dismissed));
    }
    expect(sink.events.some((event) => event.op === "client.diagnostic.rejected")).toBe(false);

    const failure = JSON.stringify({ message: "boundary", clientTs: CLIENT_TS, kind: "boundary" });
    expect((await handleClientDiagnosticIngest(context(failure))).status).toBe(204);
    expect(
      clientDiagnosticEvents(sink).some((event) => event.extra?.clientKind === "boundary"),
    ).toBe(true);
    // The routine burst itself stays bounded: its overflow is one routine rate-limit notice, and
    // the failure budget was never touched.
    const notices = sink.events.filter((event) => event.op === "client.diagnostic.rate-limited");
    expect(notices.map((event) => event.extra?.budget)).toEqual(["routine"]);
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
      op:
        | "client.binding.candidates-offered"
        | "client.binding.choice-kept"
        | "client.binding.choice-withdrawn"
        | "client.binding.resolved"
        | "client.binding.target-missing",
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

    // #3557 review: a window without a fingerprint states what it offered, zero included, as a state
    // on the timeline of the list load that decided the offer.
    it("logs an offer at info under the list load that decided it, with its count", async () => {
      const sink = captureServerLog();
      const body = JSON.stringify({
        kind: "binding",
        surface: "chat-window",
        windowRef: "chat-mfr3k2x1-6",
        outcome: "candidates-offered",
        referenceShape: "redacted",
        heuristicFlagged: false,
        candidateCount: 0,
        disambiguatedCount: 0,
        correlationId: "ui_chat-list-load-0006",
      });

      expect((await handleClientDiagnosticIngest(context(body))).status).toBe(204);

      const events = bindingEvents(sink, "client.binding.candidates-offered");
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        level: "info",
        correlationId: "ui_chat-list-load-0006",
        extra: {
          referenceShape: "redacted",
          candidateCount: 0,
          disambiguatedCount: 0,
          completeness: "complete",
        },
      });
      expect(events[0]?.errorKind).toBeUndefined();
      expect(bindingEvents(sink, "client.binding.target-missing")).toEqual([]);
    });

    // #3557 review: a person's decision about a chosen chat is a state at info on the binding's
    // timeline, and never logs without the chat it concerns.
    it.each([
      ["choice-kept", "client.binding.choice-kept"],
      ["choice-withdrawn", "client.binding.choice-withdrawn"],
    ] as const)("logs a %s decision as %s at info", async (outcome, op) => {
      const sink = captureServerLog();
      const decision = {
        kind: "binding",
        surface: "chat-window",
        windowRef: "chat-mfr3k2x1-8",
        outcome,
        referenceShape: "user-selected",
        heuristicFlagged: true,
        correlationId: "ui_chat-list-load-0008",
      };

      expect((await handleClientDiagnosticIngest(context(JSON.stringify(decision)))).status).toBe(
        400,
      );
      expect(bindingEvents(sink, op)).toEqual([]);
      const body = JSON.stringify({ ...decision, targetFingerprint: "a1".repeat(32) });
      expect((await handleClientDiagnosticIngest(context(body))).status).toBe(204);

      const events = bindingEvents(sink, op);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        level: "info",
        correlationId: "ui_chat-list-load-0008",
        extra: { referenceShape: "user-selected", targetFingerprint: "a1".repeat(32) },
      });
      expect(events[0]?.errorKind).toBeUndefined();
    });

    // #3557 review: only a binding found again after redaction names its chat, by fingerprint.
    it("refuses a target fingerprint on a missing binding", async () => {
      const sink = captureServerLog();
      const body = JSON.stringify({
        kind: "binding",
        surface: "chat-window",
        windowRef: "chat-mfr3k2x1-1",
        outcome: "target-missing",
        referenceShape: "redacted",
        heuristicFlagged: false,
        targetFingerprint: "a1".repeat(32),
      });

      expect((await handleClientDiagnosticIngest(context(body))).status).toBe(400);

      expect(bindingEvents(sink, "client.binding.target-missing")).toEqual([]);
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

  // #3557 review: an offer is routine evidence, like a resolved binding; a burst of them never uses
  // up the budget a failure report needs.
  it("keeps a failure report admitted after a burst of offers", async () => {
    const sink = captureServerLog();
    for (let index = 1; index <= 61; index += 1) {
      const offer = {
        kind: "binding",
        surface: "chat-window",
        windowRef: `chat-offer-${String(index)}`,
        outcome: "candidates-offered",
        referenceShape: "redacted",
        heuristicFlagged: false,
        candidateCount: 1,
        disambiguatedCount: 0,
      };
      await handleClientDiagnosticIngest(context(JSON.stringify(offer)));
    }
    const failure = JSON.stringify({ message: "boundary", clientTs: CLIENT_TS, kind: "boundary" });

    expect((await handleClientDiagnosticIngest(context(failure))).status).toBe(204);
    expect(clientDiagnosticEvents(sink)).toHaveLength(1);
    const notices = sink.events.filter((event) => event.op === "client.diagnostic.rate-limited");
    expect(notices.map((event) => event.extra?.budget)).toEqual(["routine"]);
  });

  // #3557 review: both phases of one mounted stage carry the client-minted id, so they join.
  it.each([
    ["chat bind", "chat-bind"],
    ["command palette", "command-palette"],
  ])("logs both phases of %s under the stage's own correlation id", async (stageId, logStage) => {
    const sink = captureServerLog();
    for (const body of [
      {
        kind: "stage",
        stage: stageId,
        phase: "started",
        ordinal: 4,
        correlationId: "ui_stage-0004",
      },
      {
        kind: "stage",
        stage: stageId,
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
    expect(stage.map((event) => event.extra?.stage)).toEqual([logStage, logStage]);
  });

  it("records the correlated deletion lifecycle with counts and no conversation content", async () => {
    const sink = captureServerLog();
    for (const report of [
      { phase: "started", deletion: { requestedCount: 3, deletedCount: 0, failedCount: 0 } },
      {
        phase: "settled",
        durationMs: 12,
        deletion: { requestedCount: 3, deletedCount: 2, failedCount: 1 },
      },
    ]) {
      const body = {
        kind: "stage",
        stage: "chat history deletion",
        ordinal: 1,
        correlationId: "ui_history-delete-0001",
        ...report,
      };
      expect((await handleClientDiagnosticIngest(context(JSON.stringify(body)))).status).toBe(204);
    }
    const events = sink.events.filter((event) => event.op.startsWith("client.stage."));
    expect(events.map((event) => [event.op, event.correlationId, event.extra?.stage])).toEqual([
      ["client.stage.started", "ui_history-delete-0001", "chat-history-deletion"],
      ["client.stage.settled", "ui_history-delete-0001", "chat-history-deletion"],
    ]);
    expect(events.at(-1)?.extra).toEqual({
      stage: "chat-history-deletion",
      ordinal: 1,
      requestedCount: 3,
      deletedCount: 2,
      failedCount: 1,
      completeness: "complete",
      loss: "none",
    });
    expect(events.at(-1)?.durationMs).toBe(12);
    expect(clientDiagnosticEvents(sink)).toHaveLength(0);
    expectCompleteGitTimeline(events);
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

    // #3557 review: a repair report the Activity Log cannot link to its repair request is refused
    // as malformed and counted, never recorded as a complete repair.
    it.each([
      ["without the repair request's id", undefined],
      ["with a repair id outside the server's correlation rule", "short"],
    ])("refuses a repair report %s", async (_label, repairCorrelationId) => {
      const sink = captureServerLog();
      const body = JSON.stringify({
        kind: "session-repair",
        outcome: "repair-acknowledged",
        stream: "run-events",
        correlationId: "ui_stream-streak-0004",
        repairCorrelationId,
      });

      expect((await handleClientDiagnosticIngest(context(body))).status).toBe(400);

      expect(sink.events.some((event) => event.op.startsWith("client.session-repair."))).toBe(
        false,
      );
      expect(sink.events.filter((event) => event.op === "client.diagnostic.rejected")).toEqual([
        expect.objectContaining({
          extra: expect.objectContaining({ rejection: "invalid-shape" }) as unknown,
        }),
      ]);
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
          repairCorrelationId: `ui_session-repair-${String(index).padStart(4, "0")}`,
        };
        await handleClientDiagnosticIngest(context(JSON.stringify(repair)));
      }
      // Every repair was admitted and spent the routine budget, none was refused.
      expect(sink.events.some((event) => event.op === "client.diagnostic.rejected")).toBe(false);
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

// A closing tab cannot retry in a later rate window. Final loss delivery needs reserved,
// bounded admission independent of routine/failure storms.
function expectFinalLossLine(sink: BufferedServerLogSink): void {
  const index = sink.events.findIndex((event) => event.extra?.clientKind === "delivery-loss");
  expect(index).toBeGreaterThanOrEqual(0);
  expect(JSON.parse(sink.lines()[index] ?? "{}") as unknown).toMatchObject({
    op: "client.diagnostic",
    correlationId: CORRELATION_ID,
    errorKind: "unknown",
    clientKind: "delivery-loss",
    clientPostsThrottled: 5,
  });
}

it("admits a final loss flush after both ordinary budgets are exhausted", async () => {
  resetClientDiagnosticsIngestStateForTests();
  const sink = captureServerLog();
  const now = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
  const before = activityLogLossCounters()["client-post-throttled"];
  try {
    for (const metadata of [{}, { selectDismissal: { reason: "escape", focus: "trigger" } }]) {
      for (let index = 0; index < 60; index += 1) {
        expect(
          (
            await handleClientDiagnosticIngest(
              context(
                JSON.stringify({
                  message: "report",
                  clientTs: CLIENT_TS,
                  ...metadata,
                }),
              ),
            )
          ).status,
        ).toBe(204);
      }
    }
    const finalReport = JSON.stringify({
      message: "[keiko] client diagnostic delivery loss summary",
      clientTs: CLIENT_TS,
      kind: "delivery-loss",
      loss: { postsThrottled: 5 },
    });
    expect((await handleClientDiagnosticIngest(context(finalReport))).status).toBe(204);
    expect(activityLogLossCounters()["client-post-throttled"] - before).toBe(5);
    expectFinalLossLine(sink);
    for (let index = 1; index < 60; index += 1) {
      expect((await handleClientDiagnosticIngest(context(finalReport))).status).toBe(204);
    }
    const admitted = activityLogLossCounters()["client-post-throttled"];
    for (let index = 0; index < 3; index += 1) {
      expect((await handleClientDiagnosticIngest(context(finalReport))).status).toBe(429);
    }
    expect(activityLogLossCounters()["client-post-throttled"]).toBe(admitted);
  } finally {
    now.mockRestore();
    resetClientDiagnosticsIngestStateForTests();
  }
});

describe("reviewed navigation and render evidence", () => {
  it.each(["applied", "unavailable", "failed", "dropped", "stale", "cancelled", "deferred"])(
    "persists closed navigation outcome %s with the lifecycle join",
    async (navigationOutcome) => {
      const sink = captureServerLog();
      const base = {
        kind: "stage",
        stage: "editor project selection",
        ordinal: 1,
        correlationId: "ui_navigation-0001",
      };
      await handleClientDiagnosticIngest(context(JSON.stringify({ ...base, phase: "started" })));
      await handleClientDiagnosticIngest(
        context(JSON.stringify({ ...base, phase: "settled", durationMs: 2, navigationOutcome })),
      );
      const events = sink.events.filter((event) => event.op.startsWith("client.stage."));
      expect(events).toHaveLength(2);
      expect(events.map((event) => event.correlationId)).toEqual([
        base.correlationId,
        base.correlationId,
      ]);
      expect(events[1]?.extra?.navigationOutcome).toBe(navigationOutcome);
      const encoded = sink.lines().join("");
      expect(encoded).toContain(`"navigationOutcome":"${navigationOutcome}"`);
      expect(analyzeLogText(encoded).sufficiency.status).toBe("complete");
    },
  );
  it("persists a source-preview capability with only closed counts", async () => {
    const sink = captureServerLog();
    const body = {
      kind: "stage",
      stage: "files source preview",
      phase: "settled",
      ordinal: 1,
      durationMs: 2,
      navigationOutcome: "applied",
      preview: { previewKind: "text", sourceTextBytesRead: 2048, canEdit: false },
    };
    expect((await handleClientDiagnosticIngest(context(JSON.stringify(body)))).status).toBe(204);
    expect(sink.events.find((event) => event.op === "client.stage.settled")?.extra).toMatchObject({
      stage: "files-source-preview",
      previewKind: "text",
      sourceTextBytesRead: 2048,
      canEdit: false,
    });
  });
  it.each(["too-large", "unsupported"] as const)(
    "persists binary preview reason %s without path/body fields",
    async (binaryReason) => {
      const sink = captureServerLog();
      const body = {
        kind: "stage",
        stage: "files source preview",
        phase: "settled",
        ordinal: 1,
        durationMs: 2,
        navigationOutcome: "applied",
        preview: { previewKind: "binary", binaryReason, sourceTextBytesRead: 0, canEdit: false },
      };
      expect((await handleClientDiagnosticIngest(context(JSON.stringify(body)))).status).toBe(204);
      expect(sink.events.find((event) => event.op === "client.stage.settled")?.extra).toMatchObject(
        { previewKind: "binary", binaryReason, sourceTextBytesRead: 0, canEdit: false },
      );
      expect(sink.lines().join("")).toContain(`"binaryReason":"${binaryReason}"`);
      const event = sink.events.find((candidate) => candidate.op === "client.stage.settled");
      const record = expectActivityLogProof(
        "client.stage.settled.line",
        formatActivityLogProofLine(event ?? {}),
      );
      expect(record).toMatchObject({
        binaryReason,
        previewKind: "binary",
        sourceTextBytesRead: 0,
        canEdit: false,
      });
      expect(clientDiagnosticEvents(sink)).toHaveLength(0);
    },
  );
  it("persists file-read transport and stage lifecycle under one minted correlation", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "keiko-navigation-stage-"));
    const sink = createActivityLogSink(stateDir, { level: "debug" });
    setServerLogger(createServerLogger({ sink, level: "debug" }));
    const correlationId = "ui_files-read-0001";
    const base = { kind: "stage", stage: "files directory load", ordinal: 1, correlationId };
    try {
      for (const body of [
        { ...base, phase: "started" },
        { ...base, phase: "settled", durationMs: 3, navigationOutcome: "applied" },
      ])
        await handleClientDiagnosticIngest(context(JSON.stringify(body), correlationId));
      sink.close?.();
      const analyzed = analyzeLogText(readPersistedActivityLog(stateDir));
      const timeline = analyzed.timelines.find((entry) => entry.correlationId === correlationId);
      expect(
        timeline?.lines.filter((line) => line.op === "http.request.body.received"),
      ).toHaveLength(2);
      expect(
        timeline?.lines
          .filter((line) => line.op.startsWith("client.stage."))
          .map((line) => line.op),
      ).toEqual(["client.stage.started", "client.stage.settled"]);
      expect(analyzed.sufficiency.status).toBe("complete");
    } finally {
      resetServerLogger();
      sink.close?.();
      await rm(stateDir, { recursive: true, force: true });
    }
  });
  it.each(["shell", "window-body"])(
    "records a real %s render failure at error while plain internal boundaries remain warn",
    async (renderFailure) => {
      const sink = captureServerLog();
      await handleClientDiagnosticIngest(
        context(
          JSON.stringify({
            message: "caught render",
            clientTs: CLIENT_TS,
            kind: "boundary",
            renderFailure,
            errorKind: "internal",
          }),
        ),
      );
      await handleClientDiagnosticIngest(
        context(
          JSON.stringify({
            message: "ordinary boundary",
            clientTs: CLIENT_TS,
            kind: "boundary",
            errorKind: "internal",
          }),
        ),
      );
      const events = clientDiagnosticEvents(sink);
      expect(events.map((event) => event.level)).toEqual(["error", "warn"]);
      expect(events[0]?.extra?.renderFailure).toBe(renderFailure);
    },
  );
});

describe("citation activation ingestion", () => {
  beforeEach(() => resetClientDiagnosticsIngestStateForTests());
  afterEach(() => {
    resetClientDiagnosticsIngestStateForTests();
    resetServerLogger();
  });

  it.each([
    { rootCount: Number.MAX_SAFE_INTEGER, correlationId: "citation-action-123", outcome: "opened" },
    { rootCount: 2, correlationId: undefined, outcome: "opened" },
    { rootCount: 0, correlationId: "citation-action-123", outcome: "opened" },
  ])("refuses impossible or unjoinable activation $rootCount/$correlationId", async (input) => {
    const sink = captureServerLog();
    const result = await handleClientDiagnosticIngest(
      context(
        JSON.stringify({
          message: "private-citation-customer-canary",
          clientTs: CLIENT_TS,
          correlationId: input.correlationId,
          citationActivation: {
            reason: "absent",
            outcome: input.outcome,
            rootCount: input.rootCount,
            matchCount: 0,
          },
        }),
      ),
    );
    expect(result.status).toBe(400);
    expect(sink.events.some((event) => event.op === "client.citation.activated")).toBe(false);
    expect(sink.events.some((event) => event.op === "client.diagnostic.rejected")).toBe(true);
    expect(sink.lines().join("\n")).not.toContain("private-citation-customer-canary");
  });

  it("retains a malformed identity after the human explicitly chooses its source", async () => {
    const sink = captureServerLog();
    const activation = { reason: "malformed", outcome: "opened", rootCount: 1, matchCount: 0 };
    expect(
      (
        await handleClientDiagnosticIngest(
          context(
            JSON.stringify({
              message: "citation action",
              clientTs: CLIENT_TS,
              correlationId: "human-choice-123",
              citationActivation: activation,
            }),
          ),
        )
      ).status,
    ).toBe(204);
    const event = sink.events.find((candidate) => candidate.op === "client.citation.activated");
    expect(
      expectActivityLogProof(
        "client.citation.activated.line",
        formatActivityLogProofLine(event ?? {}),
      ),
    ).toMatchObject({
      ...activation,
      correlationId: "human-choice-123",
      completeness: "complete",
      loss: "none",
    });
  });

  it.each(["opened", "open-refused", "picker-opened", "picker-dismissed", "refused"])(
    "persists %s as routine citation evidence rather than a new failure incident",
    async (outcome) => {
      const sink = captureServerLog();
      const activation = { reason: "absent", outcome, rootCount: 2, matchCount: 0 };
      const body = JSON.stringify({
        message: "[keiko] citation activation settled",
        clientTs: CLIENT_TS,
        correlationId: "ui_citation-activation-0001",
        citationActivation: activation,
      });
      expect(await handleClientDiagnosticIngest(context(body))).toEqual({
        status: 204,
        body: null,
      });
      expect(clientDiagnosticEvents(sink)).toHaveLength(0);
      const event = sink.events.find((candidate) => candidate.op === "client.citation.activated");
      const record = expectActivityLogProof(
        "client.citation.activated.line",
        formatActivityLogProofLine(event ?? {}),
      );
      expect(record).toMatchObject({
        ...activation,
        correlationId: "ui_citation-activation-0001",
        completeness: "complete",
        loss: "none",
      });
      expect(event?.level).toBe("info");
      expect(JSON.stringify(event)).not.toContain("citation activation settled");
    },
  );
});
