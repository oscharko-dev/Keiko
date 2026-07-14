import type {
  DebugLifecycleEvidence,
  DebugLifecycleReason,
  DebugProcessErrorCode,
  DebugSessionState,
} from "@oscharko-dev/keiko-contracts";
import assert from "node:assert/strict";
import { isUtf8 } from "node:buffer";
import {
  superviseCapsuleTermination,
  type DebugCapsuleQualification,
  type DebugCapsuleTerminationStatus,
  type QualifiedDebugCapsuleHandle,
} from "./dapCapsuleSupervisor.js";
import { createDapRestartThrottle, type DapRestartThrottle } from "./dapRestartThrottle.js";
import { isSha256Digest } from "./debugLaunchSecurityPredicates.js";

export const DEBUG_MAX_SESSIONS_PER_WORKSPACE = 1;
export const DEBUG_MAX_SESSIONS_PER_SERVER = 2;
export const DEBUG_WALL_TIMEOUT_MS = 30 * 60 * 1_000;
export const DEBUG_IDLE_TIMEOUT_MS = 15 * 60 * 1_000;
export const DEBUG_MAX_OUTPUT_EVENT_BYTES = 16 * 1_024;
export const DEBUG_MAX_SESSION_OUTPUT_BYTES = 1_024 * 1_024;
export const DEBUG_MAX_REPLAY_ENTRIES = 256;
const OUTPUT_TRUNCATION_MARKER = Buffer.from("[truncated]");

export type DebugRegistryHealth = "ready" | "terminationPending" | "evidencePending";
export interface DebugReservationInput {
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly workspacePartitionKey: string;
  readonly browserSessionBinding: string;
  readonly planId: string;
  readonly planEpoch: number;
  readonly planExpiresAtMs: number;
  readonly targetKind: "catalog" | "file";
  readonly activationRevision: number;
  readonly provisioningDigest: string;
  readonly backend: "oci" | "linuxNamespace" | "windowsContainer";
  readonly runtimeIdentityDigest: string;
  readonly network: "none";
  readonly filesystem: "executionRoot";
}
export type DebugProvisionalReservationInput = Omit<
  DebugReservationInput,
  | "planId"
  | "planEpoch"
  | "planExpiresAtMs"
  | "provisioningDigest"
  | "backend"
  | "runtimeIdentityDigest"
>;
export interface DebugReservationPromotion {
  readonly planId: string;
  readonly planEpoch: number;
  readonly planExpiresAtMs: number;
  readonly provisioningDigest: string;
  readonly backend: "oci" | "linuxNamespace" | "windowsContainer";
  readonly runtimeIdentityDigest: string;
}
export interface DebugStartupAttempt {
  readonly attemptId: number;
  readonly signal: AbortSignal;
}
export interface DebugOutputAcceptance {
  readonly accepted: Buffer;
  readonly omittedBytes: number;
  readonly limitReached: boolean;
}
export interface DebugProtocolPort {
  readonly dispose: () => void;
  readonly pendingCount: () => number;
  readonly request: <T>(
    command: string,
    args: unknown,
    lane: "control" | "inspection",
    signal?: AbortSignal,
  ) => Promise<T>;
}
export interface DebugEndpointResource {
  close(): Promise<void>;
  destroy(): void;
}
export interface DebugDisposableResource {
  cleanup(): void;
}
export interface DebugOutputLimitEvent {
  readonly kind: "output-limit";
  readonly sessionId: string;
  readonly acceptedBytes: number;
}
export interface DebugSessionProjection {
  readonly sessionId: string;
  readonly targetKind: "catalog" | "file";
  readonly state: DebugSessionState;
  readonly terminalReason: DebugLifecycleReason | undefined;
  readonly activationRevision: number;
  readonly pauseGeneration: number;
  readonly startedAtMs: number;
  readonly lastActivityAtMs: number;
  readonly outputAcceptedBytes: number;
  readonly outputTruncatedEvents: number;
  readonly pendingRequestCount: number;
  readonly startupAttemptCount: number;
  readonly health: DebugRegistryHealth;
  readonly supportsSetVariable: boolean;
}
export interface DebugSessionBinding {
  readonly workspaceId: string;
  readonly workspacePartitionKey: string;
  readonly browserSessionBinding: string;
}
export interface DebugPauseContext {
  readonly pauseGeneration: number;
  readonly threadId: number | undefined;
  readonly allThreadsStopped: boolean;
}
export interface DebugRegistryError extends Error {
  readonly code: Extract<
    DebugProcessErrorCode,
    | "CAPACITY"
    | "EVIDENCE_PENDING"
    | "SESSION_NOT_FOUND"
    | "SESSION_TERMINATING"
    | "TERMINATION_PENDING"
    | "STARTUP_THROTTLED"
    | "INVALID_CAPSULE_PLAN"
  >;
}
export interface DebugSessionRegistryDeps {
  readonly appendEvidence: (
    workspacePartitionKey: string,
    evidence: DebugLifecycleEvidence,
  ) => Promise<void>;
  readonly now: () => number;
  readonly emitOutputLimit: (event: DebugOutputLimitEvent) => Promise<void> | void;
}
export interface DebugSessionRegistry {
  reserveProvisional(input: DebugProvisionalReservationInput): DebugSessionProjection;
  promoteReservation(sessionId: string, promotion: DebugReservationPromotion): Promise<void>;
  rollbackProvisional(sessionId: string): void;
  reserve(input: DebugReservationInput): Promise<DebugSessionProjection>;
  beginStartupAttempt(sessionId: string): Promise<DebugStartupAttempt>;
  completeLaunchFailure(sessionId: string, attemptId: number): Promise<boolean>;
  attachCapsule(
    sessionId: string,
    attemptId: number,
    handle: QualifiedDebugCapsuleHandle,
    qualification: DebugCapsuleQualification,
  ): Promise<boolean>;
  capsuleExited(sessionId: string, attemptId: number): Promise<void>;
  isAttemptCurrent(sessionId: string, attemptId: number): boolean;
  attachProtocol(sessionId: string, attemptId: number, port: DebugProtocolPort): void;
  attachEndpoint(
    sessionId: string,
    attemptId: number,
    endpoint: DebugEndpointResource,
  ): Promise<void>;
  attachResource(sessionId: string, resource: DebugDisposableResource): void;
  markInitializing(sessionId: string, attemptId: number): void;
  setCapabilities(
    sessionId: string,
    attemptId: number,
    capabilities: { readonly supportsSetVariable: boolean },
  ): void;
  markRunning(sessionId: string, attemptId: number): Promise<void>;
  pause(sessionId: string, threadId: number | undefined, allThreadsStopped: boolean): number;
  resume(sessionId: string): void;
  pauseContext(sessionId: string): DebugPauseContext | undefined;
  touch(sessionId: string): void;
  isCurrentPause(sessionId: string, generation: number): boolean;
  protocol(sessionId: string): DebugProtocolPort;
  acceptOutput(sessionId: string, bytes: Buffer): Promise<DebugOutputAcceptance>;
  acceptOutputForAttempt(
    sessionId: string,
    attemptId: number,
    bytes: Buffer,
  ): Promise<DebugOutputAcceptance | undefined>;
  stop(sessionId: string): Promise<void>;
  revoke(sessionId: string): Promise<void>;
  teardown(sessionId: string, reason: DebugLifecycleReason): Promise<void>;
  reconcile(): Promise<void>;
  expiredSessions(): readonly {
    readonly sessionId: string;
    readonly reason: "wallTimeout" | "inactivityTimeout";
  }[];
  health(): DebugRegistryHealth;
  isBoundTo(
    sessionId: string,
    workspacePartitionKey: string,
    browserSessionBinding: string,
  ): boolean;
  sessionBinding(sessionId: string): DebugSessionBinding | undefined;
  boundSessionId(workspacePartitionKey: string, browserSessionBinding: string): string | undefined;
  workspaceSessionId(workspacePartitionKey: string): string | undefined;
  session(sessionId: string): DebugSessionProjection | undefined;
  sessionIds(): readonly string[];
}

