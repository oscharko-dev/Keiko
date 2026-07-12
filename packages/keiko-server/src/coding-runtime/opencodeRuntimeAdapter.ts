import { isAbsolute } from "node:path";

import { createFixedOpenCodeConfig } from "./opencodeLaunchProfile.js";
import {
  createOpenCodeReconciler,
  type OpenCodeReconciliationEvent,
  type OpenCodeReconciliationPreparation,
  type OpenCodeReconciler,
} from "./opencodeReconciler.js";
import type { OpenCodeLiveControl } from "./opencodeProtocol.js";
import {
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
  };
  readonly governedSink: {
    readonly execute: (
      identityKey: string,
      event: OpenCodeReconciliationEvent,
    ) => Promise<OpenCodeGovernedSinkReceipt>;
  };
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
  readonly terminalCheckpoints: Map<string, number>;
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
    terminalCheckpoints: new Map(),
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

      // eslint-disable-next-line complexity -- stream, reconciliation, and retry failures are independent.
      async function monitorLoop(): Promise<void> {
        let reconnects = 0;
        while (isMonitoring()) {
          try {
            let hint: OpenCodeSyncHint;
            let signal: AbortSignal | undefined;
            if (activeIterator === undefined) {
              const opened = await openSubscription();
              hint = opened.hint;
              signal = opened.signal;
            } else {
              const next = await activeIterator.next();
              if (next.done || !validHint(next.value)) throw new Error("opencode-events-ended");
              hint = next.value;
              signal = activeAbort?.signal;
            }
            if (!(await reconcileHint(ports, state, hint, signal))) {
              throw new Error("opencode-history-incomplete");
            }
            observeControl("control" in hint ? hint.control : undefined);
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
    notifyTurn();
  }

  function settleTurn(generation: number): void {
    turnArmed = false;
    turnActive = false;
    turnStatusTerminal = false;
    turnBaselineSequence = undefined;
    turnSettledGeneration = generation;
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

  // eslint-disable-next-line complexity -- active/terminal, caller, deadline, stop, and polling gates fail independently.
  async function waitForTerminal(callerSignal: AbortSignal): Promise<boolean> {
    const generation = turnGeneration;
    if (turnSettled(generation) && !callerSignal.aborted) return true;
    if (!turnArmed || ready === undefined || closed || callerSignal.aborted) return false;
    const deadline = new AbortController();
    const timer = setTimeout(() => {
      deadline.abort();
    }, OPEN_CODE_MAX_TURN_WAIT_MS);
    timer.unref();
    const signal = AbortSignal.any([callerSignal, deadline.signal]);
    try {
      while (turnCurrent(generation, signal)) {
        if (turnCompleted(generation, signal)) {
          settleTurn(generation);
          return true;
        }
        try {
          const status = await ports.control.status(ready.sessionId, signal);
          if (status !== undefined) observeControl({ sessionId: ready.sessionId, state: status });
          if (turnCompleted(generation, signal)) {
            settleTurn(generation);
            return true;
          }
          if (turnSettled(generation)) return true;
          if (status === "terminal") {
            await reconcileHistory(ports, state, signal);
            if (turnCompleted(generation, signal)) {
              settleTurn(generation);
              return true;
            }
            if (turnSettled(generation)) return true;
          }
        } catch {
          if (!turnCurrent(generation, signal)) return false;
        }
        await waitForTurnChange(signal, generation);
      }
      return turnSettled(generation);
    } finally {
      clearTimeout(timer);
    }
  }

  function turnCurrent(generation: number, signal: AbortSignal): boolean {
    return turnArmed && !closed && !signal.aborted && generation === turnGeneration;
  }

  function turnSettled(generation: number): boolean {
    return !closed && generation === turnGeneration && generation === turnSettledGeneration;
  }

  function turnCompleted(generation: number, signal: AbortSignal): boolean {
    if (!turnCurrent(generation, signal)) return false;
    if (!turnStatusTerminal) return false;
    if (turnActive) return true;
    if (ready === undefined || turnBaselineSequence === undefined) return false;
    const terminalSequence = state.terminalCheckpoints.get(ready.sessionId);
    return terminalSequence !== undefined && terminalSequence > turnBaselineSequence;
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
    /^opencode server listening on http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})(?:\r?\n)?$/u.exec(line);
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
  for (const event of prepared.projections) {
    const receipt: unknown = await ports.governedSink.execute(eventIdentity(event), event);
    if (receipt !== "applied" && receipt !== "duplicate") throw new Error("sink-receipt-invalid");
  }
  if (!prepared.commit()) throw new Error("reconciler-commit-conflict");
  replaceMap(state.checkpoints, planned.checkpoints);
  replaceMap(state.terminalCheckpoints, planned.terminalCheckpoints);
  replaceMap(state.recent, planned.recent);
  replaceMap(state.observedIds, planned.observedIds);
}

// eslint-disable-next-line complexity -- ordering, dedupe, and conflict gates fail closed independently.
function planHistory(
  events: readonly OpenCodeReconciliationEvent[],
  state: ReconciliationState,
):
  | {
      readonly events: readonly OpenCodeReconciliationEvent[];
      readonly checkpoints: ReadonlyMap<string, number>;
      readonly terminalCheckpoints: ReadonlyMap<string, number>;
      readonly recent: ReadonlyMap<string, string>;
      readonly observedIds: ReadonlyMap<string, true>;
    }
  | undefined {
  if (!validHistoryWindow(events, state)) return undefined;
  const checkpoints = new Map(state.checkpoints);
  const terminalCheckpoints = new Map(state.terminalCheckpoints);
  const recent = new Map(state.recent);
  const observedIds = new Map(state.observedIds);
  const fresh: OpenCodeReconciliationEvent[] = [];
  for (const event of events) {
    if (!validEvent(event)) return undefined;
    const key = eventIdentity(event);
    const knownDigest = recent.get(key);
    if (knownDigest !== undefined) {
      if (knownDigest !== event.digest) return undefined;
      touch(recent, key, knownDigest);
      touchObserved(observedIds, event.id);
      continue;
    }
    const checkpoint = checkpoints.get(event.aggregateId);
    if (checkpoint !== undefined && event.sequence <= checkpoint) continue;
    const expected = checkpoint === undefined ? 0 : checkpoint + 1;
    if (event.sequence !== expected) return undefined;
    if (!setCheckpoint(checkpoints, event.aggregateId, event.sequence)) return undefined;
    if (
      event.kind === "terminal" &&
      !setCheckpoint(terminalCheckpoints, event.aggregateId, event.sequence)
    )
      return undefined;
    touch(recent, key, event.digest);
    touchObserved(observedIds, event.id);
    fresh.push(event);
  }
  return { events: fresh, checkpoints, terminalCheckpoints, recent, observedIds };
}

function validHistoryWindow(
  events: readonly OpenCodeReconciliationEvent[],
  state: ReconciliationState,
): boolean {
  return (
    events.length <= MAX_HISTORY_EVENTS &&
    Buffer.byteLength(JSON.stringify(events), "utf8") <= MAX_HISTORY_BYTES &&
    state.checkpoints.size <= MAX_AGGREGATE_CHECKPOINTS &&
    state.terminalCheckpoints.size <= MAX_AGGREGATE_CHECKPOINTS
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
    ["observation", "permission", "question", "tool", "terminal"].includes(event.kind)
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
      OPENCODE_TOOL_SOURCE_DEFINITIONS.map(({ name, action, argument, inputSchema }) => [
        name,
        toolSource(action, argument, inputSchema),
      ]),
    ),
  };
}

