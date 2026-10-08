import { createBufferedServerLogSink } from "../../../../tests/support/buffered-server-log.js";

import { type ServerLogSink } from "@oscharko-dev/keiko-activity-log";
import { createHash } from "node:crypto";
import {
  accessSync,
  closeSync,
  fstatSync,
  openSync,
  chmodSync,
  constants,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { planLongLivedRuntimeSandbox } from "@oscharko-dev/keiko-sandbox";

import type { CodingWorkbenchRuntimeEvent } from "@oscharko-dev/keiko-contracts";
import { EDITOR_AGENT_CHANGESET_MAX_PATCH_BYTES } from "@oscharko-dev/keiko-contracts/runtime/editor-agent";
import { TOOL_CATALOG_LIMITS } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { GOVERNED_TOOL_HUMAN_DECISION_WAIT_MS } from "@oscharko-dev/keiko-contracts/runtime/tools";
import {
  DEFAULT_VERIFICATION_LIMITS,
  VERIFICATION_TOOL_MAX_DURATION_MS,
} from "@oscharko-dev/keiko-contracts/runtime/verification";
import {
  DEFAULT_SANDBOX_POLICY,
  GOVERNED_APPROVAL_TOOL_MAX_DURATION_MS,
} from "@oscharko-dev/keiko-contracts/runtime/tools";

import {
  defaultServerDiagnosticSink,
  type ServerDiagnosticRecord,
  type ServerDiagnosticSink,
} from "../diagnostics-log.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
  persistedActivityLogLines,
  readPersistedActivityLog,
} from "../../../../tests/support/activity-log-proof.js";
import type { PortableSidecarRuntimeVerification } from "../update-portable-sidecar-verification.js";
import {
  createRuntimeProcessSupervisor,
  type RuntimeProcessBackend,
  type RuntimeProcessTree,
  type RuntimeSupervisorLaunchRequest,
} from "./runtimeProcessSupervisor.js";
import type {
  CodingToolFacade,
  CodingToolFacadeInput,
  CodingToolNativeTextReadFacet,
  CodingToolNativeTextSnapshotResult,
} from "./codingToolFacadePorts.js";
import { createProductionManagedWorktreeToolFacade } from "./productionManagedWorktreeTools.js";
import {
  createSecureWorkspaceTextReadPort,
  secureWorkspaceTextDigest,
} from "./secureWorkspaceTextRead.js";
import {
  encodeSecureWorkspaceReadResponse,
  encodeSecureWorkspaceSnapshotResponse,
} from "./secureWorkspaceTextReadProtocol.js";
import type { SecureWorkspaceTextReadProcess } from "./secureWorkspaceTextReadProcess.js";
import {
  catalogRuntimeFixture,
  RUNTIME_NOW,
} from "../tool-catalog/__fixtures__/catalogRuntimeFixture.js";
import {
  productionRuntimeAuthorityFacts,
  type ProductionWorkspaceAuthorityInput,
} from "./productionRuntimeWorkspaceAuthority.js";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import { dirname } from "node:path";
import { createCodingToolFacade } from "./codingToolFacade.js";
import { createCodingToolInvocationRegistry } from "./codingToolInvocationRegistry.js";
import type { CodingSafeActivitySignal } from "./codingSafeActivityProjection.js";
import type {
  CodingRuntimeManager,
  OpenCodeLifecycleAdapter,
  OpenCodeLifecyclePrepareRequest,
  OpenCodeLifecyclePrepareResult,
} from "./codingRuntimeManager.js";
import {
  inspectOpenCodeServiceHostDisk,
  OPENCODE_SERVICE_HOST_DISK_EVIDENCE,
  type OpenCodeServiceHostDiskReceipt,
} from "./opencodeServiceHostArtifact.js";
import { attestPortableSidecarTreeSync } from "@oscharko-dev/keiko-security/portable-tree-attestation";
import type { CodingHistoryMessage } from "./codingRuntimeHistory.js";
import {
  createGeneratedOpenCodeV2Plugins,
  openCodeToolClientTimeoutMs,
  type OpenCodeGovernedSinkReceipt,
} from "./opencodeRuntimeAdapter.js";
import type { OpenCodeReconciliationEvent } from "./opencodeReconciler.js";
import {
  OPEN_CODE_V2_PINNED_PROTOCOL_SURFACE_SHA256,
  projectOpenCodeV2ProtocolSurface,
} from "./opencodeProtocolSurface.js";
import {
  OPENCODE_HISTORY_RESPONSE_MAX_BYTES,
  projectOpenCodePermissionRequestId,
} from "./opencodeProtocol.js";
import { capturedGeneratedV2Ask } from "./opencodeFunctionalHarness/_governedTools.js";
import { createOpenCodeV2HistoryProjection } from "./opencodeV2History.js";
import { CODING_TOOL_MAX_BODY_BYTES } from "./codingToolIpc.js";

const generatedToolSources = vi.hoisted(() => ({ passes: 0, utf8Bytes: 0 }));

// Observe the real source producer without replacing its generated tools or source definitions.
vi.mock("./opencodeToolSchemas.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./opencodeToolSchemas.js")>();
  return {
    ...actual,
    OPENCODE_TOOL_SOURCE_DEFINITIONS: new Proxy(actual.OPENCODE_TOOL_SOURCE_DEFINITIONS, {
      get(target, property, receiver): unknown {
        if (property !== "map") return Reflect.get(target, property, receiver) as unknown;
        return (...args: unknown[]): unknown => {
          const result: unknown = Reflect.apply(target.map.bind(target), target, args);
          generatedToolSources.passes += 1;
          if (Array.isArray(result)) {
            for (const entry of result as unknown[]) {
              if (Array.isArray(entry) && typeof entry[1] === "string") {
                generatedToolSources.utf8Bytes += Buffer.byteLength(entry[1], "utf8");
              }
            }
          }
          return result;
        };
      },
    }),
  };
});

const dirs: string[] = [];
const MODEL_CAPABILITY = "m".repeat(43);
const TOOL_CAPABILITY = "t".repeat(43);
// ADR-0043 D11-D14 (#3390): the fixed test double of the ONE attested loopback origin the tool
// facade rides -- the same origin `productionOpenCodeActivation.ts` derives `gatewayUrl` and
// `toolFacadeUrl` from in production, fixed here since this suite never binds a real BFF port.
const TOOL_FACADE_ORIGIN = "http://127.0.0.1:4391/api/coding-sidecar/tool";
const FIXTURE_RUN_ID = "run-2254";
const OPENCODE_VERSION = "2.0.10";
const FIXED_SESSION_TITLE = "Keiko governed runtime";
const OPENCODE_SCHEMA_SHA256 = "1362671d8cfdcb925b3a9fd61eaa20152e4c587746445a0b03504674b25c88ec";
// Captured structural projection from OpenCode 2.0.10's actual OpenAPI document.
const OPENAPI: unknown = JSON.parse(
  readFileSync(
    new URL("./opencodeProtocolSurface.opencode-2.0.10.fixture.json", import.meta.url),
    "utf8",
  ),
);
const PROTOCOL_HANDSHAKE_DIGEST = projectOpenCodeV2ProtocolSurface(OPENAPI).digest;

function materializedV2PluginPaths(runRoot: string): readonly string[] {
  return Object.keys(createGeneratedOpenCodeV2Plugins()).map((name) =>
    join(runRoot, "config", "opencode", "plugins", `${name}.ts`),
  );
}

interface OpenCodeRuntimeComposition {
  readonly prepareServiceHost: (
    request: OpenCodeLifecyclePrepareRequest,
    receipt: Extract<OpenCodeServiceHostDiskReceipt, { readonly ok: true }>,
  ) => Promise<OpenCodeLifecyclePrepareResult>;
  readonly manager: CodingRuntimeManager;
  readonly toolBridge: {
    readonly url: string;
    readonly requestDeadlineMs: number;
    readonly nativeTextRead?: CodingToolNativeTextReadFacet | undefined;
    handle(input: {
      readonly method: "POST";
      readonly headers: Headers;
      readonly body: string;
      readonly signal?: AbortSignal;
    }): Promise<{ readonly status: number; readonly body: string }>;
  };
  readonly runPort: {
    readonly submitTask: (runId: string, text: string, initialContext?: string) => Promise<boolean>;
    readonly abortTask: (runId: string) => Promise<boolean>;
    readonly waitForTerminal: (runId: string, signal: AbortSignal) => Promise<boolean>;
    readonly listQuestions: (runId: string) => Promise<readonly TestQuestionRequest[]>;
    readonly answerQuestion: (
      runId: string,
      requestId: string,
      answers: readonly (readonly string[])[],
    ) => Promise<boolean>;
    readonly rejectQuestion: (runId: string, requestId: string) => Promise<boolean>;
    readonly replyPermission: (
      runId: string,
      requestId: string,
      reply: "once" | "reject",
    ) => Promise<boolean>;
  };
}

interface TestQuestionRequest {
  readonly id: string;
  readonly sessionID: string;
  readonly questions: readonly {
    readonly question: string;
    readonly header: string;
    readonly options: readonly { readonly label: string; readonly description: string }[];
  }[];
}

interface OpenCodeRuntimeCompositionModule {
  readonly toolBridgeRequestDeadlineMs: (
    configuredDeadlineMs: number,
    body: string | undefined,
  ) => number;
  createOpenCodeRuntimeComposition(input: {
    readonly activityLog?: ServerLogSink;
    readonly canSpawnRuntime?: (request: Parameters<CodingRuntimeManager["start"]>[0]) => boolean;
    readonly toolProfile?: "direct" | "code-mode" | undefined;
    readonly portable: {
      readonly verification: PortableSidecarRuntimeVerification & {
        readonly protocolSchemaRawSha256: string;
        readonly protocolHandshakeDigest: string;
        readonly protocolHandshakeAlgorithm: "keiko-opencode-protocol-surface-v2";
      };
      readonly resourceRoot: string;
      readonly target: "macos-arm64";
    };
    readonly stateBaseRoot: string;
    readonly contextGeometry: {
      readonly contextWindowTokens: number;
      readonly maxInputTokens: number;
      readonly maxOutputTokens: number;
    };
    readonly capabilities: {
      readonly modelGatewayCapability: string;
      readonly toolFacadeCapability: string;
    };
    /** Private bridge limits are intentionally configurable for deterministic boundary tests. */
    readonly toolBridge?: {
      readonly requestDeadlineMs: number;
      readonly maxInFlight: number;
    };
    // ADR-0043 D11-D14 (#3390): mirrors `OpenCodeRuntimeCompositionInput.toolFacadeOrigin` --
    // the SAME single attested loopback origin the model gateway rides, never a second listener.
    readonly toolFacadeOrigin: string;
    readonly toolFacade: CodingToolFacade;
    readonly governedEventSink: {
      readonly execute: (
        identityKey: string,
        event: OpenCodeReconciliationEvent,
      ) => Promise<OpenCodeGovernedSinkReceipt>;
    };
    readonly safeActivity?: {
      readonly arm: (sessionId?: string, profile?: "direct" | "code-mode") => void;
      readonly beginTool?: (input: {
        readonly actionId: string;
        readonly tool: string;
        readonly occurredAt: string;
      }) => void;
      readonly clear: () => void;
      readonly ingest: (signal: CodingSafeActivitySignal) => boolean;
      readonly captureMessages?: (messages: readonly CodingHistoryMessage[]) => boolean;
      readonly recordDrops: (count: number) => void;
      readonly settleTool: (input: {
        readonly actionId: string;
        readonly delegateStarted?: true;
        readonly state: "succeeded" | "failed" | "denied" | "cancelled";
        readonly occurredAt: string;
      }) => void;
    };
    readonly onRuntimeEvent?: (event: CodingWorkbenchRuntimeEvent) => void;
    readonly onQuestionObserved?: (identity: string) => void;
    /** The run id under which each delivered tool result's model-facing rendering is recorded. */
    readonly toolResultCorrelationId?: string;
    readonly gatewayReadiness: {
      readonly waitForObservedRequest: (runId: string, signal: AbortSignal) => Promise<boolean>;
      readonly verifyObserved: (runId: string) => void;
      readonly clear: (runId: string, preserveVerification?: boolean) => void;
    };
    readonly fetch: typeof globalThis.fetch;
    readonly supervisor: ReturnType<typeof createRuntimeProcessSupervisor>;
    readonly authorityLifecycle: {
      readonly revokeRuntime: (runId: string) => boolean | Promise<boolean>;
      readonly abortInFlightActions: (runId: string) => boolean | Promise<boolean>;
      readonly markRuntimeRecoveryRequired: (runId: string) => boolean | Promise<boolean>;
      readonly releaseRuntimeAfterReap: (
        runId: string,
        receipt: unknown,
      ) => boolean | Promise<boolean>;
    };
  }): OpenCodeRuntimeComposition;
}

let loadedCompositionModule: OpenCodeRuntimeCompositionModule | undefined;

async function loadCompositionModule(): Promise<OpenCodeRuntimeCompositionModule> {
  const moduleName = "./opencodeRuntimeComposition.js";
  return (await import(moduleName)) as OpenCodeRuntimeCompositionModule;
}

function compositionModule(): Promise<OpenCodeRuntimeCompositionModule> {
  if (loadedCompositionModule === undefined) throw new Error("Composition module was not loaded");
  return Promise.resolve(loadedCompositionModule);
}

async function withDeterministicReadinessTimers<T>(
  operation: () => Promise<T>,
  beforeAdvance: Promise<void>,
): Promise<T> {
  vi.useFakeTimers();
  try {
    const pending = operation();
    await beforeAdvance;
    await vi.advanceTimersByTimeAsync(50);
    return await pending;
  } finally {
    vi.useRealTimers();
  }
}

function persistedDiagnostics(): { sink: ServerDiagnosticSink; read: () => string } {
  const stateDir = tempDir("keiko-opencode-diagnostics-");
  vi.stubEnv("KEIKO_STATE_DIR", stateDir);
  return { sink: defaultServerDiagnosticSink, read: () => readPersistedActivityLog(stateDir) };
}

function expectPersistedDiagnostic(raw: string, source: string): Record<string, unknown> {
  const lines = persistedActivityLogLines(raw, "server.diagnostic.failure").filter(
    (line) => (JSON.parse(line) as { source?: string }).source === source,
  );
  expect(lines).toHaveLength(1);
  const line = lines[0];
  if (line === undefined) throw new Error("Expected the persisted diagnostic");
  const record = expectActivityLogProof("server.diagnostic.failure.activity-log-line", line);
  expect(record).toMatchObject({
    correlationId: FIXTURE_RUN_ID,
    source,
    completeness: "complete",
    loss: "none",
  });
  return record;
}

function tempDir(prefix: string): string {
  const value = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(value);
  return value;
}

function requestPath(url: URL | RequestInfo): string {
  if (typeof url === "string") return new URL(url).pathname;
  if (url instanceof URL) return url.pathname;
  return new URL(url.url).pathname;
}

function v2Json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
  });
}

function v2Envelope(value: unknown): Response {
  return v2Json({ data: value });
}

function portableFixture(resourceRoot: string): {
  readonly executablePath: string;
  readonly verification: PortableSidecarRuntimeVerification & {
    readonly protocolSchemaRawSha256: string;
    readonly protocolHandshakeDigest: string;
    readonly protocolHandshakeAlgorithm: "keiko-opencode-protocol-surface-v2";
  };
} {
  const payloadRootPath = "runtime/sidecars/opencode-compatible";
  const payloadRoot = join(resourceRoot, payloadRootPath);
  const executablePath = join(payloadRoot, "opencode");
  mkdirSync(payloadRoot, { recursive: true });
  writeFileSync(executablePath, "#!/bin/sh\n", { mode: 0o755 });
  chmodSync(executablePath, 0o755);
  writeFileSync(join(payloadRoot, "LICENSE"), "approved license\n");
  writeFileSync(join(payloadRoot, "sbom.cdx.json"), '{"bomFormat":"CycloneDX"}\n');
  const digest = (path: string): string =>
    createHash("sha256").update(readFileSync(path)).digest("hex");
  const executableDigest = digest(executablePath);
  const licenseDigest = digest(join(payloadRoot, "LICENSE"));
  const sbomDigest = digest(join(payloadRoot, "sbom.cdx.json"));
  const executableTreeSha256 = createHash("sha256")
    .update(`opencode\0${executableDigest}\0`, "utf8")
    .digest("hex");
  const payloadSha256 = createHash("sha256")
    .update(
      `LICENSE\0${licenseDigest}\0opencode\0${executableDigest}\0sbom.cdx.json\0${sbomDigest}\0`,
      "utf8",
    )
    .digest("hex");
  return {
    executablePath,
    verification: {
      payloadRootPath,
      executablePath: `${payloadRootPath}/opencode`,
      shippedExecutableSha256: executableDigest,
      executableTreeSha256,
      licenseEvidencePath: `${payloadRootPath}/LICENSE`,
      licenseEvidenceSha256: licenseDigest,
      sbomEvidencePath: `${payloadRootPath}/sbom.cdx.json`,
      sbomEvidenceSha256: sbomDigest,
      summary: {
        name: "opencode-compatible",
        kind: "coding-runtime",
        upstreamName: "opencode",
        upstreamVersion: OPENCODE_VERSION,
        adapterName: "keiko-coding-sidecar",
        adapterVersion: "1",
        protocolVersion: "http-sse",
        platformTarget: "macos-arm64",
        payloadSha256,
        payloadSha256Prefix: payloadSha256.slice(0, 12),
        sizeBytes: 1,
        status: "verified",
      },
      availability: {
        redistributionApproved: true,
        payloadPresent: true,
        archiveDigestVerified: true,
        executableTreeDigestVerified: true,
        runtimeVersionVerified: true,
        protocolSchemaVerified: true,
        signatureVerified: true,
        qualificationVerified: true,
      },
      protocolSchemaRawSha256: OPENCODE_SCHEMA_SHA256,
      protocolHandshakeDigest: PROTOCOL_HANDSHAKE_DIGEST,
      protocolHandshakeAlgorithm: "keiko-opencode-protocol-surface-v2",
    },
  };
}

type FixtureSafeActivity = NonNullable<
  Parameters<
    OpenCodeRuntimeCompositionModule["createOpenCodeRuntimeComposition"]
  >[0]["safeActivity"]
>;

type ReadinessChallengePhase = "before-prompt" | "prompt-pending" | "aborted";

interface StartBridgeControl {
  readonly workspaceRoot?: string;
  readonly gatewayUrl?: string;
  readonly signal?: AbortSignal;
  readonly sessionLocation?: {
    readonly created?: "wrong" | "missing";
    readonly echoed?: "wrong" | "missing";
    readonly stages?: string[];
    readonly afterCreated?: () => void;
  };
  readonly toolFacadeCapability?: string;
  readonly readToolProfile?: () => "direct" | "code-mode";
  readonly canSpawnRuntime?: (request: Parameters<CodingRuntimeManager["start"]>[0]) => boolean;
  readonly onSpawn?: (() => void) | undefined;
  readonly stdinLifetime?: {
    readonly supports: true;
    readonly launches: RuntimeSupervisorLaunchRequest[];
    readonly pipe: PassThrough;
  };
  readonly activityLog?: ServerLogSink;
  readonly startTimeoutMs?: number;
  readonly shutdownTimeoutMs?: number;
  readonly onRelease?: (runId: string) => void;
  readonly historyResponse?: Promise<Response>;
  readonly historyResponseFactory?: (signal?: AbortSignal) => Promise<Response>;
  readonly expectedStart?: Readonly<Record<string, unknown>>;
  readonly onSseCancel?: () => void;
  readonly onSseStart?: (controller: ReadableStreamDefaultController<Uint8Array>) => void;
  readonly sessionCreateCalls?: string[];
  readonly sseFrame?: string;
  readonly historyCalls?: Readonly<Record<string, number>>[];
  readonly governedEvents?: OpenCodeReconciliationEvent[];
  readonly questionObservations?: string[];
  readonly safeActivity?: FixtureSafeActivity;
  readonly diagnostics?: ServerDiagnosticSink;
  /** Records each delivered tool result's rendering under this run id, on `activityLog`. */
  readonly toolResultCorrelationId?: string;
  readonly runtimeEvents?: CodingWorkbenchRuntimeEvent[];
  readonly mode?: "governed-assist" | "supervised-coding" | "autonomous-delivery";
  /** The gateway route refused the readiness challenge's model request (#3603). */
  readonly gatewayRefused?: boolean;
  readonly runControl?: {
    readonly promptBodies: string[];
    readonly abortSessions: string[];
    readonly statusResponses: unknown[];
    readonly statusResponseForReadinessPhase?: (phase: ReadinessChallengePhase) => unknown;
    readonly questionResponses?: unknown[];
    readonly onQuestionListFetch?: () => Promise<void> | void;
    readonly permissionResponses?: unknown[];
    readonly questionRequests?: {
      readonly method: string;
      readonly path: string;
      readonly body?: string;
    }[];
    readonly permissionRequests?: {
      readonly method: string;
      readonly path: string;
      readonly body?: string;
    }[];
  };
  readonly afterStart?: (
    runtime: OpenCodeRuntimeComposition,
    runRoot: string,
  ) => void | Promise<void>;
}

function optionalSpawnGuard(control: StartBridgeControl | undefined): {
  readonly canSpawnRuntime?: NonNullable<StartBridgeControl["canSpawnRuntime"]>;
} {
  return control?.canSpawnRuntime === undefined ? {} : { canSpawnRuntime: control.canSpawnRuntime };
}

function optionalSafeActivity(control: StartBridgeControl | undefined): {
  readonly safeActivity?: FixtureSafeActivity;
} {
  return control?.safeActivity === undefined ? {} : { safeActivity: control.safeActivity };
}

function optionalQuestionObservations(control: StartBridgeControl | undefined): {
  readonly onQuestionObserved?: (identity: string) => void;
} {
  const sink = control?.questionObservations;
  return sink === undefined
    ? {}
    : {
        onQuestionObserved: (identity: string): void => {
          sink.push(identity);
        },
      };
}

function optionalDiagnostics(control: StartBridgeControl | undefined): {
  readonly diagnostics?: ServerDiagnosticSink;
} {
  return control?.diagnostics === undefined ? {} : { diagnostics: control.diagnostics };
}

function optionalRuntimeEvents(control: StartBridgeControl | undefined): {
  readonly onRuntimeEvent?: (event: CodingWorkbenchRuntimeEvent) => void;
} {
  const sink = control?.runtimeEvents;
  return sink === undefined
    ? {}
    : {
        onRuntimeEvent: (event): void => {
          sink.push(event);
        },
      };
}

function runtimeMode(
  control: StartBridgeControl | undefined,
): NonNullable<StartBridgeControl["mode"]> {
  return control?.mode ?? "supervised-coding";
}

function optionalActivityLog(control: StartBridgeControl | undefined): {
  readonly activityLog?: ServerLogSink;
} {
  return control?.activityLog === undefined ? {} : { activityLog: control.activityLog };
}

function optionalToolResultCorrelation(control: StartBridgeControl | undefined): {
  readonly toolResultCorrelationId?: string;
} {
  return control?.toolResultCorrelationId === undefined
    ? {}
    : { toolResultCorrelationId: control.toolResultCorrelationId };
}

function fixtureStdinOwnership(control: StartBridgeControl | undefined): {
  readonly supportsStdinLifetime?: true;
  readonly stdin?: PassThrough;
} {
  return control?.stdinLifetime === undefined
    ? {}
    : { supportsStdinLifetime: true, stdin: control.stdinLifetime.pipe };
}