interface CapsuleResource {
  readonly attemptId: number;
  readonly handle: QualifiedDebugCapsuleHandle;
  status?: DebugCapsuleTerminationStatus | undefined;
}
interface InternalStartupAttempt {
  readonly attemptId: number;
  readonly controller: AbortController;
}
interface SessionRuntime {
  readonly input: DebugProvisionalReservationInput;
  promotion: DebugReservationPromotion | undefined;
  readonly startedAtMs: number;
  readonly restartThrottle: DapRestartThrottle;
  readonly capsules: CapsuleResource[];
  state: DebugSessionState;
  terminalReason: DebugLifecycleReason | undefined;
  projectTerminal: (now: number) => void;
  lastActivityAtMs: number;
  pauseGeneration: number;
  stoppedThreadId: number | undefined;
  allThreadsStopped: boolean;
  supportsSetVariable: boolean;
  outputAcceptedBytes: number;
  outputTruncatedEvents: number;
  nextAttemptId: number;
  activeAttempt: InternalStartupAttempt | undefined;
  lifecycleAttemptId: number | undefined;
  readonly pendingLaunches: Set<number>;
  protocol: DebugProtocolPort | undefined;
  disposeAttachedProtocol: () => void;
  endpoint: DebugEndpointResource | undefined;
  readonly resources: { readonly resource: DebugDisposableResource; cleaned: boolean }[];
  terminalEvidence: DebugLifecycleEvidence[];
  teardownPromise: Promise<void> | undefined;
  resolveTeardown: () => void;
  reconcilePromise: Promise<void> | undefined;
  terminationRetryScheduled: boolean;
}

interface ReplayEntry {
  readonly expiresAtMs: number;
}

function registryError(code: DebugRegistryError["code"]): DebugRegistryError {
  const error = new Error(code) as DebugRegistryError;
  error.name = "DebugRegistryError";
  Object.defineProperty(error, "code", { value: code, enumerable: true });
  return error;
}

function noopResolve(): void {
  // No teardown waiter exists before a session enters its terminal path.
}

function noopTerminalProjector(_now: number): void {
  // Terminal evidence is projected only after teardown starts.
}

export function createDebugSessionRegistry(deps: DebugSessionRegistryDeps): DebugSessionRegistry {
  const sessions = new Map<string, SessionRuntime>();
  const replayEntries = new Map<string, ReplayEntry>();
  return createApi(sessions, replayEntries, deps);
}

function createApi(
  sessions: Map<string, SessionRuntime>,
  replayEntries: Map<string, ReplayEntry>,
  deps: DebugSessionRegistryDeps,
): DebugSessionRegistry {
  return {
    reserveProvisional: (input) => reserveProvisional(sessions, deps, input),
    promoteReservation: (sessionId, promotion) =>
      promoteReservation(sessions, replayEntries, deps, sessionId, promotion),
    reserve: (input) => reserve(sessions, replayEntries, deps, input),
    ...createStartupApi(sessions, deps),
    ...createSessionControls(sessions, deps),
    protocol: (sessionId) => requiredProtocol(workSession(sessions, sessionId)),
    acceptOutput: (sessionId, bytes) => acceptOutput(sessions, deps, sessionId, bytes),
    acceptOutputForAttempt: (sessionId, attemptId, bytes) =>
      isAttemptCurrent(sessions, sessionId, attemptId)
        ? acceptOutput(sessions, deps, sessionId, bytes)
        : Promise.resolve(undefined),
    stop: (sessionId) => teardown(sessions, deps, sessionId, "stopped"),
    revoke: (sessionId) => teardown(sessions, deps, sessionId, "activationRevoked"),
    teardown: (sessionId, reason) => teardown(sessions, deps, sessionId, reason),
    reconcile: () => reconcileAll(sessions, deps),
    expiredSessions: () => expiredSessions(sessions, deps.now()),
    health: () => registryHealth(sessions),
    ...createBindingApi(sessions),
  };
}

