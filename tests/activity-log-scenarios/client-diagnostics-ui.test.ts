import {
  drainSupportIncidentCandidates,
  resetServerLogger,
  setSupportIncidentTriggerForTests,
} from "../support/activity-log-test-support.js";
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
import {
  closeFileServerLogSinks,
  createActivityLogSink,
  recordRegisteredFailureIncident,
  recordUserReportedIncident,
} from "@oscharko-dev/keiko-server";
import { listSupportIncidents } from "@oscharko-dev/keiko-activity-log";
import { createClientOnlySupportReport } from "@oscharko-dev/keiko-activity-log/reader";

import {
  handleClientDiagnosticIngest,
  resetClientDiagnosticsIngestStateForTests,
} from "../../packages/keiko-server/src/client-diagnostics-routes.js";
import type { RouteContext } from "../../packages/keiko-server/src/routes.js";
import { writeExclusivePidFile } from "../../packages/keiko-cli/src/state-paths.js";
import { terminateUiProcess } from "../../packages/keiko-cli/src/ui-process-stop.js";
import { startProcessHeartbeat } from "../../packages/keiko-cli/src/ui.js";
import {
  persistedActivityLogLines,
  readPersistedActivityLog,
} from "../support/activity-log-proof.js";
import {
  expectActivityLogScenario,
  type ScenarioIncidentRecorders,
} from "../support/activity-log-scenario.js";
import { fixtureEvent } from "../support/activity-log-segments.js";
import { WORKSPACE_TRUST_SCHEMA_VERSION } from "@oscharko-dev/keiko-contracts/runtime/workspace-trust";

// The ui scenarios write through the built package, so their incidents come from it too: one
// Activity Log writer instance per process (activity-log-scenario.ts).
const PACKAGED_INCIDENTS: ScenarioIncidentRecorders = {
  recordRegisteredFailureIncident,
  recordUserReportedIncident,
};

interface GitApiFixture {
  readonly fetchGitDiff: (input: { readonly root: string }) => Promise<unknown>;
  readonly fetchGitDeliverySyncExecute: (input: {
    readonly operation: "fetch";
    readonly projectId: string;
    readonly userInitiated: true;
  }) => Promise<unknown>;
}
interface ClientDiagnosticsFixture {
  readonly resetClientDiagnosticWriter: () => void;
  readonly setClientDiagnosticWriter: (writer: (message: string, meta?: unknown) => void) => void;
}
interface DiagnosticTransportFixture {
  readonly fanOutClientDiagnostic: (message: string, meta?: unknown) => void;
  readonly resetClientDiagnosticPostStateForTests: () => void;
}
let resetGitDiagnosticFixture = (): void => undefined;

// The UI is compiled under Next's Bundler resolver. Load its actual modules through Vitest rather
// than importing that separate compiler graph into the root NodeNext project. These fixture ports
// promise no response/domain type; the real wire producer and UI's own typed tests remain authoritative.
async function loadGitDiagnosticFixture(): Promise<{
  api: GitApiFixture;
  diagnostics: ClientDiagnosticsFixture;
  transport: DiagnosticTransportFixture;
}> {
  const api = await vi.importActual<GitApiFixture>("../../packages/keiko-ui/src/lib/api.js");
  const diagnostics = await vi.importActual<ClientDiagnosticsFixture>(
    "../../packages/keiko-ui/src/lib/client-diagnostics.js",
  );
  const transport = await vi.importActual<DiagnosticTransportFixture>(
    "../../packages/keiko-ui/src/lib/install-client-diagnostics.js",
  );
  if (
    ![
      api.fetchGitDiff,
      api.fetchGitDeliverySyncExecute,
      diagnostics.resetClientDiagnosticWriter,
      diagnostics.setClientDiagnosticWriter,
      transport.fanOutClientDiagnostic,
      transport.resetClientDiagnosticPostStateForTests,
    ].every((value) => typeof value === "function")
  )
    throw new TypeError("actual UI fixture exports required");
  resetGitDiagnosticFixture = (): void => {
    diagnostics.resetClientDiagnosticWriter();
    transport.resetClientDiagnosticPostStateForTests();
  };
  return { api, diagnostics, transport };
}