function fixtureStartupLine(
  request: RuntimeSupervisorLaunchRequest,
  control: StartBridgeControl | undefined,
): string {
  control?.stdinLifetime?.launches.push(request);
  return control?.stdinLifetime === undefined
    ? "server listening on http://127.0.0.1:43123\n"
    : '{"url":"http://127.0.0.1:43123"}\n';
}

function fixtureShutdownTimeout(control: StartBridgeControl | undefined): number {
  return control?.shutdownTimeoutMs ?? 20;
}

function fixtureRelease(control: StartBridgeControl | undefined, runId: string): true {
  control?.onRelease?.(runId);
  return true;
}

function fixtureWorkspaceRoot(root: string, control: StartBridgeControl | undefined): string {
  return control?.workspaceRoot ?? join(root, "workspace");
}

function fixtureToolCapability(control: StartBridgeControl | undefined): string {
  return control?.toolFacadeCapability ?? TOOL_CAPABILITY;
}

function fixtureToolFacade(facade: CodingToolFacade): CodingToolFacade {
  const nativeTextRead = facade.nativeTextRead;
  return {
    ...(nativeTextRead === undefined ? {} : { nativeTextRead }),
    execute: (input) =>
      input.body === '{"action":"permission-event","requestId":"keiko-readiness"}'
        ? Promise.resolve({ status: "observed", evidence: [] })
        : facade.execute(input),
  };
}

function fixtureGatewayUrl(control: StartBridgeControl | undefined): string {
  return control?.gatewayUrl ?? "http://127.0.0.1:1983/api/coding-sidecar/gateway";
}

function fixturePreparation(
  captured: RuntimeSupervisorLaunchRequest | undefined,
  executablePath: string,
  verification: PortableSidecarRuntimeVerification,
): OpenCodeLifecyclePrepareRequest {
  return {
    runId: FIXTURE_RUN_ID,
    executablePath,
    env: captured?.env ?? {},
    verification,
    timeoutMs: 100,
  };
}

/** Exact Info.location.directory shape qualified by original pinned native HTTP create/get. */
function fixtureNativeSession(
  id: string,
  directory: string,
  stage: "created" | "echoed",
  control: StartBridgeControl | undefined,
): Readonly<Record<string, unknown>> {
  const locationControl = control?.sessionLocation;
  locationControl?.stages?.push(stage);
  if (stage === "created") locationControl?.afterCreated?.();
  const disposition = locationControl?.[stage];
  return {
    id,
    ...(disposition === "missing"
      ? {}
      : {
          location: {
            directory: disposition === "wrong" ? join(directory, "other-workspace") : directory,
          },
        }),
  };
}

function fixtureSignal(control: StartBridgeControl | undefined): AbortSignal | undefined {
  return control?.signal;
}

async function startBridgeFixture(
  facade: CodingToolFacade,
  toolBridge: { readonly requestDeadlineMs: number; readonly maxInFlight: number } = {
    requestDeadlineMs: 50,
    maxInFlight: 1,
  },
  control?: StartBridgeControl,
): Promise<{
  readonly runtime: OpenCodeRuntimeComposition;
  readonly preparation: OpenCodeLifecyclePrepareRequest;
  stop(): Promise<void>;
}> {
  const root = tempDir("keiko-opencode-tool-bridge-");
  const resourceRoot = join(root, "resources");
  const portable = portableFixture(resourceRoot);
  mkdirSync(join(root, "workspace"), { recursive: true });
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let capturedLaunch: RuntimeSupervisorLaunchRequest | undefined;
  const supervisor = createRuntimeProcessSupervisor({
    backend: {
      identity: { platform: "darwin", arch: "arm64", backend: "macos-app-sandbox" },
      ...fixtureStdinOwnership(control),
      spawnOwnedTree: (request): RuntimeProcessTree => {
        capturedLaunch = request;
        control?.onSpawn?.();
        stdout.end(fixtureStartupLine(request, control));
        return {
          treeId: "tool-bridge-tree",
          stdout,
          stderr,
          ...fixtureStdinOwnership(control),
          onTreeExit: (): void => undefined,
        };
      },
      signalTree: (): void => undefined,
      waitForCompleteTreeExit: (): Promise<true> => {
        stderr.end();
        return Promise.resolve(true);
      },
      reconcileTreeExit: (): Promise<false> => Promise.resolve(false),
    },
    qualifications: [
      {
        platform: "darwin",
        arch: "arm64",
        backend: "macos-app-sandbox",
        releaseReceipt: `sha256:${"a".repeat(64)}`,
      },
    ],
    planSandbox: (request) =>
      planLongLivedRuntimeSandbox(
        request,
        { bubblewrap: false, unshare: false, seatbelt: true, docker: false, podman: false },
        "darwin",
      ),
  });
  const sseFrame = new TextEncoder().encode(
    control?.sseFrame ?? 'data: {"id":"evt_server","type":"server.connected","data":{}}\n\n',
  );
  let readinessChallengePhase: ReadinessChallengePhase = "before-prompt";
  // eslint-disable-next-line complexity -- finite mock endpoint table is intentionally explicit.
  const fetch = vi.fn((url: URL | RequestInfo, init?: RequestInit) => {
    const path = requestPath(url);
    if (path === "/api/info" && new Headers(init?.headers).get("authorization") === null)
      return Promise.resolve(new Response("", { status: 401 }));
    if (path === "/api/info") return Promise.resolve(v2Json({ version: OPENCODE_VERSION }));
    if (path === "/openapi.json") return Promise.resolve(v2Json(OPENAPI));
    if (path === "/api/event") {
      let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined;
      let cancelled = false;
      const onCancel = (): void => {
        if (cancelled) return;
        cancelled = true;
        control?.onSseCancel?.();
      };
      init?.signal?.addEventListener(
        "abort",
        () => {
          onCancel();
          try {
            controllerRef?.close();
          } catch {
            // The V2 stream may already have ended before the test aborts its fetch.
          }
        },
        { once: true },
      );
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller): void {
              controllerRef = controller;
              control?.onSseStart?.(controller);
              controller.enqueue(sseFrame);
            },
            cancel(): void {
              onCancel();
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
      );
    }
    if (path === "/api/session/ses_tool/message") {
      control?.historyCalls?.push({});
      if (control?.historyResponseFactory !== undefined)
        return control.historyResponseFactory(init?.signal ?? undefined);
      return control?.historyResponse ?? Promise.resolve(v2Envelope([]));
    }
    if (path.endsWith("/prompt")) {
      control?.sessionLocation?.stages?.push("prompt");
      if (typeof init?.body === "string" && init.body.includes("runtime readiness handshake")) {
        readinessChallengePhase = "prompt-pending";
      } else if (typeof init?.body === "string") {
        control?.runControl?.promptBodies.push(init.body);
      }
      return Promise.resolve(v2Envelope({}));
    }
    if (path.endsWith("/interrupt")) {
      if (readinessChallengePhase === "prompt-pending") readinessChallengePhase = "aborted";
      else control?.runControl?.abortSessions.push(path.split("/")[3] ?? "");
      return Promise.resolve(v2Envelope({}));
    }
    if (path === "/api/session/active") {
      const statuses = control?.runControl?.statusResponses;
      const value =
        control?.runControl?.statusResponseForReadinessPhase?.(readinessChallengePhase) ??
        (statuses?.length === 1 ? statuses[0] : statuses?.shift());
      return Promise.resolve(v2Envelope(value ?? {}));
    }
    if (path === "/api/form") {
      const responses = control?.runControl?.questionResponses;
      const value = responses?.length === 1 ? responses[0] : responses?.shift();
      const respond = (): Response => v2Envelope(value ?? []);
      const raced = control?.runControl?.onQuestionListFetch?.();
      return raced instanceof Promise ? raced.then(respond) : Promise.resolve(respond());
    }
    if (path.includes("/form/")) {
      control?.runControl?.questionRequests?.push({
        method: init?.method ?? "GET",
        path,
        ...(typeof init?.body === "string" ? { body: init.body } : {}),
      });
      return Promise.resolve(v2Envelope({}));
    }
    if (path === "/api/permission/request") {
      const responses = control?.runControl?.permissionResponses;
      const value = responses?.length === 1 ? responses[0] : responses?.shift();
      return Promise.resolve(v2Envelope(value ?? []));
    }
    if (path.includes("/permission/")) {
      control?.runControl?.permissionRequests?.push({
        method: init?.method ?? "GET",
        path,
        ...(typeof init?.body === "string" ? { body: init.body } : {}),
      });
      return Promise.resolve(v2Envelope({}));
    }
    if (path === "/api/session" && init?.method === "POST") {
      control?.sessionCreateCalls?.push("ses_tool");
      return Promise.resolve(
        v2Envelope(fixtureNativeSession("ses_tool", capturedLaunch?.cwd ?? "", "created", control)),
      );
    }
    if (path === "/api/session")
      return Promise.resolve(
        v2Envelope([
          fixtureNativeSession("ses_tool", capturedLaunch?.cwd ?? "", "echoed", control),
        ]),
      );
    return Promise.resolve(new Response("", { status: 404 }));
  }) as unknown as typeof globalThis.fetch;
  const runtime = (await compositionModule()).createOpenCodeRuntimeComposition({
    get toolProfile(): "direct" | "code-mode" | undefined {
      return control?.readToolProfile?.();
    },
    portable: { verification: portable.verification, resourceRoot, target: "macos-arm64" },
    stateBaseRoot: join(root, "state"),
    contextGeometry: {
      contextWindowTokens: 65_536,
      maxInputTokens: 61_440,
      maxOutputTokens: 4_096,
    },
    capabilities: {
      modelGatewayCapability: MODEL_CAPABILITY,
      toolFacadeCapability: fixtureToolCapability(control),
    },
    toolBridge,
    toolFacadeOrigin: TOOL_FACADE_ORIGIN,
    toolFacade: fixtureToolFacade(facade),
    governedEventSink: {
      execute: (_identityKey, event): Promise<"applied"> => {
        control?.governedEvents?.push(event);
        return Promise.resolve("applied");
      },
    },
    ...optionalSafeActivity(control),
    ...optionalQuestionObservations(control),
    ...optionalDiagnostics(control),
    ...optionalActivityLog(control),
    ...optionalToolResultCorrelation(control),
    ...optionalRuntimeEvents(control),
    ...optionalSpawnGuard(control),
    gatewayReadiness: {
      waitForObservedRequest: (): Promise<boolean> =>
        Promise.resolve(control?.gatewayRefused !== true),
      verifyObserved: (): void => undefined,
      clear: (): void => undefined,
    },
    fetch,
    supervisor,
    authorityLifecycle: {
      revokeRuntime: (): true => true,
      abortInFlightActions: (): true => true,
      markRuntimeRecoveryRequired: (): true => true,
      releaseRuntimeAfterReap: (runId): true => fixtureRelease(control, runId),
    },
  });
  const mode = runtimeMode(control);
  const started = await Promise.resolve(
    runtime.manager.start({
      runId: FIXTURE_RUN_ID,
      treeBindingId: "b".repeat(64),
      authorityEnvelopeDigest: "c".repeat(64),
      taskRef: "issue-2254",
      workspaceRoot: fixtureWorkspaceRoot(root, control),
      adapterKind: "opencode-compatible",
      runtimeSource: "keiko-sidecar",
      modelSource: "keiko-model-gateway",
      requestedMode: mode,
      effectiveMode: mode,
      executablePath: portable.executablePath,
      managedRoot: join(resourceRoot, "runtime/sidecars/opencode-compatible"),
      gatewayUrl: fixtureGatewayUrl(control),
      modelProfileId: "coding-safe-openai-compatible",
      args: [],
      inheritedEnvAllowlist: [],
      shutdownTimeoutMs: fixtureShutdownTimeout(control),
      startTimeoutMs: control?.startTimeoutMs ?? 100,
      signal: fixtureSignal(control),
      confinement: {
        platform: "darwin",
        arch: "arm64",
        backend: "macos-app-sandbox",
        releaseReceipt: `sha256:${"a".repeat(64)}`,
      },
    }),
  );
  expect(started).toEqual(
    control?.expectedStart ?? { ok: true, runId: FIXTURE_RUN_ID, status: "ready" },
  );
  await control?.afterStart?.(runtime, join(root, "state", FIXTURE_RUN_ID));
  const preparation = fixturePreparation(
    capturedLaunch,
    portable.executablePath,
    portable.verification,
  );
  return {
    runtime,
    preparation,
    stop: async (): Promise<void> => {
      await runtime.manager.stop(FIXTURE_RUN_ID);
    },
  };
}

it("selects native stdin ownership only after the production V2 prepare and keeps it open", async () => {
  const pipe = new PassThrough();
  const launches: RuntimeSupervisorLaunchRequest[] = [];
  const fixture = await startBridgeFixture(
    {
      execute: () => Promise.resolve({ status: "observed", evidence: [] }),
    },
    undefined,
    { stdinLifetime: { supports: true, launches, pipe } },
  );
  try {
    expect(launches).toHaveLength(1);
    expect(launches[0]?.parentLifetime).toBe("stdin-eof");
    expect(launches[0]?.args).toContain("--stdio");
    expect(pipe.writableEnded).toBe(false);
    expect(pipe.destroyed).toBe(false);
  } finally {
    await fixture.stop();
    pipe.destroy();
  }
});

function completedTurnHistory(): readonly Readonly<Record<string, unknown>>[] {
  return turnHistory("succeeded");
}

function changesetArguments(patch: string): Readonly<Record<string, unknown>> {
  return {
    changeset: {
      patch,
      files: [{ file: "src/App.tsx", expectedContentHash: "a".repeat(64) }],
    },
  };
}

function editPartRow(
  sequence: number,
  state: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return {
    id: `msg_edit_${String(sequence)}`,
    type: "assistant",
    time: { created: sequence },
    content: [
      {
        type: "tool",
        id: `call_edit_${String(sequence)}`,
        name: "keiko_changeset_edit",
        time: { created: sequence },
        state,
      },
    ],
  };
}

function failedTurnHistory(): readonly Readonly<Record<string, unknown>>[] {
  return turnHistory("failed", {
    name: "APIError",
    data: { message: "SENTINEL_PROVIDER_DETAIL", isRetryable: false },
  });
}

