import { createHash, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { Socket } from "node:net";
import { join } from "node:path";

import type { UpdatePortableTarget } from "@oscharko-dev/keiko-contracts";

import type { PortableSidecarRuntimeVerification } from "../update-portable-sidecar-verification.js";
import {
  createCodingRuntimeManager,
  type CodingRuntimeManager,
  type CodingRuntimeManagerDeps,
  type OpenCodeLifecycleAdapter,
  type OpenCodeLifecycleHandshakeRequest,
  type OpenCodeLifecyclePrepareRequest,
  type OpenCodeLifecyclePrepareResult,
} from "./codingRuntimeManager.js";
import { CODING_TOOL_MAX_BODY_BYTES, CODING_TOOL_MAX_IN_FLIGHT } from "./codingToolIpc.js";
import type { CodingToolFacade } from "./codingToolFacadePorts.js";
import {
  createOpenCodeHttpClient,
  type OpenCodeHttpClient,
  type OpenCodeQuestionRequest,
  parseOpenCodeChildEndpoint,
} from "./opencodeHttpClient.js";
import { buildOpenCodeLaunchProfile } from "./opencodeLaunchProfile.js";
import {
  createGeneratedOpenCodeBundle,
  createOpenCodeRuntimeAdapter,
  type OpenCodeGovernedSinkReceipt,
  type OpenCodeRuntimeAdapter,
  type OpenCodeSyncHint,
} from "./opencodeRuntimeAdapter.js";
import { classifyOpenCodeLiveControl, parseOpenCodeHistory } from "./opencodeProtocol.js";
import {
  OPEN_CODE_PROTOCOL_SURFACE_ALGORITHM,
  projectOpenCodeProtocolSurface,
} from "./opencodeProtocolSurface.js";
import type { OpenCodeReconciliationEvent } from "./opencodeReconciler.js";
import type { RuntimeProcessSupervisor } from "./runtimeProcessSupervisor.js";

const PINNED_VERSION = "1.17.17";
const PINNED_RAW_SCHEMA_SHA256 = "7db5cc3bb494b4757655110f2f285b1e70fa586fb5ae2327ffb31d4f0254c7de";
const DIGEST = /^[a-f0-9]{64}$/u;
const ABORT_SETTLEMENT_TIMEOUT_MS = 30_000;

interface VerifiedPortableInput {
  readonly verification: PortableSidecarRuntimeVerification;
  readonly resourceRoot: string;
  readonly target: UpdatePortableTarget;
}

export interface OpenCodeRuntimeCompositionInput {
  readonly portable: VerifiedPortableInput;
  readonly stateBaseRoot: string;
  readonly capabilities: {
    readonly modelGatewayCapability: string;
    readonly toolFacadeCapability: string;
  };
  readonly toolBridge?: {
    readonly requestDeadlineMs: number;
    readonly maxInFlight: number;
  };
  readonly toolFacade: CodingToolFacade;
  readonly governedEventSink: {
    readonly execute: (
      identityKey: string,
      event: OpenCodeReconciliationEvent,
    ) => Promise<OpenCodeGovernedSinkReceipt>;
  };
  readonly gatewayReadiness: {
    readonly waitForObservedRequest: (runId: string, signal: AbortSignal) => Promise<boolean>;
    readonly clear: (runId: string) => void;
  };
  readonly fetch: typeof globalThis.fetch;
  readonly supervisor: RuntimeProcessSupervisor;
  readonly authorityLifecycle: Pick<
    CodingRuntimeManagerDeps,
    | "revokeRuntime"
    | "abortInFlightActions"
    | "markRuntimeRecoveryRequired"
    | "releaseRuntimeAfterReap"
  >;
}

export interface OpenCodeToolBridge {
  readonly url: string;
  handle(input: {
    readonly method: "POST";
    readonly headers: Headers;
    readonly body: string;
  }): Promise<{ readonly status: number; readonly body: string }>;
}

export interface OpenCodeRuntimeComposition {
  readonly manager: CodingRuntimeManager;
  readonly toolBridge: OpenCodeToolBridge;
  readonly runPort: OpenCodeRunPort;
}

export interface OpenCodeRunPort {
  readonly submitTask: (runId: string, text: string) => Promise<boolean>;
  readonly abortTask: (runId: string) => Promise<boolean>;
  readonly waitForTerminal: (runId: string, signal: AbortSignal) => Promise<boolean>;
  readonly listQuestions: (runId: string) => Promise<readonly OpenCodeQuestionRequest[]>;
  readonly answerQuestion: (
    runId: string,
    requestId: string,
    answers: readonly (readonly string[])[],
  ) => Promise<boolean>;
  readonly rejectQuestion: (runId: string, requestId: string) => Promise<boolean>;
}

interface PreparedRun {
  readonly runId: string;
  readonly runRoot: string;
  readonly password: string;
  readonly configDigest: string;
  readonly verification: PortableSidecarRuntimeVerification;
  runtimeAdapter?: OpenCodeRuntimeAdapter | undefined;
  client?: OpenCodeHttpClient | undefined;
  sessionId?: string | undefined;
  ready: boolean;
}

interface ReadyRun extends PreparedRun {
  runtimeAdapter: OpenCodeRuntimeAdapter;
  client: OpenCodeHttpClient;
  sessionId: string;
  ready: true;
}
type ReadyRunLookup = (runId: string) => ReadyRun | undefined;
type QuestionRunPort = Pick<OpenCodeRunPort, "listQuestions" | "answerQuestion" | "rejectQuestion">;

export function createOpenCodeRuntimeComposition(
  input: OpenCodeRuntimeCompositionInput,
): OpenCodeRuntimeComposition {
  const bridge = createToolBridge(
    input.capabilities.toolFacadeCapability,
    input.toolFacade,
    input.toolBridge,
  );
  const runs = new Map<string, PreparedRun>();
  const lifecycle = lifecycleAdapter(input, bridge, runs);
  const manager = createCodingRuntimeManager({
    supervisor: input.supervisor,
    processEnv: {},
    openCodeLifecycleAdapter: lifecycle,
    portableRuntimeResolver: () => input.portable,
    ...input.authorityLifecycle,
  });
  return { manager, toolBridge: bridge.publicPort, runPort: createRunPort(runs) };
}

function createRunPort(runs: Map<string, PreparedRun>): OpenCodeRunPort {
  const readyRun = (runId: string): ReadyRun | undefined => {
    const run = runs.get(runId);
    return isReadyRun(run) ? run : undefined;
  };
  return {
    submitTask: async (runId, text): Promise<boolean> => {
      const run = readyRun(runId);
      if (!run?.runtimeAdapter.armTurn()) return false;
      try {
        await run.client.promptAsync(run.sessionId, text);
        return run.ready;
      } catch {
        run.runtimeAdapter.cancelTurn();
        return false;
      }
    },
    abortTask: createAbortTask(readyRun),
    waitForTerminal: (runId, signal): Promise<boolean> => {
      const run = readyRun(runId);
      return run?.runtimeAdapter.waitForTerminal(signal) ?? Promise.resolve(false);
    },
    ...createQuestionRunPort(readyRun),
  };
}

function createAbortTask(readyRun: ReadyRunLookup): OpenCodeRunPort["abortTask"] {
  return async (runId): Promise<boolean> => {
    const run = readyRun(runId);
    if (run === undefined) return false;
    try {
      if (!(await run.client.abortSession(run.sessionId))) {
        run.runtimeAdapter.cancelTurn();
        return false;
      }
      const settled = await run.runtimeAdapter.waitForTerminal(
        AbortSignal.timeout(ABORT_SETTLEMENT_TIMEOUT_MS),
      );
      if (!settled) run.runtimeAdapter.cancelTurn();
      return settled && run.ready;
    } catch {
      run.runtimeAdapter.cancelTurn();
      return false;
    }
  };
}

function createQuestionRunPort(readyRun: ReadyRunLookup): QuestionRunPort {
  return {
    listQuestions: async (runId): Promise<readonly OpenCodeQuestionRequest[]> => {
      const run = readyRun(runId);
      if (run === undefined) return [];
      try {
        return (await run.client.listQuestions()).filter(
          (request) => request.sessionID === run.sessionId,
        );
      } catch {
        return [];
      }
    },
    answerQuestion: async (runId, requestId, answers): Promise<boolean> => {
      const run = readyRun(runId);
      if (run === undefined) return false;
      try {
        const pending = (await run.client.listQuestions()).find(
          (request) => request.id === requestId && request.sessionID === run.sessionId,
        );
        if (pending === undefined || !answersMatchQuestions(pending, answers)) return false;
        return (await run.client.answerQuestion(requestId, answers)) && run.ready;
      } catch {
        return false;
      }
    },
    rejectQuestion: async (runId, requestId): Promise<boolean> => {
      const run = readyRun(runId);
      if (run === undefined) return false;
      try {
        const owned = (await run.client.listQuestions()).some(
          (request) => request.id === requestId && request.sessionID === run.sessionId,
        );
        return owned && (await run.client.rejectQuestion(requestId)) && run.ready;
      } catch {
        return false;
      }
    },
  };
}

function answersMatchQuestions(
  request: OpenCodeQuestionRequest,
  answers: readonly (readonly string[])[],
): boolean {
  if (answers.length !== request.questions.length) return false;
  return answers.every((answer, index) => {
    const question = request.questions[index];
    if (question === undefined || (question.multiple !== true && answer.length > 1)) return false;
    const labels = new Set(question.options.map((option) => option.label));
    return answer.every((selection) => question.custom === true || labels.has(selection));
  });
}

function isReadyRun(run: PreparedRun | undefined): run is ReadyRun {
  return (
    run?.ready === true &&
    run.client !== undefined &&
    run.runtimeAdapter !== undefined &&
    run.sessionId !== undefined
  );
}

function lifecycleAdapter(
  input: OpenCodeRuntimeCompositionInput,
  bridge: ToolBridgeController,
  runs: Map<string, PreparedRun>,
): OpenCodeLifecycleAdapter {
  return {
    prepare: (request) => prepare(input, bridge, runs, request),
    handshake: (request) => handshake(input, bridge, runs, request),
    monitor: ({ runId, onFailure }): (() => void) | undefined => {
      const run = runs.get(runId);
      const dispose = run?.runtimeAdapter?.monitor(onFailure);
      return dispose === undefined
        ? undefined
        : (): void => {
            if (run !== undefined) run.ready = false;
            dispose();
          };
    },
    dispose: async (runId): Promise<boolean> => {
      const run = runs.get(runId);
      if (run === undefined) return true;
      run.ready = false;
      input.gatewayReadiness.clear(runId);
      await run.runtimeAdapter?.close();
      await bridge.close();
      rmSync(run.runRoot, { recursive: true, force: true });
      runs.delete(runId);
      return true;
    },
  };
}

async function prepare(
  input: OpenCodeRuntimeCompositionInput,
  bridge: ToolBridgeController,
  runs: Map<string, PreparedRun>,
  request: OpenCodeLifecyclePrepareRequest,
): Promise<OpenCodeLifecyclePrepareResult> {
  if (!verifiedProtocol(request.verification, input.portable.verification)) {
    return { ok: false, reason: "target-attestation-failed" };
  }
  if (!distinctCapabilities(input.capabilities)) {
    return { ok: false, reason: "capability-binding-failed" };
  }
  const runRoot = join(input.stateBaseRoot, request.runId);
  try {
    createPrivateState(runRoot);
    await bridge.start();
    const profile = buildOpenCodeLaunchProfile({
      executable: request.executablePath,
      stateRoot: runRoot,
    });
    if (!profile.ok) throw new Error("profile-invalid");
    const bundle = createGeneratedOpenCodeBundle();
    const config = JSON.stringify(bundle.config);
    materialize(runRoot, config, bundle.toolSources);
    const password = profile.env.OPENCODE_SERVER_PASSWORD;
    if (password === undefined) throw new Error("password-missing");
    const configDigest = createHash("sha256").update(config, "utf8").digest("hex");
    runs.set(request.runId, {
      runId: request.runId,
      runRoot,
      password,
      configDigest,
      verification: request.verification,
      ready: false,
    });
    return {
      ok: true,
      env: {
        ...profile.env,
        KEIKO_MODEL_GATEWAY_CAPABILITY: input.capabilities.modelGatewayCapability,
        KEIKO_TOOL_FACADE_URL: bridge.publicPort.url,
        KEIKO_TOOL_FACADE_CAPABILITY: input.capabilities.toolFacadeCapability,
      },
    };
  } catch {
    await bridge.close();
    rmSync(runRoot, { recursive: true, force: true });
    return { ok: false, reason: "config-materialization-failed" };
  }
}

// eslint-disable-next-line max-lines-per-function -- handshake keeps attested client/adapter binding atomic.
async function handshake(
  input: OpenCodeRuntimeCompositionInput,
  bridge: ToolBridgeController,
  runs: Map<string, PreparedRun>,
  request: OpenCodeLifecycleHandshakeRequest,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }> {
  const run = runs.get(request.runId);
  if (run === undefined) return { ok: false, reason: "preparation-missing" };
  try {
    const parsed = parseOpenCodeChildEndpoint(await request.startupOutput.nextLine(request.signal));
    if (!parsed.ok) return { ok: false, reason: "endpoint-invalid" };
    const client = createOpenCodeHttpClient({
      endpoint: parsed.endpoint,
      password: run.password,
      fetch: input.fetch,
      requestTimeoutMs: request.timeoutMs,
      eventIdleTimeoutMs: request.timeoutMs,
    });
    const adapter = createOpenCodeRuntimeAdapter({
      readiness: readinessPorts(input, bridge, run, client, parsed.endpoint, request),
      governedSink: input.governedEventSink,
      control: {
        status: async (sessionId, signal) => {
          const status = (await client.sessionStatuses({ signal }))[sessionId];
          return status === undefined || status.type === "idle" ? "terminal" : "activity";
        },
      },
      safety: {
        revokeAudiences: (): void => undefined,
        abortGovernedActions: (): void => undefined,
        wipeEphemeralState: (): void => undefined,
        requireManagerReap: (): void => undefined,
      },
    });
    const result = await adapter.start();
    if (!result.ok) {
      await adapter.close();
      return { ok: false, reason: result.phase };
    }
    if (runs.get(request.runId) !== run) {
      await adapter.close();
      return { ok: false, reason: "preparation-missing" };
    }
    run.runtimeAdapter = adapter;
    run.client = client;
    run.sessionId = result.sessionId;
    run.ready = true;
    return { ok: true };
  } catch {
    return { ok: false, reason: "readiness-failed" };
  }
}

// eslint-disable-next-line max-lines-per-function -- readiness port wiring keeps trust bindings visible together.
function readinessPorts(
  input: OpenCodeRuntimeCompositionInput,
  bridge: ToolBridgeController,
  run: PreparedRun,
  client: ReturnType<typeof createOpenCodeHttpClient>,
  endpoint: string,
  request: OpenCodeLifecycleHandshakeRequest,
): Parameters<typeof createOpenCodeRuntimeAdapter>[0]["readiness"] {
  let startupRead = false;
  let fixedSessionId: string | undefined;
  return {
    verifiedTarget: {
      executable: join(input.portable.resourceRoot, run.verification.executablePath),
      attestationDigest: run.verification.protocolHandshakeDigest,
    },
    configDigest: run.configDigest,
    verifyTargetAttestation: (): Promise<boolean> => Promise.resolve(true),
    materialize: (): Promise<boolean> => Promise.resolve(configMaterialized(run.runRoot)),
    startupLine: (): Promise<string> => {
      startupRead = true;
      return Promise.resolve(`opencode server listening on ${endpoint}\n`);
    },
    health: (authorization) =>
      authorization === "basic"
        ? authenticatedHealth(client)
        : unauthenticatedHealth(input.fetch, endpoint, request.signal),
    openApiDigest: () => openApiDigest(client),
    gatewayChallenge: () =>
      challengeGateway(
        input,
        run,
        client,
        fixedSessionId,
        request.signal,
        request.timeoutMs,
        startupRead,
      ),
    toolFacadeChallenge: () => challengeToolFacade(input, bridge),
    subscribe: async function* (signal): AsyncIterable<OpenCodeSyncHint> {
      fixedSessionId = await createAndEchoFixedSession(client, request.signal);
      const combinedSignal =
        request.signal === undefined ? signal : AbortSignal.any([signal, request.signal]);
      for await (const event of client.events({ signal: combinedSignal })) {
        const eventType = event.data.type;
        if (eventType !== "sync") {
          const control = classifyOpenCodeLiveControl(event.data);
          const fixedControl = control?.sessionId === fixedSessionId ? control : undefined;
          yield {
            requiresHistoryIdentity: false,
            ...(fixedControl === undefined ? {} : { control: fixedControl }),
          };
          continue;
        }
        const eventId = event.data.id;
        if (typeof eventId !== "string") throw new Error("opencode-event-identity-invalid");
        yield { id: eventId, requiresHistoryIdentity: true };
      }
    },
    history: async (checkpoints, signal): Promise<readonly OpenCodeReconciliationEvent[]> => {
      const combinedSignal =
        request.signal === undefined ? signal : AbortSignal.any([signal, request.signal]);
      const parsed = parseOpenCodeHistory(
        await client.history(checkpoints, { signal: combinedSignal }),
      );
      if (!parsed.ok) throw new Error("opencode-history-invalid");
      return parsed.value;
    },
    sessionEcho: (): Promise<string> => Promise.resolve(fixedSessionId ?? ""),
  };
}

async function createAndEchoFixedSession(
  client: ReturnType<typeof createOpenCodeHttpClient>,
  signal: AbortSignal | undefined,
): Promise<string> {
  const created = await client.createSession({ signal });
  const createdId = typeof created.id === "string" ? created.id : undefined;
  if (createdId === undefined || !/^ses_[A-Za-z0-9_-]{1,251}$/u.test(createdId)) return "";
  const sessions = await client.sessions({ signal });
  return sessions.length === 1 && sessions[0]?.id === createdId ? createdId : "";
}

async function challengeGateway(
  input: OpenCodeRuntimeCompositionInput,
  run: PreparedRun,
  client: OpenCodeHttpClient,
  sessionId: string | undefined,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  startupRead: boolean,
): Promise<boolean> {
  if (
    !startupRead ||
    sessionId === undefined ||
    input.capabilities.modelGatewayCapability.length < 32
  )
    return false;
  const challengeSignal = signal ?? AbortSignal.timeout(timeoutMs);
  const observed = input.gatewayReadiness.waitForObservedRequest(run.runId, challengeSignal);
  try {
    await client.promptAsync(sessionId, "Keiko runtime readiness handshake.", {
      signal: challengeSignal,
    });
    const accepted = await observed;
    await client.abortSession(sessionId, { signal: challengeSignal });
    const terminal = await fixedSessionIsTerminal(client, sessionId, challengeSignal);
    return accepted && terminal;
  } catch {
    return false;
  } finally {
    input.gatewayReadiness.clear(run.runId);
  }
}

async function fixedSessionIsTerminal(
  client: OpenCodeHttpClient,
  sessionId: string,
  signal: AbortSignal,
): Promise<boolean> {
  while (!signal.aborted) {
    const status = (await client.sessionStatuses({ signal }))[sessionId];
    if (status === undefined || status.type === "idle") return true;
    if (!(await readinessPollDelay(signal))) return false;
  }
  return false;
}

function readinessPollDelay(signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const settle = (result: boolean): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      resolve(result);
    };
    const abort = (): void => {
      settle(false);
    };
    const timer = setTimeout(() => {
      settle(true);
    }, 10);
    signal.addEventListener("abort", abort, { once: true });
  });
}

