import {
  CODING_WORKBENCH_TASK_INTENT_MAX_CHARS,
  parseCodingWorkbenchRuntimeQuestionAnswerRequest,
  type CodingWorkbenchRuntimeEvent,
  type CodingWorkbenchRuntimeQuestionsResponse,
} from "@oscharko-dev/keiko-contracts";

import type { CodingRuntimeQuestionPort } from "./codingRuntimeQuestionPort.js";
import type { CodingRuntimeManager } from "./codingRuntimeManager.js";
import type { CodingRuntimeSnapshot } from "./codingRuntimeSnapshotStore.js";
import type {
  CodingRuntimeTaskDispatcher,
  CodingRuntimeTaskOutcome,
} from "./productionCodingRuntimeHost.js";
import type {
  CodingRuntimeOrchestratorResult,
  CodingRuntimeQuestionOperationResult,
} from "./codingRuntimeOrchestratorTypes.js";

interface RuntimeOperationCoordinatorDeps {
  readonly current: () => CodingRuntimeSnapshot | undefined;
  readonly serial: <T>(work: () => Promise<T>) => Promise<T>;
  readonly advanceRevision: (
    current: CodingRuntimeSnapshot,
    eventKind?: CodingWorkbenchRuntimeEvent["kind"],
  ) => CodingRuntimeOrchestratorResult;
  readonly publicSnapshot: (
    current: CodingRuntimeSnapshot,
  ) => Extract<CodingRuntimeOrchestratorResult, { readonly ok: true }>["snapshot"];
  readonly taskDispatcher: CodingRuntimeTaskDispatcher;
  readonly settleTask: (runId: string, outcome: CodingRuntimeTaskOutcome) => void;
  readonly questionPort: CodingRuntimeQuestionPort;
  readonly manager: CodingRuntimeManager;
}

interface RuntimeOperationReservation {
  readonly requestId: string;
  readonly commit: () => void;
  readonly release: () => void;
}

type PreparedRuntimeOperation =
  | {
      readonly ok: true;
      readonly current: CodingRuntimeSnapshot;
      readonly reservation: RuntimeOperationReservation;
      readonly value: Readonly<Record<string, unknown>> & {
        readonly requestId: string;
        readonly expectedRevision: number;
      };
    }
  // KEIKO-0722: distinguish the replay-cap exhaustion path from every other invalid-intent
  // rejection so callers can emit a dedicated failureCode instead of the generic "invalid-intent".
  | { readonly ok: false; readonly reason?: "replay-cap-exhausted" | undefined };

type QuestionMutationOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "invalid-intent" | "authority-resolution-failed" };

const FOLLOW_UP_STATES: ReadonlySet<CodingRuntimeSnapshot["state"]> = new Set([
  "running",
  "paused",
]);

export class CodingRuntimeOperationCoordinator {
  private readonly replay = new RuntimeOperationReplayCoordinator();

  public constructor(private readonly deps: RuntimeOperationCoordinatorDeps) {}

  public submitFollowUp(runId: string, input: unknown): Promise<CodingRuntimeOrchestratorResult> {
    return this.deps.serial(async () => {
      const operation = this.prepare(runId, input, ["requestId", "expectedRevision", "taskIntent"]);
      if (
        !operation.ok ||
        !FOLLOW_UP_STATES.has(operation.current.state) ||
        !validTaskIntent(operation.value.taskIntent)
      ) {
        if (operation.ok) operation.reservation.release();
        // KEIKO-0722: distinguish the cap-exhausted case from an ordinary invalid-intent.
        return failure(
          !operation.ok && operation.reason === "replay-cap-exhausted"
            ? "replay-cap-exhausted"
            : "invalid-intent",
        );
      }
      let dispatched: Awaited<ReturnType<CodingRuntimeTaskDispatcher["dispatch"]>>;
      try {
        dispatched = await this.deps.taskDispatcher.dispatch({
          runId,
          requestId: operation.value.requestId,
          expectedRevision: operation.current.revision,
          taskIntent: operation.value.taskIntent,
        });
      } catch {
        dispatched = { ok: false };
      }
      if (!dispatched.ok) {
        operation.reservation.release();
        return failure("authority-resolution-failed");
      }
      operation.reservation.commit();
      this.observeTaskCompletion(runId, dispatched.completion);
      return this.deps.advanceRevision(operation.current, "task-submitted");
    });
  }