function createStartupApi(
  sessions: Map<string, SessionRuntime>,
  deps: DebugSessionRegistryDeps,
): Pick<
  DebugSessionRegistry,
  | "rollbackProvisional"
  | "beginStartupAttempt"
  | "completeLaunchFailure"
  | "attachCapsule"
  | "capsuleExited"
  | "isAttemptCurrent"
  | "attachProtocol"
  | "attachEndpoint"
  | "attachResource"
  | "markInitializing"
  | "setCapabilities"
  | "markRunning"
> {
  return {
    rollbackProvisional: (sessionId): void => {
      rollbackProvisional(sessions, sessionId);
    },
    beginStartupAttempt: (sessionId) => beginStartupAttempt(sessions, deps, sessionId),
    completeLaunchFailure: (sessionId, attemptId) =>
      completeLaunchFailure(sessions, deps, sessions.get(sessionId), attemptId),
    attachCapsule: (sessionId, attemptId, handle, qualification) =>
      attachCapsule(sessions, deps, sessions.get(sessionId), attemptId, handle, qualification),
    capsuleExited: (sessionId, attemptId) => capsuleExited(sessions, deps, sessionId, attemptId),
    isAttemptCurrent: (sessionId, attemptId) => isAttemptCurrent(sessions, sessionId, attemptId),
    attachProtocol: (sessionId, attemptId, port): void => {
      attachProtocol(required(sessions, sessionId), attemptId, port);
    },
    attachEndpoint: (sessionId, attemptId, endpoint) =>
      attachEndpoint(sessions.get(sessionId), attemptId, endpoint),
    attachResource: (sessionId, resource): void => {
      attachResource(sessions, sessionId, resource);
    },
    markInitializing: (sessionId, attemptId): void => {
      transitionStartup(required(sessions, sessionId), attemptId, "starting");
    },
    setCapabilities: (sessionId, attemptId, capabilities): void => {
      const session = required(sessions, sessionId);
      assertAttempt(session, attemptId);
      session.supportsSetVariable = capabilities.supportsSetVariable;
    },
    markRunning: (sessionId, attemptId) =>
      markRunning(sessions, deps, required(sessions, sessionId), attemptId),
  };
}

function createBindingApi(
  sessions: Map<string, SessionRuntime>,
): Pick<
  DebugSessionRegistry,
  | "isBoundTo"
  | "sessionBinding"
  | "boundSessionId"
  | "workspaceSessionId"
  | "session"
  | "sessionIds"
> {
  return {
    isBoundTo: (sessionId, workspacePartitionKey, browserSessionBinding): boolean =>
      sessionIsBound(sessions.get(sessionId), workspacePartitionKey, browserSessionBinding),
    sessionBinding: (sessionId): DebugSessionBinding | undefined =>
      bindingFor(sessions.get(sessionId)),
    boundSessionId: (workspacePartitionKey, browserSessionBinding) =>
      [...sessions.values()].find(
        (session) =>
          session.input.workspacePartitionKey === workspacePartitionKey &&
          session.input.browserSessionBinding === browserSessionBinding,
      )?.input.sessionId,
    workspaceSessionId: (workspacePartitionKey) =>
      [...sessions.values()].find(
        (session) => session.input.workspacePartitionKey === workspacePartitionKey,
      )?.input.sessionId,
    session: (sessionId) => projectOptional(sessions.get(sessionId)),
    sessionIds: () => [...sessions.keys()],
  };
}

function sessionIsBound(
  session: SessionRuntime | undefined,
  workspacePartitionKey: string,
  browserSessionBinding: string,
): boolean {
  return (
    session?.input.workspacePartitionKey === workspacePartitionKey &&
    session.input.browserSessionBinding === browserSessionBinding
  );
}

function bindingFor(session: SessionRuntime | undefined): DebugSessionBinding | undefined {
  const input = session?.input;
  return input === undefined
    ? undefined
    : Object.freeze({
        workspaceId: input.workspaceId,
        workspacePartitionKey: input.workspacePartitionKey,
        browserSessionBinding: input.browserSessionBinding,
      });
}

function createSessionControls(
  sessions: Map<string, SessionRuntime>,
  deps: DebugSessionRegistryDeps,
): Pick<DebugSessionRegistry, "pause" | "resume" | "pauseContext" | "touch" | "isCurrentPause"> {
  return {
    pause: (sessionId, threadId, allThreadsStopped) =>
      pause(workSession(sessions, sessionId), threadId, allThreadsStopped),
    resume: (sessionId): void => {
      resume(workSession(sessions, sessionId));
    },
    pauseContext: (sessionId): DebugPauseContext | undefined => {
      const session = sessions.get(sessionId);
      if (session?.state !== "paused") return undefined;
      return {
        pauseGeneration: session.pauseGeneration,
        threadId: session.stoppedThreadId,
        allThreadsStopped: session.allThreadsStopped,
      };
    },
    touch: (sessionId): void => {
      touch(workSession(sessions, sessionId), deps.now());
    },
    isCurrentPause: (sessionId, generation) => isCurrentPause(sessions.get(sessionId), generation),
  };
}