async function challengeToolFacade(
  input: OpenCodeRuntimeCompositionInput,
  bridge: ToolBridgeController,
): Promise<boolean> {
  const result = await bridge.publicPort.handle({
    method: "POST",
    headers: new Headers({
      authorization: `Bearer ${input.capabilities.toolFacadeCapability}`,
    }),
    body: JSON.stringify({ action: "permission-event", requestId: "keiko-readiness" }),
  });
  if (result.status !== 200) return false;
  try {
    const parsed: unknown = JSON.parse(result.body);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
    const record = parsed as Record<string, unknown>;
    return (
      Object.keys(record).length === 2 &&
      record.status === "observed" &&
      Array.isArray(record.evidence) &&
      record.evidence.length === 0
    );
  } catch {
    return false;
  }
}

async function openApiDigest(client: ReturnType<typeof createOpenCodeHttpClient>): Promise<string> {
  return projectOpenCodeProtocolSurface(await client.document()).digest;
}

async function authenticatedHealth(
  client: ReturnType<typeof createOpenCodeHttpClient>,
): Promise<{ readonly status: number; readonly version?: string }> {
  const result = await client.health();
  if (!result.ok || result.value.healthy !== true || typeof result.value.version !== "string") {
    return { status: 500 };
  }
  return { status: 200, version: result.value.version };
}