function turnHistory(
  outcome: "succeeded" | "failed",
  error?: Readonly<Record<string, unknown>>,
): readonly Readonly<Record<string, unknown>>[] {
  return [
    { id: "msg_user", type: "user", time: { created: 1 }, text: "bounded task" },
    {
      id: "msg_assistant",
      type: "assistant",
      time: { created: 2 },
      content: [{ type: "text", text: "done" }],
      ...(error === undefined ? {} : { error }),
    },
    { id: "msg_idle", type: "idle", time: { created: 3 }, outcome },
  ];
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

beforeAll(async () => {
  loadedCompositionModule = await loadCompositionModule();
});

afterAll(() => {
  loadedCompositionModule = undefined;
});

describe("unmounted OpenCode runtime composition", () => {
  it("reuses cached native sources without regenerating a discarded legacy bundle at readiness", async () => {
    createGeneratedOpenCodeV2Plugins();
    const before = { ...generatedToolSources };
    const atSpawn: (typeof before)[] = [];
    const fixture = await startBridgeFixture(
      {
        execute: (): Promise<{ status: "completed"; evidence: never[] }> =>
          Promise.resolve({ status: "completed", evidence: [] }),
      },
      undefined,
      {
        onSpawn: (): void => {
          atSpawn.push({ ...generatedToolSources });
        },
      },
    );
    try {
      expect(atSpawn).toHaveLength(1);
      expect(atSpawn[0]).toEqual(before);
      expect(generatedToolSources).toEqual(atSpawn[0]);
      expect(fixture.runtime.manager.health()).toMatchObject({ status: "ready" });
    } finally {
      await fixture.stop();
    }
  });

  it("shows the human task without replaying attached issue context as a user message", () => {
    const context = "PRIVATE_ISSUE_CONTEXT";
    const intent = "Summarize the issue";
    const projection = createOpenCodeV2HistoryProjection();
    const events = projection.project(
      "ses_safe",
      [
        {
          id: "msg_context",
          type: "user",
          time: { created: 1 },
          text: `${context}\n\n${intent}`,
          metadata: {
            keikoContextPresentationV1: {
              displayText: intent,
              hiddenContextSha256: createHash("sha256").update(context).digest("hex"),
            },
          },
        },
      ],
      undefined,
    );
    const signals = events.flatMap((event) => {
      const signal = projection.takeSignal(event);
      return signal === undefined ? [] : [signal];
    });
    expect(signals.filter((signal) => signal.kind === "text")).toEqual([
      expect.objectContaining({ kind: "text", text: intent }),
    ]);
    expect(JSON.stringify(signals)).not.toContain(context);
  });

  // eslint-disable-next-line complexity -- this audit fixture keeps lifecycle evidence co-located.
  it("prepares secret-safe state before spawn, proves the private runtime, and disposes only after reap", async () => {
    expect(OPEN_CODE_V2_PINNED_PROTOCOL_SURFACE_SHA256).toBe(
      "726109518aba483675a0be0a0b162221c7a50a24ef2de4539cb7fd0ea929ff9b",
    );
    const root = tempDir("keiko-opencode-composition-");
    const workspaceRoot = join(root, "workspace");
    const resourceRoot = join(root, "resources");
    const portable = portableFixture(resourceRoot);
    const executable = portable.executablePath;
    const stateBaseRoot = join(root, "state-base");
    mkdirSync(workspaceRoot, { recursive: true });
    writeFileSync(
      join(workspaceRoot, "opencode.json"),
      JSON.stringify({ model: "hostile/model", tools: { bash: true } }),
    );
    mkdirSync(join(workspaceRoot, ".opencode"), { recursive: true });
    writeFileSync(
      join(workspaceRoot, ".opencode", "opencode.json"),
      JSON.stringify({ permission: { "*": "allow" }, tools: { edit: true } }),
    );
    const order: string[] = [];
    let launch: RuntimeSupervisorLaunchRequest | undefined;
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const exits: ((code: number | null) => void)[] = [];
    let releaseReap: (() => void) | undefined;
    const backend: RuntimeProcessBackend = {
      identity: { platform: "darwin", arch: "arm64", backend: "macos-app-sandbox" },
      spawnOwnedTree: (request): RuntimeProcessTree => {
        order.push("spawn");
        launch = request;
        stdout.end("server listening on http://127.0.0.1:43123\n");
        return {
          treeId: "tree-1",
          stdout,
          stderr,
          onTreeExit: (callback): void => {
            exits.push(callback);
          },
        };
      },
      signalTree: (): void => {
        order.push("terminate");
      },
      waitForCompleteTreeExit: (): Promise<boolean> =>
        new Promise((resolve) => {
          releaseReap = (): void => {
            stderr.end();
            for (const callback of exits) callback(0);
            resolve(true);
          };
        }),
      reconcileTreeExit: (): Promise<boolean> => Promise.resolve(false),
    };
    const supervisor = createRuntimeProcessSupervisor({
      backend,
      qualifications: [
        {
          platform: "darwin",
          arch: "arm64",
          backend: "macos-app-sandbox",
          releaseReceipt: `sha256:${"a".repeat(64)}`,
        },
      ],
      planSandbox: (request) =>
        planLongLivedRuntimeSandbox(
          request,
          { bubblewrap: false, unshare: false, seatbelt: true, docker: false, podman: false },
          "darwin",
        ),
    });
    const sseControllers: ReadableStreamDefaultController<Uint8Array>[] = [];
    const sseCancellations: number[] = [];
    const sseFrame = new TextEncoder().encode(
      'data: {"id":"evt_server","type":"server.connected","data":{}}\n\n',
    );
    const stream = (): ReadableStream<Uint8Array> =>
      new ReadableStream({
        start(controller): void {
          sseControllers.push(controller);
          controller.enqueue(sseFrame);
        },
        cancel(): void {
          sseCancellations.push(sseControllers.length - 1);
          order.push("sse-cancel");
        },
      });
    let readinessStatusReads = 0;
    let observePoll: (() => void) | undefined;
    const readinessPolled = new Promise<void>((resolve) => {
      observePoll = resolve;
    });
    // eslint-disable-next-line complexity -- the finite mock endpoint table is intentionally explicit.
    const fetchMock = vi.fn((url: URL | RequestInfo, init?: RequestInit) => {
      const path = requestPath(url);
      const authorization = new Headers(init?.headers).get("authorization");
      if (path === "/api/info" && authorization === null)
        return Promise.resolve(new Response("", { status: 401 }));
      expect(authorization).toMatch(/^Basic /u);
      if (path === "/api/info") return Promise.resolve(v2Json({ version: OPENCODE_VERSION }));
      if (path === "/openapi.json") return Promise.resolve(v2Json(OPENAPI));
      if (path === "/api/event") {
        init?.signal?.addEventListener(
          "abort",
          () => {
            order.push("sse-abort");
            sseCancellations.push(sseControllers.length - 1);
            sseControllers.at(-1)?.close();
          },
          { once: true },
        );
        return Promise.resolve(
          new Response(stream(), { headers: { "content-type": "text/event-stream" } }),
        );
      }
      if (path === "/api/session/ses_1/message") return Promise.resolve(v2Envelope([]));
      if (path.endsWith("/prompt")) return Promise.resolve(v2Envelope({}));
      if (path.endsWith("/interrupt")) return Promise.resolve(v2Envelope({}));
      if (path === "/api/session/active") {
        observePoll?.();
        return Promise.resolve(
          v2Envelope(readinessStatusReads++ < 4 ? { ses_1: { type: "busy" } } : {}),
        );
      }
      if (path === "/api/session" && init?.method === "POST")
        return Promise.resolve(v2Envelope({ id: "ses_1", location: { directory: workspaceRoot } }));
      if (path === "/api/session")
        return Promise.resolve(
          v2Envelope([{ id: "ses_1", location: { directory: workspaceRoot } }]),
        );
      return Promise.resolve(new Response("", { status: 404 }));
    });
    const fetch = fetchMock as unknown as typeof globalThis.fetch;
    const facade: CodingToolFacade = {
      execute: vi.fn((input: Parameters<CodingToolFacade["execute"]>[0]) =>
        Promise.resolve(
          input.body === '{"action":"permission-event","requestId":"keiko-readiness"}'
            ? { status: "observed", evidence: [] }
            : {
                status: "completed",
                evidence: [],
                read: { text: "file contents", byteCount: 13, digest: "d".repeat(64) },
              },
        ),
      ) as CodingToolFacade["execute"],
    };
    const authorityOrder: string[] = [];
    const governedEvents: OpenCodeReconciliationEvent[] = [];
    const authorityLifecycle = {
      revokeRuntime: (runId: string): true => {
        authorityOrder.push(`revoke:${runId}`);
        return true;
      },
      abortInFlightActions: (runId: string): true => {
        authorityOrder.push(`abort:${runId}`);
        return true;
      },
      markRuntimeRecoveryRequired: (runId: string): true => {
        authorityOrder.push(`recovery:${runId}`);
        return true;
      },
      releaseRuntimeAfterReap: (runId: string): true => {
        authorityOrder.push(`release:${runId}`);
        return true;
      },
    };
    const runtime = (await compositionModule()).createOpenCodeRuntimeComposition({
      portable: { verification: portable.verification, resourceRoot, target: "macos-arm64" },
      stateBaseRoot,
      contextGeometry: {
        contextWindowTokens: 65_536,
        maxInputTokens: 61_440,
        maxOutputTokens: 4_096,
      },
      capabilities: {
        modelGatewayCapability: MODEL_CAPABILITY,
        toolFacadeCapability: TOOL_CAPABILITY,
      },
      toolFacadeOrigin: TOOL_FACADE_ORIGIN,
      toolFacade: facade,
      governedEventSink: {
        execute: (_identityKey, event): Promise<"applied"> => {
          governedEvents.push(event);
          return Promise.resolve("applied");
        },
      },
      gatewayReadiness: {
        waitForObservedRequest: (): Promise<boolean> => Promise.resolve(true),
        verifyObserved: (): void => undefined,
        clear: (): void => undefined,
      },
      fetch,
      supervisor,
      authorityLifecycle,
    });

    const startResult = await withDeterministicReadinessTimers(
      () =>
        Promise.resolve(
          runtime.manager.start({
            runId: "run-1",
            treeBindingId: "a".repeat(64),
            authorityEnvelopeDigest: "b".repeat(64),
            taskRef: "issue-2254",
            workspaceRoot,
            adapterKind: "opencode-compatible",
            runtimeSource: "keiko-sidecar",
            modelSource: "keiko-model-gateway",
            requestedMode: "supervised-coding",
            effectiveMode: "supervised-coding",
            executablePath: executable,
            managedRoot: join(resourceRoot, "runtime/sidecars/opencode-compatible"),
            // Same loopback origin as `TOOL_FACADE_ORIGIN` (below) -- ADR-0043 D11-D14 (#3390):
            // production derives both from ONE loopback origin (productionOpenCodeActivation.ts).
            gatewayUrl: "http://127.0.0.1:4391/api/coding-sidecar/gateway",
            modelProfileId: "coding-safe-openai-compatible",
            args: ["--caller"],
            inheritedEnvAllowlist: [],
            shutdownTimeoutMs: 5,
            startTimeoutMs: 100,
            confinement: {
              platform: "darwin",
              arch: "arm64",
              backend: "macos-app-sandbox",
              releaseReceipt: `sha256:${"a".repeat(64)}`,
            },
          }),
        ),
      readinessPolled,
    );
    expect(startResult).toMatchObject({ ok: true });
    expect(readinessStatusReads).toBe(5);
    const sessionCreate = fetchMock.mock.calls.find(
      ([url, init]) => requestPath(url) === "/api/session" && init?.method === "POST",
    );
    expect(sessionCreate?.[1]?.body).toBe(
      JSON.stringify({ title: FIXED_SESSION_TITLE, location: { directory: workspaceRoot } }),
    );
    expect(new Headers(sessionCreate?.[1]?.headers).get("content-type")).toBe("application/json");
    let readinessPromptObserved = false;
    for (const [url, init] of fetchMock.mock.calls) {
      if (requestPath(url).endsWith("/prompt")) {
        expect(typeof init?.body).toBe("string");
        if (typeof init?.body === "string") {
          expect(init.body).not.toContain(FIXED_SESSION_TITLE);
          readinessPromptObserved ||= init.body.includes("runtime readiness handshake");
        }
      }
    }
    expect(readinessPromptObserved).toBe(true);
    // #2254: startup retains the authenticated stream for the post-ready supervisor. The SSE
    // payload is deliberately the exact nested message shape.
    expect(order).toEqual(["spawn"]);
    expect(sseCancellations).toEqual([]);
    expect(launch?.args).toEqual(["serve", "--hostname", "127.0.0.1", "--port", "0"]);
    const runRoot = join(stateBaseRoot, "run-1");
    expect(launch?.env.OPENCODE_DISABLE_PROJECT_CONFIG).toBe("true");
    expect(launch?.env.OPENCODE_CONFIG_DIR).toBe(join(runRoot, "config", "opencode"));
    expect(
      fetchMock.mock.calls.some(([url]) => url instanceof URL && url.pathname === "/openapi.json"),
    ).toBe(true);
    expect(
      new Set([
        launch?.env.KEIKO_MODEL_GATEWAY_CAPABILITY,
        launch?.env.KEIKO_TOOL_FACADE_CAPABILITY,
        launch?.env.OPENCODE_SERVER_PASSWORD,
      ]),
    ).toHaveLength(3);
    // ADR-0043 D11-D14 (#3390): the spawned sidecar receives exactly one loopback origin for
    // model and tool traffic.
    expect(launch?.env.KEIKO_TOOL_FACADE_URL).toBeDefined();
    expect(launch?.env.KEIKO_MODEL_GATEWAY_URL).toBeDefined();
    expect(new URL(launch?.env.KEIKO_TOOL_FACADE_URL ?? "").origin).toBe(
      new URL(launch?.env.KEIKO_MODEL_GATEWAY_URL ?? "").origin,
    );
    // Windows does not implement POSIX permission bits; chmodSync cannot make these mode
    // assertions meaningful there. The state layout and secret-free contents remain covered on
    // every platform, while Unix hosts verify the intended 0700/0600 permissions.
    if (process.platform !== "win32") {
      for (const path of [
        runRoot,
        join(runRoot, "config"),
        join(runRoot, "config", "opencode"),
        join(runRoot, "config", "opencode", "plugins"),
        join(runRoot, "state"),
      ])
        expect(statSync(path).mode & 0o777).toBe(0o700);
      for (const path of [
        join(runRoot, "config", "opencode", "opencode.json"),
        ...materializedV2PluginPaths(runRoot),
      ])
        expect(statSync(path).mode & 0o777).toBe(0o600);
    }
    const files = [
      join(runRoot, "config", "opencode", "opencode.json"),
      ...materializedV2PluginPaths(runRoot),
    ]
      .map((path) => readFileSync(path, "utf8"))
      .join("\n");
    expect(files).not.toContain(MODEL_CAPABILITY);
    expect(files).not.toContain(TOOL_CAPABILITY);
    expect(files).not.toContain(launch?.env.OPENCODE_SERVER_PASSWORD ?? "");
    expect(files).not.toContain(FIXED_SESSION_TITLE);
    expect(JSON.stringify(governedEvents)).not.toContain(FIXED_SESSION_TITLE);
    expect(files).toContain("Bearer {env:KEIKO_MODEL_GATEWAY_CAPABILITY}");
    const materializedConfig = JSON.parse(
      readFileSync(join(runRoot, "config", "opencode", "opencode.json"), "utf8"),
    ) as {
      readonly providers: Readonly<Record<string, unknown>>;
      readonly compaction: Readonly<Record<string, unknown>>;
    };
    const materializedProvider = materializedConfig.providers["keiko-runtime"] as {
      readonly models: Readonly<
        Record<string, { readonly limit: Readonly<Record<string, number>> }>
      >;
    };
    expect(materializedProvider.models.coding?.limit).toEqual({
      context: 65_536,
      input: 61_440,
      output: 4_096,
    });
    expect(materializedConfig.compaction).toMatchObject({ auto: true });
    expect(typeof (materializedConfig.compaction.keep as { readonly tokens: unknown }).tokens).toBe(
      "number",
    );
    const paths = fetchMock.mock.calls.map(([url]) => requestPath(url));
    expect(paths.indexOf("/api/session")).toBeLessThan(paths.lastIndexOf("/api/session"));
    expect(paths.indexOf("/api/session/ses_1/message")).toBeGreaterThan(
      paths.indexOf("/api/session"),
    );
    // ADR-0043 D11-D14 (#3390): the bridge's public `url` is the SAME attested loopback origin
    // supplied at composition -- relocated from asserting a self-issued ephemeral listener port
    // (retired) to asserting the bridge never fabricates a second one of its own.
    expect(runtime.toolBridge.url).toBe(TOOL_FACADE_ORIGIN);
    await expect(
      runtime.toolBridge.handle({
        method: "POST",
        headers: new Headers({ authorization: `Bearer ${TOOL_CAPABILITY}` }),
        body: '{"action":"read"}',
      }),
    ).resolves.toEqual({
      status: 200,
      body: JSON.stringify({
        status: "completed",
        evidence: [],
        read: { text: "file contents", byteCount: 13, digest: "d".repeat(64) },
      }),
    });
    await expect(
      runtime.toolBridge.handle({
        method: "POST",
        headers: new Headers({ authorization: "Bearer wrong", origin: "http://evil.test" }),
        body: '{"action":"read"}',
      }),
    ).resolves.toMatchObject({ status: 403 });
    await expect(
      runtime.toolBridge.handle({
        method: "POST",
        headers: new Headers({ authorization: "Bearer wrong" }),
        body: '{"action":"read"}',
      }),
    ).resolves.toMatchObject({ status: 401 });
    expect(facade.execute).toHaveBeenCalledTimes(2);
    expect(facade.execute).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        body: '{"action":"permission-event","requestId":"keiko-readiness"}',
        capability: TOOL_CAPABILITY,
      }),
    );
    const stopping = runtime.manager.stop("run-1");
    await vi.waitFor(() => {
      expect(order).toContain("terminate");
    });
    // Disposal is deferred until the supervisor provides an authentic reap result.
    expect(() => {
      accessSync(runRoot, constants.F_OK);
    }).not.toThrow();
    expect(sseCancellations).toEqual([0]);
    expect(order.indexOf("sse-abort")).toBeLessThan(order.indexOf("terminate"));
    releaseReap?.();
    await expect(stopping).resolves.toMatchObject({ ok: true });
    expect(authorityOrder).toEqual(["revoke:run-1", "abort:run-1", "release:run-1"]);
    await expect(
      runtime.toolBridge.handle({
        method: "POST",
        headers: new Headers({ authorization: `Bearer ${TOOL_CAPABILITY}` }),
        body: '{"action":"read"}',
      }),
    ).resolves.toMatchObject({ status: 503 });
    expect(() => {
      accessSync(runRoot, constants.F_OK);
    }).toThrow();
  });
});