  public listQuestions(
    runId: string,
    input: unknown,
  ): Promise<CodingRuntimeQuestionOperationResult> {
    return this.deps.serial<CodingRuntimeQuestionOperationResult>(async () => {
      const operation = this.prepare(runId, input, ["requestId", "expectedRevision"]);
      if (!operation.ok) {
        return failure(
          operation.reason === "replay-cap-exhausted" ? "replay-cap-exhausted" : "invalid-intent",
        );
      }
      let questions: CodingWorkbenchRuntimeQuestionsResponse | undefined;
      try {
        questions = await this.deps.questionPort.list(operationRequest(runId, operation));
      } catch {
        questions = undefined;
      }
      if (questions === undefined) {
        operation.reservation.release();
        return failure("authority-resolution-failed");
      }
      // #2906: release, never commit -- listing is a read. It must not advance the revision (or
      // any background question refresh would race concurrent operator actions into revision
      // conflicts), and for the exact same reason it must not occupy a permanent slot in the
      // per-run replay cap either: nothing here ever moves the live revision, so a committed read
      // id could never become supersede-and-evictable, and unbounded polling would otherwise
      // exhaust the same 512-id budget real mutations share.
      operation.reservation.release();
      return { ok: true, snapshot: this.deps.publicSnapshot(operation.current), questions };
    });
  }

  public answerQuestion(runId: string, input: unknown): Promise<CodingRuntimeOrchestratorResult> {
    return this.mutateQuestion(runId, input, "answer");
  }

  public rejectQuestion(runId: string, input: unknown): Promise<CodingRuntimeOrchestratorResult> {
    return this.mutateQuestion(runId, input, "reject");
  }

  public async startInitialTurn(input: {
    readonly runId: string;
    readonly requestId: string;
    readonly expectedRevision: number;
    readonly taskIntent: string;
  }): Promise<"accepted" | "failed" | "recovery-required"> {
    const reserveOutcome = this.replay.reserve(
      input.runId,
      input.requestId,
      input.expectedRevision,
    );
    if ("rejection" in reserveOutcome) return "recovery-required";
    const { reservation } = reserveOutcome;
    let dispatched: Awaited<ReturnType<CodingRuntimeTaskDispatcher["dispatch"]>>;
    try {
      dispatched = await this.deps.taskDispatcher.dispatch(input);
    } catch {
      dispatched = { ok: false };
    }
    if (dispatched.ok) {
      reservation.commit();
      this.observeTaskCompletion(input.runId, dispatched.completion);
      return "accepted";
    }
    reservation.release();
    try {
      const stopped = await this.deps.manager.stop(input.runId);
      return stopped.ok ? "failed" : "recovery-required";
    } catch {
      return "recovery-required";
    }
  }

  public clear(runId: string): void {
    this.replay.clear(runId);
  }

  private observeTaskCompletion(
    runId: string,
    completion: Promise<CodingRuntimeTaskOutcome>,
  ): void {
    void completion.then(
      (outcome): void => {
        this.deps.settleTask(runId, outcome);
      },
      (): void => {
        this.deps.settleTask(runId, "failed");
      },
    );
  }

  private mutateQuestion(
    runId: string,
    input: unknown,
    action: "answer" | "reject",
  ): Promise<CodingRuntimeOrchestratorResult> {
    return this.deps.serial(async () => {
      const keys =
        action === "answer"
          ? ["requestId", "expectedRevision", "questionId", "answers"]
          : ["requestId", "expectedRevision", "questionId"];
      const operation = this.prepare(runId, input, keys);
      if (!operation.ok || !validQuestionId(operation.value.questionId)) {
        if (operation.ok) operation.reservation.release();
        return failure(
          !operation.ok && operation.reason === "replay-cap-exhausted"
            ? "replay-cap-exhausted"
            : "invalid-intent",
        );
      }
      const outcome = await this.applyQuestionMutation(
        runId,
        action,
        operation,
        operation.value.questionId,
      );
      if (!outcome.ok) {
        operation.reservation.release();
        return failure(outcome.reason);
      }
      operation.reservation.commit();
      return this.deps.advanceRevision(operation.current);
    });
  }