function isAttemptCurrent(
  sessions: ReadonlyMap<string, SessionRuntime>,
  sessionId: string,
  attemptId: number,
): boolean {
  return sessions.get(sessionId)?.lifecycleAttemptId === attemptId;
}

function attachResource(
  sessions: Map<string, SessionRuntime>,
  sessionId: string,
  resource: DebugDisposableResource,
): void {
  required(sessions, sessionId).resources.push({ resource, cleaned: false });
}

async function reserve(
  sessions: Map<string, SessionRuntime>,
  replayEntries: Map<string, ReplayEntry>,
  deps: DebugSessionRegistryDeps,
  input: DebugReservationInput,
): Promise<DebugSessionProjection> {
  reserveProvisional(sessions, deps, input);
  try {
    await promoteReservation(sessions, replayEntries, deps, input.sessionId, input);
    return projection(required(sessions, input.sessionId));
  } catch (error: unknown) {
    rollbackProvisional(sessions, input.sessionId);
    throw error;
  }
}

function reserveProvisional(
  sessions: Map<string, SessionRuntime>,
  deps: DebugSessionRegistryDeps,
  input: DebugProvisionalReservationInput,
): DebugSessionProjection {
  assertCapacity(sessions, input);
  const now = deps.now();
  const session: SessionRuntime = {
    input,
    promotion: undefined,
    startedAtMs: now,
    restartThrottle: createDapRestartThrottle(),
    capsules: [],
    state: "reserved",
    terminalReason: undefined,
    projectTerminal: noopTerminalProjector,
    lastActivityAtMs: now,
    pauseGeneration: 0,
    stoppedThreadId: undefined,
    // Stryker disable next-line BooleanLiteral: this field is projected only while paused, where
    // pause() overwrites it from the typed DAP event before any projection can be observed.
    allThreadsStopped: false,
    supportsSetVariable: false,
    outputAcceptedBytes: 0,
    outputTruncatedEvents: 0,
    nextAttemptId: 0,
    activeAttempt: undefined,
    lifecycleAttemptId: undefined,
    pendingLaunches: new Set(),
    protocol: undefined,
    disposeAttachedProtocol: noopResolve,
    endpoint: undefined,
    resources: [],
    terminalEvidence: [],
    teardownPromise: undefined,
    resolveTeardown: noopResolve,
    reconcilePromise: undefined,
    terminationRetryScheduled: false,
  };
  sessions.set(input.sessionId, session);
  return projection(session);
}

async function promoteReservation(
  sessions: Map<string, SessionRuntime>,
  replayEntries: Map<string, ReplayEntry>,
  deps: DebugSessionRegistryDeps,
  sessionId: string,
  promotion: DebugReservationPromotion,
): Promise<void> {
  const session = required(sessions, sessionId);
  if (session.promotion !== undefined) throw registryError("INVALID_CAPSULE_PLAN");
  const now = deps.now();
  let replayKey: string;
  try {
    replayKey = claimReplayEntry(replayEntries, session, promotion, now);
  } catch (error: unknown) {
    sessions.delete(sessionId);
    throw error;
  }
  session.promotion = promotion;
  try {
    await append(deps, session, lifecycleEvidence(session, "start", "starting", "requested", now));
    session.state = "starting";
  } catch (error: unknown) {
    replayEntries.delete(replayKey);
    sessions.delete(sessionId);
    throw error;
  }
}

function rollbackProvisional(sessions: Map<string, SessionRuntime>, sessionId: string): void {
  const session = sessions.get(sessionId);
  if (session?.promotion === undefined) sessions.delete(sessionId);
}

function beginStartupAttempt(
  sessions: Map<string, SessionRuntime>,
  deps: DebugSessionRegistryDeps,
  sessionId: string,
): Promise<DebugStartupAttempt> {
  const session = required(sessions, sessionId);
  if (session.promotion === undefined) throw registryError("INVALID_CAPSULE_PLAN");
  assertAcceptingStartup(session);
  const now = deps.now();
  if (session.promotion.planExpiresAtMs <= now) {
    return teardown(sessions, deps, session.input.sessionId, "startupFailed").then(() =>
      Promise.reject(registryError("INVALID_CAPSULE_PLAN")),
    );
  }
  if (!session.restartThrottle.mayStart(now, false)) {
    return teardown(sessions, deps, session.input.sessionId, "restartThrottled").then(() =>
      Promise.reject(registryError("STARTUP_THROTTLED")),
    );
  }
  const attempt = { attemptId: ++session.nextAttemptId, controller: new AbortController() };
  session.activeAttempt = attempt;
  session.pendingLaunches.add(attempt.attemptId);
  return Promise.resolve({ attemptId: attempt.attemptId, signal: attempt.controller.signal });
}

function assertAcceptingStartup(session: SessionRuntime): void {
  if (isTerminating(session)) throw registryError("SESSION_TERMINATING");
  if (session.activeAttempt !== undefined) throw registryError("CAPACITY");
}

async function completeLaunchFailure(
  sessions: Map<string, SessionRuntime>,
  deps: DebugSessionRegistryDeps,
  session: SessionRuntime | undefined,
  attemptId: number,
): Promise<boolean> {
  if (session === undefined) return false;
  session.pendingLaunches.delete(attemptId);
  await reconcileSession(sessions, deps, session);
  if (isTerminating(session)) return false;
  return releaseStartupAttempt(sessions, deps, session, attemptId);
}