describe("private OpenCode run control", () => {
  const facade: CodingToolFacade = {
    execute: vi.fn(() =>
      Promise.resolve({
        status: "completed",
        evidence: [],
        read: { text: "fixture", byteCount: 7, digest: "f".repeat(64) },
      }),
    ) as CodingToolFacade["execute"],
  };

  it("accepts an empty V2 active-session map after readiness interruption", async () => {
    const fixture = await startBridgeFixture(facade, undefined, {
      runControl: {
        promptBodies: [],
        abortSessions: [],
        statusResponses: [{}],
      },
    });
    await fixture.stop();
  });

  it("isolates the live startup challenge from user task submissions", async () => {
    const statusPhases: ReadinessChallengePhase[] = [];
    const runControl = {
      promptBodies: [],
      abortSessions: [],
      statusResponses: [],
      statusResponseForReadinessPhase: (phase: ReadinessChallengePhase): unknown => {
        statusPhases.push(phase);
        return phase === "aborted" ? {} : { ses_tool: { type: "busy" } };
      },
    };
    const fixture = await startBridgeFixture(facade, undefined, { runControl });
    expect(runControl.promptBodies).toEqual([]);
    expect(runControl.abortSessions).toEqual([]);
    expect(statusPhases.at(-1)).toBe("aborted");
    expect(fixture.runtime.manager.health()).toMatchObject({
      status: "ready",
      activeRunId: FIXTURE_RUN_ID,
    });
    await fixture.stop();
  });

  it("syncs once for a non-fixed live control without identity catch-up or failure", async () => {
    const historyCalls: Readonly<Record<string, number>>[] = [];
    const fixture = await startBridgeFixture(facade, undefined, {
      sseFrame:
        'data: {"id":"evt_live_only","type":"session.execution.started","data":{"sessionID":"ses_other"}}\n\n',
      historyCalls,
    });
    try {
      expect(historyCalls).toEqual([{}, {}]);
    } finally {
      await fixture.stop();
    }
  });

  it("reuses the fixed V2 session when the event stream reconnects", async () => {
    const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
    const sessionCreateCalls: string[] = [];
    const activityLog = createBufferedServerLogSink();
    const fixture = await startBridgeFixture(facade, undefined, {
      onSseStart: (controller): void => {
        streams.push(controller);
      },
      sessionCreateCalls,
      activityLog,
    });
    try {
      expect(sessionCreateCalls).toEqual(["ses_tool"]);
      streams[0]?.close();
      await vi.waitFor(() => {
        expect(streams).toHaveLength(2);
      });
      expect(sessionCreateCalls).toEqual(["ses_tool"]);
      expect(fixture.runtime.manager.health()).toMatchObject({ status: "ready" });
      const bindings = activityLog.events
        .filter((event) => event.op === "coding-runtime.sidecar-session.bound")
        .map((event) =>
          expectActivityLogProof(
            "coding-runtime.sidecar-session.bound.emitted-line",
            formatActivityLogProofLine(event),
          ),
        );
      expect(bindings).toMatchObject([
        {
          correlationId: FIXTURE_RUN_ID,
          binding: "created",
          streamCount: 1,
          sessionId: "ses_tool",
        },
        { correlationId: FIXTURE_RUN_ID, binding: "reused", streamCount: 2, sessionId: "ses_tool" },
      ]);
    } finally {
      await fixture.stop();
    }
  });

  // PR #3876 review: OpenCode 2.0.10 persists a streamed text or reasoning part only empty and
  // complete, so the live timeline is fed from the event stream's ephemeral delta events through the
  // history projection, and the events the coalescing pump folds into one read are counted on the
  // projection's line. These run the production wiring end to end: the SSE stream, the pump, the
  // projection, the adapter and the safe activity feed.
  describe("a streamed answer the history holds empty", () => {
    const encoder = new TextEncoder();
    let eventNumber = 0;
    const frame = (type: string, data: Readonly<Record<string, unknown>> = {}): Uint8Array => {
      eventNumber += 1;
      const event = {
        id: `evt_live_${String(eventNumber)}`,
        type,
        data: { sessionID: "ses_tool", assistantMessageID: "msg_assistant", ordinal: 0, ...data },
      };
      return encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
    };
    // The history endpoint lists newest first.
    const assistantHistory = (
      content: readonly Record<string, unknown>[],
    ): readonly Readonly<Record<string, unknown>>[] =>
      [
        { id: "msg_user", type: "user", time: { created: 1 }, text: "Task" },
        { id: "msg_assistant", type: "assistant", time: { created: 2 }, content },
      ].reverse();
    const grown = (
      signals: readonly CodingSafeActivitySignal[],
      kind: "text" | "reasoning",
    ): string[] =>
      signals.flatMap((signal) =>
        signal.kind === kind && signal.messageId === "msg_assistant" ? [signal.text] : [],
      );
    const settled = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve));
    const activityFeed = (
      ingested: CodingSafeActivitySignal[],
    ): NonNullable<StartBridgeControl["safeActivity"]> => ({
      arm: vi.fn(),
      clear: vi.fn(),
      ingest: (signal): boolean => {
        ingested.push(signal);
        return true;
      },
      recordDrops: vi.fn(),
      settleTool: vi.fn(),
    });
    const projectionLines = (
      sink: ReturnType<typeof createBufferedServerLogSink>,
    ): Record<string, unknown>[] =>
      sink.events
        .filter((event) => event.op === "coding-runtime.history-projection")
        .map((event) =>
          expectActivityLogProof(
            "coding-runtime.history-projection.emitted-line",
            formatActivityLogProofLine(event),
          ),
        );
    const mergedTotal = (sink: ReturnType<typeof createBufferedServerLogSink>): number =>
      projectionLines(sink).reduce(
        (sum, line) =>
          sum + (typeof line.mergedEventCount === "number" ? line.mergedEventCount : 0),
        0,
      );

    it("shows reasoning and the answer as the event stream delivers them, and nothing twice once the history completes", async () => {
      const ingested: CodingSafeActivitySignal[] = [];
      const historyCalls: Readonly<Record<string, number>>[] = [];
      const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
      const activityLog = createBufferedServerLogSink();
      let content: readonly Record<string, unknown>[] = [
        { type: "reasoning", text: "" },
        { type: "text", text: "" },
      ];
      const fixture = await startBridgeFixture(facade, undefined, {
        activityLog,
        historyCalls,
        onSseStart: (controller): void => {
          streams.push(controller);
        },
        safeActivity: activityFeed(ingested),
        historyResponseFactory: () => Promise.resolve(v2Envelope(assistantHistory(content))),
      });
      try {
        const stream = streams[0];
        if (stream === undefined) throw new Error("expected the event stream");
        stream.enqueue(frame("session.reasoning.started"));
        stream.enqueue(frame("session.reasoning.delta", { delta: "Let me " }));
        stream.enqueue(frame("session.reasoning.delta", { delta: "think." }));
        await vi.waitFor(() => {
          expect(grown(ingested, "reasoning").join("")).toBe("Let me think.");
        });
        stream.enqueue(frame("session.text.started"));
        stream.enqueue(frame("session.text.delta", { delta: "It is " }));
        stream.enqueue(frame("session.text.delta", { delta: "42." }));
        await vi.waitFor(() => {
          expect(grown(ingested, "text").join("")).toBe("It is 42.");
        });

        // The runtime ends the parts: the history shows them complete.
        content = [
          { type: "reasoning", text: "Let me think." },
          { type: "text", text: "It is 42." },
        ];
        const reads = historyCalls.length;
        stream.enqueue(frame("session.text.ended", { text: "It is 42." }));
        await vi.waitFor(() => {
          expect(historyCalls.length).toBeGreaterThan(reads);
        });
        stream.enqueue(frame("session.step.ended"));
        await vi.waitFor(() => {
          expect(historyCalls.length).toBeGreaterThan(reads + 1);
        });
        await settled();

        expect(grown(ingested, "reasoning").join("")).toBe("Let me think.");
        expect(grown(ingested, "text").join("")).toBe("It is 42.");
        // The words travelled as four live deltas; the lines, which count since the previous line,
        // say how many and that none was lost.
        const lines = projectionLines(activityLog);
        const counted = (field: "liveDeltaCount" | "liveDroppedCount"): number =>
          lines.reduce((sum, line) => sum + (typeof line[field] === "number" ? line[field] : 0), 0);
        expect(counted("liveDeltaCount")).toBe(4);
        expect(counted("liveDroppedCount")).toBe(0);
        expect(lines.every((line) => line.correlationId === FIXTURE_RUN_ID)).toBe(true);
        expect(JSON.stringify(lines)).not.toContain("think");
      } finally {
        await fixture.stop();
      }
    });

    it("stops extending a part when the event stream is replaced and takes the rest from the history", async () => {
      const ingested: CodingSafeActivitySignal[] = [];
      const historyCalls: Readonly<Record<string, number>>[] = [];
      const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
      let content: readonly Record<string, unknown>[] = [{ type: "reasoning", text: "" }];
      const fixture = await startBridgeFixture(facade, undefined, {
        historyCalls,
        onSseStart: (controller): void => {
          streams.push(controller);
        },
        safeActivity: activityFeed(ingested),
        historyResponseFactory: () => Promise.resolve(v2Envelope(assistantHistory(content))),
      });
      try {
        streams[0]?.enqueue(frame("session.reasoning.started"));
        streams[0]?.enqueue(frame("session.reasoning.delta", { delta: "Hel" }));
        await vi.waitFor(() => {
          expect(grown(ingested, "reasoning")).toEqual(["Hel"]);
        });

        const readsBeforeReplacement = historyCalls.length;
        streams[0]?.close();
        await vi.waitFor(() => {
          expect(streams).toHaveLength(2);
        });
        // Events the replaced stream missed are gone: this delta cannot extend the part.
        streams[1]?.enqueue(frame("session.reasoning.delta", { delta: "lo wor" }));
        streams[1]?.enqueue(frame("session.step.started"));
        // The reconnect's own read, then the one this event asks for: the second read has started, so
        // it read the history while the part was still empty.
        await vi.waitFor(() => {
          expect(historyCalls.length).toBeGreaterThanOrEqual(readsBeforeReplacement + 2);
        });
        content = [{ type: "reasoning", text: "Hello world" }];
        streams[1]?.enqueue(frame("session.step.ended"));
        await vi.waitFor(() => {
          expect(grown(ingested, "reasoning").join("")).toBe("Hello world");
        });

        expect(grown(ingested, "reasoning")).toEqual(["Hel", "lo world"]);
      } finally {
        await fixture.stop();
      }
    });

    it("counts the events merged into one history read on the projection's line", async () => {
      const ingested: CodingSafeActivitySignal[] = [];
      const historyCalls: Readonly<Record<string, number>>[] = [];
      const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
      const activityLog = createBufferedServerLogSink();
      let content: readonly Record<string, unknown>[] = [{ type: "text", text: "" }];
      let hold = false;
      let release: ((response: Response) => void) | undefined;
      const fixture = await startBridgeFixture(facade, undefined, {
        activityLog,
        historyCalls,
        onSseStart: (controller): void => {
          streams.push(controller);
        },
        safeActivity: activityFeed(ingested),
        historyResponseFactory: () =>
          hold
            ? new Promise<Response>((resolve) => {
                release = resolve;
              })
            : Promise.resolve(v2Envelope(assistantHistory(content))),
      });
      try {
        const stream = streams[0];
        if (stream === undefined) throw new Error("expected the event stream");
        const mergedBefore = mergedTotal(activityLog);
        const reads = historyCalls.length;

        // One event asks for a read, which waits; ten more arrive meanwhile.
        hold = true;
        stream.enqueue(frame("session.step.started"));
        await vi.waitFor(() => {
          expect(historyCalls).toHaveLength(reads + 1);
        });
        for (let sent = 0; sent < 10; sent += 1) stream.enqueue(frame("session.step.streamed"));
        await settled();

        // The history changes, so the read in flight writes the projection's line.
        hold = false;
        content = [{ type: "text", text: "Hello" }];
        release?.(v2Envelope(assistantHistory(content)));
        await vi.waitFor(() => {
          expect(historyCalls).toHaveLength(reads + 2);
        });
        await vi.waitFor(() => {
          expect(grown(ingested, "text")).toEqual(["Hello"]);
        });

        // Of the ten, one asked for the next read; the other nine were covered by it.
        expect(mergedTotal(activityLog) - mergedBefore).toBe(9);
        expect(projectionLines(activityLog).at(-1)).toMatchObject({ mergedEventCount: 9 });
      } finally {
        await fixture.stop();
      }
    });
  });

  it("observes live fixed-session question frames and ignores foreign or unbound ones", async () => {
    const questionObservations: string[] = [];
    const fixture = await startBridgeFixture(facade, undefined, {
      sseFrame: [
        'data: {"id":"evt_q1","type":"form.created","data":{"form":{"id":"frm_1","sessionID":"ses_tool"}}}\n\n',
        'data: {"id":"evt_q2","type":"form.created","data":{"form":{"id":"frm_2","sessionID":"ses_tool"}}}\n\n',
        'data: {"id":"evt_q3","type":"form.created","data":{"form":{"id":"frm_3","sessionID":"ses_other"}}}\n\n',
        'data: {"id":"evt_q4","type":"form.created","data":{}}\n\n',
      ].join(""),
      questionObservations,
    });
    try {
      await vi.waitFor(() => {
        expect(questionObservations.length).toBeGreaterThanOrEqual(2);
      });
      // Foreign-session and session-unbound frames observe nothing; dedupe is the consumer's job.
      expect(questionObservations).toEqual(["evt_q1", "evt_q2"]);
    } finally {
      await fixture.stop();
    }
  });

  // The ask as the generated V2 plugin sends it for one keiko_verification call (#3612). A file edit
  // asks no one: its change review is its one approval (ADR-0124 D6).
  const governedAsk = (callId: string): Promise<Record<string, unknown>> =>
    capturedGeneratedV2Ask({
      runId: FIXTURE_RUN_ID,
      sessionId: "ses_tool",
      callId,
      tool: "keiko_verification",
      args: { verifierId: "test", targetPath: "" },
    });
  const settlementRecorder = (): {
    readonly safeActivity: NonNullable<StartBridgeControl["safeActivity"]>;
    readonly settlements: Parameters<
      NonNullable<StartBridgeControl["safeActivity"]>["settleTool"]
    >[0][];
  } => {
    const settlements: Parameters<
      NonNullable<StartBridgeControl["safeActivity"]>["settleTool"]
    >[0][] = [];
    return {
      settlements,
      safeActivity: {
        arm: vi.fn(),
        clear: vi.fn(),
        ingest: () => true,
        recordDrops: vi.fn(),
        settleTool: (settlement): void => {
          settlements.push(settlement);
        },
      },
    };
  };
  const permissionRequested = async (
    runtimeEvents: readonly CodingWorkbenchRuntimeEvent[],
  ): Promise<string> => {
    await vi.waitFor(() => {
      expect(runtimeEvents.some((event) => event.kind === "permission-requested")).toBe(true);
    });
    const event = runtimeEvents.find((candidate) => candidate.kind === "permission-requested");
    const permission = event?.permissionRequest;
    if (permission === undefined || Array.isArray(permission)) {
      throw new Error("expected public permission request");
    }
    return permission.requestId;
  };

  it("closes a pending human permission without starting a delegate or retaining authority", async () => {
    const runtimeEvents: CodingWorkbenchRuntimeEvent[] = [];
    const delegate = vi.fn((): Promise<unknown> => Promise.resolve({ outcome: "completed" }));
    const realFacade = createCodingToolFacade({
      authority: { admit: () => ({ ok: true, mutationGuard: { check: (): true => true } }) },
      delegate: { execute: delegate },
    });
    const onRelease = vi.fn();
    const fixture = await startBridgeFixture(realFacade, undefined, {
      mode: "governed-assist",
      runtimeEvents,
      onRelease,
    });
    try {
      const decision = fixture.runtime.toolBridge.handle({
        method: "POST",
        headers: new Headers({ authorization: `Bearer ${TOOL_CAPABILITY}` }),
        body: JSON.stringify(await governedAsk("call_pending_close")),
      });
      await permissionRequested(runtimeEvents);
      expect(await fixture.runtime.manager.stop(FIXTURE_RUN_ID)).toEqual({
        ok: true,
        status: "stopped",
      });
      expect(await decision).toMatchObject({ status: 403, rejection: "approval-cancelled" });
      expect(delegate).not.toHaveBeenCalled();
      expect(onRelease).toHaveBeenCalledOnce();
    } finally {
      await fixture.stop();
    }
  });

  it("aliases live permission ids and resolves only the run-owned upstream request", async () => {
    const runtimeEvents: CodingWorkbenchRuntimeEvent[] = [];
    const permissionRequests: {
      readonly method: string;
      readonly path: string;
      readonly body?: string;
    }[] = [];
    const ask = await governedAsk("call_1");
    const upstreamPermission = ask.properties as { readonly id: string };
    const recorder = settlementRecorder();
    const fixture = await startBridgeFixture(facade, undefined, {
      mode: "governed-assist",
      runtimeEvents,
      safeActivity: recorder.safeActivity,
      runControl: {
        promptBodies: [],
        abortSessions: [],
        statusResponses: [],
        permissionResponses: [[upstreamPermission]],
        permissionRequests,
      },
    });
    try {
      const decision = fixture.runtime.toolBridge.handle({
        method: "POST",
        headers: new Headers({ authorization: `Bearer ${TOOL_CAPABILITY}` }),
        body: JSON.stringify(ask),
      });
      const requestId = await permissionRequested(runtimeEvents);
      expect(requestId).toMatch(/^permission-[0-9]+$/u);
      expect(requestId).not.toBe(upstreamPermission.id);
      await expect(
        fixture.runtime.runPort.replyPermission(FIXTURE_RUN_ID, upstreamPermission.id, "reject"),
      ).resolves.toBe(false);
      expect(permissionRequests).toEqual([]);
      await expect(
        fixture.runtime.runPort.replyPermission(FIXTURE_RUN_ID, requestId, "reject"),
      ).resolves.toBe(true);
      // #3610: the refusal names the human decision, so the route never logs it as an origin refusal.
      // Owner decision 2026-09-26 (ADR-0124 D6): a denial rejects only this step, so the call answers
      // 409 with its own result, which the plugin hands to the model in place of the call.
      const denied = await decision;
      expect(denied).toMatchObject({ status: 409, rejection: "approval-denied" });
      expect(JSON.parse(denied.body)).toEqual({
        status: "denied",
        evidence: [],
        guidance: expect.stringContaining("The user declined this step") as string,
      });
      expect(permissionRequests).toEqual([]);
      // #3612: the refused call is settled with the human's verdict, never left to OpenCode's
      // generic failure that read "Failed" for a denial.
      expect(recorder.settlements).toEqual([
        { actionId: "ses_tool:call_1", state: "denied", occurredAt: expect.any(String) as string },
      ]);
    } finally {
      await fixture.stop();
    }
  });

  it("settles an ask whose caller went away as cancelled (#3612)", async () => {
    const runtimeEvents: CodingWorkbenchRuntimeEvent[] = [];
    const recorder = settlementRecorder();
    const fixture = await startBridgeFixture(facade, undefined, {
      mode: "governed-assist",
      runtimeEvents,
      safeActivity: recorder.safeActivity,
      runControl: { promptBodies: [], abortSessions: [], statusResponses: [] },
    });
    try {
      const caller = new AbortController();
      const decision = fixture.runtime.toolBridge.handle({
        method: "POST",
        headers: new Headers({ authorization: `Bearer ${TOOL_CAPABILITY}` }),
        body: JSON.stringify(await governedAsk("call_gone")),
        signal: caller.signal,
      });
      await permissionRequested(runtimeEvents);
      caller.abort();
      await expect(decision).resolves.toMatchObject({
        status: 403,
        rejection: "approval-cancelled",
      });
      expect(recorder.settlements).toEqual([
        {
          actionId: "ses_tool:call_gone",
          state: "cancelled",
          occurredAt: expect.any(String) as string,
        },
      ]);
    } finally {
      await fixture.stop();
    }
  });

  // ADR-0124 D6: an ask nobody decided in time ends like a denial — the call answers with its own
  // result, so the model goes on without the step instead of reading a bare refusal.
  it("answers an expired ask with the call's own result", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const runtimeEvents: CodingWorkbenchRuntimeEvent[] = [];
    const recorder = settlementRecorder();
    const fixture = await startBridgeFixture(facade, undefined, {
      mode: "governed-assist",
      runtimeEvents,
      safeActivity: recorder.safeActivity,
      runControl: { promptBodies: [], abortSessions: [], statusResponses: [] },
    });
    try {
      const decision = fixture.runtime.toolBridge.handle({
        method: "POST",
        headers: new Headers({ authorization: `Bearer ${TOOL_CAPABILITY}` }),
        body: JSON.stringify(await governedAsk("call_expired")),
      });
      await permissionRequested(runtimeEvents);
      await vi.advanceTimersByTimeAsync(GOVERNED_TOOL_HUMAN_DECISION_WAIT_MS);
      const expired = await decision;
      expect(expired).toMatchObject({ status: 409, rejection: "approval-expired" });
      expect(JSON.parse(expired.body)).toEqual({
        status: "cancelled",
        evidence: [],
        guidance: expect.stringContaining("Nobody decided this approval in time") as string,
      });
      expect(recorder.settlements).toEqual([
        {
          actionId: "ses_tool:call_expired",
          state: "cancelled",
          occurredAt: expect.any(String) as string,
        },
      ]);
    } finally {
      vi.useRealTimers();
      await fixture.stop();
    }
  });

  // Owner decision 2026-09-26 (ADR-0124 D6): a denied native OpenCode ask is rejected with the
  // human's feedback, which OpenCode 2.0.10 hands to the model as the correction for that one call,
  // so its loop goes on; a bare reject would end the turn.
  it("rejects a native ask with the denial's feedback so the runtime goes on", async () => {
    const permissionRequests: {
      readonly method: string;
      readonly path: string;
      readonly body?: string;
    }[] = [];
    const upstream = (await governedAsk("call_native")).properties as { readonly id: string };
    const requestId = projectOpenCodePermissionRequestId(upstream.id);
    if (requestId === undefined) throw new Error("expected a projectable permission id");
    const fixture = await startBridgeFixture(facade, undefined, {
      mode: "governed-assist",
      runtimeEvents: [],
      runControl: {
        promptBodies: [],
        abortSessions: [],
        statusResponses: [],
        permissionResponses: [[upstream]],
        permissionRequests,
      },
    });
    try {
      await expect(
        fixture.runtime.runPort.replyPermission(FIXTURE_RUN_ID, requestId, "reject"),
      ).resolves.toBe(true);
      expect(permissionRequests).toHaveLength(1);
      expect(permissionRequests[0]?.path).toBe(
        `/api/session/ses_tool/permission/${upstream.id}/reply`,
      );
      expect(JSON.parse(permissionRequests[0]?.body ?? "{}")).toEqual({
        decision: "reject",
        message: expect.stringContaining("The user declined this step") as string,
      });
    } finally {
      await fixture.stop();
    }
  });

  it("accepts status omission only when causal terminal history exists", async () => {
    const prompt = "SENTINEL_PRIVATE_RUN_PROMPT";
    const initialContext = "SENTINEL_UNTRUSTED_ISSUE_CONTEXT";
    const activityLog = createBufferedServerLogSink();
    const governedEvents: OpenCodeReconciliationEvent[] = [];
    let history: readonly Readonly<Record<string, unknown>>[] = completedTurnHistory().slice(0, 1);
    const runControl = {
      promptBodies: [] as string[],
      abortSessions: [] as string[],
      statusResponses: [{}, {}] as unknown[],
    };
    let runRoot = "";
    const fixture = await startBridgeFixture(facade, undefined, {
      governedEvents,
      runControl,
      activityLog,
      historyResponseFactory: () => Promise.resolve(v2Envelope(history.slice().reverse())),
      afterStart: (_runtime, root): void => {
        runRoot = root;
      },
    });

    await expect(fixture.runtime.runPort.submitTask("unknown-run", prompt)).resolves.toBe(false);
    await expect(
      fixture.runtime.runPort.submitTask(FIXTURE_RUN_ID, prompt, initialContext),
    ).resolves.toBe(true);
    history = completedTurnHistory();
    const terminalWait = new AbortController();
    const terminalDeadline = setTimeout(() => {
      terminalWait.abort();
    }, 2_000);
    await expect(
      fixture.runtime.runPort.waitForTerminal(FIXTURE_RUN_ID, terminalWait.signal),
    ).resolves.toBe(true);
    clearTimeout(terminalDeadline);
    expect(runControl.statusResponses).toEqual([{}]);
    await expect(fixture.runtime.runPort.abortTask(FIXTURE_RUN_ID)).resolves.toBe(true);
    expect(runControl.abortSessions).toEqual(["ses_tool"]);
    expect(runControl.promptBodies).toEqual([
      JSON.stringify({
        text: `${initialContext}\n\n${prompt}`,
        metadata: {
          keikoContextPresentationV1: {
            displayText: prompt,
            hiddenContextSha256: createHash("sha256").update(initialContext).digest("hex"),
          },
        },
      }),
    ]);

    const aborted = new AbortController();
    aborted.abort();
    await expect(
      fixture.runtime.runPort.waitForTerminal(FIXTURE_RUN_ID, aborted.signal),
    ).resolves.toBe(false);
    const retained = [
      JSON.stringify(governedEvents),
      readFileSync(join(runRoot, "config", "opencode", "opencode.json"), "utf8"),
      ...materializedV2PluginPaths(runRoot).map((path) => readFileSync(path, "utf8")),
    ].join("\n");
    expect(retained).not.toContain(prompt);
    expect(retained).not.toContain(initialContext);
    const presentation = activityLog.events.find(
      (event) => event.extra?.event === "context-presented",
    );
    if (presentation === undefined) throw new Error("Missing context presentation");
    const line = formatActivityLogProofLine(presentation);
    expect(JSON.parse(line)).toMatchObject({
      op: "coding-runtime.history",
      correlationId: FIXTURE_RUN_ID,
      event: "context-presented",
      runId: FIXTURE_RUN_ID,
      messageCount: 1,
    });
    expect(line).not.toContain(initialContext);
    expect(line).not.toContain(prompt);

    await fixture.stop();
    await expect(fixture.runtime.runPort.submitTask(FIXTURE_RUN_ID, "after stop")).resolves.toBe(
      false,
    );
    await expect(fixture.runtime.runPort.abortTask(FIXTURE_RUN_ID)).resolves.toBe(false);
  });

  it("records a body-free diagnostic when a submitted turn terminates as failed", async () => {
    const records: Parameters<ServerDiagnosticSink["record"]>[0][] = [];
    let history: readonly Readonly<Record<string, unknown>>[] = completedTurnHistory().slice(0, 1);
    const runControl = {
      promptBodies: [] as string[],
      abortSessions: [] as string[],
      statusResponses: [{}] as unknown[],
    };
    const fixture = await startBridgeFixture(facade, undefined, {
      runControl,
      diagnostics: {
        record: (record): void => {
          records.push(record);
        },
      },
      historyResponseFactory: () => Promise.resolve(v2Envelope(history.slice().reverse())),
    });
    try {
      await expect(
        fixture.runtime.runPort.submitTask(FIXTURE_RUN_ID, "bounded failing task"),
      ).resolves.toBe(true);
      history = failedTurnHistory();
      await expect(
        fixture.runtime.runPort.waitForTerminal(FIXTURE_RUN_ID, AbortSignal.timeout(2_000)),
      ).resolves.toBe(false);
      expect(records).toEqual([
        expect.objectContaining({
          correlationId: FIXTURE_RUN_ID,
          operation: "coding-runtime.opencode-composition",
          source: "opencode.turn",
          errorClass: "OpenCodeTurnFailure",
          message: "runtime-turn-failed",
          code: "stage=terminal:db=missing",
        }),
      ]);
      const serialized = JSON.stringify(records);
      expect(serialized).not.toContain("bounded failing task");
      expect(serialized).not.toContain("SENTINEL_PROVIDER_DETAIL");
    } finally {
      await fixture.stop();
    }
  });

  it("synchronizes durable history before arming and submitting each productive turn", async () => {
    const historyCalls: Readonly<Record<string, number>>[] = [];
    const runControl = {
      promptBodies: [] as string[],
      abortSessions: [] as string[],
      statusResponses: [{}] as unknown[],
    };
    const fixture = await startBridgeFixture(facade, undefined, { historyCalls, runControl });
    try {
      const readinessCalls = historyCalls.length;
      await expect(
        fixture.runtime.runPort.submitTask(FIXTURE_RUN_ID, "bounded productive task"),
      ).resolves.toBe(true);
      expect(historyCalls.length).toBeGreaterThan(readinessCalls);
      expect(runControl.promptBodies).toHaveLength(1);
    } finally {
      await fixture.stop();
    }
  });

  it("settles abort only after HTTP success and authoritative terminal control", async () => {
    let history: readonly Readonly<Record<string, unknown>>[] = completedTurnHistory().slice(0, 1);
    const runControl = {
      promptBodies: [] as string[],
      abortSessions: [] as string[],
      statusResponses: [{}, { ses_tool: { type: "busy" } }] as unknown[],
    };
    const fixture = await startBridgeFixture(facade, undefined, {
      runControl,
      historyResponseFactory: () => Promise.resolve(v2Envelope(history.slice().reverse())),
    });
    try {
      await expect(
        fixture.runtime.runPort.submitTask(FIXTURE_RUN_ID, "bounded abort task"),
      ).resolves.toBe(true);
      const terminal = fixture.runtime.runPort.waitForTerminal(
        FIXTURE_RUN_ID,
        AbortSignal.timeout(2_000),
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      let abortSettled = false;
      const aborting = fixture.runtime.runPort.abortTask(FIXTURE_RUN_ID).finally(() => {
        abortSettled = true;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(runControl.abortSessions).toEqual(["ses_tool"]);
      expect(abortSettled).toBe(false);
      history = completedTurnHistory();
      runControl.statusResponses.push({});
      await expect(aborting).resolves.toBe(true);
      await expect(terminal).resolves.toBe(true);
    } finally {
      await fixture.stop();
    }
  });

  it("exposes only fixed-session questions through bounded answer and reject run controls", async () => {
    const questionRequests: {
      readonly method: string;
      readonly path: string;
      readonly body?: string;
    }[] = [];
    const pending = [
      {
        id: "frm_fixed",
        sessionID: "ses_tool",
        title: "Approval",
        fields: [
          {
            key: "decision",
            title: "Approval",
            description: "Approve the bounded edit?",
            type: "string",
            options: [{ label: "Approve", value: "approved", description: "Continue" }],
          },
        ],
      },
      {
        id: "frm_other",
        sessionID: "ses_other",
        title: "Other",
        fields: [{ key: "decision", title: "Other", type: "string" }],
      },
    ];
    const fixture = await startBridgeFixture(facade, undefined, {
      runControl: {
        promptBodies: [],
        abortSessions: [],
        statusResponses: [{}],
        questionResponses: [pending],
        questionRequests,
      },
    });
    try {
      await expect(fixture.runtime.runPort.listQuestions("unknown-run")).resolves.toEqual([]);
      await expect(fixture.runtime.runPort.listQuestions(FIXTURE_RUN_ID)).resolves.toEqual([
        {
          id: "que_fixed",
          sessionID: "ses_tool",
          questions: [
            {
              question: "Approve the bounded edit?",
              header: "Approval",
              options: [{ label: "Approve", description: "Continue" }],
              multiple: false,
              custom: false,
            },
          ],
        },
      ]);
      await expect(
        fixture.runtime.runPort.answerQuestion(FIXTURE_RUN_ID, "que_other", [["Approve"]]),
      ).resolves.toBe(false);
      await expect(
        fixture.runtime.runPort.answerQuestion(FIXTURE_RUN_ID, "que_fixed", []),
      ).rejects.toThrow("question-answer-rejected");
      expect(questionRequests).toEqual([]);
      await expect(
        fixture.runtime.runPort.rejectQuestion("unknown-run", "que_fixed"),
      ).resolves.toBe(false);
      await expect(
        fixture.runtime.runPort.answerQuestion(FIXTURE_RUN_ID, "que_fixed", [["Approve"]]),
      ).resolves.toBe(true);
      await expect(
        fixture.runtime.runPort.rejectQuestion(FIXTURE_RUN_ID, "que_fixed"),
      ).resolves.toBe(true);
      expect(questionRequests).toEqual([
        {
          method: "POST",
          path: "/api/session/ses_tool/form/frm_fixed/reply",
          body: '{"answer":{"decision":"approved"}}',
        },
        { method: "DELETE", path: "/api/session/ses_tool/form/frm_fixed" },
      ]);
      expect(JSON.stringify(questionRequests)).not.toContain("Approve the bounded edit?");
    } finally {
      await fixture.stop();
    }
  });

  it.each(["list", "answer", "reject"] as const)(
    "propagates V2 %s transport failures with redacted run evidence",
    async (operation) => {
      const diagnostics = persistedDiagnostics();
      const fixture = await startBridgeFixture(facade, undefined, {
        diagnostics: diagnostics.sink,
        runControl: {
          promptBodies: [],
          abortSessions: [],
          statusResponses: [{}],
          questionResponses: [{ privateContent: "PRIVATE_FORM_CONTENT" }],
        },
      });
      try {
        const port = fixture.runtime.runPort;
        const request =
          operation === "list"
            ? port.listQuestions(FIXTURE_RUN_ID)
            : operation === "answer"
              ? port.answerQuestion(FIXTURE_RUN_ID, "que_fixed", [["Approve"]])
              : port.rejectQuestion(FIXTURE_RUN_ID, "que_fixed");
        await expect(request).rejects.toThrow();
        const persisted = diagnostics.read();
        const record = expectPersistedDiagnostic(persisted, "opencode.turn");
        expect(record).toMatchObject({
          diagnosticOperation: "coding-runtime.opencode-composition",
          diagnosticSummary: "runtime-turn-failed",
        });
        expect(record.code).toMatch(/^stage=question:/u);
        expect(persisted).not.toContain("PRIVATE_FORM_CONTENT");
      } finally {
        await fixture.stop();
      }
    },
  );

  // Pins the post-await readiness re-check in answerQuestion (opencodeRuntimeComposition.ts):
  // `readyRun` hands back a live reference into the SAME mutable run record kept in the
  // composition's internal map, so a concurrent dispose that completes while the run's own
  // listQuestions() round trip is still in flight is visible on that reference the instant it
  // resolves, even though nothing re-fetches the run from the map. Before #3384 batch-6 fixed
  // `ReadyRun.ready`'s type from the literal `true` to `boolean`, TypeScript treated that
  // re-check as provably always false, which made `@typescript-eslint/no-unnecessary-condition`
  // flag it as dead code -- a lint-driven "cleanup" that deleted it would have let an
  // already-disposed run answer a question it no longer owns.
  it("fails closed when the run is disposed while its question list is still in flight", async () => {
    const questionRequests: {
      readonly method: string;
      readonly path: string;
      readonly body?: string;
    }[] = [];
    const pending = [
      {
        id: "frm_fixed",
        sessionID: "ses_tool",
        title: "Approval",
        fields: [
          {
            key: "decision",
            title: "Approval",
            description: "Approve the bounded edit?",
            type: "string",
            options: [{ label: "Approve", value: "approved", description: "Continue" }],
          },
        ],
      },
    ];
    const runtimeRef: { current?: OpenCodeRuntimeComposition } = {};
    let disposedOnce = false;
    const fixture = await startBridgeFixture(facade, undefined, {
      runControl: {
        promptBodies: [],
        abortSessions: [],
        statusResponses: [{}],
        questionResponses: [pending],
        questionRequests,
        onQuestionListFetch: async (): Promise<void> => {
          if (disposedOnce) return;
          disposedOnce = true;
          await runtimeRef.current?.manager.stop(FIXTURE_RUN_ID);
        },
      },
    });
    runtimeRef.current = fixture.runtime;
    try {
      await expect(
        fixture.runtime.runPort.answerQuestion(FIXTURE_RUN_ID, "que_fixed", [["Approve"]]),
      ).resolves.toBe(false);
      expect(questionRequests).toEqual([]);
    } finally {
      await fixture.stop();
    }
  });
});

describe("private OpenCode tool bridge", () => {
  const completed = {
    status: "completed" as const,
    evidence: [],
    read: { text: "fixture", byteCount: 7, digest: "f".repeat(64) },
  };
  const authorized = { authorization: `Bearer ${TOOL_CAPABILITY}` };
  const toolBody = (callId: string): string =>
    JSON.stringify({
      action: "read",
      actionId: `tool:${callId}`,
      idempotencyKey: `idempotency-${callId}`,
      relativePath: "src/index.ts",
    });
  // Valid requests for the tools the catalog settles beyond the sandbox default, exactly as the
  // facade's own parser accepts them (a body it refuses is admitted under the default instead),
  // each with the budget the catalog declares for it.
  const longBudgetBody = (fields: Readonly<Record<string, unknown>>): string =>
    JSON.stringify({ actionId: "tool:call_long", idempotencyKey: "idempotency-long", ...fields });
  const LONG_BUDGET_REQUESTS = [
    [
      "verification",
      longBudgetBody({ action: "verification", verifierId: "test", targetPath: "" }),
      VERIFICATION_TOOL_MAX_DURATION_MS,
    ],
    [
      "git stage proposal",
      longBudgetBody({
        action: "git",
        operation: "stage",
        phase: "propose",
        paths: ["src/index.ts"],
      }),
      GOVERNED_APPROVAL_TOOL_MAX_DURATION_MS,
    ],
    [
      "commit proposal",
      longBudgetBody({
        action: "delivery",
        intent: "commit",
        phase: "propose",
        message: "Add the landing page",
      }),
      GOVERNED_APPROVAL_TOOL_MAX_DURATION_MS,
    ],
    [
      "push proposal",
      longBudgetBody({ action: "delivery", intent: "push", phase: "propose" }),
      GOVERNED_APPROVAL_TOOL_MAX_DURATION_MS,
    ],
    [
      "pull-request proposal",
      longBudgetBody({
        action: "delivery",
        intent: "pull-request",
        phase: "propose",
        title: "Add the landing page",
      }),
      GOVERNED_APPROVAL_TOOL_MAX_DURATION_MS,
    ],
    [
      "changeset edit",
      longBudgetBody({
        action: "edit",
        changeset: {
          patch: "--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n",
          files: [{ file: "a.ts", expectedContentHash: "c".repeat(64) }],
        },
      }),
      GOVERNED_APPROVAL_TOOL_MAX_DURATION_MS,
    ],
  ] as const;
  const activityRecorder = (): {
    readonly safeActivity: FixtureSafeActivity;
    readonly settlements: Parameters<FixtureSafeActivity["settleTool"]>[0][];
  } => {
    const settlements: Parameters<FixtureSafeActivity["settleTool"]>[0][] = [];
    return {
      settlements,
      safeActivity: {
        arm: vi.fn(),
        clear: vi.fn(),
        ingest: () => true,
        recordDrops: vi.fn(),
        settleTool: (settlement): void => {
          settlements.push(settlement);
        },
      },
    };
  };

  it("settles governed read facts with the actual bridge service duration and no raw output", async () => {
    let now = Date.now();
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    const facade: CodingToolFacade = {
      execute: vi.fn(() => {
        now += 125;
        return Promise.resolve({ ...completed, read: { ...completed.read, totalLines: 400 } });
      }),
    };
    const activity = activityRecorder();
    const fixture = await startBridgeFixture(facade, undefined, {
      safeActivity: activity.safeActivity,
    });
    try {
      await fixture.runtime.toolBridge.handle({
        method: "POST",
        headers: new Headers(authorized),
        body: toolBody("call_facts"),
      });
      expect(activity.settlements).toEqual([
        expect.objectContaining({
          actionId: "tool:call_facts",
          state: "succeeded",
          presentation: {
            relativePath: "src/index.ts",
            readByteCount: 7,
            totalFileLines: 400,
            bridgeDurationMs: 125,
          },
        }),
      ]);
      expect(JSON.stringify(activity.settlements)).not.toContain("fixture");
      expect(JSON.stringify(activity.settlements)).not.toContain("digest");
    } finally {
      clock.mockRestore();
      await fixture.stop();
    }
  });

  // #3390 (ADR-0043 D11-D14): a negative proof that no production path re-opens a second loopback
  // listener for this bridge. The public port's OWN shape is the guard: it exposes exactly `url`
  // (a fixed string, never a self-issued port), `requestDeadlineMs` (a plain number the route
  // reads to bound body-ingestion by the SAME deadline the admission gate uses for execution) and
  // `handle` -- no `listen`/`close`/socket accessor a caller could use to stand up an HTTP server,
  // which is exactly what made the retired listener reachable from a Seatbelt-denied second port
  // in the first place.
  it("exposes exactly {url, requestDeadlineMs, handle} on the public bridge port -- no listener surface to reopen", async () => {
    const facade: CodingToolFacade = { execute: vi.fn(() => Promise.resolve(completed)) };
    const fixture = await startBridgeFixture(facade);
    try {
      expect(Object.keys(fixture.runtime.toolBridge).sort()).toEqual([
        "handle",
        "requestDeadlineMs",
        "url",
      ]);
      // Pins to the SAME configured value `startBridgeFixture`'s default `toolBridge` input uses
      // (`requestDeadlineMs: 50`) -- not just "some positive number" -- so a future change that
      // decouples the exposed value from the admission gate's own limit is caught here.
      expect(fixture.runtime.toolBridge.requestDeadlineMs).toBe(50);
    } finally {
      await fixture.stop();
    }
  });

  it("closes an adapter whose handshake succeeds after manager timeout disposal", async () => {
    let releaseHistory: (() => void) | undefined;
    const historyResponse = new Promise<Response>((resolve) => {
      releaseHistory = (): void => {
        resolve(v2Envelope([]));
      };
    });
    let sseCancellations = 0;
    const clearSafeActivity = vi.fn();
    const facade: CodingToolFacade = { execute: vi.fn(() => Promise.resolve(completed)) };
    const fixture = await startBridgeFixture(
      facade,
      { requestDeadlineMs: 1_000, maxInFlight: 1 },
      {
        startTimeoutMs: 20,
        historyResponse,
        expectedStart: { ok: false, failureCode: "start-timeout", retryable: true },
        safeActivity: {
          arm: vi.fn(),
          clear: clearSafeActivity,
          ingest: () => true,
          recordDrops: vi.fn(),
          settleTool: vi.fn(),
        },
        onSseCancel: (): void => {
          sseCancellations += 1;
        },
        afterStart: async (runtime, runRoot): Promise<void> => {
          expect(clearSafeActivity).toHaveBeenCalled();
          expect(runtime.manager.health()).toEqual({ status: "stopped" });
          expect(() => {
            accessSync(runRoot, constants.F_OK);
          }).toThrow();
          await expect(
            runtime.toolBridge.handle({
              method: "POST",
              headers: new Headers(authorized),
              body: "{}",
            }),
          ).resolves.toMatchObject({ status: 503 });
          releaseHistory?.();
          await vi.waitFor(() => {
            expect(sseCancellations).toBe(1);
          });
          expect(runtime.manager.health()).toEqual({ status: "stopped" });
        },
      },
    );
    await fixture.stop();
  });

  it("reports a malformed history page as one bulk drop update", async () => {
    const recordDrops = vi.fn();
    const rows = Array.from({ length: 512 }, (_, sequence) => ({
      id: `msg_malformed_${String(sequence)}`,
      time: { created: sequence },
      type: "message.part.updated.1",
    }));
    const descending = rows.slice().reverse();
    let offset = 0;
    const fixture = await startBridgeFixture(
      { execute: vi.fn(() => Promise.resolve(completed)) },
      undefined,
      {
        historyResponseFactory: (): Promise<Response> => {
          const batch = descending.slice(offset, offset + 100);
          offset += batch.length;
          return Promise.resolve(
            v2Json({
              data: batch,
              ...(offset < descending.length ? { cursor: { next: String(offset) } } : {}),
            }),
          );
        },
        expectedStart: {
          ok: false,
          failureCode: "protocol-schema-mismatch",
          retryable: false,
        },
        safeActivity: {
          arm: vi.fn(),
          clear: vi.fn(),
          ingest: () => true,
          recordDrops,
          settleTool: vi.fn(),
        },
      },
    );

    expect(recordDrops).toHaveBeenCalledOnce();
    expect(recordDrops).toHaveBeenCalledWith(512);
    await fixture.stop();
  });

  it("forwards validated canonical history to durable capture even when display signals are rejected", async () => {
    const captureMessages = vi.fn().mockReturnValue(true);
    const fixture = await startBridgeFixture(
      { execute: vi.fn(() => Promise.resolve(completed)) },
      undefined,
      {
        historyResponseFactory: () =>
          Promise.resolve(
            v2Envelope([
              {
                id: "msg_durable_assistant",
                type: "assistant",
                time: { created: 2 },
                content: [{ type: "text", text: "Retained native answer" }],
              },
              {
                id: "msg_durable_user",
                type: "user",
                time: { created: 1 },
                text: "Visible intent",
              },
            ]),
          ),
        safeActivity: {
          arm: vi.fn(),
          clear: vi.fn(),
          ingest: () => false,
          recordDrops: vi.fn(),
          settleTool: vi.fn(),
          captureMessages,
        },
      },
    );
    try {
      expect(captureMessages).toHaveBeenCalledWith([
        { messageId: "msg_durable_user", role: "user", content: "Visible intent" },
        {
          messageId: "msg_durable_assistant",
          role: "assistant",
          content: "Retained native answer",
        },
      ]);
    } finally {
      await fixture.stop();
    }
  });

  it("records a correlated reconciliation failure when live text is rewritten", async () => {
    const diagnostics = persistedDiagnostics();
    let text = "PRIVATE_Hello";
    const facade = { execute: vi.fn(() => Promise.resolve(completed)) };
    const fixture = await startBridgeFixture(facade, undefined, {
      diagnostics: diagnostics.sink,
      runControl: { promptBodies: [], abortSessions: [], statusResponses: [] },
      historyResponseFactory: () =>
        Promise.resolve(v2Envelope([{ id: "msg_user", type: "user", time: { created: 1 }, text }])),
    });
    try {
      text = "PRIVATE_He";
      await expect(fixture.runtime.runPort.submitTask(FIXTURE_RUN_ID, "next")).resolves.toBe(false);
      const record = expectPersistedDiagnostic(diagnostics.read(), "opencode.history");
      expect(record).toMatchObject({
        diagnosticOperation: "coding-runtime.history",
        diagnosticSummary: "runtime-history-failed",
        code: "stage=history:reason=text-prefix-invalid",
      });
      expect(record.frames).toEqual(
        expect.arrayContaining([
          expect.stringMatching(
            /^packages\/keiko-server\/(?:src|dist)\/coding-runtime\/opencodeV2History\.(?:ts|js):[0-9]+:[0-9]+$/u,
          ),
        ]),
      );
      expect(diagnostics.read()).not.toContain("PRIVATE_");
    } finally {
      await fixture.stop();
    }
  });

  it("preserves safe frames and causes from a history transport failure", async () => {
    const diagnostics = persistedDiagnostics();
    const failure = new Error("PRIVATE_TRANSPORT", { cause: new TypeError("PRIVATE_CAUSE") });
    failure.stack =
      "Error: PRIVATE_TRANSPORT\n    at read (/private/packages/keiko-server/dist/coding-runtime/opencodeV2HttpClient.js:88:9)";
    const fixture = await startBridgeFixture(
      { execute: vi.fn(() => Promise.resolve(completed)) },
      undefined,
      {
        diagnostics: diagnostics.sink,
        historyResponseFactory: () => Promise.reject(failure),
        expectedStart: { ok: false, failureCode: "protocol-schema-mismatch", retryable: false },
      },
    );
    try {
      expect(expectPersistedDiagnostic(diagnostics.read(), "opencode.history")).toMatchObject({
        diagnosticOperation: "coding-runtime.history",
        diagnosticSummary: "runtime-history-failed",
        code: "stage=history:reason=transport-invalid",
        frames: ["packages/keiko-server/dist/coding-runtime/opencodeV2HttpClient.js:88:9"],
        causeChain: ["TypeError"],
      });
      expect(diagnostics.read()).not.toContain("PRIVATE_");
    } finally {
      await fixture.stop();
    }
  });

  it("does not diagnose a history read cancelled by normal run disposal", async () => {
    const diagnostics = persistedDiagnostics();
    const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
    let holdHistory = false;
    let markHistoryStarted: (() => void) | undefined;
    const historyStarted = new Promise<void>((resolve) => {
      markHistoryStarted = resolve;
    });
    const fixture = await startBridgeFixture(
      { execute: vi.fn(() => Promise.resolve(completed)) },
      undefined,
      {
        diagnostics: diagnostics.sink,
        onSseStart: (controller): void => {
          streams.push(controller);
        },
        historyResponseFactory: (signal): Promise<Response> => {
          if (!holdHistory) return Promise.resolve(v2Envelope([]));
          markHistoryStarted?.();
          return new Promise((_resolve, reject) => {
            signal?.addEventListener(
              "abort",
              () => {
                reject(new Error("history read aborted", { cause: signal.reason }));
              },
              { once: true },
            );
          });
        },
      },
    );
    holdHistory = true;
    streams[0]?.enqueue(
      new TextEncoder().encode(
        'data: {"id":"evt_final","type":"session.execution.succeeded","data":{"sessionID":"ses_tool"}}\n\n',
      ),
    );
    await historyStarted;
    await fixture.stop();
    expect(diagnostics.read()).not.toContain("coding-runtime.history");
    expect(fixture.runtime.manager.health()).toEqual({ status: "stopped" });
  });

  // #3603: the gateway route refused the readiness challenge's model request (a deterministic
  // 400). The handshake ends at once under its own cause instead of waiting out the start timeout
  // as a request that never arrived, and the start is no protocol schema mismatch.
  it("ends a start whose gateway challenge the route refused under gateway-refused", async () => {
    const diagnostics = persistedDiagnostics();
    const fixture = await startBridgeFixture(
      { execute: vi.fn(() => Promise.resolve(completed)) },
      undefined,
      {
        diagnostics: diagnostics.sink,
        gatewayRefused: true,
        startTimeoutMs: 60_000,
        expectedStart: { ok: false, failureCode: "gateway-challenge-failed", retryable: false },
      },
    );
    try {
      expect(
        expectPersistedDiagnostic(diagnostics.read(), "opencode.gateway-challenge"),
      ).toMatchObject({
        diagnosticOperation: "coding-runtime.handshake",
        code: "stage=gateway-challenge:reason=gateway-refused",
      });
    } finally {
      await fixture.stop();
    }
  });

  it("records a body-free structural diagnostic for an unknown history message shape", async () => {
    const diagnostics = persistedDiagnostics();
    const sentinel = "SENTINEL_PRIVATE_HISTORY_BODY";
    const sentinelKey = "ÄpfelPrivateHistoryKey";
    const history = completedTurnHistory();
    const assistant = history.at(-2);
    if (assistant === undefined) throw new Error("assistant history fixture missing");
    const malformed = [
      ...history.slice(0, -2),
      { ...assistant, [sentinelKey]: sentinel, zebra: sentinel },
      history.at(-1),
    ];
    const fixture = await startBridgeFixture(
      { execute: vi.fn(() => Promise.resolve(completed)) },
      undefined,
      {
        diagnostics: diagnostics.sink,
        historyResponse: Promise.resolve(v2Envelope(malformed.slice().reverse())),
        expectedStart: {
          ok: false,
          failureCode: "protocol-schema-mismatch",
          retryable: false,
        },
      },
    );

    const persisted = diagnostics.read();
    const record = expectPersistedDiagnostic(persisted, "opencode.history");
    expect(record).toMatchObject({
      correlationId: FIXTURE_RUN_ID,
      diagnosticOperation: "coding-runtime.history",
      source: "opencode.history",
      diagnosticErrorClass: "OpenCodeHistoryFailure",
      diagnosticSummary: "runtime-history-failed",
    });
    expect(record.code).toMatch(
      /^stage=history:reason=event-unknown:eventSha256=[a-f0-9]{16}:role=assistant:extraCount=2:extraKeySha256=[a-f0-9]{16}$/u,
    );
    expect(persisted).not.toContain(sentinel);
    expect(persisted).not.toContain(sentinelKey);
    const keysDigest = createHash("sha256")
      .update(JSON.stringify(["zebra", sentinelKey]))
      .digest("hex")
      .slice(0, 16);
    expect(record.code).toContain(`extraKeySha256=${keysDigest}`);
    await fixture.stop();
  });

  // Run 2026-09-10: the model's first `keiko_changeset_edit` call (a 19 KiB unified diff, inside the
  // 64 KiB patch contract) left durable rows whose arguments exceeded the 4096-character metadata
  // bound; the pull threw and the run ended `runtime-failed` on its first edit. The rows a governed
  // edit legitimately leaves -- pending with the raw argument text, running, settled -- now
  // reconcile, and nothing of the patch reaches the diagnostics. The start phase pulls history more
  // than once, so the fixture answers every pull with a fresh response.
  it("reconciles a governed edit whose argument rows fill the patch contract", async () => {
    const records: ServerDiagnosticRecord[] = [];
    const patch = "x".repeat(EDITOR_AGENT_CHANGESET_MAX_PATCH_BYTES);
    const input = changesetArguments(patch);
    const fixture = await startBridgeFixture(
      { execute: vi.fn(() => Promise.resolve(completed)) },
      undefined,
      {
        diagnostics: {
          record: (record): void => {
            records.push(record);
          },
        },
        historyResponseFactory: (): Promise<Response> =>
          Promise.resolve(
            v2Envelope(
              [
                ...completedTurnHistory().slice(0, -1),
                editPartRow(3, { status: "streaming", input: JSON.stringify(input) }),
                editPartRow(4, {
                  status: "running",
                  input,
                  metadata: {},
                }),
                editPartRow(5, {
                  status: "error",
                  input,
                  error: { name: "INVALID_EDITS", data: { message: "bounded" } },
                }),
                completedTurnHistory().at(-1),
              ]
                .slice()
                .reverse(),
            ),
          ),
      },
    );

    expect(records.filter((record) => record.errorClass === "OpenCodeHistoryFailure")).toEqual([]);
    expect(JSON.stringify(records)).not.toContain("xxxxx");
    await fixture.stop();
  });

  it.each(["streaming", "SENTINEL_PRIVATE_STATUS"])(
    "records a body-free diagnostic for a refused history part with status %s",
    async (status) => {
      const diagnostics = persistedDiagnostics();
      const sentinel = "SENTINEL_PRIVATE_ARGUMENT_BODY";
      const fixture = await startBridgeFixture(
        { execute: vi.fn(() => Promise.resolve(completed)) },
        undefined,
        {
          diagnostics: diagnostics.sink,
          historyResponse: Promise.resolve(
            v2Envelope(
              [
                ...completedTurnHistory().slice(0, -1),
                {
                  ...editPartRow(3, {}),
                  content: [
                    {
                      type: "tool",
                      id: "call_private",
                      name: "keiko_PRIVATE_EMPLOYEE_A123",
                      time: { created: 3 },
                      state: {
                        status,
                        input: `${sentinel}${"x".repeat(TOOL_CATALOG_LIMITS.maxArgumentBytes)}`,
                      },
                    },
                  ],
                },
                completedTurnHistory().at(-1),
              ]
                .slice()
                .reverse(),
            ),
          ),
          expectedStart: {
            ok: false,
            failureCode: "protocol-schema-mismatch",
            retryable: false,
          },
        },
      );

      const persisted = diagnostics.read();
      const record = expectPersistedDiagnostic(persisted, "opencode.history");
      expect(record).toMatchObject({
        correlationId: FIXTURE_RUN_ID,
        diagnosticOperation: "coding-runtime.history",
        source: "opencode.history",
        diagnosticErrorClass: "OpenCodeHistoryFailure",
        diagnosticSummary: "runtime-history-failed",
      });
      expect(record.code).toMatch(
        /^stage=history:reason=argument-bound:eventSha256=[a-f0-9]{16}:toolSha256=[a-f0-9]{16}:statusSha256=[a-f0-9]{16}:partBytes=[1-9][0-9]*$/u,
      );
      expect(persisted).not.toContain(sentinel);
      expect(persisted).not.toContain("PRIVATE_EMPLOYEE_A123");
      expect(persisted).not.toContain("SENTINEL_PRIVATE_STATUS");
      await fixture.stop();
    },
  );

  // Before 2026-09-10 a pull that failed before any row was parsed -- refused, oversized, not a JSON
  // array -- reached the lifecycle failure with no line of its own. The closed reason and, for an
  // oversized pull, the budget it exceeded now travel in `code`; the response never does.
  it("records the closed transport reason when the history pull itself fails", async () => {
    const diagnostics = persistedDiagnostics();
    let cancellations = 0;
    const fixture = await startBridgeFixture(
      { execute: vi.fn(() => Promise.resolve(completed)) },
      undefined,
      {
        diagnostics: diagnostics.sink,
        historyResponse: Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>(
              {
                cancel(): void {
                  cancellations += 1;
                },
              },
              { highWaterMark: 0 },
            ),
            {
              headers: {
                "content-length": String(OPENCODE_HISTORY_RESPONSE_MAX_BYTES + 1),
                "content-type": "application/json",
              },
            },
          ),
        ),
        expectedStart: {
          ok: false,
          failureCode: "protocol-schema-mismatch",
          retryable: false,
        },
      },
    );

    expect(cancellations).toBe(1);
    const record = expectPersistedDiagnostic(diagnostics.read(), "opencode.history");
    expect(record).toMatchObject({
      correlationId: FIXTURE_RUN_ID,
      diagnosticOperation: "coding-runtime.history",
      source: "opencode.history",
      diagnosticErrorClass: "OpenCodeHistoryFailure",
      diagnosticSummary: "runtime-history-failed",
      errorKind: "internal",
      code: `stage=history:reason=transport-oversized:responseBudgetBytes=${String(OPENCODE_HISTORY_RESPONSE_MAX_BYTES)}`,
    });
    await fixture.stop();
  });

  // #3390 (ADR-0043 D11-D14): the raw-listener framing pins below (chunked-before-EOF, declared
  // Content-Length, non-POST/wrong-path routing, and the fatal UTF-8 decode) tested the RETIRED
  // `createServer` listener's own request parsing. That framing is gone -- `handle()` is now the
  // ONE dispatch surface, reached by the BFF's real route dispatcher (coding-sidecar-tool-facade.ts)
  // which reads the body itself before calling `handle()`. Each invariant that still applies to
  // `handle()` is relocated below, called directly instead of over a socket; the two that moved to
  // a different owning layer are relocated there instead (never silently dropped):
  //  - non-POST / wrong-path routing is now the router's job, not this bridge's -- covered by
  //    routes.test.ts's generic `matchRoute` method-not-allowed coverage, strengthened with an
  //    explicit pin for this route's pattern.
  //  - "reject bytes that fail to decode as UTF-8" is now the BFF body reader's job
  //    (coding-sidecar-tool-facade.ts's `readJsonObject`, over the real `IncomingMessage`) -- see
  //    coding-sidecar-tool-facade.test.ts's own malformed-encoding pin.
  it("rejects an unauthorized request before any facade call", async () => {
    const facade: CodingToolFacade = { execute: vi.fn(() => Promise.resolve(completed)) };
    const fixture = await startBridgeFixture(facade);
    try {
      await expect(
        fixture.runtime.toolBridge.handle({
          method: "POST",
          headers: new Headers(),
          body: '{"action":"read"}',
        }),
      ).resolves.toMatchObject({ status: 401 });
      expect(facade.execute).not.toHaveBeenCalled();
    } finally {
      await fixture.stop();
    }
  });

  it("rejects an Origin header before invoking the facade", async () => {
    const facade: CodingToolFacade = { execute: vi.fn(() => Promise.resolve(completed)) };
    const fixture = await startBridgeFixture(facade);
    try {
      await expect(
        fixture.runtime.toolBridge.handle({
          method: "POST",
          headers: new Headers({ ...authorized, origin: "http://untrusted.invalid" }),
          body: '{"action":"read"}',
        }),
      ).resolves.toMatchObject({ status: 403 });
      expect(facade.execute).not.toHaveBeenCalled();
    } finally {
      await fixture.stop();
    }
  });

  it("admits a body at exactly the byte budget and rejects one over it, before invoking the facade for the oversized one", async () => {
    const facade: CodingToolFacade = { execute: vi.fn(() => Promise.resolve(completed)) };
    const fixture = await startBridgeFixture(facade);
    // Padding with ASCII spaces keeps `Buffer.byteLength(body, "utf8")` equal to `body.length`,
    // so the body constructed for N bytes is EXACTLY N bytes -- the same off-by-one-sensitive
    // boundary `preflightToolRequest`'s `Buffer.byteLength(body, "utf8") > CODING_TOOL_MAX_BODY_BYTES`
    // check guards.
    const paddedObjectOfSize = (bytes: number): string => `{${" ".repeat(bytes - 2)}}`;
    try {
      const exact = paddedObjectOfSize(CODING_TOOL_MAX_BODY_BYTES);
      expect(Buffer.byteLength(exact, "utf8")).toBe(CODING_TOOL_MAX_BODY_BYTES);
      await expect(
        fixture.runtime.toolBridge.handle({
          method: "POST",
          headers: new Headers(authorized),
          body: exact,
        }),
      ).resolves.toMatchObject({ status: 200 });
      expect(facade.execute).toHaveBeenCalledOnce();
      const oversized = paddedObjectOfSize(CODING_TOOL_MAX_BODY_BYTES + 1);
      await expect(
        fixture.runtime.toolBridge.handle({
          method: "POST",
          headers: new Headers(authorized),
          body: oversized,
        }),
      ).resolves.toMatchObject({ status: 413 });
      expect(facade.execute).toHaveBeenCalledOnce();
    } finally {
      await fixture.stop();
    }
  });

  describe("a declared Content-Length", () => {
    // One request through the bridge: the status it answers and how often it ran the facade.
    const declaredLengthOutcome = async (
      declared: string,
    ): Promise<{ readonly status: number; readonly executions: number }> => {
      const facade: CodingToolFacade = { execute: vi.fn(() => Promise.resolve(completed)) };
      const fixture = await startBridgeFixture(facade);
      try {
        const response = await fixture.runtime.toolBridge.handle({
          method: "POST",
          headers: new Headers({ ...authorized, "content-length": declared }),
          body: toolBody("call_declared_length"),
        });
        return { status: response.status, executions: vi.mocked(facade.execute).mock.calls.length };
      } finally {
        await fixture.stop();
      }
    };

    it.each([
      ["a non-numeric declaration", "abc"],
      ["a negative declaration", "-1"],
      ["a leading-zero declaration", "01"],
      ["a fractional declaration", "1.5"],
      ["an unsafe-integer declaration", "9007199254740993"],
      ["a declaration over the byte budget", String(CODING_TOOL_MAX_BODY_BYTES + 1)],
    ])("rejects %s with 413 before invoking the facade", async (_label, declared) => {
      await expect(declaredLengthOutcome(declared)).resolves.toEqual({
        status: 413,
        executions: 0,
      });
    });

    it.each(["0", String(CODING_TOOL_MAX_BODY_BYTES)])(
      "admits the declaration %s within the byte budget",
      async (declared) => {
        await expect(declaredLengthOutcome(declared)).resolves.toEqual({
          status: 200,
          executions: 1,
        });
      },
    );
  });

  it("bounds admitted facade work before a second request is delegated", async () => {
    const releases: (() => void)[] = [];
    const facade: CodingToolFacade = {
      execute: vi.fn(
        () =>
          new Promise<typeof completed>((resolve) => {
            releases.push((): void => {
              resolve(completed);
            });
          }),
      ),
    };
    const fixture = await startBridgeFixture(facade, { requestDeadlineMs: 1_000, maxInFlight: 1 });
    const request = (): Promise<{ readonly status: number; readonly body: string }> =>
      fixture.runtime.toolBridge.handle({
        method: "POST",
        headers: new Headers(authorized),
        body: '{"action":"read"}',
      });
    try {
      const first = request();
      await vi.waitFor(() => {
        expect(facade.execute).toHaveBeenCalledOnce();
      });
      await expect(request()).resolves.toMatchObject({ status: 429 });
      expect(facade.execute).toHaveBeenCalledOnce();
      for (const release of releases) release();
      await expect(first).resolves.toMatchObject({ status: 200 });
    } finally {
      for (const release of releases) release();
      await fixture.stop();
    }
  });

  it("settles facade busy and rejected calls as failed", async () => {
    const activity = activityRecorder();
    const facade: CodingToolFacade = {
      execute: vi
        .fn()
        .mockResolvedValueOnce({ status: "busy", evidence: [] })
        .mockRejectedValueOnce(new Error("facade-rejected")),
    };
    const fixture = await startBridgeFixture(facade, undefined, {
      safeActivity: activity.safeActivity,
    });
    try {
      await expect(
        fixture.runtime.toolBridge.handle({
          method: "POST",
          headers: new Headers(authorized),
          body: toolBody("call_busy"),
        }),
      ).resolves.toMatchObject({ status: 429 });
      await expect(
        fixture.runtime.toolBridge.handle({
          method: "POST",
          headers: new Headers(authorized),
          body: toolBody("call_rejected"),
        }),
      ).resolves.toMatchObject({ status: 502 });
      expect(activity.settlements).toEqual([
        expect.objectContaining({ actionId: "tool:call_busy", state: "failed" }),
        expect.objectContaining({ actionId: "tool:call_rejected", state: "failed" }),
      ]);
    } finally {
      await fixture.stop();
    }
  });

  it("surfaces a synchronous facade throw as a redacted operator diagnostic", async () => {
    const activity = activityRecorder();
    const records: Parameters<ServerDiagnosticSink["record"]>[0][] = [];
    const facade: CodingToolFacade = {
      execute: vi.fn(() => {
        throw new Error("facade died before returning a promise");
      }),
    };
    const fixture = await startBridgeFixture(facade, undefined, {
      safeActivity: activity.safeActivity,
      diagnostics: {
        record: (record): void => {
          records.push(record);
        },
      },
    });
    try {
      await expect(
        fixture.runtime.toolBridge.handle({
          method: "POST",
          headers: new Headers(authorized),
          body: toolBody("call_sync_throw"),
        }),
      ).resolves.toMatchObject({ status: 502 });
      expect(activity.settlements).toEqual([
        expect.objectContaining({ actionId: "tool:call_sync_throw", state: "failed" }),
      ]);
      // The evidence's `tool:<callId>` action id is not a canonical correlation id (no `:`), so the
      // bridge maps it onto `tool-<callId>` — the documented prefix swap — rather than letting the
      // default sink replace it with its content-free marker and lose the correlation.
      expect(records).toEqual([
        expect.objectContaining({
          correlationId: "tool-call_sync_throw",
          operation: "coding-runtime.tool-bridge",
          source: "opencode-runtime-composition.facade-execute",
          errorClass: "Error",
          message: "tool-facade-failed",
        }),
      ]);
      const serialized = JSON.stringify(records);
      expect(serialized).not.toContain("facade died");
    } finally {
      await fixture.stop();
    }
  });

  // PR #3876 review (CodeRabbit, outside the diff): a delivered result is recorded, body-free, on the
  // activity log after the facade has answered — and the facade has by then executed the tool, an
  // applied edit among them. A sink that cannot take that line used to throw into the catch that
  // answers 502 and settles the SAME action a second time as failed, so the model read a failure for
  // a completed action and could repeat it. The record is evidence about the answer, never part of
  // it: the answer stands and the failure goes to the operator diagnostic.
  describe("a delivered result whose rendering record cannot be written", () => {
    const RENDER_OP = "coding-runtime.tool-result-rendered";
    // A sink that takes every line but the rendering record of the results it is told to refuse. The
    // readiness challenge's own `observed` result is recorded too, so a test that wants the run to
    // start refuses `completed` results only.
    const failingRenderSink = (
      refuses: "completed" | "every",
    ): { readonly sink: ServerLogSink; readonly other: string[] } => {
      const other: string[] = [];
      return {
        other,
        sink: {
          write: (event): void => {
            const refused =
              event.op === RENDER_OP &&
              (refuses === "every" || event.extra?.resultStatus === "completed");
            if (refused) throw new Error("PRIVATE_SINK_FAULT");
            other.push(event.op);
          },
        },
      };
    };
    const diagnosticsInto = (
      records: Parameters<ServerDiagnosticSink["record"]>[0][],
    ): ServerDiagnosticSink => ({
      record: (record): void => {
        records.push(record);
      },
    });

    it("still answers 200 with the result, settles the call once as succeeded, and diagnoses the record", async () => {
      const activity = activityRecorder();
      const records: Parameters<ServerDiagnosticSink["record"]>[0][] = [];
      const log = failingRenderSink("completed");
      const facade: CodingToolFacade = { execute: vi.fn(() => Promise.resolve(completed)) };
      const fixture = await startBridgeFixture(facade, undefined, {
        safeActivity: activity.safeActivity,
        activityLog: log.sink,
        toolResultCorrelationId: FIXTURE_RUN_ID,
        diagnostics: diagnosticsInto(records),
      });
      try {
        await expect(
          fixture.runtime.toolBridge.handle({
            method: "POST",
            headers: new Headers(authorized),
            body: toolBody("call_render_log_throws"),
          }),
        ).resolves.toEqual({ status: 200, body: JSON.stringify(completed) });

        // Exactly one settlement, the call's own: never a second one as failed.
        expect(activity.settlements).toEqual([
          expect.objectContaining({ actionId: "tool:call_render_log_throws", state: "succeeded" }),
        ]);
        // One operator diagnostic names the record that was lost, content-free and correlated to the
        // call (the `tool:<callId>` evidence id maps onto `tool-<callId>`, as the facade-failure
        // diagnostic does).
        expect(records).toEqual([
          expect.objectContaining({
            correlationId: "tool-call_render_log_throws",
            operation: "coding-runtime.tool-bridge",
            source: "opencode-runtime-composition.tool-result-render-log",
            errorClass: "Error",
            message: "tool-result-render-log-failed",
          }),
        ]);
        expect(JSON.stringify(records)).not.toContain("PRIVATE_SINK_FAULT");
        // The sink took every other line: only the rendering record was lost.
        expect(log.other.length).toBeGreaterThan(0);
      } finally {
        await fixture.stop();
      }
    });

    it("does not answer an applied edit as a failure the model could repeat", async () => {
      const activity = activityRecorder();
      const records: Parameters<ServerDiagnosticSink["record"]>[0][] = [];
      const applied = { status: "completed" as const, evidence: [] };
      const facade: CodingToolFacade = { execute: vi.fn(() => Promise.resolve(applied)) };
      const fixture = await startBridgeFixture(facade, undefined, {
        safeActivity: activity.safeActivity,
        activityLog: failingRenderSink("completed").sink,
        toolResultCorrelationId: FIXTURE_RUN_ID,
        diagnostics: diagnosticsInto(records),
      });
      try {
        const answer = await fixture.runtime.toolBridge.handle({
          method: "POST",
          headers: new Headers(authorized),
          body: JSON.stringify({
            action: "edit",
            actionId: "tool:call_applied_edit",
            idempotencyKey: "idempotency-call_applied_edit",
            changeset: {
              patch: "--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n",
              files: [{ file: "a.ts", expectedContentHash: "c".repeat(64) }],
            },
          }),
        });

        expect(answer).toEqual({ status: 200, body: JSON.stringify(applied) });
        expect(activity.settlements.map((settlement) => settlement.state)).toEqual(["succeeded"]);
        expect(records.map((record) => record.message)).toEqual(["tool-result-render-log-failed"]);
      } finally {
        await fixture.stop();
      }
    });

    // The readiness challenge is itself a tool call, answered `observed` and recorded like any other
    // result: a sink that refuses every rendering record used to fail the run's startup.
    it("does not fail the run's startup when the sink refuses the readiness challenge's record", async () => {
      const records: Parameters<ServerDiagnosticSink["record"]>[0][] = [];
      const facade: CodingToolFacade = { execute: vi.fn(() => Promise.resolve(completed)) };
      const fixture = await startBridgeFixture(facade, undefined, {
        activityLog: failingRenderSink("every").sink,
        toolResultCorrelationId: FIXTURE_RUN_ID,
        diagnostics: diagnosticsInto(records),
      });
      try {
        expect(records.map((record) => record.message)).toContain("tool-result-render-log-failed");
        expect(records.map((record) => record.message)).not.toContain("runtime-handshake-failed");
      } finally {
        await fixture.stop();
      }
    });

    it("records the rendering under the run's correlation when the sink takes it", async () => {
      const log = createBufferedServerLogSink();
      const facade: CodingToolFacade = { execute: vi.fn(() => Promise.resolve(completed)) };
      const fixture = await startBridgeFixture(facade, undefined, {
        activityLog: log,
        toolResultCorrelationId: FIXTURE_RUN_ID,
      });
      try {
        await expect(
          fixture.runtime.toolBridge.handle({
            method: "POST",
            headers: new Headers(authorized),
            body: toolBody("call_render_log_ok"),
          }),
        ).resolves.toMatchObject({ status: 200 });

        const rendered = log.events.filter(
          (event) => event.op === RENDER_OP && event.extra?.resultStatus === "completed",
        );
        expect(rendered).toHaveLength(1);
        expect(
          expectActivityLogProof(
            "coding-runtime.tool-result-rendered.emitted-line",
            formatActivityLogProofLine(rendered[0] ?? {}),
          ),
        ).toMatchObject({
          correlationId: FIXTURE_RUN_ID,
          framing: "json",
          textBlockCount: 0,
          resultStatus: "completed",
        });
      } finally {
        await fixture.stop();
      }
    });
  });

  it("degrades an overridden Error.name to a content-free class in the diagnostic", async () => {
    const records: Parameters<ServerDiagnosticSink["record"]>[0][] = [];
    const facade: CodingToolFacade = {
      execute: vi.fn(() => {
        const hostile = new Error("boom");
        hostile.name = "secret-token-abc123";
        throw hostile;
      }),
    };
    const fixture = await startBridgeFixture(facade, undefined, {
      diagnostics: {
        record: (record): void => {
          records.push(record);
        },
      },
    });
    try {
      await expect(
        fixture.runtime.toolBridge.handle({
          method: "POST",
          headers: new Headers(authorized),
          body: toolBody("call_hostile_name"),
        }),
      ).resolves.toMatchObject({ status: 502 });
      expect(records).toEqual([expect.objectContaining({ errorClass: "Error" })]);
      expect(JSON.stringify(records)).not.toContain("secret-token-abc123");
    } finally {
      await fixture.stop();
    }
  });

  it("degrades a prose-shaped actionId to the unparsed marker in the diagnostic", async () => {
    const records: Parameters<ServerDiagnosticSink["record"]>[0][] = [];
    const facade: CodingToolFacade = {
      execute: vi.fn(() => {
        throw new Error("facade sync death");
      }),
    };
    const fixture = await startBridgeFixture(facade, undefined, {
      diagnostics: {
        record: (record): void => {
          records.push(record);
        },
      },
    });
    try {
      await expect(
        fixture.runtime.toolBridge.handle({
          method: "POST",
          headers: new Headers(authorized),
          body: JSON.stringify({
            action: "read",
            actionId: "please leak this user text",
            idempotencyKey: "idempotency-hostile-action",
            relativePath: "src/index.ts",
          }),
        }),
      ).resolves.toMatchObject({ status: 502 });
      expect(records).toEqual([
        expect.objectContaining({ correlationId: "tool-bridge-unparsed-action" }),
      ]);
      expect(JSON.stringify(records)).not.toContain("please leak this user text");
    } finally {
      await fixture.stop();
    }
  });

  it("aborts delayed governed work when the client disconnects", async () => {
    let observedSignal: AbortSignal | undefined;
    let release: (() => void) | undefined;
    const invoked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const facade: CodingToolFacade = {
      execute: vi.fn((input: Parameters<CodingToolFacade["execute"]>[0]) => {
        const { signal } = input;
        observedSignal = signal;
        release?.();
        return new Promise((resolve) => {
          signal?.addEventListener(
            "abort",
            () => {
              resolve(completed);
            },
            { once: true },
          );
        });
      }) as CodingToolFacade["execute"],
    };
    const activity = activityRecorder();
    const fixture = await startBridgeFixture(
      facade,
      { requestDeadlineMs: 1_000, maxInFlight: 1 },
      { safeActivity: activity.safeActivity },
    );
    // #3390 (ADR-0043 D11-D14): a raw TCP disconnect no longer reaches this bridge directly --
    // the ROUTE (coding-sidecar-tool-facade.ts's `bindRouteDisconnect`) observes its own
    // request/response and turns that into exactly this `signal`, merged with the admission
    // gate's own deadline abort by `bindExternalAbort`. Driving that same `signal` here proves
    // the merge point directly instead of simulating a socket close this bridge never sees again.
    const disconnect = new AbortController();
    const handled = fixture.runtime.toolBridge.handle({
      method: "POST",
      headers: new Headers(authorized),
      body: toolBody("call_disconnect"),
      signal: disconnect.signal,
    });
    try {
      await invoked;
      expect(observedSignal).toBeInstanceOf(AbortSignal);
      disconnect.abort();
      await vi.waitFor(() => {
        expect(observedSignal?.aborted).toBe(true);
      });
      await vi.waitFor(() => {
        expect(activity.settlements).toEqual([
          expect.objectContaining({ actionId: "tool:call_disconnect", state: "cancelled" }),
        ]);
      });
      await expect(handled).resolves.toMatchObject({ status: 502 });
    } finally {
      disconnect.abort();
      await fixture.stop();
    }
  });

  it("passes a deadline signal to a delayed facade request", async () => {
    let observedSignal: AbortSignal | undefined;
    let release: (() => void) | undefined;
    const invoked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const facade: CodingToolFacade = {
      execute: vi.fn((input: Parameters<CodingToolFacade["execute"]>[0]) => {
        const { signal } = input;
        observedSignal = signal;
        release?.();
        return new Promise((resolve) => {
          signal?.addEventListener(
            "abort",
            () => {
              resolve(completed);
            },
            { once: true },
          );
        });
      }) as CodingToolFacade["execute"],
    };
    const activity = activityRecorder();
    const records: ServerDiagnosticRecord[] = [];
    const fixture = await startBridgeFixture(
      facade,
      { requestDeadlineMs: 30, maxInFlight: 1 },
      {
        safeActivity: activity.safeActivity,
        diagnostics: {
          record: (record): void => {
            records.push(record);
          },
        },
      },
    );
    const handled = fixture.runtime.toolBridge.handle({
      method: "POST",
      headers: new Headers(authorized),
      body: toolBody("call_timeout"),
    });
    try {
      await invoked;
      expect(observedSignal).toBeInstanceOf(AbortSignal);
      await vi.waitFor(() => {
        expect(observedSignal?.aborted).toBe(true);
      });
      await expect(handled).resolves.toMatchObject({ status: 408 });
      expect(activity.settlements).toEqual([
        expect.objectContaining({ actionId: "tool:call_timeout", state: "cancelled" }),
      ]);
      // The bridge's own deadline names itself, the configured default for an ordinary tool.
      expect(records).toEqual([
        expect.objectContaining({ message: "tool-bridge-deadline", deadlineMs: 30 }),
      ]);
    } finally {
      await fixture.stop();
    }
  });

  // #3452 (F44): the deadline a request is admitted under is read from the catalog budget of the
  // tool it dispatches to (toolBridgeRequestDeadlineMs), pinned here through the public handle()
  // surface for every tool the catalog settles beyond the sandbox default. The verification budget
  // is on the order of eleven minutes and an approval's near six, so fake timers step through them
  // without ever really waiting; the deadline's expiry leaves a diagnostic that names it.
  it.each(LONG_BUDGET_REQUESTS)(
    "keeps a %s admitted past the configured default deadline and stops it at its own",
    async (_label, body, budgetMs) => {
      const facade: CodingToolFacade = {
        execute: vi.fn((input: Parameters<CodingToolFacade["execute"]>[0]) => {
          const { signal } = input;
          return new Promise((resolve) => {
            signal?.addEventListener(
              "abort",
              () => {
                resolve(completed);
              },
              { once: true },
            );
          });
        }) as CodingToolFacade["execute"],
      };
      const records: ServerDiagnosticRecord[] = [];
      // A small configured default: were the request bound to it (a regression), it would already
      // be settled long before the first `advanceTimersByTimeAsync` ends.
      const fixture = await startBridgeFixture(
        facade,
        { requestDeadlineMs: 30, maxInFlight: 1 },
        {
          diagnostics: {
            record: (record): void => {
              records.push(record);
            },
          },
        },
      );
      try {
        vi.useFakeTimers();
        const { toolBridgeRequestDeadlineMs } = await compositionModule();
        const deadlineMs = toolBridgeRequestDeadlineMs(30, body);
        // The bridge outlives the catalog's own settlement of the tool, so the facade answers first.
        expect(deadlineMs).toBeGreaterThan(budgetMs);
        let settled = false;
        const handled = fixture.runtime.toolBridge
          .handle({ method: "POST", headers: new Headers(authorized), body })
          .then((response) => {
            settled = true;
            return response;
          });

        await vi.advanceTimersByTimeAsync(deadlineMs - 1);
        expect(settled).toBe(false);

        await vi.advanceTimersByTimeAsync(1);
        await expect(handled).resolves.toMatchObject({ status: 408 });
        expect(records).toEqual([
          expect.objectContaining({
            operation: "coding-runtime.tool-bridge",
            source: "opencode-runtime-composition.request-deadline",
            message: "tool-bridge-deadline",
            httpStatus: 408,
            deadlineMs,
          }),
        ]);
      } finally {
        vi.useRealTimers();
        await fixture.stop();
      }
    },
  );

  it("aborts a body without a recognized verification action at the configured default deadline", async () => {
    const facade: CodingToolFacade = {
      execute: vi.fn((input: Parameters<CodingToolFacade["execute"]>[0]) => {
        const { signal } = input;
        return new Promise((resolve) => {
          signal?.addEventListener(
            "abort",
            () => {
              resolve(completed);
            },
            { once: true },
          );
        });
      }) as CodingToolFacade["execute"],
    };
    const fixture = await startBridgeFixture(facade, { requestDeadlineMs: 30, maxInFlight: 1 });
    try {
      vi.useFakeTimers();
      // Valid JSON so it is admitted past preflight and reaches the facade, but declaredAction()
      // finds no "action" key at all -- requestDeadlineFor() must fall through to the configured
      // default rather than the verification budget.
      const handled = fixture.runtime.toolBridge.handle({
        method: "POST",
        headers: new Headers(authorized),
        body: '{"unrelated":true}',
      });
      await vi.advanceTimersByTimeAsync(30);
      await expect(handled).resolves.toMatchObject({ status: 408 });
    } finally {
      vi.useRealTimers();
      await fixture.stop();
    }
  });

  // The budgets the tool bridge chain relies on staying strictly ordered for every tool the catalog
  // settles beyond the sandbox default, so the sidecar always receives the server's own answer (the
  // result or the catalog's timeout) instead of racing a client- or bridge-side abort of its own.
  // Each bound is read from the layer that owns it: the catalog budget from the contract, the
  // bridge deadline from the bridge, the client timeout from the plugin generator.
  it.each(LONG_BUDGET_REQUESTS)(
    "orders the plugin client timeout above the bridge deadline above the catalog budget for a %s",
    async (_label, body, budgetMs) => {
      const { toolBridgeRequestDeadlineMs } = await compositionModule();
      const bridgeDeadlineMs = toolBridgeRequestDeadlineMs(
        DEFAULT_SANDBOX_POLICY.defaultTimeoutMs,
        body,
      );
      expect(openCodeToolClientTimeoutMs(budgetMs)).toBeGreaterThan(bridgeDeadlineMs);
      expect(bridgeDeadlineMs).toBeGreaterThan(budgetMs);
      expect(budgetMs).toBeGreaterThan(DEFAULT_SANDBOX_POLICY.defaultTimeoutMs);
    },
  );

  it("orders the verification budget above the default wall time", () => {
    expect(VERIFICATION_TOOL_MAX_DURATION_MS).toBeGreaterThan(
      DEFAULT_VERIFICATION_LIMITS.wallTimeMs,
    );
  });
});