function gitScopeResponse(malformed: boolean): Response {
  return new Response(
    JSON.stringify({
      schemaVersion: "1",
      root: "/private-git-root",
      state: "available",
      available: true,
      scope: malformed ? ["all"] : "all",
      diff: "private git diff body",
      truncated: false,
      maxBytes: 128,
    }),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "X-Keiko-Correlation-Id": "git-scope-response-scenario",
      },
    },
  );
}

async function driveGitScopeRefusal(context: (body: string) => RouteContext): Promise<void> {
  let malformed = false;
  let delivery: Promise<Response> | undefined;
  const bodies: string[] = [];
  const { api, diagnostics, transport } = await loadGitDiagnosticFixture();
  resetGitDiagnosticFixture();
  diagnostics.setClientDiagnosticWriter(transport.fanOutClientDiagnostic);
  vi.spyOn(console, "warn").mockImplementation((): void => undefined);
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      if (typeof input !== "string") throw new TypeError("fixture string request required");
      if (input.startsWith("/api/git/diff?")) return gitScopeResponse(malformed);
      if (input !== "/api/diagnostics/client" || typeof init?.body !== "string")
        throw new TypeError("unexpected fixture request");
      bodies.push(init.body);
      delivery = handleClientDiagnosticIngest(context(init.body)).then(
        (result): Response => new Response(null, { status: result.status }),
      );
      return delivery;
    },
  );
  await expect(api.fetchGitDiff({ root: "/private-git-root" })).resolves.toMatchObject({
    scope: "all",
  });
  expect(bodies).toEqual([]);
  malformed = true;
  await expect(api.fetchGitDiff({ root: "/private-git-root" })).rejects.toMatchObject({
    code: "CONTRACT_VALIDATION_FAILED",
    status: 502,
    correlationId: "git-scope-response-scenario",
  });
  expect(bodies).toHaveLength(1);
  if (delivery === undefined) throw new TypeError("diagnostic delivery required");
  expect((await delivery).status).toBe(204);
  expect(bodies[0]).not.toContain("private-git-root");
  expect(bodies[0]).not.toContain("private git diff body");
  expect(bodies[0]).not.toContain("scope invalid");
}

function gitSyncResponse(malformed: boolean): Response {
  return new Response(
    JSON.stringify({
      schemaVersion: "1",
      operation: "fetch",
      status: "succeeded",
      available: true,
      truncated: false,
      branch: "private-sync-branch",
      upstream: { ref: malformed ? 123 : "private-sync-ref" },
    }),
    { headers: { "X-Keiko-Correlation-Id": "git-sync-response-scenario" } },
  );
}

async function driveGitSyncRefusal(context: (body: string) => RouteContext): Promise<void> {
  let executions = 0;
  let delivery: Promise<Response> | undefined;
  const bodies: string[] = [];
  const { api, diagnostics, transport } = await loadGitDiagnosticFixture();
  resetGitDiagnosticFixture();
  diagnostics.setClientDiagnosticWriter(transport.fanOutClientDiagnostic);
  vi.spyOn(console, "warn").mockImplementation((): void => undefined);
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      if (input === "/api/git-delivery/fetch/execute") {
        expect(init?.method).toBe("POST");
        executions += 1;
        return gitSyncResponse(executions > 1);
      }
      if (input !== "/api/diagnostics/client" || typeof init?.body !== "string")
        throw new TypeError("unexpected fixture request");
      bodies.push(init.body);
      delivery = handleClientDiagnosticIngest(context(init.body)).then(
        (result): Response => new Response(null, { status: result.status }),
      );
      return delivery;
    },
  );
  const request = {
    operation: "fetch",
    projectId: "private-sync-project",
    userInitiated: true,
  } as const;
  await expect(api.fetchGitDeliverySyncExecute(request)).resolves.toMatchObject({
    upstream: { ref: "private-sync-ref" },
  });
  expect(bodies).toEqual([]);
  await expect(api.fetchGitDeliverySyncExecute(request)).rejects.toMatchObject({
    code: "CONTRACT_VALIDATION_FAILED",
    status: 502,
    correlationId: "git-sync-response-scenario",
  });
  expect(bodies).toHaveLength(1);
  if (delivery === undefined) throw new TypeError("diagnostic delivery required");
  expect((await delivery).status).toBe(204);
  expect(executions).toBe(2);
  for (const privateValue of ["private-sync-branch", "private-sync-ref", "private-sync-project"])
    expect(bodies[0]).not.toContain(privateValue);
}

