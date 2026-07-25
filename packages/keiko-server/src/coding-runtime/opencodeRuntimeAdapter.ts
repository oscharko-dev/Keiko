import { isAbsolute } from "node:path";

import type { CodingSafeActivitySignal } from "./codingSafeActivityProjection.js";

import { createFixedOpenCodeConfig } from "./opencodeLaunchProfile.js";
import {
  createOpenCodeReconciler,
  OPEN_CODE_EVENT_KINDS,
  type OpenCodeReconciliationEvent,
  type OpenCodeReconciliationPreparation,
  type OpenCodeReconciler,
} from "./opencodeReconciler.js";
import type { OpenCodeLiveControl } from "./opencodeProtocol.js";
import {
  OPENCODE_GOVERNED_ACTION_PERMISSION,
  OPENCODE_PINNED_VERSION,
  OPENCODE_TOOL_SOURCE_DEFINITIONS,
} from "./opencodeToolSchemas.js";

const DIGEST = /^[a-f0-9]{64}$/u;
const EVENT_ID = /^[A-Za-z0-9_-]{1,256}$/u;
const SESSION_ID = /^ses_[A-Za-z0-9_-]{1,251}$/u;
const MAX_HISTORY_EVENTS = 256;
const MAX_HISTORY_BYTES = 1024 * 1024;
const MAX_AGGREGATE_CHECKPOINTS = 256;
const MAX_RECENT_IDENTITIES = 2_048;
const MAX_HISTORY_CATCH_UP_ATTEMPTS = 4;
const MAX_STREAM_RECONNECTS = 3;
// The generated client must outlive the server-owned 30 s governed tool-bridge deadline.
const OPEN_CODE_TOOL_CLIENT_TIMEOUT_MS = 35_000;
export const OPEN_CODE_MAX_TURN_WAIT_MS = 30 * 60_000;

export type OpenCodeGovernedSinkReceipt = "applied" | "duplicate";

export type OpenCodeSyncHint =
  | { readonly id: string; readonly requiresHistoryIdentity?: true }
  | { readonly requiresHistoryIdentity: false; readonly control?: OpenCodeLiveControl };

export type OpenCodeReadinessPhase =
  | "target-attestation"
  | "config-materialization"
  | "endpoint"
  | "authenticated-health"
  | "unauthenticated-health"
  | "openapi-digest"
  | "gateway-challenge"
  | "tool-facade-challenge"
  | "sse-history-reconciliation"
  | "session-echo";

export interface OpenCodeAdapterFailure {
  readonly ok: false;
  readonly phase: OpenCodeReadinessPhase;
  readonly reason: "readiness-failed";
}

export interface OpenCodeAdapterReady {
  readonly ok: true;
  readonly endpoint: string;
  readonly sessionId: string;
  readonly configDigest: string;
}

export interface GeneratedOpenCodeBundle {
  readonly config: {
    readonly snapshot: false;
    readonly model: string;
    readonly agent: Readonly<Record<string, { readonly prompt: string }>>;
    readonly provider: Readonly<Record<string, unknown>>;
    readonly tools: Readonly<Record<string, boolean>>;
    readonly permission: Readonly<Record<string, string>>;
  };
  readonly toolSources: Readonly<Record<string, string>>;
}

export interface OpenCodeRuntimeAdapterPorts {
  readonly readiness: {
    readonly verifiedTarget: { readonly executable: string; readonly attestationDigest: string };
    readonly configDigest: string;
    readonly verifyTargetAttestation: () => Promise<boolean>;
    readonly materialize: (bundle: GeneratedOpenCodeBundle) => Promise<boolean>;
    readonly startupLine: () => Promise<string>;
    readonly health: (
      authorization: "basic" | "none",
    ) => Promise<{ readonly status: number; readonly version?: string }>;
    readonly openApiDigest: () => Promise<string>;
    readonly gatewayChallenge: () => Promise<boolean>;
    readonly toolFacadeChallenge: () => Promise<boolean>;
    readonly subscribe: (signal: AbortSignal) => AsyncIterable<OpenCodeSyncHint>;
    readonly history: (
      checkpoints: Readonly<Record<string, number>>,
      signal: AbortSignal,
    ) => Promise<readonly OpenCodeReconciliationEvent[]>;
    readonly sessionEcho: () => Promise<string>;
    readonly takeSafeActivity?:
      ((identityKey: string) => CodingSafeActivitySignal | undefined) | undefined;
    readonly clearSafeActivity?: (() => void) | undefined;
  };
  readonly governedSink: {
    readonly execute: (
      identityKey: string,
      event: OpenCodeReconciliationEvent,
    ) => Promise<OpenCodeGovernedSinkReceipt>;
  };
  readonly safeActivitySink?:
    | {
        readonly ingest: (signal: CodingSafeActivitySignal) => boolean;
        readonly recordDrops: (count: number) => void;
      }
    | undefined;
  readonly control: {
    readonly status: (
      sessionId: string,
      signal: AbortSignal,
    ) => Promise<OpenCodeLiveControl["state"] | undefined>;
  };
  readonly safety: {
    readonly revokeAudiences: () => void;
    readonly abortGovernedActions: () => void;
    readonly wipeEphemeralState: () => void;
    readonly requireManagerReap: () => void;
  };
}

