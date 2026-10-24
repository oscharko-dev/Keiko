import { resolve } from "node:path";

import type { ServerLogSink } from "@oscharko-dev/keiko-activity-log";
import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";

import type { OpenCodeNativeSessionRelation } from "./opencodeNativePolicy.js";
import type { OpenCodeV2HttpClient } from "./opencodeV2HttpClient.js";

/**
 * The run's native session tree (#3897 review, PR #4064): the one session the Workbench created and
 * the child sessions (subagents) the original runtime opened under it. The runtime hosts them all in
 * one process, so what the run owns is decided here, once: a session is the run's own when it is the
 * primary session or its `parentID` chain reaches the primary within a bounded depth, every session on
 * the chain located in the run's workspace. The proof is read from the runtime's own session list and
 * cached; a session that is not proven is never the run's, so an unrelated session can neither ask
 * the human a question nor keep a run alive.
 */
export const NATIVE_CHILD_SESSION_MAX = 64;
export const NATIVE_SESSION_ANCESTRY_MAX_DEPTH = 8;
const SESSION_ID = /^ses_[A-Za-z0-9_-]{1,251}$/u;
// A fan-out settles on the second inactive read: the runtime ends a child and starts the parent's
// notification turn in one step, and a single read can fall between the two.
const INACTIVE_READS_TO_SETTLE = 2;

// The run's native session tree (a primary session and the subagent sessions under it). A line is
// written when the tree's state changes, never per poll: `held` is the moment the run's primary went
// idle while an owned child session or a background shell job of the run was still active, so the
// run was kept alive; `released` the moment that stopped being true (the child or job ended, or its
// notification started the primary again); `interrupted` a stop or turn replacement that sent
// interrupts to owned children or stopped the run's background jobs.
const NATIVE_SESSION_TREE_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "coding-runtime.native-session-tree.observed",
  category: "process",
  owner: "keiko-server",
  emitter: "coding-runtime.opencodeNativeSessionTree.recordNativeSessionTree",
  fields: {
    phase: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["held", "interrupted", "released"],
    },
    // Whether the run's primary session was running; absent on `interrupted`, which concerns the
    // children it interrupted.
    primaryActive: { type: "boolean", dataClass: "closed-enum", required: false },
    // The owned children active when the line was written; for `interrupted`, the ones interrupted.
    activeChildCount: { type: "integer", dataClass: "count", required: true },
    ownedChildCount: { type: "integer", dataClass: "count", required: true },
    // #3901 AC3: the run's background shell jobs running when the line was written; for
    // `interrupted`, the ones stopped. Absent when there were none.
    activeShellCount: { type: "integer", dataClass: "count", required: false },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["coding-runtime-session-continuity"],
  proofIds: ["coding-runtime.native-session-tree.observed.emitted-line"],
  releaseImpact: "patch",
});

type SessionRecord = Readonly<Record<string, unknown>>;

/** The part of the HTTP client the tree reads and drives. */
export type NativeSessionTreeClient = Pick<
  OpenCodeV2HttpClient,
  "active" | "interrupt" | "sessions" | "shells" | "removeShell"
>;

/** The run's identity in the tree; `children` is the run's admission cache, shared by reference. */
export interface NativeSessionTreeRun {
  readonly sessionId: string;
  readonly workspaceRoot: string;
  readonly children: Set<string>;
}

/**
 * What is running now: the primary, the owned children among the active sessions, and the run's
 * background shell jobs (#3901 AC3), which outlive the turn that started them.
 */
export interface NativeTreeActivity {
  readonly primaryActive: boolean;
  readonly activeChildren: readonly string[];
  readonly activeShells: readonly string[];
  readonly ownedChildCount: number;
}

/** True when `sessionID`'s parent chain reaches `primaryId` inside the workspace (pure, bounded). */
export function nativeSessionDescendsFromRun(
  sessions: readonly SessionRecord[],
  sessionID: string,
  primaryId: string,
  workspaceRoot: string,
): boolean {
  const byId = new Map(sessions.map((session) => [session.id, session] as const));
  let current = sessionID;
  for (let depth = 0; depth < NATIVE_SESSION_ANCESTRY_MAX_DEPTH; depth += 1) {
    const session = byId.get(current);
    if (session === undefined || !nativeSessionInWorkspace(session, workspaceRoot)) return false;
    const parent = session.parentID;
    if (typeof parent !== "string" || parent.length === 0 || parent === current) return false;
    if (parent === primaryId) return true;
    current = parent;
  }
  return false;
}

function nativeSessionInWorkspace(session: SessionRecord, workspaceRoot: string): boolean {
  const location = session.location;
  const directory =
    typeof location === "object" && location !== null
      ? (location as Readonly<Record<string, unknown>>).directory
      : undefined;
  return typeof directory === "string" && resolve(directory) === resolve(workspaceRoot);
}