async function unauthenticatedHealth(
  fetch: typeof globalThis.fetch,
  endpoint: string,
  signal: AbortSignal | undefined,
): Promise<{ readonly status: number }> {
  const response = await fetch(new URL("/global/health", endpoint), {
    method: "GET",
    redirect: "manual",
    ...(signal === undefined ? {} : { signal }),
  });
  return { status: response.status };
}

function verifiedProtocol(
  candidate: PortableSidecarRuntimeVerification,
  trusted: PortableSidecarRuntimeVerification,
): boolean {
  return (
    candidate === trusted &&
    candidate.summary.status === "verified" &&
    candidate.summary.upstreamVersion === PINNED_VERSION &&
    candidate.availability.protocolSchemaVerified &&
    candidate.protocolSchemaRawSha256 === PINNED_RAW_SCHEMA_SHA256 &&
    runtimeField(candidate, "protocolHandshakeAlgorithm") ===
      OPEN_CODE_PROTOCOL_SURFACE_ALGORITHM &&
    DIGEST.test(candidate.protocolHandshakeDigest)
  );
}

function runtimeField(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function distinctCapabilities(
  capabilities: OpenCodeRuntimeCompositionInput["capabilities"],
): boolean {
  return (
    capabilities.modelGatewayCapability.length >= 32 &&
    capabilities.toolFacadeCapability.length >= 32 &&
    capabilities.modelGatewayCapability !== capabilities.toolFacadeCapability
  );
}

function createPrivateState(runRoot: string): void {
  mkdirSync(runRoot, { recursive: true, mode: 0o700 });
  chmodSync(runRoot, 0o700);
  for (const name of ["config", "state", "home", "tmp"]) {
    const path = join(runRoot, name);
    mkdirSync(path, { recursive: true, mode: 0o700 });
    chmodSync(path, 0o700);
  }
  for (const path of [
    join(runRoot, "config", "opencode"),
    join(runRoot, "config", "opencode", "tools"),
  ]) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    chmodSync(path, 0o700);
  }
}