export interface OpenCodeRuntimeAdapter {
  readonly start: () => Promise<OpenCodeAdapterReady | OpenCodeAdapterFailure>;
  readonly reconcile: () => Promise<OpenCodeAdapterReady | OpenCodeAdapterFailure>;
  readonly monitor: (onFailure: () => void) => () => void;
  readonly close: () => Promise<void>;
  readonly armTurn: () => boolean;
  readonly cancelTurn: () => void;
  readonly waitForTerminal: (signal: AbortSignal) => Promise<boolean>;
}

interface ReconciliationState {
  readonly checkpoints: Map<string, number>;
  readonly evidenceCheckpoints: Map<string, number>;
  readonly terminalCheckpoints: Map<string, number>;
  readonly terminalFailureCheckpoints: Map<string, number>;
  readonly recent: Map<string, string>;
  readonly observedIds: Map<string, true>;
  readonly reconciler: OpenCodeReconciler;
  reconciliationTail: Promise<void>;
}

// eslint-disable-next-line max-lines-per-function -- owns one auditable stream/reconciliation controller.
export function createOpenCodeRuntimeAdapter(
  ports: OpenCodeRuntimeAdapterPorts,
): OpenCodeRuntimeAdapter {
  const state: ReconciliationState = {
    checkpoints: new Map(),
    evidenceCheckpoints: new Map(),
    terminalCheckpoints: new Map(),
    terminalFailureCheckpoints: new Map(),
    recent: new Map(),
    observedIds: new Map(),
    reconciler: createOpenCodeReconciler(),
    reconciliationTail: Promise.resolve(),
  };
  let ready: OpenCodeAdapterReady | undefined;
  let cleanupRequested = false;
  let activeIterator: AsyncIterator<OpenCodeSyncHint> | undefined;
  let activeAbort: AbortController | undefined;
  let monitorTask: Promise<void> | undefined;
  let monitoring = false;
  let closed = false;
  let turnGeneration = 0;
  let turnArmed = false;
  let turnActive = false;
  let turnStatusTerminal = false;
  let turnBaselineSequence: number | undefined;
  let turnSettledGeneration: number | undefined;
  let turnSettledOutcome: boolean | undefined;
  const turnNotifications = new Set<() => void>();

  const fail = (phase: OpenCodeReadinessPhase): OpenCodeAdapterFailure => {
    if (!cleanupRequested) {
      cleanupRequested = true;
      runCleanup(ports.safety);
    }
    return { ok: false, phase, reason: "readiness-failed" };
  };

  const reconcile = async (): Promise<OpenCodeAdapterReady | OpenCodeAdapterFailure> => {
    if (ready === undefined) return fail("sse-history-reconciliation");
    try {
      const reconciled = await reconcileHistory(ports, state, new AbortController().signal);
      return reconciled ? ready : fail("sse-history-reconciliation");
    } catch {
      return fail("sse-history-reconciliation");
    }
  };

  return {
    start: async (): Promise<OpenCodeAdapterReady | OpenCodeAdapterFailure> => {
      const result = await startAdapter(ports, state, fail, openSubscription);
      if (result.ok) ready = result;
      return result;
    },
    reconcile,
    // eslint-disable-next-line max-lines-per-function -- monitor lifecycle stays in one auditable closure.
    monitor: (onFailure): (() => void) => {
      if (ready === undefined || closed) {
        onFailure();
        return (): void => undefined;
      }
      if (monitorTask === undefined) {
        monitoring = true;
        monitorTask = monitorLoop().finally(() => {
          monitorTask = undefined;
        });
      }
      return (): void => {
        monitoring = false;
        cancelTurn();
        activeAbort?.abort();
        void activeIterator?.return?.();
      };

      async function monitorLoop(): Promise<void> {
        let reconnects = 0;
        while (isMonitoring()) {
          try {
            await observeNextHint();
            reconnects = 0;
          } catch {
            if (!isMonitoring()) return;
            await cancelSubscription();
            reconnects += 1;
            if (reconnects > MAX_STREAM_RECONNECTS) {
              onFailure();
              return;
            }
          }
        }
      }

      async function observeNextHint(): Promise<void> {
        const { hint, signal } = await nextHint();
        if (!(await reconcileHint(ports, state, hint, signal))) {
          throw new Error("opencode-history-incomplete");
        }
        observeControl("control" in hint ? hint.control : undefined);
      }

      async function nextHint(): Promise<{
        readonly hint: OpenCodeSyncHint;
        readonly signal: AbortSignal | undefined;
      }> {
        if (activeIterator === undefined) return openSubscription();
        const next = await activeIterator.next();
        if (next.done || !validHint(next.value)) throw new Error("opencode-events-ended");
        return { hint: next.value, signal: activeAbort?.signal };
      }

      function isMonitoring(): boolean {
        return monitoring && !closed;
      }
    },
    close: async (): Promise<void> => {
      closed = true;
      monitoring = false;
      cancelTurn();
      await cancelSubscription();
      await monitorTask;
    },
    armTurn: (): boolean => {
      if (closed || ready === undefined || turnArmed) return false;
      const baselineSequence = state.checkpoints.get(ready.sessionId);
      if (baselineSequence === undefined) return false;
      turnGeneration += 1;
      turnArmed = true;
      turnActive = false;
      turnStatusTerminal = false;
      turnBaselineSequence = baselineSequence;
      turnSettledGeneration = undefined;
      turnSettledOutcome = undefined;
      return true;
    },
    cancelTurn,
    waitForTerminal,
  };

  function cancelTurn(): void {
    turnGeneration += 1;
    turnArmed = false;
    turnActive = false;
    turnStatusTerminal = false;
    turnBaselineSequence = undefined;
    turnSettledGeneration = undefined;
    turnSettledOutcome = undefined;
    notifyTurn();
  }

  function settleTurn(generation: number, outcome: boolean): void {
    turnArmed = false;
    turnActive = false;
    turnStatusTerminal = false;
    turnBaselineSequence = undefined;
    turnSettledGeneration = generation;
    turnSettledOutcome = outcome;
    notifyTurn();
  }

  function observeControl(control: OpenCodeLiveControl | undefined): void {
    if (control === undefined) return;
    if (ready !== undefined && control.sessionId !== ready.sessionId) return;
    if (!turnArmed) return;
    const changed =
      control.state === "activity" ? !turnActive || turnStatusTerminal : !turnStatusTerminal;
    if (control.state === "activity") {
      turnActive = true;
      turnStatusTerminal = false;
    } else {
      turnStatusTerminal = true;
    }
    if (changed) notifyTurn();
  }

  function notifyTurn(): void {
    for (const notify of turnNotifications) notify();
    turnNotifications.clear();
  }

  /** Active/terminal, caller, deadline, stop, and polling gates fail independently. */
  async function waitForTerminal(callerSignal: AbortSignal): Promise<boolean> {
    const generation = turnGeneration;
    if (turnSettled(generation) && !callerSignal.aborted) return turnSettledOutcome ?? false;
    if (!turnArmed || ready === undefined || closed || callerSignal.aborted) return false;
    const deadline = new AbortController();
    const timer = setTimeout(() => {
      deadline.abort();
    }, OPEN_CODE_MAX_TURN_WAIT_MS);
    timer.unref();
    const signal = AbortSignal.any([callerSignal, deadline.signal]);
    try {
      return await awaitTurnTerminal(generation, signal, ready.sessionId);
    } finally {
      clearTimeout(timer);
    }
  }

  async function awaitTurnTerminal(
    generation: number,
    signal: AbortSignal,
    sessionId: string,
  ): Promise<boolean> {
    while (turnCurrent(generation, signal)) {
      const settled = settleIfCompleted(generation, signal);
      if (settled !== undefined) return settled;
      const outcome = await pollTurnOnce(generation, signal, sessionId);
      if (outcome !== undefined) return outcome;
      await waitForTurnChange(signal, generation);
    }
    return turnSettled(generation) ? (turnSettledOutcome ?? false) : false;
  }

  /** Returns the settled wait outcome, or undefined when polling must continue. */
  async function pollTurnOnce(
    generation: number,
    signal: AbortSignal,
    sessionId: string,
  ): Promise<boolean | undefined> {
    try {
      const status = await ports.control.status(sessionId, signal);
      if (status !== undefined) observeControl({ sessionId, state: status });
      const observed = observedTurnOutcome(generation, signal);
      if (observed !== undefined || status !== "terminal") return observed;
      await reconcileHistory(ports, state, signal);
      return observedTurnOutcome(generation, signal);
    } catch {
      return turnCurrent(generation, signal) ? undefined : false;
    }
  }

  function settleIfCompleted(generation: number, signal: AbortSignal): boolean | undefined {
    const outcome = turnOutcome(generation, signal);
    if (outcome === undefined) return undefined;
    settleTurn(generation, outcome);
    return outcome;
  }

  function observedTurnOutcome(generation: number, signal: AbortSignal): boolean | undefined {
    const settled = settleIfCompleted(generation, signal);
    if (settled !== undefined) return settled;
    return turnSettled(generation) ? (turnSettledOutcome ?? false) : undefined;
  }

  function turnCurrent(generation: number, signal: AbortSignal): boolean {
    return turnArmed && !closed && !signal.aborted && generation === turnGeneration;
  }

  function turnSettled(generation: number): boolean {
    return !closed && generation === turnGeneration && generation === turnSettledGeneration;
  }

  function turnOutcome(generation: number, signal: AbortSignal): boolean | undefined {
    if (!turnCurrent(generation, signal)) return undefined;
    if (!turnStatusTerminal) return undefined;
    if (ready === undefined || turnBaselineSequence === undefined) return undefined;
    return causalHistoryOutcome(ready.sessionId, turnBaselineSequence);
  }

  function causalHistoryOutcome(sessionId: string, baselineSequence: number): boolean | undefined {
    const evidenceSequence = state.evidenceCheckpoints.get(sessionId);
    if (evidenceSequence === undefined || evidenceSequence <= baselineSequence) return undefined;
    const failureSequence = state.terminalFailureCheckpoints.get(sessionId);
    if (failureSequence !== undefined && failureSequence > baselineSequence) return false;
    const terminalSequence = state.terminalCheckpoints.get(sessionId);
    return terminalSequence !== undefined && terminalSequence > baselineSequence ? true : undefined;
  }

  function waitForTurnChange(signal: AbortSignal, generation: number): Promise<void> {
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        turnNotifications.delete(done);
        resolve();
      };
      const timer = setTimeout(done, 250);
      timer.unref();
      signal.addEventListener("abort", done, { once: true });
      if (generation !== turnGeneration || closed) done();
      else turnNotifications.add(done);
    });
  }

  async function openSubscription(): Promise<{
    readonly hint: OpenCodeSyncHint;
    readonly signal: AbortSignal;
  }> {
    if (closed) throw new Error("opencode-adapter-closed");
    if (activeIterator !== undefined) await cancelSubscription();
    activeAbort = new AbortController();
    activeIterator = ports.readiness.subscribe(activeAbort.signal)[Symbol.asyncIterator]();
    const first = await activeIterator.next();
    if (first.done || !validHint(first.value)) {
      await cancelSubscription();
      throw new Error("opencode-events-invalid");
    }
    return { hint: first.value, signal: activeAbort.signal };
  }

  async function cancelSubscription(): Promise<void> {
    const iterator = activeIterator;
    activeIterator = undefined;
    activeAbort?.abort();
    activeAbort = undefined;
    try {
      await iterator?.return?.();
    } catch {
      // Cancellation is a terminal control operation; transport errors do not reopen the stream.
    }
  }
}

