import type {
  DebugEvent,
  DebugLifecycleReason,
  DebugOutputCategory,
  DebugProcessErrorCode,
  DebugSessionStopReason,
  DebugStopReason,
} from "@oscharko-dev/keiko-contracts";
import {
  DEFAULT_DEBUG_PAYLOAD_LIMITS,
  projectDebugText,
} from "@oscharko-dev/keiko-contracts/runtime/dap-debug";
import type { QualifiedDebugCapsuleHandle } from "./dapCapsuleSupervisor.js";
import {
  preflightDapAdapter,
  type DapAdapterPreflight,
  type DapAdapterPreflightDeps,
} from "./dapNodeAdapter.js";
import { type DapPrivateEndpointConnection } from "./dapPrivateEndpoint.js";
import {
  createDapProtocolClient,
  DapProtocolError,
  type DapEvent,
  type DapProtocolClient,
  type DapRequestLane,
  type DapStoppedEvent,
} from "./dapProtocolClient.js";
import type { DapEventBridge, DebugEventChannel } from "./dapEventBridge.js";
import {
  assertPlanBoundToRequest,
  type DebugCapsuleLayer2Validator,
  type DebugCapsulePlanBinding,
  type Layer2DebugCapsulePlan,
  type DebugSpawnEnvelope,
} from "./debugCapsulePlan.js";
import type { DapAdapterProviderCatalog } from "./providers/dapAdapterProviders.js";
import type {
  DebugPauseContext,
  DebugProtocolPort,
  DebugProvisionalReservationInput,
  DebugSessionBinding,
  DebugSessionProjection,
  DebugSessionRegistry,
} from "./debugSessionRegistry.js";

export type DebugCapsuleLauncher = (
  envelope: DebugSpawnEnvelope,
  signal: AbortSignal,
) => Promise<QualifiedDebugCapsuleHandle>;
export interface DapProcessManagerDeps {
  readonly registry: DebugSessionRegistry;
  readonly adapterCatalog: DapAdapterProviderCatalog;
  readonly adapterPreflight: (
    identity: DapProcessStartInput["identity"],
  ) => DapAdapterPreflightDeps;
  readonly validateCapsulePlan: DebugCapsuleLayer2Validator;
  readonly launchCapsule: DebugCapsuleLauncher;
  readonly connectEndpoint: (plan: Layer2DebugCapsulePlan) => Promise<DapPrivateEndpointConnection>;
  readonly revalidateTarget: (envelope: DebugSpawnEnvelope) => boolean;
  readonly events?: DapEventBridge | undefined;
}
export interface DapProcessStartInput {
  readonly identity: DebugProvisionalReservationInput;
  readonly adapterRuntime: string;
  readonly adapterProviderId: string;
  readonly planCandidate: unknown;
  readonly configure?: ((port: DapSessionConfigurationPort) => Promise<void>) | undefined;
}
export interface DapSessionConfigurationPort {
  request<T>(command: string, args: unknown): Promise<T>;
}
export interface DapProcessManager {
  start(input: DapProcessStartInput): Promise<void>;
  request<T>(
    sessionId: string,
    command: string,
    args: unknown,
    lane: DapRequestLane,
    signal?: AbortSignal,
  ): Promise<T>;
  stop(sessionId: string): Promise<void>;
  revoke(sessionId: string): Promise<void>;
  failMalformed(sessionId: string): Promise<void>;
  sweepExpired(): Promise<void>;
  reconcile(): Promise<void>;
  shutdown(): Promise<void>;
  health(sessionId: string): DebugSessionProjection | undefined;
  binding(sessionId: string): DebugSessionBinding | undefined;
  boundSessionId(workspacePartitionKey: string, browserSessionBinding: string): string | undefined;
  workspaceSessionId(workspacePartitionKey: string): string | undefined;
  pauseContext(sessionId: string): DebugPauseContext | undefined;
}