describe("production OpenCode pending-spawn guard wiring", () => {
  it("forwards the server-owned live guard and refuses spawn before native readiness", async () => {
    const spawned = vi.fn();
    const guard = vi.fn<NonNullable<StartBridgeControl["canSpawnRuntime"]>>(() => false);
    const bridge = await startBridgeFixture(
      { execute: () => Promise.resolve({ status: "observed", evidence: [] }) },
      undefined,
      {
        canSpawnRuntime: guard,
        onSpawn: spawned,
        expectedStart: { ok: false, failureCode: "authority-resolution-failed", retryable: false },
      },
    );
    expect(guard).toHaveBeenCalledOnce();
    expect(guard.mock.calls[0]?.[0]).toMatchObject({
      runId: FIXTURE_RUN_ID,
      treeBindingId: "b".repeat(64),
      authorityEnvelopeDigest: "c".repeat(64),
    });
    expect(spawned).not.toHaveBeenCalled();
    await bridge.stop();
  });
});

it("keeps real delegate admission private for duplicate and replay bridge responses", async () => {
  const registry = createCodingToolInvocationRegistry({ now: () => 0 });
  let resolve!: (value: unknown) => void;
  const delegate = vi.fn(
    () =>
      new Promise((accept) => {
        resolve = accept;
      }),
  );
  const facade = createCodingToolFacade(
    {
      authority: {
        admit: (): ReturnType<
          import("./codingToolFacadePorts.js").CodingToolAuthorityPort["admit"]
        > => ({
          ok: true,
          binding: {
            runId: "run-1",
            workspaceId: "workspace",
            envelopeDigest: "a".repeat(64),
            workspaceRootDigest: "b".repeat(64),
            expiresAt: "2030-01-01T00:00:00.000Z",
          },
          mutationGuard: { check: () => true },
        }),
      },
      delegate: { execute: delegate },
    },
    { invocationRegistry: registry, requireInvocationRegistryForEdits: true },
  );
  const beginTool = vi.fn();
  const settleTool = vi.fn();
  const fixture = await startBridgeFixture(
    facade,
    { requestDeadlineMs: 1_000, maxInFlight: 2 },
    {
      safeActivity: {
        arm: vi.fn(),
        clear: vi.fn(),
        ingest: () => true,
        recordDrops: vi.fn(),
        beginTool,
        settleTool,
      },
    },
  );
  const request = {
    method: "POST" as const,
    headers: new Headers({ authorization: `Bearer ${TOOL_CAPABILITY}` }),
    body: JSON.stringify({
      action: "edit",
      actionId: "ses_tool:call_edit",
      idempotencyKey: "same-edit",
      changeset: {
        patch: "--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n",
        files: [{ file: "a.ts", expectedContentHash: "a".repeat(64) }],
      },
    }),
  };
  try {
    const running = fixture.runtime.toolBridge.handle(request);
    await vi.waitFor(() => {
      expect(beginTool).toHaveBeenCalledTimes(1);
    });
    const duplicate = await fixture.runtime.toolBridge.handle(request);
    expect(settleTool.mock.calls[0]?.[0]).not.toHaveProperty("delegateStarted");
    resolve({ outcome: "completed" });
    const completed = await running;
    expect(settleTool.mock.calls[1]?.[0]).toMatchObject({
      delegateStarted: true,
      state: "succeeded",
    });
    const replay = await fixture.runtime.toolBridge.handle(request);
    expect(settleTool.mock.calls[2]?.[0]).not.toHaveProperty("delegateStarted");
    expect(beginTool).toHaveBeenCalledTimes(1);
    expect(delegate).toHaveBeenCalledTimes(1);
    for (const response of [duplicate, completed, replay]) {
      expect(response.body).not.toContain("delegateStarted");
      expect(response.body).not.toContain("onDelegateStarted");
    }
  } finally {
    resolve({ outcome: "completed" });
    await fixture.stop();
    registry.dispose();
  }
});