// eslint-disable-next-line complexity, max-lines-per-function -- ordered readiness gates remain explicit for audit.
async function startAdapter(
  ports: OpenCodeRuntimeAdapterPorts,
  state: ReconciliationState,
  fail: (phase: OpenCodeReadinessPhase) => OpenCodeAdapterFailure,
  openSubscription: () => Promise<{
    readonly hint: OpenCodeSyncHint;
    readonly signal: AbortSignal;
  }>,
): Promise<OpenCodeAdapterReady | OpenCodeAdapterFailure> {
  const { readiness } = ports;
  let phase: OpenCodeReadinessPhase = "target-attestation";
  try {
    if (!validTarget(readiness) || !(await readiness.verifyTargetAttestation())) {
      return fail("target-attestation");
    }
    phase = "config-materialization";
    if (!(await readiness.materialize(createGeneratedOpenCodeBundle()))) {
      return fail("config-materialization");
    }
    phase = "endpoint";
    const endpoint = parseStartupEndpoint(await readiness.startupLine());
    if (endpoint === undefined) return fail("endpoint");
    phase = "authenticated-health";
    const authenticated = await readiness.health("basic");
    if (authenticated.status !== 200 || authenticated.version !== OPENCODE_PINNED_VERSION) {
      return fail("authenticated-health");
    }
    phase = "unauthenticated-health";
    const unauthenticated = await readiness.health("none");
    if (unauthenticated.status !== 401) return fail("unauthenticated-health");
    phase = "openapi-digest";
    if ((await readiness.openApiDigest()) !== readiness.verifiedTarget.attestationDigest) {
      return fail("openapi-digest");
    }
    phase = "sse-history-reconciliation";
    const firstHint = await openSubscription();
    phase = "session-echo";
    const sessionId = await readiness.sessionEcho();
    if (!SESSION_ID.test(sessionId)) return fail("session-echo");
    phase = "sse-history-reconciliation";
    if (!(await reconcileHint(ports, state, firstHint.hint, firstHint.signal))) {
      return fail("sse-history-reconciliation");
    }
    if (!state.checkpoints.has(sessionId)) return fail("session-echo");
    phase = "gateway-challenge";
    if (!(await readiness.gatewayChallenge())) return fail("gateway-challenge");
    phase = "tool-facade-challenge";
    if (!(await readiness.toolFacadeChallenge())) return fail("tool-facade-challenge");
    phase = "sse-history-reconciliation";
    if (!(await reconcileHistory(ports, state, firstHint.signal))) {
      return fail("sse-history-reconciliation");
    }
    return { ok: true, endpoint, sessionId, configDigest: readiness.configDigest };
  } catch {
    return fail(phase);
  }
}