export class DapProcessManagerError extends Error {
  public readonly code: Extract<
    DebugProcessErrorCode,
    "STARTUP_THROTTLED" | "SESSION_NOT_FOUND" | "INVALID_CAPSULE_PLAN" | "CLIENT_DISPOSED"
  >;
  public constructor(
    code: "STARTUP_THROTTLED" | "SESSION_NOT_FOUND" | "INVALID_CAPSULE_PLAN" | "CLIENT_DISPOSED",
  ) {
    super(code);
    this.name = "DapProcessManagerError";
    this.code = code;
  }
}

export function createDapProcessManager(deps: DapProcessManagerDeps): DapProcessManager {
  let shutdownPromise: Promise<void> | undefined;
  const assertOpen = (): void => {
    if (shutdownPromise !== undefined) throw new DapProcessManagerError("CLIENT_DISPOSED");
  };
  return {
    start: async (input): Promise<void> => {
      assertOpen();
      await startAndPublish(deps, input);
    },
    request: <T>(
      sessionId: string,
      command: string,
      args: unknown,
      lane: DapRequestLane,
      signal?: AbortSignal,
    ): Promise<T> => {
      if (shutdownPromise !== undefined) {
        return Promise.reject(new DapProcessManagerError("CLIENT_DISPOSED"));
      }
      return requestAndTouch<T>(deps, sessionId, command, args, lane, signal);
    },
    stop: async (sessionId): Promise<void> => {
      assertOpen();
      await stopAndPublish(deps, sessionId, "stopped", "requested");
    },
    revoke: async (sessionId): Promise<void> => {
      assertOpen();
      await stopAndPublish(deps, sessionId, "revoked", "revoked");
    },
    failMalformed: (sessionId) => failMalformedOpen(deps, assertOpen, sessionId),
    sweepExpired: async (): Promise<void> => {
      assertOpen();
      await sweepExpired(deps);
    },
    reconcile: () => reconcileOpen(deps, assertOpen),
    shutdown: (): Promise<void> => {
      shutdownPromise ??= shutdown(deps);
      return shutdownPromise;
    },
    health: (sessionId) => deps.registry.session(sessionId),
    binding: (sessionId) => deps.registry.sessionBinding(sessionId),
    boundSessionId: (workspacePartitionKey, browserSessionBinding) =>
      deps.registry.boundSessionId(workspacePartitionKey, browserSessionBinding),
    workspaceSessionId: (workspacePartitionKey) =>
      deps.registry.workspaceSessionId(workspacePartitionKey),
    pauseContext: (sessionId) => deps.registry.pauseContext(sessionId),
  };
}

async function reconcileOpen(deps: DapProcessManagerDeps, assertOpen: () => void): Promise<void> {
  assertOpen();
  await deps.registry.reconcile();
}

async function failMalformedOpen(
  deps: DapProcessManagerDeps,
  assertOpen: () => void,
  sessionId: string,
): Promise<void> {
  assertOpen();
  await failMalformedAndPublish(deps, sessionId);
}

function requestAndTouch<T>(
  deps: DapProcessManagerDeps,
  sessionId: string,
  command: string,
  args: unknown,
  lane: DapRequestLane,
  signal?: AbortSignal,
): Promise<T> {
  const protocol = deps.registry.protocol(sessionId);
  deps.registry.touch(sessionId);
  return protocol.request<T>(command, args, lane, signal);
}

async function startAndPublish(
  deps: DapProcessManagerDeps,
  input: DapProcessStartInput,
): Promise<void> {
  await start(deps, input);
  await publishRequired(deps, input.identity, {
    kind: "session-started",
    sessionId: input.identity.sessionId,
    status: "running",
  });
}

async function stopAndPublish(
  deps: DapProcessManagerDeps,
  sessionId: string,
  status: "stopped" | "revoked",
  reason: DebugSessionStopReason,
): Promise<void> {
  const binding = requiredBinding(deps, sessionId);
  await transitionAndPublish(
    deps,
    binding,
    sessionId,
    status === "revoked" ? "activationRevoked" : "stopped",
    { kind: "session-stopped", sessionId, status, reason },
  );
}