  // Issues the answer/reject port call for an already-admitted question operation. Split out of
  // mutateQuestion() so that method stays under the line/complexity ceiling; behaviour (including
  // which failureCode each path maps to) is unchanged from the inline version it replaced.
  private async applyQuestionMutation(
    runId: string,
    action: "answer" | "reject",
    operation: Extract<PreparedRuntimeOperation, { readonly ok: true }>,
    // Already validated by validQuestionId(operation.value.questionId) at the mutateQuestion()
    // call site: `operation.value` types every field but requestId/expectedRevision as unknown
    // (it is shared across every operation kind, not just answer/reject), so that narrowing
    // cannot survive the call into this method and questionId is threaded through explicitly.
    questionId: string,
  ): Promise<QuestionMutationOutcome> {
    try {
      if (action !== "answer") {
        const accepted = await this.deps.questionPort.reject({
          ...operationRequest(runId, operation),
          questionId,
        });
        return accepted ? { ok: true } : { ok: false, reason: "authority-resolution-failed" };
      }
      // requestId/expectedRevision are already bound and verified by prepare() above
      // (isExactRecord + expectedRevision-vs-current.revision + the one-use requestId replay
      // reservation) — this is a consolidation of that existing binding into the shared contract
      // type (KEIKO-0411), not a new check at this call site. The values are already known-valid;
      // the aggregate answers byte budget below is the one genuinely new protection this parse
      // call adds here.
      const answers = parseCodingWorkbenchRuntimeQuestionAnswerRequest({
        requestId: operation.value.requestId,
        expectedRevision: operation.value.expectedRevision,
        questionRequestId: questionId,
        answers: operation.value.answers,
      });
      if (!answers.ok) return { ok: false, reason: "invalid-intent" };
      const accepted = await this.deps.questionPort.answer({
        ...operationRequest(runId, operation),
        questionId,
        answers: answers.value.answers,
      });
      return accepted ? { ok: true } : { ok: false, reason: "authority-resolution-failed" };
    } catch {
      return { ok: false, reason: "authority-resolution-failed" };
    }
  }

  private prepare(
    runId: string,
    input: unknown,
    keys: readonly string[],
  ): PreparedRuntimeOperation {
    const admitted = admitRuntimeOperation(input, keys, this.deps.current(), runId);
    if (admitted === undefined) return { ok: false };
    const reserveOutcome = this.replay.reserve(
      runId,
      admitted.value.requestId,
      admitted.current.revision,
    );
    if ("rejection" in reserveOutcome) {
      // KEIKO-0722: distinguish the cap-exhausted case so callers emit "replay-cap-exhausted";
      // an ordinary duplicate/pending stays "invalid-intent" as before.
      return reserveOutcome.rejection === "cap-exhausted"
        ? { ok: false, reason: "replay-cap-exhausted" }
        : { ok: false };
    }
    return {
      ok: true,
      current: admitted.current,
      reservation: reserveOutcome.reservation,
      value: admitted.value,
    };
  }
}

// Inline answer/reject operations are admitted while the run is running or paused; follow-up
// additionally requires running, so a paused run cannot queue new work. Every other lifecycle
// state fails closed. Split out of prepare() so that method stays under the complexity ceiling;
// returns the narrowed snapshot and input together so a successful admission cannot be reported
// with a stale/undefined current snapshot.
function admitRuntimeOperation(
  input: unknown,
  keys: readonly string[],
  current: CodingRuntimeSnapshot | undefined,
  runId: string,
):
  | {
      readonly current: CodingRuntimeSnapshot;
      readonly value: Readonly<Record<string, unknown>> & {
        readonly requestId: string;
        readonly expectedRevision: number;
      };
    }
  | undefined {
  if (
    !isExactRecord(input, keys) ||
    current?.runId !== runId ||
    !(current.state === "running" || current.state === "paused")
  ) {
    return undefined;
  }
  // The one-use request id plus monotonic revision reservation admit exactly one turn per
  // revision, so a second concurrent follow-up fails closed instead of queueing.
  if (
    !validRequestId(input.requestId) ||
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision !== current.revision
  ) {
    return undefined;
  }
  return {
    current,
    value: input as Readonly<Record<string, unknown>> & {
      readonly requestId: string;
      readonly expectedRevision: number;
    },
  };
}