function materialize(
  runRoot: string,
  config: string,
  toolSources: Readonly<Record<string, string>>,
): void {
  const discoveryRoot = join(runRoot, "config", "opencode");
  writePrivateFile(join(discoveryRoot, "opencode.json"), config);
  for (const [name, source] of Object.entries(toolSources)) {
    writePrivateFile(join(discoveryRoot, "tools", `${name}.ts`), source);
  }
}

function writePrivateFile(path: string, value: string): void {
  writeFileSync(path, value, { encoding: "utf8", mode: 0o600 });
  chmodSync(path, 0o600);
}

function configMaterialized(runRoot: string): boolean {
  try {
    return (
      statSync(join(runRoot, "config", "opencode", "opencode.json")).isFile() &&
      readFileSync(join(runRoot, "config", "opencode", "opencode.json"), "utf8").length > 0
    );
  } catch {
    return false;
  }
}

interface ToolBridgeController {
  readonly publicPort: OpenCodeToolBridge;
  start(): Promise<void>;
  close(): Promise<void>;
  active(): boolean;
}

interface ToolBridgeLimits {
  readonly requestDeadlineMs: number;
  readonly maxInFlight: number;
}

interface AdmittedToolRequest {
  readonly controller: AbortController;
  release(): void;
}

interface ToolBridgeAdmissionGate {
  readonly admit: () => AdmittedToolRequest | undefined;
  readonly abortAll: () => void;
}