async function failMalformedAndPublish(
  deps: DapProcessManagerDeps,
  sessionId: string,
): Promise<void> {
  const binding = requiredBinding(deps, sessionId);
  await transitionAndPublish(deps, binding, sessionId, "malformedFrame", {
    kind: "session-stopped",
    sessionId,
    status: "failed",
    reason: "failed",
  });
}

async function start(deps: DapProcessManagerDeps, input: DapProcessStartInput): Promise<void> {
  const { plan } = await prepareStartup(deps, input);
  await runStartupAttempt(deps, input, plan);
}

async function runStartupAttempt(
  deps: DapProcessManagerDeps,
  input: DapProcessStartInput,
  plan: Layer2DebugCapsulePlan,
): Promise<void> {
  const attempt = await deps.registry.beginStartupAttempt(input.identity.sessionId);
  try {
    await launchAttempt(deps, input, plan, attempt);
  } catch (error: unknown) {
    const retry = await releaseFailedAttempt(deps, input, attempt.attemptId);
    if (error instanceof DapProcessManagerError) {
      await deps.registry.teardown(input.identity.sessionId, "startupFailed");
      throw error;
    }
    if (!retry) throw error;
    await runStartupAttempt(deps, input, plan);
  }
}

async function prepareStartup(
  deps: DapProcessManagerDeps,
  input: DapProcessStartInput,
): Promise<{ readonly adapter: DapAdapterPreflight; readonly plan: Layer2DebugCapsulePlan }> {
  deps.registry.reserveProvisional(input.identity);
  try {
    return await prepareReservedStartup(deps, input);
  } catch (error: unknown) {
    deps.registry.rollbackProvisional(input.identity.sessionId);
    throw error;
  }
}

async function prepareReservedStartup(
  deps: DapProcessManagerDeps,
  input: DapProcessStartInput,
): Promise<{ readonly adapter: DapAdapterPreflight; readonly plan: Layer2DebugCapsulePlan }> {
  const spec = deps.adapterCatalog.resolve(input.adapterRuntime, input.adapterProviderId);
  if (spec === undefined) throw new DapProcessManagerError("INVALID_CAPSULE_PLAN");
  assertSpecSupportsStart(spec, input);
  const adapter = preflightDapAdapter(spec, deps.adapterPreflight(input.identity));
  const binding = planBinding(input);
  let plan: Layer2DebugCapsulePlan;
  try {
    plan = await deps.validateCapsulePlan.validateAndRederive({
      candidate: input.planCandidate,
      correlationId: input.identity.sessionId,
      binding,
      adapter: {
        providerId: spec.providerId,
        executable: adapter.executable,
        args: adapter.args,
        env: adapter.env,
        home: adapter.home.path,
        temp: adapter.temp.path,
        runtimeRoot: adapter.runtimeRoot,
      },
    });
    assertPlanBoundToRequest(plan, binding);
  } catch {
    adapter.home.cleanup();
    adapter.temp.cleanup();
    throw new DapProcessManagerError("INVALID_CAPSULE_PLAN");
  }
  try {
    await deps.registry.promoteReservation(input.identity.sessionId, {
      provisioningDigest: plan.provisioningDigest,
      backend: plan.backend,
      runtimeIdentityDigest: plan.runtimeIdentityDigest,
      planId: plan.planId,
      planEpoch: plan.epoch,
      planExpiresAtMs: plan.expiresAtMs,
    });
    deps.registry.attachResource(input.identity.sessionId, adapter.home);
    deps.registry.attachResource(input.identity.sessionId, adapter.temp);
  } catch (error: unknown) {
    adapter.home.cleanup();
    adapter.temp.cleanup();
    throw error;
  }
  return { adapter, plan };
}

function assertSpecSupportsStart(
  spec: NonNullable<ReturnType<DapAdapterProviderCatalog["resolve"]>>,
  input: DapProcessStartInput,
): void {
  const closed =
    isNoneNetworkPolicy(spec.networkPolicy) &&
    spec.supportedTargetKinds.includes(input.identity.targetKind) &&
    spec.supportedLaunchKinds.includes("launch") &&
    spec.supportedAttachKinds.length === 0 &&
    spec.reverseRequestAllowlist.length === 0 &&
    spec.requiredExecutables.length > 0;
  if (!closed) throw new DapProcessManagerError("INVALID_CAPSULE_PLAN");
}