interface WorkspaceTrustFixture {
  readonly fetchWorkspaceTrustStatus: (projectId: string) => Promise<unknown>;
  readonly mutateWorkspaceTrust: (projectId: string, mutation: "grant") => Promise<unknown>;
  readonly WORKSPACE_TRUST_CHANGED_EVENT: string;
}

function trustStatusResponse(empty: boolean): Response {
  return new Response(
    empty
      ? null
      : JSON.stringify({
          kind: "workspace-trust-status",
          schemaVersion: WORKSPACE_TRUST_SCHEMA_VERSION,
          projectId: "private-trust-project",
          trust: "trusted",
          decidedBy: "server",
          reason: "human-grant",
          revision: 1,
        }),
    {
      status: empty ? 204 : 200,
      headers: { "X-Keiko-Correlation-Id": "trust-204-response-scenario" },
    },
  );
}

async function driveTrust204Refusal(context: (body: string) => RouteContext): Promise<void> {
  const api = await vi.importActual<WorkspaceTrustFixture>(
    "../../packages/keiko-ui/src/lib/workspace-trust-api.js",
  );
  const { diagnostics, transport } = await loadGitDiagnosticFixture();
  resetGitDiagnosticFixture();
  diagnostics.setClientDiagnosticWriter(transport.fanOutClientDiagnostic);
  vi.spyOn(console, "warn").mockImplementation((): void => undefined);
  const browser = new EventTarget();
  vi.stubGlobal("window", browser);
  const changes = vi.fn();
  browser.addEventListener(api.WORKSPACE_TRUST_CHANGED_EVENT, changes);
  let empty = false;
  let requests = 0;
  const bodies: string[] = [];
  const deliveries: Promise<Response>[] = [];
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      if (typeof input === "string" && input.startsWith("/api/editor/verification/trust")) {
        requests += 1;
        return trustStatusResponse(empty);
      }
      if (input !== "/api/diagnostics/client" || typeof init?.body !== "string")
        throw new TypeError("unexpected fixture request");
      bodies.push(init.body);
      const delivery = handleClientDiagnosticIngest(context(init.body)).then(
        (result): Response => new Response(null, { status: result.status }),
      );
      deliveries.push(delivery);
      return delivery;
    },
  );
  await expect(api.fetchWorkspaceTrustStatus("private-trust-project")).resolves.toMatchObject({
    trust: "trusted",
  });
  expect(bodies).toEqual([]);
  empty = true;
  for (const action of [
    (): Promise<unknown> => api.fetchWorkspaceTrustStatus("private-trust-project"),
    (): Promise<unknown> => api.mutateWorkspaceTrust("private-trust-project", "grant"),
  ])
    await expect(action()).rejects.toMatchObject({
      code: "CONTRACT_VALIDATION_FAILED",
      status: 502,
      correlationId: "trust-204-response-scenario",
    });
  expect(requests).toBe(3);
  expect(changes).not.toHaveBeenCalled();
  expect(bodies).toHaveLength(2);
  expect((await Promise.all(deliveries)).map((response) => response.status)).toEqual([204, 204]);
  for (const body of bodies) {
    expect(body).toContain('"errorClass":"ApiError"');
    expect(body).toContain('"frames":[]');
    expect(body).toContain('"causeChain":[]');
  }
  expect(bodies.join("\n")).not.toContain("private-trust-project");
}

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
    setSupportIncidentTriggerForTests(undefined);
    resetServerLogger();
    resetClientDiagnosticsIngestStateForTests();
    resetGitDiagnosticFixture();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("reconstructs a scope notice and evidence inspection failure in one complete private report", async () => {
    const startedAtMs = Date.now();
    const frames = ["dist/ui/static/_next/static/chunks/1wntg-7ptuw73.js:12:345"];
    const envelope = {
      message: "private-client-text-canary",
      clientTs: CLIENT_TS,
      correlationId: CORRELATION_ID,
    };
    const notice = await handleClientDiagnosticIngest(
      context(
        JSON.stringify({
          ...envelope,
          scopeNotice: { reason: "narrowed-to-file", scopeKind: "files", pathCount: 1 },
        }),
      ),
    );
    const inspection = await handleClientDiagnosticIngest(
      context(
        JSON.stringify({
          ...envelope,
          evidenceInspection: { reason: "manifest-fetch-failed" },
          errorKind: "unavailable",
          errorEvidence: { errorClass: "TypeError", frames, causeChain: ["TypeError"] },
        }),
      ),
    );
    expect(notice.status).toBe(204);
    expect(inspection.status).toBe(204);
    const trace = await expectActivityLogScenario("client-diagnostics.dependency-failure", {
      stateDir,
      startedAtMs,
      expectedOps: ["client.scope.notice", "client.evidence.inspected"],
    });
    expect(trace.failureClasses).toEqual(
      expect.arrayContaining(["client-scope-notice", "client-evidence-inspection"]),
    );
    const log = readPersistedActivityLog(stateDir);
    expect(log).not.toContain("private-client-text-canary");
    const inspected = parsedLine(persistedActivityLogLines(log, "client.evidence.inspected")[0]);
    expect(inspected).toMatchObject({
      reason: "manifest-fetch-failed",
      errorKind: "unavailable",
      causeChain: ["TypeError"],
    });
    expect(inspected.frames).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /^dist\/ui\/static\/_next\/static\/chunks\/sha256-[a-f0-9]+\.js:12:345$/u,
        ),
      ]),
    );
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

  it("persists actual Git response contract refusal through the browser transport and analyzer", async () => {
    const startedAtMs = Date.now();
    await driveGitScopeRefusal(context);
    const lines = persistedActivityLogLines(
      readPersistedActivityLog(stateDir),
      "client.diagnostic",
    );
    expect(lines).toHaveLength(1);
    expect(parsedLine(lines[0])).toMatchObject({
      correlationId: "git-scope-response-scenario",
      clientKind: "other",
      errorKind: "validation-failed",
      completeness: "complete",
      loss: "none",
    });
    const trace = await expectActivityLogScenario("client-diagnostics.dependency-failure", {
      stateDir,
      startedAtMs,
      expectedOps: ["client.diagnostic"],
    });
    expect(trace.failureClasses).toContain("client-diagnostic");
    expect(readPersistedActivityLog(stateDir)).not.toContain("private-git-root");
    expect(readPersistedActivityLog(stateDir)).not.toContain("private git diff body");
  });

  it("persists a malformed Git sync response without replaying the mutation", async () => {
    const startedAtMs = Date.now();
    await driveGitSyncRefusal(context);
    const log = readPersistedActivityLog(stateDir);
    const lines = persistedActivityLogLines(log, "client.diagnostic");
    expect(lines).toHaveLength(1);
    expect(parsedLine(lines[0])).toMatchObject({
      correlationId: "git-sync-response-scenario",
      clientKind: "other",
      errorKind: "validation-failed",
      completeness: "complete",
      loss: "none",
    });
    const trace = await expectActivityLogScenario("client-diagnostics.dependency-failure", {
      stateDir,
      startedAtMs,
      expectedOps: ["client.diagnostic"],
    });
    expect(trace.failureClasses).toContain("client-diagnostic");
    for (const privateValue of ["private-sync-branch", "private-sync-ref", "private-sync-project"])
      expect(log).not.toContain(privateValue);
  });

  it("persists each actual 204 trust refusal without a false change announcement or replay", async () => {
    const startedAtMs = Date.now();
    await driveTrust204Refusal(context);
    const log = readPersistedActivityLog(stateDir);
    const lines = persistedActivityLogLines(log, "client.diagnostic");
    expect(lines).toHaveLength(2);
    for (const line of lines)
      expect(parsedLine(line)).toMatchObject({
        correlationId: "trust-204-response-scenario",
        clientKind: "other",
        errorKind: "validation-failed",
        completeness: "complete",
        loss: "none",
        errorClass: "ApiError",
      });
    const trace = await expectActivityLogScenario("client-diagnostics.dependency-failure", {
      stateDir,
      startedAtMs,
      expectedOps: ["client.diagnostic"],
    });
    expect(trace.failureClasses).toContain("client-diagnostic");
    expect(log).not.toContain("private-trust-project");
    expect(log).not.toContain("/api/editor/verification/trust");
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

  it("rejects an incoherent client-only preparation without losing the valid retry", async () => {
    setSupportIncidentTriggerForTests(true);
    const startedAtMs = Date.now();
    const report = createClientOnlySupportReport(CORRELATION_ID, "service-unavailable");
    const preparation = {
      reportBytes: Buffer.byteLength(report.reportJson, "utf8"),
      evidenceScope: report.evidenceScope,
      completeness: report.summary?.completeness,
      loss: report.summary?.loss,
      availabilityReason: report.summary?.availabilityReason,
    };
    const diagnostic = {
      message: "Keiko support report prepared locally.",
      clientTs: CLIENT_TS,
      correlationId: "ui_report-rejection-0001",
      supportReportPreparation: preparation,
    };
    expect(
      (
        await handleClientDiagnosticIngest(
          context(
            JSON.stringify({
              ...diagnostic,
              supportReportPreparation: { ...preparation, loss: "event-dropped" },
            }),
          ),
        )
      ).status,
    ).toBe(400);
    expect(
      persistedActivityLogLines(
        readPersistedActivityLog(stateDir),
        "client.support-report.prepared",
      ),
    ).toEqual([]);
    expect((await handleClientDiagnosticIngest(context(JSON.stringify(diagnostic)))).status).toBe(
      204,
    );

    expect(
      (
        await handleClientDiagnosticIngest(
          context(
            JSON.stringify({
              message: "Keiko local support report preparation failed.",
              clientTs: CLIENT_TS,
              correlationId: "ui_report-rejection-0001",
              supportReportPreparation: {
                outcome: "failed",
                errorKind: "unavailable",
                durationMs: 12,
              },
            }),
          ),
        )
      ).status,
    ).toBe(204);
    drainSupportIncidentCandidates();
    expect(listSupportIncidents(stateDir, { readOnly: true })).toEqual([]);
    const failures = persistedActivityLogLines(
      readPersistedActivityLog(stateDir),
      "client.support-report.preparation-failed",
    );
    expect(failures).toHaveLength(1);
    expect(parsedLine(failures[0])).toMatchObject({ level: "info" });
    const trace = await expectActivityLogScenario("client-diagnostics.rejection", {
      stateDir,
      startedAtMs,
      expectedOps: [
        "client.diagnostic.rejected",
        "client.support-report.prepared",
        "client.support-report.preparation-failed",
      ],
    });
    expect(trace.failureClasses).toEqual(
      expect.arrayContaining(["client-diagnostic-rejection", "support-report"]),
    );
    const prepared = persistedActivityLogLines(
      readPersistedActivityLog(stateDir),
      "client.support-report.prepared",
    );
    expect(prepared).toHaveLength(1);
    expect(parsedLine(prepared[0])).toMatchObject({
      evidenceScope: "client-only",
      reportCompleteness: preparation.completeness,
      reportLoss: preparation.loss,
      completeness: "complete",
      loss: "none",
    });
    expect(readPersistedActivityLog(stateDir)).not.toContain(report.reportJson);
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
      incidents: PACKAGED_INCIDENTS,
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
    // `reportProcessStarted` writes the lifetime's start right before it starts the heartbeat. A
    // heartbeat without that start is one whose start retention removed, so the scenario keeps the
    // production order.
    activityLog.write(fixtureEvent({ op: "process.started" }));
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
      incidents: PACKAGED_INCIDENTS,
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