const DEFAULT_TOOL_BRIDGE_DEADLINE_MS = 30_000;
const MAX_TOOL_BRIDGE_DEADLINE_MS = 60_000;
const MAX_TOOL_BRIDGE_IN_FLIGHT = 64;
const DEADLINE_ABORT = "tool-bridge-deadline";
const DISCONNECT_ABORT = "tool-bridge-disconnect";
const CLOSE_ABORT = "tool-bridge-close";

function createToolBridge(
  capability: string,
  facade: CodingToolFacade,
  configuredLimits: OpenCodeRuntimeCompositionInput["toolBridge"],
): ToolBridgeController {
  const limits = normalizeToolBridgeLimits(configuredLimits);
  let server: Server | undefined;
  let url = "http://127.0.0.1:0/tool";
  let listening = false;
  const gate = createToolBridgeAdmissionGate(limits);
  const sockets = new Set<Socket>();
  const handle: OpenCodeToolBridge["handle"] = (request) =>
    handleDirectToolRequest(listening, capability, facade, gate, request);
  const publicPort: OpenCodeToolBridge = {
    get url(): string {
      return url;
    },
    handle,
  };
  return {
    publicPort,
    active: () => listening,
    start: async (): Promise<void> => {
      if (listening) return;
      server = configuredBridgeServer(limits, sockets, (request, response): void => {
        void handleIncomingToolRequest(
          request,
          response,
          listening,
          capability,
          facade,
          gate.admit,
        );
      });
      url = await listenBridge(server);
      listening = true;
    },
    close: async (): Promise<void> => {
      listening = false;
      const current = server;
      server = undefined;
      if (current === undefined) return;
      gate.abortAll();
      for (const socket of sockets) socket.destroy();
      await closeBridgeServer(current);
    },
  };
}

