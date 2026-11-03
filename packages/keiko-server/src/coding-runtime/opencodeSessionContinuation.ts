import { join } from "node:path";

import type { ServerLogSink } from "@oscharko-dev/keiko-activity-log";

import {
  recordSessionContinuity,
  type CodingSessionContinuity,
  type ContinuityIntent,
  type ContinuityReason,
  type ForkBoundary,
  type SessionContinuityRecord,
} from "./codingSessionContinuity.js";
import { OPENCODE_RUNTIME_READINESS_PROMPT } from "./opencodeLaunchProfile.js";
import type {
  CheckoutResult,
  RetainedSessionBinding,
  RetainedSessionSource,
  RetainedSessionStore,
} from "./opencodeSessionRetention.js";
import type { OpenCodeV2HttpClient } from "./opencodeV2HttpClient.js";
import { codingRuntimeFactDigest } from "./runtimeAuthorityService.js";

/**
 * The composition's half of native session continuity (S02/S03, #3904, ADR-0137 D10): seeding a
 * run's private runtime database from the task's retained entry before the runtime starts, binding
 * the run to the retained (or forked) session once it is up, and retaining the database of a run
 * that settled normally. Everything that decides whether a retained entry may be used lives in the
 * store (`opencodeSessionRetention.ts`); this module only asks, and every refusal leaves the run
 * exactly as a fresh one: its own empty session and the task's history context. A run that was
 * continued mints and holds its authority like any other; nothing in the database is read as such.
 */

/** What the composition hands in about the run it prepares and the runtime it launches. */
export interface SessionContinuationContext {
  readonly service: CodingSessionContinuity;
  readonly workspaceId: string;
  readonly runtimeVersion: string;
  /** The input window of the run's model, the bound a retained history must fit. */
  readonly maxInputTokens: number;
  readonly activityLog: ServerLogSink | undefined;
  /**
   * The managed workspace the run's own one was provisioned from (#3903 AC4, #3902 AC3), as its
   * retained entries are bound: a fork may continue a task retained there. Absent, a fork continues
   * only a task retained in the run's own workspace.
   */
  readonly forkSource?: (() => RetainedSessionSource | undefined) | undefined;
}

export interface ContinuedRunLocation {
  readonly runId: string;
  readonly runRoot: string;
  readonly workspaceRoot: string;
}

/** A run whose private database was seeded from a retained entry. */
export interface RunContinuation {
  readonly intent: ContinuityIntent;
  /** The task whose entry seeded the database. */
  readonly taskId: string;
  /** The retained session inside the seeded database. */
  readonly sessionId: string;
  readonly databaseBytes: number;
  readonly messageCount: number;
  readonly ageMs: number;
  /** Set once the session is bound: the messages of the session at that moment. */
  baselineIds?: ReadonlySet<string> | undefined;
  /** The fork source's location, where the retained session still is until it is moved. */
  readonly sourceDirectory?: string | undefined;
}

const BENIGN_REASONS: ReadonlySet<ContinuityReason> = new Set([
  "disabled",
  "not-native-profile",
  "no-retained-state",
]);

export function runtimeDatabasePath(runRoot: string): string {
  return join(runRoot, "state", "opencode.db");
}

/** The key a workspace's retained entries are bound to: a digest of its id and its root. */
export function continuationWorkspaceKey(workspaceId: string, workspaceRoot: string): string {
  return codingRuntimeFactDigest([
    "keiko.retained-session.workspace.v1",
    workspaceId,
    workspaceRoot,
  ]);
}

function bindingOf(
  context: SessionContinuationContext,
  location: ContinuedRunLocation,
  taskId: string,
): RetainedSessionBinding {
  return {
    taskId,
    workspaceKey: continuationWorkspaceKey(context.workspaceId, location.workspaceRoot),
    runtimeVersion: context.runtimeVersion,
    maxInputTokens: context.maxInputTokens,
  };
}

function boundaryKind(intent: ContinuityIntent): ForkBoundary["kind"] | undefined {
  return intent.kind === "fork" ? intent.boundary.kind : undefined;
}

function lineOf(
  context: SessionContinuationContext,
  location: ContinuedRunLocation,
  intent: ContinuityIntent,
): Pick<SessionContinuityRecord, "runId" | "action" | "taskId" | "sourceTaskId" | "boundary"> {
  const boundary = boundaryKind(intent);
  const taskId =
    intent.kind === "resume" ? intent.taskId : context.service.taskOfRun(location.runId);
  return {
    runId: location.runId,
    action: intent.kind,
    ...(taskId === undefined ? {} : { taskId }),
    ...(intent.kind === "fork" ? { sourceTaskId: intent.sourceTaskId } : {}),
    ...(boundary === undefined ? {} : { boundary }),
  };
}