// Per-run replay/duplicate-detection budget. Sized well above any plausible single-run operation
// count; #2906: exhausting it no longer permanently locks a live run (see evictSuperseded below),
// so this only bounds how many requestIds still relevant to the CURRENT revision may be tracked
// at once.
const REPLAY_COMMITTED_CAP = 512;

class RuntimeOperationReplayCoordinator {
  // requestId -> the live revision at the moment it was committed.
  private readonly committed = new Map<string, Map<string, number>>();
  private readonly pending = new Map<string, Set<string>>();

  public reserve(
    runId: string,
    requestId: string,
    liveRevision: number,
  ):
    | { readonly reservation: RuntimeOperationReservation }
    | { readonly rejection: "cap-exhausted" | "duplicate" } {
    const committed = this.evictSuperseded(runId, liveRevision);
    const pending = this.pending.get(runId) ?? new Set<string>();
    if (committed.size >= REPLAY_COMMITTED_CAP) return { rejection: "cap-exhausted" };
    if (committed.has(requestId) || pending.has(requestId)) return { rejection: "duplicate" };
    pending.add(requestId);
    this.pending.set(runId, pending);
    let active = true;
    const release = (): void => {
      if (!active) return;
      active = false;
      pending.delete(requestId);
      if (pending.size === 0) this.pending.delete(runId);
    };
    const reservation: RuntimeOperationReservation = {
      requestId,
      commit: (): void => {
        if (!active) return;
        committed.set(requestId, liveRevision);
        this.committed.set(runId, committed);
        release();
      },
      release,
    };
    return { reservation };
  }

  // A requestId committed at revision N is only ever reachable again by a caller that ALSO
  // supplies expectedRevision === N: admitRuntimeOperation enforces that match against the live
  // snapshot before this coordinator is even consulted. The stored revision N is the PRE-op
  // revision at commit time, so the op that owned it advanced live to N+1. A legitimate direct
  // replay attempt therefore arrives with `expectedRevision: N+1` — dropping at `revision < live`
  // (i.e. as soon as live > N) evicts before the very next op can be checked for that requestId,
  // silently admitting `answer` + `reject` reuse of the same requestId across the same advance.
  // The correct condition retains a committed record until live has moved beyond that op's own
  // post-revision (live > N + 1). That still bounds unbounded polling once live truly overtakes,
  // but preserves duplicate detection for the immediate next admission window (#2906).
  private evictSuperseded(runId: string, liveRevision: number): Map<string, number> {
    const committed = this.committed.get(runId) ?? new Map<string, number>();
    for (const [requestId, revision] of committed) {
      if (revision + 1 < liveRevision) committed.delete(requestId);
    }
    return committed;
  }

  public clear(runId: string): void {
    this.committed.delete(runId);
    this.pending.delete(runId);
  }
}

function operationRequest(
  runId: string,
  operation: Extract<PreparedRuntimeOperation, { readonly ok: true }>,
): { readonly runId: string; readonly requestId: string; readonly expectedRevision: number } {
  return {
    runId,
    requestId: operation.value.requestId,
    expectedRevision: operation.current.revision,
  };
}

function failure<T extends string>(
  failureCode: T,
): { readonly ok: false; readonly failureCode: T } {
  return { ok: false, failureCode };
}

function isExactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function validRequestId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);
}

function validTaskIntent(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= CODING_WORKBENCH_TASK_INTENT_MAX_CHARS
  );
}

function validQuestionId(value: unknown): value is string {
  return typeof value === "string" && /^que_[A-Za-z0-9_-]{1,251}$/u.test(value);
}
