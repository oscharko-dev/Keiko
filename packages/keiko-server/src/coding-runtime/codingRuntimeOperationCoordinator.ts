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
  | { readonly ok: false };

export class CodingRuntimeOperationCoordinator {
  private readonly replay = new RuntimeOperationReplayCoordinator();

  public constructor(private readonly deps: RuntimeOperationCoordinatorDeps) {}

  public submitFollowUp(runId: string, input: unknown): Promise<CodingRuntimeOrchestratorResult> {
    return this.deps.serial(async () => {
      const operation = this.prepare(runId, input, ["requestId", "expectedRevision", "taskIntent"]);
      if (!operation.ok || !validTaskIntent(operation.value.taskIntent)) {
        if (operation.ok) operation.reservation.release();
        return failure("invalid-intent");
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
      if (!operation.ok) return failure("invalid-intent");
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
      operation.reservation.commit();
      // Listing is a read: the revision must NOT advance, or any background question refresh
      // would race concurrent operator actions (pause/answer/follow-up) into revision conflicts.
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
    const reservation = this.replay.reserve(input.runId, input.requestId);
    if (reservation === undefined) return "recovery-required";
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
        return failure("invalid-intent");
      }
      let accepted: boolean;
      try {
        if (action === "answer") {
          const answers = parseCodingWorkbenchRuntimeQuestionAnswerRequest({
            answers: operation.value.answers,
          });
          if (!answers.ok) {
            operation.reservation.release();
            return failure("invalid-intent");
          }
          accepted = await this.deps.questionPort.answer({
            ...operationRequest(runId, operation),
            questionId: operation.value.questionId,
            answers: answers.value.answers,
          });
        } else {
          accepted = await this.deps.questionPort.reject({
            ...operationRequest(runId, operation),
            questionId: operation.value.questionId,
          });
        }
      } catch {
        accepted = false;
      }
      if (!accepted) {
        operation.reservation.release();
        return failure("authority-resolution-failed");
      }
      operation.reservation.commit();
      return this.deps.advanceRevision(operation.current);
    });
  }

  private prepare(
    runId: string,
    input: unknown,
    keys: readonly string[],
  ): PreparedRuntimeOperation {
    const current = this.deps.current();
    // Inline human-interaction (answer/reject/follow-up) is admitted while the run is running or
    // paused; every other lifecycle state fails closed. No hidden prompt queue is possible: the
    // one-use request id plus monotonic revision reservation admit exactly one turn per revision,
    // so a second concurrent follow-up fails closed rather than queueing behind the active one.
    if (
      !isExactRecord(input, keys) ||
      current?.runId !== runId ||
      !(current.state === "running" || current.state === "paused")
    ) {
      return { ok: false };
    }
    if (
      !validRequestId(input.requestId) ||
      !Number.isSafeInteger(input.expectedRevision) ||
      input.expectedRevision !== current.revision
    ) {
      return { ok: false };
    }
    const reservation = this.replay.reserve(runId, input.requestId);
    return reservation === undefined
      ? { ok: false }
      : {
          ok: true,
          current,
          reservation,
          value: input as Readonly<Record<string, unknown>> & {
            readonly requestId: string;
            readonly expectedRevision: number;
          },
        };
  }
}

class RuntimeOperationReplayCoordinator {
  private readonly committed = new Map<string, Set<string>>();
  private readonly pending = new Map<string, Set<string>>();

  public reserve(runId: string, requestId: string): RuntimeOperationReservation | undefined {
    const committed = this.committed.get(runId) ?? new Set<string>();
    const pending = this.pending.get(runId) ?? new Set<string>();
    if (committed.size >= 512 || committed.has(requestId) || pending.has(requestId))
      return undefined;
    pending.add(requestId);
    this.pending.set(runId, pending);
    let active = true;
    const release = (): void => {
      if (!active) return;
      active = false;
      pending.delete(requestId);
      if (pending.size === 0) this.pending.delete(runId);
    };
    return {
      requestId,
      commit: (): void => {
        if (!active) return;
        committed.add(requestId);
        this.committed.set(runId, committed);
        release();
      },
      release,
    };
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