// eslint-disable-next-line max-lines-per-function -- emitted dependency-free tool source keeps all transport gates visible.
function toolSource(
  action: "read" | "edit",
  argument: "relativePath" | "changeset",
  inputSchema: Readonly<Record<string, unknown>>,
): string {
  return [
    "const MAX_RESPONSE_BYTES = 262144;",
    "const TIMEOUT_MS = 10000;",
    `const action = ${JSON.stringify(action)};`,
    `const argument = ${JSON.stringify(argument)};`,
    `const inputSchema = ${JSON.stringify(inputSchema)};`,
    "function validResult(value) {",
    '  if (!value || typeof value !== "object" || Array.isArray(value)) return false;',
    '  if (!["completed", "failed", "denied", "invalid", "cancelled", "busy", "observed"].includes(value.status)) return false;',
    '  if (action !== "read" || value.status !== "completed") return true;',
    "  const read = value.read;",
    '  return !!read && typeof read === "object" && !Array.isArray(read) && typeof read.text === "string" && Number.isSafeInteger(read.byteCount) && /^[a-f0-9]{64}$/.test(read.digest);',
    "}",
    "export default {",
    `  description: ${JSON.stringify(action === "read" ? "Read a bounded repository text file through Keiko governance." : "Submit a bounded changeset through Keiko governance.")},`,
    `  args: { ${argument}: inputSchema },`,
    "  async execute(args, context) {",
    "    const endpoint = process.env.KEIKO_TOOL_FACADE_URL;",
    "    const capability = process.env.KEIKO_TOOL_FACADE_CAPABILITY;",
    '    if (!endpoint || !capability) throw new Error("keiko-tool-unavailable");',
    "    const identity = `${context.sessionID}:${context.callID || context.messageID}`;",
    `    const body = JSON.stringify({ action, actionId: identity, idempotencyKey: identity, ${argument}: args.${argument} });`,
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
  ].join("\n");
}
