import { createBufferedServerLogSink } from "../../../../tests/support/buffered-server-log.js";

import { type ServerLogSink } from "@oscharko-dev/keiko-activity-log";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  accessSync,
  existsSync,
  closeSync,
  fstatSync,
  openSync,
  chmodSync,
  constants,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi, type Mock } from "vitest";
import { planLongLivedRuntimeSandbox } from "@oscharko-dev/keiko-sandbox";

import { CodingRuntimeAuthorityService } from "./runtimeAuthorityService.js";
import {
  createCodingSessionContinuity,
  type CodingSessionContinuity,
} from "./codingSessionContinuity.js";
import { retainedSessionKey, type RetainedSessionStore } from "./opencodeSessionRetention.js";
import { EditorAgentAuthorityRegistry } from "../editor/agentAuthorityRegistry.js";
import { createInMemoryRuntimeCapabilityStore } from "./runtimeCapabilityStore.js";
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
  CodingAcceptedInitializationReadPort,
  CodingAcceptedInitializationFacet,
  CodingToolNativeTextReadFacet,
  CodingToolNativeReadBeginInput,
  CodingToolNativeReadIdentity,
  CodingToolNativeTextSnapshotResult,
} from "./codingToolFacadePorts.js";
import { createProductionManagedWorktreeToolFacade } from "./productionManagedWorktreeTools.js";
import {
  createSecureWorkspaceTextReadPort,
  secureWorkspaceTextDigest,
} from "./secureWorkspaceTextRead.js";
import {
  encodeSecureWorkspaceReadResponse,
  decodeSecureWorkspaceNativeResponse,
  encodeSecureWorkspaceSnapshotResponse,
} from "./secureWorkspaceTextReadProtocol.js";
import { createNodeSecureWorkspaceReadProcessFactory } from "./secureWorkspaceTextReadNodeProcess.js";
import type { SecureWorkspaceTextReadArtifact } from "./secureWorkspaceTextReadArtifact.js";
import {
  SECURE_WORKSPACE_TEXT_READ_TIMEOUT_MS,
  type SecureWorkspaceTextReadProcess,
} from "./secureWorkspaceTextReadProcess.js";
import type { SecureWorkspaceNativeFileIO } from "./secureWorkspaceTextRead.js";
import type { CodingRuntimeRepositoryItemsPort } from "./codingRuntimeRepositoryItems.js";
import { createProductionAcceptedInitializationAuthority } from "./productionCodingRuntimeResolver.js";
import {
  catalogRuntimeFixture,
  RUNTIME_NOW,
} from "../tool-catalog/__fixtures__/catalogRuntimeFixture.js";
import {
  productionRuntimeAuthorityFacts,
  type ProductionWorkspaceAuthorityInput,
} from "./productionRuntimeWorkspaceAuthority.js";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import type { WorkspaceRootAccess } from "../task-workspace/workspace-root-access.js";
import { dirname } from "node:path";
import { createCodingToolFacade } from "./codingToolFacade.js";
import { createCodingToolNativeSettlementFacet } from "./codingToolNativeEffect.js";
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
import type {
  AdmittedPromptInputs,
  PromptInputsAdmission,
  PromptInputsRequest,
} from "./opencodePromptInputs.js";
import { OPENCODE_NATIVE_REQUIRED_PLUGINS } from "./opencodeNativePluginReadiness.js";
import { CODING_TOOL_MAX_BODY_BYTES } from "./codingToolIpc.js";
import { openCodeV2PromptFileData } from "./opencodeV2HttpClient.js";

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
const OPENCODE_VERSION = "2.1.4";
const FIXED_SESSION_TITLE = "Keiko governed runtime";
const OPENCODE_SCHEMA_SHA256 = "4a01890f5810d71dca59ee39d9fb101c95f3bdf46332986a0bab0fa3885b68b9";
// Captured structural projection from OpenCode 2.1.4's actual OpenAPI document.
const OPENAPI: unknown = JSON.parse(
  readFileSync(
    new URL("./opencodeProtocolSurface.opencode-2.1.4.fixture.json", import.meta.url),
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
    readonly acceptedInitialization?: CodingAcceptedInitializationFacet | undefined;
    handle(input: {
      readonly method: "POST";
      readonly headers: Headers;
      readonly body: string;
      readonly signal?: AbortSignal;
    }): Promise<{
      readonly status: number;
      readonly body: string;
      readonly nativeBytes?: Uint8Array;
      readonly nativeResult?: true;
    }>;
  };
  readonly runPort: {
    readonly submitTask: (
      runId: string,
      text: string,
      initialContext?: string,
      agent?: "build" | "plan",
      inputs?: AdmittedPromptInputs,
    ) => Promise<boolean>;
    /** What a prompt may carry besides its text, and the operations that honour it (ADR-0137 D10). */
    readonly promptInputs?:
      | { readonly delivery: boolean; readonly references: boolean; readonly commands?: boolean }
      | undefined;
    readonly admitPromptInputs?:
      ((runId: string, request: PromptInputsRequest) => PromptInputsAdmission) | undefined;
    readonly deliverPrompt?:
      ((runId: string, text: string, inputs: AdmittedPromptInputs) => Promise<boolean>) | undefined;
    /** The run's slash commands and the confirmation of a turn's command (C02, ADR-0137 D10). */
    readonly listCommands?:
      | ((
          runId: string,
          correlationId?: string,
        ) => Promise<
          readonly { readonly name: string; readonly description?: string }[] | undefined
        >)
      | undefined;
    readonly admitCommand?:
      ((runId: string, inputs: AdmittedPromptInputs) => Promise<PromptInputsAdmission>) | undefined;
    /** The messages sent into the running turn that the runtime has not taken yet (S07). */
    readonly listInbox?:
      | ((
          runId: string,
          correlationId?: string,
        ) => Promise<
          | readonly {
              readonly itemId: string;
              readonly delivery: "queue" | "steer";
              readonly preview: string;
            }[]
          | undefined
        >)
      | undefined;
    readonly actOnInbox?:
      | ((
          runId: string,
          input: { readonly action: "cancel" | "promote"; readonly itemId: string },
          correlationId?: string,
        ) => Promise<
          | { readonly ok: true; readonly outcome: string }
          | { readonly ok: false; readonly reason: string }
        >)
      | undefined;
    readonly selectableAgents?: readonly ("build" | "plan")[] | undefined;
    readonly abortTask: (runId: string) => Promise<boolean>;
    /** Undo and restore of the newest turn; offered by the native profile only (B3, S04). */
    readonly revertTurn?:
      | ((
          runId: string,
          action: "restore" | "undo",
          correlationId?: string,
        ) => Promise<
          | {
              readonly ok: true;
              readonly fileCount: number;
              readonly additions: number;
              readonly deletions: number;
            }
          | { readonly ok: false; readonly reason: string }
        >)
      | undefined;
    readonly revertState?:
      | ((runId: string) => Promise<
          | {
              readonly staged: boolean;
              readonly fileCount: number;
              readonly additions: number;
              readonly deletions: number;
            }
          | undefined
        >)
      | undefined;
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
  readonly nativeSessionDescendsFromRun: (
    sessions: readonly Readonly<Record<string, unknown>>[],
    sessionID: string,
    primaryId: string,
    workspaceRoot: string,
  ) => boolean;
  readonly toolBridgeRequestDeadlineMs: (
    configuredDeadlineMs: number,
    body: string | undefined,
  ) => number;
  createOpenCodeRuntimeComposition(input: {
    readonly activityLog?: ServerLogSink;
    readonly canSpawnRuntime?: (request: Parameters<CodingRuntimeManager["start"]>[0]) => boolean;
    readonly toolProfile?: "direct" | "code-mode" | "native" | undefined;
    readonly processEnv?: NodeJS.ProcessEnv | undefined;
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
    readonly resolveWorkspaceRootAccess?: (() => WorkspaceRootAccess | undefined) | undefined;
    readonly governedEventSink: {
      readonly execute: (
        identityKey: string,
        event: OpenCodeReconciliationEvent,
      ) => Promise<OpenCodeGovernedSinkReceipt>;
    };
    readonly safeActivity?: {
      readonly arm: (sessionId?: string, profile?: "direct" | "code-mode" | "native") => void;
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

/**
 * The producer's receipt for a prompt: it echoes the message id the body carried (the pinned
 * `Session.Inbox.User`), which the client reconciles against the id it sent; a prompt without an id
 * keeps the empty receipt it always had.
 */
function promptReceipt(path: string, body: BodyInit | null | undefined): Record<string, unknown> {
  const sent: unknown = typeof body === "string" ? JSON.parse(body) : undefined;
  const id = typeof sent === "object" && sent !== null ? (sent as { id?: unknown }).id : undefined;
  return typeof id === "string" ? { id, sessionID: path.split("/")[3] ?? "", type: "user" } : {};
}

const NATIVE_MESSAGE_ID = /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/u;

/** A turn's prompt as the producer receives it: the input carries its own native message id. */
function turnPrompt(fields: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return { ...fields, id: expect.stringMatching(NATIVE_MESSAGE_ID) as unknown };
}

function parsedBodies(bodies: readonly string[]): unknown[] {
  return bodies.map((body) => JSON.parse(body) as unknown);
}

/** The producer's side of a turn prompt, as `runControl.promptAcknowledgement` scripts it. */
function storedTurnPrompt(
  runControl: NonNullable<StartBridgeControl["runControl"]>,
  path: string,
  body: string,
): Promise<Response> {
  const acknowledgement = runControl.promptAcknowledgement?.() ?? "deliver";
  if (acknowledgement === "refuse") return Promise.resolve(new Response("", { status: 400 }));
  const receipt = promptReceipt(path, body);
  const stored = runControl.promptBodies.some(
    (held) => receipt.id !== undefined && promptReceipt(path, held).id === receipt.id,
  );
  if (!stored) runControl.promptBodies.push(body);
  if (acknowledgement === "lose") return Promise.reject(new TypeError("fetch failed"));
  return Promise.resolve(v2Envelope(receipt));
}

/**
 * The producer's session inbox, derived from the delivered prompts the fixture stored: every
 * prompt that carried a `delivery` is pending until the test withdraws it (`DELETE`) or marks it
 * delivered, and a `PATCH` changes its delivery, as the pinned producer does (204 for each).
 */
function inboxResponse(
  inbox: NonNullable<NonNullable<StartBridgeControl["runControl"]>["inbox"]>,
  promptBodies: readonly string[],
  path: string,
  init: RequestInit | undefined,
): Response {
  const method = init?.method ?? "GET";
  const scripted = inbox.respond?.();
  if (scripted !== undefined) return scripted;
  inbox.requests.push({
    method,
    path,
    ...(typeof init?.body === "string" ? { body: init.body } : {}),
  });
  const entryId = path.split("/")[5] ?? "";
  if (method === "DELETE") {
    inbox.withdrawn.add(entryId);
    return new Response(null, { status: 204 });
  }
  if (method === "PATCH") {
    inbox.promoted.add(entryId);
    return new Response(null, { status: 204 });
  }
  const pending = promptBodies.flatMap((body) => {
    const parsed = JSON.parse(body) as { id?: string; delivery?: "queue" | "steer"; text: string };
    const id = parsed.id;
    if (id === undefined || parsed.delivery === undefined) return [];
    if (inbox.withdrawn.has(id) || inbox.delivered.has(id)) return [];
    return [
      {
        id,
        sessionID: "ses_tool",
        time: { created: 1 },
        type: "user",
        payload: { text: parsed.text },
        delivery: inbox.promoted.has(id) ? "steer" : parsed.delivery,
      },
    ];
  });
  return v2Envelope([...inbox.runtimeOwned, ...pending]);
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
  readonly resolveWorkspaceRootAccess?: (() => WorkspaceRootAccess | undefined) | undefined;
  /** Extra sessions the runtime's session list reports (native child sessions, #3897). */
  readonly childSessions?: readonly Record<string, unknown>[];
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
  readonly readToolProfile?: () => "direct" | "code-mode" | "native";
  /** What `plugin.list` reports; absent reports Keiko's generated plugins active. */
  readonly pluginEntries?: (launch: RuntimeSupervisorLaunchRequest | undefined) => unknown[];
  readonly canSpawnRuntime?: (request: Parameters<CodingRuntimeManager["start"]>[0]) => boolean;
  readonly onSpawn?: (() => void) | undefined;
  readonly stdinLifetime?: {
    readonly supports: true;
    readonly launches: RuntimeSupervisorLaunchRequest[];
    readonly pipe: PassThrough;
  };
  readonly activityLog?: ServerLogSink;
  /** The repository items admission the composition is handed (#3903). */
  readonly repositoryItems?: CodingRuntimeRepositoryItemsPort;
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
  /** Native session continuity (S02/S03, #3904): the shared service and what the runtime holds. */
  readonly continuity?: FixtureContinuity;
  readonly runControl?: {
    readonly promptBodies: string[];
    /**
     * How the producer answers each turn prompt: `deliver` (the default) stores it and returns its
     * receipt, `lose` stores it and then loses the reply, `refuse` answers 400 and stores nothing. A
     * prompt whose id is already stored is answered with its receipt and not stored twice, as the
     * pinned producer deduplicates a resent input.
     */
    readonly promptAcknowledgement?: () => "deliver" | "lose" | "refuse";
    /** Each `POST /api/session/{id}/agent`, with how many prompts had been posted before it. */
    readonly agentRequests?: {
      readonly path: string;
      readonly body: string;
      readonly promptsBefore: number;
    }[];
    readonly agentResponse?: () => Response;
    /** The slash command routes of a native run (C02): the listing and the session command. */
    readonly commands?: {
      /** Each `GET /api/command` and `POST /api/session/{id}/command`, in arrival order. */
      readonly requests: {
        readonly method: string;
        readonly path: string;
        readonly body?: string;
      }[];
      /** What `GET /api/command` answers. */
      listing: unknown[];
      /** What `GET /api/command` fails with, when it should not answer the listing. */
      listingResponse?: (() => Response) | undefined;
      /** What `POST .../command` answers; the runtime's 204 by default. */
      commandResponse?: (() => Response) | undefined;
    };
    /** The session inbox routes of a native run (S07): listing, withdrawal and delivery change. */
    readonly inbox?: {
      readonly requests: {
        readonly method: string;
        readonly path: string;
        readonly body?: string;
      }[];
      /** Entries the runtime queued on its own; listed first, never the operator's. */
      readonly runtimeOwned: unknown[];
      /** Ids a `DELETE` withdrew. */
      readonly withdrawn: Set<string>;
      /** Ids a `PATCH` changed to `steer`. */
      readonly promoted: Set<string>;
      /** Ids the running turn already took: no longer pending. */
      readonly delivered: Set<string>;
      /** Answers every inbox request with this instead, when the producer should fail. */
      respond?: (() => Response) | undefined;
    };
    /** The session diff and revert routes of a native run (B3, S04). */
    readonly revert?: {
      readonly requests: {
        readonly method: string;
        readonly path: string;
        readonly body?: string;
      }[];
      /** What `GET .../diff` answers. */
      diff: unknown[];
      /** The session's messages in order; the runtime answers them newest first (`order=desc`). */
      messages: unknown[];
      /** What `POST .../revert/stage` answers. */
      staged: unknown;
    };
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

/**
 * What the fake runtime holds for a continued run: the sessions its list reports (mutated by the
 * creation, fork and removal routes), the messages every session answers (oldest first) and the
 * session-level requests it was asked, in arrival order.
 */
interface FixtureContinuity {
  readonly service: CodingSessionContinuity;
  readonly workspaceId: string;
  /** False leaves every session route to the fixture's own. */
  readonly serveSessions: boolean;
  readonly sessions: string[];
  messages: readonly Record<string, unknown>[];
  readonly requests: { readonly method: string; readonly path: string; readonly body?: string }[];
  /** The id a fork gets; `ses_tool` is the one session the rest of the fixture answers for. */
  readonly forkedSessionId?: string;
  /** The runtime answers the session listing with a server error: it cannot be asked at all. */
  readonly listFails?: boolean;
}

function optionalSessionContinuity(control: StartBridgeControl | undefined): {
  readonly sessionContinuity?: {
    readonly service: CodingSessionContinuity;
    readonly workspaceId: string;
  };
} {
  return control?.continuity === undefined
    ? {}
    : {
        sessionContinuity: {
          service: control.continuity.service,
          workspaceId: control.continuity.workspaceId,
        },
      };
}

interface ContinuityRoute {
  readonly method: string;
  readonly pattern: RegExp;
  /** Whether the request is one of the session-level routes this change adds, which are recorded. */
  readonly recorded: boolean;
  readonly respond: (
    held: FixtureContinuity,
    match: RegExpExecArray,
    body: string | undefined,
    session: (id: string) => Record<string, unknown>,
  ) => Response;
}

const SESSION_ID_PATTERN = "(ses_[A-Za-z0-9_]+)";

/** The routes of a continued run's runtime: list, create, remove, fork and the messages. */
const CONTINUITY_ROUTES: readonly ContinuityRoute[] = [
  {
    method: "GET",
    pattern: /^\/api\/session$/u,
    recorded: false,
    respond: (held, _match, _body, session): Response =>
      held.listFails === true
        ? new Response("{}", { status: 500 })
        : v2Envelope(held.sessions.map(session)),
  },
  {
    method: "POST",
    pattern: /^\/api\/session$/u,
    recorded: true,
    respond: (held, _match, _body, session): Response => {
      const id = `ses_scratch_${String(held.requests.length)}`;
      held.sessions.push(id);
      return v2Envelope(session(id));
    },
  },
  {
    method: "DELETE",
    pattern: new RegExp(`^/api/session/${SESSION_ID_PATTERN}$`, "u"),
    recorded: true,
    respond: (held, match): Response => {
      const index = held.sessions.indexOf(match[1] ?? "");
      if (index >= 0) held.sessions.splice(index, 1);
      return new Response(null, { status: 204 });
    },
  },
  {
    method: "POST",
    pattern: new RegExp(`^/api/session/${SESSION_ID_PATTERN}/fork$`, "u"),
    recorded: true,
    respond: (held, match, body, session): Response => {
      const before = (JSON.parse(body ?? "{}") as { before?: string }).before;
      const id = held.forkedSessionId ?? "ses_tool";
      held.sessions.push(id);
      const boundary =
        before === undefined
          ? { type: "through", messageID: "msg_last" }
          : { type: "before", messageID: before };
      return v2Envelope({ ...session(id), fork: { sessionID: match[1], boundary } });
    },
  },
  {
    method: "GET",
    pattern: new RegExp(`^/api/session/${SESSION_ID_PATTERN}/message$`, "u"),
    recorded: false,
    respond: (held): Response => v2Envelope([...held.messages].reverse()),
  },
];

function continuityRoute(
  method: string,
  path: string,
): { readonly route: ContinuityRoute; readonly match: RegExpExecArray } | undefined {
  for (const route of CONTINUITY_ROUTES) {
    const match = route.method === method ? route.pattern.exec(path) : null;
    if (match !== null) return { route, match };
  }
  return undefined;
}

/** The session routes of a continued run's runtime; `undefined` leaves the route to the fixture. */
function continuityResponse(
  held: FixtureContinuity | undefined,
  path: string,
  init: RequestInit | undefined,
  directory: string,
): Response | undefined {
  if (held?.serveSessions !== true) return undefined;
  const method = init?.method ?? "GET";
  const body = typeof init?.body === "string" ? init.body : undefined;
  const found = continuityRoute(method, path);
  if (found === undefined) return undefined;
  if (found.route.recorded) {
    held.requests.push({ method, path, ...(body === undefined ? {} : { body }) });
  }
  return found.route.respond(held, found.match, body, (id) => ({ id, location: { directory } }));
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

function optionalRepositoryItems(control: StartBridgeControl | undefined): {
  readonly repositoryItems?: CodingRuntimeRepositoryItemsPort;
} {
  return control?.repositoryItems === undefined ? {} : { repositoryItems: control.repositoryItems };
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
  const acceptedInitialization = facade.acceptedInitialization;
  const nativeEffect = facade.nativeEffect;
  const nativeSettlement = facade.nativeSettlement;
  return {
    ...(acceptedInitialization === undefined ? {} : { acceptedInitialization }),
    ...(nativeTextRead === undefined ? {} : { nativeTextRead }),
    ...(nativeEffect === undefined ? {} : { nativeEffect }),
    ...(nativeSettlement === undefined ? {} : { nativeSettlement }),
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

/**
 * The `plugin.list` entries the pinned producer reports for Keiko's generated plugins (shape
 * observed on 2.1.4: id, local source path, server feature, active state), beside a built-in one.
 */
function fixturePlugins(
  launch: RuntimeSupervisorLaunchRequest | undefined,
  status: "active" | "failed" = "active",
): unknown[] {
  const directory = join(launch?.env.OPENCODE_CONFIG_DIR ?? "", "plugins");
  return [
    {
      id: "opencode.tool.read",
      source: { type: "builtin" },
      features: { server: true },
      state: { status: "active" },
    },
    ...OPENCODE_NATIVE_REQUIRED_PLUGINS.map((plugin) => ({
      id: plugin.id,
      source: { type: "local", path: join(directory, plugin.file) },
      features: { server: true },
      state: status === "active" ? { status } : { status, error: "fixture" },
    })),
  ];
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
    const continued = continuityResponse(
      control?.continuity,
      path,
      init,
      capturedLaunch?.cwd ?? "",
    );
    if (continued !== undefined) return Promise.resolve(continued);
    if (path === "/api/session/ses_tool/message" && control?.runControl?.revert !== undefined) {
      return Promise.resolve(v2Envelope([...control.runControl.revert.messages].reverse()));
    }
    if (path === "/api/session/ses_tool/diff") {
      control?.runControl?.revert?.requests.push({ method: init?.method ?? "GET", path });
      return Promise.resolve(v2Envelope(control?.runControl?.revert?.diff ?? []));
    }
    if (path.startsWith("/api/session/ses_tool/revert")) {
      control?.runControl?.revert?.requests.push({
        method: init?.method ?? "GET",
        path,
        ...(typeof init?.body === "string" ? { body: init.body } : {}),
      });
      return Promise.resolve(
        path.endsWith("/stage")
          ? v2Envelope(control?.runControl?.revert?.staged ?? {})
          : new Response(null, { status: 204 }),
      );
    }
    if (path === "/api/session/ses_tool/message") {
      control?.historyCalls?.push({});
      if (control?.historyResponseFactory !== undefined)
        return control.historyResponseFactory(init?.signal ?? undefined);
      return control?.historyResponse ?? Promise.resolve(v2Envelope([]));
    }
    if (
      path.startsWith("/api/session/ses_tool/inbox") &&
      control?.runControl?.inbox !== undefined
    ) {
      return Promise.resolve(
        inboxResponse(control.runControl.inbox, control.runControl.promptBodies, path, init),
      );
    }
    if (path === "/api/command" || path.endsWith("/command")) {
      const commands = control?.runControl?.commands;
      commands?.requests.push({
        method: init?.method ?? "GET",
        path,
        ...(typeof init?.body === "string" ? { body: init.body } : {}),
      });
      return Promise.resolve(
        path === "/api/command"
          ? (commands?.listingResponse?.() ?? v2Envelope(commands?.listing ?? []))
          : (commands?.commandResponse?.() ?? new Response(null, { status: 204 })),
      );
    }
    if (path.endsWith("/prompt")) {
      control?.sessionLocation?.stages?.push("prompt");
      if (typeof init?.body === "string" && init.body.includes("runtime readiness handshake")) {
        readinessChallengePhase = "prompt-pending";
      } else if (typeof init?.body === "string" && control?.runControl !== undefined) {
        return storedTurnPrompt(control.runControl, path, init.body);
      }
      return Promise.resolve(v2Envelope(promptReceipt(path, init?.body)));
    }
    if (path.endsWith("/agent")) {
      control?.runControl?.agentRequests?.push({
        path,
        body: typeof init?.body === "string" ? init.body : "",
        promptsBefore: control.runControl.promptBodies.length,
      });
      return Promise.resolve(
        control?.runControl?.agentResponse?.() ?? new Response(null, { status: 204 }),
      );
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
    if (path === "/api/plugin") {
      return Promise.resolve(
        v2Envelope(control?.pluginEntries?.(capturedLaunch) ?? fixturePlugins(capturedLaunch)),
      );
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
          ...(control?.childSessions ?? []),
        ]),
      );
    return Promise.resolve(new Response("", { status: 404 }));
  }) as unknown as typeof globalThis.fetch;
  const runtime = (await compositionModule()).createOpenCodeRuntimeComposition({
    get toolProfile(): "direct" | "code-mode" | "native" | undefined {
      return control?.readToolProfile?.();
    },
    // #3897: the host environment is offered to every profile; only the native profile's
    // allowlist copies anything from it, so a mapped launch must still carry no PATH.
    processEnv: { PATH: "/host/toolchain/bin", HOME: "/host/home" },
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
    ...optionalRootAccess(control),
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
    ...optionalRepositoryItems(control),
    ...optionalToolResultCorrelation(control),
    ...optionalRuntimeEvents(control),
    ...optionalSpawnGuard(control),
    ...optionalSessionContinuity(control),
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
      // Ordinary tests exercise live filesystem setup; deadline tests pass their own short bound.
      startTimeoutMs: control?.startTimeoutMs ?? 5_000,
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
      "64fed78974757f65a486bb3008929416bb88de78e38f12b5b502b0033cc2b400",
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
    expect(launch?.env.PATH).toBeUndefined();
    expect(launch?.env.HOME).not.toBe("/host/home");
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
    expect(parsedBodies(runControl.promptBodies)).toEqual([
      turnPrompt({
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

  // PR #4064 (P1): a run's session tree is its primary session and the subagent sessions the
  // original runtime opened under it. The run is over only when none of them runs, and a native
  // question of any of them reaches the human.
  describe("the native session tree (PR #4064)", () => {
    const nativeForm = (id: string, sessionID: string): Record<string, unknown> => ({
      id,
      sessionID,
      title: "Choice",
      fields: [
        {
          key: "choice",
          title: "Choice",
          description: `Which one? (${id})`,
          type: "string",
          options: [{ label: "Blue", value: "blue", description: "First" }],
        },
      ],
    });

    async function withChildren(
      control: {
        readonly runControl: NonNullable<
          NonNullable<Parameters<typeof startBridgeFixture>[2]>["runControl"]
        >;
        readonly historyResponseFactory?: () => Promise<Response>;
      },
      body: (
        fixture: Awaited<ReturnType<typeof startBridgeFixture>>,
        activityLog: ReturnType<typeof createBufferedServerLogSink>,
      ) => Promise<void>,
    ): Promise<void> {
      const activityLog = createBufferedServerLogSink();
      const childSessions: Record<string, unknown>[] = [];
      const fixture = await startBridgeFixture(facade, undefined, {
        ...control,
        childSessions,
        activityLog,
      });
      const workspaceRoot = fixture.preparation.env.KEIKO_CODING_WORKSPACE_ROOT ?? "";
      childSessions.push(
        { id: "ses_child", parentID: "ses_tool", location: { directory: workspaceRoot } },
        { id: "ses_elsewhere", parentID: "ses_tool", location: { directory: "/elsewhere" } },
        { id: "ses_foreign", location: { directory: workspaceRoot } },
      );
      try {
        await body(fixture, activityLog);
      } finally {
        await fixture.stop();
      }
    }

    it("lists, answers and rejects the questions of an admitted child, and no foreign session's", async () => {
      const questionRequests: { method: string; path: string; body?: string }[] = [];
      await withChildren(
        {
          runControl: {
            promptBodies: [],
            abortSessions: [],
            statusResponses: [{}],
            questionResponses: [
              [
                nativeForm("frm_primary", "ses_tool"),
                nativeForm("frm_child", "ses_child"),
                nativeForm("frm_elsewhere", "ses_elsewhere"),
                nativeForm("frm_foreign", "ses_foreign"),
              ],
            ],
            questionRequests,
          },
        },
        async ({ runtime }, activityLog) => {
          const port = runtime.runPort;
          const listed = await port.listQuestions(FIXTURE_RUN_ID);
          expect(listed.map(({ id, sessionID }) => [id, sessionID])).toEqual([
            ["que_primary", "ses_tool"],
            ["que_child", "ses_child"],
          ]);
          await expect(port.answerQuestion(FIXTURE_RUN_ID, "que_child", [["Blue"]])).resolves.toBe(
            true,
          );
          await expect(port.rejectQuestion(FIXTURE_RUN_ID, "que_child")).resolves.toBe(true);
          // Another session's form is refused whichever way it is reached.
          for (const id of ["que_elsewhere", "que_foreign"]) {
            await expect(port.answerQuestion(FIXTURE_RUN_ID, id, [["Blue"]])).resolves.toBe(false);
            await expect(port.rejectQuestion(FIXTURE_RUN_ID, id)).resolves.toBe(false);
          }
          expect(questionRequests).toEqual([
            {
              method: "POST",
              path: "/api/session/ses_child/form/frm_child/reply",
              body: '{"answer":{"choice":"blue"}}',
            },
            { method: "DELETE", path: "/api/session/ses_child/form/frm_child" },
          ]);
          const routed = activityLog.events.filter(
            (event) => event.op === "coding-runtime.native-question.routed",
          );
          expect(routed.map((event) => event.extra)).toEqual([
            expect.objectContaining({ action: "list", childFormCount: 1, formCount: 4 }),
            expect.objectContaining({
              action: "answer",
              outcome: "answered",
              sessionRelation: "child",
            }),
            expect.objectContaining({
              action: "reject",
              outcome: "rejected",
              sessionRelation: "child",
            }),
            ...Array.from({ length: 4 }, (): unknown =>
              expect.objectContaining({ outcome: "refused", refusal: "foreign-session" }),
            ),
          ]);
          expect(routed.every((event) => event.correlationId === FIXTURE_RUN_ID)).toBe(true);
          expect(JSON.stringify(routed)).not.toMatch(/ses_|frm_|que_|Which one/u);
        },
      );
    });

    it("keeps the run open while an owned child runs, and settles once it ended", async () => {
      let history: readonly Readonly<Record<string, unknown>>[] = completedTurnHistory().slice(
        0,
        1,
      );
      const statusResponses: unknown[] = [{ ses_child: { type: "busy" } }];
      await withChildren(
        {
          runControl: { promptBodies: [], abortSessions: [], statusResponses },
          historyResponseFactory: () => Promise.resolve(v2Envelope(history.slice().reverse())),
        },
        async ({ runtime }, activityLog) => {
          await expect(runtime.runPort.submitTask(FIXTURE_RUN_ID, "bounded task")).resolves.toBe(
            true,
          );
          // The primary finished its turn; its subagent still runs.
          history = completedTurnHistory();
          let settled = false;
          const terminal = runtime.runPort
            .waitForTerminal(FIXTURE_RUN_ID, AbortSignal.timeout(10_000))
            .finally(() => {
              settled = true;
            });
          await new Promise<void>((resolve) => setTimeout(resolve, 700));
          expect(settled).toBe(false);
          statusResponses[0] = {};
          await expect(terminal).resolves.toBe(true);
          const phases = activityLog.events
            .filter((event) => event.op === "coding-runtime.native-session-tree.observed")
            .map((event) => event.extra?.phase);
          expect(phases).toEqual(["held", "released"]);
        },
      );
    });

    it("is not kept open by an active session that is not the run's", async () => {
      let history: readonly Readonly<Record<string, unknown>>[] = completedTurnHistory().slice(
        0,
        1,
      );
      await withChildren(
        {
          runControl: {
            promptBodies: [],
            abortSessions: [],
            statusResponses: [{ ses_foreign: { type: "busy" } }],
          },
          historyResponseFactory: () => Promise.resolve(v2Envelope(history.slice().reverse())),
        },
        async ({ runtime }) => {
          await expect(runtime.runPort.submitTask(FIXTURE_RUN_ID, "bounded task")).resolves.toBe(
            true,
          );
          history = completedTurnHistory();
          await expect(
            runtime.runPort.waitForTerminal(FIXTURE_RUN_ID, AbortSignal.timeout(5_000)),
          ).resolves.toBe(true);
        },
      );
    });

    it("interrupts the owned children when a turn is stopped, and no other session", async () => {
      const abortSessions: string[] = [];
      const statusResponses: unknown[] = [{}];
      await withChildren(
        { runControl: { promptBodies: [], abortSessions, statusResponses } },
        async ({ runtime }, activityLog) => {
          // The child runs on the first read; it and the primary are quiet on the next two.
          statusResponses.splice(
            0,
            1,
            { ses_child: { type: "busy" }, ses_foreign: { type: "busy" } },
            {},
            {},
          );
          await expect(runtime.runPort.abortTask(FIXTURE_RUN_ID)).resolves.toBe(true);
          expect(abortSessions).toEqual(["ses_tool", "ses_child"]);
          expect(
            activityLog.events
              .filter((event) => event.op === "coding-runtime.native-session-tree.observed")
              .map((event) => event.extra),
          ).toEqual([expect.objectContaining({ phase: "interrupted", activeChildCount: 1 })]);
        },
      );
    });
  });
});

describe("native policy asks on the tool bridge (#3897 review)", () => {
  const completed = {
    status: "completed" as const,
    evidence: [],
    read: { text: "fixture", byteCount: 7, digest: "f".repeat(64) },
  };
  const authorized = { authorization: `Bearer ${TOOL_CAPABILITY}` };
  const nativeAsk = (
    sessionID: string,
    permission = "read",
    source?: { readonly messageID: string; readonly id: string },
  ): string =>
    JSON.stringify({
      action: "native-policy",
      runId: FIXTURE_RUN_ID,
      sessionID,
      permission,
      resources: ["src/index.ts"],
      configured: "allow",
      ...(source === undefined ? {} : { source: { type: "tool", ...source } }),
    });
  type NativeAdmit = NonNullable<CodingToolFacade["nativeEffect"]>["admit"];
  const CHARGED = { ok: true, charge: "charged" } as const;
  const admitWith = (result: ReturnType<NativeAdmit>): Mock<NativeAdmit> =>
    vi.fn<NativeAdmit>(() => result);
  const facadeWith = (
    admit: NativeAdmit | undefined,
    nativeSettlement?: CodingToolFacade["nativeSettlement"],
  ): CodingToolFacade => ({
    execute: vi.fn(() => Promise.resolve(completed)),
    ...(admit === undefined ? {} : { nativeEffect: { admit } }),
    ...(nativeSettlement === undefined ? {} : { nativeSettlement }),
  });

  it("releases an allowed effect only after the facade's live authority owner admits it", async () => {
    const admit = admitWith(CHARGED);
    const fixture = await startBridgeFixture(facadeWith(admit), undefined, {
      mode: "supervised-coding",
    });
    try {
      const response = await fixture.runtime.toolBridge.handle({
        method: "POST",
        headers: new Headers(authorized),
        body: nativeAsk("ses_tool"),
      });
      expect(response).toMatchObject({ status: 200, body: '{"effect":"allow"}' });
      expect(admit).toHaveBeenCalledOnce();
      const admitted = admit.mock.calls[0]?.[0];
      expect(admitted).toMatchObject({
        actionClass: "workspace-read",
        capability: TOOL_CAPABILITY,
      });
      // A check that names no tool invocation (no `source`) carries no invocation identity.
      expect(admitted?.invocation).toBeUndefined();
    } finally {
      await fixture.stop();
    }
  });

  it("hands the measured size of an edit's diff to the authority owner with its invocation", async () => {
    const admit = admitWith(CHARGED);
    const fixture = await startBridgeFixture(facadeWith(admit), undefined, {
      mode: "autonomous-delivery",
    });
    try {
      const ask = JSON.parse(
        nativeAsk("ses_tool", "edit", { messageID: "msg_1", id: "call_1" }),
      ) as Readonly<Record<string, unknown>>;
      const response = await fixture.runtime.toolBridge.handle({
        method: "POST",
        headers: new Headers(authorized),
        body: JSON.stringify({ ...ask, patchBytes: 4_097 }),
      });
      expect(response).toMatchObject({ status: 200, body: '{"effect":"allow"}' });
      expect(admit.mock.calls[0]?.[0]).toMatchObject({
        actionClass: "workspace-write",
        patchBytes: 4_097,
        invocation: { sessionId: "ses_tool", messageId: "msg_1", callId: "call_1" },
      });
      const malformed = await fixture.runtime.toolBridge.handle({
        method: "POST",
        headers: new Headers(authorized),
        body: JSON.stringify({ ...ask, patchBytes: -1 }),
      });
      // An unmeasurable diff is no policy ask: it is never allowed and never reaches the owner.
      expect(malformed.body).not.toContain('"effect":"allow"');
      expect(admit).toHaveBeenCalledOnce();
    } finally {
      await fixture.stop();
    }
  });

  it("refuses the effect when the authority owner refuses it or is absent from the wiring", async () => {
    const admit = admitWith({ ok: false, reason: "authority-budget-exceeded" });
    const refused = await startBridgeFixture(facadeWith(admit), undefined, {
      mode: "supervised-coding",
    });
    try {
      const response = await refused.runtime.toolBridge.handle({
        method: "POST",
        headers: new Headers(authorized),
        body: nativeAsk("ses_tool"),
      });
      expect(response.status).toBe(200);
      expect(JSON.parse(response.body)).toMatchObject({ effect: "deny" });
      expect(JSON.stringify(response)).not.toContain("src/index.ts");
    } finally {
      await refused.stop();
    }
    const unwired = await startBridgeFixture(facadeWith(undefined), undefined, {
      mode: "autonomous-delivery",
    });
    try {
      const response = await unwired.runtime.toolBridge.handle({
        method: "POST",
        headers: new Headers(authorized),
        body: nativeAsk("ses_tool"),
      });
      expect(JSON.parse(response.body)).toMatchObject({ effect: "deny" });
    } finally {
      await unwired.stop();
    }
  });

  it("cancels an already-aborted ask without consulting authority", async () => {
    const admit = admitWith(CHARGED);
    const fixture = await startBridgeFixture(facadeWith(admit), undefined, {
      mode: "autonomous-delivery",
    });
    try {
      const response = await fixture.runtime.toolBridge.handle({
        method: "POST",
        headers: new Headers(authorized),
        body: nativeAsk("ses_tool"),
        signal: AbortSignal.abort(),
      });
      expect(JSON.parse(response.body)).toMatchObject({ effect: "deny" });
      expect(admit).not.toHaveBeenCalled();
    } finally {
      await fixture.stop();
    }
  });

  it("binds a native child session to its parent run and refuses a foreign session", async () => {
    const admit = admitWith(CHARGED);
    const childSessions: Record<string, unknown>[] = [];
    const fixture = await startBridgeFixture(facadeWith(admit), undefined, {
      mode: "autonomous-delivery",
      childSessions,
    });
    const workspaceRoot = fixture.preparation.env.KEIKO_CODING_WORKSPACE_ROOT ?? "";
    expect(workspaceRoot).not.toBe("");
    childSessions.push(
      { id: "ses_child", parentID: "ses_tool", location: { directory: workspaceRoot } },
      { id: "ses_grandchild", parentID: "ses_child", location: { directory: workspaceRoot } },
      { id: "ses_elsewhere", parentID: "ses_tool", location: { directory: "/elsewhere" } },
      { id: "ses_foreign", location: { directory: workspaceRoot } },
    );
    try {
      for (const [sessionID, status] of [
        ["ses_grandchild", 200],
        ["ses_child", 200],
        ["ses_elsewhere", 403],
        ["ses_foreign", 403],
        ["ses_unknown", 403],
      ] as const) {
        const response = await fixture.runtime.toolBridge.handle({
          method: "POST",
          headers: new Headers(authorized),
          body: nativeAsk(sessionID),
        });
        expect(response.status, sessionID).toBe(status);
      }
      expect(admit).toHaveBeenCalledTimes(2);
    } finally {
      await fixture.stop();
    }
  });

  it("refuses a child session whose ancestry cannot be read and records a correlated diagnostic", async () => {
    const diagnostics = persistedDiagnostics();
    const admit = admitWith(CHARGED);
    let failList = false;
    const childSessions = new Proxy<Record<string, unknown>[]>([], {
      get(target, property, receiver): unknown {
        if (failList && property === Symbol.iterator) throw new TypeError("PRIVATE_list_failure");
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
    const fixture = await startBridgeFixture(facadeWith(admit), undefined, {
      mode: "autonomous-delivery",
      childSessions,
      diagnostics: diagnostics.sink,
    });
    try {
      failList = true;
      const response = await fixture.runtime.toolBridge.handle({
        method: "POST",
        headers: new Headers(authorized),
        body: nativeAsk("ses_child"),
      });
      expect(response.status).toBe(403);
      expect(admit).not.toHaveBeenCalled();
      const record = expectPersistedDiagnostic(
        diagnostics.read(),
        "opencode-runtime-composition.native-session-ancestry",
      );
      expect(record).toMatchObject({ diagnosticSummary: "native-session-ancestry-failed" });
      expect(JSON.stringify(record)).not.toContain("PRIVATE_list_failure");
    } finally {
      await fixture.stop();
    }
  });

  it("decides with the narrower mode after a narrowing resume (#3897 audit)", async () => {
    const admit = admitWith(CHARGED);
    const fixture = await startBridgeFixture(facadeWith(admit), undefined, {
      mode: "autonomous-delivery",
    });
    const fetchAsk = (): string =>
      JSON.stringify({
        action: "native-policy",
        runId: FIXTURE_RUN_ID,
        sessionID: "ses_tool",
        permission: "webfetch",
        resources: ["https://example.invalid/doc"],
        configured: "ask",
      });
    try {
      const before = await fixture.runtime.toolBridge.handle({
        method: "POST",
        headers: new Headers(authorized),
        body: fetchAsk(),
      });
      expect(JSON.parse(before.body)).toMatchObject({ effect: "allow" });
      expect(fixture.runtime.manager.pause(FIXTURE_RUN_ID)).toMatchObject({ ok: true });
      expect(fixture.runtime.manager.resume(FIXTURE_RUN_ID, "supervised-coding")).toMatchObject({
        ok: true,
        effectiveMode: "supervised-coding",
      });
      const after = await fixture.runtime.toolBridge.handle({
        method: "POST",
        headers: new Headers(authorized),
        body: fetchAsk(),
      });
      expect(JSON.parse(after.body)).toMatchObject({ effect: "deny" });
    } finally {
      await fixture.stop();
    }
  });

  // #3897 review (P1): a native tree launched in Full access keeps the inherited egress the kernel
  // bound at launch, so narrowing it below Full access in place would acknowledge authority the
  // tree still holds. The resume is refused and recorded; narrowing below Full stays in place.
  it("refuses to narrow a native Full access tree in place and records why", async () => {
    const activityLog = createBufferedServerLogSink();
    const fixture = await startBridgeFixture(facadeWith(admitWith(CHARGED)), undefined, {
      mode: "autonomous-delivery",
      readToolProfile: () => "native",
      activityLog,
    });
    try {
      expect(fixture.runtime.manager.pause(FIXTURE_RUN_ID)).toMatchObject({ ok: true });
      for (const narrower of ["supervised-coding", "governed-assist"] as const)
        expect(fixture.runtime.manager.resume(FIXTURE_RUN_ID, narrower)).toEqual({
          ok: false,
          failureCode: "authority-resolution-failed",
          retryable: false,
        });
      const refused = activityLog.events.filter(
        (event) => event.op === "coding-runtime.native-narrowing.refused",
      );
      expect(refused.map((event) => event.extra)).toEqual([
        expect.objectContaining({
          runId: FIXTURE_RUN_ID,
          launchMode: "autonomous-delivery",
          requestedMode: "supervised-coding",
        }),
        expect.objectContaining({
          runId: FIXTURE_RUN_ID,
          launchMode: "autonomous-delivery",
          requestedMode: "governed-assist",
        }),
      ]);
      expect(refused[0]).toMatchObject({ level: "warn", correlationId: FIXTURE_RUN_ID });
      expectActivityLogProof(
        "coding-runtime.native-narrowing.refused.emitted-line",
        formatActivityLogProofLine(refused[0] ?? {}),
      );
      // Resuming in the launch mode is not a narrowing and resumes the paused run.
      expect(fixture.runtime.manager.resume(FIXTURE_RUN_ID, "autonomous-delivery")).toMatchObject({
        ok: true,
      });
    } finally {
      await fixture.stop();
    }
  });

  it("control: a native tree launched below Full access narrows in place", async () => {
    const activityLog = createBufferedServerLogSink();
    const fixture = await startBridgeFixture(facadeWith(admitWith(CHARGED)), undefined, {
      mode: "supervised-coding",
      readToolProfile: () => "native",
      activityLog,
    });
    try {
      expect(fixture.runtime.manager.pause(FIXTURE_RUN_ID)).toMatchObject({ ok: true });
      expect(fixture.runtime.manager.resume(FIXTURE_RUN_ID, "governed-assist")).toMatchObject({
        ok: true,
        effectiveMode: "governed-assist",
      });
      expect(
        activityLog.events.some((event) => event.op === "coding-runtime.native-narrowing.refused"),
      ).toBe(false);
    } finally {
      await fixture.stop();
    }
  });

  // #3903: the native profile admits the workspace's Markdown agents, commands and skills into the
  // run's private discovery directory, after Keiko's own generated document is there and before the
  // first launch; the mapped profiles never reach the admission.
  describe("repository items admission", () => {
    interface AdmissionCall {
      readonly runId: string;
      readonly discoveryRoot: string;
      readonly generatedConfigPresent: boolean;
    }

    function recordingPort(order: string[]): {
      readonly port: CodingRuntimeRepositoryItemsPort;
      readonly calls: AdmissionCall[];
    } {
      const calls: AdmissionCall[] = [];
      return {
        calls,
        port: {
          admitForRun: (request): Promise<void> => {
            order.push("admit");
            calls.push({
              runId: request.runId,
              discoveryRoot: request.discoveryRoot,
              generatedConfigPresent: existsSync(join(request.discoveryRoot, "opencode.json")),
            });
            return Promise.resolve();
          },
        },
      };
    }

    it("admits once per native launch, into the discovery directory, before the child is spawned", async () => {
      const order: string[] = [];
      const { port, calls } = recordingPort(order);
      const fixture = await startBridgeFixture(facadeWith(admitWith(CHARGED)), undefined, {
        mode: "supervised-coding",
        readToolProfile: () => "native",
        repositoryItems: port,
        onSpawn: () => order.push("spawn"),
      });
      try {
        expect(calls).toHaveLength(1);
        const [call] = calls;
        expect(call?.runId).toBe(FIXTURE_RUN_ID);
        expect(call?.discoveryRoot.endsWith(join(FIXTURE_RUN_ID, "config", "opencode"))).toBe(true);
        expect(call?.generatedConfigPresent).toBe(true);
        expect(order).toEqual(["admit", "spawn"]);
      } finally {
        await fixture.stop();
      }
    });

    it.each(["direct", "code-mode"] as const)(
      "never reaches the admission on the mapped %s profile",
      async (profile) => {
        const { port, calls } = recordingPort([]);
        const fixture = await startBridgeFixture(facadeWith(admitWith(CHARGED)), undefined, {
          readToolProfile: () => profile,
          repositoryItems: port,
        });
        try {
          expect(calls).toHaveLength(0);
        } finally {
          await fixture.stop();
        }
      },
    );
  });

  // #3897 (parity row C07): the producer runs a built-in formatter after its own edits without any
  // permission, so the launch mode decides whether it may, and the choice is recorded body-free.
  it.each([
    ["autonomous-delivery", true, "enabled"],
    ["supervised-coding", false, "disabled-supervised-mode"],
    ["governed-assist", false, "disabled-ask-mode"],
  ] as const)(
    "binds the native built-in formatter to the %s launch mode and records the decision",
    async (mode, formatter, disposition) => {
      const activityLog = createBufferedServerLogSink();
      const fixture = await startBridgeFixture(facadeWith(admitWith(CHARGED)), undefined, {
        mode,
        readToolProfile: () => "native",
        activityLog,
      });
      try {
        const binding = JSON.parse(fixture.preparation.env.OPENCODE_CONFIG_CONTENT ?? "null") as {
          readonly formatter?: unknown;
        };
        expect(binding.formatter).toBe(formatter);
        const bound = activityLog.events.filter(
          (event) => event.op === "coding-runtime.native-formatter.bound",
        );
        expect(bound).toHaveLength(1);
        expect(bound[0]).toMatchObject({ correlationId: FIXTURE_RUN_ID });
        expect(bound[0]?.extra).toMatchObject({
          runId: FIXTURE_RUN_ID,
          disposition,
          launchMode: mode,
        });
        expectActivityLogProof(
          "coding-runtime.native-formatter.bound.emitted-line",
          formatActivityLogProofLine(bound[0] ?? {}),
        );
      } finally {
        await fixture.stop();
      }
    },
  );

  // Parity row S11: every profile binds the producer's provider policy and keeps the hosted free
  // models off, so the runtime knows no model route but the Model Gateway. The line is read from
  // the configuration and environment the run was actually given.
  it.each(["native", "direct"] as const)(
    "records that a %s launch admits only the gateway-bound provider",
    async (toolProfile) => {
      const activityLog = createBufferedServerLogSink();
      const fixture = await startBridgeFixture(facadeWith(admitWith(CHARGED)), undefined, {
        mode: "governed-assist",
        readToolProfile: () => toolProfile,
        activityLog,
      });
      try {
        expect(fixture.preparation.env.OPENCODE_DISABLE_FREE_MODELS).toBe("1");
        const bound = activityLog.events.filter(
          (event) => event.op === "coding-runtime.provider-policy.bound",
        );
        expect(bound).toHaveLength(1);
        expect(bound[0]).toMatchObject({ correlationId: FIXTURE_RUN_ID });
        expect(bound[0]?.extra).toMatchObject({
          runId: FIXTURE_RUN_ID,
          providerPolicy: "gateway-only",
          freeModels: "disabled",
          modelsFetch: "disabled",
          toolProfile,
        });
        expectActivityLogProof(
          "coding-runtime.provider-policy.bound.emitted-line",
          formatActivityLogProofLine(bound[0] ?? {}),
        );
      } finally {
        await fixture.stop();
      }
    },
  );

  it("control: a mapped launch carries no formatter setting and records no decision", async () => {
    const activityLog = createBufferedServerLogSink();
    const fixture = await startBridgeFixture(facadeWith(admitWith(CHARGED)), undefined, {
      mode: "autonomous-delivery",
      readToolProfile: () => "direct",
      activityLog,
    });
    try {
      expect(fixture.preparation.env).not.toHaveProperty("OPENCODE_CONFIG_CONTENT");
      expect(
        activityLog.events.some((event) => event.op === "coding-runtime.native-formatter.bound"),
      ).toBe(false);
    } finally {
      await fixture.stop();
    }
  });

  // The formatter's setting is part of the launch configuration and cannot follow a narrowing.
  // The only launch mode that enables it is one whose resume cannot narrow in place, so a tree that
  // may format can never be acknowledged as Ask for approval while it still would.
  it("refuses to narrow a formatter-enabled tree in place to a mode that forbids the formatter", async () => {
    const fixture = await startBridgeFixture(facadeWith(admitWith(CHARGED)), undefined, {
      mode: "autonomous-delivery",
      readToolProfile: () => "native",
      activityLog: createBufferedServerLogSink(),
    });
    try {
      const binding = JSON.parse(fixture.preparation.env.OPENCODE_CONFIG_CONTENT ?? "null") as {
        readonly formatter?: unknown;
      };
      expect(binding.formatter).toBe(true);
      expect(fixture.runtime.manager.pause(FIXTURE_RUN_ID)).toMatchObject({ ok: true });
      expect(fixture.runtime.manager.resume(FIXTURE_RUN_ID, "governed-assist")).toEqual({
        ok: false,
        failureCode: "authority-resolution-failed",
        retryable: false,
      });
    } finally {
      await fixture.stop();
    }
  });

  const SOURCE = { messageID: "msg_assistant_1", id: "call_read_1" } as const;
  const handleAsk = (
    fixture: Awaited<ReturnType<typeof startBridgeFixture>>,
    body: string,
  ): Promise<{ readonly status: number; readonly body: string }> =>
    fixture.runtime.toolBridge.handle({ method: "POST", headers: new Headers(authorized), body });

  it("hands the authority owner the original invocation identity of a tool-sourced check (#3897 review)", async () => {
    const admit = admitWith(CHARGED);
    const childSessions: Record<string, unknown>[] = [];
    const fixture = await startBridgeFixture(facadeWith(admit), undefined, {
      mode: "autonomous-delivery",
      childSessions,
    });
    const workspaceRoot = fixture.preparation.env.KEIKO_CODING_WORKSPACE_ROOT ?? "";
    childSessions.push({
      id: "ses_child",
      parentID: "ses_tool",
      location: { directory: workspaceRoot },
    });
    try {
      // Two checks of one tool call (an edit and the directory it touches) name one invocation.
      await handleAsk(fixture, nativeAsk("ses_tool", "read", SOURCE));
      await handleAsk(fixture, nativeAsk("ses_tool", "edit", SOURCE));
      // The same message and call ids in a child session are the child's own invocation.
      await handleAsk(fixture, nativeAsk("ses_child", "read", SOURCE));
      expect(admit.mock.calls.map(([input]) => input.invocation)).toEqual([
        { sessionId: "ses_tool", messageId: "msg_assistant_1", callId: "call_read_1" },
        { sessionId: "ses_tool", messageId: "msg_assistant_1", callId: "call_read_1" },
        { sessionId: "ses_child", messageId: "msg_assistant_1", callId: "call_read_1" },
      ]);
    } finally {
      await fixture.stop();
    }
  });

  it("records how a check was charged and why the authority refused one, without a path (#3897 review)", async () => {
    const activityLog = createBufferedServerLogSink();
    const answers = [
      { ok: true, charge: "charged" },
      { ok: true, charge: "already-charged" },
      { ok: false, reason: "authority-budget-exceeded" },
      { ok: false, reason: "workspace-drift" },
    ] as const;
    let asked = 0;
    const admit = vi.fn<NativeAdmit>(() => {
      const answer = answers[asked] ?? CHARGED;
      asked += 1;
      return answer;
    });
    const fixture = await startBridgeFixture(facadeWith(admit), undefined, {
      mode: "supervised-coding",
      activityLog,
    });
    try {
      for (const callId of ["call_1", "call_1", "call_2", "call_3"])
        await handleAsk(fixture, nativeAsk("ses_tool", "read", { messageID: "msg_1", id: callId }));
      const decided = activityLog.events
        .filter((event) => event.op === "coding-runtime.native-policy.decided")
        .map((event) => event.extra);
      expect(decided).toMatchObject([
        { outcome: "allowed", invocationCharge: "charged" },
        { outcome: "allowed", invocationCharge: "already-charged" },
        { outcome: "authority-refused", authorityReason: "authority-budget-exceeded" },
        { outcome: "authority-refused", authorityReason: "drift" },
      ]);
      expect(decided[2]).not.toHaveProperty("invocationCharge");
      expect(decided[0]).not.toHaveProperty("authorityReason");
      expect(JSON.stringify(decided)).not.toContain("src/index.ts");
    } finally {
      await fixture.stop();
    }
  });

  it("tells the run evidence owner which call a refusal ended, and no call that was admitted", async () => {
    const refused = vi.fn();
    const nativeSettlement = { refused, settled: vi.fn() } as unknown as NonNullable<
      CodingToolFacade["nativeSettlement"]
    >;
    const admit = vi.fn<NativeAdmit>((input) =>
      input.invocation?.callId === "call_exhausted"
        ? { ok: false, reason: "authority-budget-exceeded" }
        : CHARGED,
    );
    const fixture = await startBridgeFixture(facadeWith(admit, nativeSettlement), undefined, {
      mode: "supervised-coding",
    });
    const source = (id: string): { readonly messageID: string; readonly id: string } => ({
      messageID: "msg_1",
      id,
    });
    try {
      await handleAsk(fixture, nativeAsk("ses_tool", "read", source("call_ok")));
      expect(refused).not.toHaveBeenCalled();
      // Refused by policy (internet below Full access), by the authority owner, and a check with no
      // tool source (nothing to tell: no call can be named).
      await handleAsk(fixture, nativeAsk("ses_tool", "webfetch", source("call_policy")));
      await handleAsk(fixture, nativeAsk("ses_tool", "read", source("call_exhausted")));
      await handleAsk(fixture, nativeAsk("ses_tool", "webfetch"));
      expect(refused.mock.calls).toEqual([
        [{ messageId: "msg_1", callId: "call_policy" }],
        [{ messageId: "msg_1", callId: "call_exhausted" }],
      ]);
    } finally {
      await fixture.stop();
    }
  });

  // #3901: an admitted project check is remembered by its call, so its exit status can become the
  // run's verification evidence; any other shell line is no check.
  it("tells the run evidence owner which admitted shell call is a project check (#3901)", async () => {
    const verificationAdmitted = vi.fn();
    const nativeSettlement = {
      refused: vi.fn(),
      settled: vi.fn(),
      verificationAdmitted,
      verificationDenied: vi.fn(),
    } as unknown as NonNullable<CodingToolFacade["nativeSettlement"]>;
    const fixture = await startBridgeFixture(
      facadeWith(admitWith(CHARGED), nativeSettlement),
      undefined,
      {
        mode: "autonomous-delivery",
      },
    );
    const shellAsk = (id: string, resources: readonly string[]): string =>
      JSON.stringify({
        action: "native-policy",
        runId: FIXTURE_RUN_ID,
        sessionID: "ses_tool",
        permission: "shell",
        resources,
        configured: "allow",
        source: { type: "tool", messageID: "msg_1", id },
      });
    try {
      await handleAsk(fixture, shellAsk("call_test", ["cd packages/app", "npm test"]));
      await handleAsk(fixture, shellAsk("call_typecheck", ["npm run typecheck"]));
      await handleAsk(fixture, shellAsk("call_listing", ["ls -la"]));
      await handleAsk(fixture, shellAsk("call_masked", ["npm test", "true"]));
      expect(verificationAdmitted.mock.calls).toEqual([
        [{ messageId: "msg_1", callId: "call_test" }, "test"],
        [{ messageId: "msg_1", callId: "call_typecheck" }, "typecheck"],
      ]);
    } finally {
      await fixture.stop();
    }
  });

  it("proves ancestry only through a bounded parent chain inside the workspace", async () => {
    const { nativeSessionDescendsFromRun } = await compositionModule();
    const ws = "/ws";
    const at = (id: string, parentID?: string, directory = ws): Record<string, unknown> => ({
      id,
      ...(parentID === undefined ? {} : { parentID }),
      location: { directory },
    });
    expect(nativeSessionDescendsFromRun([at("c", "p")], "c", "p", ws)).toBe(true);
    expect(nativeSessionDescendsFromRun([at("c", "p"), at("g", "c")], "g", "p", ws)).toBe(true);
    expect(nativeSessionDescendsFromRun([at("c", "p", "/other")], "c", "p", ws)).toBe(false);
    expect(nativeSessionDescendsFromRun([at("c")], "c", "p", ws)).toBe(false);
    expect(nativeSessionDescendsFromRun([at("c", "c")], "c", "p", ws)).toBe(false);
    expect(nativeSessionDescendsFromRun([at("a", "b"), at("b", "a")], "a", "p", ws)).toBe(false);
    const deep = Array.from({ length: 10 }, (_, i) =>
      at(`s${String(i)}`, i === 0 ? "p" : `s${String(i - 1)}`),
    );
    expect(nativeSessionDescendsFromRun(deep, "s9", "p", ws)).toBe(false);
    expect(nativeSessionDescendsFromRun(deep, "s6", "p", ws)).toBe(true);
  });
});

describe("native tool evidence from the runtime's own history (#3873, #3897 review)", () => {
  const completed = {
    status: "completed" as const,
    evidence: [],
    read: { text: "fixture", byteCount: 7, digest: "f".repeat(64) },
  };
  const authorized = { authorization: `Bearer ${TOOL_CAPABILITY}` };
  const TOOL_ERROR = { type: "ToolError", message: "PRIVATE_TOOL_ERROR" };
  const part = (
    callId: string,
    name: string,
    status: "running" | "completed" | "error",
  ): Record<string, unknown> => ({
    type: "tool",
    id: callId,
    name,
    executed: true,
    native: {},
    time: { created: 5, ran: 6, ...(status === "running" ? {} : { completed: 7 }) },
    state: {
      status,
      input: { filePath: "PRIVATE_PATH" },
      ...(status === "completed" ? { content: [{ type: "text", text: "PRIVATE_OUTPUT" }] } : {}),
      ...(status === "error" ? { error: TOOL_ERROR } : {}),
    },
  });
  // The history endpoint lists newest first.
  const history = (
    content: readonly Record<string, unknown>[],
  ): readonly Readonly<Record<string, unknown>>[] =>
    [
      { id: "msg_user", type: "user", time: { created: 1 }, text: "Task" },
      { id: "msg_assistant", type: "assistant", time: { created: 2 }, content },
    ].reverse();
  const frame = (type: string, number: number): Uint8Array =>
    new TextEncoder().encode(
      `data: ${JSON.stringify({
        id: `evt_native_${String(number)}`,
        type,
        data: { sessionID: "ses_tool", assistantMessageID: "msg_assistant", ordinal: 0 },
      })}\n\n`,
    );
  const policyAsk = (permission: string, callId: string): string =>
    JSON.stringify({
      action: "native-policy",
      runId: FIXTURE_RUN_ID,
      sessionID: "ses_tool",
      permission,
      resources: ["https://example.invalid/doc"],
      source: { type: "tool", messageID: "msg_assistant", id: callId },
      configured: "ask",
    });

  async function runHistory(
    profile: "native" | "direct",
  ): Promise<{ readonly settled: [string | undefined, string][] }> {
    const settled: [string | undefined, string][] = [];
    const nativeSettlement = createCodingToolNativeSettlementFacet((action, status) => {
      settled.push([action, status]);
    });
    const historyCalls: Readonly<Record<string, number>>[] = [];
    const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
    // A mapped profile's history only admits Keiko's own tool names.
    const tool = (native: string): string =>
      profile === "native" ? native : "keiko_workspace_read";
    let content: readonly Record<string, unknown>[] = [
      part("call_read_1", tool("read"), "completed"),
      part("call_edit_1", tool("edit"), "completed"),
    ];
    const fixture = await startBridgeFixture(
      {
        execute: vi.fn(() => Promise.resolve(completed)),
        nativeEffect: { admit: () => ({ ok: true, charge: "charged" }) },
        nativeSettlement,
      },
      undefined,
      {
        mode: "supervised-coding",
        readToolProfile: () => profile,
        historyCalls,
        onSseStart: (controller): void => {
          streams.push(controller);
        },
        historyResponseFactory: () => Promise.resolve(v2Envelope(history(content))),
      },
    );
    try {
      const stream = streams[0];
      if (stream === undefined) throw new Error("expected the event stream");
      let hints = 0;
      const reread = async (): Promise<void> => {
        const reads = historyCalls.length;
        hints += 1;
        stream.enqueue(frame("session.step.ended", hints));
        await vi.waitFor(() => {
          expect(historyCalls.length).toBeGreaterThan(reads);
        });
        await new Promise<void>((resolve) => setImmediate(resolve));
      };
      await reread();
      // The policy refused the fetch (internet is a Full access capability): the runtime ends it as a
      // failed call, the later calls run, and one is still running when the history is read.
      await fixture.runtime.toolBridge.handle({
        method: "POST",
        headers: new Headers(authorized),
        body: policyAsk("webfetch", "call_fetch_1"),
      });
      content = [
        ...content,
        part("call_fetch_1", tool("webfetch"), "error"),
        part("call_read_2", tool("read"), "completed"),
        part("call_shell_1", tool("shell"), "running"),
      ];
      await reread();
      // A reconnect or a repeated history read reports the same calls again.
      await reread();
      await reread();
      return { settled };
    } finally {
      await fixture.stop();
    }
  }

  it("records what a native edit wrote, so an undo never overwrites a human edit made after it", async () => {
    const settled: string[] = [];
    const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
    const revert = {
      requests: [] as { method: string; path: string; body?: string }[],
      diff: [
        { file: "a.txt", patch: "", additions: 1, deletions: 1, status: "modified" },
      ] as unknown[],
      messages: [] as unknown[],
      staged: {
        messageID: "msg_user",
        files: [{ file: "a.txt", patch: "", additions: 1, deletions: 1, status: "modified" }],
      } as unknown,
    };
    const fixture = await startBridgeFixture(
      {
        execute: vi.fn(() => Promise.resolve(completed)),
        nativeEffect: { admit: () => ({ ok: true, charge: "charged" }) },
        nativeSettlement: createCodingToolNativeSettlementFacet((action) => {
          settled.push(String(action));
        }),
      },
      undefined,
      {
        mode: "autonomous-delivery",
        readToolProfile: () => "native",
        onSseStart: (controller): void => {
          streams.push(controller);
        },
        runControl: { promptBodies: [], abortSessions: [], statusResponses: [{}], revert },
      },
    );
    try {
      const workspaceRoot = fixture.preparation.env.KEIKO_CODING_WORKSPACE_ROOT ?? "";
      const file = join(workspaceRoot, "a.txt");
      writeFileSync(file, "as the native edit wrote it\n");
      const ask = await fixture.runtime.toolBridge.handle({
        method: "POST",
        headers: new Headers(authorized),
        body: JSON.stringify({
          action: "native-policy",
          runId: FIXTURE_RUN_ID,
          sessionID: "ses_tool",
          permission: "edit",
          resources: ["a.txt"],
          source: { type: "tool", messageID: "msg_assistant", id: "call_edit_1" },
          configured: "allow",
        }),
      });
      expect(ask.body).toBe('{"effect":"allow"}');
      revert.messages = [...history([part("call_edit_1", "edit", "completed")])].reverse();
      streams[0]?.enqueue(frame("session.step.ended", 1));
      await vi.waitFor(() => {
        expect(settled).toEqual(["edit"]);
      });
      const port = fixture.runtime.runPort;
      // Healthy control first: with the file as the native edit wrote it, the undo stages, and the
      // undo waits for the edit's image, so the human edit below lands after it was taken.
      await expect(port.revertTurn?.(FIXTURE_RUN_ID, "undo")).resolves.toMatchObject({ ok: true });
      await expect(port.revertTurn?.(FIXTURE_RUN_ID, "restore")).resolves.toMatchObject({
        ok: true,
      });
      revert.requests.length = 0;
      writeFileSync(file, "a human edit after it\n");
      await expect(port.revertTurn?.(FIXTURE_RUN_ID, "undo")).resolves.toEqual({
        ok: false,
        reason: "workspace-changed",
      });
      expect(revert.requests.map(({ path }) => path)).not.toContain(
        "/api/session/ses_tool/revert/stage",
      );
    } finally {
      await fixture.stop();
    }
  });

  it("counts each completed native call once, a policy refusal as a refusal, and a running call not at all", async () => {
    const { settled } = await runHistory("native");
    expect(settled).toEqual([
      ["read", "completed"],
      ["edit", "completed"],
      ["egress", "denied"],
      ["read", "completed"],
    ]);
  });

  it("control: a mapped profile's calls reach the run's effort through the facade, never through its history", async () => {
    const { settled } = await runHistory("direct");
    expect(settled).toEqual([]);
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
    let enteredHistory: (() => void) | undefined;
    const historyStarted = new Promise<void>((resolve) => {
      enteredHistory = resolve;
    });
    let sseCancellations = 0;
    const clearSafeActivity = vi.fn();
    const facade: CodingToolFacade = { execute: vi.fn(() => Promise.resolve(completed)) };
    const fixture = await withDeterministicReadinessTimers(
      () =>
        startBridgeFixture(
          facade,
          { requestDeadlineMs: 1_000, maxInFlight: 1 },
          {
            startTimeoutMs: 20,
            historyResponseFactory: () => {
              enteredHistory?.();
              return historyResponse;
            },
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
        ),
      historyStarted,
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

  // #3897 review (P1): the native profile keeps every built-in agent's own permission rules, so the
  // policy hook is what governs the run. A native run whose governing plugin the producer reports
  // failed never becomes ready, before any session or prompt; a mapped run never depends on it.
  it("refuses a native start whose governing plugin the producer reports failed", async () => {
    let pluginLists = 0;
    const sessionCreateCalls: string[] = [];
    const fixture = await startBridgeFixture(
      { execute: vi.fn(() => Promise.resolve(completed)) },
      undefined,
      {
        readToolProfile: () => "native",
        sessionCreateCalls,
        pluginEntries: (launch): unknown[] => {
          pluginLists += 1;
          return fixturePlugins(launch, "failed");
        },
        startTimeoutMs: 60_000,
        expectedStart: { ok: false, failureCode: "runtime-profile-open", retryable: false },
      },
    );
    try {
      expect(pluginLists).toBe(1);
      expect(sessionCreateCalls).toEqual([]);
    } finally {
      await fixture.stop();
    }
  });

  it("control: a native start with its governing plugins active readies; a mapped one never asks", async () => {
    for (const profile of ["native", "direct"] as const) {
      let pluginLists = 0;
      const fixture = await startBridgeFixture(
        { execute: vi.fn(() => Promise.resolve(completed)) },
        undefined,
        {
          readToolProfile: () => profile,
          pluginEntries: (launch): unknown[] => {
            pluginLists += 1;
            return fixturePlugins(launch);
          },
        },
      );
      try {
        expect(pluginLists).toBe(profile === "native" ? 1 : 0);
      } finally {
        await fixture.stop();
      }
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
  it("allows ordinary fixture startup across a short scheduling delay", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const fixture = await startBridgeFixture(
      { execute: () => Promise.resolve({ status: "observed", evidence: [] }) },
      undefined,
      {
        canSpawnRuntime: (): boolean => {
          vi.setSystemTime(Date.now() + 150);
          return true;
        },
      },
    );
    try {
      expect(fixture.runtime.manager.health()).toMatchObject({
        status: "ready",
        activeRunId: FIXTURE_RUN_ID,
      });
    } finally {
      await fixture.stop();
    }
  });

  it("clears prepared state when the deadline expires before native spawn", async () => {
    vi.useFakeTimers();
    try {
      const spawned = vi.fn();
      const clear = vi.fn();
      const released = vi.fn();
      const guard = vi.fn<NonNullable<StartBridgeControl["canSpawnRuntime"]>>(() => {
        vi.setSystemTime(Date.now() + 20);
        return true;
      });
      const fixture = await startBridgeFixture(
        { execute: () => Promise.resolve({ status: "observed", evidence: [] }) },
        undefined,
        {
          startTimeoutMs: 20,
          canSpawnRuntime: guard,
          onSpawn: spawned,
          onRelease: released,
          expectedStart: { ok: false, failureCode: "start-timeout", retryable: true },
          safeActivity: {
            arm: vi.fn(),
            clear,
            ingest: () => true,
            recordDrops: vi.fn(),
            settleTool: vi.fn(),
          },
          afterStart: async (runtime, runRoot) => {
            expect(guard).toHaveBeenCalledOnce();
            expect(spawned).not.toHaveBeenCalled();
            expect(released).not.toHaveBeenCalled();
            expect(runtime.manager.health()).toEqual({ status: "stopped" });
            expect(existsSync(runRoot)).toBe(false);
            expect(clear).toHaveBeenCalledOnce();
            await expect(
              runtime.toolBridge.handle({
                method: "POST",
                headers: new Headers({ authorization: `Bearer ${TOOL_CAPABILITY}` }),
                body: "{}",
              }),
            ).resolves.toMatchObject({ status: 503 });
          },
        },
      );
      await fixture.stop();
    } finally {
      vi.useRealTimers();
    }
  });

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
  readonly workspace: ProductionWorkspaceAuthorityInput;
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
  native = false,
): ReturnType<typeof createSecureWorkspaceTextReadPort> {
  return createSecureWorkspaceTextReadPort({
    resolveWorkspaceRoot: () => authority.root,
    artifact: nativeBridgeArtifact(native),
    artifactVerifier: { verify: () => true },
    platform: { os: "darwin", arch: "arm64" },
    processFactory: { create: () => ({ run: process }) },
  });
}

function nativeBridgeArtifact(native: boolean): SecureWorkspaceTextReadArtifact {
  return {
    target: "darwin-arm64",
    installRelativePath: "runtime/native/keiko-secure-workspace-read",
    sha256: "a".repeat(64),
    protocol: "KSR1/KSS1",
    snapshotProtocol: "KSR2/KSS2",
    sourceCommit: "b".repeat(40),
    sourceTreeSha256: "a".repeat(64),
    signed: true,
    ...(native ? { nativeProtocol: "KSR3/KSS3" as const } : {}),
  };
}

function nativeReadAuthority(
  maxToolCalls?: number,
  runId = "run-1",
): ReturnType<typeof catalogRuntimeFixture> {
  const base = catalogRuntimeFixture("autonomous-delivery");
  if (maxToolCalls === undefined) return base;
  const trusted = { ...base.trusted, budget: { ...base.trusted.budget, maxToolCalls } };
  const registry = new EditorAgentAuthorityRegistry();
  const authority = new CodingRuntimeAuthorityService(
    registry,
    () => runId,
    () => "nonce-1",
    undefined,
    createInMemoryRuntimeCapabilityStore({ nowMs: () => Date.parse(RUNTIME_NOW) }),
  );
  const intent = {
    schemaVersion: "1" as const,
    requestId: "request-1",
    command: "start" as const,
    taskIntent: "Read the accepted workspace",
    requestedMode: "autonomous-delivery" as const,
    modelSource: "keiko-model-gateway" as const,
  };
  const confirmation = authority.confirmStart(
    intent,
    trusted.taskId,
    trusted.operatorId,
    RUNTIME_NOW,
  );
  const minted = authority.mintStart(intent, trusted, confirmation, RUNTIME_NOW);
  if (!minted.ok) throw new TypeError("Expected one-tool authority mint");
  authority.transition(runId, "ready", RUNTIME_NOW);
  authority.transition(runId, "running", RUNTIME_NOW);
  return { ...base, trusted, registry, authority, minted };
}

function nativeBridgeFixture(
  text: string,
  effect?: SecureWorkspaceTextReadProcess["run"],
  maxToolCalls?: number,
  native = false,
  runId = "run-1",
): NativeBridgeFixture {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(RUNTIME_NOW));
  const authority = nativeReadAuthority(maxToolCalls, runId);
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
    secureWorkspaceTextRead: nativeBridgeSecureRead(authority, process, native),
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
    workspace,
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

function nativeInvocationInput(
  id = "native-original-read",
  signal?: AbortSignal,
): CodingToolNativeReadBeginInput {
  return {
    ...nativeBridgeInput(id),
    signal,
    context: {
      sessionID: "native-session",
      messageID: "native-message",
      id: "native-call",
      agent: "build",
    },
  };
}

it("charges one original read invocation rather than each target and instruction IO", async () => {
  const f = nativeBridgeFixture("PRIVATE_PARENT_READ_BYTES", undefined, 1);
  const admission = vi.spyOn(f.authority.authority, "resolveCapabilityForDelegation");
  const fixture = await startBridgeFixture(
    f.facade,
    { maxInFlight: 1, requestDeadlineMs: 1000 },
    f.control,
  );
  const invocations = fixture.runtime.toolBridge.nativeTextRead?.invocations;
  expect(invocations).toBeDefined();
  try {
    const begun = await invocations?.begin(nativeInvocationInput());
    expect(begun?.ok).toBe(true);
    if (begun?.ok !== true || invocations === undefined)
      throw new Error("native read did not begin");
    for (const ordinal of [1, 2]) {
      const result = await invocations.readTextSnapshot(begun.identity, {
        ordinal,
        relativePath: "fixture.ts",
      });
      expect(result.ok).toBe(true);
    }
    expect(f.process).toHaveBeenCalledTimes(2);
    expect(admission.mock.calls.reduce((count, [input]) => count + input.usage.toolCalls, 0)).toBe(
      1,
    );
    expect(await invocations.close(begun.identity, "completed")).toBe(true);
    await begun.settled;
    expect(invocations.signalFor(begun.identity)).toBeUndefined();
    expect(
      f.registry.inspect({ runId: f.authority.minted.authorityRef.runId, ...begun.identity }).kind,
    ).toBe("terminal");
    expect(await invocations.begin(nativeInvocationInput("budget-exhausted-next-read"))).toEqual({
      ok: false,
      reason: "dispatch-refused",
    });
    expect(f.process).toHaveBeenCalledTimes(2);
  } finally {
    f.registry.dispose();
    await fixture.stop();
  }
});

it("offers an inactive original read invocation owner on the existing private bridge", async () => {
  const f = nativeBridgeFixture("PRIVATE_PARENT_READ_BYTES");
  const fixture = await startBridgeFixture(
    f.facade,
    { maxInFlight: 1, requestDeadlineMs: 1000 },
    f.control,
  );
  try {
    expect(fixture.runtime.toolBridge.nativeTextRead?.invocations?.begin).toBeTypeOf("function");
    expect(f.process).not.toHaveBeenCalled();
  } finally {
    await fixture.stop();
    f.registry.dispose();
  }
});

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

describe("primary agent selection on the run port (#3897)", () => {
  const agentFacade: CodingToolFacade = {
    execute: () => Promise.resolve({ status: "observed", evidence: [] }),
  };

  // A submitted turn stays armed until it settles; an already-aborted wait settles it as not
  // productive, which frees the run for the next submission without scripting a runtime history.
  async function settleTurn(port: OpenCodeRuntimeComposition["runPort"]): Promise<void> {
    await port.waitForTerminal(FIXTURE_RUN_ID, AbortSignal.abort());
  }

  function agentControl(extra: Partial<StartBridgeControl> = {}): {
    readonly control: StartBridgeControl;
    readonly agentRequests: NonNullable<
      NonNullable<StartBridgeControl["runControl"]>["agentRequests"]
    >;
    readonly promptBodies: string[];
    readonly activityLog: ReturnType<typeof createBufferedServerLogSink>;
    readonly diagnostics: Parameters<ServerDiagnosticSink["record"]>[0][];
  } {
    const agentRequests: NonNullable<
      NonNullable<StartBridgeControl["runControl"]>["agentRequests"]
    > = [];
    const promptBodies: string[] = [];
    const diagnostics: Parameters<ServerDiagnosticSink["record"]>[0][] = [];
    const activityLog = createBufferedServerLogSink();
    return {
      agentRequests,
      promptBodies,
      activityLog,
      diagnostics,
      control: {
        activityLog,
        diagnostics: {
          record: (record): void => {
            diagnostics.push(record);
          },
        },
        runControl: { promptBodies, abortSessions: [], statusResponses: [{}], agentRequests },
        ...extra,
      },
    };
  }

  it("lists plan only where the native service runs its own agent policy", async () => {
    for (const [profile, expected] of [
      ["native", ["build", "plan"]],
      ["direct", ["build"]],
      ["code-mode", ["build"]],
    ] as const) {
      const { control } = agentControl({ readToolProfile: () => profile });
      const fixture = await startBridgeFixture(agentFacade, undefined, control);
      try {
        expect(fixture.runtime.runPort.selectableAgents).toEqual(expected);
      } finally {
        await fixture.stop();
      }
    }
  });

  it("switches the session agent once, before the prompt, and not again for the same agent", async () => {
    const { control, agentRequests, promptBodies, activityLog } = agentControl({
      readToolProfile: () => "native",
    });
    const fixture = await startBridgeFixture(agentFacade, undefined, control);
    try {
      const port = fixture.runtime.runPort;
      await expect(port.submitTask(FIXTURE_RUN_ID, "outline it", undefined, "plan")).resolves.toBe(
        true,
      );
      expect(agentRequests).toEqual([
        { path: "/api/session/ses_tool/agent", body: '{"agent":"plan"}', promptsBefore: 0 },
      ]);
      expect(parsedBodies(promptBodies)).toEqual([turnPrompt({ text: "outline it" })]);
      await settleTurn(port);

      // Same agent again, and an absent agent: the session already runs plan, so nothing is re-sent.
      await expect(port.submitTask(FIXTURE_RUN_ID, "refine it", undefined, "plan")).resolves.toBe(
        true,
      );
      await settleTurn(port);
      await expect(port.submitTask(FIXTURE_RUN_ID, "and again")).resolves.toBe(true);
      await settleTurn(port);
      expect(agentRequests).toHaveLength(1);
      expect(promptBodies).toHaveLength(3);

      // Back to the default agent is a switch of its own, again before its prompt.
      await expect(port.submitTask(FIXTURE_RUN_ID, "now build", undefined, "build")).resolves.toBe(
        true,
      );
      expect(agentRequests.map(({ body, promptsBefore }) => ({ body, promptsBefore }))).toEqual([
        { body: '{"agent":"plan"}', promptsBefore: 0 },
        { body: '{"agent":"build"}', promptsBefore: 3 },
      ]);

      const lines = activityLog.events
        .filter((event) => event.op === "coding-runtime.agent.selected")
        .map((event) =>
          expectActivityLogProof(
            "coding-runtime.agent.selected.emitted-line",
            formatActivityLogProofLine(event),
          ),
        );
      expect(lines).toMatchObject([
        {
          correlationId: FIXTURE_RUN_ID,
          runId: FIXTURE_RUN_ID,
          agent: "plan",
          previousAgent: "build",
        },
        {
          correlationId: FIXTURE_RUN_ID,
          runId: FIXTURE_RUN_ID,
          agent: "build",
          previousAgent: "plan",
        },
      ]);
      expect(JSON.stringify(lines)).not.toMatch(/outline it|refine it|now build/u);
    } finally {
      await fixture.stop();
    }
  });

  it("issues no switch and leaves the prompt flow untouched when no agent is requested", async () => {
    const { control, agentRequests, promptBodies, activityLog } = agentControl({
      readToolProfile: () => "native",
    });
    const fixture = await startBridgeFixture(agentFacade, undefined, control);
    try {
      const port = fixture.runtime.runPort;
      await expect(port.submitTask(FIXTURE_RUN_ID, "plain task")).resolves.toBe(true);
      await settleTurn(port);
      // The default agent is what a fresh run already runs: naming it is not a switch either.
      await expect(
        port.submitTask(FIXTURE_RUN_ID, "explicit build", undefined, "build"),
      ).resolves.toBe(true);
      expect(agentRequests).toEqual([]);
      expect(parsedBodies(promptBodies)).toEqual([
        turnPrompt({ text: "plain task" }),
        turnPrompt({ text: "explicit build" }),
      ]);
      expect(activityLog.events.some((event) => event.op === "coding-runtime.agent.selected")).toBe(
        false,
      );
    } finally {
      await fixture.stop();
    }
  });

  it("fails the submission truthfully when the switch is refused: no prompt, no assumed agent", async () => {
    let refuse = true;
    const { control, agentRequests, promptBodies, diagnostics, activityLog } = agentControl({
      readToolProfile: () => "native",
    });
    const runControl = {
      ...control.runControl,
      promptBodies,
      abortSessions: [],
      statusResponses: [{}],
      agentRequests,
      agentResponse: (): Response =>
        refuse
          ? new Response(JSON.stringify({ _tag: "AgentNotFoundError", agentID: "plan" }), {
              status: 404,
              headers: { "content-type": "application/json" },
            })
          : new Response(null, { status: 204 }),
    };
    const fixture = await startBridgeFixture(agentFacade, undefined, { ...control, runControl });
    try {
      const port = fixture.runtime.runPort;
      await expect(
        port.submitTask(FIXTURE_RUN_ID, "PRIVATE_PLAN_TASK", undefined, "plan"),
      ).resolves.toBe(false);
      expect(promptBodies).toEqual([]);
      expect(activityLog.events.some((event) => event.op === "coding-runtime.agent.selected")).toBe(
        false,
      );
      expect(diagnostics).toEqual([
        expect.objectContaining({
          correlationId: FIXTURE_RUN_ID,
          operation: "coding-runtime.opencode-composition",
          source: "opencode.turn",
          message: "runtime-turn-failed",
          code: expect.stringMatching(/^stage=agent:/u) as unknown,
        }),
      ]);
      expect(JSON.stringify(diagnostics)).not.toContain("PRIVATE_PLAN_TASK");

      // The refused switch was not remembered: the retry sends it again and then the prompt.
      refuse = false;
      await expect(port.submitTask(FIXTURE_RUN_ID, "retry", undefined, "plan")).resolves.toBe(true);
      expect(agentRequests.map(({ body }) => body)).toEqual([
        '{"agent":"plan"}',
        '{"agent":"plan"}',
      ]);
      expect(parsedBodies(promptBodies)).toEqual([turnPrompt({ text: "retry" })]);
    } finally {
      await fixture.stop();
    }
  });

  it.each(["direct", "code-mode"] as const)(
    "refuses a plan request on the governed %s profile before any request leaves, and still runs build",
    async (profile) => {
      const { control, agentRequests, promptBodies, diagnostics } = agentControl({
        readToolProfile: () => profile,
      });
      const fixture = await startBridgeFixture(agentFacade, undefined, control);
      try {
        const port = fixture.runtime.runPort;
        await expect(
          port.submitTask(FIXTURE_RUN_ID, "read-only please", undefined, "plan"),
        ).resolves.toBe(false);
        expect(agentRequests).toEqual([]);
        expect(promptBodies).toEqual([]);
        expect(diagnostics).toEqual([
          expect.objectContaining({
            correlationId: FIXTURE_RUN_ID,
            code: expect.stringMatching(/^stage=agent-unsupported:/u) as unknown,
          }),
        ]);
        expect(JSON.stringify(diagnostics)).not.toContain("read-only please");

        await expect(port.submitTask(FIXTURE_RUN_ID, "build it", undefined, "build")).resolves.toBe(
          true,
        );
        expect(agentRequests).toEqual([]);
        expect(parsedBodies(promptBodies)).toEqual([turnPrompt({ text: "build it" })]);
      } finally {
        await fixture.stop();
      }
    },
  );
});

// A lost acknowledgement of a turn's prompt does not end a turn the runtime may already run: the
// prompt is resent once under the same native id, which the producer answers from what it stored.
describe("turn prompt acknowledgement on the run port (#3897 review)", () => {
  const promptFacade: CodingToolFacade = {
    execute: () => Promise.resolve({ status: "observed", evidence: [] }),
  };

  function acknowledgementControl(answers: readonly ("deliver" | "lose" | "refuse")[]): {
    readonly control: StartBridgeControl;
    readonly promptBodies: string[];
    readonly diagnostics: Parameters<ServerDiagnosticSink["record"]>[0][];
    readonly posts: () => number;
  } {
    const promptBodies: string[] = [];
    const diagnostics: Parameters<ServerDiagnosticSink["record"]>[0][] = [];
    let posts = 0;
    return {
      promptBodies,
      diagnostics,
      posts: () => posts,
      control: {
        diagnostics: {
          record: (record): void => {
            diagnostics.push(record);
          },
        },
        runControl: {
          promptBodies,
          abortSessions: [],
          statusResponses: [{}],
          promptAcknowledgement: () => answers[posts++] ?? "deliver",
        },
      },
    };
  }

  function failureStages(diagnostics: Parameters<ServerDiagnosticSink["record"]>[0][]): string[] {
    return diagnostics.map((record) => /^stage=([a-z-]+):/u.exec(record.code ?? "")?.[1] ?? "");
  }

  it("resends a prompt whose acknowledgement was lost once, under the same id, and runs the turn", async () => {
    const { control, promptBodies, diagnostics, posts } = acknowledgementControl(["lose"]);
    const fixture = await startBridgeFixture(promptFacade, undefined, control);
    try {
      await expect(
        fixture.runtime.runPort.submitTask(FIXTURE_RUN_ID, "PRIVATE_FIRST_TASK"),
      ).resolves.toBe(true);
      expect(posts()).toBe(2);
      // The producer holds one input: the resend carried the id of the post it had stored.
      expect(parsedBodies(promptBodies)).toEqual([turnPrompt({ text: "PRIVATE_FIRST_TASK" })]);
      expect(failureStages(diagnostics)).toEqual(["submit-resent"]);
      expect(diagnostics[0]).toMatchObject({
        correlationId: FIXTURE_RUN_ID,
        errorClass: "TypeError",
      });
      expect(JSON.stringify(diagnostics)).not.toContain("PRIVATE_FIRST_TASK");
    } finally {
      await fixture.stop();
    }
  });

  it("fails the turn when the resent prompt's acknowledgement is lost too, and frees the run", async () => {
    const { control, promptBodies, diagnostics, posts } = acknowledgementControl(["lose", "lose"]);
    const fixture = await startBridgeFixture(promptFacade, undefined, control);
    try {
      const port = fixture.runtime.runPort;
      await expect(port.submitTask(FIXTURE_RUN_ID, "first task")).resolves.toBe(false);
      expect(posts()).toBe(2);
      expect(failureStages(diagnostics)).toEqual(["submit-resent", "submit"]);
      // One resend, never a loop; the cancelled turn leaves the run free for the next submission.
      await expect(port.submitTask(FIXTURE_RUN_ID, "second task")).resolves.toBe(true);
      expect(posts()).toBe(3);
      expect(parsedBodies(promptBodies)).toEqual([
        turnPrompt({ text: "first task" }),
        turnPrompt({ text: "second task" }),
      ]);
      const [first, second] = parsedBodies(promptBodies) as { id: string }[];
      expect(first?.id).not.toBe(second?.id);
    } finally {
      await fixture.stop();
    }
  });

  it("never resends a prompt the runtime refused", async () => {
    const { control, promptBodies, diagnostics, posts } = acknowledgementControl(["refuse"]);
    const fixture = await startBridgeFixture(promptFacade, undefined, control);
    try {
      await expect(fixture.runtime.runPort.submitTask(FIXTURE_RUN_ID, "first task")).resolves.toBe(
        false,
      );
      expect(posts()).toBe(1);
      expect(promptBodies).toEqual([]);
      expect(failureStages(diagnostics)).toEqual(["submit"]);
    } finally {
      await fixture.stop();
    }
  });
});

// B3, S04: undo and restore of the newest turn on a live native run. The logic is pinned in
// opencodeRevert.test.ts and against the pinned binary in opencodeNativeRevert.real.test.ts; this
// suite pins the composition's wiring: which profile offers it, how it reaches the runtime, and that
// a staged undo blocks the next turn.
describe("turn revert on the run port (B3, S04)", () => {
  const revertFacade: CodingToolFacade = {
    execute: () => Promise.resolve({ status: "observed", evidence: [] }),
  };
  const TURN = [
    { id: "msg_old_user", time: { created: 1 }, text: "older", type: "user" },
    { id: "msg_old_idle", time: { created: 2 }, type: "idle", outcome: "succeeded" },
    { id: "msg_turn_user", time: { created: 3 }, text: "newest", type: "user" },
    { id: "msg_turn_idle", time: { created: 4 }, type: "idle", outcome: "succeeded" },
  ];
  const CHANGED = [
    { file: "a.txt", patch: "SECRET-PATCH", additions: 3, deletions: 1, status: "modified" },
  ];

  function revertControl(profile: "native" | "direct" | "code-mode" = "native"): {
    readonly control: StartBridgeControl;
    readonly revert: NonNullable<NonNullable<StartBridgeControl["runControl"]>["revert"]>;
    readonly promptBodies: string[];
    readonly activityLog: ReturnType<typeof createBufferedServerLogSink>;
  } {
    const promptBodies: string[] = [];
    const activityLog = createBufferedServerLogSink();
    const revert = {
      requests: [] as { method: string; path: string; body?: string }[],
      diff: CHANGED as unknown[],
      messages: [] as unknown[],
      staged: { messageID: "msg_turn_user", files: CHANGED } as unknown,
    };
    return {
      revert,
      promptBodies,
      activityLog,
      control: {
        activityLog,
        readToolProfile: () => profile,
        runControl: { promptBodies, abortSessions: [], statusResponses: [{}], revert },
      },
    };
  }

  it("offers undo and restore on the native profile only, whose runtime records snapshots", async () => {
    for (const [profile, offered] of [
      ["native", true],
      ["direct", false],
      ["code-mode", false],
    ] as const) {
      const { control } = revertControl(profile);
      const fixture = await startBridgeFixture(revertFacade, undefined, control);
      try {
        const port = fixture.runtime.runPort;
        expect(port.revertTurn !== undefined, profile).toBe(offered);
        expect(port.revertState !== undefined, profile).toBe(offered);
      } finally {
        await fixture.stop();
      }
    }
  });

  it("counts the newest turn's files through the runtime's session diff, without its patch", async () => {
    const { control, revert, activityLog } = revertControl();
    const fixture = await startBridgeFixture(revertFacade, undefined, control);
    try {
      await expect(fixture.runtime.runPort.revertState?.(FIXTURE_RUN_ID)).resolves.toEqual({
        staged: false,
        fileCount: 1,
        additions: 3,
        deletions: 1,
      });
      expect(revert.requests).toEqual([{ method: "GET", path: "/api/session/ses_tool/diff" }]);
      expect(JSON.stringify(activityLog.events)).not.toContain("SECRET-PATCH");
    } finally {
      await fixture.stop();
    }
  });

  it("stages an undo at the newest turn, blocks the next turn until it is restored, then runs it", async () => {
    const { control, revert, promptBodies, activityLog } = revertControl();
    const fixture = await startBridgeFixture(revertFacade, undefined, control);
    try {
      const port = fixture.runtime.runPort;
      revert.messages = TURN;
      // The turn settles through the run port, which records the files as the turn left them.
      await port.waitForTerminal(FIXTURE_RUN_ID, AbortSignal.abort());
      await vi.waitFor(() => {
        expect(revert.requests).toEqual([{ method: "GET", path: "/api/session/ses_tool/diff" }]);
      });
      revert.requests.length = 0;
      await expect(port.revertTurn?.(FIXTURE_RUN_ID, "undo", "corr-revert-0001")).resolves.toEqual({
        ok: true,
        fileCount: 1,
        additions: 3,
        deletions: 1,
      });
      expect(revert.requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
        "GET /api/session/ses_tool/diff",
        "POST /api/session/ses_tool/revert/stage",
      ]);
      expect(revert.requests[1]?.body).toBe(
        JSON.stringify({ messageID: "msg_turn_user", files: true }),
      );

      // The staged undo refuses a new turn: nothing is posted, and the refusal is on the log.
      await expect(port.submitTask(FIXTURE_RUN_ID, "SECRET-NEXT-TASK")).resolves.toBe(false);
      expect(promptBodies).toEqual([]);
      expect(
        activityLog.events.filter((event) => event.op.startsWith("coding-runtime.revert.")),
      ).toMatchObject([
        { op: "coding-runtime.revert.applied", correlationId: "corr-revert-0001" },
        {
          op: "coding-runtime.revert.refused",
          level: "warn",
          correlationId: FIXTURE_RUN_ID,
          extra: { runId: FIXTURE_RUN_ID, operation: "submit", reason: "turn-blocked" },
        },
      ]);
      expect(JSON.stringify(activityLog.events)).not.toContain("SECRET-NEXT-TASK");

      revert.messages = [];
      await expect(port.revertTurn?.(FIXTURE_RUN_ID, "restore")).resolves.toMatchObject({
        ok: true,
        fileCount: 1,
      });
      expect(revert.requests.at(-1)).toEqual({
        method: "DELETE",
        path: "/api/session/ses_tool/revert",
      });
      await expect(port.submitTask(FIXTURE_RUN_ID, "the next task")).resolves.toBe(true);
      expect(parsedBodies(promptBodies)).toEqual([turnPrompt({ text: "the next task" })]);
    } finally {
      await fixture.stop();
    }
  });

  it("refuses to undo a settled turn whose files changed after it settled", async () => {
    const { control, revert } = revertControl();
    const fixture = await startBridgeFixture(revertFacade, undefined, control);
    try {
      const port = fixture.runtime.runPort;
      const workspaceRoot = fixture.preparation.env.KEIKO_CODING_WORKSPACE_ROOT ?? "";
      writeFileSync(join(workspaceRoot, "a.txt"), "as the turn left it\n");
      revert.messages = TURN;
      await port.waitForTerminal(FIXTURE_RUN_ID, AbortSignal.abort());
      // Healthy control: while the file is as the turn left it, undo and restore both apply.
      await expect(port.revertTurn?.(FIXTURE_RUN_ID, "undo")).resolves.toMatchObject({ ok: true });
      revert.messages = [];
      await expect(port.revertTurn?.(FIXTURE_RUN_ID, "restore")).resolves.toMatchObject({
        ok: true,
      });
      revert.messages = TURN;
      revert.requests.length = 0;
      writeFileSync(join(workspaceRoot, "a.txt"), "a human edit after the turn\n");
      await expect(port.revertTurn?.(FIXTURE_RUN_ID, "undo")).resolves.toEqual({
        ok: false,
        reason: "workspace-changed",
      });
      expect(revert.requests.map(({ path }) => path)).not.toContain(
        "/api/session/ses_tool/revert/stage",
      );
    } finally {
      await fixture.stop();
    }
  });

  it("does not stop a turn in flight whose changed files none of its own native edits wrote", async () => {
    const { control, revert } = revertControl();
    const runControl = control.runControl;
    if (runControl === undefined) throw new Error("expected run control");
    const fixture = await startBridgeFixture(revertFacade, undefined, control);
    try {
      const port = fixture.runtime.runPort;
      runControl.statusResponses.splice(0, runControl.statusResponses.length, { ses_tool: {} }, {});
      revert.messages = TURN;
      // Nothing proves who changed the file while the turn runs: the undo is refused, unstopped.
      await expect(port.revertTurn?.(FIXTURE_RUN_ID, "undo")).resolves.toEqual({
        ok: false,
        reason: "workspace-changed",
      });
      expect(runControl.abortSessions).toEqual([]);
      expect(revert.requests.map(({ path }) => path)).not.toContain(
        "/api/session/ses_tool/revert/stage",
      );
    } finally {
      await fixture.stop();
    }
  });
});

// S07 (ADR-0137 D10): the messages sent into the running turn that the runtime has not taken yet.
describe("pending messages on the run port (S07)", () => {
  const facadeStub: CodingToolFacade = {
    execute: () => Promise.resolve({ status: "observed", evidence: [] }),
  };
  const SECRET = "PRIVATE-OPERATOR-TEXT";

  async function inboxFixture(profile: "native" | "direct" | "code-mode" = "native"): Promise<{
    readonly fixture: Awaited<ReturnType<typeof startBridgeFixture>>;
    readonly port: OpenCodeRuntimeComposition["runPort"];
    readonly promptBodies: string[];
    readonly inbox: NonNullable<NonNullable<StartBridgeControl["runControl"]>["inbox"]>;
    readonly runControl: NonNullable<StartBridgeControl["runControl"]>;
    /** The session history the fixture answers; a test completes the turn by replacing `value`. */
    readonly history: { value: readonly Readonly<Record<string, unknown>>[] };
    readonly activityLog: ReturnType<typeof createBufferedServerLogSink>;
  }> {
    const workspace = realpathSync(tempDir("keiko-inbox-workspace-"));
    const promptBodies: string[] = [];
    const activityLog = createBufferedServerLogSink();
    const inbox = {
      requests: [],
      runtimeOwned: [],
      withdrawn: new Set<string>(),
      promoted: new Set<string>(),
      delivered: new Set<string>(),
    };
    const history = { value: completedTurnHistory().slice(0, 1) };
    const runControl = {
      promptBodies,
      abortSessions: [],
      statusResponses: [{}, { ses_tool: { type: "busy" } }] as unknown[],
      inbox,
    };
    const fixture = await startBridgeFixture(facadeStub, undefined, {
      activityLog,
      workspaceRoot: workspace,
      readToolProfile: () => profile,
      runControl,
      historyResponseFactory: () => Promise.resolve(v2Envelope(history.value.slice().reverse())),
    });
    return {
      fixture,
      port: fixture.runtime.runPort,
      promptBodies,
      inbox,
      runControl,
      history,
      activityLog,
    };
  }

  /**
   * Interrupts the turn in flight the way the settlement tests do: the runtime has been asked to stop,
   * and the turn ends once its history shows it complete and the session reports quiet.
   */
  async function interrupt(
    fixtureState: Awaited<ReturnType<typeof inboxFixture>>,
  ): Promise<boolean> {
    const { port, runControl, history } = fixtureState;
    const terminal = port.waitForTerminal(FIXTURE_RUN_ID, AbortSignal.timeout(5_000));
    await new Promise<void>((resolve) => setImmediate(resolve));
    const aborting = port.abortTask(FIXTURE_RUN_ID);
    await new Promise<void>((resolve) => setImmediate(resolve));
    history.value = completedTurnHistory();
    runControl.statusResponses.push({});
    const stopped = await aborting;
    await terminal;
    return stopped;
  }

  async function deliver(
    port: OpenCodeRuntimeComposition["runPort"],
    requestId: string,
    text: string,
    delivery: "queue" | "steer",
  ): Promise<void> {
    const admitted = port.admitPromptInputs?.(FIXTURE_RUN_ID, { delivery, requestId });
    if (admitted?.ok !== true) throw new Error("expected the delivery to be admitted");
    await expect(port.deliverPrompt?.(FIXTURE_RUN_ID, text, admitted.inputs)).resolves.toBe(true);
  }

  const idOf = (body: string | undefined): string =>
    (JSON.parse(body ?? "{}") as { id?: string }).id ?? "";

  const inboxLines = (log: ReturnType<typeof createBufferedServerLogSink>): unknown[] =>
    log.events
      .filter((event) => event.op === "coding-runtime.inbox.action")
      .map((event) => {
        const { completeness: _completeness, loss: _loss, ...extra } = event.extra ?? {};
        return extra;
      });

  it("lists the delivered messages with the operator's own preview, steered before queued", async () => {
    const { fixture, port, promptBodies, inbox, activityLog } = await inboxFixture();
    try {
      await expect(port.submitTask(FIXTURE_RUN_ID, "first task")).resolves.toBe(true);
      await deliver(port, "req-queued", `  ${SECRET}\n  later  `, "queue");
      await deliver(port, "req-steered", "use the new logger", "steer");
      // The runtime queued something of its own: it is not the operator's and is never listed.
      inbox.runtimeOwned.push({
        id: "msg_runtime_owned",
        sessionID: "ses_tool",
        time: { created: 1 },
        type: "synthetic",
        payload: { text: "RUNTIME-OWNED-TEXT" },
        delivery: "steer",
      });

      const items = await port.listInbox?.(FIXTURE_RUN_ID, "corr-0123456789");

      expect(items).toEqual([
        { itemId: idOf(promptBodies[2]), delivery: "steer", preview: "use the new logger" },
        { itemId: idOf(promptBodies[1]), delivery: "queue", preview: `${SECRET} later` },
      ]);
      expect(inbox.requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
        "GET /api/session/ses_tool/inbox",
      ]);
      expect(inboxLines(activityLog)).toEqual([
        {
          runId: FIXTURE_RUN_ID,
          action: "list",
          outcome: "listed",
          itemCount: 2,
          ignoredCount: 1,
        },
      ]);
      expect(JSON.stringify(activityLog.events)).not.toMatch(
        /PRIVATE-OPERATOR-TEXT|RUNTIME-OWNED-TEXT|use the new logger|msg_/u,
      );
    } finally {
      await fixture.stop();
    }
  });

  it("offers nothing while no turn is in flight and on a profile that takes no delivery", async () => {
    const idle = await inboxFixture();
    const mapped = await inboxFixture("direct");
    try {
      await expect(idle.port.listInbox?.(FIXTURE_RUN_ID)).resolves.toBeUndefined();
      await expect(mapped.port.submitTask(FIXTURE_RUN_ID, "first task")).resolves.toBe(true);
      await expect(mapped.port.listInbox?.(FIXTURE_RUN_ID)).resolves.toBeUndefined();

      expect(idle.inbox.requests).toEqual([]);
      expect(mapped.inbox.requests).toEqual([]);
      expect(inboxLines(idle.activityLog)).toEqual([
        { runId: FIXTURE_RUN_ID, action: "list", outcome: "turn-not-running" },
      ]);
      expect(inboxLines(mapped.activityLog)).toEqual([
        { runId: FIXTURE_RUN_ID, action: "list", outcome: "unsupported" },
      ]);
    } finally {
      await idle.fixture.stop();
      await mapped.fixture.stop();
    }
  });

  it("withdraws a queued message from the runtime, and lists and withdraws it no more", async () => {
    const { fixture, port, promptBodies, inbox, activityLog } = await inboxFixture();
    try {
      await port.submitTask(FIXTURE_RUN_ID, "first task");
      await deliver(port, "req-1", "first queued", "queue");
      await deliver(port, "req-2", "second queued", "queue");
      const [first, second] = [idOf(promptBodies[1]), idOf(promptBodies[2])];

      await expect(
        port.actOnInbox?.(FIXTURE_RUN_ID, { action: "cancel", itemId: first }, "corr-0123456789"),
      ).resolves.toEqual({ ok: true, outcome: "cancelled" });

      expect(inbox.withdrawn).toEqual(new Set([first]));
      expect((await port.listInbox?.(FIXTURE_RUN_ID))?.map((item) => item.itemId)).toEqual([
        second,
      ]);
      await expect(
        port.actOnInbox?.(FIXTURE_RUN_ID, { action: "cancel", itemId: first }),
      ).resolves.toEqual({ ok: true, outcome: "already-cancelled" });
      expect(inbox.requests.filter(({ method }) => method === "DELETE")).toHaveLength(1);
      expect(inboxLines(activityLog)).toMatchObject([
        { action: "cancel", outcome: "cancelled" },
        { action: "list", outcome: "listed", itemCount: 1 },
        { action: "cancel", outcome: "already-cancelled" },
      ]);
    } finally {
      await fixture.stop();
    }
  });

  it("promotes a queued message with the closed steer body and lists it as sent now", async () => {
    const { fixture, port, promptBodies, inbox } = await inboxFixture();
    try {
      await port.submitTask(FIXTURE_RUN_ID, "first task");
      await deliver(port, "req-1", "queued", "queue");
      const queued = idOf(promptBodies[1]);

      await expect(
        port.actOnInbox?.(FIXTURE_RUN_ID, { action: "promote", itemId: queued }),
      ).resolves.toEqual({ ok: true, outcome: "promoted" });

      const patch = inbox.requests.find(({ method }) => method === "PATCH");
      expect(patch).toEqual({
        method: "PATCH",
        path: `/api/session/ses_tool/inbox/${queued}`,
        body: JSON.stringify({ delivery: "steer" }),
      });
      await expect(port.listInbox?.(FIXTURE_RUN_ID)).resolves.toEqual([
        { itemId: queued, delivery: "steer", preview: "queued" },
      ]);
    } finally {
      await fixture.stop();
    }
  });

  it("says a message the turn already took was delivered and changes nothing", async () => {
    const { fixture, port, promptBodies, inbox } = await inboxFixture();
    try {
      await port.submitTask(FIXTURE_RUN_ID, "first task");
      await deliver(port, "req-1", "steered", "steer");
      const steered = idOf(promptBodies[1]);
      inbox.delivered.add(steered);

      await expect(
        port.actOnInbox?.(FIXTURE_RUN_ID, { action: "cancel", itemId: steered }),
      ).resolves.toEqual({ ok: true, outcome: "already-delivered" });
      await expect(
        port.actOnInbox?.(FIXTURE_RUN_ID, { action: "promote", itemId: steered }),
      ).resolves.toEqual({ ok: true, outcome: "already-delivered" });

      expect(inbox.requests.map(({ method }) => method)).toEqual(["GET", "GET"]);
    } finally {
      await fixture.stop();
    }
  });

  it("refuses an id Keiko did not mint for the run, even one the runtime itself lists", async () => {
    const { fixture, port, inbox } = await inboxFixture();
    try {
      await port.submitTask(FIXTURE_RUN_ID, "first task");
      inbox.runtimeOwned.push({
        id: "msg_runtime_owned",
        sessionID: "ses_tool",
        time: { created: 1 },
        type: "user",
        payload: { text: "typed in another client" },
        delivery: "queue",
      });

      for (const action of ["cancel", "promote"] as const) {
        await expect(
          port.actOnInbox?.(FIXTURE_RUN_ID, { action, itemId: "msg_runtime_owned" }),
        ).resolves.toEqual({ ok: false, reason: "unknown-item" });
      }

      expect(inbox.requests).toEqual([]);
      expect(inbox.withdrawn.size).toBe(0);
    } finally {
      await fixture.stop();
    }
  });

  it("withdraws every pending message when the turn is interrupted, so none leaks into the next turn", async () => {
    const state = await inboxFixture();
    const { fixture, port, promptBodies, inbox, runControl, activityLog } = state;
    try {
      await port.submitTask(FIXTURE_RUN_ID, "first task");
      await deliver(port, "req-1", "queued one", "queue");
      await deliver(port, "req-2", "steered two", "steer");
      const pending = [idOf(promptBodies[1]), idOf(promptBodies[2])];

      await expect(interrupt(state)).resolves.toBe(true);

      expect(runControl.abortSessions).toEqual(["ses_tool"]);
      expect(inbox.withdrawn).toEqual(new Set(pending));
      expect(inboxLines(activityLog)).toEqual([
        { runId: FIXTURE_RUN_ID, action: "withdraw", outcome: "withdrawn", itemCount: 2 },
      ]);
    } finally {
      await fixture.stop();
    }
  });

  it("settles an interrupt whose withdrawal failed: the failure is evidence, not a failed stop", async () => {
    const state = await inboxFixture();
    const { fixture, port, promptBodies, inbox, activityLog } = state;
    try {
      await port.submitTask(FIXTURE_RUN_ID, "first task");
      await deliver(port, "req-1", "queued one", "queue");
      inbox.respond = (): Response => new Response("", { status: 503 });

      await expect(interrupt(state)).resolves.toBe(true);

      expect(promptBodies).toHaveLength(2);
      expect(inboxLines(activityLog)).toMatchObject([{ action: "withdraw", outcome: "failed" }]);
    } finally {
      await fixture.stop();
    }
  });
});

// ADR-0137 D10: a message that joins the running turn and the workspace files a prompt references.
describe("prompt inputs on the run port (ADR-0137 D10)", () => {
  const facadeStub: CodingToolFacade = {
    execute: () => Promise.resolve({ status: "observed", evidence: [] }),
  };

  async function inputsFixture(profile: "native" | "direct" | "code-mode" = "native"): Promise<{
    readonly fixture: Awaited<ReturnType<typeof startBridgeFixture>>;
    readonly port: OpenCodeRuntimeComposition["runPort"];
    readonly workspace: string;
    readonly promptBodies: string[];
    readonly activityLog: ReturnType<typeof createBufferedServerLogSink>;
    readonly diagnostics: Parameters<ServerDiagnosticSink["record"]>[0][];
  }> {
    const workspace = realpathSync(tempDir("keiko-prompt-inputs-workspace-"));
    writeFileSync(join(workspace, "notes.md"), "NOTES-CANARY\n");
    writeFileSync(join(workspace, ".env"), "TOKEN=SENSITIVE-CANARY\n");
    const promptBodies: string[] = [];
    const diagnostics: Parameters<ServerDiagnosticSink["record"]>[0][] = [];
    const activityLog = createBufferedServerLogSink();
    const fixture = await startBridgeFixture(facadeStub, undefined, {
      activityLog,
      workspaceRoot: workspace,
      readToolProfile: () => profile,
      diagnostics: { record: (record): void => void diagnostics.push(record) },
      runControl: { promptBodies, abortSessions: [], statusResponses: [{}] },
    });
    return {
      fixture,
      port: fixture.runtime.runPort,
      workspace,
      promptBodies,
      activityLog,
      diagnostics,
    };
  }

  const settle = (port: OpenCodeRuntimeComposition["runPort"]): Promise<boolean> =>
    port.waitForTerminal(FIXTURE_RUN_ID, AbortSignal.abort());

  const inputLines = (log: ReturnType<typeof createBufferedServerLogSink>): unknown[] =>
    log.events
      .filter((event) => event.op === "coding-runtime.prompt-inputs.settled")
      .map((event) => event.extra);

  it("offers delivery, references and slash commands on the native service only", async () => {
    for (const [profile, expected] of [
      ["native", { delivery: true, references: true, commands: true, mentions: true }],
      ["direct", { delivery: false, references: false, commands: false, mentions: false }],
      ["code-mode", { delivery: false, references: false, commands: false, mentions: false }],
    ] as const) {
      const { fixture, port } = await inputsFixture(profile);
      try {
        expect(port.promptInputs).toEqual(expected);
      } finally {
        await fixture.stop();
      }
    }
  });

  it("delivers a steering message to the session of the turn in flight without arming another", async () => {
    const { fixture, port, promptBodies, activityLog } = await inputsFixture();
    try {
      await expect(port.submitTask(FIXTURE_RUN_ID, "first task")).resolves.toBe(true);
      const admitted = port.admitPromptInputs?.(FIXTURE_RUN_ID, {
        delivery: "steer",
        references: [{ path: "notes.md" }],
      });
      if (admitted?.ok !== true) throw new Error("expected the delivery to be admitted");

      await expect(
        port.deliverPrompt?.(FIXTURE_RUN_ID, "also read @notes.md", admitted.inputs),
      ).resolves.toBe(true);

      // Both inputs carry the producer's supported message id (ADR-0137 D10), which is what makes a
      // resend of either one the same input; only the delivery names how it joins the turn.
      expect(promptBodies).toHaveLength(2);
      expect(JSON.parse(promptBodies[0] ?? "null")).toEqual(turnPrompt({ text: "first task" }));
      expect(JSON.parse(promptBodies[1] ?? "null")).toEqual({
        text: "also read @notes.md",
        id: expect.stringMatching(NATIVE_MESSAGE_ID) as unknown,
        files: [{ uri: openCodeV2PromptFileData(Buffer.from("NOTES-CANARY\n")), name: "notes.md" }],
        delivery: "steer",
      });
      expect(inputLines(activityLog)).toMatchObject([
        {
          runId: FIXTURE_RUN_ID,
          outcome: "accepted",
          delivery: "steer",
          referenceCount: 1,
          attachedBytes: "NOTES-CANARY\n".length,
          inputBinding: "bound",
        },
      ]);
      // The turn the message joined is still the one in flight: a second turn cannot be armed,
      // and settling it is the first turn's own settlement.
      await expect(port.submitTask(FIXTURE_RUN_ID, "second turn")).resolves.toBe(false);
      await expect(settle(port)).resolves.toBe(false);
      expect(JSON.stringify(inputLines(activityLog))).not.toMatch(
        /NOTES-CANARY|notes\.md|also read/u,
      );
    } finally {
      await fixture.stop();
    }
  });

  it("queues a message behind the turn in flight with the closed delivery and nothing else", async () => {
    const { fixture, port, promptBodies } = await inputsFixture();
    try {
      await expect(port.submitTask(FIXTURE_RUN_ID, "first task")).resolves.toBe(true);
      const admitted = port.admitPromptInputs?.(FIXTURE_RUN_ID, { delivery: "queue" });
      if (admitted?.ok !== true) throw new Error("expected the delivery to be admitted");
      await expect(
        port.deliverPrompt?.(FIXTURE_RUN_ID, "after this turn", admitted.inputs),
      ).resolves.toBe(true);
      expect(JSON.parse(promptBodies[1] ?? "null")).toEqual({
        text: "after this turn",
        id: expect.stringMatching(NATIVE_MESSAGE_ID) as unknown,
        delivery: "queue",
      });
    } finally {
      await fixture.stop();
    }
  });

  it("refuses a delivery when no turn is in flight, recording a closed reason and sending nothing", async () => {
    const { fixture, port, promptBodies, activityLog } = await inputsFixture();
    try {
      expect(port.admitPromptInputs?.(FIXTURE_RUN_ID, { delivery: "steer" })).toEqual({
        ok: false,
        reason: "turn-not-running",
      });
      await expect(port.submitTask(FIXTURE_RUN_ID, "first task")).resolves.toBe(true);
      await settle(port);
      expect(port.admitPromptInputs?.(FIXTURE_RUN_ID, { delivery: "queue" })).toEqual({
        ok: false,
        reason: "turn-not-running",
      });
      expect(port.admitPromptInputs?.("unknown-run", { delivery: "queue" })).toEqual({
        ok: false,
        reason: "run-unavailable",
      });
      expect(parsedBodies(promptBodies)).toEqual([turnPrompt({ text: "first task" })]);
      expect(inputLines(activityLog)).toMatchObject([
        { outcome: "refused", delivery: "steer", reason: "turn-not-running" },
        { outcome: "refused", delivery: "queue", reason: "turn-not-running" },
        { outcome: "refused", delivery: "queue", reason: "run-unavailable" },
      ]);
    } finally {
      await fixture.stop();
    }
  });

  // ADR-0137 D10 (C02): the runtime's slash commands. The run port lists them, confirms a turn's command
  // against the listing, and posts the turn as `session.command` instead of a prompt.
  describe("slash commands on the run port (C02)", () => {
    const facadeStub: CodingToolFacade = {
      execute: () => Promise.resolve({ status: "observed", evidence: [] }),
    };
    const LISTING = [
      { name: "init", description: "guided AGENTS.md setup" },
      { name: "review", description: "review changes [commit|branch|pr], defaults to uncommitted" },
    ];

    async function commandsFixture(
      profile: "native" | "direct" | "code-mode" = "native",
      listing: unknown[] = LISTING,
    ): Promise<{
      readonly fixture: Awaited<ReturnType<typeof startBridgeFixture>>;
      readonly port: OpenCodeRuntimeComposition["runPort"];
      readonly workspace: string;
      readonly promptBodies: string[];
      readonly commands: NonNullable<NonNullable<StartBridgeControl["runControl"]>["commands"]>;
      readonly activityLog: ReturnType<typeof createBufferedServerLogSink>;
      readonly diagnostics: Parameters<ServerDiagnosticSink["record"]>[0][];
    }> {
      const workspace = realpathSync(tempDir("keiko-commands-workspace-"));
      writeFileSync(join(workspace, "notes.md"), "NOTES-CANARY\n");
      const promptBodies: string[] = [];
      const diagnostics: Parameters<ServerDiagnosticSink["record"]>[0][] = [];
      const activityLog = createBufferedServerLogSink();
      const commands = { requests: [], listing };
      const fixture = await startBridgeFixture(facadeStub, undefined, {
        activityLog,
        workspaceRoot: workspace,
        readToolProfile: () => profile,
        diagnostics: { record: (record): void => void diagnostics.push(record) },
        runControl: { promptBodies, abortSessions: [], statusResponses: [{}], commands },
      });
      return {
        fixture,
        port: fixture.runtime.runPort,
        workspace,
        promptBodies,
        commands,
        activityLog,
        diagnostics,
      };
    }

    const lines = (log: ReturnType<typeof createBufferedServerLogSink>, op: string): unknown[] =>
      log.events.filter((event) => event.op === op).map((event) => event.extra);

    const admitted = (
      port: OpenCodeRuntimeComposition["runPort"],
      extra: Record<string, unknown> = {},
    ): AdmittedPromptInputs => {
      const inputs = port.admitPromptInputs?.(FIXTURE_RUN_ID, {
        command: { name: "review", argumentBytes: 4 },
        ...extra,
      });
      if (inputs?.ok !== true) throw new Error("expected the command inputs to be admitted");
      return inputs.inputs;
    };

    it("lists the commands the runtime reports and records the counts alone", async () => {
      const { fixture, port, commands, activityLog } = await commandsFixture();
      try {
        await expect(port.listCommands?.(FIXTURE_RUN_ID, "corr-0123456789")).resolves.toEqual(
          LISTING,
        );

        expect(commands.requests).toEqual([{ method: "GET", path: "/api/command" }]);
        expect(lines(activityLog, "coding-runtime.commands.listed")).toMatchObject([
          { runId: FIXTURE_RUN_ID, outcome: "listed", commandCount: 2, skippedCount: 0 },
        ]);
        expect(JSON.stringify(activityLog.events)).not.toMatch(/AGENTS\.md|uncommitted/u);
      } finally {
        await fixture.stop();
      }
    });

    it("confirms a turn's command against the listing before anything is reserved or sent", async () => {
      const { fixture, port, commands, promptBodies, activityLog } = await commandsFixture();
      try {
        const inputs = admitted(port);
        await expect(port.admitCommand?.(FIXTURE_RUN_ID, inputs)).resolves.toEqual({
          ok: true,
          inputs,
        });
        const unknown = admitted(port, { command: { name: "nope", argumentBytes: 0 } });
        await expect(port.admitCommand?.(FIXTURE_RUN_ID, unknown)).resolves.toEqual({
          ok: false,
          reason: "command-unknown",
        });

        expect(commands.requests.map(({ path }) => path)).toEqual(["/api/command", "/api/command"]);
        expect(promptBodies).toEqual([]);
        expect(lines(activityLog, "coding-runtime.prompt-inputs.settled")).toMatchObject([
          { outcome: "refused", reason: "command-unknown", command: "other" },
        ]);
        expect(JSON.stringify(activityLog.events)).not.toContain("nope");
      } finally {
        await fixture.stop();
      }
    });

    it("posts the turn as the session command with the text after it and no prompt", async () => {
      const { fixture, port, commands, promptBodies, activityLog } = await commandsFixture();
      try {
        const inputs = admitted(port);

        await expect(
          port.submitTask(FIXTURE_RUN_ID, "main", undefined, undefined, inputs),
        ).resolves.toBe(true);

        expect(commands.requests).toEqual([
          {
            method: "POST",
            path: "/api/session/ses_tool/command",
            body: JSON.stringify({ name: "review", text: "main" }),
          },
        ]);
        expect(promptBodies, "a command turn is not also posted as a prompt").toEqual([]);
        expect(lines(activityLog, "coding-runtime.prompt-inputs.settled")).toMatchObject([
          {
            outcome: "accepted",
            command: "review",
            commandArgumentBytes: 4,
            delivery: "none",
            referenceCount: 0,
          },
        ]);
        expect(JSON.stringify(activityLog.events)).not.toContain("main");
      } finally {
        await fixture.stop();
      }
    });

    it("sends a bare command with an empty text and the admitted attachments with the command", async () => {
      const { fixture, port, commands } = await commandsFixture();
      try {
        const bare = admitted(port, { command: { name: "init", argumentBytes: 0 } });
        await expect(port.submitTask(FIXTURE_RUN_ID, "", undefined, undefined, bare)).resolves.toBe(
          true,
        );
        await settleRun(port);
        const withFile = admitted(port, { references: [{ path: "notes.md" }] });
        await expect(
          port.submitTask(FIXTURE_RUN_ID, "the notes", undefined, undefined, withFile),
        ).resolves.toBe(true);

        expect(commands.requests.map(({ body }) => body)).toEqual([
          JSON.stringify({ name: "init", text: "" }),
          JSON.stringify({
            name: "review",
            text: "the notes",
            files: [
              { uri: openCodeV2PromptFileData(Buffer.from("NOTES-CANARY\n")), name: "notes.md" },
            ],
          }),
        ]);
      } finally {
        await fixture.stop();
      }
    });

    it("drops the initial context of a command turn instead of hiding it in the arguments", async () => {
      const { fixture, port, commands, promptBodies } = await commandsFixture();
      try {
        await expect(
          port.submitTask(
            FIXTURE_RUN_ID,
            "main",
            "REPOSITORY-INSTRUCTIONS-CANARY",
            undefined,
            admitted(port),
          ),
        ).resolves.toBe(true);

        expect(commands.requests[0]?.body).toBe(JSON.stringify({ name: "review", text: "main" }));
        expect(JSON.stringify([commands.requests, promptBodies])).not.toContain("CANARY");
      } finally {
        await fixture.stop();
      }
    });

    it("fails the turn and records the refusal when the runtime rejects the command", async () => {
      const { fixture, port, commands, promptBodies, activityLog, diagnostics } =
        await commandsFixture();
      try {
        commands.commandResponse = (): Response =>
          new Response(JSON.stringify({ _tag: "CommandExecutionError" }), {
            status: 500,
            headers: { "content-type": "application/json" },
          });

        await expect(
          port.submitTask(FIXTURE_RUN_ID, "main", undefined, undefined, admitted(port)),
        ).resolves.toBe(false);

        expect(promptBodies).toEqual([]);
        expect(lines(activityLog, "coding-runtime.prompt-inputs.settled")).toMatchObject([
          { outcome: "refused", reason: "command-refused", command: "review" },
        ]);
        expect(
          activityLog.events.find((event) => event.extra?.reason === "command-refused"),
        ).toMatchObject({
          level: "warn",
          errorKind: expect.any(String) as unknown,
        });
        expect(diagnostics).not.toHaveLength(0);
        expect(JSON.stringify([diagnostics, activityLog.events])).not.toContain("main");
        // The failed turn is not left armed: an ordinary turn is accepted afterwards.
        commands.commandResponse = undefined;
        await expect(port.submitTask(FIXTURE_RUN_ID, "an ordinary turn")).resolves.toBe(true);
      } finally {
        await fixture.stop();
      }
    });

    it("reports an unreachable listing as a failed listing and refuses the command it could not confirm", async () => {
      const { fixture, port, commands, activityLog } = await commandsFixture();
      try {
        commands.listingResponse = (): Response => new Response("", { status: 500 });

        await expect(port.listCommands?.(FIXTURE_RUN_ID)).resolves.toBeUndefined();
        await expect(port.admitCommand?.(FIXTURE_RUN_ID, admitted(port))).resolves.toEqual({
          ok: false,
          reason: "command-unavailable",
        });

        expect(lines(activityLog, "coding-runtime.commands.listed")).toMatchObject([
          { outcome: "failed" },
        ]);
        expect(lines(activityLog, "coding-runtime.prompt-inputs.settled")).toMatchObject([
          { outcome: "refused", reason: "command-unavailable" },
        ]);
      } finally {
        await fixture.stop();
      }
    });

    it.each(["direct", "code-mode"] as const)(
      "offers no command on the governed %s profile and sends none",
      async (profile) => {
        const { fixture, port, commands, promptBodies, activityLog } =
          await commandsFixture(profile);
        try {
          await expect(port.listCommands?.(FIXTURE_RUN_ID)).resolves.toBeUndefined();
          expect(
            port.admitPromptInputs?.(FIXTURE_RUN_ID, {
              command: { name: "review", argumentBytes: 0 },
            }),
          ).toEqual({ ok: false, reason: "commands-unsupported" });

          expect(commands.requests).toEqual([]);
          expect(promptBodies).toEqual([]);
          expect(lines(activityLog, "coding-runtime.commands.listed")).toMatchObject([
            { outcome: "unsupported" },
          ]);
          expect(lines(activityLog, "coding-runtime.prompt-inputs.settled")).toMatchObject([
            { outcome: "refused", reason: "commands-unsupported" },
          ]);
        } finally {
          await fixture.stop();
        }
      },
    );

    it("offers nothing for a run that is not live", async () => {
      const { fixture, port, commands } = await commandsFixture();
      try {
        await expect(port.listCommands?.("unknown-run")).resolves.toBeUndefined();
        expect(commands.requests).toEqual([]);
      } finally {
        await fixture.stop();
      }
    });
  });

  const settleRun = (port: OpenCodeRuntimeComposition["runPort"]): Promise<boolean> =>
    port.waitForTerminal(FIXTURE_RUN_ID, AbortSignal.abort());

  it.each(["direct", "code-mode"] as const)(
    "refuses a delivery and references on the governed %s profile, like a plan request",
    async (profile) => {
      const { fixture, port, promptBodies, activityLog } = await inputsFixture(profile);
      try {
        await expect(port.submitTask(FIXTURE_RUN_ID, "first task")).resolves.toBe(true);
        expect(port.admitPromptInputs?.(FIXTURE_RUN_ID, { delivery: "steer" })).toEqual({
          ok: false,
          reason: "delivery-unsupported",
        });
        expect(
          port.admitPromptInputs?.(FIXTURE_RUN_ID, { references: [{ path: "notes.md" }] }),
        ).toEqual({ ok: false, reason: "references-unsupported" });
        expect(parsedBodies(promptBodies)).toEqual([turnPrompt({ text: "first task" })]);
        expect(inputLines(activityLog)).toMatchObject([
          { reason: "delivery-unsupported" },
          { reason: "references-unsupported" },
        ]);
      } finally {
        await fixture.stop();
      }
    },
  );

  it("attaches referenced files to the prompt of a new turn and counts them against the run", async () => {
    const { fixture, port, promptBodies } = await inputsFixture();
    try {
      const admitted = port.admitPromptInputs?.(FIXTURE_RUN_ID, {
        references: [{ path: "notes.md" }],
      });
      if (admitted?.ok !== true) throw new Error("expected the references to be admitted");
      await expect(
        port.submitTask(
          FIXTURE_RUN_ID,
          "summarize @notes.md",
          undefined,
          undefined,
          admitted.inputs,
        ),
      ).resolves.toBe(true);
      expect(parsedBodies(promptBodies)).toEqual([
        turnPrompt({
          text: "summarize @notes.md",
          files: [
            { uri: openCodeV2PromptFileData(Buffer.from("NOTES-CANARY\n")), name: "notes.md" },
          ],
        }),
      ]);
    } finally {
      await fixture.stop();
    }
  });

  it("never starts a turn for a delivery: submitTask refuses it and arms nothing", async () => {
    const { fixture, port, promptBodies } = await inputsFixture();
    try {
      await expect(port.submitTask(FIXTURE_RUN_ID, "first task")).resolves.toBe(true);
      const admitted = port.admitPromptInputs?.(FIXTURE_RUN_ID, { delivery: "steer" });
      if (admitted?.ok !== true) throw new Error("expected the delivery to be admitted");
      await settle(port);
      await expect(
        port.submitTask(FIXTURE_RUN_ID, "as a turn", undefined, undefined, admitted.inputs),
      ).resolves.toBe(false);
      expect(parsedBodies(promptBodies)).toEqual([turnPrompt({ text: "first task" })]);
      // Nothing was armed by the refusal: an ordinary turn is still accepted.
      await expect(port.submitTask(FIXTURE_RUN_ID, "an ordinary turn")).resolves.toBe(true);
    } finally {
      await fixture.stop();
    }
  });

  it("refuses a hostile reference before anything is sent and logs the closed reason, not the path", async () => {
    const { fixture, port, promptBodies, activityLog, workspace } = await inputsFixture();
    try {
      symlinkSync("/etc/hosts", join(workspace, "hosts-link"));
      for (const [path, reason] of [
        ["../outside.txt", "reference-invalid"],
        ["/etc/hosts", "reference-invalid"],
        [".env", "reference-sensitive"],
        ["hosts-link", "reference-outside-workspace"],
        ["missing.md", "reference-unreadable"],
      ] as const) {
        expect(port.admitPromptInputs?.(FIXTURE_RUN_ID, { references: [{ path }] })).toEqual({
          ok: false,
          reason,
        });
      }
      expect(promptBodies).toEqual([]);
      expect(inputLines(activityLog)).toHaveLength(5);
      expect(JSON.stringify(inputLines(activityLog))).not.toMatch(
        /\/etc\/hosts|hosts-link|\.env|outside\.txt|missing\.md|SENSITIVE/u,
      );
    } finally {
      await fixture.stop();
    }
  });
});

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

  it.each(["direct", "code-mode"] as const)(
    "binds the captured %s profile to the same config digest without admitting readiness",
    async (toolProfile) => {
      const fixture = await stoppedPreparationFixture(toolProfile);
      const result = await fixture.runtime.prepareServiceHost(
        fixture.preparation,
        await preparationReceipt(),
      );
      expect(result.ok).toBe(true);
      if (!result.ok || result.serviceHost === undefined)
        throw new Error("Expected inactive preparation");
      expect(result.serviceHost.binding).toMatchObject({ toolProfile });
      const config = readFileSync(
        join(result.serviceHost.binding.stateRoot, "config", "opencode", "opencode.json"),
      );
      expect(result.serviceHost.binding.configDigest).toBe(
        createHash("sha256").update(config).digest("hex"),
      );
      expect(JSON.parse(result.serviceHost.packet)).toEqual(result.serviceHost.binding);
      await expect(
        fixture.runtime.runPort.submitTask(fixture.preparation.runId, "still inactive"),
      ).resolves.toBe(false);
    },
  );

  it("rejects a copied receipt without blocking later preparation from the owned receipt", async () => {
    const receipt = await preparationReceipt();
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

async function beginOriginalBridgeRead(
  fixture: Awaited<ReturnType<typeof startBridgeFixture>>,
  input = nativeInvocationInput(),
): Promise<{
  readonly facet: NonNullable<CodingToolNativeTextReadFacet["invocations"]>;
  readonly begun: Extract<
    import("./codingToolFacadePorts.js").CodingToolNativeReadBeginResult,
    { readonly ok: true }
  >;
}> {
  const facet = fixture.runtime.toolBridge.nativeTextRead?.invocations;
  if (facet === undefined) throw new TypeError("Expected original read bridge");
  const begun = await facet.begin(input);
  if (!begun.ok) throw new TypeError("Expected admitted original read");
  return { facet, begun };
}

it.each(["cancel", "deadline", "stop"] as const)(
  "retains the actual original read's held physical work after %s and reconciles only after settlement",
  async (cause) => {
    let release!: (packet: Buffer) => void;
    const held = new Promise<Buffer>((resolve) => {
      release = resolve;
    });
    let physicalSettled = false;
    const f = nativeBridgeFixture("PRIVATE_ORIGINAL_HELD_BYTES", () =>
      held.then((packet) => {
        physicalSettled = true;
        return packet;
      }),
    );
    const signal = new AbortController();
    const onRelease = vi.fn();
    let runRoot = "";
    const fixture = await startBridgeFixture(
      f.facade,
      { requestDeadlineMs: cause === "deadline" ? 100 : 1000, maxInFlight: 1 },
      {
        ...f.control,
        onRelease,
        afterStart: (_runtime, root): void => {
          runRoot = root;
        },
      },
    );
    try {
      const { facet, begun } = await beginOriginalBridgeRead(
        fixture,
        nativeInvocationInput("native-held", signal.signal),
      );
      let delegateSettled = false;
      void begun.settled.then(() => {
        delegateSettled = true;
      });
      const read = facet.readTextSnapshot(begun.identity, {
        ordinal: 1,
        relativePath: "fixture.ts",
      });
      await vi.waitFor(() => {
        expect(f.process).toHaveBeenCalledOnce();
      });
      if (cause === "cancel") signal.abort();
      if (cause === "stop")
        expect(await fixture.runtime.manager.stop(FIXTURE_RUN_ID)).toMatchObject({
          ok: false,
          failureCode: "runtime-reap-unproven",
        });
      expect((await read).ok).toBe(false);
      expect(physicalSettled).toBe(false);
      expect(delegateSettled).toBe(false);
      expect(
        await facet.readTextSnapshot(begun.identity, { ordinal: 2, relativePath: "fixture.ts" }),
      ).toMatchObject({ ok: false });
      expect(f.process).toHaveBeenCalledOnce();
      if (cause !== "stop") {
        expect(await facet.begin(nativeInvocationInput("second-native-held"))).toEqual({
          ok: false,
          reason: "busy",
        });
        expect(await fixture.runtime.manager.stop(FIXTURE_RUN_ID)).toMatchObject({
          ok: false,
          failureCode: "runtime-reap-unproven",
        });
      }
      expect(existsSync(runRoot)).toBe(true);
      expect(onRelease).not.toHaveBeenCalled();
      expect(await fixture.runtime.manager.reconcile(FIXTURE_RUN_ID)).toMatchObject({
        ok: false,
        failureCode: "runtime-reap-unproven",
      });
      release(nativeBridgeSnapshot(join(f.authority.root, "fixture.ts")));
      await begun.settled;
      expect(physicalSettled).toBe(true);
      expect(await fixture.runtime.manager.reconcile(FIXTURE_RUN_ID)).toMatchObject({ ok: true });
      expect(existsSync(runRoot)).toBe(false);
      expect(onRelease).toHaveBeenCalledOnce();
      expect(JSON.stringify(f.activity.events)).not.toContain("PRIVATE_ORIGINAL_HELD_BYTES");
    } finally {
      release(nativeBridgeSnapshot(join(f.authority.root, "fixture.ts")));
      f.registry.dispose();
      await fixture.stop();
    }
  },
);

it.each(["head", "root", "revoked", "expired"] as const)(
  "refuses private child IO after actual current %s authority changes",
  async (cause) => {
    const f = nativeBridgeFixture("PRIVATE_STALE_ORIGINAL_BYTES");
    const fixture = await startBridgeFixture(
      f.facade,
      { requestDeadlineMs: 1000, maxInFlight: 1 },
      f.control,
    );
    try {
      const { facet, begun } = await beginOriginalBridgeRead(fixture);
      if (cause === "head") f.readHead.mockReturnValue("2".repeat(40));
      else if (cause === "root") {
        const active = f.workspace.workspaceLifecycle.getActive();
        if (active === undefined) throw new TypeError("Expected active workspace");
        vi.spyOn(f.workspace.workspaceLifecycle, "getActive").mockReturnValue({
          ...active,
          binding: { ...active.binding, activeRoot: join(dirname(f.authority.root), "other") },
        });
      } else if (cause === "revoked") f.authority.registry.revoke(f.authority.minted.authorityRef);
      else vi.setSystemTime(new Date(Date.parse(f.authority.trusted.expiresAt) + 1));
      expect(
        (await facet.readTextSnapshot(begun.identity, { ordinal: 1, relativePath: "fixture.ts" }))
          .ok,
      ).toBe(false);
      expect(f.process).not.toHaveBeenCalled();
      expect(await facet.close(begun.identity, "completed")).toBe(false);
      await begun.settled;
      expect(JSON.stringify(f.activity.events)).not.toContain("PRIVATE_STALE_ORIGINAL_BYTES");
    } finally {
      f.registry.dispose();
      await fixture.stop();
    }
  },
);

it("shares capacity between one original read and ordinary/native tool requests without charging child IO again", async () => {
  const f = nativeBridgeFixture("PRIVATE_SHARED_PARENT_BYTES");
  const fixture = await startBridgeFixture(
    f.facade,
    { requestDeadlineMs: 1000, maxInFlight: 1 },
    f.control,
  );
  try {
    const { facet, begun } = await beginOriginalBridgeRead(fixture);
    expect(await facet.begin(nativeInvocationInput("second-parent"))).toEqual({
      ok: false,
      reason: "busy",
    });
    expect(await readNativeBridge(fixture.runtime, nativeBridgeInput("standalone-read"))).toEqual({
      ok: false,
      reason: "busy",
    });
    const ordinary = await fixture.runtime.toolBridge.handle({
      method: "POST",
      headers: new Headers({ authorization: `Bearer ${f.authority.minted.toolFacadeCapability}` }),
      body: JSON.stringify({
        action: "read",
        relativePath: "fixture.ts",
        actionId: "ordinary-read",
        idempotencyKey: "ordinary-read",
      }),
    });
    expect(ordinary.status).toBe(429);
    expect(
      (await facet.readTextSnapshot(begun.identity, { ordinal: 1, relativePath: "fixture.ts" })).ok,
    ).toBe(true);
    expect(await facet.close(begun.identity, "completed")).toBe(true);
    await begun.settled;
    const next = await beginOriginalBridgeRead(fixture, nativeInvocationInput("fresh-parent"));
    expect(
      (
        await next.facet.readTextSnapshot(next.begun.identity, {
          ordinal: 1,
          relativePath: "fixture.ts",
        })
      ).ok,
    ).toBe(true);
    expect(await next.facet.close(next.begun.identity, "completed")).toBe(true);
    expect(f.process).toHaveBeenCalledTimes(2);
  } finally {
    f.registry.dispose();
    await fixture.stop();
  }
});

it("settles an original read's rejected physical process before a fresh parent is admitted", async () => {
  const error = new Error("PRIVATE_ORIGINAL_PROCESS_FAILURE");
  const f = nativeBridgeFixture("PRIVATE_ORIGINAL_SOURCE", () => Promise.reject(error));
  const fixture = await startBridgeFixture(
    f.facade,
    { requestDeadlineMs: 1000, maxInFlight: 1 },
    f.control,
  );
  try {
    const { facet, begun } = await beginOriginalBridgeRead(fixture);
    expect(
      await facet.readTextSnapshot(begun.identity, { ordinal: 1, relativePath: "fixture.ts" }),
    ).toMatchObject({ ok: false, reason: "process-failed" });
    expect(await facet.close(begun.identity, "failed")).toBe(false);
    await begun.settled;
    const failed = f.activity.events.filter(
      (event) => event.op === "coding-runtime.workspace-read" && event.extra?.state === "failed",
    );
    expect(failed).toHaveLength(1);
    expect(
      expectActivityLogProof(
        "coding-runtime.workspace-read.emitted-line",
        formatActivityLogProofLine(failed[0] ?? {}),
      ),
    ).toMatchObject({ state: "failed", purpose: "native-tool-io", reason: "process-failed" });
    expect(JSON.stringify(f.activity.events)).not.toContain(error.message);
    expect(JSON.stringify(f.activity.events)).not.toContain("PRIVATE_ORIGINAL_SOURCE");
    f.process.mockResolvedValue(nativeBridgeSnapshot(join(f.authority.root, "fixture.ts")));
    const next = await beginOriginalBridgeRead(fixture, nativeInvocationInput("after-rejection"));
    expect(
      (
        await facet.readTextSnapshot(next.begun.identity, {
          ordinal: 1,
          relativePath: "fixture.ts",
        })
      ).ok,
    ).toBe(true);
    expect(await facet.close(next.begun.identity, "completed")).toBe(true);
    await next.begun.settled;
    expect(f.process).toHaveBeenCalledTimes(2);
  } finally {
    f.registry.dispose();
    await fixture.stop();
  }
});

it("captures the host profile once and keeps it aligned with materialized config after input mutation", async () => {
  let toolProfile: "direct" | "code-mode" = "code-mode";
  let reads = 0;
  const fixture = await startBridgeFixture(
    { execute: () => Promise.resolve({ status: "observed", evidence: [] }) },
    undefined,
    {
      gatewayUrl: "http://127.0.0.1:4391/api/coding-sidecar/gateway",
      readToolProfile: () => {
        reads += 1;
        return toolProfile;
      },
    },
  );
  await fixture.stop();
  toolProfile = "direct";
  const result = await fixture.runtime.prepareServiceHost(
    fixture.preparation,
    await preparationReceipt(),
  );
  expect(result.ok).toBe(true);
  if (!result.ok || result.serviceHost === undefined)
    throw new Error("Expected captured host profile");
  expect(result.serviceHost.binding.toolProfile).toBe("code-mode");
  expect(reads).toBe(1);
  const config = readFileSync(
    join(result.serviceHost.binding.stateRoot, "config", "opencode", "opencode.json"),
    "utf8",
  );
  expect(config.includes('{"action":"execute","resource":"*","effect":"allow"}')).toBe(true);
});

function initialBridgeAuthority(): ReturnType<typeof catalogRuntimeFixture> & {
  readonly authorityRegistry: EditorAgentAuthorityRegistry;
} {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(RUNTIME_NOW));
  const base = catalogRuntimeFixture("autonomous-delivery");
  dirs.push(dirname(dirname(base.root)));
  const authorityRegistry = new EditorAgentAuthorityRegistry();
  const authority = new CodingRuntimeAuthorityService(
    authorityRegistry,
    () => FIXTURE_RUN_ID,
    () => "nonce-initial-bridge",
    undefined,
    createInMemoryRuntimeCapabilityStore({ nowMs: () => Date.now() }),
  );
  const intent = {
    schemaVersion: "1" as const,
    requestId: "request-initial-bridge",
    command: "start" as const,
    taskIntent: "Load original accepted project instructions",
    requestedMode: "autonomous-delivery" as const,
    modelSource: "keiko-model-gateway" as const,
  };
  const proof = authority.confirmStart(
    intent,
    base.trusted.taskId,
    base.trusted.operatorId,
    RUNTIME_NOW,
  );
  const minted = authority.mintStart(intent, base.trusted, proof, RUNTIME_NOW);
  if (!minted.ok) throw new TypeError("Expected accepted initial bridge mint");
  return { ...base, authority, minted, authorityRegistry };
}

function initialBridgeProducer(effect?: SecureWorkspaceNativeFileIO["readBytes"]): {
  readonly runtime: ReturnType<typeof initialBridgeAuthority>;
  readonly facade: CodingToolFacade;
  readonly read: ReturnType<typeof vi.fn<SecureWorkspaceNativeFileIO["readBytes"]>>;
  readonly bytes: Uint8Array;
  readonly info: { readonly type: "file"; readonly size: number; readonly mtimeMs: number };
  readonly registry: ReturnType<typeof createCodingToolInvocationRegistry>;
  readonly control: Pick<StartBridgeControl, "workspaceRoot" | "toolFacadeCapability">;
} {
  const runtime = initialBridgeAuthority();
  const workspace = nativeBridgeWorkspace(runtime);
  const liveFacts = (): ReturnType<typeof productionRuntimeAuthorityFacts> =>
    productionRuntimeAuthorityFacts(workspace, runtime.trusted);
  const access = (): WorkspaceRootAccess => ({
    kind: "managed-task" as const,
    canonicalRoot: runtime.root,
    repositoryRoot: runtime.root,
    fs: nodeWorkspaceFs,
  });
  const projection = createProductionAcceptedInitializationAuthority({
    minted: runtime.minted,
    authority: runtime.authority,
    context: runtime.trusted,
    liveFacts,
    resolveWorkspaceRootAccess: access,
    signal: new AbortController().signal,
    now: (): Date => new Date(),
  });
  const bytes = new Uint8Array([65, 71, 69, 78, 84, 83]);
  const info = { type: "file" as const, size: bytes.length, mtimeMs: -1 };
  const read = vi.fn<SecureWorkspaceNativeFileIO["readBytes"]>(
    effect ??
      ((): Promise<Awaited<ReturnType<SecureWorkspaceNativeFileIO["readBytes"]>>> =>
        Promise.resolve({ ok: true, bytes, info })),
  );
  const registry = createCodingToolInvocationRegistry();
  const facade = createProductionManagedWorktreeToolFacade({
    authority: runtime.authority,
    authorityRef: runtime.minted.authorityRef,
    workspaceRoot: runtime.root,
    authorityExpiresAt: runtime.trusted.expiresAt,
    effectiveMode: "autonomous-delivery",
    deploymentCeiling: "autonomous-delivery",
    liveFacts,
    resolveWorkspaceRootAccess: access,
    secureWorkspaceTextRead: {
      readText: vi.fn(),
      nativeFileIO: {
        readBytes: read,
        stat: vi.fn(),
        list: vi.fn(),
      },
    },
    initializationAuthority: projection,
    editorAgentClient: { action: vi.fn() },
    verificationRunner: { runToReport: vi.fn() },
    invocationRegistry: registry,
    onRuntimeEvent: vi.fn(),
    activityLog: createBufferedServerLogSink(),
  });
  return {
    runtime,
    facade,
    read,
    bytes,
    info,
    registry,
    control: {
      workspaceRoot: runtime.root,
      toolFacadeCapability: runtime.minted.toolFacadeCapability,
    },
  };
}

it("offers the accepted initialization callback only on the inactive private bridge", async () => {
  const f = initialBridgeProducer();
  const fixture = await startBridgeFixture(f.facade, undefined, f.control);
  try {
    expect(fixture.runtime.toolBridge.acceptedInitialization?.run).toBeTypeOf("function");
    expect(
      await fixture.runtime.toolBridge.acceptedInitialization?.run(async (io) => {
        const read = await io.readBytes({ relativePath: "AGENTS.md" });
        return read.ok ? read.bytes.length : -1;
      }),
    ).toEqual({ ok: true, value: 6 });
    expect(f.read).toHaveBeenCalledOnce();
    expect(f.runtime.authority.state().state).toBe("starting");
  } finally {
    await fixture.stop();
    f.registry.dispose();
  }
});

it("retains initial raw IO through callback failure, interrupted preparation and recovery release", async () => {
  let release!: (result: Awaited<ReturnType<SecureWorkspaceNativeFileIO["readBytes"]>>) => void;
  const held = new Promise<Awaited<ReturnType<SecureWorkspaceNativeFileIO["readBytes"]>>>(
    (resolve) => {
      release = resolve;
    },
  );
  const f = initialBridgeProducer(() => held);
  const onRelease = vi.fn();
  let root = "";
  const fixture = await startBridgeFixture(
    f.facade,
    { requestDeadlineMs: 1000, maxInFlight: 1 },
    {
      ...f.control,
      onRelease,
      afterStart: (_runtime, runRoot) => {
        root = runRoot;
      },
    },
  );
  const pending = fixture.runtime.toolBridge.acceptedInitialization?.run((io) => {
    void io.readBytes({ relativePath: "AGENTS.md" });
    return Promise.reject(new Error("PRIVATE_NATIVE_INITIAL_FAILURE"));
  });
  try {
    await vi.waitFor(() => {
      expect(f.read).toHaveBeenCalledOnce();
    });
    expect(await fixture.runtime.manager.stop(FIXTURE_RUN_ID)).toMatchObject({
      ok: false,
      failureCode: "runtime-reap-unproven",
    });
    expect(await pending).toEqual({ ok: false, reason: "cancelled" });
    expect(() => {
      accessSync(root);
    }).not.toThrow();
    expect(onRelease).not.toHaveBeenCalled();
    expect(await fixture.runtime.manager.reconcile(FIXTURE_RUN_ID)).toMatchObject({
      ok: false,
      failureCode: "runtime-reap-unproven",
    });
    release({ ok: true, bytes: f.bytes, info: f.info });
    await vi.waitFor(() => {
      expect(f.bytes.every((byte) => byte === 0)).toBe(true);
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(await fixture.runtime.manager.reconcile(FIXTURE_RUN_ID)).toEqual({
      ok: true,
      status: "stopped",
    });
    expect(() => {
      accessSync(root);
    }).toThrow();
    expect(onRelease).toHaveBeenCalledOnce();
  } finally {
    release({ ok: true, bytes: f.bytes, info: f.info });
    await pending;
    await fixture.stop();
    f.registry.dispose();
  }
});

it("shares the existing admission capacity with initial acquisition instead of a second gate", async () => {
  let finish!: () => void;
  const held = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const f = initialBridgeProducer();
  const fixture = await startBridgeFixture(
    f.facade,
    { maxInFlight: 1, requestDeadlineMs: 1000 },
    f.control,
  );
  let entered = false;
  const pending = fixture.runtime.toolBridge.acceptedInitialization?.run(async () => {
    entered = true;
    await held;
    return "ready";
  });
  try {
    await vi.waitFor(() => {
      expect(entered).toBe(true);
    });
    expect(
      await fixture.runtime.toolBridge.handle({
        method: "POST",
        headers: new Headers({ authorization: `Bearer ${f.runtime.minted.toolFacadeCapability}` }),
        body: JSON.stringify({
          action: "read",
          relativePath: "AGENTS.md",
          actionId: "ordinary-call",
          idempotencyKey: "ordinary-call",
        }),
      }),
    ).toMatchObject({ status: 429 });
    expect(
      await fixture.runtime.toolBridge.acceptedInitialization?.run(() =>
        Promise.resolve("second-start"),
      ),
    ).toEqual({ ok: false, reason: "busy" });
    finish();
    expect(await pending).toEqual({ ok: true, value: "ready" });
    expect(
      await fixture.runtime.toolBridge.acceptedInitialization?.run(() =>
        Promise.resolve("watch-refresh"),
      ),
    ).toEqual({ ok: false, reason: "initialization-closed" });
  } finally {
    finish();
    await pending;
    await fixture.stop();
    f.registry.dispose();
  }
});

it("returns initial deadline refusal promptly while the actual raw producer remains held", async () => {
  let release!: (result: Awaited<ReturnType<SecureWorkspaceNativeFileIO["readBytes"]>>) => void;
  const held = new Promise<Awaited<ReturnType<SecureWorkspaceNativeFileIO["readBytes"]>>>(
    (resolve) => {
      release = resolve;
    },
  );
  const f = initialBridgeProducer(() => held);
  const fixture = await startBridgeFixture(
    f.facade,
    { maxInFlight: 1, requestDeadlineMs: 60 },
    f.control,
  );
  let late!: CodingAcceptedInitializationReadPort;
  const pending = fixture.runtime.toolBridge.acceptedInitialization?.run((io) => {
    late = io;
    return io.readBytes({ relativePath: "AGENTS.md" });
  });
  try {
    await vi.waitFor(() => {
      expect(f.read).toHaveBeenCalledOnce();
    });
    expect(await pending).toEqual({ ok: false, reason: "timeout" });
    expect(await late.readBytes({ relativePath: "nested/AGENTS.md" })).toEqual({
      ok: false,
      reason: "preflight-refused",
    });
    expect(f.read).toHaveBeenCalledOnce();
  } finally {
    release({ ok: true, bytes: f.bytes, info: f.info });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await fixture.stop();
    f.registry.dispose();
  }
});

// Fixture verifier accepts this exact compiled helper, without claiming release qualification.
// Cold native process startup uses the existing helper budget; these controls verify admission
// accounting and reaping, while the separate deadline controls retain their short injected budgets.
describe.skipIf(process.platform !== "darwin")(
  "original Read parent with actual native IO process",
  () => {
    let executable = "";
    beforeAll(() => {
      const base = mkdtempSync(join(tmpdir(), "native-parent-file-"));
      executable = join(base, "secure-read");
      execFileSync("cc", [
        "-std=c11",
        "-Wall",
        "-Wextra",
        "-Werror",
        "-O2",
        fileURLToPath(
          new URL(
            "../../../../native/secure-workspace-read/secure_workspace_read.c",
            import.meta.url,
          ),
        ),
        "-o",
        executable,
      ]);
    });
    afterAll(() => {
      if (executable !== "") rmSync(dirname(executable), { recursive: true, force: true });
    });
    function physicalFixture(
      afterFrame?: (frame: Uint8Array) => Promise<Uint8Array>,
      runId = "run-1",
    ): NativeBridgeFixture {
      const factory = createNodeSecureWorkspaceReadProcessFactory({
        binding: {
          executable,
          artifact: nativeBridgeArtifact(true),
          resourceRoot: dirname(executable),
          helperSizeBytes: statSync(executable).size,
        },
        safeCwd: dirname(executable),
      });
      return nativeBridgeFixture(
        "PRIVATE_PARENT_NATIVE_BYTES",
        (request) =>
          factory
            .create(nativeBridgeArtifact(true))
            .run(request)
            .then((frame) => afterFrame?.(frame) ?? frame),
        1,
        true,
        runId,
      );
    }
    it("runs bytes, stat, root list and zero range under one authority charge and admission slot", async () => {
      const f = physicalFixture();
      const admission = vi.spyOn(f.authority.authority, "resolveCapabilityForDelegation");
      const fixture = await startBridgeFixture(
        f.facade,
        { maxInFlight: 1, requestDeadlineMs: SECURE_WORKSPACE_TEXT_READ_TIMEOUT_MS },
        f.control,
      );
      try {
        const parent = fixture.runtime.toolBridge.nativeTextRead?.invocations;
        const begun = await parent?.begin(nativeInvocationInput());
        if (begun?.ok !== true || parent?.fileIO === undefined)
          throw new TypeError("Missing native parent IO");
        const packet = {
          ordinal: 1,
          relativePath: "fixture.ts",
          purpose: "native-tool-io" as const,
        };
        const bytes = await parent.fileIO.readBytes(begun.identity, packet);
        expect(bytes).toMatchObject({
          ok: true,
          bytes: Buffer.from("PRIVATE_PARENT_NATIVE_BYTES"),
        });
        expect(await parent.fileIO.stat(begun.identity, { ...packet, ordinal: 2 })).toMatchObject({
          ok: true,
          info: { type: "file", size: statSync(join(f.authority.root, "fixture.ts")).size },
        });
        expect(
          await parent.fileIO.list(begun.identity, { ...packet, ordinal: 3, relativePath: "" }),
        ).toMatchObject({
          ok: true,
          entries: [{ name: "fixture.ts", type: "file" }],
        });
        expect(
          await parent.fileIO.readBytes(begun.identity, {
            ...packet,
            ordinal: 4,
            range: { offset: 0, length: 0 },
          }),
        ).toMatchObject({ ok: true, bytes: Buffer.alloc(0) });
        expect(f.process).toHaveBeenCalledTimes(4);
        expect(
          admission.mock.calls.reduce((count, [input]) => count + input.usage.toolCalls, 0),
        ).toBe(1);
        expect(await parent.begin(nativeInvocationInput("other-parent"))).toEqual({
          ok: false,
          reason: "busy",
        });
        expect(await parent.close(begun.identity, "completed")).toBe(true);
        await begun.settled;
        expect(JSON.stringify(f.activity.events)).not.toMatch(
          /PRIVATE_PARENT_NATIVE_BYTES|fixture\.ts/u,
        );
      } finally {
        await stopNativeBridge(f, fixture);
      }
    });
    it("retains the real native process promise through stop and withholds its held completed response", async () => {
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const reached = vi.fn();
      const f = physicalFixture(async (frame) => {
        reached();
        await held;
        return frame;
      });
      const onRelease = vi.fn();
      let runRoot = "";
      const fixture = await startBridgeFixture(
        f.facade,
        { maxInFlight: 1, requestDeadlineMs: SECURE_WORKSPACE_TEXT_READ_TIMEOUT_MS },
        {
          ...f.control,
          onRelease,
          afterStart: (_runtime, root): void => {
            runRoot = root;
          },
        },
      );
      const parent = fixture.runtime.toolBridge.nativeTextRead?.invocations;
      const begun = await parent?.begin(nativeInvocationInput());
      if (begun?.ok !== true || parent?.fileIO === undefined)
        throw new TypeError("Missing native parent IO");
      const reading = parent.fileIO.readBytes(begun.identity, {
        ordinal: 1,
        relativePath: "fixture.ts",
        purpose: "native-tool-io",
      });
      try {
        await vi.waitFor(
          () => {
            expect(reached).toHaveBeenCalledOnce();
          },
          { timeout: SECURE_WORKSPACE_TEXT_READ_TIMEOUT_MS },
        );
        expect(await fixture.runtime.manager.stop(FIXTURE_RUN_ID)).toMatchObject({
          ok: false,
          failureCode: "runtime-reap-unproven",
        });
        expect(await reading).toEqual({ ok: false, reason: "cancelled" });
        expect(existsSync(runRoot)).toBe(true);
        expect(onRelease).not.toHaveBeenCalled();
        expect(await fixture.runtime.manager.reconcile(FIXTURE_RUN_ID)).toMatchObject({
          ok: false,
        });
        release();
        await begun.settled;
        expect(existsSync(runRoot)).toBe(true);
        expect(onRelease).not.toHaveBeenCalled();
        expect(await fixture.runtime.manager.reconcile(FIXTURE_RUN_ID)).toEqual({
          ok: true,
          status: "stopped",
        });
        expect(existsSync(runRoot)).toBe(false);
        expect(onRelease).toHaveBeenCalledOnce();
        const workspaceReads = f.activity.events.filter(
          (event) => event.op === "coding-runtime.workspace-read",
        );
        expect(workspaceReads.at(-1)?.extra?.state).toBe("failed");
        expect(JSON.stringify(f.activity.events)).not.toContain("PRIVATE_PARENT_NATIVE_BYTES");
      } finally {
        release();
        await reading;
        await stopNativeBridge(f, fixture);
      }
    });

    it("transports real binary, stat and directory IO through one admitted HTTP parent", async () => {
      const f = physicalFixture(undefined, FIXTURE_RUN_ID);
      const admission = vi.spyOn(f.authority.authority, "resolveCapabilityForDelegation");
      const route = await startNativeReadTransportFixture(f);
      try {
        const identity = await admittedTransportIdentity(route);
        const request = {
          identity,
          ordinal: 1,
          relativePath: "fixture.ts",
          purpose: "native-tool-io",
        };
        const bytes = await route.call("readBytes", request);
        expect(nativeTransportFrame(bytes)).toMatchObject({
          status: "ok",
          bytes: Buffer.from("PRIVATE_PARENT_NATIVE_BYTES"),
        });
        const stat = await route.call("stat", { ...request, ordinal: 2 });
        expect(nativeTransportFrame(stat)).toMatchObject({ status: "ok", info: { type: "file" } });
        const list = await route.call("list", { ...request, ordinal: 3, relativePath: "" });
        expect(nativeTransportFrame(list).info.type).toBe("directory");
        const zero = await route.call("readBytes", {
          ...request,
          ordinal: 4,
          range: { offset: 0, length: 0 },
        });
        expect(nativeTransportFrame(zero).bytes).toHaveLength(0);
        expect(f.process).toHaveBeenCalledTimes(4);
        expect(admission.mock.calls.reduce((n, [input]) => n + input.usage.toolCalls, 0)).toBe(1);
        expect(
          nativeTransportVerdict(
            (await route.call("close", { identity, outcome: "completed" })).body,
          ),
        ).toEqual({ ok: true });
        expect(
          nativeTransportVerdict((await route.call("begin", originalReadTransportBegin())).body).ok,
        ).toBe(false);
        expect(JSON.stringify(f.activity.events)).not.toMatch(
          /PRIVATE_PARENT_NATIVE_BYTES|fixture\.ts/u,
        );
      } finally {
        await stopNativeBridge(f, route.fixture);
      }
    });

    it("retains physical IO through a disconnected HTTP parent and refuses a false completed close", async () => {
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const reached = vi.fn();
      const f = physicalFixture(async (frame) => {
        reached();
        await held;
        return frame;
      }, FIXTURE_RUN_ID);
      const onRelease = vi.fn();
      const route = await startNativeReadTransportFixture(f, { onRelease });
      const identity = await admittedTransportIdentity(route);
      const cancel = new AbortController();
      const reading = route.call(
        "readBytes",
        { identity, ordinal: 1, relativePath: "fixture.ts", purpose: "native-tool-io" },
        cancel.signal,
      );
      try {
        await vi.waitFor(() => {
          expect(reached).toHaveBeenCalledOnce();
        });
        cancel.abort();
        expect(JSON.parse((await reading).body)).toMatchObject({ ok: false });
        expect(
          nativeTransportVerdict(
            (await route.call("close", { identity, outcome: "completed" })).body,
          ),
        ).toEqual({ ok: false });
        expect(onRelease).not.toHaveBeenCalled();
        expect(await route.fixture.runtime.manager.stop(FIXTURE_RUN_ID)).toMatchObject({
          ok: false,
          failureCode: "runtime-reap-unproven",
        });
        release();
        await vi.waitFor(() => {
          expect(f.registry.inspect({ runId: FIXTURE_RUN_ID, ...identity }).kind).toBe("terminal");
        });
        expect(await route.fixture.runtime.manager.reconcile(FIXTURE_RUN_ID)).toMatchObject({
          ok: true,
        });
        expect(onRelease).toHaveBeenCalledOnce();
      } finally {
        release();
        await reading;
        await stopNativeBridge(f, route.fixture);
      }
    });

    it("cannot cancel the active parent with a foreign identity and refuses terminal replay", async () => {
      const f = physicalFixture(undefined, FIXTURE_RUN_ID);
      const route = await startNativeReadTransportFixture(f);
      try {
        const identity = await admittedTransportIdentity(route);
        for (const foreign of [
          { ...identity, invocationId: "0".repeat(32) },
          { ...identity, actionId: "different" },
          { ...identity, idempotencyKey: "different" },
        ]) {
          expect(
            nativeTransportVerdict(
              (await route.call("close", { identity: foreign, outcome: "cancelled" })).body,
            ),
          ).toEqual({ ok: false });
          expect(
            route.fixture.runtime.toolBridge.nativeTextRead?.invocations?.signalFor(identity)
              ?.aborted,
          ).toBe(false);
        }
        expect(
          nativeTransportFrame(
            await route.call("stat", {
              identity,
              ordinal: 1,
              relativePath: "fixture.ts",
              purpose: "native-tool-io",
            }),
          ).status,
        ).toBe("ok");
        expect(
          nativeTransportVerdict(
            (await route.call("close", { identity, outcome: "completed" })).body,
          ),
        ).toEqual({ ok: true });
        expect(
          nativeTransportVerdict((await route.call("close", { identity, outcome: "failed" })).body),
        ).toEqual({ ok: false });
        expect(
          nativeTransportVerdict((await route.call("begin", originalReadTransportBegin())).body).ok,
        ).toBe(false);
        expect(f.process).toHaveBeenCalledOnce();
      } finally {
        await stopNativeBridge(f, route.fixture);
      }
    });

    it.each(["changed", "technical"] as const)(
      "withholds and wipes actual IO when root postflight is %s",
      async (change) => {
        const f = physicalFixture(undefined, FIXTURE_RUN_ID);
        const diagnostics: ServerDiagnosticRecord[] = [];
        let captured: Uint8Array | undefined;
        const observed = observeNativeReadBytes(f, (bytes): void => {
          captured = bytes;
        });
        const route = await startNativeReadTransportFixture(observed, {
          diagnostics: {
            record: (event): void => {
              diagnostics.push(event);
            },
          },
        });
        try {
          const identity = await admittedTransportIdentity(route);
          const accepted = route.root();
          route.root
            .mockImplementationOnce(() => accepted)
            .mockImplementationOnce(() => {
              if (change === "technical") throw new TypeError("PRIVATE_ROOT_POSTFLIGHT_FAILURE");
              return { ...accepted, canonicalRoot: "/changed-root" };
            });
          const result = await route.call("readBytes", {
            identity,
            ordinal: 1,
            relativePath: "fixture.ts",
            purpose: "native-tool-io",
          });
          expect(result.status).toBe(change === "technical" ? 502 : 409);
          expect(result.nativeBytes).toBeUndefined();
          expect(captured).toBeDefined();
          expect(captured?.every((byte) => byte === 0)).toBe(true);
          expect(nativeTransportVerdict(result.body)).toMatchObject({ ok: false });
          expect(f.process).toHaveBeenCalledOnce();
          expect(
            nativeTransportVerdict(
              (await route.call("close", { identity, outcome: "completed" })).body,
            ),
          ).toEqual({ ok: false });
          expect(diagnostics).toHaveLength(change === "technical" ? 1 : 0);
          expect(JSON.stringify({ events: f.activity.events, diagnostics })).not.toMatch(
            /PRIVATE_ROOT_POSTFLIGHT_FAILURE|PRIVATE_PARENT_NATIVE_BYTES|fixture\.ts/u,
          );
        } finally {
          await stopNativeBridge(f, route.fixture);
        }
      },
    );

    it.each(["head", "expired", "withdrawn"] as const)(
      "refuses stale %s authority over HTTP before starting a helper",
      async (change) => {
        const f = physicalFixture(undefined, FIXTURE_RUN_ID);
        const route = await startNativeReadTransportFixture(f);
        try {
          const identity = await admittedTransportIdentity(route);
          if (change === "head") f.readHead.mockReturnValue("2".repeat(40));
          else if (change === "expired")
            vi.setSystemTime(new Date(Date.parse(f.authority.trusted.expiresAt) + 1));
          else f.authority.registry.revoke(f.authority.minted.authorityRef);
          expect(
            nativeTransportVerdict(
              (
                await route.call("readBytes", {
                  identity,
                  ordinal: 1,
                  relativePath: "fixture.ts",
                  purpose: "native-tool-io",
                })
              ).body,
            ).ok,
          ).toBe(false);
          expect(f.process).not.toHaveBeenCalled();
          expect(
            nativeTransportVerdict(
              (await route.call("close", { identity, outcome: "failed" })).body,
            ),
          ).toEqual({ ok: false });
        } finally {
          await stopNativeBridge(f, route.fixture);
        }
      },
    );

    it("refuses copied identities, ordinal replay and sensitive paths without duplicate effects", async () => {
      const f = physicalFixture(undefined, FIXTURE_RUN_ID);
      const route = await startNativeReadTransportFixture(f);
      try {
        const identity = await admittedTransportIdentity(route);
        const request = {
          identity,
          ordinal: 1,
          relativePath: "fixture.ts",
          purpose: "native-tool-io",
        };
        expect(
          nativeTransportVerdict(
            (
              await route.call("stat", {
                ...request,
                identity: { ...identity, invocationId: "0".repeat(32) },
              })
            ).body,
          ).ok,
        ).toBe(false);
        expect(nativeTransportFrame(await route.call("stat", request)).status).toBe("ok");
        expect(nativeTransportVerdict((await route.call("stat", request)).body).ok).toBe(false);
        expect(
          nativeTransportVerdict(
            (await route.call("readBytes", { ...request, ordinal: 2, relativePath: ".env" })).body,
          ).ok,
        ).toBe(false);
        expect(f.process).toHaveBeenCalledOnce();
        expect(
          nativeTransportVerdict((await route.call("close", { identity, outcome: "failed" })).body),
        ).toEqual({ ok: false });
      } finally {
        await stopNativeBridge(f, route.fixture);
      }
    });

    it.each(["head", "expired", "withdrawn"] as const)(
      "refuses private original IO with stale %s authority before the actual child starts",
      async (change) => {
        const f = physicalFixture();
        const fixture = await startBridgeFixture(
          f.facade,
          { maxInFlight: 1, requestDeadlineMs: 1000 },
          f.control,
        );
        try {
          const parent = fixture.runtime.toolBridge.nativeTextRead?.invocations;
          const begun = await parent?.begin(nativeInvocationInput());
          if (begun?.ok !== true || parent?.fileIO === undefined)
            throw new TypeError("Missing native IO");
          if (change === "head") f.readHead.mockReturnValue("2".repeat(40));
          else if (change === "expired")
            vi.setSystemTime(new Date(Date.parse(f.authority.trusted.expiresAt) + 1));
          else f.authority.registry.revoke(f.authority.minted.authorityRef);
          expect(
            (
              await parent.fileIO.readBytes(begun.identity, {
                ordinal: 1,
                relativePath: "fixture.ts",
                purpose: "native-tool-io",
              })
            ).ok,
          ).toBe(false);
          expect(f.process).not.toHaveBeenCalled();
          expect(await parent.close(begun.identity, "failed")).toBe(false);
        } finally {
          await stopNativeBridge(f, fixture);
        }
      },
    );
  },
);

function initialTransportPacket(
  phase: string,
  extra: Readonly<Record<string, unknown>> = {},
): string {
  return JSON.stringify({
    action: "native-initialization",
    phase,
    runId: FIXTURE_RUN_ID,
    ...extra,
  });
}

async function initialTransportFixture(
  effect?: SecureWorkspaceNativeFileIO["readBytes"],
  requestDeadlineMs = 5000,
): Promise<{
  producer: ReturnType<typeof initialBridgeProducer>;
  log: ReturnType<typeof createBufferedServerLogSink>;
  setRoot: (root: string) => void;
  fixture: Awaited<ReturnType<typeof startBridgeFixture>>;
  call: (
    phase: string,
    extra?: Readonly<Record<string, unknown>>,
  ) => ReturnType<OpenCodeRuntimeComposition["toolBridge"]["handle"]>;
}> {
  const producer = initialBridgeProducer(effect);
  const log = createBufferedServerLogSink();
  let currentRoot = producer.runtime.root;
  const fixture = await startBridgeFixture(
    producer.facade,
    { maxInFlight: 1, requestDeadlineMs },
    {
      ...producer.control,
      activityLog: log,
      gatewayUrl: "http://127.0.0.1:4391/api/coding-sidecar/gateway",
      resolveWorkspaceRootAccess: () => ({
        kind: "managed-task",
        canonicalRoot: currentRoot,
        repositoryRoot: producer.runtime.root,
        fs: nodeWorkspaceFs,
      }),
    },
  );
  await fixture.stop();
  const prepared = await fixture.runtime.prepareServiceHost(
    fixture.preparation,
    await preparationReceipt(),
  );
  expect(prepared.ok).toBe(true);
  return {
    producer,
    log,
    setRoot: (root): void => {
      currentRoot = root;
    },
    fixture,
    call: (phase, extra) =>
      fixture.runtime.toolBridge.handle({
        method: "POST",
        headers: new Headers({
          authorization: `Bearer ${producer.runtime.minted.toolFacadeCapability}`,
        }),
        body: initialTransportPacket(phase, extra),
      }),
  };
}

it("binds same-route initial bytes to the actual accepted callback without charging a model tool", async () => {
  const { producer, fixture, call } = await initialTransportFixture();
  try {
    const begin = await call("begin");
    expect(begin.status).toBe(200);
    const value = JSON.parse(begin.body) as { scopeId: string };
    expect(value.scopeId).toBeTypeOf("string");
    const result = await call("readBytes", { scopeId: value.scopeId, relativePath: "AGENTS.md" });
    expect(result.status).toBe(200);
    expect((result as unknown as { nativeBytes?: Uint8Array }).nativeBytes).toBeInstanceOf(
      Uint8Array,
    );
    expect(producer.read).toHaveBeenCalledOnce();
    expect(producer.runtime.authority.state().state).toBe("starting");
    expect(await call("end", { scopeId: value.scopeId })).toMatchObject({ status: 200 });
  } finally {
    await fixture.stop();
    producer.registry.dispose();
  }
});

function optionalRootAccess(control: StartBridgeControl | undefined): {
  readonly resolveWorkspaceRootAccess?: (() => WorkspaceRootAccess | undefined) | undefined;
} {
  return control?.resolveWorkspaceRootAccess === undefined
    ? {}
    : { resolveWorkspaceRootAccess: control.resolveWorkspaceRootAccess };
}

it("persists real transport lifecycle without content, paths or authority bytes", async () => {
  const f = await initialTransportFixture();
  try {
    const started = await f.call("begin");
    const { scopeId } = JSON.parse(started.body) as { scopeId: string };
    await f.call("end", { scopeId });
    const events = f.log.events.filter(
      (event) => event.op === "coding-runtime.initialization-transport",
    );
    expect(events).toHaveLength(2);
    const line = formatActivityLogProofLine(events[0] ?? {});
    expectActivityLogProof("coding-runtime.initialization-transport.emitted-line", line);
    expect(events.map((event) => event.extra?.stage)).toEqual(["begin", "end"]);
    expect(events.map((event) => event.extra?.outcome)).toEqual(["accepted", "completed"]);
    expect(line).not.toContain(f.producer.runtime.root);
    expect(line).not.toContain(scopeId);
    expect(line).not.toContain(f.producer.runtime.minted.toolFacadeCapability);
  } finally {
    await f.fixture.stop();
    f.producer.registry.dispose();
  }
});

it("rejects copied scopes, duplicate begin, extra selectors and calls after initial end", async () => {
  const f = await initialTransportFixture();
  try {
    const started = await f.call("begin");
    const { scopeId } = JSON.parse(started.body) as { scopeId: string };
    expect((await f.call("begin")).status).toBe(409);
    expect(
      (await f.call("readBytes", { scopeId: "0".repeat(36), relativePath: "AGENTS.md" })).status,
    ).toBe(409);
    expect(
      (await f.call("readBytes", { scopeId, relativePath: "AGENTS.md", purpose: "native-tool-io" }))
        .status,
    ).toBe(400);
    expect(f.producer.read).not.toHaveBeenCalled();
    expect((await f.call("end", { scopeId })).status).toBe(200);
    expect((await f.call("readBytes", { scopeId, relativePath: "AGENTS.md" })).status).toBe(409);
    expect((await f.call("begin")).status).toBe(409);
  } finally {
    await f.fixture.stop();
    f.producer.registry.dispose();
  }
});

it("requires actual prepared host and current accepted root before initial callback", async () => {
  const f = initialBridgeProducer();
  const fixture = await startBridgeFixture(f.facade, undefined, f.control);
  try {
    const result = await fixture.runtime.toolBridge.handle({
      method: "POST",
      headers: new Headers({ authorization: `Bearer ${f.runtime.minted.toolFacadeCapability}` }),
      body: initialTransportPacket("begin"),
    });
    expect(result.status).toBe(409);
    expect(f.read).not.toHaveBeenCalled();
  } finally {
    await fixture.stop();
    f.registry.dispose();
  }
});

it("rejects current-root drift before IO and after an outstanding real producer resolves", async () => {
  let release!: (value: Awaited<ReturnType<SecureWorkspaceNativeFileIO["readBytes"]>>) => void;
  const held = new Promise<Awaited<ReturnType<SecureWorkspaceNativeFileIO["readBytes"]>>>(
    (resolve) => {
      release = resolve;
    },
  );
  const f = await initialTransportFixture(() => held);
  try {
    const { scopeId } = JSON.parse((await f.call("begin")).body) as { scopeId: string };
    const pending = f.call("readBytes", { scopeId, relativePath: "AGENTS.md" });
    await vi.waitFor(() => {
      expect(f.producer.read).toHaveBeenCalledOnce();
    });
    f.setRoot(join(f.producer.runtime.root, "changed"));
    release({ ok: true, bytes: f.producer.bytes, info: f.producer.info });
    const result = await pending;
    expect(result.status).toBe(409);
    expect(f.producer.bytes.every((byte) => byte === 0)).toBe(true);
    expect((await f.call("stat", { scopeId, relativePath: "AGENTS.md" })).status).toBe(409);
    expect(f.producer.read).toHaveBeenCalledOnce();
  } finally {
    release({ ok: true, bytes: f.producer.bytes, info: f.producer.info });
    await f.fixture.stop();
    f.producer.registry.dispose();
  }
});

it("removes transport authority when the actual accepted starting mint is revoked", async () => {
  const f = await initialTransportFixture();
  try {
    const { scopeId } = JSON.parse((await f.call("begin")).body) as { scopeId: string };
    f.producer.runtime.authorityRegistry.revoke(f.producer.runtime.minted.authorityRef);
    expect((await f.call("readBytes", { scopeId, relativePath: "AGENTS.md" })).status).toBe(409);
    expect(f.producer.read).not.toHaveBeenCalled();
    expect((await f.call("end", { scopeId })).status).toBe(409);
  } finally {
    await f.fixture.stop();
    f.producer.registry.dispose();
  }
});

it("preserves original technical read failure as an unavailable private result", async () => {
  const f = await initialTransportFixture(() =>
    Promise.resolve({ ok: false, reason: "process-failed" }),
  );
  try {
    const { scopeId } = JSON.parse((await f.call("begin")).body) as { scopeId: string };
    const result = await f.call("readBytes", { scopeId, relativePath: "AGENTS.md" });
    expect(JSON.parse(result.body)).toEqual({ ok: false, reason: "process-failed" });
    expect((await f.call("end", { scopeId })).status).toBe(200);
  } finally {
    await f.fixture.stop();
    f.producer.registry.dispose();
  }
});

it("cancels promptly while holding the SAME physical gate until the actual raw IO settles", async () => {
  let release!: (value: Awaited<ReturnType<SecureWorkspaceNativeFileIO["readBytes"]>>) => void;
  const held = new Promise<Awaited<ReturnType<SecureWorkspaceNativeFileIO["readBytes"]>>>(
    (resolve) => {
      release = resolve;
    },
  );
  const f = await initialTransportFixture(() => held);
  const controller = new AbortController();
  try {
    const { scopeId } = JSON.parse((await f.call("begin")).body) as { scopeId: string };
    const pending = f.fixture.runtime.toolBridge.handle({
      method: "POST",
      headers: new Headers({
        authorization: `Bearer ${f.producer.runtime.minted.toolFacadeCapability}`,
      }),
      body: initialTransportPacket("readBytes", { scopeId, relativePath: "AGENTS.md" }),
      signal: controller.signal,
    });
    await vi.waitFor(() => {
      expect(f.producer.read).toHaveBeenCalledOnce();
    });
    controller.abort();
    expect(JSON.parse((await pending).body)).toMatchObject({ ok: false, reason: "cancelled" });
    const busy = await f.fixture.runtime.toolBridge.handle({
      method: "POST",
      headers: new Headers({
        authorization: `Bearer ${f.producer.runtime.minted.toolFacadeCapability}`,
      }),
      body: "{}",
    });
    expect(busy.status).toBe(429);
    release({ ok: true, bytes: f.producer.bytes, info: f.producer.info });
    await vi.waitFor(async () => {
      expect(
        (
          await f.fixture.runtime.toolBridge.handle({
            method: "POST",
            headers: new Headers({
              authorization: `Bearer ${f.producer.runtime.minted.toolFacadeCapability}`,
            }),
            body: "{}",
          })
        ).status,
      ).not.toBe(429);
    });
    expect(f.producer.bytes.every((byte) => byte === 0)).toBe(true);
  } finally {
    release({ ok: true, bytes: f.producer.bytes, info: f.producer.info });
    await f.fixture.stop();
    f.producer.registry.dispose();
  }
});

it.each(["accessor", "inherited", "symbol", "extra", "nested-accessor"])(
  "captures closed initial packets without evaluating %s input",
  async (kind) => {
    const { copyNativeInitializationPacket } = await import("./opencodeRuntimeComposition.js");
    const value: Record<PropertyKey, unknown> = {
      action: "native-initialization",
      phase: "begin",
      runId: FIXTURE_RUN_ID,
    };
    const get = vi.fn(() => FIXTURE_RUN_ID);
    if (kind === "accessor") Object.defineProperty(value, "runId", { get });
    if (kind === "inherited") Object.setPrototypeOf(value, { inherited: true });
    if (kind === "symbol") value[Symbol("selector")] = true;
    if (kind === "extra") value.authority = "untrusted";
    if (kind === "nested-accessor") {
      value.phase = "readBytes";
      value.scopeId = "0".repeat(36);
      value.relativePath = "AGENTS.md";
      value.range = Object.defineProperty({ length: 1 }, "offset", { get });
    }
    expect(copyNativeInitializationPacket(value)).toBeUndefined();
    expect(get).not.toHaveBeenCalled();
  },
);

it.each(["expired", "ready", "running"] as const)(
  "refuses initial transport when actual accepted authority is %s",
  async (state) => {
    const f = await initialTransportFixture();
    try {
      if (state === "expired")
        vi.setSystemTime(new Date(Date.parse(f.producer.runtime.trusted.expiresAt) + 1));
      else {
        expect(f.producer.runtime.authority.transition(FIXTURE_RUN_ID, "ready", RUNTIME_NOW)).toBe(
          true,
        );
        if (state === "running")
          expect(
            f.producer.runtime.authority.transition(FIXTURE_RUN_ID, "running", RUNTIME_NOW),
          ).toBe(true);
      }
      expect((await f.call("begin")).status).toBe(409);
      expect(f.producer.read).not.toHaveBeenCalled();
    } finally {
      await f.fixture.stop();
      f.producer.registry.dispose();
    }
  },
);

it("refuses an initial begin when the actual accepted root no longer matches preparation", async () => {
  const f = await initialTransportFixture();
  try {
    f.setRoot(join(f.producer.runtime.root, "other"));
    expect((await f.call("begin")).status).toBe(409);
    expect(f.producer.read).not.toHaveBeenCalled();
  } finally {
    await f.fixture.stop();
    f.producer.registry.dispose();
  }
});

it("reports transport deadline while retaining actual outstanding IO and refusing a new scope", async () => {
  let release!: (value: Awaited<ReturnType<SecureWorkspaceNativeFileIO["readBytes"]>>) => void;
  const held = new Promise<Awaited<ReturnType<SecureWorkspaceNativeFileIO["readBytes"]>>>(
    (resolve) => {
      release = resolve;
    },
  );
  const f = await initialTransportFixture(() => held, 100);
  try {
    const { scopeId } = JSON.parse((await f.call("begin")).body) as { scopeId: string };
    const result = await f.call("readBytes", { scopeId, relativePath: "AGENTS.md" });
    expect(JSON.parse(result.body)).toEqual({ ok: false, reason: "timeout" });
    expect((await f.call("begin")).status).toBe(409);
    expect(f.producer.read).toHaveBeenCalledOnce();
    const ordinary = await f.fixture.runtime.toolBridge.handle({
      method: "POST",
      headers: new Headers({
        authorization: `Bearer ${f.producer.runtime.minted.toolFacadeCapability}`,
      }),
      body: "{}",
    });
    expect(ordinary.status).toBe(429);
  } finally {
    release({ ok: true, bytes: f.producer.bytes, info: f.producer.info });
    await f.fixture.stop();
    f.producer.registry.dispose();
  }
});

it("settles initial end honestly when its actual lifecycle writer fails", async () => {
  const f = await initialTransportFixture();
  try {
    const { scopeId } = JSON.parse((await f.call("begin")).body) as { scopeId: string };
    const write = f.log.write.bind(f.log);
    vi.spyOn(f.log, "write").mockImplementation((event) => {
      if (event.op === "coding-runtime.initialization-transport" && event.extra?.stage === "end")
        throw new Error("PRIVATE_INITIAL_END_WRITER_FAILURE");
      write(event);
    });
    const pending = f.call("end", { scopeId });
    let result: Awaited<ReturnType<typeof f.call>> | undefined;
    void pending.then((value) => {
      result = value;
    });
    await vi.waitFor(
      () => {
        expect(result).toBeDefined();
      },
      { timeout: 100 },
    );
    expect(JSON.parse((await pending).body)).toEqual({
      ok: false,
      reason: "initialization-failed",
    });
    expect((await f.call("begin")).status).toBe(409);
    expect(f.log.lines().join("\n")).not.toContain("PRIVATE_INITIAL_END_WRITER_FAILURE");
  } finally {
    await f.fixture.stop();
    f.producer.registry.dispose();
  }
});

function originalReadTransportBody(
  phase: string,
  extra: Readonly<Record<string, unknown>> = {},
): string {
  return JSON.stringify({
    action: "native-read-invocation",
    phase,
    runId: FIXTURE_RUN_ID,
    ...extra,
  });
}

function originalReadTransportBegin(): {
  actionId: string;
  idempotencyKey: string;
  relativePath: string;
  context: CodingToolNativeReadBeginInput["context"];
  runId?: string;
} {
  return {
    actionId: "ses_tool:original-read",
    idempotencyKey: "ses_tool:original-read",
    relativePath: "fixture.ts",
    context: {
      sessionID: "ses_tool",
      messageID: "msg_original",
      id: "original-read",
      agent: "build",
    },
  };
}

it("admits a genuine ready native read parent over the existing HTTP dispatch boundary", async () => {
  const f = nativeBridgeFixture("PRIVATE_PARENT_ROUTE", undefined, 1, false, FIXTURE_RUN_ID);
  const fixture = await startBridgeFixture(
    f.facade,
    { maxInFlight: 1, requestDeadlineMs: 5000 },
    {
      ...f.control,
      resolveWorkspaceRootAccess: () => ({
        kind: "managed-task",
        canonicalRoot: f.authority.root,
        repositoryRoot: f.authority.root,
        fs: nodeWorkspaceFs,
      }),
    },
  );
  const call = (
    phase: string,
    extra: Readonly<Record<string, unknown>>,
  ): ReturnType<OpenCodeRuntimeComposition["toolBridge"]["handle"]> =>
    fixture.runtime.toolBridge.handle({
      method: "POST",
      headers: new Headers({
        authorization: `Bearer ${f.authority.minted.toolFacadeCapability}`,
      }),
      body: originalReadTransportBody(phase, extra),
    });
  try {
    const result = await call("begin", originalReadTransportBegin());
    expect(result.status).toBe(200);
    const { identity } = JSON.parse(result.body) as { identity: Readonly<Record<string, string>> };
    expect(identity).toMatchObject({ actionId: "ses_tool:original-read" });
    expect((await call("close", { identity, outcome: "completed" })).body).toBe('{"ok":true}');
    expect(f.authority.minted.authorityRef.runId).toBe(FIXTURE_RUN_ID);
    expect(JSON.stringify(f.activity.events)).not.toContain("PRIVATE_PARENT_ROUTE");
  } finally {
    await stopNativeBridge(f, fixture);
  }
});

type NativeTransportFixture = Awaited<ReturnType<typeof startNativeReadTransportFixture>>;
async function startNativeReadTransportFixture(
  f: NativeBridgeFixture,
  extra: StartBridgeControl = {},
  deadline = 5000,
): Promise<{
  fixture: Awaited<ReturnType<typeof startBridgeFixture>>;
  root: ReturnType<typeof vi.fn<() => WorkspaceRootAccess>>;
  call: (
    phase: string,
    extra?: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ) => ReturnType<OpenCodeRuntimeComposition["toolBridge"]["handle"]>;
}> {
  const root = vi.fn<() => WorkspaceRootAccess>(() => ({
    kind: "managed-task",
    canonicalRoot: f.authority.root,
    repositoryRoot: f.authority.root,
    fs: nodeWorkspaceFs,
  }));
  const fixture = await startBridgeFixture(
    f.facade,
    { maxInFlight: 1, requestDeadlineMs: deadline },
    { ...f.control, ...extra, resolveWorkspaceRootAccess: root },
  );
  return {
    fixture,
    root,
    call: (phase, extra, signal) =>
      fixture.runtime.toolBridge.handle({
        method: "POST",
        headers: new Headers({
          authorization: `Bearer ${f.authority.minted.toolFacadeCapability}`,
        }),
        body: originalReadTransportBody(phase, extra ?? {}),
        ...(signal === undefined ? {} : { signal }),
      }),
  };
}

async function admittedTransportIdentity(
  route: NativeTransportFixture,
): Promise<CodingToolNativeReadIdentity> {
  const result = await route.call("begin", originalReadTransportBegin());
  expect(result.status).toBe(200);
  const value = JSON.parse(result.body) as { ok: boolean; identity: CodingToolNativeReadIdentity };
  expect(value.ok).toBe(true);
  expect(value.identity.invocationId).toBeTypeOf("string");
  return value.identity;
}

function nativeTransportFrame(
  result: Awaited<ReturnType<OpenCodeRuntimeComposition["toolBridge"]["handle"]>>,
): Extract<ReturnType<typeof decodeSecureWorkspaceNativeResponse>, { status: "ok" }> {
  expect(result.status).toBe(200);
  if (result.nativeBytes === undefined) throw new TypeError("Missing native frame");
  const frame = decodeSecureWorkspaceNativeResponse(result.nativeBytes);
  if (frame.status !== "ok") throw new TypeError("Expected successful native frame");
  return frame;
}

it.each(["session", "unknown-run", "root", "cancelled"] as const)(
  "rejects %s Read transport admission without authority charge",
  async (change) => {
    const f = nativeBridgeFixture("PRIVATE_REFUSED_ADMISSION", undefined, 1, false, FIXTURE_RUN_ID);
    const charge = vi.spyOn(f.authority.authority, "resolveCapabilityForDelegation");
    const route = await startNativeReadTransportFixture(f);
    const packet = originalReadTransportBegin();
    const cancelled = new AbortController();
    if (change === "session") packet.context = { ...packet.context, sessionID: "other-session" };
    if (change === "unknown-run") packet.runId = "not-the-accepted-run";
    if (change === "root")
      route.root.mockReturnValue({
        kind: "managed-task",
        canonicalRoot: "/not-accepted",
        repositoryRoot: f.authority.root,
        fs: nodeWorkspaceFs,
      });
    if (change === "cancelled") cancelled.abort();
    try {
      expect(
        nativeTransportVerdict((await route.call("begin", packet, cancelled.signal)).body).ok,
      ).toBe(false);
      expect(charge).not.toHaveBeenCalled();
      expect(f.process).not.toHaveBeenCalled();
    } finally {
      await stopNativeBridge(f, route.fixture);
    }
  },
);

it("keeps native Read unavailable in a genuinely prepared STARTING service host", async () => {
  const f = await initialTransportFixture();
  try {
    const response = await f.fixture.runtime.toolBridge.handle({
      method: "POST",
      headers: new Headers({
        authorization: `Bearer ${f.producer.runtime.minted.toolFacadeCapability}`,
      }),
      body: originalReadTransportBody("begin", originalReadTransportBegin()),
    });
    expect(JSON.parse(response.body)).toMatchObject({ ok: false, reason: "dispatch-refused" });
    expect(f.producer.read).not.toHaveBeenCalled();
  } finally {
    await f.fixture.stop();
    f.producer.registry.dispose();
  }
});

it("does not return a parent admitted while the accepted root changed across await", async () => {
  const f = nativeBridgeFixture("PRIVATE_POSTAWAIT_ROOT", undefined, 1, false, FIXTURE_RUN_ID);
  const owned = f.facade.nativeTextRead;
  const original = owned?.invocations;
  if (owned === undefined || original === undefined)
    throw new TypeError("Missing actual native facet");
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reached = vi.fn();
  const begin = original.begin;
  const facade = {
    ...f.facade,
    nativeTextRead: {
      ...owned,
      invocations: {
        ...original,
        begin: async (
          input: CodingToolNativeReadBeginInput,
        ): Promise<Awaited<ReturnType<typeof begin>>> => {
          const result = await begin(input);
          reached();
          await held;
          return result;
        },
      },
    },
  };
  const route = await startNativeReadTransportFixture({ ...f, facade });
  const pending = route.call("begin", originalReadTransportBegin());
  try {
    await vi.waitFor(() => {
      expect(reached).toHaveBeenCalledOnce();
    });
    route.root.mockReturnValue({
      kind: "managed-task",
      canonicalRoot: "/changed-after-admission",
      repositoryRoot: f.authority.root,
      fs: nodeWorkspaceFs,
    });
    release();
    expect(JSON.parse((await pending).body)).toEqual({ ok: false, reason: "dispatch-refused" });
    expect(await route.fixture.runtime.manager.stop(FIXTURE_RUN_ID)).toMatchObject({ ok: true });
    expect(f.process).not.toHaveBeenCalled();
  } finally {
    release();
    await pending;
    await stopNativeBridge(f, route.fixture);
  }
});

it.each([
  "accessor",
  "inherited",
  "symbol",
  "extra",
  "context-accessor",
  "context-extra",
  "range-stat",
] as const)("captures Read transport data without trusting %s fields", async (kind) => {
  const { copyNativeReadTransportPacket } = await import("./opencodeRuntimeComposition.js");
  const getter = vi.fn(() => "PRIVATE_ACCESSOR");
  const packet: Record<string | symbol, unknown> = JSON.parse(
    originalReadTransportBody("begin", originalReadTransportBegin()),
  ) as Record<string, unknown>;
  if (kind === "accessor") Object.defineProperty(packet, "actionId", { get: getter });
  if (kind === "inherited") Object.setPrototypeOf(packet, { authority: "not-owned" });
  if (kind === "symbol") packet[Symbol("authority")] = "not-owned";
  if (kind === "extra") packet.workspaceRoot = "/not-owned";
  if (kind === "context-accessor")
    Object.defineProperty(packet.context, "sessionID", { get: getter });
  if (kind === "context-extra")
    packet.context = { ...(packet.context as object), guard: "not-owned" };
  if (kind === "range-stat") {
    Object.assign(packet, {
      phase: "stat",
      identity: { actionId: "a", idempotencyKey: "a", invocationId: "b" },
      ordinal: 1,
      purpose: "native-tool-io",
      range: { offset: 0, length: 1 },
    });
    delete packet.actionId;
    delete packet.idempotencyKey;
    delete packet.context;
  }
  expect(copyNativeReadTransportPacket(packet)).toBeUndefined();
  expect(getter).not.toHaveBeenCalled();
});

function nativeTransportVerdict(body: string): { readonly ok: boolean } {
  return JSON.parse(body) as { readonly ok: boolean };
}

it("logs technical root acquisition failure and starts no canonical Read effect", async () => {
  const f = nativeBridgeFixture("PRIVATE_ROOT_ACQUISITION", undefined, 1, false, FIXTURE_RUN_ID);
  const charge = vi.spyOn(f.authority.authority, "resolveCapabilityForDelegation");
  const diagnostics: ServerDiagnosticRecord[] = [];
  const route = await startNativeReadTransportFixture(f, {
    diagnostics: {
      record: (event): void => {
        diagnostics.push(event);
      },
    },
  });
  route.root.mockImplementationOnce(() => {
    throw new TypeError("PRIVATE_ROOT_ACQUISITION_FAILURE");
  });
  try {
    const result = await route.call("begin", originalReadTransportBegin());
    expect(result.status).toBe(502);
    expect(nativeTransportVerdict(result.body)).toMatchObject({ ok: false });
    expect(charge).not.toHaveBeenCalled();
    expect(f.process).not.toHaveBeenCalled();
    expect(diagnostics).toHaveLength(1);
    expect(JSON.stringify(diagnostics)).not.toContain("PRIVATE_ROOT_ACQUISITION_FAILURE");
  } finally {
    await stopNativeBridge(f, route.fixture);
  }
});

function observeNativeReadBytes(
  f: NativeBridgeFixture,
  captured: (bytes: Uint8Array) => void,
): NativeBridgeFixture {
  const selected = f.facade.nativeTextRead;
  const parent = selected?.invocations;
  const io = parent?.fileIO;
  if (selected === undefined || parent === undefined || io === undefined)
    throw new TypeError("Missing actual native file producer");
  return {
    ...f,
    facade: {
      ...f.facade,
      nativeTextRead: {
        ...selected,
        invocations: {
          ...parent,
          fileIO: {
            ...io,
            readBytes: async (identity, input): ReturnType<typeof io.readBytes> => {
              const result = await io.readBytes(identity, input);
              if (result.ok) captured(result.bytes);
              return result;
            },
          },
        },
      },
    },
  };
}

// S02/S03 (#3904, ADR-0137 D10): the run that continues a task's retained session. The composition
// seeds the run's private database from the task's entry before the runtime starts, binds the
// started runtime to the retained (or forked) session, proves the gateway route in a scratch
// session, shows only what the run adds, and retains the database of a run that settled normally.
describe("native session continuity in the composition", () => {
  const TASK = "task-continued";

  interface StoreCalls {
    readonly checkouts: Parameters<RetainedSessionStore["checkout"]>[0][];
    readonly retains: Parameters<RetainedSessionStore["retain"]>[0][];
    readonly removed: string[];
    readonly seededDirectoryExisted: boolean[];
  }

  function continuedWorld(
    options: {
      sessions?: string[];
      retainedSessionId?: string;
      checkout?: ReturnType<RetainedSessionStore["checkout"]>;
      retain?: ReturnType<RetainedSessionStore["retain"]>;
      messages?: readonly Record<string, unknown>[];
      forkedSessionId?: string;
      /** False leaves every session route to the fixture's own, as for a run that continues nothing. */
      serveSessions?: boolean;
      listFails?: boolean;
    } = {},
  ): { readonly continuity: FixtureContinuity; readonly calls: StoreCalls } {
    const calls: StoreCalls = {
      checkouts: [],
      retains: [],
      removed: [],
      seededDirectoryExisted: [],
    };
    const store: RetainedSessionStore = {
      checkout: (input) => {
        calls.checkouts.push(input);
        calls.seededDirectoryExisted.push(existsSync(dirname(input.destinationDatabase)));
        return (
          options.checkout ?? {
            ok: true,
            sessionId: options.retainedSessionId ?? "ses_tool",
            databaseBytes: 4096,
            messageCount: 4,
            ageMs: 60_000,
          }
        );
      },
      retain: (input) => {
        calls.retains.push(input);
        return (
          options.retain ?? {
            ok: true,
            databaseBytes: 4096,
            messageCount: 6,
            entryCount: 1,
            prunedCount: 0,
          }
        );
      },
      remove: (taskId) => {
        calls.removed.push(taskId);
      },
      prune: () => ({ expired: 0, orphaned: 0, invalid: 0, quota: 0, entryCount: 0 }),
    };
    const service = createCodingSessionContinuity({
      store,
      taskOfRun: (runId) => (runId === FIXTURE_RUN_ID ? TASK : undefined),
    });
    return {
      calls,
      continuity: {
        service,
        workspaceId: "workspace-continued",
        serveSessions: options.serveSessions ?? true,
        sessions: options.sessions ?? [options.retainedSessionId ?? "ses_tool"],
        // Messages of an earlier run that the history projection could not even parse: if the run
        // projected them it would fail its readiness, so a started run proves they were left out.
        messages: options.messages ?? [
          { id: "msg_earlier_1", type: "earlier-run-user-turn" },
          { id: "msg_earlier_2", type: "earlier-run-answer" },
        ],
        requests: [],
        ...(options.listFails === true ? { listFails: true } : {}),
        ...(options.forkedSessionId === undefined
          ? {}
          : { forkedSessionId: options.forkedSessionId }),
      },
    };
  }

  function continuityLines(
    log: ReturnType<typeof createBufferedServerLogSink>,
  ): Record<string, unknown>[] {
    return log.events
      .filter((event) => event.op === "coding-runtime.session-continuity")
      .map((event) => ({ ...event, ...(event.extra as Record<string, unknown>) }));
  }

  const native = { readToolProfile: (): "native" => "native" } as const;
  const facade = (): CodingToolFacade => ({
    execute: () => Promise.resolve({ status: "observed", evidence: [] }),
  });

  it("resumes the retained session: seeded before the start, proved in a scratch session, shown from what the run adds", async () => {
    const activityLog = createBufferedServerLogSink();
    const governedEvents: OpenCodeReconciliationEvent[] = [];
    const world = continuedWorld();
    world.continuity.service.declare(FIXTURE_RUN_ID, { kind: "resume", taskId: TASK });

    const fixture = await startBridgeFixture(facade(), undefined, {
      ...native,
      continuity: world.continuity,
      activityLog,
      governedEvents,
    });
    try {
      // Seeded into the run's own private state, after that state exists and before the runtime ran.
      expect(world.calls.checkouts).toHaveLength(1);
      const [checkout] = world.calls.checkouts;
      expect(
        checkout?.destinationDatabase.endsWith(join(FIXTURE_RUN_ID, "state", "opencode.db")),
      ).toBe(true);
      expect(world.calls.seededDirectoryExisted).toEqual([true]);
      expect(checkout?.binding).toMatchObject({
        taskId: TASK,
        runtimeVersion: OPENCODE_VERSION,
        maxInputTokens: 61_440,
      });
      expect(checkout?.directory).toBe(fixture.preparation.env.KEIKO_CODING_WORKSPACE_ROOT);

      // The handshake runs in a scratch session that is removed again: the run holds one session,
      // no new session was created for the work, and the continued one carries no handshake turn.
      expect(world.continuity.requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
        "POST /api/session",
        "DELETE /api/session/ses_scratch_1",
      ]);
      expect(world.continuity.sessions).toEqual(["ses_tool"]);

      // Only the readiness creation event: the earlier run's messages were never projected.
      expect(governedEvents).toHaveLength(1);

      expect(world.continuity.service.outcome(FIXTURE_RUN_ID)).toEqual({ kind: "resumed" });
      const [line] = continuityLines(activityLog);
      expect(line).toMatchObject({
        action: "resume",
        outcome: "resumed",
        taskDigest: retainedSessionKey(TASK),
        databaseBytes: 4096,
        messageCount: 2,
        ageMs: 60_000,
        correlationId: FIXTURE_RUN_ID,
      });
      const written = activityLog.events.find(
        (event) => event.op === "coding-runtime.session-continuity",
      );
      expectActivityLogProof(
        "coding-runtime.session-continuity.emitted-line",
        formatActivityLogProofLine(written ?? {}),
      );
    } finally {
      await fixture.stop();
    }
  });

  it("forks the retained session through its end and removes the source from the run's database", async () => {
    const activityLog = createBufferedServerLogSink();
    const world = continuedWorld({ retainedSessionId: "ses_source", forkedSessionId: "ses_tool" });
    world.continuity.service.declare(FIXTURE_RUN_ID, {
      kind: "fork",
      sourceTaskId: "task-source",
      boundary: { kind: "end" },
    });

    const fixture = await startBridgeFixture(facade(), undefined, {
      ...native,
      continuity: world.continuity,
      activityLog,
    });
    try {
      expect(world.calls.checkouts[0]?.binding.taskId).toBe("task-source");
      expect(
        world.continuity.requests.slice(0, 2).map(({ method, path }) => `${method} ${path}`),
      ).toEqual(["POST /api/session/ses_source/fork", "DELETE /api/session/ses_source"]);
      expect(world.continuity.requests[0]?.body).toBe("{}");
      expect(world.continuity.sessions).toEqual(["ses_tool"]);
      expect(world.continuity.service.outcome(FIXTURE_RUN_ID)).toEqual({ kind: "forked" });
      expect(continuityLines(activityLog)).toMatchObject([
        {
          action: "fork",
          outcome: "forked",
          boundary: "end",
          taskDigest: retainedSessionKey(TASK),
          sourceTaskDigest: retainedSessionKey("task-source"),
        },
      ]);
    } finally {
      await fixture.stop();
    }
  });

  it("starts a fresh session with the task's history when the entry is refused, and says why", async () => {
    const activityLog = createBufferedServerLogSink();
    const sessionCreateCalls: string[] = [];
    const world = continuedWorld({
      checkout: { ok: false, reason: "version-changed", removed: true },
      serveSessions: false,
    });
    world.continuity.service.declare(FIXTURE_RUN_ID, { kind: "resume", taskId: TASK });

    const fixture = await startBridgeFixture(facade(), undefined, {
      ...native,
      continuity: world.continuity,
      activityLog,
      sessionCreateCalls,
    });
    try {
      // The fixture's own routes answered: a new session was created, as for any fresh run.
      expect(sessionCreateCalls).toEqual(["ses_tool"]);
      expect(world.continuity.requests).toEqual([]);
      expect(world.continuity.service.outcome(FIXTURE_RUN_ID)).toEqual({
        kind: "fresh",
        reason: "version-changed",
      });
      expect(continuityLines(activityLog)).toMatchObject([
        { action: "resume", outcome: "refused", reason: "version-changed", level: "warn" },
      ]);
    } finally {
      await fixture.stop();
    }
  });

  it("fails the run's readiness when the runtime does not hold exactly the retained session", async () => {
    const activityLog = createBufferedServerLogSink();
    const world = continuedWorld({ sessions: ["ses_tool", "ses_unexpected"] });
    world.continuity.service.declare(FIXTURE_RUN_ID, { kind: "resume", taskId: TASK });
    const diagnostics = { record: vi.fn<(record: ServerDiagnosticRecord) => void>() };

    const fixture = await startBridgeFixture(facade(), undefined, {
      ...native,
      continuity: world.continuity,
      activityLog,
      diagnostics,
      expectedStart: { ok: false, failureCode: "protocol-schema-mismatch", retryable: false },
    });

    // The failed binding, then the disposal of the run that never started: it retains nothing.
    expect(continuityLines(activityLog)).toMatchObject([
      { action: "resume", outcome: "failed", reason: "session-mismatch" },
      { action: "retain", outcome: "skipped", reason: "not-succeeded" },
    ]);
    // An entry the runtime does not see the way its manifest says is never used again.
    expect(world.calls.removed).toContain(TASK);
    expect(fixture.runtime.manager.health().status).toBe("stopped");
  });

  it("records a runtime that cannot be asked for its sessions with its error and fails the readiness", async () => {
    const activityLog = createBufferedServerLogSink();
    const world = continuedWorld({ listFails: true });
    world.continuity.service.declare(FIXTURE_RUN_ID, { kind: "resume", taskId: TASK });

    const fixture = await startBridgeFixture(facade(), undefined, {
      ...native,
      continuity: world.continuity,
      activityLog,
      expectedStart: { ok: false, failureCode: "protocol-schema-mismatch", retryable: false },
    });

    // Not a mismatch the retained entry caused, so the line carries the failure's frames.
    const [failed] = continuityLines(activityLog);
    expect(failed).toMatchObject({
      action: "resume",
      outcome: "failed",
      reason: "session-mismatch",
    });
    expect(Array.isArray(failed?.frames)).toBe(true);
    expect(fixture.runtime.manager.health().status).toBe("stopped");
  });

  it("retains the database of a run that succeeded, and only of one that did", async () => {
    const activityLog = createBufferedServerLogSink();
    const world = continuedWorld();
    world.continuity.service.declare(FIXTURE_RUN_ID, { kind: "resume", taskId: TASK });
    const fixture = await startBridgeFixture(facade(), undefined, {
      ...native,
      continuity: world.continuity,
      activityLog,
    });
    const database = world.calls.checkouts[0]?.destinationDatabase ?? "";

    await fixture.runtime.manager.stop(FIXTURE_RUN_ID, "succeeded");

    expect(world.calls.retains).toHaveLength(1);
    expect(world.calls.retains[0]).toMatchObject({
      binding: { taskId: TASK, runtimeVersion: OPENCODE_VERSION },
      sessionId: "ses_tool",
      sourceDatabase: database,
    });
    expect(world.calls.removed).toEqual([]);
    expect(continuityLines(activityLog).at(-1)).toMatchObject({
      action: "retain",
      outcome: "retained",
      taskDigest: retainedSessionKey(TASK),
      databaseBytes: 4096,
      messageCount: 6,
    });
  });

  it.each(["failed", "cancelled"] as const)(
    "removes the task's entry instead of retaining when the run ended %s",
    async (status) => {
      const activityLog = createBufferedServerLogSink();
      const world = continuedWorld();
      world.continuity.service.declare(FIXTURE_RUN_ID, { kind: "resume", taskId: TASK });
      const fixture = await startBridgeFixture(facade(), undefined, {
        ...native,
        continuity: world.continuity,
        activityLog,
      });

      await fixture.runtime.manager.stop(FIXTURE_RUN_ID, status);

      expect(world.calls.retains).toEqual([]);
      expect(world.calls.removed).toEqual([TASK]);
      expect(continuityLines(activityLog).at(-1)).toMatchObject({
        action: "retain",
        outcome: "skipped",
        reason: "not-succeeded",
      });
    },
  );

  it("retains the database of a run that continued nothing, so the next run of its task can resume it", async () => {
    const world = continuedWorld({ serveSessions: false });
    const fixture = await startBridgeFixture(facade(), undefined, {
      ...native,
      continuity: world.continuity,
    });

    await fixture.runtime.manager.stop(FIXTURE_RUN_ID, "succeeded");

    expect(world.calls.checkouts).toEqual([]);
    expect(world.calls.retains).toMatchObject([
      { binding: { taskId: TASK }, sessionId: "ses_tool" },
    ]);
  });

  it("keeps a mapped tool profile on a fresh session and retains nothing", async () => {
    const activityLog = createBufferedServerLogSink();
    const world = continuedWorld({ serveSessions: false });
    world.continuity.service.declare(FIXTURE_RUN_ID, { kind: "resume", taskId: TASK });
    const fixture = await startBridgeFixture(facade(), undefined, {
      continuity: world.continuity,
      activityLog,
    });

    await fixture.runtime.manager.stop(FIXTURE_RUN_ID, "succeeded");

    expect(world.calls.checkouts).toEqual([]);
    expect(world.calls.retains).toEqual([]);
    expect(world.continuity.service.outcome(FIXTURE_RUN_ID)).toEqual({
      kind: "fresh",
      reason: "not-native-profile",
    });
    expect(continuityLines(activityLog).map((line) => line.reason)).toEqual([
      "not-native-profile",
      "not-native-profile",
    ]);
  });
});