it("retains private state and authority release until the real admitted facade effect settles", async () => {
  let release!: (value: unknown) => void;
  let effectSettled = false;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const delegate = vi.fn(async (): Promise<unknown> => {
    const result = await pending;
    effectSettled = true;
    return result;
  });
  const facade = createCodingToolFacade({
    authority: { admit: () => ({ ok: true, mutationGuard: { check: (): true => true } }) },
    delegate: { execute: delegate },
  });
  const onRelease = vi.fn();
  let runRoot = "";
  const fixture = await startBridgeFixture(
    facade,
    { requestDeadlineMs: 1_000, maxInFlight: 1 },
    {
      onRelease,
      afterStart: (_runtime, path): void => {
        runRoot = path;
      },
    },
  );
  try {
    const handled = fixture.runtime.toolBridge.handle({
      method: "POST",
      headers: new Headers({ authorization: `Bearer ${TOOL_CAPABILITY}` }),
      body: JSON.stringify({
        action: "command",
        commandId: "test",
        actionId: "tool:call_drain",
        idempotencyKey: "drain",
      }),
    });
    await vi.waitFor(() => {
      expect(delegate).toHaveBeenCalledOnce();
    });
    vi.useFakeTimers();
    const stopping = fixture.runtime.manager.stop(FIXTURE_RUN_ID);
    await vi.advanceTimersByTimeAsync(21);
    expect(await stopping).toMatchObject({ ok: false, failureCode: "runtime-reap-unproven" });
    expect(effectSettled).toBe(false);
    expect((): void => {
      accessSync(runRoot);
    }).not.toThrow();
    expect(onRelease).not.toHaveBeenCalled();
    expect(await handled).toMatchObject({ status: 502 });
    expect(
      await fixture.runtime.toolBridge.handle({
        method: "POST",
        headers: new Headers({ authorization: `Bearer ${TOOL_CAPABILITY}` }),
        body: JSON.stringify({
          action: "command",
          commandId: "test",
          actionId: "tool:call_after_close",
          idempotencyKey: "after-close",
        }),
      }),
    ).toMatchObject({ status: 503 });
    expect(delegate).toHaveBeenCalledOnce();
    const reconciling = fixture.runtime.manager.reconcile(FIXTURE_RUN_ID);
    await vi.advanceTimersByTimeAsync(21);
    expect(await reconciling).toMatchObject({ ok: false, failureCode: "runtime-reap-unproven" });
    expect(onRelease).not.toHaveBeenCalled();
    release({ outcome: "completed" });
    await vi.advanceTimersByTimeAsync(0);
    expect(effectSettled).toBe(true);
    expect((): void => {
      accessSync(runRoot);
    }).not.toThrow();
    expect(onRelease).not.toHaveBeenCalled();
    expect(await fixture.runtime.manager.reconcile(FIXTURE_RUN_ID)).toEqual({
      ok: true,
      status: "stopped",
    });
    expect((): void => {
      accessSync(runRoot);
    }).toThrow();
    expect(onRelease).toHaveBeenCalledOnce();
  } finally {
    release({ outcome: "completed" });
    vi.useRealTimers();
    await fixture.stop();
  }
});

