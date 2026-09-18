// Activity Log scenario matrix (#3532): the client-diagnostics ingest route and the UI
// launcher/process-lifecycle surfaces.
//
// Each scenario drives a production entry point with the real production file writer under a
// temporary KEIKO_STATE_DIR and reconstructs the persisted log through `keiko support analyze` to a
// complete report (tests/support/activity-log-scenario.ts).
//
// `client-diagnostics.*` drives `handleClientDiagnosticIngest` (keiko-server source) directly, the
// same production route `client-diagnostics-loss.test.ts` exercises; `resetServerLogger` comes from
// the SAME source module graph that route resolves `getServerLogger()` from (a relative import), so
// the process-wide logger slot it reads `KEIKO_STATE_DIR` into is the one this file resets.
//
// `ui.*` drives `terminateUiProcess`/`startProcessHeartbeat` (keiko-cli source). Neither call reads
// the process-wide logger: both accept an injected sink, so this file builds the REAL file-backed
// sink itself with `createActivityLogSink` — the exact factory `keiko-cli`'s own composition root
// (`runner.ts`'s `deferredSecurityLogCollector`) uses in production, reached through
// `@oscharko-dev/keiko-server` (dist) because that is the only module graph `keiko-cli` source ever
// loads keiko-server through (`lazy-modules.ts`'s `loadServer`). `resetServerLogger` is not part of
// that package's public surface (only `createActivityLogSink`/`closeFileServerLogSinks` are), so
// `closeFileServerLogSinks` is the equivalent reset for this graph: it closes the per-directory file
// sink `createActivityLogSink` opens, the same resource `resetServerLogger` releases for the
// process-wide slot the client-diagnostics scenarios use instead.

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
import { closeFileServerLogSinks, createActivityLogSink } from "@oscharko-dev/keiko-server";

import {
  handleClientDiagnosticIngest,
  resetClientDiagnosticsIngestStateForTests,
} from "../../packages/keiko-server/src/client-diagnostics-routes.js";
import { resetServerLogger } from "../../packages/keiko-server/src/observability/index.js";
import type { RouteContext } from "../../packages/keiko-server/src/routes.js";
import { writeExclusivePidFile } from "../../packages/keiko-cli/src/state-paths.js";
import { terminateUiProcess } from "../../packages/keiko-cli/src/ui-process-stop.js";
import { startProcessHeartbeat } from "../../packages/keiko-cli/src/ui.js";
import {
  persistedActivityLogLines,
  readPersistedActivityLog,
} from "../support/activity-log-proof.js";
import { expectActivityLogScenario } from "../support/activity-log-scenario.js";

const CLIENT_TS = "2026-09-18T10:00:00.000Z";

function parsedLine(line: string | undefined): Record<string, unknown> {
  return JSON.parse(line ?? "{}") as Record<string, unknown>;
}