/**
 * The candidates the run owns. A child proven once stays admitted (a session never changes its
 * parent); the session list is read at most once per call and only for candidates not yet proven.
 * The admission cache holds at most `NATIVE_CHILD_SESSION_MAX` children; a descendant proven when it
 * is full is still the run's, it is just proven again on its next appearance (#3897 review: a full
 * cache that skipped the proof let a 65th active child look like no activity, so the tree read as
 * terminal while it ran). A failed read throws: the caller decides what an unproven session means,
 * because refusing an ask and keeping a run alive are different questions.
 */
export async function admitNativeChildren(
  client: Pick<NativeSessionTreeClient, "sessions">,
  run: NativeSessionTreeRun,
  candidates: readonly string[],
  signal: AbortSignal | undefined,
): Promise<readonly string[]> {
  const owned: string[] = [];
  const unproven = candidates.some(
    (candidate) => candidate !== run.sessionId && !run.children.has(candidate),
  );
  const sessions = unproven ? await client.sessions(signal) : [];
  for (const candidate of candidates) {
    if (candidate === run.sessionId) continue;
    if (run.children.has(candidate)) {
      owned.push(candidate);
      continue;
    }
    if (!nativeSessionDescendsFromRun(sessions, candidate, run.sessionId, run.workspaceRoot))
      continue;
    if (run.children.size < NATIVE_CHILD_SESSION_MAX) run.children.add(candidate);
    owned.push(candidate);
  }
  return owned;
}

/** The relation of one session to the run, or `undefined` when it is not the run's. */
export async function classifyNativeSession(
  client: Pick<NativeSessionTreeClient, "sessions">,
  run: NativeSessionTreeRun,
  sessionID: string,
  signal: AbortSignal | undefined,
): Promise<OpenCodeNativeSessionRelation | undefined> {
  if (sessionID === run.sessionId) return "primary";
  return (await admitNativeChildren(client, run, [sessionID], signal)).length === 1
    ? "child"
    : undefined;
}

/**
 * The sessions the runtime reports active, split into the run's primary and its owned children. An
 * active session that is not the run's is ignored: it cannot extend the run. A failed read throws.
 */
export async function nativeTreeActivity(
  client: Pick<NativeSessionTreeClient, "active" | "sessions" | "shells">,
  run: NativeSessionTreeRun,
  signal: AbortSignal | undefined,
): Promise<NativeTreeActivity> {
  const active = await client.active(signal);
  const others = Object.keys(active).filter((id) => id !== run.sessionId && SESSION_ID.test(id));
  const activeChildren = await admitNativeChildren(client, run, others, signal);
  const shells = await client.shells(run.workspaceRoot, signal);
  return {
    primaryActive: Object.hasOwn(active, run.sessionId),
    activeChildren,
    // The run's runtime hosts this run alone; a job a session of another tree started is not the
    // run's, and a job the runtime names no session for is held as the run's.
    activeShells: shells
      .filter((shell) => shell.sessionId === undefined || ownedSession(run, shell.sessionId))
      .map((shell) => shell.id),
    ownedChildCount: run.children.size,
  };
}

function ownedSession(run: NativeSessionTreeRun, sessionId: string): boolean {
  return sessionId === run.sessionId || run.children.has(sessionId);
}

/** A run's tree is terminal only when its primary, every owned child and every job are inactive. */
export function nativeTreeInactive(activity: NativeTreeActivity): boolean {
  return (
    !activity.primaryActive &&
    activity.activeChildren.length === 0 &&
    activity.activeShells.length === 0
  );
}

export interface NativeTreeInterruptOutcome {
  /** The owned children an interrupt was sent to (each counted once, however often it was sent). */
  readonly interruptedChildren: number;
  /** The run's background shell jobs stopped (#3901 AC3). */
  readonly stoppedShells: number;
  /** Whether the whole tree was inactive before the signal ended. */
  readonly settled: boolean;
}

export interface NativeTreeInterruptOptions {
  readonly signal: AbortSignal;
  /** Waits between two reads and resolves `false` once `signal` ended. */
  readonly pause: (signal: AbortSignal) => Promise<boolean>;
  readonly runId: string;
  readonly activityLog: ServerLogSink | undefined;
}

/**
 * Stops the run's turn across its whole tree. The primary is interrupted first, as it always was;
 * then every owned child that is still active is interrupted, and so is the primary again when it
 * came back after being idle: the runtime tells a parent that a child it launched in the background
 * ended, and the parent then runs a turn of its own to read that, so interrupting only the sessions
 * that were active at the first read would leave that turn running. The loop ends when nothing of
 * the run is active on two consecutive reads (`settled`) or `signal` ends; a failed request throws.
 * One line records the children interrupted.
 */