function validTarget(readiness: OpenCodeRuntimeAdapterPorts["readiness"]): boolean {
  return (
    isAbsolute(readiness.verifiedTarget.executable) &&
    DIGEST.test(readiness.verifiedTarget.attestationDigest) &&
    DIGEST.test(readiness.configDigest)
  );
}

function parseStartupEndpoint(line: string): string | undefined {
  const match =
    /^opencode server listening on http:\/\/127\.0\.0\.1:([1-9]\d{0,4})(?:\r?\n)?$/u.exec(line);
  const port = Number(match?.[1]);
  return Number.isSafeInteger(port) && port <= 65_535
    ? `http://127.0.0.1:${String(port)}`
    : undefined;
}

async function reconcileHistory(
  ports: OpenCodeRuntimeAdapterPorts,
  state: ReconciliationState,
  signal: AbortSignal,
): Promise<boolean> {
  let release: (() => void) | undefined;
  const predecessor = state.reconciliationTail;
  state.reconciliationTail = new Promise((resolve) => {
    release = resolve;
  });
  await predecessor;
  try {
    if (signal.aborted) return false;
    const planned = await historyPlan(ports, state, signal);
    if (planned === undefined) return false;
    const prepared = state.reconciler.prepare(planned.events);
    if (!prepared.ok) return false;
    await applyHistoryPlan(ports, state, planned, prepared);
    return true;
  } finally {
    ports.readiness.clearSafeActivity?.();
    release?.();
  }
}

