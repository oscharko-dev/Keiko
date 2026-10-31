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
import {
  analyzeLogText,
  createClientOnlySupportReport,
} from "@oscharko-dev/keiko-activity-log/reader";

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
import {
  GIT_EDITOR_SCHEMA_VERSION,
  GIT_EDITOR_DIFF_MAX_BYTES,
  GIT_EDITOR_DIFF_MAX_FILES,
  GIT_EDITOR_BLAME_MAX_BYTES,
  GIT_EDITOR_BLAME_MAX_LINES,
} from "@oscharko-dev/keiko-contracts/runtime/git-editor";

// The ui scenarios write through the built package, so their incidents come from it too: one
// Activity Log writer instance per process (activity-log-scenario.ts).
const PACKAGED_INCIDENTS: ScenarioIncidentRecorders = {
  recordRegisteredFailureIncident,
  recordUserReportedIncident,
};

interface GitApiFixture {
  readonly fetchGitStructuredDiff: (input: {
    readonly root: string;
    readonly scope: "staged";
  }) => Promise<unknown>;
  readonly fetchGitBlame: (input: {
    readonly root: string;
    readonly path: string;
    readonly startLine: number;
    readonly maxLines: number;
  }) => Promise<unknown>;
  readonly fetchGitDiff: (input: { readonly root: string }) => Promise<unknown>;
  readonly fetchGitDeliverySyncExecute: (input: {
    readonly operation: "fetch";
    readonly projectId: string;
    readonly userInitiated: true;
  }) => Promise<unknown>;
}
interface CommandApiFixture {
  readonly fetchCommandCatalog: (projectId: string) => Promise<unknown>;
  readonly createCommandRun: (input: {
    readonly projectId: string;
    readonly taskId: string;
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
      api.fetchGitStructuredDiff,
      api.fetchGitBlame,
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

// Answers the fixture's upstream reads through `upstream` and forwards every client diagnostic to
// the real ingest route, so a test sees each delivered body and its route status.
function stubDiagnosticForwardingFetch(
  context: (body: string) => RouteContext,
  upstream: (input: string, init?: RequestInit) => Response | undefined,
): { readonly bodies: string[]; readonly expectSingleDelivery: () => Promise<void> } {
  const bodies: string[] = [];
  let delivery: Promise<Response> | undefined;
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      if (typeof input !== "string") throw new TypeError("fixture string request required");
      const response = upstream(input, init);
      if (response !== undefined) return response;
      if (input !== "/api/diagnostics/client" || typeof init?.body !== "string")
        throw new TypeError("unexpected fixture request");
      bodies.push(init.body);
      delivery = handleClientDiagnosticIngest(context(init.body)).then(
        (result): Response => new Response(null, { status: result.status }),
      );
      return delivery;
    },
  );
  const expectSingleDelivery = async (): Promise<void> => {
    expect(bodies).toHaveLength(1);
    if (delivery === undefined) throw new TypeError("diagnostic delivery required");
    expect((await delivery).status).toBe(204);
  };
  return { bodies, expectSingleDelivery };
}

async function driveGitScopeRefusal(context: (body: string) => RouteContext): Promise<void> {
  let malformed = false;
  const { api, diagnostics, transport } = await loadGitDiagnosticFixture();
  resetGitDiagnosticFixture();
  diagnostics.setClientDiagnosticWriter(transport.fanOutClientDiagnostic);
  vi.spyOn(console, "warn").mockImplementation((): void => undefined);
  const { bodies, expectSingleDelivery } = stubDiagnosticForwardingFetch(context, (input) =>
    input.startsWith("/api/git/diff?") ? gitScopeResponse(malformed) : undefined,
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
  await expectSingleDelivery();
  expect(bodies[0]).not.toContain("private-git-root");
  expect(bodies[0]).not.toContain("private git diff body");
  expect(bodies[0]).not.toContain("scope invalid");
}

function structuredGitResponse(kind: "structured-diff" | "blame", malformed: boolean): Response {
  const payload =
    kind === "structured-diff"
      ? {
          schemaVersion: GIT_EDITOR_SCHEMA_VERSION,
          scope: "staged",
          files: [],
          truncated: false,
          totalFiles: 0,
          totalBytes: 0,
          maxBytes: GIT_EDITOR_DIFF_MAX_BYTES,
          maxFiles: GIT_EDITOR_DIFF_MAX_FILES,
        }
      : {
          schemaVersion: GIT_EDITOR_SCHEMA_VERSION,
          path: "private-git-file",
          startLine: 1,
          lines: [],
          truncated: false,
          totalLines: 0,
          totalBytes: 0,
          maxBytes: GIT_EDITOR_BLAME_MAX_BYTES,
          maxLines: GIT_EDITOR_BLAME_MAX_LINES,
        };
  return new Response(JSON.stringify(malformed ? "private-git-json-body" : payload), {
    headers: {
      "Content-Type": "application/json",
      "X-Keiko-Correlation-Id": `git-${kind}-response-scenario`,
    },
  });
}

async function driveStructuredGitRefusal(
  context: (body: string) => RouteContext,
  kind: "structured-diff" | "blame",
): Promise<void> {
  let malformed = false;
  const { api, diagnostics, transport } = await loadGitDiagnosticFixture();
  resetGitDiagnosticFixture();
  diagnostics.setClientDiagnosticWriter(transport.fanOutClientDiagnostic);
  vi.spyOn(console, "warn").mockImplementation((): void => undefined);
  const prefix = kind === "structured-diff" ? "/api/git/diff/structured?" : "/api/git/blame?";
  const { bodies, expectSingleDelivery } = stubDiagnosticForwardingFetch(context, (input) =>
    input.startsWith(prefix) ? structuredGitResponse(kind, malformed) : undefined,
  );
  const read = (): Promise<unknown> =>
    kind === "structured-diff"
      ? api.fetchGitStructuredDiff({ root: "/private-git-root", scope: "staged" })
      : api.fetchGitBlame({
          root: "/private-git-root",
          path: "private-git-file",
          startLine: 1,
          maxLines: 1,
        });
  await expect(read()).resolves.toMatchObject({ schemaVersion: GIT_EDITOR_SCHEMA_VERSION });
  expect(bodies).toEqual([]);
  malformed = true;
  const failure = await read().catch((error: unknown): unknown => error);
  await expectSingleDelivery();
  expect(failure).toMatchObject({
    code: "CONTRACT_VALIDATION_FAILED",
    status: 502,
    correlationId: `git-${kind}-response-scenario`,
  });
  for (const value of ["private-git-root", "private-git-file", "private-git-json-body"])
    expect(bodies[0]).not.toContain(value);
}

function commandResponse(kind: "catalog" | "run", malformed: boolean): Response {
  const payload =
    kind === "catalog"
      ? { schemaVersion: "1", projectId: "/private-command-project", tasks: [] }
      : {
          schemaVersion: "1",
          runId: "command-scenario",
          taskId: "npm-script:test",
          kind: "test",
          exitCode: 0,
          durationMs: 1,
          truncated: false,
          timedOut: false,
          failureReason: "none",
          stdout: "private-command-output",
          stderr: "",
        };
  return new Response(JSON.stringify(malformed ? "private-command-body" : payload), {
    headers: {
      "Content-Type": "application/json",
      "X-Keiko-Correlation-Id": `command-${kind}-response-scenario`,
    },
  });
}

async function loadCommandDiagnosticFixture(): Promise<CommandApiFixture> {
  const api = await vi.importActual<CommandApiFixture>(
    "../../packages/keiko-ui/src/lib/commands-api.js",
  );
  if (typeof api.fetchCommandCatalog !== "function" || typeof api.createCommandRun !== "function")
    throw new TypeError("actual command exports required");
  const { diagnostics, transport } = await loadGitDiagnosticFixture();
  resetGitDiagnosticFixture();
  diagnostics.setClientDiagnosticWriter(transport.fanOutClientDiagnostic);
  vi.spyOn(console, "warn").mockImplementation((): void => undefined);
  return api;
}

async function driveCommandRefusal(
  context: (body: string) => RouteContext,
  kind: "catalog" | "run",
): Promise<void> {
  const api = await loadCommandDiagnosticFixture();
  let malformed = false;
  let commandCalls = 0;
  const { bodies, expectSingleDelivery } = stubDiagnosticForwardingFetch(context, (input) => {
    if (!input.startsWith("/api/commands/")) return undefined;
    commandCalls += 1;
    return commandResponse(kind, malformed);
  });
  const read = (): Promise<unknown> =>
    kind === "catalog"
      ? api.fetchCommandCatalog("/private-command-project")
      : api.createCommandRun({ projectId: "/private-command-project", taskId: "npm-script:test" });
  await expect(read()).resolves.toMatchObject({ schemaVersion: "1" });
  expect(bodies).toEqual([]);
  malformed = true;
  const failure = await read().catch((error: unknown): unknown => error);
  await expectSingleDelivery();
  expect(failure).toMatchObject({
    code: "CONTRACT_VALIDATION_FAILED",
    status: 502,
    correlationId: `command-${kind}-response-scenario`,
  });
  expect(commandCalls).toBe(2);
  expect(bodies[0]).not.toContain("private-command");
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
  const { api, diagnostics, transport } = await loadGitDiagnosticFixture();
  resetGitDiagnosticFixture();
  diagnostics.setClientDiagnosticWriter(transport.fanOutClientDiagnostic);
  vi.spyOn(console, "warn").mockImplementation((): void => undefined);
  const { bodies, expectSingleDelivery } = stubDiagnosticForwardingFetch(context, (input, init) => {
    if (input !== "/api/git-delivery/fetch/execute") return undefined;
    expect(init?.method).toBe("POST");
    executions += 1;
    return gitSyncResponse(executions > 1);
  });
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
  await expectSingleDelivery();
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

interface CatalogApiFixture {
  readonly fetchCapsules: (options: { readonly includeKnowledgePods: true }) => Promise<unknown>;
  readonly fetchCapsuleSets: (options: { readonly includeKnowledgePods: true }) => Promise<unknown>;
}

function catalogScenarioResponse(sets: boolean, malformed: boolean): Response {
  const headers = {
    "X-Keiko-Correlation-Id": sets
      ? "catalog-sets-response-scenario"
      : "catalog-capsules-response-scenario",
  };
  if (malformed && sets) return new Response(null, { status: 204, headers });
  const body = sets
    ? { capsuleSets: [] }
    : {
        capsules: malformed
          ? [{ id: "private-catalog-id", displayName: "private-catalog-label" }]
          : [],
      };
  return new Response(JSON.stringify(body), { headers });
}

async function driveCatalogRefusals(context: (body: string) => RouteContext): Promise<void> {
  const api = await vi.importActual<CatalogApiFixture>(
    "../../packages/keiko-ui/src/lib/local-knowledge-api.js",
  );
  const { diagnostics, transport } = await loadGitDiagnosticFixture();
  resetGitDiagnosticFixture();
  diagnostics.setClientDiagnosticWriter(transport.fanOutClientDiagnostic);
  vi.spyOn(console, "warn").mockImplementation((): void => undefined);
  let malformed = false;
  let requests = 0;
  const bodies: string[] = [];
  const deliveries: Promise<Response>[] = [];
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      if (typeof input === "string" && input.startsWith("/api/local-knowledge/")) {
        requests += 1;
        expect(input).toMatch(/includeKnowledgePods=1$/u);
        return catalogScenarioResponse(input.includes("capsule-sets"), malformed);
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
  await expect(api.fetchCapsules({ includeKnowledgePods: true })).resolves.toEqual({
    capsules: [],
  });
  await expect(api.fetchCapsuleSets({ includeKnowledgePods: true })).resolves.toEqual({
    capsuleSets: [],
  });
  expect(bodies).toEqual([]);
  malformed = true;
  await expect(api.fetchCapsules({ includeKnowledgePods: true })).rejects.toMatchObject({
    code: "CONTRACT_VALIDATION_FAILED",
    status: 502,
    correlationId: "catalog-capsules-response-scenario",
  });
  await expect(api.fetchCapsuleSets({ includeKnowledgePods: true })).rejects.toMatchObject({
    code: "CONTRACT_VALIDATION_FAILED",
    status: 502,
    correlationId: "catalog-sets-response-scenario",
  });
  expect(requests).toBe(4);
  expect(bodies).toHaveLength(2);
  expect((await Promise.all(deliveries)).map((response) => response.status)).toEqual([204, 204]);
  expect(bodies.join("\n")).not.toContain("private-catalog");
}

interface ShellRecoveryFixture {
  readonly resetPersistedShortcutOverrides: () => Promise<void>;
}

async function loadShellRecoveryFixture(): Promise<{
  recovery: ShellRecoveryFixture;
  diagnostics: ClientDiagnosticsFixture;
  transport: DiagnosticTransportFixture;
}> {
  const { api, diagnostics, transport } = await loadGitDiagnosticFixture();
  const summary = await vi.importActual("../../packages/keiko-ui/src/lib/client-error-summary.js");
  const evidence = await vi.importActual(
    "../../packages/keiko-ui/src/lib/client-error-evidence.js",
  );
  vi.doMock("@/lib/api", () => api);
  vi.doMock("@/lib/client-diagnostics", () => diagnostics);
  vi.doMock("@/lib/client-error-summary", () => summary);
  vi.doMock("@/lib/client-error-evidence", () => evidence);
  vi.doMock("@oscharko-dev/keiko-contracts/runtime/editor-m7", () => {
    throw new TypeError("private-shell-module endpoint unavailable");
  });
  const recovery = await vi.importActual<ShellRecoveryFixture>(
    "../../packages/keiko-ui/src/app/components/desktop/shellRecovery.js",
  );
  return { recovery, diagnostics, transport };
}

async function driveShellRecoveryLoadRefusal(
  context: (body: string) => RouteContext,
): Promise<readonly string[]> {
  const { recovery, diagnostics, transport } = await loadShellRecoveryFixture();
  diagnostics.setClientDiagnosticWriter(transport.fanOutClientDiagnostic);
  vi.spyOn(console, "warn").mockImplementation((): void => undefined);
  const bodies: string[] = [];
  const deliveries: Promise<Response>[] = [];
  const requests: string[] = [];
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      if (typeof input !== "string") throw new TypeError("fixture string request required");
      requests.push(input);
      if (input === "/api/editor/settings")
        return new Response(
          JSON.stringify({ userRevision: 4, workspaceRevision: 7, etag: "etag-1" }),
        );
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
  try {
    await expect(recovery.resetPersistedShortcutOverrides()).rejects.toThrow(
      /refused by 2 setting layers/u,
    );
    expect(requests.filter((path) => path !== "/api/diagnostics/client")).toEqual([
      "/api/editor/settings",
    ]);
    expect(bodies).toHaveLength(2);
    for (const body of bodies) {
      const payload = parsedLine(body);
      expect(payload.correlationId).toEqual(expect.any(String));
      expect(payload).toMatchObject({
        errorKind: "unavailable",
        errorEvidence: { errorClass: "Error", frames: [], causeChain: ["TypeError"] },
      });
    }
    expect((await Promise.all(deliveries)).map((response) => response.status)).toEqual([204, 204]);
    expect(bodies.join("\n")).not.toContain("private-shell-module");
    return bodies;
  } finally {
    for (const name of [
      "@/lib/api",
      "@/lib/client-diagnostics",
      "@/lib/client-error-summary",
      "@/lib/client-error-evidence",
      "@oscharko-dev/keiko-contracts/runtime/editor-m7",
    ])
      vi.doUnmock(name);
  }
}

interface ErrorClassificationFixture {
  readonly clientErrorEvidence: (error: unknown) => {
    readonly errorClass: string;
    readonly frames: readonly string[];
    readonly causeChain: readonly string[];
  };
}
interface ErrorDiagnosticFixture extends ClientDiagnosticsFixture {
  readonly reportClientDiagnostic: (
    message: string,
    meta: {
      readonly correlationId: string;
      readonly kind: "other";
      readonly errorKind: "unavailable";
      readonly errorEvidence: ReturnType<ErrorClassificationFixture["clientErrorEvidence"]>;
    },
  ) => void;
}

async function loadErrorClassificationFixture(): Promise<{
  evidence: ErrorClassificationFixture;
  diagnostics: ErrorDiagnosticFixture;
  transport: DiagnosticTransportFixture;
}> {
  const evidence = await vi.importActual<ErrorClassificationFixture>(
    "../../packages/keiko-ui/src/lib/client-error-evidence.js",
  );
  const diagnostics = await vi.importActual<ErrorDiagnosticFixture>(
    "../../packages/keiko-ui/src/lib/client-diagnostics.js",
  );
  const transport = await vi.importActual<DiagnosticTransportFixture>(
    "../../packages/keiko-ui/src/lib/install-client-diagnostics.js",
  );
  diagnostics.resetClientDiagnosticWriter();
  transport.resetClientDiagnosticPostStateForTests();
  resetGitDiagnosticFixture = (): void => {
    diagnostics.resetClientDiagnosticWriter();
    transport.resetClientDiagnosticPostStateForTests();
  };
  diagnostics.setClientDiagnosticWriter(transport.fanOutClientDiagnostic);
  return { evidence, diagnostics, transport };
}

function changingClassError(): { readonly error: Error; readonly reads: () => number } {
  const error = new Error("private-classification-message");
  // V8 must not lazily format a stack and consume the name observation under test.
  error.stack = "";
  let reads = 0;
  Object.defineProperty(error, "name", {
    get(): string {
      reads += 1;
      return reads === 1 ? "TypeError" : "private-second-name-canary";
    },
  });
  return { error, reads: (): number => reads };
}

function unreadableClassErrors(): readonly unknown[] {
  const error = new Error("private-classification-message");
  error.stack = "";
  Object.defineProperty(error, "name", {
    get(): never {
      throw new Error("private-name-inspection");
    },
  });
  const prototype = new Proxy(
    {},
    {
      getPrototypeOf(): never {
        throw new Error("private-prototype-inspection");
      },
    },
  );
  return [error, prototype];
}

async function driveErrorClassificationReports(
  context: (body: string) => RouteContext,
): Promise<readonly string[]> {
  const { evidence, diagnostics } = await loadErrorClassificationFixture();
  const bodies: string[] = [];
  const deliveries: Promise<Response>[] = [];
  vi.spyOn(console, "warn").mockImplementation((): void => undefined);
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (input !== "/api/diagnostics/client" || typeof init?.body !== "string")
      throw new TypeError("expected actual browser diagnostic transport");
    bodies.push(init.body);
    const delivery = handleClientDiagnosticIngest(context(init.body)).then(
      (result): Response => new Response(null, { status: result.status }),
    );
    deliveries.push(delivery);
    return delivery;
  });
  const changing = changingClassError();
  const healthy = new TypeError("private-classification-message");
  healthy.stack = "";
  for (const [index, error] of [changing.error, healthy, ...unreadableClassErrors()].entries()) {
    const previous = deliveries.length;
    diagnostics.reportClientDiagnostic("Browser dependency unavailable.", {
      correlationId: `client-classification-scenario-${String(index)}`,
      kind: "other",
      errorKind: "unavailable",
      errorEvidence: evidence.clientErrorEvidence(error),
    });
    expect(deliveries).toHaveLength(previous + 1);
    const delivery = deliveries.at(-1);
    if (delivery === undefined) throw new TypeError("actual diagnostic delivery required");
    expect((await delivery).status).toBe(204);
  }
  expect(changing.reads()).toBe(1);
  return bodies;
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

  it("reconstructs actual read-once browser error classes and preserved inspection loss", async () => {
    const startedAtMs = Date.now();
    const bodies = await driveErrorClassificationReports(context);
    expect(bodies).toHaveLength(4);
    const log = readPersistedActivityLog(stateDir);
    const lines = persistedActivityLogLines(log, "client.diagnostic");
    expect(lines).toHaveLength(4);
    for (const [index, line] of lines.entries())
      expect(parsedLine(line)).toMatchObject({
        correlationId: `client-classification-scenario-${String(index)}`,
        errorClass: index < 2 ? "TypeError" : "Error",
        errorKind: "unavailable",
        completeness: "complete",
        loss: "none",
      });
    for (const index of [0, 1])
      expect(parsedLine(lines[index]).clientErrorsSuppressed).toBeUndefined();
    for (const index of [2, 3])
      expect(parsedLine(lines[index]).clientErrorsSuppressed).toBeGreaterThan(0);
    expect(activityLogLossCounters()["client-error-suppressed"]).toBeGreaterThan(0);
    const trace = await expectActivityLogScenario("client-diagnostics.dependency-failure", {
      stateDir,
      startedAtMs,
      expectedOps: ["client.diagnostic"],
    });
    expect(trace.failureClasses).toContain("client-diagnostic");
    const analysis = analyzeLogText(log);
    for (const privateValue of [
      "private-classification-message",
      "private-second-name-canary",
      "private-name-inspection",
      "private-prototype-inspection",
    ]) {
      expect(log).not.toContain(privateValue);
      expect(JSON.stringify(bodies)).not.toContain(privateValue);
      expect(JSON.stringify(analysis)).not.toContain(privateValue);
    }
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

  it("reconstructs actual structured-diff JSON refusal with its response correlation", async () => {
    const startedAtMs = Date.now();
    await driveStructuredGitRefusal(context, "structured-diff");
    const log = readPersistedActivityLog(stateDir);
    const lines = persistedActivityLogLines(log, "client.diagnostic");
    expect(lines).toHaveLength(1);
    expect(parsedLine(lines[0])).toMatchObject({
      correlationId: "git-structured-diff-response-scenario",
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
    for (const value of ["private-git-root", "private-git-file", "private-git-json-body"])
      expect(log).not.toContain(value);
  });

  it("reconstructs actual blame JSON refusal with its response correlation", async () => {
    const startedAtMs = Date.now();
    await driveStructuredGitRefusal(context, "blame");
    const log = readPersistedActivityLog(stateDir);
    const lines = persistedActivityLogLines(log, "client.diagnostic");
    expect(lines).toHaveLength(1);
    expect(parsedLine(lines[0])).toMatchObject({
      correlationId: "git-blame-response-scenario",
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
    for (const value of ["private-git-root", "private-git-file", "private-git-json-body"])
      expect(log).not.toContain(value);
  });

  it("reconstructs actual command catalog JSON refusal without replay", async () => {
    const startedAtMs = Date.now();
    await driveCommandRefusal(context, "catalog");
    const log = readPersistedActivityLog(stateDir);
    const lines = persistedActivityLogLines(log, "client.diagnostic");
    expect(lines).toHaveLength(1);
    expect(parsedLine(lines[0])).toMatchObject({
      correlationId: "command-catalog-response-scenario",
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
    expect(log).not.toContain("private-command");
  });

  it("reconstructs actual command run JSON refusal without replay", async () => {
    const startedAtMs = Date.now();
    await driveCommandRefusal(context, "run");
    const log = readPersistedActivityLog(stateDir);
    const lines = persistedActivityLogLines(log, "client.diagnostic");
    expect(lines).toHaveLength(1);
    expect(parsedLine(lines[0])).toMatchObject({
      correlationId: "command-run-response-scenario",
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
    expect(log).not.toContain("private-command");
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

  it("persists actual catalog malformed-200 and empty-204 refusals exactly once per request", async () => {
    const startedAtMs = Date.now();
    await driveCatalogRefusals(context);
    const log = readPersistedActivityLog(stateDir);
    const lines = persistedActivityLogLines(log, "client.diagnostic");
    expect(lines).toHaveLength(2);
    for (const [index, correlationId] of [
      "catalog-capsules-response-scenario",
      "catalog-sets-response-scenario",
    ].entries()) {
      expect(parsedLine(lines[index])).toMatchObject({
        correlationId,
        errorClass: "ApiError",
        errorKind: "validation-failed",
        completeness: "complete",
        loss: "none",
      });
    }
    const trace = await expectActivityLogScenario("client-diagnostics.dependency-failure", {
      stateDir,
      startedAtMs,
      expectedOps: ["client.diagnostic"],
    });
    expect(trace.failureClasses).toContain("client-diagnostic");
    expect(log).not.toContain("private-catalog");
    expect(log).not.toContain("/api/local-knowledge/");
  });

  it("persists each actual shell recovery contract-load refusal without a reset request", async () => {
    const startedAtMs = Date.now();
    const bodies = await driveShellRecoveryLoadRefusal(context);
    const log = readPersistedActivityLog(stateDir);
    const lines = persistedActivityLogLines(log, "client.diagnostic");
    expect(lines).toHaveLength(2);
    for (const [index, line] of lines.entries())
      expect(parsedLine(line)).toMatchObject({
        correlationId: parsedLine(bodies[index]).correlationId,
        errorKind: "unavailable",
        errorClass: "Error",
        completeness: "complete",
        loss: "none",
      });
    expect(new Set(bodies.map((body) => parsedLine(body).correlationId)).size).toBe(2);
    const trace = await expectActivityLogScenario("client-diagnostics.dependency-failure", {
      stateDir,
      startedAtMs,
      expectedOps: ["client.diagnostic"],
    });
    expect(trace.failureClasses).toContain("client-diagnostic");
    expect(log).not.toContain("private-shell-module");
    expect(log).not.toContain("/api/editor/settings");
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