/**
 * Takes the run's declaration and, when the run asked to continue a task, seeds its private runtime
 * database from the task's retained entry. Returns the continuation, or `undefined` when the run
 * proceeds with a fresh session (nothing was asked, or the entry was refused with a recorded reason).
 */
export function seedContinuation(
  context: SessionContinuationContext,
  location: ContinuedRunLocation,
): RunContinuation | undefined {
  const intent = context.service.take(location.runId);
  if (intent === undefined) return undefined;
  const taskId = intent.kind === "resume" ? intent.taskId : intent.sourceTaskId;
  const store = context.service.store;
  if (store === undefined) {
    recordFallBack(context, location, intent, "disabled");
    return undefined;
  }
  let checkout: CheckoutResult;
  try {
    checkout = store.checkout(checkoutInput(context, location, intent, taskId));
  } catch (error) {
    // A filesystem or database failure of the copy: the run starts fresh and the line carries it.
    recordFallBack(context, location, intent, "copy-failed", error);
    return undefined;
  }
  if (!checkout.ok) {
    recordFallBack(context, location, intent, checkout.reason);
    return undefined;
  }
  const { sessionId, databaseBytes, messageCount, ageMs, sourceDirectory } = checkout;
  return {
    intent,
    taskId,
    sessionId,
    databaseBytes,
    messageCount,
    ageMs,
    ...(sourceDirectory === undefined ? {} : { sourceDirectory }),
  };
}

/** What a run asks the store for: its own binding, and for a fork the provisioning source too. */
function checkoutInput(
  context: SessionContinuationContext,
  location: ContinuedRunLocation,
  intent: ContinuityIntent,
  taskId: string,
): Parameters<RetainedSessionStore["checkout"]>[0] {
  const source = intent.kind === "fork" ? context.forkSource?.() : undefined;
  return {
    binding: bindingOf(context, location, taskId),
    directory: location.workspaceRoot,
    destinationDatabase: runtimeDatabasePath(location.runRoot),
    ...(intent.kind === "fork" ? { purpose: "fork" as const } : {}),
    ...(source === undefined ? {} : { source }),
  };
}

function recordFallBack(
  context: SessionContinuationContext,
  location: ContinuedRunLocation,
  intent: ContinuityIntent,
  reason: ContinuityReason,
  error?: unknown,
): void {
  context.service.settle(location.runId, { kind: "fresh", reason });
  const outcome = freshOutcome(reason);
  recordSessionContinuity(context.activityLog, {
    ...lineOf(context, location, intent),
    outcome,
    reason,
    ...(error === undefined ? {} : { error }),
  });
}

/** A benign reason falls back fresh; a failed copy failed; anything else was refused. */
function freshOutcome(reason: ContinuityReason): "failed" | "fresh" | "refused" {
  if (BENIGN_REASONS.has(reason)) return "fresh";
  return reason === "copy-failed" ? "failed" : "refused";
}

/** The part of the runtime client the session binding uses. */
export type ContinuationClient = Pick<
  OpenCodeV2HttpClient,
  | "sessions"
  | "messages"
  | "forkSession"
  | "removeSession"
  | "switchAgent"
  | "createSession"
  | "moveSession"
>;

export type ContinuedSession =
  | { readonly ok: true; readonly sessionId: string; readonly baselineIds: ReadonlySet<string> }
  | { readonly ok: false; readonly reason: ContinuityReason; readonly error?: unknown };

class ContinuationRefused extends Error {
  public constructor(
    public readonly reason: ContinuityReason,
    options?: ErrorOptions,
  ) {
    super("opencode-session-continuation-refused", options);
    this.name = "ContinuationRefused";
  }
}

/**
 * Binds the started runtime to the session the run continues. A resume uses the retained session as
 * it is; a fork copies it (to just before a user turn, or through its end) into a new session and
 * removes the source from this run's private database, so the run holds exactly one session and the
 * retained entry of the source task is untouched. Either way the session must be the retained one in
 * the run's own workspace; anything else is a refusal. A session retained at the fork source's
 * location is first moved to the run's own workspace by the runtime itself (`session.move`).
 */
export async function bindContinuedSession(
  client: ContinuationClient,
  continuation: RunContinuation,
  directory: string,
  signal: AbortSignal | undefined,
): Promise<ContinuedSession> {
  try {
    const retained = await relocatedSession(client, continuation, directory, signal);
    const sessionId =
      continuation.intent.kind === "fork"
        ? await forkAndReplace(client, continuation.intent.boundary, retained, directory, signal)
        : retained.id;
    const baselineIds = await messageIds(client, sessionId, signal);
    await resetAgent(client, sessionId, retained.agent, continuation.intent.kind, signal);
    return { ok: true, sessionId, baselineIds };
  } catch (error) {
    if (error instanceof ContinuationRefused) {
      return { ok: false, reason: error.reason, error: error.cause ?? error };
    }
    // Anything else is not a refusal: it propagates to the composition, which records it.
    throw error;
  }
}