function handleDirectToolRequest(
  active: boolean,
  capability: string,
  facade: CodingToolFacade,
  gate: ToolBridgeAdmissionGate,
  input: Parameters<OpenCodeToolBridge["handle"]>[0],
): Promise<{ readonly status: number; readonly body: string }> {
  const rejection = preflightToolRequest(active, capability, input.headers, input.body);
  if (rejection !== undefined) return Promise.resolve(rejection);
  const admission = gate.admit();
  if (admission === undefined) return Promise.resolve({ status: 429, body: "" });
  return executeToolRequest(facade, capability, input.headers, input.body, admission);
}

function createToolBridgeAdmissionGate(limits: ToolBridgeLimits): ToolBridgeAdmissionGate {
  let admitted = 0;
  const controllers = new Set<AbortController>();
  return {
    admit: (): AdmittedToolRequest | undefined => {
      if (admitted >= limits.maxInFlight) return undefined;
      admitted += 1;
      const controller = new AbortController();
      controllers.add(controller);
      const timer = setTimeout(() => {
        controller.abort(new Error(DEADLINE_ABORT));
      }, limits.requestDeadlineMs);
      timer.unref();
      let released = false;
      return {
        controller,
        release: (): void => {
          if (released) return;
          released = true;
          clearTimeout(timer);
          controllers.delete(controller);
          admitted -= 1;
        },
      };
    },
    abortAll: (): void => {
      for (const controller of controllers) controller.abort(new Error(CLOSE_ABORT));
    },
  };
}