async function attachCapsule(
  sessions: Map<string, SessionRuntime>,
  deps: DebugSessionRegistryDeps,
  session: SessionRuntime | undefined,
  attemptId: number,
  handle: QualifiedDebugCapsuleHandle,
  qualification: DebugCapsuleQualification,
): Promise<boolean> {
  if (session === undefined) {
    await superviseCapsuleTermination(handle, qualification);
    return false;
  }
  session.pendingLaunches.delete(attemptId);
  if (!qualificationMatches(session, qualification)) {
    await teardown(sessions, deps, session.input.sessionId, "startupFailed");
    await superviseCapsuleTermination(handle, {
      backend: requiredPromotion(session).backend,
      runtimeIdentityDigest: requiredPromotion(session).runtimeIdentityDigest,
    });
    return false;
  }
  const resource: CapsuleResource = {
    attemptId,
    handle,
  };
  session.capsules.push(resource);
  const current = session.activeAttempt?.attemptId === attemptId;
  if (handle.planId !== requiredPromotion(session).planId) {
    await teardown(sessions, deps, session.input.sessionId, "startupFailed");
    return false;
  }
  if (!current) return rejectStaleCapsule(session, resource, qualification);
  if (isTerminating(session)) {
    await reconcileSession(sessions, deps, session);
    return false;
  }
  session.lifecycleAttemptId = attemptId;
  return true;
}

async function rejectStaleCapsule(
  session: SessionRuntime,
  resource: CapsuleResource,
  qualification: DebugCapsuleQualification,
): Promise<boolean> {
  session.capsules.pop();
  await superviseCapsuleTermination(resource.handle, qualification);
  return false;
}

function qualificationMatches(
  session: SessionRuntime,
  qualification: DebugCapsuleQualification,
): boolean {
  return (
    qualification.backend === requiredPromotion(session).backend &&
    qualification.runtimeIdentityDigest === requiredPromotion(session).runtimeIdentityDigest
  );
}

async function capsuleExited(
  sessions: Map<string, SessionRuntime>,
  deps: DebugSessionRegistryDeps,
  sessionId: string,
  attemptId: number,
): Promise<void> {
  const session = sessions.get(sessionId);
  if (session === undefined) return;
  if (session.lifecycleAttemptId !== attemptId || isTerminating(session)) return;
  await teardown(sessions, deps, sessionId, "debuggeeExit");
}

function attachProtocol(session: SessionRuntime, attemptId: number, port: DebugProtocolPort): void {
  assertAttempt(session, attemptId);
  if (isTerminating(session)) throw registryError("SESSION_TERMINATING");
  session.protocol = port;
  session.disposeAttachedProtocol = createProtocolDisposer(port);
}

async function attachEndpoint(
  session: SessionRuntime | undefined,
  attemptId: number,
  endpoint: DebugEndpointResource,
): Promise<void> {
  if (
    session === undefined ||
    session.activeAttempt?.attemptId !== attemptId ||
    isTerminating(session)
  ) {
    await closeDetachedEndpoint(endpoint);
    throw registryError("SESSION_TERMINATING");
  }
  session.endpoint = endpoint;
}

function transitionStartup(session: SessionRuntime, attemptId: number, state: "starting"): void {
  assertAttempt(session, attemptId);
  if (isTerminating(session)) throw registryError("SESSION_TERMINATING");
  session.state = state;
}

async function markRunning(
  sessions: Map<string, SessionRuntime>,
  deps: DebugSessionRegistryDeps,
  session: SessionRuntime,
  attemptId: number,
): Promise<void> {
  assertAttempt(session, attemptId);
  if (isTerminating(session)) throw registryError("SESSION_TERMINATING");
  try {
    await append(
      deps,
      session,
      lifecycleEvidence(session, "active", "running", "requested", deps.now()),
    );
  } catch (error: unknown) {
    void teardown(sessions, deps, session.input.sessionId, "startupFailed");
    throw error;
  }
  assertAttempt(session, attemptId);
  if (isTerminating(session)) throw registryError("SESSION_TERMINATING");
  // A compliant adapter can stop immediately after configuration. Preserve that observed pause if
  // it arrived while durable activation evidence was being appended.
  if (session.state !== "paused") session.state = "running";
  session.activeAttempt = undefined;
}

async function releaseStartupAttempt(
  sessions: Map<string, SessionRuntime>,
  deps: DebugSessionRegistryDeps,
  session: SessionRuntime,
  attemptId: number,
): Promise<boolean> {
  assertAttempt(session, attemptId);
  session.activeAttempt = undefined;
  disposeProtocol(session);
  const endpointClosing = closeEndpoint(session);
  const complete = await terminateCapsules(session);
  const endpointClosed = await endpointClosing;
  if (!complete || !endpointClosed) {
    void teardown(sessions, deps, session.input.sessionId, "startupFailed");
    return false;
  }
  session.capsules.length = 0;
  session.lifecycleAttemptId = undefined;
  session.state = "starting";
  await reconcileSession(sessions, deps, session);
  return true;
}

function assertAttempt(session: SessionRuntime, attemptId: number): void {
  if (session.activeAttempt?.attemptId !== attemptId) {
    throw registryError("SESSION_TERMINATING");
  }
}

function pause(
  session: SessionRuntime,
  threadId: number | undefined,
  allThreadsStopped: boolean,
): number {
  session.pauseGeneration += 1;
  session.state = "paused";
  session.stoppedThreadId = threadId;
  session.allThreadsStopped = allThreadsStopped;
  return session.pauseGeneration;
}

function resume(session: SessionRuntime): void {
  session.pauseGeneration += 1;
  session.state = "running";
  session.stoppedThreadId = undefined;
  // Stryker disable next-line BooleanLiteral: running sessions have no pause projection; the
  // next pause() supplies the authoritative DAP allThreadsStopped value before it is readable.
  session.allThreadsStopped = false;
}

function touch(session: SessionRuntime, now: number): void {
  session.lastActivityAtMs = now;
}