describe("Activity Log scenario: client-diagnostics", () => {
  const CORRELATION_ID = "client-diagnostics-ui-scenario";
  let stateDir: string;

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

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "keiko-scenario-client-diag-"));
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

  // Fault injection: the browser reports its EventSource transport closing unexpectedly (readyState
  // 2 = CLOSED) with counts of what it already dropped locally while the stream was down — a
  // genuine dependency failure (the BFF's SSE channel) surfacing through the ingest route's one
  // production write path for an accepted report.
  it("persists a browser-reported SSE dependency failure", async () => {
    const startedAtMs = Date.now();
    const body = JSON.stringify({
      message: "[keiko] sse stream closed unexpectedly",
      clientTs: CLIENT_TS,
      kind: "sse-error",
      readyState: 2,
      loss: { postsFailed: 1, bufferEvicted: 2 },
    });

    const response = await handleClientDiagnosticIngest(context(body));
    expect(response.status).toBe(204);

    const trace = await expectActivityLogScenario("client-diagnostics.dependency-failure", {
      stateDir,
      startedAtMs,
      expectedOps: ["client.diagnostic"],
    });
    expect(trace.failureClasses).toEqual(expect.arrayContaining(["client-diagnostic"]));

    const lines = persistedActivityLogLines(
      readPersistedActivityLog(stateDir),
      "client.diagnostic",
    );
    expect(lines).toHaveLength(1);
    expect(parsedLine(lines[0])).toMatchObject({
      correlationId: CORRELATION_ID,
      clientKind: "sse-error",
      errorKind: "unavailable",
      readyState: 2,
      clientPostsFailed: 1,
      clientBufferEvicted: 2,
      completeness: "complete",
      loss: "none",
    });
    expect(activityLogLossCounters()["client-post-failed"]).toBe(1);
    expect(activityLogLossCounters()["client-buffer-evicted"]).toBe(2);
  });

  // Fault injection: four refused reports (two sharing a refusal reason within the same throttle
  // window) drive the route's own loss path — a report refused is never parsed into an event, so
  // the ONLY evidence of it is the throttled `client.diagnostic.rejected` line and its suppressed
  // count, exactly the "backpressure/refused" loss mode this scenario id names.
  it("persists throttled loss evidence for refused reports", async () => {
    const startedAtMs = Date.now();
    expect((await handleClientDiagnosticIngest(context("{not json"))).status).toBe(400);
    expect((await handleClientDiagnosticIngest(context("{still not json"))).status).toBe(400);
    const oversized = JSON.stringify({ message: "x".repeat(5_000), clientTs: CLIENT_TS });
    expect((await handleClientDiagnosticIngest(context(oversized))).status).toBe(413);
    const shapeless = JSON.stringify({ message: "no timestamp" });
    expect((await handleClientDiagnosticIngest(context(shapeless))).status).toBe(400);

    const trace = await expectActivityLogScenario("client-diagnostics.loss", {
      stateDir,
      startedAtMs,
      expectedOps: ["client.diagnostic.rejected"],
    });
    expect(trace.failureClasses).toEqual(expect.arrayContaining(["client-diagnostic-rejection"]));

    const rejected = persistedActivityLogLines(
      readPersistedActivityLog(stateDir),
      "client.diagnostic.rejected",
    );
    expect(rejected.map((line) => parsedLine(line).rejection)).toEqual([
      "invalid-json",
      "too-large",
      "invalid-shape",
    ]);
    expect(parsedLine(rejected[0])).toMatchObject({
      correlationId: CORRELATION_ID,
      errorKind: "invalid-request",
      completeness: "complete",
      loss: "event-dropped",
    });
    // The second invalid-json call fell inside the first's throttle window: it never got its own
    // line, only a suppressed count — the loss ledger is the only place that count is not lost too.
    expect(activityLogLossCounters()["client-rejected"]).toBe(4);
  });
});

