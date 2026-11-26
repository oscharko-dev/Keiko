// A run's effort roll-up (#3873): `coding-runtime.run.settled` says how many model calls and
// governed tool calls the run made and where its time went, so a support report answers "how many
// model turns, how much model time, how long did the human wait" without walking every child
// correlation. Counts and durations only, recorded where the run's own components observe them:
//
// - model calls at the run's model-gateway capability boundary. The coding sidecar gateway
//   reserves each call's prompt estimate against the run authority immediately before dispatching
//   it, and settles the reservation immediately after the provider answered or failed; a settlement
//   of zero tokens releases a call that was never dispatched. The reservation answers an opaque call
//   identity and the settlement names it, so a call's duration is always measured from its own
//   reservation: pairing by reservation size alone measured a released call and an answered one of
//   the same size from each other's start (#3873 review). A settled count that differs from the
//   reserved estimate is the provider's own report. One equal to it may be the kept estimate, so it
//   is not counted: `promptTokensTotal` never presents an estimate as a provider count;
// - governed tool calls at the run's tool facade, which knows each call's action and its answer;
// - verification summaries and operator decisions at the orchestrator, which ingests and settles
//   them, and which knows how long the run waited on a human.
//
// Bounded like `codingRuntimeContextUsage`: the most recent runs, and a bounded list of open model
// calls per run. A settlement that names no open call, or a run this process did not start, is not
// counted (fail closed); nothing is guessed.
import { editNeedsVerification } from "./codingRuntimeDocumentationPaths.js";
import type { CodingToolAction, CodingToolResult } from "./codingToolIpc.js";
import type {
  CodingVerificationBlockedReason,
  CodingVerificationExecutedObserver,
  CodingVerificationNotRunScope,
} from "./codingToolFacadePorts.js";