function isNoneNetworkPolicy(value: unknown): value is "none" {
  return value === "none";
}

async function launchAttempt(
  deps: DapProcessManagerDeps,
  input: DapProcessStartInput,
  plan: Layer2DebugCapsulePlan,
  attempt: { readonly attemptId: number; readonly signal: AbortSignal },
): Promise<void> {
  const handle = await deps.launchCapsule(plan.spawnEnvelope, attempt.signal);
  const attached = await deps.registry.attachCapsule(
    input.identity.sessionId,
    attempt.attemptId,
    handle,
    { backend: plan.backend, runtimeIdentityDigest: plan.runtimeIdentityDigest },
  );
  if (!attached) throw new DapProcessManagerError("SESSION_NOT_FOUND");
  await initializeAttempt(
    deps,
    input.identity.sessionId,
    attempt.attemptId,
    plan,
    handle,
    input.configure,
  );
}

async function releaseFailedAttempt(
  deps: DapProcessManagerDeps,
  input: DapProcessStartInput,
  attemptId: number,
): Promise<boolean> {
  return deps.registry.completeLaunchFailure(input.identity.sessionId, attemptId);
}

function planBinding(input: DapProcessStartInput): DebugCapsulePlanBinding {
  return {
    workspacePartitionKey: input.identity.workspacePartitionKey,
    activationRevision: input.identity.activationRevision,
    targetKind: input.identity.targetKind,
  };
}

async function initializeAttempt(
  deps: DapProcessManagerDeps,
  sessionId: string,
  attemptId: number,
  plan: Layer2DebugCapsulePlan,
  handle: QualifiedDebugCapsuleHandle,
  configure: DapProcessStartInput["configure"],
): Promise<void> {
  const client = await attachAttemptResources(deps, sessionId, attemptId, plan, handle);
  deps.registry.markInitializing(sessionId, attemptId);
  const initializeBody = await client.controlRequest<unknown>(
    "initialize",
    { clientID: "keiko", adapterID: "node", linesStartAt1: true, columnsStartAt1: true },
    10_000,
  );
  const capabilities = initializeCapabilities(initializeBody);
  deps.registry.setCapabilities(sessionId, attemptId, {
    supportsSetVariable: capabilities.supportsSetVariable,
  });
  assertTargetCurrent(deps, plan.spawnEnvelope);
  await launchConfiguredSession(client, plan, configure, capabilities);
  await deps.registry.markRunning(sessionId, attemptId);
}

async function attachAttemptResources(
  deps: DapProcessManagerDeps,
  sessionId: string,
  attemptId: number,
  plan: Layer2DebugCapsulePlan,
  handle: QualifiedDebugCapsuleHandle,
): Promise<DapProtocolClient> {
  const endpoint = await deps.connectEndpoint(plan);
  await deps.registry.attachEndpoint(sessionId, attemptId, endpoint);
  const client = createManagedClient(deps, sessionId, attemptId, endpoint);
  deps.registry.attachProtocol(sessionId, attemptId, protocolPort(client));
  registerCapsuleExit(deps, sessionId, attemptId, handle);
  return client;
}

function registerCapsuleExit(
  deps: DapProcessManagerDeps,
  sessionId: string,
  attemptId: number,
  handle: QualifiedDebugCapsuleHandle,
): void {
  handle.onExit?.(() => handleCapsuleExit(deps, sessionId, attemptId));
}

async function handleCapsuleExit(
  deps: DapProcessManagerDeps,
  sessionId: string,
  attemptId: number,
): Promise<void> {
  const binding = deps.registry.sessionBinding(sessionId);
  const owner = await deps.registry.capsuleExited(sessionId, attemptId);
  if (binding !== undefined && owner) {
    publishEvent(deps, binding, {
      kind: "session-stopped",
      sessionId,
      status: "failed",
      reason: "failed",
    });
  }
}