function isCurrentPause(session: SessionRuntime | undefined, generation: number): boolean {
  if (session === undefined) return false;
  if (session.state !== "paused") return false;
  return session.pauseGeneration === generation;
}

async function acceptOutput(
  sessions: Map<string, SessionRuntime>,
  deps: DebugSessionRegistryDeps,
  sessionId: string,
  bytes: Buffer,
): Promise<DebugOutputAcceptance> {
  const session = workSession(sessions, sessionId);
  const acceptance = projectOutput(session, bytes);
  if (acceptance.limitReached) {
    const terminal = teardown(sessions, deps, sessionId, "outputOverflow");
    emitOutputLimitOnce(deps, session);
    await terminal;
  }
  return acceptance;
}

function emitOutputLimitOnce(deps: DebugSessionRegistryDeps, session: SessionRuntime): void {
  try {
    const notification = deps.emitOutputLimit({
      kind: "output-limit",
      sessionId: session.input.sessionId,
      acceptedBytes: session.outputAcceptedBytes,
    });
    void Promise.resolve(notification).catch(ignoreNotificationError);
  } catch {
    // The optional live projection cannot weaken the already-started canonical terminal path.
  }
}

function ignoreNotificationError(): void {
  // The optional live projection cannot weaken the already-started canonical terminal path.
}

function projectOutput(session: SessionRuntime, bytes: Buffer): DebugOutputAcceptance {
  const remaining = Math.max(0, DEBUG_MAX_SESSION_OUTPUT_BYTES - session.outputAcceptedBytes);
  const acceptedForSession = Math.min(bytes.length, remaining);
  const eventTruncated = acceptedForSession > DEBUG_MAX_OUTPUT_EVENT_BYTES;
  const accepted = eventTruncated
    ? truncateUtf8WithMarker(bytes.subarray(0, acceptedForSession))
    : bytes.subarray(0, acceptedForSession);
  const retainedContent = eventTruncated
    ? accepted.length - OUTPUT_TRUNCATION_MARKER.length
    : accepted.length;
  const omittedBytes = bytes.length - retainedContent;
  session.outputAcceptedBytes += acceptedForSession;
  if (omittedBytes !== 0) session.outputTruncatedEvents += 1;
  return { accepted, omittedBytes, limitReached: acceptedForSession === remaining };
}

function truncateUtf8WithMarker(bytes: Buffer): Buffer {
  const contentCap = DEBUG_MAX_OUTPUT_EVENT_BYTES - OUTPUT_TRUNCATION_MARKER.length;
  const maximum = Math.min(bytes.length, contentCap);
  const end = [maximum, maximum - 1, maximum - 2, maximum - 3].find((candidate) =>
    isUtf8(bytes.subarray(0, candidate)),
  );
  const content = bytes.subarray(0, end ?? 0);
  return Buffer.concat([content, OUTPUT_TRUNCATION_MARKER]);
}

function teardown(
  sessions: Map<string, SessionRuntime>,
  deps: DebugSessionRegistryDeps,
  sessionId: string,
  reason: DebugLifecycleReason,
): Promise<void> {
  const session = sessions.get(sessionId);
  if (session === undefined) return Promise.resolve();
  if (session.teardownPromise !== undefined) return session.teardownPromise;
  session.state = "stopping";
  session.terminalReason = reason;
  session.projectTerminal = (now): void => {
    prepareTerminalEvidence(session, now, reason);
  };
  session.pauseGeneration += 1;
  abortAttempt(session);
  session.teardownPromise = new Promise<void>((resolve) => {
    session.resolveTeardown = resolve;
  });
  void reconcileSession(sessions, deps, session);
  return session.teardownPromise;
}

async function reconcileAll(
  sessions: Map<string, SessionRuntime>,
  deps: DebugSessionRegistryDeps,
): Promise<void> {
  for (const session of [...sessions.values()]) await reconcileSession(sessions, deps, session);
}

async function reconcileSession(
  sessions: Map<string, SessionRuntime>,
  deps: DebugSessionRegistryDeps,
  session: SessionRuntime,
): Promise<void> {
  const previous = session.reconcilePromise ?? Promise.resolve();
  const operation = previous.then(async () => {
    await runReconcile(sessions, deps, session);
  });
  session.reconcilePromise = operation;
  await operation;
}

async function runReconcile(
  sessions: Map<string, SessionRuntime>,
  deps: DebugSessionRegistryDeps,
  session: SessionRuntime,
): Promise<void> {
  if (sessions.get(session.input.sessionId) !== session || session.teardownPromise === undefined) {
    return;
  }
  disposeProtocol(session);
  const endpointClosing = closeEndpoint(session);
  const capsuleCount = session.capsules.length;
  const terminated = await terminateCapsules(session);
  const endpointClosed = await endpointClosing;
  const resourcesCleaned = cleanupResources(session);
  if (
    !terminated ||
    !endpointClosed ||
    !resourcesCleaned ||
    session.pendingLaunches.size !== 0 ||
    session.capsules.length !== capsuleCount
  ) {
    session.state = "terminationPending";
    scheduleTerminationReconcile(sessions, deps, session);
    return;
  }
  session.capsules.length = 0;
  session.projectTerminal(deps.now());
  if (!(await appendTerminalEvidence(deps, session))) return;
  sessions.delete(session.input.sessionId);
  session.resolveTeardown();
  session.resolveTeardown = noopResolve;
}

const TERMINATION_RECONCILE_RETRY_MS = 250;

function scheduleTerminationReconcile(
  sessions: Map<string, SessionRuntime>,
  deps: DebugSessionRegistryDeps,
  session: SessionRuntime,
): void {
  if (session.terminationRetryScheduled) return;
  session.terminationRetryScheduled = true;
  const timer = setTimeout(() => {
    session.terminationRetryScheduled = false;
    void reconcileSession(sessions, deps, session);
  }, TERMINATION_RECONCILE_RETRY_MS);
  timer.unref();
}