const MAX_RETAINED_RUNS = 16;
const MAX_OPEN_MODEL_CALLS = 64;
const MAX_TRACKED_RUNS = 8;
const MAX_SETTLED_DEBTS = 64;

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
  /**
   * The run's model-gateway capability reserved the prompt estimate of a call it dispatches. Answers
   * the call's identity (an opaque number its settlement names, never reused), or `undefined` for
   * an estimate that is not a count (nothing is tracked).
   */
  readonly modelCallReserved: (runId: string, reservedPromptTokens: number) => number | undefined;
  /**
   * The same capability settled the call it reserved, naming it, with the call's settled prompt
   * count; zero releases a call that was never dispatched. A settlement that names no open call of
   * the run is not counted.
   */
  readonly modelCallSettled: (
    runId: string,
    modelCallId: number | undefined,
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
  readonly id: number;
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

// The open call a settlement names, removed once taken: a call is settled or released exactly once,
// and never against another call's reservation.
function takeOpenCall(record: HostEffortRecord, modelCallId: number): OpenModelCall | undefined {
  const index = record.openModelCalls.findIndex((call) => call.id === modelCallId);
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
  let nextModelCallId = 1;
  const recordFor = (runId: string): HostEffortRecord =>
    retained(records, runId, newHostRecord, MAX_RETAINED_RUNS);
  return {
    read: (runId): CodingRuntimeHostRunEffort | undefined => {
      const record = records.get(runId);
      return record === undefined ? undefined : hostEffort(record);
    },
    modelCallReserved: (runId, reservedPromptTokens): number | undefined => {
      if (!validCount(reservedPromptTokens)) return undefined;
      const open = recordFor(runId).openModelCalls;
      const id = nextModelCallId;
      nextModelCallId += 1;
      open.push({ id, reservedPromptTokens, startedAtMs: nowMs() });
      if (open.length > MAX_OPEN_MODEL_CALLS) open.shift();
      return id;
    },
    modelCallSettled: (runId, modelCallId, settledPromptTokens): void => {
      const record = records.get(runId);
      if (record === undefined || modelCallId === undefined || !validCount(settledPromptTokens)) {
        return;
      }
      const call = takeOpenCall(record, modelCallId);
      if (call !== undefined) settleModelCall(record, call, settledPromptTokens, nowMs());
    },
    toolSettled: (runId, action, status): void => {
      if (status !== "observed") countTool(recordFor(runId), action, status);
    },
  };
}

/**
 * What a failed check left in the ledger for the fact-based continuation: which check (a closed
 * word, `check` when the verifier is not one of the known kinds) and how many of its steps failed.
 * Never a path, a line of output or a message.
 */
export interface CodingVerificationFailureEvidence {
  readonly check: "test" | "targeted-test" | "typecheck" | "lint" | "build" | "check";
  readonly failedCount: number;
}

interface OrchestratorEffortRecord {
  verificationCount: number;
  appliedEditCount: number;
  verificationRequired: boolean;
  /** The task's last change had no passing check when this run began (#4492). */
  inheritedVerificationDebt: boolean;
  editRevision: number;
  readonly verificationTargets: Map<string, VerificationTargetState>;
  verificationBlocker: CodingVerificationBlockedReason | undefined;
  blockerRevision: number;
  operatorDecisionCount: number;
  operatorWaitMs: number;
  waitingSinceMs: number | undefined;
}

interface VerificationTargetState {
  readonly passed: boolean;
  readonly selected: boolean;
  /** The target's check ran after the run's last code edit and failed; cleared by the next edit. */
  readonly failure?: CodingVerificationFailureEvidence;
  readonly notRun?: boolean;
  readonly blockedReason?: CodingVerificationBlockedReason;
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
  // Settled runs that handed an inherited verification debt on (#4492), kept past `forget` so the
  // task's next follow-up still owes the check; bounded like every record this process keeps.
  private readonly settledDebts = new Map<string, true>();

  begin(runId: string): void {
    this.runs.delete(runId);
    retained(this.runs, runId, newOrchestratorRecord, MAX_TRACKED_RUNS);
  }

  /**
   * A run that continues a task whose last change was left without a passing check (#4492)
   * inherits that debt. A check it runs must pass, or the run cannot settle as succeeded; a run
   * that runs no check (a question, a summary) is not failed for it, but hands the debt on.
   */
  inheritVerificationDebt(runId: string, unverifiedPredecessor: boolean): void {
    const run = this.runs.get(runId);
    if (run !== undefined && unverifiedPredecessor) run.inheritedVerificationDebt = true;
  }

  /** Whether the run inherited a verification debt and ended without a passing check for it. */
  carriesVerificationDebt(runId: string): boolean {
    const run = this.runs.get(runId);
    if (run === undefined) return this.settledDebts.has(runId);
    return run.inheritedVerificationDebt && !everySelectedPassed(run);
  }

  /**
   * An applied edit of the run. An edit that changed documentation alone is no change a check could
   * contradict: it demands no verification and leaves the run's earlier results standing; any edit
   * that changed code, or named no path, demands one after it (#4491).
   */
  edit(runId: string, changedPaths?: readonly string[]): void {
    const run = this.runs.get(runId);
    if (run === undefined) return;
    run.appliedEditCount = boundedSum(run.appliedEditCount, 1);
    if (!editNeedsVerification(changedPaths)) return;
    run.verificationRequired = true;
    run.editRevision = boundedSum(run.editRevision, 1);
    for (const [target, state] of run.verificationTargets) {
      const { failure: _superseded, ...rest } = state;
      run.verificationTargets.set(target, { ...rest, passed: false });
    }
  }

  verificationRevision(runId: string): number | undefined {
    const revision = this.runs.get(runId)?.editRevision;
    return revision === Number.MAX_SAFE_INTEGER ? undefined : revision;
  }

  verification(
    runId: string,
    passed: boolean | null = false,
    target = "legacy",
    editRevision?: number,
    failure?: CodingVerificationFailureEvidence,
  ): void {
    const run = this.runs.get(runId);
    if (run === undefined) return;
    run.verificationCount += 1;
    if (passed === null || run.verificationTargets.get(target)?.notRun === true) return;
    if (!verificationAtCurrentRevision(run, editRevision)) {
      // A late old summary must not erase an already observed fresh pass for this same target.
      if (!run.verificationTargets.has(target))
        run.verificationTargets.set(target, { passed: false, selected: true });
      return;
    }
    run.verificationTargets.set(target, { passed, selected: true, ...failedWith(passed, failure) });
  }

  /** Whether a summary's edit revision is the run's current one (the rule `verification` applies). */
  summaryIsCurrent(runId: string, editRevision: number | undefined): boolean {
    const run = this.runs.get(runId);
    return run !== undefined && verificationAtCurrentRevision(run, editRevision);
  }

  verificationBlocked(
    runId: string,
    reason: CodingVerificationBlockedReason,
    targetDigest?: string,
    scope: CodingVerificationNotRunScope = "blocks-repair",
  ): void {
    const run = this.runs.get(runId);
    if (run === undefined) return;
    const selected = markVerificationNotRun(run, reason, targetDigest);
    if (scope === "evidence-only" || !verificationBlockerApplies(targetDigest, selected)) return;
    run.blockerRevision = boundedSum(run.blockerRevision, 1);
    setVerificationBlocker(run, reason, targetDigest);
  }

  verificationAdmitted(runId: string): CodingVerificationExecutedObserver | undefined {
    const run = this.runs.get(runId);
    if (run === undefined) return undefined;
    const revision = run.blockerRevision;
    return (targetDigest): void => {
      if (
        this.runs.get(runId) !== run ||
        run.blockerRevision !== revision ||
        revision === Number.MAX_SAFE_INTEGER
      )
        return;
      run.verificationBlocker = undefined;
      const selected = run.verificationTargets.get(targetDigest);
      if (selected !== undefined) {
        run.verificationTargets.set(targetDigest, { passed: selected.passed, selected: true });
      }
    };
  }

  verificationBlockedReason(runId: string): CodingVerificationBlockedReason | undefined {
    const run = this.runs.get(runId);
    return (
      run?.verificationBlocker ??
      [...(run?.verificationTargets.values() ?? [])].find(
        (state) => state.selected && !state.passed && state.blockedReason !== undefined,
      )?.blockedReason
    );
  }

  /**
   * The check that ran after the run's last code edit and failed, when one did: the one fact that
   * justifies sending the model back to repair (#4491). Absent when no check ran, when a check
   * could not start, or when every check since the last edit passed.
   */
  failedCheck(runId: string): CodingVerificationFailureEvidence | undefined {
    const run = this.runs.get(runId);
    if (run === undefined) return undefined;
    return [...run.verificationTargets.values()].find(
      (state) => state.selected && !state.passed && state.failure !== undefined,
    )?.failure;
  }

  /** Whether the run applied edits and every one of them changed documentation alone. */
  documentationOnly(runId: string): boolean {
    const run = this.runs.get(runId);
    return run !== undefined && run.appliedEditCount > 0 && !run.verificationRequired;
  }

  needsVerification(runId: string): boolean {
    const run = this.runs.get(runId);
    if (run === undefined) return false;
    if (run.verificationRequired) return !everySelectedPassed(run);
    return run.inheritedVerificationDebt && hasSelectedTargets(run) && !everySelectedPassed(run);
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
    if (this.carriesVerificationDebt(runId)) {
      retained(this.settledDebts, runId, () => true as const, MAX_SETTLED_DEBTS);
    }
    this.runs.delete(runId);
  }
}

// The failed check's evidence rides the target only while the target is failing.
function failedWith(
  passed: boolean,
  failure: CodingVerificationFailureEvidence | undefined,
): { readonly failure?: CodingVerificationFailureEvidence } {
  return passed || failure === undefined ? {} : { failure };
}

function verificationAtCurrentRevision(
  run: OrchestratorEffortRecord,
  revision: number | undefined,
): boolean {
  return (
    !run.verificationRequired ||
    (revision !== undefined &&
      revision !== Number.MAX_SAFE_INTEGER &&
      revision === run.editRevision)
  );
}

function markVerificationNotRun(
  run: OrchestratorEffortRecord,
  reason: CodingVerificationBlockedReason,
  targetDigest: string | undefined,
): VerificationTargetState | undefined {
  const selected =
    targetDigest === undefined ? undefined : run.verificationTargets.get(targetDigest);
  if (reason === "VERIFICATION_NOT_RUN" && targetDigest !== undefined) {
    run.verificationTargets.set(targetDigest, {
      ...(selected ?? { passed: false, selected: false }),
      notRun: true,
    });
  }
  return selected;
}

function verificationBlockerApplies(
  targetDigest: string | undefined,
  selected: VerificationTargetState | undefined,
): boolean {
  // A target-scoped refusal blocks repair only for a selected, still failing target: while none is
  // selected, the target was unrelated to the change and another check can still evidence it.
  return targetDigest === undefined || (selected?.selected === true && !selected.passed);
}

function setVerificationBlocker(
  run: OrchestratorEffortRecord,
  reason: CodingVerificationBlockedReason,
  targetDigest: string | undefined,
): void {
  const selected =
    targetDigest === undefined ? undefined : run.verificationTargets.get(targetDigest);
  if (targetDigest !== undefined && selected?.selected === true) {
    run.verificationTargets.set(targetDigest, { ...selected, blockedReason: reason });
  } else {
    run.verificationBlocker = reason;
  }
}

function hasSelectedTargets(run: OrchestratorEffortRecord): boolean {
  return [...run.verificationTargets.values()].some((state) => state.selected);
}

/** At least one check was selected and every selected check passed. */
function everySelectedPassed(run: OrchestratorEffortRecord): boolean {
  return (
    hasSelectedTargets(run) &&
    [...run.verificationTargets.values()].every((state) => !state.selected || state.passed)
  );
}

function newOrchestratorRecord(): OrchestratorEffortRecord {
  return {
    verificationCount: 0,
    appliedEditCount: 0,
    verificationRequired: false,
    inheritedVerificationDebt: false,
    editRevision: 0,
    verificationTargets: new Map(),
    verificationBlocker: undefined,
    blockerRevision: 0,
    operatorDecisionCount: 0,
    operatorWaitMs: 0,
    waitingSinceMs: undefined,
  };
}
