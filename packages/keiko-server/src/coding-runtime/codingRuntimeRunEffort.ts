// A run's effort roll-up (#3873): `coding-runtime.run.settled` says how many model calls and
// governed tool calls the run made and where its time went, so a support report answers "how many
// model turns, how much model time, how long did the human wait" without walking every child
// correlation. Counts and durations only, recorded where the run's own components observe them:
//
// - model calls at the run's model-gateway capability boundary. The coding sidecar gateway
//   reserves each call's prompt estimate against the run authority immediately before dispatching
//   it, and settles the reservation immediately after the provider answered or failed; a settlement
//   of zero tokens releases a call that was never dispatched. A settled count that differs from the
//   reserved estimate is the provider's own report. One equal to it may be the kept estimate, so it
//   is not counted: `promptTokensTotal` never presents an estimate as a provider count;
// - governed tool calls at the run's tool facade, which knows each call's action and its answer;
// - verification summaries and operator decisions at the orchestrator, which ingests and settles
//   them, and which knows how long the run waited on a human.
//
// Bounded like `codingRuntimeContextUsage`: the most recent runs, and a bounded list of open model
// calls per run. A call that cannot be paired, or a run this process did not start, is not counted
// (fail closed); nothing is guessed.
import type { CodingToolAction, CodingToolResult } from "./codingToolIpc.js";

const MAX_RETAINED_RUNS = 16;
const MAX_OPEN_MODEL_CALLS = 64;
const MAX_TRACKED_RUNS = 8;

/** The run host's share of a run's effort. */
export interface CodingRuntimeHostRunEffort {
  readonly modelTurnCount: number;
  readonly modelDurationMs: number;
  readonly promptTokensTotal: number;
  readonly toolInvocationCount: number;
  readonly workspaceReadCount: number;
  readonly editCount: number;
  readonly editRefusedCount: number;
}

/** The roll-up a run's settlement line carries. */
export interface CodingRuntimeRunEffortRollUp extends CodingRuntimeHostRunEffort {
  readonly wallDurationMs: number;
  readonly verificationCount: number;
  readonly operatorDecisionCount: number;
  readonly operatorWaitMs: number;
}

export interface CodingRuntimeRunEffortRegistry {
  readonly read: (runId: string) => CodingRuntimeHostRunEffort | undefined;
  /** The run's model-gateway capability reserved the prompt estimate of a call it dispatches. */
  readonly modelCallReserved: (runId: string, reservedPromptTokens: number) => void;
  /** The same capability settled a reservation with the call's settled prompt count. */
  readonly modelCallSettled: (
    runId: string,
    reservedPromptTokens: number,
    settledPromptTokens: number,
  ) => void;
  /** The run's tool facade answered one call, naming its closed action when the call named one. */
  readonly toolSettled: (
    runId: string,
    action: CodingToolAction | undefined,
    status: CodingToolResult["status"],
  ) => void;
}

interface OpenModelCall {
  readonly reservedPromptTokens: number;
  readonly startedAtMs: number;
}

interface HostEffortRecord {
  readonly openModelCalls: OpenModelCall[];
  modelTurnCount: number;
  modelDurationMs: number;
  promptTokensTotal: number;
  toolInvocationCount: number;
  workspaceReadCount: number;
  editCount: number;
  editRefusedCount: number;
}

// An edit the facade answered without applying it; a cancelled one was stopped, not refused.
const REFUSED_TOOL_STATUSES: ReadonlySet<CodingToolResult["status"]> = new Set([
  "failed",
  "denied",
  "invalid",
  "busy",
  "timeout",
]);

function validCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function boundedSum(left: number, right: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, left + right);
}

function newHostRecord(): HostEffortRecord {
  return {
    openModelCalls: [],
    modelTurnCount: 0,
    modelDurationMs: 0,
    promptTokensTotal: 0,
    toolInvocationCount: 0,
    workspaceReadCount: 0,
    editCount: 0,
    editRefusedCount: 0,
  };
}

function retained<T>(records: Map<string, T>, runId: string, create: () => T, limit: number): T {
  const existing = records.get(runId);
  if (existing !== undefined) return existing;
  const created = create();
  records.set(runId, created);
  while (records.size > limit) {
    const oldest = records.keys().next().value;
    if (oldest === undefined) break;
    records.delete(oldest);
  }
  return created;
}

// Oldest first among reservations of one size: however concurrent calls of one size are paired,
// the sum of their durations is the same, so the total stays exact.
function takeOpenCall(
  record: HostEffortRecord,
  reservedPromptTokens: number,
): OpenModelCall | undefined {
  const index = record.openModelCalls.findIndex(
    (call) => call.reservedPromptTokens === reservedPromptTokens,
  );
  return index < 0 ? undefined : record.openModelCalls.splice(index, 1)[0];
}

function settleModelCall(
  record: HostEffortRecord,
  call: OpenModelCall,
  settledPromptTokens: number,
  nowMs: number,
): void {
  if (settledPromptTokens === 0) return;
  record.modelTurnCount += 1;
  record.modelDurationMs = boundedSum(
    record.modelDurationMs,
    Math.max(0, nowMs - call.startedAtMs),
  );
  if (settledPromptTokens !== call.reservedPromptTokens) {
    record.promptTokensTotal = boundedSum(record.promptTokensTotal, settledPromptTokens);
  }
}