describe("Activity Log scenario: ui", () => {
  const TEST_LAUNCH_ID = "d".repeat(32);
  let stateDir: string;
  let activityLog: ReturnType<typeof createActivityLogSink>;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "keiko-scenario-ui-"));
    vi.stubEnv("KEIKO_STATE_DIR", stateDir);
    vi.stubEnv("KEIKO_LOG_LEVEL", "debug");
    closeFileServerLogSinks();
    activityLog = createActivityLogSink(stateDir);
  });

  afterEach(() => {
    closeFileServerLogSinks();
    vi.unstubAllEnvs();
    rmSync(stateDir, { recursive: true, force: true });
  });

  // Fault injection: the UI process never dies during the graceful (SIGTERM) grace window, so
  // `terminateUiProcess` must escalate — and the escalation's own SIGKILL is denied (EPERM), an
  // abort the caller can only learn about from the activity log. `performance.now()` is stubbed
  // exactly as the sibling proof test (`ui-process-stop.activity-log-proof.test.ts`) already proves
  // out, so the grace budget elapses without a real sleep.
  it("escalates a stop request through a denied SIGKILL", async () => {
    const pid = 5_551_212;
    writeExclusivePidFile(join(stateDir, "ui.pid"), pid, TEST_LAUNCH_ID);
    const killed: (readonly [number, NodeJS.Signals | 0 | undefined])[] = [];
    let alive = true;
    const nowSpy = vi.spyOn(performance, "now");
    nowSpy.mockReturnValueOnce(0).mockReturnValueOnce(1_001);
    const startedAtMs = Date.now();
    try {
      const outcome = await terminateUiProcess({
        pid,
        stateDir,
        stopTimeoutMs: 1,
        platform: "linux",
        sleep: () => Promise.resolve(),
        isProcessAlive: () => alive,
        killProcess: (killedPid, signal) => {
          killed.push([killedPid, signal]);
          if (signal === "SIGKILL") {
            alive = false;
            throw Object.assign(new Error("denied"), { code: "EPERM" });
          }
        },
        securityLogSink: activityLog,
        escalate: true,
        launchId: TEST_LAUNCH_ID,
        verifyLaunchIdentity: () => true,
      });
      expect(outcome).toEqual({ confirmed: true, escalated: true });
    } finally {
      nowSpy.mockRestore();
    }
    expect(killed).toEqual([
      [pid, "SIGTERM"],
      [pid, "SIGKILL"],
    ]);

    // Write order: the initial SIGTERM request, then the denied SIGKILL inside escalation, then the
    // escalation decision itself (`escalateForcedStop` logs the disposition AFTER attempting the
    // forced signal) — `expectOrderedSubsequence` enforces this exact causal order.
    const trace = await expectActivityLogScenario("ui.crash", {
      stateDir,
      startedAtMs,
      expectedOps: [
        "cli.lifecycle.stop-requested",
        "cli.lifecycle.stop-escalation-failed",
        "cli.lifecycle.stop-escalated",
      ],
    });
    expect(trace.failureClasses).toEqual(
      expect.arrayContaining(["ui-process-stop", "ui-process-stop-escalation"]),
    );

    const raw = readPersistedActivityLog(stateDir);
    expect(
      parsedLine(persistedActivityLogLines(raw, "cli.lifecycle.stop-requested")[0]),
    ).toMatchObject({ channel: "sigterm" });
    expect(
      parsedLine(persistedActivityLogLines(raw, "cli.lifecycle.stop-escalation-failed")[0]),
    ).toMatchObject({ failureKind: "EPERM", errorKind: "unavailable" });
    expect(
      parsedLine(persistedActivityLogLines(raw, "cli.lifecycle.stop-escalated")[0]),
    ).toMatchObject({ windowsTreeKill: "not-attempted" });
  });

  // Fault injection: `startProcessHeartbeat`'s injectable histogram (the seam `ui.ts` documents for
  // pinning interval-scoping in tests) reports a measured 6-second p99 event-loop delay on every
  // tick — a real stall, not a happy-path sample. `process.heartbeat` carries both `process-stall`
  // and `memory-pressure` in its own registration regardless of the sampled values, so this single
  // injected fault evidences both classes this scenario id maps to.
  it("persists a heartbeat observing a stalled event loop", async () => {
    const startedAtMs = Date.now();
    const stop = startProcessHeartbeat(activityLog, 10, stalledHistogram);
    try {
      await vi.waitFor(() => {
        expect(
          persistedActivityLogLines(readPersistedActivityLog(stateDir), "process.heartbeat").length,
        ).toBeGreaterThan(0);
      });
    } finally {
      stop();
    }

    const trace = await expectActivityLogScenario("ui.dependency-failure", {
      stateDir,
      startedAtMs,
      expectedOps: ["process.heartbeat"],
    });
    expect(trace.failureClasses).toEqual(
      expect.arrayContaining(["process-stall", "memory-pressure"]),
    );

    const heartbeats = persistedActivityLogLines(
      readPersistedActivityLog(stateDir),
      "process.heartbeat",
    );
    const record = parsedLine(heartbeats[0]);
    // Exact, not toBeGreaterThanOrEqual: the fake histogram deterministically returns
    // 6_000 * 1_000_000 ns, so only `toBe(6_000)` can catch a broken ns-to-ms conversion (e.g. a
    // missing or doubled /1_000_000, or a units mix-up) — >= 6_000 accepts any larger value too.
    expect(record.eventLoopDelayP99Ms).toBe(6_000);
    expect(typeof record.rssBytes).toBe("number");
  });
});

// `startProcessHeartbeat`'s `createHistogram` seam takes any zero-argument factory whose result
// structurally matches Node's `RecordableHistogram` subset it calls — this double never depends on
// real event-loop timing, unlike the actual `monitorEventLoopDelay()` the production launch uses.
interface StalledHistogram {
  enable(): void;
  disable(): void;
  reset(): void;
  percentile(percentile: number): number;
}

function stalledHistogram(): StalledHistogram {
  return {
    enable: (): void => undefined,
    disable: (): void => undefined,
    reset: (): void => undefined,
    // 6_000ms of measured event-loop delay in nanoseconds, `writeHeartbeat`'s own unit.
    percentile: (): number => 6_000 * 1_000_000,
  };
}