interface RetainedSessionView {
  readonly id: string;
  readonly agent: unknown;
}

async function soleSession(
  client: ContinuationClient,
  expectedId: string,
  directory: string,
  signal: AbortSignal | undefined,
): Promise<RetainedSessionView> {
  const sessions = await client.sessions(signal);
  const session = sessions[0];
  if (sessions.length !== 1 || session?.id !== expectedId) {
    throw new ContinuationRefused("session-mismatch");
  }
  const location = session.location;
  const sessionDirectory =
    typeof location === "object" && location !== null && "directory" in location
      ? location.directory
      : undefined;
  if (sessionDirectory !== directory) throw new ContinuationRefused("session-mismatch");
  return { id: expectedId, agent: session.agent };
}

/**
 * The retained session in the run's own workspace (#3903 AC4, #3902 AC3). One retained at the fork
 * source's location is moved by the runtime's own `session.move` into this run's root, the only
 * root its sandbox and authority bind, and must then be there; it is never used where it was.
 */
async function relocatedSession(
  client: ContinuationClient,
  continuation: RunContinuation,
  directory: string,
  signal: AbortSignal | undefined,
): Promise<RetainedSessionView> {
  const source = continuation.sourceDirectory;
  if (source === undefined) return soleSession(client, continuation.sessionId, directory, signal);
  await soleSession(client, continuation.sessionId, source, signal);
  try {
    await client.moveSession(continuation.sessionId, directory, signal);
  } catch (error) {
    throw new ContinuationRefused("move-failed", { cause: error });
  }
  return soleSession(client, continuation.sessionId, directory, signal);
}

async function messageIds(
  client: ContinuationClient,
  sessionId: string,
  signal: AbortSignal | undefined,
): Promise<ReadonlySet<string>> {
  try {
    const messages = await client.messages(sessionId, signal);
    return new Set(
      messages.flatMap((message) => (typeof message.id === "string" ? [message.id] : [])),
    );
  } catch (error) {
    throw new ContinuationRefused("history-oversized", { cause: error });
  }
}

/**
 * A resumed run starts under the launch profile's default agent, as a fresh one does: the agent the
 * previous run ended under is not carried over (a read-only `plan` run must not silently turn the
 * next task into one, and an editing agent must not turn up where `plan` was asked for).
 */
async function resetAgent(
  client: ContinuationClient,
  sessionId: string,
  agent: unknown,
  kind: ContinuityIntent["kind"],
  signal: AbortSignal | undefined,
): Promise<void> {
  if (kind === "fork" || agent === undefined || agent === null || agent === "build") return;
  try {
    await client.switchAgent(sessionId, "build", signal);
  } catch (error) {
    throw new ContinuationRefused("agent-reset-failed", { cause: error });
  }
}

async function forkAndReplace(
  client: ContinuationClient,
  boundary: ForkBoundary,
  source: RetainedSessionView,
  directory: string,
  signal: AbortSignal | undefined,
): Promise<string> {
  const before = await forkPoint(client, source.id, boundary, signal);
  let forked: Awaited<ReturnType<ContinuationClient["forkSession"]>>;
  try {
    forked = await client.forkSession(source.id, before, signal);
  } catch (error) {
    throw new ContinuationRefused("fork-failed", { cause: error });
  }
  const expected = before === undefined ? "through" : "before";
  if (
    forked.sourceSessionId !== source.id ||
    forked.directory !== directory ||
    forked.boundary.type !== expected ||
    (before !== undefined && forked.boundary.messageId !== before)
  ) {
    throw new ContinuationRefused("fork-failed");
  }
  try {
    await client.removeSession(source.id, signal);
  } catch (error) {
    throw new ContinuationRefused("fork-failed", { cause: error });
  }
  await soleSession(client, forked.id, directory, signal);
  return forked.id;
}

/**
 * The runtime message a turn boundary names. Coding History and the runtime's own history count the
 * same user turns; the runtime's readiness handshake is not one of them. A disagreement in the number
 * of turns means the two cannot be aligned, and no boundary is guessed.
 */
async function forkPoint(
  client: ContinuationClient,
  sessionId: string,
  boundary: ForkBoundary,
  signal: AbortSignal | undefined,
): Promise<string | undefined> {
  if (boundary.kind === "end") return undefined;
  const messages = await client.messages(sessionId, signal).catch((error: unknown) => {
    throw new ContinuationRefused("history-oversized", { cause: error });
  });
  const turns = messages.flatMap((message) =>
    message.type === "user" &&
    typeof message.id === "string" &&
    typeof message.text === "string" &&
    message.text.trim() !== OPENCODE_RUNTIME_READINESS_PROMPT
      ? [message.id]
      : [],
  );
  const before = turns[boundary.ordinal];
  if (turns.length !== boundary.userTurnCount || before === undefined) {
    throw new ContinuationRefused("fork-boundary-unresolved");
  }
  return before;
}