async function launchConfiguredSession(
  client: DapProtocolClient,
  plan: Layer2DebugCapsulePlan,
  configure: DapProcessStartInput["configure"],
  capabilities: InitializeCapabilities,
): Promise<void> {
  const initialized = waitForInitialized(client);
  const launched = client.controlRequest(
    plan.launchRequest.command,
    plan.launchRequest.arguments,
    10_000,
  );
  await initialized;
  if (configure !== undefined) {
    await configure({
      request: <T>(command: string, args: unknown): Promise<T> =>
        // Stryker disable next-line StringLiteral: the protocol client treats every non-control lane
        // as inspection for both capacity reservation and the pending-request classification.
        client.request<T>(command, args, { lane: "inspection", deadlineMs: 3_000 }),
    });
  }
  if (capabilities.supportsConfigurationDoneRequest) {
    await client.controlRequest("configurationDone", {}, 2_000);
  }
  await launched;
}

interface InitializeCapabilities {
  readonly supportsConfigurationDoneRequest: boolean;
  readonly supportsSetVariable: boolean;
}

function initializeCapabilities(value: unknown): InitializeCapabilities {
  // Stryker disable next-line ConditionalExpression: null reaches the same closed startup retry
  // boundary if property access throws; the decoder nevertheless rejects it explicitly for clarity.
  // Stryker disable next-line BlockStatement: deleting this explicit null rejection only defers the
  // same closed startup failure to property access below; no decoded capability can be accepted.
  if (value === null) {
    // Stryker disable next-line StringLiteral: startup never exposes DAP decoder codes; this error
    // and an equivalent decoder failure both enter the same bounded closed retry classification.
    throw new DapProtocolError("MALFORMED_MESSAGE");
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    // Stryker disable next-line StringLiteral: startup never exposes DAP decoder codes; this error
    // and an equivalent decoder failure both enter the same bounded closed retry classification.
    throw new DapProtocolError("MALFORMED_MESSAGE");
  }
  const record = value as Readonly<Record<string, unknown>>;
  for (const key of ["supportsConfigurationDoneRequest", "supportsSetVariable"]) {
    if (record[key] !== undefined && typeof record[key] !== "boolean") {
      // Stryker disable next-line StringLiteral: startup never exposes DAP decoder codes; this error
      // and an equivalent decoder failure both enter the same bounded closed retry classification.
      throw new DapProtocolError("MALFORMED_MESSAGE");
    }
  }
  return {
    supportsConfigurationDoneRequest: record.supportsConfigurationDoneRequest === true,
    supportsSetVariable: record.supportsSetVariable === true,
  };
}

function waitForInitialized(client: DapProtocolClient): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      // Stryker disable next-line StringLiteral: initialized-wait failures are classified solely by
      // the DapProtocolError boundary, then retried and throttled without exposing the inner code.
      reject(new DapProtocolError("REQUEST_TIMEOUT"));
    }, 10_000);
    timer.unref();
    const unsubscribe = client.onEvent((event) => {
      if (event.event !== "initialized") return;
      clearTimeout(timer);
      unsubscribe();
      resolve();
    });
  });
}

function assertTargetCurrent(deps: DapProcessManagerDeps, envelope: DebugSpawnEnvelope): void {
  if (!targetCurrent(deps, envelope)) {
    throw new DapProcessManagerError("INVALID_CAPSULE_PLAN");
  }
}

// Stryker disable BlockStatement: Deleting any block in this closed boolean adapter yields
// undefined, which the caller rejects identically to false; all non-equivalent mutations remain.
function targetCurrent(deps: DapProcessManagerDeps, envelope: DebugSpawnEnvelope): boolean {
  try {
    return deps.revalidateTarget(envelope);
  } catch {
    return false;
  }
}
// Stryker restore BlockStatement