function configuredBridgeServer(
  limits: ToolBridgeLimits,
  sockets: Set<Socket>,
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Server {
  const server = createServer(handler);
  server.headersTimeout = Math.min(limits.requestDeadlineMs, 10_000);
  server.requestTimeout = limits.requestDeadlineMs;
  server.keepAliveTimeout = 1_000;
  server.timeout = limits.requestDeadlineMs;
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  return server;
}

async function listenBridge(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("bridge-bind-failed");
  return `http://127.0.0.1:${String(address.port)}/tool`;
}

async function closeBridgeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    });
  });
}

function normalizeToolBridgeLimits(
  input: OpenCodeRuntimeCompositionInput["toolBridge"],
): ToolBridgeLimits {
  return {
    requestDeadlineMs: boundedInteger(
      input?.requestDeadlineMs,
      DEFAULT_TOOL_BRIDGE_DEADLINE_MS,
      MAX_TOOL_BRIDGE_DEADLINE_MS,
    ),
    maxInFlight: boundedInteger(
      input?.maxInFlight,
      CODING_TOOL_MAX_IN_FLIGHT,
      MAX_TOOL_BRIDGE_IN_FLIGHT,
    ),
  };
}

function boundedInteger(value: number | undefined, fallback: number, maximum: number): number {
  return value === undefined || !Number.isFinite(value)
    ? fallback
    : Math.min(maximum, Math.max(1, Math.trunc(value)));
}

function preflightToolRequest(
  active: boolean,
  capability: string,
  headers: Headers,
  body?: string,
): { readonly status: number; readonly body: string } | undefined {
  if (!active) return { status: 503, body: "" };
  if (headers.has("origin")) return { status: 403, body: "" };
  const bearer = headers.get("authorization");
  if (bearer === null || !safeEqual(bearer, `Bearer ${capability}`)) {
    return { status: 401, body: "" };
  }
  const declaredLength = declaredBodyLength(headers.get("content-length"));
  if (declaredLength === "invalid" || declaredLength > CODING_TOOL_MAX_BODY_BYTES) {
    return { status: 413, body: "" };
  }
  if (body !== undefined && Buffer.byteLength(body, "utf8") > CODING_TOOL_MAX_BODY_BYTES) {
    return { status: 413, body: "" };
  }
  return undefined;
}

function declaredBodyLength(value: string | null): number | "invalid" {
  if (value === null) return 0;
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) return "invalid";
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : "invalid";
}

