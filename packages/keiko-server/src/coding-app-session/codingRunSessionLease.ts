// Inactivity protection for the session that drives a Coding Workbench run (ADR-0141 D5, #3897).
//
// A run is one explicit operation the human started, like a Chat turn, but it outlives the request
// that admitted it: a model turn can stay quiet for longer than the idle window. Without this the
// window that started a run unpaired itself mid-run (Keiko 1.3.0 test: `coding-app-session.expired`
// with reason inactivity while the run was still working). After an admitted run mutation leaves
// the run active, the requesting session holds the existing scoped operation lease until the run
// leaves an active state. Like every operation lease it protects only inactivity: revocation,
// rotation, restart, capacity eviction and the absolute lifetime still end the session at once.
// The run-state observation below only releases; it never renews or extends anything.

import type { IncomingMessage } from "node:http";
import type { CodingWorkbenchRuntimeStateName } from "@oscharko-dev/keiko-contracts";
import type { UiHandlerDeps } from "../deps.js";
import {
  beginAppSessionOperation,
  resolveAppSessionReadAuthority,
} from "./appSessionReadAuthority.js";
import type { CodingAppSessionChannel } from "./sessionChannel.js";

/** How often a held lease re-reads its run's state; the lease ends within this of settlement. */
export const CODING_RUN_SESSION_LEASE_OBSERVATION_MS = 5_000;
/** Bounds per channel: the single active run, a parent with its children, and their windows. */
const MAX_LEASED_RUNS = 8;
const MAX_SESSIONS_PER_RUN = 4;

/** The states in which the runtime is working or waiting on a human inside the run. */
const ACTIVE_RUN_STATES: ReadonlySet<CodingWorkbenchRuntimeStateName> = new Set([
  "starting",
  "ready",
  "running",
  "awaiting-approval",
  "stopping",
]);

export function isLeaseHoldingRunState(
  state: CodingWorkbenchRuntimeStateName | undefined,
): boolean {
  return state !== undefined && ACTIVE_RUN_STATES.has(state);
}

type RunStateReader = (runId: string) => CodingWorkbenchRuntimeStateName | undefined;
type LeaseDeps = Pick<UiHandlerDeps, "codingAppSessionChannel" | "activityLog">;

interface SessionLease {
  readonly abort: AbortController;
  readonly release: () => void;
}

interface LeasedRun {
  readonly sessions: Map<string, SessionLease>;
  runState: RunStateReader;
}

class CodingRunSessionLeases {
  private readonly runs = new Map<string, LeasedRun>();
  private timer: ReturnType<typeof setInterval> | undefined;

  hold(input: {
    readonly deps: LeaseDeps;
    readonly req: IncomingMessage;
    readonly runId: string;
    readonly sessionId: string;
    readonly runState: RunStateReader;
  }): void {
    const run = this.runFor(input.runId, input.runState);
    if (run === undefined || run.sessions.has(input.sessionId)) return;
    if (run.sessions.size >= MAX_SESSIONS_PER_RUN) return;
    const abort = new AbortController();
    const release = beginAppSessionOperation(input.deps, input.req, abort.signal, {
      correlationId: input.runId,
      surface: "coding-run",
    });
    run.sessions.set(input.sessionId, { abort, release });
    this.timer ??= this.startObserving();
  }

  /** Graph disposal: every held lease ends as aborted, and nothing keeps observing. */
  abortAll(): void {
    for (const run of this.runs.values()) {
      for (const lease of run.sessions.values()) lease.abort.abort();
    }
    this.runs.clear();
    this.stopObserving();
  }

  private runFor(runId: string, runState: RunStateReader): LeasedRun | undefined {
    const existing = this.runs.get(runId);
    if (existing !== undefined) {
      existing.runState = runState;
      return existing;
    }
    if (this.runs.size >= MAX_LEASED_RUNS) return undefined;
    const run: LeasedRun = { sessions: new Map(), runState };
    this.runs.set(runId, run);
    return run;
  }

  private startObserving(): ReturnType<typeof setInterval> {
    const timer = setInterval(() => {
      this.observe();
    }, CODING_RUN_SESSION_LEASE_OBSERVATION_MS);
    timer.unref();
    return timer;
  }

  private stopObserving(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  private observe(): void {
    for (const [runId, run] of this.runs) {
      if (isLeaseHoldingRunState(run.runState(runId))) continue;
      this.runs.delete(runId);
      for (const lease of run.sessions.values()) lease.release();
    }
    if (this.runs.size === 0) this.stopObserving();
  }
}

// One set per composed channel, so independently composed servers never share leases (the
// KEIKO-0838 graph-scoping rule); the set goes away with its channel.
const leasesByChannel = new WeakMap<CodingAppSessionChannel, CodingRunSessionLeases>();

function leasesFor(channel: CodingAppSessionChannel): CodingRunSessionLeases {
  let leases = leasesByChannel.get(channel);
  if (leases === undefined) {
    leases = new CodingRunSessionLeases();
    leasesByChannel.set(channel, leases);
  }
  return leases;
}

/**
 * Keep the requesting session active while the run an admitted mutation answered for is active.
 * Absent channel, an unauthenticated request, a settled run and a session already holding this
 * run's lease change nothing.
 */
export function holdAppSessionForCodingRun(
  deps: LeaseDeps,
  req: IncomingMessage,
  snapshot: {
    readonly runId?: string | undefined;
    readonly state: CodingWorkbenchRuntimeStateName;
  },
  runState: RunStateReader,
): void {
  const channel = deps.codingAppSessionChannel;
  const runId = snapshot.runId;
  if (channel === undefined || runId === undefined || !isLeaseHoldingRunState(snapshot.state))
    return;
  const session = resolveAppSessionReadAuthority(deps, req);
  if (session === undefined) return;
  leasesFor(channel).hold({ deps, req, runId, sessionId: session.sessionId, runState });
}

/** Graph disposal: end every run lease this channel holds. */
export function abortCodingRunSessionLeases(channel: CodingAppSessionChannel | undefined): void {
  if (channel !== undefined) leasesByChannel.get(channel)?.abortAll();
}