async function historyPlan(
  ports: OpenCodeRuntimeAdapterPorts,
  state: ReconciliationState,
  signal: AbortSignal,
): Promise<ReturnType<typeof planHistory>> {
  const events = await ports.readiness.history(checkpointSnapshot(state), signal);
  return planHistory(events, state);
}

async function reconcileThroughHint(
  ports: OpenCodeRuntimeAdapterPorts,
  state: ReconciliationState,
  hintId: string,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  const activeSignal = signal ?? new AbortController().signal;
  for (let attempt = 0; attempt < MAX_HISTORY_CATCH_UP_ATTEMPTS; attempt += 1) {
    if (!(await reconcileHistory(ports, state, activeSignal))) return false;
    if (state.observedIds.has(hintId)) return true;
  }
  return false;
}

async function reconcileHint(
  ports: OpenCodeRuntimeAdapterPorts,
  state: ReconciliationState,
  hint: OpenCodeSyncHint,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  const activeSignal = signal ?? new AbortController().signal;
  return hint.requiresHistoryIdentity === false
    ? reconcileHistory(ports, state, activeSignal)
    : reconcileThroughHint(ports, state, hint.id, activeSignal);
}

async function applyHistoryPlan(
  ports: OpenCodeRuntimeAdapterPorts,
  state: ReconciliationState,
  planned: NonNullable<ReturnType<typeof planHistory>>,
  prepared: Extract<OpenCodeReconciliationPreparation, { readonly ok: true }>,
): Promise<void> {
  const activity = takeSafeActivity(ports, planned.events);
  for (const event of prepared.projections) {
    const identity = eventIdentity(event);
    const receipt: unknown = await ports.governedSink.execute(identity, event);
    if (receipt !== "applied" && receipt !== "duplicate") throw new Error("sink-receipt-invalid");
  }
  if (!prepared.commit()) throw new Error("reconciler-commit-conflict");
  replaceMap(state.checkpoints, planned.checkpoints);
  replaceMap(state.evidenceCheckpoints, planned.evidenceCheckpoints);
  replaceMap(state.terminalCheckpoints, planned.terminalCheckpoints);
  replaceMap(state.terminalFailureCheckpoints, planned.terminalFailureCheckpoints);
  replaceMap(state.recent, planned.recent);
  replaceMap(state.observedIds, planned.observedIds);
  for (const signal of activity) {
    if (ports.safeActivitySink?.ingest(signal) === false) ports.safeActivitySink.recordDrops(1);
  }
}

function takeSafeActivity(
  ports: OpenCodeRuntimeAdapterPorts,
  events: readonly OpenCodeReconciliationEvent[],
): readonly CodingSafeActivitySignal[] {
  const signals: CodingSafeActivitySignal[] = [];
  for (const event of events) {
    const signal = ports.readiness.takeSafeActivity?.(eventIdentity(event));
    if (signal !== undefined) signals.push(signal);
  }
  return signals;
}

interface HistoryPlanDraft {
  readonly checkpoints: Map<string, number>;
  readonly evidenceCheckpoints: Map<string, number>;
  readonly terminalCheckpoints: Map<string, number>;
  readonly terminalFailureCheckpoints: Map<string, number>;
  readonly recent: Map<string, string>;
  readonly observedIds: Map<string, true>;
  readonly fresh: OpenCodeReconciliationEvent[];
}