async function executeToolRequest(
  facade: CodingToolFacade,
  capability: string,
  headers: Headers,
  body: string,
  admission: AdmittedToolRequest,
): Promise<{ readonly status: number; readonly body: string }> {
  if (!validJson(body)) {
    admission.release();
    return { status: 400, body: "" };
  }
  const facadeWork = facade.execute({
    body,
    capability,
    headers,
    signal: admission.controller.signal,
  });
  void facadeWork.then(
    () => {
      admission.release();
    },
    () => {
      admission.release();
    },
  );
  try {
    const result = await raceAbort(facadeWork, admission.controller.signal);
    if (abortReason(admission.controller.signal) === DEADLINE_ABORT) {
      return { status: 408, body: "" };
    }
    if (result.status === "busy") return { status: 429, body: "" };
    const responseBody = JSON.stringify(result);
    return Buffer.byteLength(responseBody, "utf8") <= CODING_TOOL_MAX_BODY_BYTES
      ? { status: 200, body: responseBody }
      : { status: 502, body: "" };
  } catch {
    return abortReason(admission.controller.signal) === DEADLINE_ABORT
      ? { status: 408, body: "" }
      : { status: 502, body: "" };
  }
}

function validJson(body: string): boolean {
  try {
    JSON.parse(body);
    return true;
  } catch {
    return false;
  }
}

function raceAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError(signal));
  return Promise.race([
    work,
    new Promise<never>((_resolve, reject) => {
      signal.addEventListener(
        "abort",
        () => {
          reject(abortError(signal));
        },
        { once: true },
      );
    }),
  ]);
}

function abortReason(signal: AbortSignal): string | undefined {
  return signal.reason instanceof Error ? signal.reason.message : undefined;
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("tool-bridge-aborted");
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

async function handleIncomingToolRequest(
  request: IncomingMessage,
  response: ServerResponse,
  active: boolean,
  capability: string,
  facade: CodingToolFacade,
  admit: () => AdmittedToolRequest | undefined,
): Promise<void> {
  if (request.method !== "POST" || request.url !== "/tool") {
    response.writeHead(404).end();
    return;
  }
  const headers = incomingHeaders(request.headers);
  const rejection = preflightToolRequest(active, capability, headers);
  if (rejection !== undefined) {
    response.writeHead(rejection.status).end();
    return;
  }
  const admission = admit();
  if (admission === undefined) {
    response.writeHead(429).end();
    return;
  }
  const abortDisconnect = (): void => {
    admission.controller.abort(new Error(DISCONNECT_ABORT));
  };
  request.once("aborted", abortDisconnect);
  response.once("close", () => {
    if (!response.writableFinished) abortDisconnect();
  });
  try {
    const bytes = await readBoundedBody(request, admission.controller.signal);
    const body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const result = await executeToolRequest(facade, capability, headers, body, admission);
    if (!response.destroyed) {
      response.writeHead(result.status, { "Content-Type": "application/json" }).end(result.body);
    }
  } catch {
    admission.release();
    if (response.destroyed) return;
    const status = abortReason(admission.controller.signal) === DEADLINE_ABORT ? 408 : 400;
    response.writeHead(status).end();
  } finally {
    request.removeListener("aborted", abortDisconnect);
  }
}

function incomingHeaders(values: IncomingHttpHeaders): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(values)) {
    if (typeof value === "string") headers.set(name, value);
    else if (value !== undefined) headers.set(name, value.join(", "));
  }
  return headers;
}

function readBoundedBody(request: IncomingMessage, signal: AbortSignal): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    const cleanup = (): void => {
      request.removeListener("data", onData);
      request.removeListener("end", onEnd);
      request.removeListener("error", onError);
      signal.removeEventListener("abort", onAbort);
    };
    const fail = (reason: unknown): void => {
      request.pause();
      cleanup();
      reject(reason instanceof Error ? reason : new Error("tool-bridge-read-aborted"));
    };
    const onData = (chunk: Buffer): void => {
      bytes += chunk.length;
      if (bytes > CODING_TOOL_MAX_BODY_BYTES) fail(new Error("body-too-large"));
      else chunks.push(chunk);
    };
    const onEnd = (): void => {
      cleanup();
      resolve(Buffer.concat(chunks, bytes));
    };
    const onError = (error: Error): void => {
      fail(error);
    };
    const onAbort = (): void => {
      fail(signal.reason);
    };
    request.on("data", onData);
    request.once("end", onEnd);
    request.once("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}
