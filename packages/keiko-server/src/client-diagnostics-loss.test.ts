// The BFF client-diagnostics route's loss evidence (#3532): refused reports get their own throttled
// line, trailing suppressed counts are flushed at shutdown, and browser-reported delivery loss is
// persisted and counted — all through the real production sink.

import { IncomingMessage, ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLogLossCounters,
  resetActivityLogLossCountersForTests,
} from "@oscharko-dev/keiko-contracts/runtime/observability";

import {
  expectActivityLogProof,
  persistedActivityLogLines,
  readPersistedActivityLog,
} from "../../../tests/support/activity-log-proof.js";
import {
  clientBindingDigest,
  flushClientDiagnosticsIngestCounts,
  handleClientDiagnosticIngest,
  resetClientDiagnosticsIngestStateForTests,
} from "./client-diagnostics-routes.js";
import { resetServerLogger } from "./observability/index.js";
import type { RouteContext } from "./routes.js";

const CORRELATION_ID = "client-loss-route-test";
const CLIENT_TS = "2026-09-18T10:00:00.000Z";

function context(rawBody: string): RouteContext {
  const req = new IncomingMessage(new Socket());
  req.push(rawBody);
  req.push(null);
  return {
    req,
    res: new ServerResponse(req),
    params: {},
    url: new URL("http://localhost/api/diagnostics/client"),
    correlationId: CORRELATION_ID,
  };
}