it.each(["cooperative", "rejecting"] as const)(
  "joins a real %s delegate after close aborts it",
  async (kind) => {
    let settled = false;
    const delegate = vi.fn(
      (
        _request: Parameters<
          Parameters<typeof createCodingToolFacade>[0]["delegate"]["execute"]
        >[0],
        signal: AbortSignal | undefined,
      ): Promise<unknown> =>
        new Promise((resolve, reject) => {
          signal?.addEventListener(
            "abort",
            (): void => {
              settled = true;
              if (kind === "rejecting") reject(new Error("private-delegate-body"));
              else resolve({ outcome: "completed" });
            },
            { once: true },
          );
        }),
    );
    const facade = createCodingToolFacade({
      authority: { admit: () => ({ ok: true, mutationGuard: { check: (): true => true } }) },
      delegate: { execute: delegate },
    });
    const onRelease = vi.fn();
    let runRoot = "";
    const fixture = await startBridgeFixture(
      facade,
      { requestDeadlineMs: 1_000, maxInFlight: 1 },
      {
        onRelease,
        afterStart: (_runtime, path): void => {
          runRoot = path;
        },
      },
    );
    try {
      const handled = fixture.runtime.toolBridge.handle({
        method: "POST",
        headers: new Headers({ authorization: `Bearer ${TOOL_CAPABILITY}` }),
        body: JSON.stringify({
          action: "command",
          commandId: "test",
          actionId: "tool:call_cooperative",
          idempotencyKey: "cooperative",
        }),
      });
      await vi.waitFor(() => {
        expect(delegate).toHaveBeenCalledOnce();
      });
      expect(await fixture.runtime.manager.stop(FIXTURE_RUN_ID)).toEqual({
        ok: true,
        status: "stopped",
      });
      expect(settled).toBe(true);
      expect(await handled).toMatchObject({ status: 502 });
      expect((): void => {
        accessSync(runRoot);
      }).toThrow();
      expect(onRelease).toHaveBeenCalledOnce();
    } finally {
      await fixture.stop();
    }
  },
);

it("never removes private state after a timed-out adapter close eventually completes", async () => {
  const module = await import("./opencodeRuntimeAdapter.js");
  const createAdapter = module.createOpenCodeRuntimeAdapter;
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const closing = vi.fn();
  const spy = vi.spyOn(module, "createOpenCodeRuntimeAdapter").mockImplementation((input) => {
    const adapter = createAdapter(input);
    return {
      ...adapter,
      close: async (): Promise<void> => {
        closing();
        await pending;
        await adapter.close();
      },
    };
  });
  const onRelease = vi.fn();
  let runRoot = "";
  const fixture = await startBridgeFixture(
    createCodingToolFacade({
      authority: { admit: () => ({ ok: true, mutationGuard: { check: (): true => true } }) },
      delegate: { execute: (): Promise<unknown> => Promise.resolve({ outcome: "completed" }) },
    }),
    undefined,
    {
      onRelease,
      afterStart: (_runtime, path): void => {
        runRoot = path;
      },
    },
  );
  vi.useFakeTimers();
  try {
    const stopping = fixture.runtime.manager.stop(FIXTURE_RUN_ID);
    await vi.advanceTimersByTimeAsync(21);
    expect(await stopping).toMatchObject({ ok: false, failureCode: "runtime-reap-unproven" });
    expect(closing).toHaveBeenCalledOnce();
    expect(onRelease).not.toHaveBeenCalled();
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect((): void => {
      accessSync(runRoot);
    }).not.toThrow();
    expect(onRelease).not.toHaveBeenCalled();
    expect(await fixture.runtime.manager.reconcile(FIXTURE_RUN_ID)).toEqual({
      ok: true,
      status: "stopped",
    });
    expect((): void => {
      accessSync(runRoot);
    }).toThrow();
    expect(onRelease).toHaveBeenCalledOnce();
  } finally {
    finish();
    vi.useRealTimers();
    spy.mockRestore();
    await fixture.stop();
  }
});

it("captures the configured tool profile getter once before asynchronous readiness", async () => {
  const readToolProfile = vi.fn((): "direct" => {
    if (readToolProfile.mock.calls.length > 1) throw new Error("profile-second-read");
    return "direct";
  });
  const arm = vi.fn();
  const fixture = await startBridgeFixture(
    createCodingToolFacade({
      authority: { admit: () => ({ ok: true, mutationGuard: { check: (): true => true } }) },
      delegate: { execute: (): Promise<unknown> => Promise.resolve({ outcome: "completed" }) },
    }),
    undefined,
    {
      readToolProfile,
      safeActivity: {
        arm,
        clear: vi.fn(),
        ingest: (): true => true,
        recordDrops: vi.fn(),
        settleTool: vi.fn(),
      },
    },
  );
  try {
    expect(readToolProfile).toHaveBeenCalledOnce();
    expect(arm).toHaveBeenCalledWith("ses_tool", "direct");
    expect(await fixture.runtime.runPort.submitTask(FIXTURE_RUN_ID, "Read-only fixture task")).toBe(
      true,
    );
    expect(readToolProfile).toHaveBeenCalledOnce();
  } finally {
    await fixture.stop();
  }
});

interface NativeBridgeFixture {
  readonly facade: ReturnType<typeof createProductionManagedWorktreeToolFacade>;
  readonly authority: ReturnType<typeof catalogRuntimeFixture>;
  readonly process: ReturnType<typeof vi.fn<SecureWorkspaceTextReadProcess["run"]>>;
  readonly activity: ReturnType<typeof createBufferedServerLogSink>;
  readonly registry: ReturnType<typeof createCodingToolInvocationRegistry>;
  readonly readHead: ReturnType<typeof vi.fn<() => string>>;
  readonly control: Pick<StartBridgeControl, "workspaceRoot" | "toolFacadeCapability">;
}

function nativeBridgeWorkspace(
  authority: ReturnType<typeof catalogRuntimeFixture>,
): ProductionWorkspaceAuthorityInput {
  const c = authority.trusted;
  const instance = {
    workspaceId: c.workspaceId,
    repositoryId: c.projectId,
    repositoryRoot: authority.root,
    managedWorktreePath: authority.root,
    taskId: c.taskId,
    taskBranch: c.branchRef,
    baseBranch: c.branch.baseRef,
    lastVerifiedHead: "1".repeat(40),
    lifecycleState: "active" as const,
    health: "healthy" as const,
    driftMarkers: [],
  };
  return {
    workspaceLifecycle: {
      getActive: () => ({ instance, binding: { activeRoot: authority.root } }),
    } as unknown as ProductionWorkspaceAuthorityInput["workspaceLifecycle"],
    managedTaskWorkspaceRoot: dirname(dirname(authority.root)),
    deploymentCeiling: "autonomous-delivery",
    readWorkspaceHead: () => "1".repeat(40),
    now: () => new Date(RUNTIME_NOW),
  };
}

function nativeBridgeSnapshot(path: string, rich = true): Buffer {
  const fd = openSync(path, "r");
  try {
    const info = fstatSync(fd);
    const bytes = readFileSync(fd);
    if (!rich) return encodeSecureWorkspaceReadResponse({ status: "ok", bytes });
    return encodeSecureWorkspaceSnapshotResponse({
      status: "ok",
      bytes,
      info: { type: "file", size: info.size, mtimeMs: info.mtimeMs },
    });
  } finally {
    closeSync(fd);
  }
}

function nativeBridgeSecureRead(
  authority: ReturnType<typeof catalogRuntimeFixture>,
  process: SecureWorkspaceTextReadProcess["run"],
): ReturnType<typeof createSecureWorkspaceTextReadPort> {
  return createSecureWorkspaceTextReadPort({
    resolveWorkspaceRoot: () => authority.root,
    artifact: {
      target: "darwin-arm64",
      installRelativePath: "runtime/native/keiko-secure-workspace-read",
      sha256: "a".repeat(64),
      protocol: "KSR1/KSS1",
      snapshotProtocol: "KSR2/KSS2",
      sourceCommit: "b".repeat(40),
      sourceTreeSha256: "a".repeat(64),
      signed: true,
    },
    artifactVerifier: { verify: () => true },
    platform: { os: "darwin", arch: "arm64" },
    processFactory: { create: () => ({ run: process }) },
  });
}

function nativeBridgeFixture(
  text: string,
  effect?: SecureWorkspaceTextReadProcess["run"],
): NativeBridgeFixture {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(RUNTIME_NOW));
  const authority = catalogRuntimeFixture("autonomous-delivery");
  dirs.push(dirname(dirname(authority.root)));
  writeFileSync(join(authority.root, "fixture.ts"), text);
  const process = vi.fn<SecureWorkspaceTextReadProcess["run"]>(
    effect ??
      ((request): Promise<Buffer> =>
        Promise.resolve(
          nativeBridgeSnapshot(
            join(authority.root, "fixture.ts"),
            Buffer.from(request.stdin.subarray(0, 4)).toString("ascii") === "KSR2",
          ),
        )),
  );
  const activity = createBufferedServerLogSink();
  const registry = createCodingToolInvocationRegistry({ now: () => Date.parse(RUNTIME_NOW) });
  const readHead = vi.fn<() => string>(() => "1".repeat(40));
  const workspace = { ...nativeBridgeWorkspace(authority), readWorkspaceHead: readHead };
  const facade = createProductionManagedWorktreeToolFacade({
    authority: authority.authority,
    authorityRef: authority.minted.authorityRef,
    workspaceRoot: authority.root,
    authorityExpiresAt: authority.trusted.expiresAt,
    deploymentCeiling: "autonomous-delivery",
    effectiveMode: "autonomous-delivery",
    liveFacts: () => productionRuntimeAuthorityFacts(workspace, authority.trusted),
    resolveWorkspaceRootAccess: () => ({
      kind: "managed-task",
      canonicalRoot: authority.root,
      repositoryRoot: authority.root,
      fs: nodeWorkspaceFs,
    }),
    secureWorkspaceTextRead: nativeBridgeSecureRead(authority, process),
    editorAgentClient: { action: vi.fn() },
    onRuntimeEvent: vi.fn(),
    verificationRunner: { runToReport: vi.fn() },
    invocationRegistry: registry,
    activityLog: activity,
  });
  return {
    facade,
    authority,
    process,
    activity,
    registry,
    readHead,
    control: {
      workspaceRoot: authority.root,
      toolFacadeCapability: authority.minted.toolFacadeCapability,
    },
  };
}

function nativeBridgeInput(id = "private-native-read"): CodingToolFacadeInput {
  return {
    body: JSON.stringify({
      action: "read",
      relativePath: "fixture.ts",
      actionId: id,
      idempotencyKey: id,
    }),
  };
}