/** Ordering, dedupe, and conflict gates fail closed independently. */
function planHistory(
  events: readonly OpenCodeReconciliationEvent[],
  state: ReconciliationState,
):
  | {
      readonly events: readonly OpenCodeReconciliationEvent[];
      readonly checkpoints: ReadonlyMap<string, number>;
      readonly evidenceCheckpoints: ReadonlyMap<string, number>;
      readonly terminalCheckpoints: ReadonlyMap<string, number>;
      readonly terminalFailureCheckpoints: ReadonlyMap<string, number>;
      readonly recent: ReadonlyMap<string, string>;
      readonly observedIds: ReadonlyMap<string, true>;
    }
  | undefined {
  if (!validHistoryWindow(events, state)) return undefined;
  const draft: HistoryPlanDraft = {
    checkpoints: new Map(state.checkpoints),
    evidenceCheckpoints: new Map(state.evidenceCheckpoints),
    terminalCheckpoints: new Map(state.terminalCheckpoints),
    terminalFailureCheckpoints: new Map(state.terminalFailureCheckpoints),
    recent: new Map(state.recent),
    observedIds: new Map(state.observedIds),
    fresh: [],
  };
  for (const event of events) {
    if (!planHistoryEvent(draft, event)) return undefined;
  }
  return {
    events: draft.fresh,
    checkpoints: draft.checkpoints,
    evidenceCheckpoints: draft.evidenceCheckpoints,
    terminalCheckpoints: draft.terminalCheckpoints,
    terminalFailureCheckpoints: draft.terminalFailureCheckpoints,
    recent: draft.recent,
    observedIds: draft.observedIds,
  };
}

function planHistoryEvent(draft: HistoryPlanDraft, event: OpenCodeReconciliationEvent): boolean {
  if (!validEvent(event)) return false;
  const key = eventIdentity(event);
  const knownDigest = draft.recent.get(key);
  if (knownDigest !== undefined) {
    if (knownDigest !== event.digest) return false;
    touch(draft.recent, key, knownDigest);
    touchObserved(draft.observedIds, event.id);
    return true;
  }
  return planFreshHistoryEvent(draft, event, key);
}

function planFreshHistoryEvent(
  draft: HistoryPlanDraft,
  event: OpenCodeReconciliationEvent,
  key: string,
): boolean {
  const checkpoint = draft.checkpoints.get(event.aggregateId);
  if (checkpoint !== undefined && event.sequence <= checkpoint) return true;
  const expected = checkpoint === undefined ? 0 : checkpoint + 1;
  if (event.sequence !== expected) return false;
  if (!setCheckpoint(draft.checkpoints, event.aggregateId, event.sequence)) return false;
  if (!setKindCheckpoint(draft, event)) return false;
  touch(draft.recent, key, event.digest);
  touchObserved(draft.observedIds, event.id);
  draft.fresh.push(event);
  return true;
}

function setKindCheckpoint(draft: HistoryPlanDraft, event: OpenCodeReconciliationEvent): boolean {
  if (event.kind === "terminal") {
    return setCheckpoint(draft.terminalCheckpoints, event.aggregateId, event.sequence);
  }
  if (event.kind === "terminal-failure") {
    return setCheckpoint(draft.terminalFailureCheckpoints, event.aggregateId, event.sequence);
  }
  if (event.kind === "terminal-control") return true;
  return setCheckpoint(draft.evidenceCheckpoints, event.aggregateId, event.sequence);
}

function validHistoryWindow(
  events: readonly OpenCodeReconciliationEvent[],
  state: ReconciliationState,
): boolean {
  return (
    events.length <= MAX_HISTORY_EVENTS &&
    Buffer.byteLength(JSON.stringify(events), "utf8") <= MAX_HISTORY_BYTES &&
    state.checkpoints.size <= MAX_AGGREGATE_CHECKPOINTS &&
    state.evidenceCheckpoints.size <= MAX_AGGREGATE_CHECKPOINTS &&
    state.terminalCheckpoints.size <= MAX_AGGREGATE_CHECKPOINTS &&
    state.terminalFailureCheckpoints.size <= MAX_AGGREGATE_CHECKPOINTS
  );
}

function setCheckpoint(
  checkpoints: Map<string, number>,
  aggregateId: string,
  sequence: number,
): boolean {
  if (!checkpoints.has(aggregateId) && checkpoints.size >= MAX_AGGREGATE_CHECKPOINTS) return false;
  checkpoints.set(aggregateId, sequence);
  return true;
}

function validHint(event: unknown): event is OpenCodeSyncHint {
  if (exactRecord(event, ["requiresHistoryIdentity"])) {
    return event.requiresHistoryIdentity === false;
  }
  if (exactRecord(event, ["id"])) return typeof event.id === "string" && EVENT_ID.test(event.id);
  if (exactRecord(event, ["requiresHistoryIdentity", "control"])) {
    return event.requiresHistoryIdentity === false && validControl(event.control);
  }
  return (
    exactRecord(event, ["id", "requiresHistoryIdentity"]) &&
    typeof event.id === "string" &&
    EVENT_ID.test(event.id) &&
    event.requiresHistoryIdentity === true
  );
}

function validControl(value: unknown): value is OpenCodeLiveControl {
  return (
    exactRecord(value, ["sessionId", "state"]) &&
    typeof value.sessionId === "string" &&
    SESSION_ID.test(value.sessionId) &&
    (value.state === "activity" || value.state === "terminal")
  );
}