function countTool(
  record: HostEffortRecord,
  action: CodingToolAction | undefined,
  status: CodingToolResult["status"],
): void {
  record.toolInvocationCount += 1;
  if (action === "read" && status === "completed") record.workspaceReadCount += 1;
  if (action !== "edit") return;
  if (status === "completed") record.editCount += 1;
  else if (REFUSED_TOOL_STATUSES.has(status)) record.editRefusedCount += 1;
}

function hostEffort(record: HostEffortRecord): CodingRuntimeHostRunEffort {
  return {
    modelTurnCount: record.modelTurnCount,
    modelDurationMs: record.modelDurationMs,
    promptTokensTotal: record.promptTokensTotal,
    toolInvocationCount: record.toolInvocationCount,
    workspaceReadCount: record.workspaceReadCount,
    editCount: record.editCount,
    editRefusedCount: record.editRefusedCount,
  };
}

export function createCodingRuntimeRunEffortRegistry(
  options: { readonly nowMs?: (() => number) | undefined } = {},
): CodingRuntimeRunEffortRegistry {
  const nowMs = options.nowMs ?? Date.now;
  const records = new Map<string, HostEffortRecord>();
  const recordFor = (runId: string): HostEffortRecord =>
    retained(records, runId, newHostRecord, MAX_RETAINED_RUNS);
  return {
    read: (runId): CodingRuntimeHostRunEffort | undefined => {
      const record = records.get(runId);
      return record === undefined ? undefined : hostEffort(record);
    },
    modelCallReserved: (runId, reservedPromptTokens): void => {
      if (!validCount(reservedPromptTokens)) return;
      const open = recordFor(runId).openModelCalls;
      open.push({ reservedPromptTokens, startedAtMs: nowMs() });
      if (open.length > MAX_OPEN_MODEL_CALLS) open.shift();
    },
    modelCallSettled: (runId, reservedPromptTokens, settledPromptTokens): void => {
      const record = records.get(runId);
      if (record === undefined || !validCount(settledPromptTokens)) return;
      const call = takeOpenCall(record, reservedPromptTokens);
      if (call !== undefined) settleModelCall(record, call, settledPromptTokens, nowMs());
    },
    toolSettled: (runId, action, status): void => {
      if (status !== "observed") countTool(recordFor(runId), action, status);
    },
  };
}

interface OrchestratorEffortRecord {
  verificationCount: number;
  operatorDecisionCount: number;
  operatorWaitMs: number;
  waitingSinceMs: number | undefined;
}

const NO_HOST_EFFORT: CodingRuntimeHostRunEffort = {
  modelTurnCount: 0,
  modelDurationMs: 0,
  promptTokensTotal: 0,
  toolInvocationCount: 0,
  workspaceReadCount: 0,
  editCount: 0,
  editRefusedCount: 0,
};

/** Time between two strict UTC instants, or 0 when either is unreadable (fail closed). */
export function elapsedMs(fromIso: string, toIso: string): number {
  const elapsed = Date.parse(toIso) - Date.parse(fromIso);
  return Number.isSafeInteger(elapsed) && elapsed > 0 ? elapsed : 0;
}

/**
 * The orchestrator's share of a run's effort: verification summaries it ingested, operator
 * decisions it settled, and the time the run spent waiting on a human (awaiting an approval, or
 * paused on a decision a governed tool waits for). Tracked for the runs this process started; a run
 * settled after a restart reports its wall time alone, because nothing else about it was observed.
 */
export class CodingRuntimeRunEffortLedger {
  private readonly runs = new Map<string, OrchestratorEffortRecord>();

  begin(runId: string): void {
    this.runs.delete(runId);
    retained(this.runs, runId, newOrchestratorRecord, MAX_TRACKED_RUNS);
  }

  verification(runId: string): void {
    const run = this.runs.get(runId);
    if (run !== undefined) run.verificationCount += 1;
  }

  decision(runId: string): void {
    const run = this.runs.get(runId);
    if (run !== undefined) run.operatorDecisionCount += 1;
  }

  /** The run is (true) or is no longer (false) waiting on a human decision as of `atIso`. */
  waiting(runId: string, waiting: boolean, atIso: string): void {
    const run = this.runs.get(runId);
    const atMs = Date.parse(atIso);
    if (run === undefined || Number.isNaN(atMs)) return;
    if (waiting) {
      run.waitingSinceMs ??= atMs;
      return;
    }
    if (run.waitingSinceMs === undefined) return;
    run.operatorWaitMs = boundedSum(run.operatorWaitMs, Math.max(0, atMs - run.waitingSinceMs));
    run.waitingSinceMs = undefined;
  }

  /** The settlement line's roll-up; only the wall time for a run this process did not start. */
  rollUp(
    run: { readonly runId: string; readonly createdAt: string; readonly updatedAt: string },
    host: CodingRuntimeHostRunEffort | undefined,
  ): CodingRuntimeRunEffortRollUp | { readonly wallDurationMs: number } {
    const wallDurationMs = elapsedMs(run.createdAt, run.updatedAt);
    const record = this.runs.get(run.runId);
    if (record === undefined) return { wallDurationMs };
    return {
      wallDurationMs,
      ...(host ?? NO_HOST_EFFORT),
      verificationCount: record.verificationCount,
      operatorDecisionCount: record.operatorDecisionCount,
      operatorWaitMs: record.operatorWaitMs,
    };
  }

  forget(runId: string): void {
    this.runs.delete(runId);
  }
}

function newOrchestratorRecord(): OrchestratorEffortRecord {
  return {
    verificationCount: 0,
    operatorDecisionCount: 0,
    operatorWaitMs: 0,
    waitingSinceMs: undefined,
  };
}