async function terminateCapsules(session: SessionRuntime): Promise<boolean> {
  let complete = true;
  for (const resource of session.capsules) {
    resource.status = await superviseCapsuleTermination(
      resource.handle,
      {
        backend: requiredPromotion(session).backend,
        runtimeIdentityDigest: requiredPromotion(session).runtimeIdentityDigest,
      },
      resource.status,
    );
    if (!resource.status.terminated || !resource.status.cleanupComplete) complete = false;
  }
  return complete;
}

function disposeProtocol(session: SessionRuntime): void {
  session.protocol = undefined;
  const dispose = session.disposeAttachedProtocol;
  session.disposeAttachedProtocol = noopResolve;
  dispose();
}

function createProtocolDisposer(protocol: DebugProtocolPort): () => void {
  return (): void => {
    try {
      protocol.dispose();
    } catch {
      // Process-scope termination remains authoritative even if protocol disposal fails.
    }
  };
}

async function closeEndpoint(session: SessionRuntime): Promise<boolean> {
  const endpoint = session.endpoint;
  if (endpoint === undefined) return true;
  const result = (await Promise.allSettled([closeWithDeadline(endpoint)]))[0];
  if (result.status !== "fulfilled") return false;
  session.endpoint = undefined;
  return true;
}

const ENDPOINT_CLOSE_DEADLINE_MS = 250;

async function closeWithDeadline(endpoint: DebugEndpointResource): Promise<void> {
  const closing = endpoint.close();
  if (await settlesWithinDeadline(closing)) return;
  endpoint.destroy();
  if (await settlesWithinDeadline(closing)) return;
  throw new Error("DEBUG_ENDPOINT_CLOSE_TIMEOUT");
}

function settlesWithinDeadline(operation: Promise<void>): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve(false);
    }, ENDPOINT_CLOSE_DEADLINE_MS);
    timer.unref();
    void operation.then(
      () => {
        clearTimeout(timer);
        resolve(true);
      },
      () => {
        clearTimeout(timer);
        resolve(false);
      },
    );
  });
}

async function closeDetachedEndpoint(endpoint: DebugEndpointResource): Promise<void> {
  try {
    await closeWithDeadline(endpoint);
  } catch {
    // The endpoint is force-destroyed by closeWithDeadline and never becomes manager-owned.
  }
}

function cleanupResources(session: SessionRuntime): boolean {
  let complete = true;
  for (const entry of session.resources) {
    if (entry.cleaned) continue;
    try {
      entry.resource.cleanup();
      entry.cleaned = true;
    } catch {
      complete = false;
    }
  }
  return complete;
}

function abortAttempt(session: SessionRuntime): void {
  session.activeAttempt?.controller.abort();
}

function prepareTerminalEvidence(
  session: SessionRuntime,
  now: number,
  reason: DebugLifecycleReason,
): void {
  if (session.terminalEvidence.length > 0) return;
  const terminal = terminalState(reason);
  session.state = terminal.state;
  session.terminalEvidence.push(
    lifecycleEvidence(session, terminal.eventKind, terminal.state, reason, now),
    lifecycleEvidence(session, "teardown", terminal.state, reason, now),
  );
}

function terminalState(reason: DebugLifecycleReason): {
  readonly state: "stopped" | "failed" | "revoked" | "restartThrottled";
  readonly eventKind: "stop" | "failure" | "session-revoked";
} {
  if (reason === "activationRevoked") return { state: "revoked", eventKind: "session-revoked" };
  if (reason === "stopped") return { state: "stopped", eventKind: "stop" };
  if (reason === "restartThrottled") {
    return { state: "restartThrottled", eventKind: "failure" };
  }
  return { state: "failed", eventKind: "failure" };
}

async function appendTerminalEvidence(
  deps: DebugSessionRegistryDeps,
  session: SessionRuntime,
): Promise<boolean> {
  if (!(await appendTerminalHead(deps, session))) return false;
  if (session.terminalEvidence.length !== 0 && !(await appendTerminalHead(deps, session))) {
    return false;
  }
  return true;
}

async function appendTerminalHead(
  deps: DebugSessionRegistryDeps,
  session: SessionRuntime,
): Promise<boolean> {
  const record = asNonEmptyEvidence(session.terminalEvidence)[0];
  const result = (await Promise.allSettled([append(deps, session, record)]))[0];
  if (result.status !== "fulfilled") return false;
  session.terminalEvidence.shift();
  return true;
}

function asNonEmptyEvidence(
  records: DebugLifecycleEvidence[],
): [DebugLifecycleEvidence, ...DebugLifecycleEvidence[]] {
  return records as [DebugLifecycleEvidence, ...DebugLifecycleEvidence[]];
}

function lifecycleEvidence(
  session: SessionRuntime,
  eventKind: DebugLifecycleEvidence["eventKind"],
  state: DebugSessionState,
  reason: DebugLifecycleReason,
  timestampMs: number,
): DebugLifecycleEvidence {
  return {
    schemaVersion: "1",
    eventKind,
    sessionId: session.input.sessionId,
    state,
    reason,
    targetKind: session.input.targetKind,
    backend: requiredPromotion(session).backend,
    network: session.input.network,
    filesystem: session.input.filesystem,
    provisioningDigest: requiredPromotion(session).provisioningDigest,
    timestampMs,
    activationRevision: session.input.activationRevision,
    outputAcceptedBytes: session.outputAcceptedBytes,
    outputTruncatedEvents: session.outputTruncatedEvents,
  };
}