function validEvent(event: OpenCodeReconciliationEvent): boolean {
  return (
    exactRecord(event, ["id", "aggregateId", "sequence", "digest", "kind"]) &&
    EVENT_ID.test(event.id) &&
    SESSION_ID.test(event.aggregateId) &&
    Number.isSafeInteger(event.sequence) &&
    event.sequence >= 0 &&
    DIGEST.test(event.digest) &&
    OPEN_CODE_EVENT_KINDS.includes(event.kind)
  );
}

function exactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => actual.includes(key));
}

function eventIdentity(event: OpenCodeReconciliationEvent): string {
  return `${event.aggregateId}\u0000${String(event.sequence)}`;
}

function touch(recent: Map<string, string>, key: string, digest: string): void {
  recent.delete(key);
  recent.set(key, digest);
  while (recent.size > MAX_RECENT_IDENTITIES) {
    const oldest = recent.keys().next().value;
    if (oldest === undefined) return;
    recent.delete(oldest);
  }
}

function touchObserved(observed: Map<string, true>, id: string): void {
  observed.delete(id);
  observed.set(id, true);
  while (observed.size > MAX_RECENT_IDENTITIES) {
    const oldest = observed.keys().next().value;
    if (oldest === undefined) return;
    observed.delete(oldest);
  }
}

function checkpointSnapshot(state: ReconciliationState): Readonly<Record<string, number>> {
  return Object.freeze(Object.fromEntries(state.checkpoints));
}

function replaceMap<K, V>(target: Map<K, V>, source: ReadonlyMap<K, V>): void {
  target.clear();
  for (const [key, value] of source) target.set(key, value);
}

function runCleanup(safety: OpenCodeRuntimeAdapterPorts["safety"]): void {
  for (const operation of [
    safety.revokeAudiences,
    safety.abortGovernedActions,
    safety.wipeEphemeralState,
    safety.requireManagerReap,
  ]) {
    try {
      operation();
    } catch {
      // Cleanup remains best-effort per port while every remaining fail-closed barrier still runs.
    }
  }
}

export function createGeneratedOpenCodeBundle(): GeneratedOpenCodeBundle {
  return {
    config: createFixedOpenCodeConfig(),
    toolSources: Object.fromEntries(
      OPENCODE_TOOL_SOURCE_DEFINITIONS.map(({ name, action, arguments: schemas }) => [
        name,
        toolSource(action, schemas),
      ]),
    ),
  };
}

type GeneratedToolAction =
  "read" | "discover" | "edit" | "verification" | "egress" | "skill" | "child-agent";

function toolDescription(action: GeneratedToolAction): string {
  if (action === "discover") {
    return (
      "Find exact workspace-relative file paths through Keiko's bounded repository discovery. " +
      "Search by short filename or path keywords before reading files; * returns only a bounded " +
      "overview. Denied and ignored paths never appear."
    );
  }
  if (action === "read") {
    return (
      "Read one repository text file through Keiko governance — the only way to observe " +
      "workspace content. startLine/maxLines select the returned line window (start at 1 with " +
      "a generous maxLines for a whole small file); the result reports totalLines plus " +
      "nextStartLine when truncated, and the whole-file SHA-256 digest that " +
      "keiko_changeset_edit requires as expectedContentHash."
    );
  }
  if (action === "egress") {
    return "Fetch one approved public https URL through governed read-only research (#2387).";
  }
  if (action === "skill") return "Invoke one exact server-approved read-only skill.";
  if (action === "child-agent") return "Run one bounded, one-layer read-only child agent.";
  if (action === "verification") {
    return (
      "Run one vetted repository verification through Keiko governance — the only way to " +
      "execute checks (there is no shell). Pick exactly one verifierId: test, targeted-test, " +
      "typecheck, lint, or build."
    );
  }
  return (
    "Submit a bounded changeset through Keiko governance — the only way to modify workspace " +
    "files. Provide one strict unified diff and, for every listed file, the " +
    "expectedContentHash digest returned by its most recent keiko_workspace_read; on a digest " +
    "mismatch re-read the file and rebuild the patch."
  );
}