function createManagedClient(
  deps: DapProcessManagerDeps,
  sessionId: string,
  attemptId: number,
  endpoint: DapPrivateEndpointConnection,
): DapProtocolClient {
  const registry = deps.registry;
  const binding = requiredBinding(deps, sessionId);
  const client = createDapProtocolClient({
    source: endpoint.source,
    sendFrame: endpoint.sendFrame,
    onFatalError: async (error) => {
      if (registry.isAttemptCurrent(sessionId, attemptId)) {
        await transitionAndPublish(deps, binding, sessionId, terminalReason(error.code), {
          kind: "session-stopped",
          sessionId,
          status: "failed",
          reason: "failed",
        });
      }
    },
  });
  client.onEvent((event) => handleProtocolEvent(deps, binding, sessionId, attemptId, event));
  client.onStopped((event) => {
    handleStoppedEvent(deps, binding, sessionId, event);
  });
  return client;
}

function eventBody(event: DapEvent): Readonly<Record<string, unknown>> | undefined {
  return event.body as Readonly<Record<string, unknown>> | undefined;
}

async function handleProtocolEvent(
  deps: DapProcessManagerDeps,
  binding: DebugEventChannel,
  sessionId: string,
  attemptId: number,
  event: DapEvent,
): Promise<void> {
  if (event.event === "output") await handleOutputEvent(deps, binding, sessionId, attemptId, event);
  if (event.event === "continued") handleContinuedEvent(deps, binding, sessionId);
  if (event.event === "exited") await handleExitedEvent(deps, binding, sessionId, event);
  if (event.event === "terminated") await handleTerminatedEvent(deps, binding, sessionId);
}

async function handleOutputEvent(
  deps: DapProcessManagerDeps,
  binding: DebugEventChannel,
  sessionId: string,
  attemptId: number,
  event: DapEvent,
): Promise<void> {
  const body = eventBody(event);
  if (typeof body?.output !== "string") return;
  if (body.category === "telemetry") return;
  const bytes = Buffer.from(body.output);
  const accepted = await deps.registry.acceptOutputForAttempt(sessionId, attemptId, bytes);
  // Stryker disable next-line ConditionalExpression: an obsolete attempt can return undefined;
  // dereferencing it becomes an isolated protocol fatal, which is ignored by isAttemptCurrent and
  // therefore has the same live-session projection as this explicit stale-output rejection.
  if (accepted === undefined || accepted.accepted.length === 0) return;
  publishEvent(deps, binding, {
    kind: "output",
    sessionId,
    category: outputCategory(body.category),
    text: accepted.accepted.toString("utf8"),
    truncated: accepted.omittedBytes > 0,
    originalBytes: bytes.length,
    omittedBytes: accepted.omittedBytes,
  });
  if (accepted.terminalOwner === true) {
    publishEvent(deps, binding, {
      kind: "session-stopped",
      sessionId,
      status: "stopped",
      reason: "limit",
    });
  }
}

function outputCategory(value: unknown): DebugOutputCategory {
  return value === "stdout" || value === "stderr" ? value : "console";
}

function handleContinuedEvent(
  deps: DapProcessManagerDeps,
  binding: DebugEventChannel,
  sessionId: string,
): void {
  deps.registry.resume(sessionId);
  const session = deps.registry.session(sessionId);
  // Stryker disable next-line ConditionalExpression: resume and session are synchronous operations
  // on the same registry; if resume accepts the id, the session cannot disappear in between. The
  // defensive return remains for future registry implementations.
  if (session === undefined) return;
  const pauseGeneration = session.pauseGeneration;
  publishEvent(deps, binding, { kind: "continued", sessionId, pauseGeneration });
}

function requiredBinding(deps: DapProcessManagerDeps, sessionId: string): DebugEventChannel {
  const binding = deps.registry.sessionBinding(sessionId);
  if (binding === undefined) throw new DapProcessManagerError("SESSION_NOT_FOUND");
  return binding;
}