function append(
  deps: DebugSessionRegistryDeps,
  session: SessionRuntime,
  evidence: DebugLifecycleEvidence,
): Promise<void> {
  return deps.appendEvidence(session.input.workspacePartitionKey, evidence);
}

function assertCapacity(
  sessions: Map<string, SessionRuntime>,
  input: DebugProvisionalReservationInput,
): void {
  const health = registryHealth(sessions);
  if (health === "terminationPending") throw registryError("TERMINATION_PENDING");
  if (health === "evidencePending") throw registryError("EVIDENCE_PENDING");
  if (sessions.has(input.sessionId) || sessions.size >= DEBUG_MAX_SESSIONS_PER_SERVER) {
    throw registryError("CAPACITY");
  }
  if (
    [...sessions.values()].some(
      (session) => session.input.workspacePartitionKey === input.workspacePartitionKey,
    )
  ) {
    throw registryError("CAPACITY");
  }
}

function claimReplayEntry(
  replayEntries: Map<string, ReplayEntry>,
  session: SessionRuntime,
  promotion: DebugReservationPromotion,
  now: number,
): string {
  purgeExpiredReplayEntries(replayEntries, now);
  if (!validPromotion(promotion, now)) throw registryError("INVALID_CAPSULE_PLAN");
  const key = JSON.stringify([
    session.input.activationRevision,
    promotion.planEpoch,
    promotion.planId,
  ]);
  if (replayEntries.has(key) || replayEntries.size >= DEBUG_MAX_REPLAY_ENTRIES) {
    throw registryError("CAPACITY");
  }
  replayEntries.set(key, { expiresAtMs: promotion.planExpiresAtMs });
  return key;
}

function validPromotion(promotion: DebugReservationPromotion, now: number): boolean {
  return (
    promotion.planId.length > 0 &&
    Number.isSafeInteger(promotion.planEpoch) &&
    promotion.planEpoch >= 0 &&
    Number.isSafeInteger(promotion.planExpiresAtMs) &&
    promotion.planExpiresAtMs > now &&
    ["oci", "linuxNamespace", "windowsContainer"].includes(promotion.backend) &&
    isSha256Digest(promotion.provisioningDigest) &&
    isSha256Digest(promotion.runtimeIdentityDigest)
  );
}

function purgeExpiredReplayEntries(replayEntries: Map<string, ReplayEntry>, now: number): void {
  for (const [key, entry] of replayEntries) {
    if (entry.expiresAtMs <= now) replayEntries.delete(key);
  }
}

function registryHealth(sessions: Map<string, SessionRuntime>): DebugRegistryHealth {
  if ([...sessions.values()].some((session) => session.terminalEvidence.length > 0)) {
    return "evidencePending";
  }
  return [...sessions.values()].some((session) => session.teardownPromise !== undefined)
    ? "terminationPending"
    : "ready";
}

function required(sessions: Map<string, SessionRuntime>, sessionId: string): SessionRuntime {
  const session = sessions.get(sessionId);
  if (session === undefined) throw registryError("SESSION_NOT_FOUND");
  return session;
}

function requiredPromotion(session: SessionRuntime): DebugReservationPromotion {
  // Every lifecycle/capsule caller is downstream of successful atomic promotion.
  assert.ok(session.promotion);
  return session.promotion;
}

function workSession(sessions: Map<string, SessionRuntime>, sessionId: string): SessionRuntime {
  const session = required(sessions, sessionId);
  if (isTerminating(session)) throw registryError("SESSION_TERMINATING");
  return session;
}

function requiredProtocol(session: SessionRuntime): DebugProtocolPort {
  if (session.protocol === undefined) throw registryError("SESSION_NOT_FOUND");
  return session.protocol;
}

function isTerminating(session: SessionRuntime): boolean {
  return session.teardownPromise !== undefined;
}

function projection(session: SessionRuntime): DebugSessionProjection {
  return {
    sessionId: session.input.sessionId,
    targetKind: session.input.targetKind,
    state: session.state,
    terminalReason: session.terminalReason,
    activationRevision: session.input.activationRevision,
    pauseGeneration: session.pauseGeneration,
    startedAtMs: session.startedAtMs,
    lastActivityAtMs: session.lastActivityAtMs,
    outputAcceptedBytes: session.outputAcceptedBytes,
    outputTruncatedEvents: session.outputTruncatedEvents,
    pendingRequestCount: session.protocol?.pendingCount() ?? 0,
    startupAttemptCount: session.restartThrottle.attemptCount(),
    health:
      session.terminalEvidence.length > 0
        ? "evidencePending"
        : session.teardownPromise !== undefined
          ? "terminationPending"
          : "ready",
    supportsSetVariable: session.supportsSetVariable,
  };
}

function projectOptional(session: SessionRuntime | undefined): DebugSessionProjection | undefined {
  return session === undefined ? undefined : projection(session);
}

function expirationReason(
  session: SessionRuntime,
  now: number,
): "wallTimeout" | "inactivityTimeout" | undefined {
  if (isTerminating(session)) return undefined;
  if (now - session.startedAtMs > DEBUG_WALL_TIMEOUT_MS) return "wallTimeout";
  return now - session.lastActivityAtMs > DEBUG_IDLE_TIMEOUT_MS ? "inactivityTimeout" : undefined;
}

function expiredSessions(
  sessions: Map<string, SessionRuntime>,
  now: number,
): readonly { readonly sessionId: string; readonly reason: "wallTimeout" | "inactivityTimeout" }[] {
  const expired: { sessionId: string; reason: "wallTimeout" | "inactivityTimeout" }[] = [];
  for (const session of sessions.values()) {
    const reason = expirationReason(session, now);
    if (reason !== undefined) expired.push({ sessionId: session.input.sessionId, reason });
  }
  return expired;
}