export async function interruptNativeTree(
  client: NativeSessionTreeClient,
  run: NativeSessionTreeRun,
  options: NativeTreeInterruptOptions,
): Promise<NativeTreeInterruptOutcome> {
  const { signal, pause } = options;
  await client.interrupt(run.sessionId, signal);
  const fanOut: FanOutState = {
    interrupted: new Set(),
    stopped: new Set(),
    primaryIdleSeen: false,
    inactiveReads: 0,
  };
  let settled = false;
  while (!signal.aborted && !settled) {
    settled = await fanOutStep(client, run, signal, fanOut);
    if (!settled && !(await pause(signal))) break;
  }
  if (fanOut.interrupted.size > 0 || fanOut.stopped.size > 0)
    recordNativeSessionTree(options.activityLog, options.runId, "interrupted", {
      activeChildCount: fanOut.interrupted.size,
      ownedChildCount: run.children.size,
      activeShellCount: fanOut.stopped.size,
    });
  return {
    interruptedChildren: fanOut.interrupted.size,
    stoppedShells: fanOut.stopped.size,
    settled,
  };
}

interface FanOutState {
  readonly interrupted: Set<string>;
  /** The run's background shell jobs already stopped. */
  readonly stopped: Set<string>;
  // The primary is interrupted again only when it came back after being seen idle, which is the
  // notification turn of a child the loop just ended; an execution still running from the first
  // interrupt is not asked twice.
  primaryIdleSeen: boolean;
  inactiveReads: number;
}

// One read of what is active and the interrupts it calls for; true once the tree stayed inactive.
async function fanOutStep(
  client: NativeSessionTreeClient,
  run: NativeSessionTreeRun,
  signal: AbortSignal,
  fanOut: FanOutState,
): Promise<boolean> {
  const activity = await nativeTreeActivity(client, run, signal);
  if (!activity.primaryActive) fanOut.primaryIdleSeen = true;
  if (nativeTreeInactive(activity)) {
    fanOut.inactiveReads += 1;
    return fanOut.inactiveReads >= INACTIVE_READS_TO_SETTLE;
  }
  fanOut.inactiveReads = 0;
  // The children are independent sessions: their interrupts go out together, in order.
  const pending = activity.activeChildren.filter((id) => !fanOut.interrupted.has(id));
  await Promise.all(pending.map((child) => client.interrupt(child, signal)));
  for (const child of pending) fanOut.interrupted.add(child);
  // A background job outlives an interrupt of its session; stopping the turn stops it too.
  const jobs = activity.activeShells.filter((id) => !fanOut.stopped.has(id));
  await Promise.all(jobs.map((id) => client.removeShell(id, run.workspaceRoot, signal)));
  for (const id of jobs) fanOut.stopped.add(id);
  if (activity.primaryActive && fanOut.primaryIdleSeen) {
    await client.interrupt(run.sessionId, signal);
    fanOut.primaryIdleSeen = false;
  }
  return false;
}

export interface NativeTreeStatusDeps {
  readonly runId: string;
  readonly client: Pick<NativeSessionTreeClient, "active" | "sessions" | "shells">;
  /** The run's tree, for the primary session the adapter asks about. */
  readonly tree: (sessionId: string) => NativeSessionTreeRun;
  readonly activityLog: ServerLogSink | undefined;
}

/**
 * The run's liveness as the adapter polls it: `activity` while the primary session runs, `held` when
 * it is idle but a session the run owns or a background shell job of the run still runs, and
 * `terminal` only when nothing of the run runs. A background subagent or job keeps working after its
 * parent went idle, so the parent's idleness alone is not the end of the run (#3901 AC3); a session
 * that is not the run's never keeps it alive. A line is written when the run starts being held for an owned child and when it
 * stops (never per poll). A failed read throws: an unproven state is not a terminal one.
 */
export function createNativeTreeStatusPort(
  deps: NativeTreeStatusDeps,
): (sessionId: string, signal: AbortSignal) => Promise<"activity" | "held" | "terminal"> {
  let holding = false;
  return async (sessionId, signal) => {
    const activity = await nativeTreeActivity(deps.client, deps.tree(sessionId), signal);
    const held = !activity.primaryActive && !nativeTreeInactive(activity);
    if (held !== holding) {
      holding = held;
      recordNativeSessionTree(deps.activityLog, deps.runId, held ? "held" : "released", {
        primaryActive: activity.primaryActive,
        activeChildCount: activity.activeChildren.length,
        ownedChildCount: activity.ownedChildCount,
        activeShellCount: activity.activeShells.length,
      });
    }
    if (activity.primaryActive) return "activity";
    return held ? "held" : "terminal";
  };
}

interface NativeSessionTreeFacts {
  readonly primaryActive?: boolean;
  readonly activeChildCount: number;
  readonly ownedChildCount: number;
  readonly activeShellCount?: number | undefined;
}

function recordNativeSessionTree(
  activityLog: ServerLogSink | undefined,
  runId: string,
  phase: "held" | "interrupted" | "released",
  facts: NativeSessionTreeFacts,
): void {
  activityLog?.write(
    activityLogEvent(
      NATIVE_SESSION_TREE_OPERATION,
      { correlationId: runId },
      {
        phase,
        ...(facts.primaryActive === undefined ? {} : { primaryActive: facts.primaryActive }),
        activeChildCount: facts.activeChildCount,
        ownedChildCount: facts.ownedChildCount,
        ...(facts.activeShellCount === undefined || facts.activeShellCount === 0
          ? {}
          : { activeShellCount: facts.activeShellCount }),
      },
    ),
  );
}