it("retains private state while the actual canonical native snapshot producer remains held", async () => {
  let release!: (value: Buffer) => void;
  let physicalSettled = false;
  const held = new Promise<Buffer>((resolve) => {
    release = resolve;
  }).then((packet) => {
    physicalSettled = true;
    return packet;
  });
  const f = nativeBridgeFixture("PRIVATE_SNAPSHOT_SENTINEL", () => held);
  const onRelease = vi.fn();
  let runRoot = "";
  const fixture = await startBridgeFixture(
    f.facade,
    { requestDeadlineMs: 1_000, maxInFlight: 1 },
    {
      ...f.control,
      onRelease,
      afterStart: (_runtime, root): void => {
        runRoot = root;
      },
    },
  );
  const result = fixture.runtime.toolBridge.nativeTextRead?.readTextSnapshot(nativeBridgeInput());
  try {
    await vi.waitFor(() => {
      expect(f.process).toHaveBeenCalledOnce();
    });
    const stopped = await fixture.runtime.manager.stop(FIXTURE_RUN_ID);
    expect(stopped).toMatchObject({ ok: false, failureCode: "runtime-reap-unproven" });
    expect((): void => {
      accessSync(runRoot);
    }).not.toThrow();
    expect(onRelease).not.toHaveBeenCalled();
    expect(physicalSettled).toBe(false);
    expect(await result).toEqual({ ok: false, reason: "cancelled" });
    expect(await fixture.runtime.manager.reconcile(FIXTURE_RUN_ID)).toMatchObject({
      ok: false,
      failureCode: "runtime-reap-unproven",
    });
    release(nativeBridgeSnapshot(join(f.authority.root, "fixture.ts")));
    await vi.waitFor(() => {
      expect(physicalSettled).toBe(true);
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect((): void => {
      accessSync(runRoot);
    }).not.toThrow();
    expect(onRelease).not.toHaveBeenCalled();
    expect(await fixture.runtime.manager.reconcile(FIXTURE_RUN_ID)).toEqual({
      ok: true,
      status: "stopped",
    });
    expect((): void => {
      accessSync(runRoot);
    }).toThrow();
    expect(onRelease).toHaveBeenCalledOnce();
  } finally {
    release(nativeBridgeSnapshot(join(f.authority.root, "fixture.ts")));
    await result;
    await fixture.stop();
    f.registry.dispose();
  }
});

it("offers the inactive native bridge facet only when the actual canonical producer exists", async () => {
  const f = nativeBridgeFixture("");
  const fixture = await startBridgeFixture(f.facade, undefined, f.control);
  try {
    expect(fixture.runtime.toolBridge.nativeTextRead?.readTextSnapshot).toBeTypeOf("function");
  } finally {
    await fixture.stop();
    f.registry.dispose();
  }
});

function readNativeBridge(
  runtime: OpenCodeRuntimeComposition,
  input: CodingToolFacadeInput = nativeBridgeInput(),
): Promise<CodingToolNativeTextSnapshotResult> {
  const facet = runtime.toolBridge.nativeTextRead;
  if (facet === undefined) throw new TypeError("Native bridge fixture is unavailable");
  return facet.readTextSnapshot(input);
}

async function stopNativeBridge(
  f: NativeBridgeFixture,
  fixture: Awaited<ReturnType<typeof startBridgeFixture>>,
): Promise<void> {
  await fixture.stop();
  f.registry.dispose();
}

it.each(["", "PRIVATE_NATIVE_SNAPSHOT_SENTINEL\n".repeat(3_000)])(
  "delivers the real native snapshot and metadata outside the model renderer (%#)",
  async (text) => {
    const f = nativeBridgeFixture(text);
    const rendered = createBufferedServerLogSink();
    const safe = {
      arm: vi.fn(),
      clear: vi.fn(),
      ingest: (): true => true,
      recordDrops: vi.fn(),
      settleTool: vi.fn(),
      beginTool: vi.fn(),
    };
    const fixture = await startBridgeFixture(
      f.facade,
      { requestDeadlineMs: 1_000, maxInFlight: 2 },
      {
        ...f.control,
        activityLog: rendered,
        toolResultCorrelationId: FIXTURE_RUN_ID,
        safeActivity: safe,
      },
    );
    const renderedBefore = rendered.events.filter(
      (event) => event.op === "coding-runtime.tool-result-rendered",
    ).length;
    try {
      const result = await readNativeBridge(fixture.runtime);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new TypeError("Expected real native snapshot");
      expect(secureWorkspaceTextDigest(result.text)).toBe(secureWorkspaceTextDigest(text));
      const stat = statSync(join(f.authority.root, "fixture.ts"));
      expect(result.info).toEqual({ type: "file", size: stat.size, mtimeMs: stat.mtimeMs });
      expect(f.process).toHaveBeenCalledOnce();
      expect(safe.beginTool).not.toHaveBeenCalled();
      expect(safe.settleTool).not.toHaveBeenCalled();
      expect(
        rendered.events.filter((event) => event.op === "coding-runtime.tool-result-rendered"),
      ).toHaveLength(renderedBefore);
      expect(
        JSON.stringify({ events: f.activity.events, rendered: rendered.events }),
      ).not.toContain("PRIVATE_NATIVE_SNAPSHOT_SENTINEL");
      expect(
        f.activity.events.some(
          (event) =>
            event.op === "tool-catalog.invocation-settled" && event.extra?.status === "completed",
        ),
      ).toBe(true);
    } finally {
      await stopNativeBridge(f, fixture);
    }
  },
);

it.each(["native-first", "model-first"] as const)(
  "shares one actual admission capacity across %s requests",
  async (order) => {
    let release!: (value: Buffer) => void;
    const held = new Promise<Buffer>((resolve) => {
      release = resolve;
    });
    let fixturePath = "";
    const f = nativeBridgeFixture("safe source", ({ stdin }) =>
      held.then(() =>
        nativeBridgeSnapshot(
          fixturePath,
          Buffer.from(stdin.subarray(0, 4)).toString("ascii") === "KSR2",
        ),
      ),
    );
    fixturePath = join(f.authority.root, "fixture.ts");
    const fixture = await startBridgeFixture(
      f.facade,
      { requestDeadlineMs: 1_000, maxInFlight: 1 },
      f.control,
    );
    const normal = (): Promise<{ readonly status: number; readonly body: string }> =>
      fixture.runtime.toolBridge.handle({
        method: "POST",
        headers: new Headers({
          authorization: `Bearer ${f.authority.minted.toolFacadeCapability}`,
        }),
        body: String(nativeBridgeInput("normal-read").body),
      });
    const first = order === "native-first" ? readNativeBridge(fixture.runtime) : normal();
    try {
      await vi.waitFor(() => {
        expect(f.process).toHaveBeenCalledOnce();
      });
      if (order === "native-first") expect(await normal()).toMatchObject({ status: 429 });
      else expect(await readNativeBridge(fixture.runtime)).toEqual({ ok: false, reason: "busy" });
      expect(f.process).toHaveBeenCalledOnce();
      release(nativeBridgeSnapshot(join(f.authority.root, "fixture.ts"), order === "native-first"));
      const firstResult = await first;
      if ("body" in firstResult) {
        expect(firstResult.status).toBe(200);
        expect(JSON.parse(firstResult.body)).toMatchObject({ status: "completed" });
      } else expect(firstResult).toMatchObject({ ok: true });
      // Each hermetic process owns its response frame, just as the real helper does.
      expect(
        await readNativeBridge(fixture.runtime, nativeBridgeInput("capacity-recovered")),
      ).toMatchObject({ ok: true });
    } finally {
      release(nativeBridgeSnapshot(join(f.authority.root, "fixture.ts"), order === "native-first"));
      await first;
      await stopNativeBridge(f, fixture);
    }
  },
);

it.each([
  ["malformed", { body: "{" }],
  [
    "wrong action",
    { body: '{"action":"command","commandId":"test","actionId":"wrong","idempotencyKey":"wrong"}' },
  ],
  [
    "window start",
    {
      body: '{"action":"read","relativePath":"fixture.ts","startLine":1,"actionId":"window","idempotencyKey":"window"}',
    },
  ],
  [
    "window size",
    {
      body: '{"action":"read","relativePath":"fixture.ts","maxLines":1,"actionId":"window","idempotencyKey":"window"}',
    },
  ],
  ["headers", { headers: new Headers() }],
  ["foreign capability", { capability: "foreign-server-capability" }],
  ["oversize", { body: "x".repeat(CODING_TOOL_MAX_BODY_BYTES + 1) }],
] as const)(
  "refuses a private %s request before canonical admission or IO",
  async (_label, override) => {
    const f = nativeBridgeFixture("safe source");
    const fixture = await startBridgeFixture(f.facade, undefined, f.control);
    try {
      expect(
        await readNativeBridge(fixture.runtime, { ...nativeBridgeInput(), ...override }),
      ).toEqual({ ok: false, reason: "invalid-request" });
      expect(f.process).not.toHaveBeenCalled();
      expect(
        f.registry.inspect({
          runId: "run-1",
          actionId: "private-native-read",
          idempotencyKey: "private-native-read",
        }),
      ).toEqual({ kind: "missing" });
    } finally {
      await stopNativeBridge(f, fixture);
    }
  },
);

it("refuses a pre-aborted private caller before the real read and refuses post-close calls", async () => {
  const f = nativeBridgeFixture("safe source");
  const fixture = await startBridgeFixture(f.facade, undefined, f.control);
  try {
    expect(
      await readNativeBridge(fixture.runtime, {
        ...nativeBridgeInput(),
        signal: AbortSignal.abort(),
      }),
    ).toEqual({ ok: false, reason: "cancelled" });
    expect(f.process).not.toHaveBeenCalled();
    await fixture.stop();
    expect(await readNativeBridge(fixture.runtime)).toEqual({
      ok: false,
      reason: "dispatch-refused",
    });
    expect(f.process).not.toHaveBeenCalled();
  } finally {
    await stopNativeBridge(f, fixture);
  }
});

it("owns mutable private request bytes before the canonical producer can observe them", async () => {
  const f = nativeBridgeFixture("safe source");
  const fixture = await startBridgeFixture(f.facade, undefined, f.control);
  try {
    const body = Buffer.from(nativeBridgeInput().body);
    const result = readNativeBridge(fixture.runtime, { body });
    body.fill(0);
    expect(await result).toMatchObject({ ok: true });
    expect(f.process).toHaveBeenCalledOnce();
  } finally {
    await stopNativeBridge(f, fixture);
  }
});

it.each(["authority-revoked", "authority-expired", "workspace-drift"] as const)(
  "withholds real native bytes when canonical postflight sees %s",
  async (change) => {
    let release!: (value: Buffer) => void;
    const held = new Promise<Buffer>((resolve) => {
      release = resolve;
    });
    const f = nativeBridgeFixture("PRIVATE_POSTFLIGHT_SENTINEL", () => held);
    const fixture = await startBridgeFixture(
      f.facade,
      { requestDeadlineMs: 1_000, maxInFlight: 1 },
      f.control,
    );
    const result = readNativeBridge(fixture.runtime);
    try {
      await vi.waitFor(() => {
        expect(f.process).toHaveBeenCalledOnce();
      });
      if (change === "authority-revoked")
        expect(f.authority.authority.revokeBeforeTerminate("run-1")).toBe(true);
      else if (change === "authority-expired")
        vi.setSystemTime(new Date(f.authority.trusted.expiresAt));
      else f.readHead.mockReturnValue("2".repeat(40));
      release(nativeBridgeSnapshot(join(f.authority.root, "fixture.ts")));
      expect(await result).toMatchObject({ ok: false });
      expect(JSON.stringify(await result)).not.toContain("PRIVATE_POSTFLIGHT_SENTINEL");
    } finally {
      release(nativeBridgeSnapshot(join(f.authority.root, "fixture.ts")));
      await result;
      await stopNativeBridge(f, fixture);
    }
  },
);

it("preserves canonical replay/refusal with no new private physical effect", async () => {
  let release!: (value: Buffer) => void;
  const held = new Promise<Buffer>((resolve) => {
    release = resolve;
  });
  const f = nativeBridgeFixture("safe source", () => held.then((packet) => Buffer.from(packet)));
  const fixture = await startBridgeFixture(
    f.facade,
    { requestDeadlineMs: 1_000, maxInFlight: 2 },
    f.control,
  );
  const result = readNativeBridge(fixture.runtime);
  try {
    await vi.waitFor(() => {
      expect(f.process).toHaveBeenCalledOnce();
    });
    expect(await readNativeBridge(fixture.runtime)).toEqual({
      ok: false,
      reason: "dispatch-refused",
    });
    expect(f.process).toHaveBeenCalledOnce();
    release(nativeBridgeSnapshot(join(f.authority.root, "fixture.ts")));
    expect(await result).toMatchObject({ ok: true });
    expect(await readNativeBridge(fixture.runtime)).toEqual({
      ok: false,
      reason: "dispatch-refused",
    });
    expect(f.process).toHaveBeenCalledOnce();
  } finally {
    release(nativeBridgeSnapshot(join(f.authority.root, "fixture.ts")));
    await result;
    await stopNativeBridge(f, fixture);
  }
});

it.each(["disconnect", "deadline"] as const)(
  "withholds late native bytes and retains capacity after %s",
  async (cause) => {
    let release!: (value: Buffer) => void;
    let settled = false;
    const held = new Promise<Buffer>((resolve) => {
      release = resolve;
    }).then((packet) => {
      settled = true;
      return packet;
    });
    const f = nativeBridgeFixture("PRIVATE_CANCELED_NATIVE_BYTES", () =>
      held.then((packet) => Buffer.from(packet)),
    );
    const diagnostics: ServerDiagnosticRecord[] = [];
    const fixture = await startBridgeFixture(
      f.facade,
      { requestDeadlineMs: cause === "deadline" ? 10 : 1_000, maxInFlight: 1 },
      {
        ...f.control,
        diagnostics: {
          record: (record): void => {
            diagnostics.push(record);
          },
        },
      },
    );
    const abort = new AbortController();
    const pending = readNativeBridge(fixture.runtime, {
      ...nativeBridgeInput(),
      signal: abort.signal,
    });
    try {
      await vi.waitFor(() => {
        expect(f.process).toHaveBeenCalledOnce();
      });
      if (cause === "disconnect") abort.abort();
      expect(await pending).toEqual({
        ok: false,
        reason: cause === "deadline" ? "timeout" : "cancelled",
      });
      expect(settled).toBe(false);
      expect(await readNativeBridge(fixture.runtime, nativeBridgeInput("after-cancel"))).toEqual({
        ok: false,
        reason: "busy",
      });
      expect(f.process).toHaveBeenCalledOnce();
      if (cause === "deadline")
        expect(diagnostics).toMatchObject([
          {
            operation: "coding-runtime.tool-bridge",
            message: "tool-bridge-deadline",
            deadlineMs: 10,
          },
        ]);
      else expect(diagnostics).toHaveLength(0);
      release(nativeBridgeSnapshot(join(f.authority.root, "fixture.ts")));
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(settled).toBe(true);
      expect(
        await readNativeBridge(fixture.runtime, nativeBridgeInput("fresh-read")),
      ).toMatchObject({ ok: true });
      expect(f.process).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(diagnostics)).not.toContain("PRIVATE_CANCELED_NATIVE_BYTES");
    } finally {
      release(nativeBridgeSnapshot(join(f.authority.root, "fixture.ts")));
      await pending;
      await stopNativeBridge(f, fixture);
    }
  },
);

it.each(["cooperative", "rejecting"] as const)(
  "joins actual %s secure-read work before releasing the stopped run",
  async (outcome) => {
    let settled = false;
    const effect: SecureWorkspaceTextReadProcess["run"] = ({ signal }) =>
      new Promise((resolve, reject) => {
        signal.addEventListener(
          "abort",
          (): void => {
            settled = true;
            if (outcome === "rejecting") reject(new Error("PRIVATE_SECURE_READ_FAILURE"));
            else resolve(Buffer.alloc(0));
          },
          { once: true },
        );
      });
    const f = nativeBridgeFixture("safe source", effect);
    const onRelease = vi.fn();
    const fixture = await startBridgeFixture(
      f.facade,
      { requestDeadlineMs: 1_000, maxInFlight: 1 },
      { ...f.control, onRelease },
    );
    const pending = readNativeBridge(fixture.runtime);
    try {
      await vi.waitFor(() => {
        expect(f.process).toHaveBeenCalledOnce();
      });
      expect(await fixture.runtime.manager.stop(FIXTURE_RUN_ID)).toEqual({
        ok: true,
        status: "stopped",
      });
      expect(settled).toBe(true);
      expect(await pending).toEqual({ ok: false, reason: "cancelled" });
      expect(onRelease).toHaveBeenCalledOnce();
      expect(JSON.stringify(f.activity.events)).not.toContain("PRIVATE_SECURE_READ_FAILURE");
    } finally {
      await stopNativeBridge(f, fixture);
    }
  },
);

it("retains an explicit canonical denied read without starting a physical effect", async () => {
  const f = nativeBridgeFixture("safe source");
  const fixture = await startBridgeFixture(f.facade, undefined, f.control);
  try {
    const result = await readNativeBridge(fixture.runtime, {
      body: JSON.stringify({
        action: "read",
        actionId: "denied-read",
        idempotencyKey: "denied-read",
        relativePath: ".env",
      }),
    });
    expect(result).toMatchObject({ ok: false });
    expect(f.process).not.toHaveBeenCalled();
    expect(await fixture.runtime.manager.stop(FIXTURE_RUN_ID)).toEqual({
      ok: true,
      status: "stopped",
    });
  } finally {
    await stopNativeBridge(f, fixture);
  }
});

it("captures the private producer function once before readiness and repeated reads", async () => {
  const f = nativeBridgeFixture("safe source");
  const original = f.facade.nativeTextRead;
  if (original === undefined) throw new TypeError("Native snapshot fixture unavailable");
  const readMethod = vi.fn(() => {
    if (readMethod.mock.calls.length > 1) throw new Error("native-producer-second-read");
    return original.readTextSnapshot;
  });
  const fixture = await startBridgeFixture(
    {
      ...f.facade,
      nativeTextRead: {
        get readTextSnapshot() {
          return readMethod();
        },
      },
    },
    undefined,
    f.control,
  );
  try {
    expect(Object.isFrozen(fixture.runtime.toolBridge.nativeTextRead)).toBe(true);
    expect(await readNativeBridge(fixture.runtime, nativeBridgeInput("captured-1"))).toMatchObject({
      ok: true,
    });
    expect(await readNativeBridge(fixture.runtime, nativeBridgeInput("captured-2"))).toMatchObject({
      ok: true,
    });
    expect(readMethod).toHaveBeenCalledOnce();
  } finally {
    await stopNativeBridge(f, fixture);
  }
});

it.each(["synchronous", "asynchronous"] as const)(
  "classifies a %s private facade fault without exposing body or error text",
  async (kind) => {
    const native = {
      readTextSnapshot: (): Promise<CodingToolNativeTextSnapshotResult> => {
        const error = new Error("PRIVATE_FACADE_FAILURE_SENTINEL");
        if (kind === "synchronous") throw error;
        return Promise.reject(error);
      },
    };
    const diagnostics: ServerDiagnosticRecord[] = [];
    const fixture = await startBridgeFixture(
      {
        execute: (): Promise<import("./codingToolIpc.js").CodingToolResult> =>
          Promise.resolve({ status: "failed", evidence: [] }),
        nativeTextRead: native,
      },
      undefined,
      {
        diagnostics: {
          record: (record): void => {
            diagnostics.push(record);
          },
        },
      },
    );
    try {
      expect(await readNativeBridge(fixture.runtime)).toEqual({
        ok: false,
        reason: "dispatch-refused",
      });
      expect(diagnostics).toMatchObject([
        {
          operation: "coding-runtime.tool-bridge",
          errorClass: "Error",
          message: "tool-facade-failed",
        },
      ]);
      expect(JSON.stringify(diagnostics)).not.toContain("PRIVATE_FACADE_FAILURE_SENTINEL");
      expect(await fixture.runtime.manager.stop(FIXTURE_RUN_ID)).toEqual({
        ok: true,
        status: "stopped",
      });
    } finally {
      await fixture.stop();
    }
  },
);

it.each(["direct", "code-mode"] as const)(
  "materializes the selected %s profile into the real native config and plugin sources",
  async (profile) => {
    const fixture = await startBridgeFixture(
      { execute: () => Promise.resolve({ status: "observed", evidence: [] }) },
      undefined,
      {
        readToolProfile: () => profile,
        afterStart: (_runtime, runRoot): void => {
          const config = readFileSync(join(runRoot, "config", "opencode", "opencode.json"), "utf8");
          expect(config.includes('{"action":"execute","resource":"*","effect":"allow"}')).toBe(
            profile === "code-mode",
          );
          for (const [name, source] of Object.entries(createGeneratedOpenCodeV2Plugins(profile))) {
            expect(
              readFileSync(join(runRoot, "config", "opencode", "plugins", `${name}.ts`), "utf8"),
            ).toBe(source);
          }
        },
      },
    );
    try {
      expect(fixture.runtime.manager.health()).toMatchObject({ status: "ready" });
    } finally {
      await fixture.stop();
    }
  },
);

async function preparationReceipt(): Promise<
  Extract<OpenCodeServiceHostDiskReceipt, { readonly ok: true }>
> {
  const payloadRoot = tempDir("keiko-host-composition-bytes-");
  mkdirSync(join(payloadRoot, "runtime"));
  mkdirSync(join(payloadRoot, "evidence"));
  for (const [path] of OPENCODE_SERVICE_HOST_DISK_EVIDENCE)
    writeFileSync(join(payloadRoot, path), "inactive byte fixture");
  const measured = attestPortableSidecarTreeSync(
    payloadRoot,
    "runtime/node",
    Date.now() + 5000,
    undefined,
    OPENCODE_SERVICE_HOST_DISK_EVIDENCE.map(([path]) => path),
  );
  const base = (
    JSON.parse(
      readFileSync(
        new URL(
          "../../../keiko-contracts/src/opencode-service-host.private-qualified.fixture.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as { readonly approval: Record<string, unknown> }
  ).approval;
  const approval = {
    ...base,
    payloadTreeSha256: measured.treeSha256,
    ...Object.fromEntries(
      OPENCODE_SERVICE_HOST_DISK_EVIDENCE.map(([path, field]) => [
        field,
        measured.selectedFileSha256ByPath?.[path],
      ]),
    ),
  };
  const receipt = await inspectOpenCodeServiceHostDisk(
    {
      payloadRoot,
      target: "macos-arm64",
      approval,
      trustedSupplement: { "macos-arm64": approval },
    },
    { deadline: Date.now() + 5000 },
  );
  if (!receipt.ok) throw new Error("Expected supplementary byte receipt");
  return receipt;
}

async function stoppedPreparationFixture(
  profile: "direct" | "code-mode" = "direct",
): ReturnType<typeof startBridgeFixture> {
  const fixture = await startBridgeFixture(
    { execute: () => Promise.resolve({ status: "observed", evidence: [] }) },
    undefined,
    {
      gatewayUrl: "http://127.0.0.1:4391/api/coding-sidecar/gateway",
      readToolProfile: () => profile,
    },
  );
  await fixture.stop();
  return fixture;
}

describe("inactive fixed-host preparation at existing captured composition", () => {
  it("derives fixed packet config/capabilities/root from the actual accepted CLI producer values", async () => {
    const fixture = await stoppedPreparationFixture();
    const receipt = await preparationReceipt();
    const result = await fixture.runtime.prepareServiceHost(fixture.preparation, receipt);
    expect(result.ok).toBe(true);
    if (!result.ok || result.serviceHost === undefined)
      throw new Error("Expected inactive host preparation");
    const { binding, packet } = result.serviceHost;
    const root = result.env?.OPENCODE_CONFIG_DIR;
    if (root === undefined) throw new Error("Expected captured config root");
    const config = readFileSync(join(root, "opencode.json"));
    expect(binding.configDigest).toBe(createHash("sha256").update(config).digest("hex"));
    expect(binding.workspace).toBe(fixture.preparation.env.KEIKO_CODING_WORKSPACE_ROOT);
    expect(binding.mode).toBe(fixture.preparation.env.KEIKO_CODING_MODE);
    expect(binding.password).toBe(result.env?.OPENCODE_SERVER_PASSWORD);
    expect(binding.providerCapability).toBe(MODEL_CAPABILITY);
    expect(binding.facadeCapability).toBe(TOOL_CAPABILITY);
    expect(binding.facadeURL).toBe(fixture.runtime.toolBridge.url);
    expect(JSON.parse(packet)).toEqual(binding);
    await expect(
      fixture.runtime.runPort.submitTask(fixture.preparation.runId, "must remain inactive"),
    ).resolves.toBe(false);
    await expect(fixture.runtime.prepareServiceHost(fixture.preparation, receipt)).resolves.toEqual(
      { ok: false, reason: "host-preparation-unqualified" },
    );
  });

  it("fails host readiness before reading startup or opening an adapter through the same lifecycle owner", async () => {
    const managerModule = await import("./codingRuntimeManager.js");
    const original = managerModule.createCodingRuntimeManager;
    let lifecycle: OpenCodeLifecycleAdapter | undefined;
    vi.spyOn(managerModule, "createCodingRuntimeManager").mockImplementation((input) => {
      lifecycle = input.openCodeLifecycleAdapter;
      return original(input);
    });
    const fixture = await stoppedPreparationFixture();
    const result = await fixture.runtime.prepareServiceHost(
      fixture.preparation,
      await preparationReceipt(),
    );
    expect(result.ok).toBe(true);
    let reads = 0;
    if (lifecycle === undefined) throw new Error("Expected actual lifecycle owner");
    await expect(
      lifecycle.handshake({
        runId: fixture.preparation.runId,
        timeoutMs: 100,
        startupOutput: {
          nextLine: (): Promise<string> => {
            reads += 1;
            return Promise.reject(new Error("must not read"));
          },
        },
        onPermission: (): void => undefined,
      }),
    ).resolves.toEqual({ ok: false, reason: "host-readiness-unqualified" });
    expect(reads).toBe(0);
  });

  it("refuses CodeMode while fixed host assets are direct and rejects a copied receipt", async () => {
    const codeMode = await stoppedPreparationFixture("code-mode");
    const receipt = await preparationReceipt();
    await expect(
      codeMode.runtime.prepareServiceHost(codeMode.preparation, receipt),
    ).resolves.toEqual({ ok: false, reason: "host-preparation-unqualified" });
    const direct = await stoppedPreparationFixture();
    await expect(
      direct.runtime.prepareServiceHost(direct.preparation, { ...receipt }),
    ).resolves.toEqual({ ok: false, reason: "config-materialization-failed" });
    await expect(
      direct.runtime.prepareServiceHost(direct.preparation, receipt),
    ).resolves.toMatchObject({ ok: true });
  });
});

describe("accepted original native session Location binding", () => {
  it.each([
    { created: "wrong" as const },
    { created: "missing" as const },
    { echoed: "wrong" as const },
    { echoed: "missing" as const },
  ])("refuses inconsistent native Location before model readiness: %j", async (fault) => {
    const stages: string[] = [];
    const diagnostics = { record: vi.fn<(record: ServerDiagnosticRecord) => void>() };
    const fixture = await startBridgeFixture(
      { execute: () => Promise.resolve({ status: "observed", evidence: [] }) },
      undefined,
      {
        sessionLocation: { ...fault, stages },
        diagnostics,
        expectedStart: { ok: false, failureCode: "protocol-schema-mismatch", retryable: false },
      },
    );
    expect(stages).not.toContain("prompt");
    expect(diagnostics.record).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "coding-runtime.handshake",
        code: "session-echo",
        correlationId: FIXTURE_RUN_ID,
      }),
    );
    const record = JSON.stringify(diagnostics.record.mock.calls);
    expect(record).not.toContain("other-workspace");
    expect(record).not.toContain(fixture.preparation.env.KEIKO_CODING_WORKSPACE_ROOT);
    expect(fixture.runtime.manager.health().status).toBe("stopped");
  });

  it("keeps the actual original Location shape bound to the supervisor-proved accepted root", async () => {
    const stages: string[] = [];
    const fixture = await startBridgeFixture(
      { execute: () => Promise.resolve({ status: "observed", evidence: [] }) },
      undefined,
      { sessionLocation: { stages } },
    );
    expect(stages.slice(0, 2)).toEqual(["created", "echoed"]);
    expect(stages).toContain("prompt");
    expect(fixture.runtime.manager.health().status).toBe("ready");
    await fixture.stop();
  });

  it("refuses cancellation after original creation before echo/model readiness", async () => {
    const controller = new AbortController();
    const stages: string[] = [];
    const fixture = await startBridgeFixture(
      { execute: () => Promise.resolve({ status: "observed", evidence: [] }) },
      undefined,
      {
        signal: controller.signal,
        sessionLocation: {
          stages,
          afterCreated: (): void => {
            controller.abort();
          },
        },
        expectedStart: { ok: false, failureCode: "start-aborted", retryable: true },
      },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(stages).toEqual(["created"]);
    expect(fixture.runtime.manager.health().status).toBe("stopped");
  });
});