async function handleExitedEvent(
  deps: DapProcessManagerDeps,
  binding: DebugEventChannel,
  sessionId: string,
  event: DapEvent,
): Promise<void> {
  const exitCode = eventBody(event)?.exitCode;
  // Stryker disable next-line ConditionalExpression: Number.isSafeInteger itself rejects every
  // non-number, so removing the TypeScript narrowing conjunct cannot change the emitted event.
  if (typeof exitCode === "number" && Number.isSafeInteger(exitCode)) {
    publishEvent(deps, binding, { kind: "exited", sessionId, exitCode });
  }
  await transitionAndPublish(deps, binding, sessionId, "debuggeeExit", {
    kind: "session-stopped",
    sessionId,
    status: "stopped",
    reason: "exited",
  });
}

async function handleTerminatedEvent(
  deps: DapProcessManagerDeps,
  binding: DebugEventChannel,
  sessionId: string,
): Promise<void> {
  await transitionAndPublish(deps, binding, sessionId, "debuggeeExit", {
    kind: "session-stopped",
    sessionId,
    status: "stopped",
    reason: "exited",
  });
}

async function transitionAndPublish(
  deps: DapProcessManagerDeps,
  binding: DebugEventChannel,
  sessionId: string,
  lifecycleReason: DebugLifecycleReason,
  event: DebugEvent,
): Promise<boolean> {
  const transition = deps.registry.transitionTerminal(sessionId, lifecycleReason);
  await transition.completion;
  if (transition.owner) publishEvent(deps, binding, event);
  return transition.owner;
}

function handleStoppedEvent(
  deps: DapProcessManagerDeps,
  binding: DebugEventChannel,
  sessionId: string,
  event: DapStoppedEvent,
): void {
  const pauseGeneration = deps.registry.pause(sessionId, event.threadId, event.allThreadsStopped);
  publishEvent(deps, binding, {
    kind: "stopped",
    sessionId,
    pauseGeneration,
    reason: stopReason(event.reason),
    allThreadsStopped: event.allThreadsStopped,
    ...(event.description === undefined
      ? {}
      : {
          description: projectDebugText(
            event.description,
            DEFAULT_DEBUG_PAYLOAD_LIMITS.maxValueBytes,
          ),
        }),
  });
}

function stopReason(value: string): DebugStopReason {
  if (value === "breakpoint" || value === "exception" || value === "step" || value === "entry") {
    return value;
  }
  return "pause";
}

function publishEvent(
  deps: DapProcessManagerDeps,
  binding: DebugEventChannel,
  event: DebugEvent,
): boolean {
  return deps.events?.publish(binding, event) ?? true;
}

async function publishRequired(
  deps: DapProcessManagerDeps,
  identity: DapProcessStartInput["identity"],
  event: DebugEvent,
): Promise<void> {
  if (publishEvent(deps, identity, event)) return;
  await deps.registry.teardown(identity.sessionId, "malformedFrame");
  throw new DapProcessManagerError("INVALID_CAPSULE_PLAN");
}

function protocolPort(client: DapProtocolClient): DebugProtocolPort {
  return {
    dispose: (): void => {
      client.dispose();
    },
    pendingCount: () => client.pendingCount(),
    request: <T>(
      command: string,
      args: unknown,
      lane: "control" | "inspection",
      signal?: AbortSignal,
    ): Promise<T> =>
      client.request<T>(command, args, {
        lane,
        deadlineMs: requestDeadline(lane),
        signal,
      }),
  };
}

function requestDeadline(lane: "control" | "inspection"): number {
  return lane === "control" ? 2_000 : 3_000;
}

function terminalReason(code: DebugProcessErrorCode): DebugLifecycleReason {
  if (code === "PAYLOAD_TOO_LARGE") return "frameOverflow";
  if (code === "WRITE_FAILED") return "writeFailure";
  if (code === "UNEXPECTED_EOF") return "unexpectedEof";
  return "malformedFrame";
}

async function sweepExpired(deps: DapProcessManagerDeps): Promise<void> {
  for (const expired of deps.registry.expiredSessions()) {
    await deps.registry.teardown(expired.sessionId, expired.reason);
  }
}

async function shutdown(deps: DapProcessManagerDeps): Promise<void> {
  await Promise.all(
    deps.registry
      .sessionIds()
      .map((sessionId) => deps.registry.teardown(sessionId, "serverShutdown")),
  );
}