describe("client diagnostics loss evidence", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "keiko-client-loss-"));
    vi.stubEnv("KEIKO_STATE_DIR", stateDir);
    vi.stubEnv("KEIKO_LOG_LEVEL", "debug");
    resetServerLogger();
    resetClientDiagnosticsIngestStateForTests();
    resetActivityLogLossCountersForTests();
  });

  afterEach(() => {
    resetServerLogger();
    resetClientDiagnosticsIngestStateForTests();
    vi.unstubAllEnvs();
    rmSync(stateDir, { recursive: true, force: true });
  });

  function lines(op: string): readonly string[] {
    return persistedActivityLogLines(readPersistedActivityLog(stateDir), op);
  }

  it("persists one throttled rejection line per refusal reason and counts every refusal", async () => {
    expect((await handleClientDiagnosticIngest(context("{not json"))).status).toBe(400);
    expect((await handleClientDiagnosticIngest(context("{still not json"))).status).toBe(400);
    const oversized = JSON.stringify({ message: "x".repeat(5_000), clientTs: CLIENT_TS });
    expect((await handleClientDiagnosticIngest(context(oversized))).status).toBe(413);
    const shapeless = JSON.stringify({ message: "no timestamp" });
    expect((await handleClientDiagnosticIngest(context(shapeless))).status).toBe(400);

    const rejected = lines("client.diagnostic.rejected");
    expect(rejected.map((line) => (JSON.parse(line) as { rejection: string }).rejection)).toEqual([
      "invalid-json",
      "too-large",
      "invalid-shape",
    ]);
    expect(
      expectActivityLogProof("client.diagnostic.rejected.line", rejected[0] ?? ""),
    ).toMatchObject({
      correlationId: CORRELATION_ID,
      errorKind: "invalid-request",
      trigger: "window",
      loss: "event-dropped",
    });
    expect(activityLogLossCounters()["client-rejected"]).toBe(4);
  });

  it("flushes the trailing suppressed counts at shutdown", async () => {
    await handleClientDiagnosticIngest(context("{not json"));
    await handleClientDiagnosticIngest(context("{not json"));
    await handleClientDiagnosticIngest(context("{not json"));
    for (let index = 0; index < 62; index += 1) {
      const body = JSON.stringify({ message: `report ${String(index)}`, clientTs: CLIENT_TS });
      await handleClientDiagnosticIngest(context(body));
    }

    flushClientDiagnosticsIngestCounts();

    const flushed = lines("client.diagnostic.rejected").at(-1) ?? "";
    expect(
      expectActivityLogProof("client.diagnostic.rejected.shutdown-flush", flushed),
    ).toMatchObject({
      rejection: "invalid-json",
      suppressedRejections: 2,
      trigger: "shutdown-flush",
    });
    const drops = lines("client.diagnostic.rate-limited");
    expect(drops).toHaveLength(2);
    expect(
      expectActivityLogProof("client.diagnostic.rate-limited.line", drops[1] ?? ""),
    ).toMatchObject({ suppressedDrops: 1, trigger: "shutdown-flush" });
    expect(activityLogLossCounters()["client-rate-suppressed"]).toBe(2);
    // A second flush has nothing left to write.
    flushClientDiagnosticsIngestCounts();
    expect(lines("client.diagnostic.rate-limited")).toHaveLength(2);
  });

  it("persists and counts the browser's own delivery loss on the next accepted report", async () => {
    const body = JSON.stringify({
      message: "[keiko] uncaught window error: TypeError",
      clientTs: CLIENT_TS,
      kind: "window-error",
      loss: { bufferEvicted: 3, postsFailed: 1, errorsSuppressed: 2 },
    });
    expect((await handleClientDiagnosticIngest(context(body))).status).toBe(204);

    const [line] = lines("client.diagnostic");
    expect(expectActivityLogProof("client.diagnostic.line", line ?? "")).toMatchObject({
      clientKind: "window-error",
      errorKind: "internal",
      clientBufferEvicted: 3,
      clientPostsFailed: 1,
      clientErrorsSuppressed: 2,
    });
    const counters = activityLogLossCounters();
    expect(counters["client-buffer-evicted"]).toBe(3);
    expect(counters["client-post-failed"]).toBe(1);
    expect(counters["client-error-suppressed"]).toBe(2);
  });

  it("refuses a report whose loss block is not closed", async () => {
    const body = JSON.stringify({
      message: "report",
      clientTs: CLIENT_TS,
      loss: { bufferEvicted: 3, somethingElse: 1 },
    });
    expect((await handleClientDiagnosticIngest(context(body))).status).toBe(400);
    expect(lines("client.diagnostic")).toEqual([]);
  });

  // KEIKO-3557: proves the new lifecycle operations reach the production file sink with a complete
  // v2 identity, exactly like every other registered operation — not merely a buffered test event.
  it("persists a started stage report as client.stage.started", async () => {
    const body = JSON.stringify({
      kind: "stage",
      stage: "editor widget chunk",
      phase: "started",
      ordinal: 2,
    });
    expect((await handleClientDiagnosticIngest(context(body))).status).toBe(204);

    const [line] = lines("client.stage.started");
    expect(expectActivityLogProof("client.stage.started.line", line ?? "")).toMatchObject({
      correlationId: CORRELATION_ID,
      stage: "editor-widget-chunk",
      ordinal: 2,
      completeness: "complete",
      loss: "none",
    });
    expect(lines("client.diagnostic")).toEqual([]);
  });

  // #3557 review: both binding outcomes reach the production file sink with the complete identity.
  it("persists a missing binding target as client.binding.target-missing", async () => {
    const body = JSON.stringify({
      kind: "binding",
      surface: "chat-window",
      windowRef: "chat-mfr3k2x1-1",
      outcome: "target-missing",
      referenceShape: "redacted",
      heuristicFlagged: false,
      correlationId: "ui_chat-list-load-0002",
    });
    expect((await handleClientDiagnosticIngest(context(body))).status).toBe(204);

    const [line] = lines("client.binding.target-missing");
    expect(expectActivityLogProof("client.binding.target-missing.line", line ?? "")).toMatchObject({
      correlationId: "ui_chat-list-load-0002",
      errorKind: "unavailable",
      surface: "chat-window",
      referenceShape: "redacted",
      heuristicFlagged: false,
      bindingDigest: clientBindingDigest("chat-mfr3k2x1-1"),
      completeness: "complete",
      loss: "none",
    });
    expect(lines("client.diagnostic")).toEqual([]);
  });

  it("persists a resolved binding whose reference the heuristic flags as client.binding.resolved", async () => {
    const body = JSON.stringify({
      kind: "binding",
      surface: "chat-window",
      windowRef: "chat-mfr3k2x1-1",
      outcome: "resolved",
      referenceShape: "uuid",
      heuristicFlagged: true,
    });
    expect((await handleClientDiagnosticIngest(context(body))).status).toBe(204);

    const [line] = lines("client.binding.resolved");
    const record = expectActivityLogProof("client.binding.resolved.line", line ?? "");
    expect(record).toMatchObject({
      correlationId: CORRELATION_ID,
      referenceShape: "uuid",
      heuristicFlagged: true,
    });
    expect(record.errorKind).toBeUndefined();
  });

  // #3557 review: both session-repair outcomes reach the production file sink with full identity.
  it("persists a recovered session repair as client.session-repair.recovered", async () => {
    const body = JSON.stringify({
      kind: "session-repair",
      outcome: "replayed",
      correlationId: "ui_denied-read-0002",
      repairCorrelationId: "ui_session-repair-0002",
    });
    expect((await handleClientDiagnosticIngest(context(body))).status).toBe(204);

    const [line] = lines("client.session-repair.recovered");
    const record = expectActivityLogProof("client.session-repair.recovered.line", line ?? "");
    expect(record).toMatchObject({
      correlationId: "ui_denied-read-0002",
      repairCorrelationId: "ui_session-repair-0002",
      completeness: "complete",
      loss: "none",
    });
    expect(record.errorKind).toBeUndefined();
  });

  // #3557 review: a stream repair persists under its failure streak, naming the stream.
  it("persists a stream repair as client.session-repair.recovered with its stream", async () => {
    const body = JSON.stringify({
      kind: "session-repair",
      outcome: "stream-repaired",
      stream: "shared-event-source",
      correlationId: "ui_stream-streak-0001",
      repairCorrelationId: "ui_session-repair-0004",
    });
    expect((await handleClientDiagnosticIngest(context(body))).status).toBe(204);

    const [line] = lines("client.session-repair.recovered");
    const record = expectActivityLogProof("client.session-repair.recovered.line", line ?? "");
    expect(record).toMatchObject({
      correlationId: "ui_stream-streak-0001",
      outcome: "stream-repaired",
      stream: "shared-event-source",
      repairCorrelationId: "ui_session-repair-0004",
      completeness: "complete",
      loss: "none",
    });
  });

  // #3557 review: an acknowledged stream repair persists as its own state line.
  it("persists an acknowledged stream repair as client.session-repair.acknowledged", async () => {
    const body = JSON.stringify({
      kind: "session-repair",
      outcome: "repair-acknowledged",
      stream: "run-events",
      correlationId: "ui_stream-streak-0005",
      repairCorrelationId: "ui_session-repair-0005",
    });
    expect((await handleClientDiagnosticIngest(context(body))).status).toBe(204);

    const [line] = lines("client.session-repair.acknowledged");
    const record = expectActivityLogProof("client.session-repair.acknowledged.line", line ?? "");
    expect(record).toMatchObject({
      correlationId: "ui_stream-streak-0005",
      stream: "run-events",
      repairCorrelationId: "ui_session-repair-0005",
      completeness: "complete",
      loss: "none",
    });
    expect(record.errorKind).toBeUndefined();
  });

  // #3557 review: a chat restored through its id's fingerprint reports that shape.
  it("persists a binding restored through a fingerprint as client.binding.resolved", async () => {
    const body = JSON.stringify({
      kind: "binding",
      surface: "chat-window",
      windowRef: "chat-mfr3k2x1-3",
      outcome: "resolved",
      referenceShape: "fingerprint",
      heuristicFlagged: true,
    });
    expect((await handleClientDiagnosticIngest(context(body))).status).toBe(204);

    const [line] = lines("client.binding.resolved");
    expect(expectActivityLogProof("client.binding.resolved.line", line ?? "")).toMatchObject({
      referenceShape: "fingerprint",
      heuristicFlagged: true,
    });
  });

  it("persists a failed session repair as client.session-repair.failed", async () => {
    const body = JSON.stringify({
      kind: "session-repair",
      outcome: "repair-failed",
      correlationId: "ui_denied-read-0003",
      repairCorrelationId: "ui_session-repair-0003",
      errorKind: "unavailable",
    });
    expect((await handleClientDiagnosticIngest(context(body))).status).toBe(204);

    const [line] = lines("client.session-repair.failed");
    expect(expectActivityLogProof("client.session-repair.failed.line", line ?? "")).toMatchObject({
      correlationId: "ui_denied-read-0003",
      errorKind: "unavailable",
      outcome: "repair-failed",
      repairCorrelationId: "ui_session-repair-0003",
    });
  });

  it("persists a settled stage report as client.stage.settled, with durationMs on the envelope", async () => {
    const body = JSON.stringify({
      kind: "stage",
      stage: "editor widget chunk",
      phase: "settled",
      ordinal: 2,
      durationMs: 17,
    });
    expect((await handleClientDiagnosticIngest(context(body))).status).toBe(204);

    const [line] = lines("client.stage.settled");
    const record = expectActivityLogProof("client.stage.settled.line", line ?? "");
    expect(record).toMatchObject({
      correlationId: CORRELATION_ID,
      durationMs: 17,
      stage: "editor-widget-chunk",
      ordinal: 2,
    });
    expect(record.errorKind).toBeUndefined();
  });
});