function governedPermissionSource(): readonly string[] {
  return [
    `const governedPermission = ${JSON.stringify(OPENCODE_GOVERNED_ACTION_PERMISSION)};`,
    "function editPermission(args) {",
    "  const files = Array.isArray(args.changeset?.files) ? args.changeset.files : [];",
    '  const patterns = files.map((file) => file?.file).filter((file) => typeof file === "string");',
    '  if (patterns.length !== files.length || patterns.length === 0) throw new Error("keiko-tool-invalid");',
    '  const patch = typeof args.changeset?.patch === "string" ? args.changeset.patch : "";',
    String.raw`  const addedLines = patch.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++")).length;`,
    String.raw`  const deletedLines = patch.split("\n").filter((line) => line.startsWith("-") && !line.startsWith("---")).length;`,
    "  return {",
    "    patterns,",
    '    metadata: { kind: "workspace-write", actionClass: "workspace-write", reasonCode: "approval-required", actionKind: "file-edit", scopeLabel: "workspace-scope", risk: "medium", policyReason: "approval-required", targetPath: patterns[0], allowedRelativePaths: patterns, fileCount: patterns.length, addedLines, deletedLines },',
    "  };",
    "}",
    "function verificationPermission(args) {",
    '  if (typeof args.verifierId !== "string") throw new Error("keiko-tool-invalid");',
    "  return {",
    '    patterns: [args.verifierId], metadata: { kind: "command-execution", actionClass: "verification", reasonCode: "approval-required", actionKind: "verification-command", scopeLabel: "workspace-scope", risk: "low", policyReason: "approval-required", commandLabel: args.verifierId },',
    "  };",
    "}",
    "async function askForGovernedPermission(args, context) {",
    '  if (process.env.KEIKO_CODING_MODE !== "governed-assist") return;',
    '  const request = action === "edit" ? editPermission(args) : action === "verification" ? verificationPermission(args) : undefined;',
    "  if (!request) return;",
    "  await context.ask({",
    "    permission: governedPermission,",
    "    patterns: request.patterns,",
    "    always: [],",
    "    metadata: { ...request.metadata, expiresAt: new Date(Date.now() + 300000).toISOString() },",
    "  });",
    "}",
  ];
}

// eslint-disable-next-line max-lines-per-function -- emitted dependency-free tool source keeps all transport gates visible.
function toolSource(
  action: GeneratedToolAction,
  schemas: Readonly<Record<string, Readonly<Record<string, unknown>>>>,
): string {
  const argumentNames = Object.keys(schemas);
  return [
    "const MAX_RESPONSE_BYTES = 262144;",
    `const TIMEOUT_MS = ${String(OPEN_CODE_TOOL_CLIENT_TIMEOUT_MS)};`,
    `const action = ${JSON.stringify(action)};`,
    `const argumentNames = ${JSON.stringify(argumentNames)};`,
    `const inputSchemas = ${JSON.stringify(schemas)};`,
    "function validResult(value) {",
    '  if (!value || typeof value !== "object" || Array.isArray(value)) return false;',
    '  if (!["completed", "failed", "denied", "invalid", "cancelled", "busy", "observed"].includes(value.status)) return false;',
    '  if ((action !== "read" && action !== "discover" && action !== "egress") || value.status !== "completed") return true;',
    "  const read = value.read;",
    '  if (!read || typeof read !== "object" || Array.isArray(read) || typeof read.text !== "string" || !Number.isSafeInteger(read.byteCount) || !/^[a-f0-9]{64}$/.test(read.digest)) return false;',
    '  if (action !== "read" && action !== "discover") return true;',
    "  if (!Number.isSafeInteger(read.totalLines) || read.totalLines < 0) return false;",
    "  return read.nextStartLine === undefined || (Number.isSafeInteger(read.nextStartLine) && read.nextStartLine >= 2);",
    "}",
    "export default {",
    `  description: ${JSON.stringify(toolDescription(action))},`,
    "  args: inputSchemas,",
    "  async execute(args, context) {",
    "    const endpoint = process.env.KEIKO_TOOL_FACADE_URL;",
    "    const capability = process.env.KEIKO_TOOL_FACADE_CAPABILITY;",
    '    if (!endpoint || !capability) throw new Error("keiko-tool-unavailable");',
    "    const identity = `${context.sessionID}:${context.callID || context.messageID}`;",
    "    const request = { action, actionId: identity, idempotencyKey: identity };",
    "    for (const name of argumentNames) request[name] = args[name];",
    "    await askForGovernedPermission(args, context);",
    "    const body = JSON.stringify(request);",
    "    const controller = new AbortController();",
    "    const abort = () => controller.abort();",
    '    context.abort.addEventListener("abort", abort, { once: true });',
    "    const timeout = setTimeout(abort, TIMEOUT_MS);",
    "    try {",
    '      const response = await fetch(endpoint, { method: "POST", redirect: "manual", signal: controller.signal, headers: { Authorization: `Bearer ${capability}`, "Content-Type": "application/json" }, body });',
    '      if (!response.ok || response.type === "opaqueredirect" || response.body === null) throw new Error("keiko-tool-denied");',
    "      const reader = response.body.getReader();",
    "      const chunks = [];",
    "      let total = 0;",
    "      for (;;) {",
    "        const chunk = await reader.read();",
    "        if (chunk.done) break;",
    "        total += chunk.value.length;",
    '        if (total > MAX_RESPONSE_BYTES) throw new Error("keiko-tool-oversized");',
    "        chunks.push(chunk.value);",
    "      }",
    "      const bytes = new Uint8Array(total);",
    "      let offset = 0;",
    "      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }",
    '      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);',
    "      const result = JSON.parse(text);",
    '      if (!validResult(result)) throw new Error("keiko-tool-invalid");',
    "      return { title: action, output: text, metadata: {} };",
    "    } finally {",
    "      clearTimeout(timeout);",
    '      context.abort.removeEventListener("abort", abort);',
    "    }",
    "  },",
    "};",
    ...governedPermissionSource(),
  ].join("\n");
}
