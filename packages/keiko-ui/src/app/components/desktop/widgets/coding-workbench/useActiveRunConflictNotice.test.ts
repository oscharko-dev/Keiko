import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CodingWorkbenchRuntimeSnapshot } from "@oscharko-dev/keiko-contracts";
import type {
  CodingWorkbenchMutationKind,
  CodingWorkbenchMutationState,
  CodingWorkbenchRuntimeState,
} from "@/lib/coding-workbench-live-state";
import { useActiveRunConflictNotice } from "./useActiveRunConflictNotice";

const CONFLICT = "CODING_RUNTIME_ACTIVE_RUN_CONFLICT";
const TASK = "Fix the flaky retry loop";

const IDLE: CodingWorkbenchMutationState = {
  status: "idle",
  kind: null,
  requestId: null,
  error: null,
};

function superseded(
  kind: CodingWorkbenchMutationKind | null,
  code: string,
): CodingWorkbenchMutationState {
  return { ...IDLE, supersededFailure: { kind, code } };
}

function pending(kind: CodingWorkbenchMutationKind): CodingWorkbenchMutationState {
  return { status: "pending", kind, requestId: "req-1", error: null };
}

function stateOf(
  mutation: CodingWorkbenchMutationState,
  runState: "running" | "succeeded" | null,
): Pick<CodingWorkbenchRuntimeState, "mutation" | "run"> {
  const value =
    runState === null
      ? null
      : ({
          schemaVersion: "1",
          state: runState,
          revision: 1,
          updatedAt: "2026-07-13T12:00:00.000Z",
          runId: "run-other",
        } as CodingWorkbenchRuntimeSnapshot);
  return { mutation, run: { status: "ready", value, error: null } };
}

interface Props {
  readonly mutation: CodingWorkbenchMutationState;
  readonly runState: "running" | "succeeded" | null;
  readonly draft: string;
}

function mount(initial: Props): {
  readonly hook: ReturnType<
    typeof renderHook<ReturnType<typeof useActiveRunConflictNotice>, Props>
  >;
  readonly setTaskIntent: ReturnType<typeof vi.fn<(value: string) => void>>;
} {
  const setTaskIntent = vi.fn<(value: string) => void>();
  const hook = renderHook(
    ({ mutation, runState, draft }: Props) =>
      useActiveRunConflictNotice({
        state: stateOf(mutation, runState),
        taskIntent: draft,
        setTaskIntent,
      }),
    { initialProps: initial },
  );
  return { hook, setTaskIntent };
}

describe("useActiveRunConflictNotice (U-14)", () => {
  it.each([
    ["a superseded stop", superseded("stop", CONFLICT)],
    ["a superseded start refused for another reason", superseded("start", "CODING_RUNTIME_OTHER")],
    ["an idle mutation", IDLE],
  ])("does not hold the task for %s", (_name, mutation) => {
    const { hook } = mount({ mutation, runState: "running", draft: TASK });
    expect(hook.result.current.visible).toBe(false);
    expect(hook.result.current.taskIntent).toBe(TASK);
  });

  it("holds the task locally when a start is refused, whatever the shared draft then says", () => {
    const { hook, setTaskIntent } = mount({ mutation: IDLE, runState: null, draft: TASK });
    hook.rerender({ mutation: superseded("start", CONFLICT), runState: "running", draft: TASK });
    expect(hook.result.current.visible).toBe(true);

    hook.rerender({ mutation: superseded("start", CONFLICT), runState: "running", draft: "" });
    expect(hook.result.current.taskIntent).toBe(TASK);
    expect(setTaskIntent).not.toHaveBeenCalled();
  });

  it("holds nothing when the composer was empty at the refusal", () => {
    const { hook } = mount({ mutation: IDLE, runState: null, draft: "" });
    hook.rerender({ mutation: superseded("start", CONFLICT), runState: "running", draft: "" });
    expect(hook.result.current.visible).toBe(true);
    expect(hook.result.current.taskIntent).toBe("");
  });

  it("drops the held task and the notice on a deliberate reset", () => {
    const { hook, setTaskIntent } = mount({ mutation: IDLE, runState: null, draft: TASK });
    hook.rerender({ mutation: superseded("start", CONFLICT), runState: "running", draft: TASK });

    act(() => hook.result.current.onDraftReset());
    hook.rerender({ mutation: superseded("start", CONFLICT), runState: "running", draft: "" });

    expect(setTaskIntent).toHaveBeenCalledExactlyOnceWith("");
    expect(hook.result.current.visible).toBe(false);
    expect(hook.result.current.taskIntent).toBe("");
  });

  it("lets the person's own edit replace the held task, including an empty one", () => {
    const { hook, setTaskIntent } = mount({ mutation: IDLE, runState: null, draft: TASK });
    hook.rerender({ mutation: superseded("start", CONFLICT), runState: "running", draft: TASK });

    act(() => hook.result.current.onTaskIntentChange(""));
    hook.rerender({ mutation: superseded("start", CONFLICT), runState: "running", draft: "" });

    expect(setTaskIntent).toHaveBeenCalledExactlyOnceWith("");
    expect(hook.result.current.taskIntent).toBe("");
  });

  it("ends the notice when the other run ends and keeps the task until the person acts", () => {
    const { hook } = mount({ mutation: IDLE, runState: null, draft: TASK });
    hook.rerender({ mutation: superseded("start", CONFLICT), runState: "running", draft: TASK });
    expect(hook.result.current.visible).toBe(true);

    hook.rerender({ mutation: superseded("start", CONFLICT), runState: "succeeded", draft: "" });
    expect(hook.result.current.visible).toBe(false);
    expect(hook.result.current.taskIntent).toBe(TASK);
  });

  it("commits the held task to the draft on a new Start, so a failed Start keeps it", () => {
    const { hook, setTaskIntent } = mount({ mutation: IDLE, runState: null, draft: TASK });
    hook.rerender({ mutation: superseded("start", CONFLICT), runState: "running", draft: TASK });
    hook.rerender({ mutation: superseded("start", CONFLICT), runState: "running", draft: "" });

    hook.rerender({ mutation: pending("start"), runState: "succeeded", draft: "" });

    expect(setTaskIntent).toHaveBeenCalledExactlyOnceWith(TASK);
    expect(hook.result.current.visible).toBe(false);
    hook.rerender({ mutation: pending("start"), runState: "succeeded", draft: TASK });
    expect(hook.result.current.taskIntent).toBe(TASK);
  });

  it("is not disarmed by a pending mutation that takes no task text", () => {
    const { hook } = mount({ mutation: IDLE, runState: null, draft: TASK });
    hook.rerender({ mutation: superseded("start", CONFLICT), runState: "running", draft: TASK });
    hook.rerender({ mutation: pending("stop"), runState: "running", draft: TASK });
    expect(hook.result.current.visible).toBe(true);
  });

  it("asks before the tab closes while a task is held, and not otherwise", () => {
    const { hook } = mount({ mutation: IDLE, runState: null, draft: TASK });
    const closing = (): boolean => {
      const event = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    };
    expect(closing()).toBe(false);

    hook.rerender({ mutation: superseded("start", CONFLICT), runState: "running", draft: TASK });
    expect(closing()).toBe(true);

    act(() => hook.result.current.onDraftReset());
    expect(closing()).toBe(false);
  });
});