/** Removes the messages a continued session already held: they belong to earlier runs. */
export function withoutBaseline<Message extends { readonly id?: unknown }>(
  messages: readonly Message[],
  baselineIds: ReadonlySet<string> | undefined,
): readonly Message[] {
  if (baselineIds === undefined || baselineIds.size === 0) return messages;
  return messages.filter(
    (message) => typeof message.id !== "string" || !baselineIds.has(message.id),
  );
}

/** What the composition knows about a run when it is disposed. */
export interface SettledContinuedRun {
  readonly runId: string;
  readonly runRoot: string;
  readonly workspaceRoot: string;
  readonly sessionId: string | undefined;
}

/**
 * After the runtime is reaped, submits a terminal run's database to the existing strict audit.
 * Failed and cancelled turns may retain safe native history, without retaining authority or
 * pending effects. Every refusal removes the stale entry and falls back to Coding History.
 * Unsettled runs never retain. Never throws: a failure is one `failed` line with its cause.
 */
export function retainSettledRun(
  context: SessionContinuationContext,
  run: SettledContinuedRun,
  terminalStatus: string | undefined,
): void {
  const store = context.service.store;
  const taskId = context.service.taskOfRun(run.runId);
  const line = {
    runId: run.runId,
    action: "retain" as const,
    ...(taskId === undefined ? {} : { taskId }),
  };
  const reason = skipReason(store, run, taskId, terminalStatus);
  if (reason === undefined && store !== undefined && taskId !== undefined) {
    attemptRetain(context, store, run, taskId, line);
    return;
  }
  // An entry always describes the latest settled state of its task: a run that leaves none removes
  // the previous one, unless retention is off and there is none to remove.
  if (store !== undefined && taskId !== undefined) removeEntry(context, store, taskId, line);
  recordSessionContinuity(context.activityLog, {
    ...line,
    outcome: "skipped",
    reason: reason ?? "no-task",
  });
}

/** Removes a task's entry; a removal that fails is one `failed` line, never a failed disposal. */
function removeEntry(
  context: SessionContinuationContext,
  store: NonNullable<CodingSessionContinuity["store"]>,
  taskId: string,
  line: Pick<SessionContinuityRecord, "runId" | "action" | "taskId">,
): void {
  try {
    store.remove(taskId);
  } catch (error) {
    recordSessionContinuity(context.activityLog, {
      ...line,
      outcome: "failed",
      reason: "copy-failed",
      error,
    });
  }
}

function skipReason(
  store: CodingSessionContinuity["store"],
  run: SettledContinuedRun,
  taskId: string | undefined,
  terminalStatus: string | undefined,
): ContinuityReason | undefined {
  if (store === undefined) return "disabled";
  if (
    terminalStatus !== "succeeded" &&
    terminalStatus !== "failed" &&
    terminalStatus !== "cancelled"
  ) {
    return "not-succeeded";
  }
  if (run.sessionId === undefined) return "no-session";
  return taskId === undefined ? "no-task" : undefined;
}

function attemptRetain(
  context: SessionContinuationContext,
  store: NonNullable<CodingSessionContinuity["store"]>,
  run: SettledContinuedRun,
  taskId: string,
  line: Pick<SessionContinuityRecord, "runId" | "action" | "taskId">,
): void {
  try {
    const result = store.retain({
      binding: bindingOf(
        context,
        { runId: run.runId, runRoot: run.runRoot, workspaceRoot: run.workspaceRoot },
        taskId,
      ),
      sessionId: run.sessionId ?? "",
      directory: run.workspaceRoot,
      sourceDatabase: runtimeDatabasePath(run.runRoot),
    });
    if (result.ok) {
      recordSessionContinuity(context.activityLog, {
        ...line,
        outcome: "retained",
        databaseBytes: result.databaseBytes,
        messageCount: result.messageCount,
        entryCount: result.entryCount,
        prunedCount: result.prunedCount,
      });
      return;
    }
    removeEntry(context, store, taskId, line);
    recordSessionContinuity(context.activityLog, {
      ...line,
      outcome: "refused",
      reason: result.reason,
      ...(result.check === undefined ? {} : { auditCheck: result.check }),
    });
  } catch (error) {
    // The copy or the audit failed on the filesystem or in the database: the previous entry no
    // longer describes the task, so it goes, and the line carries the failure.
    removeEntry(context, store, taskId, line);
    recordSessionContinuity(context.activityLog, {
      ...line,
      outcome: "failed",
      reason: "copy-failed",
      error,
    });
  }
}
