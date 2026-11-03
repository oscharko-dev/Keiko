import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { CodingWorkbenchMutationState } from "@/lib/coding-workbench-live-state";
import { usePromptDeliveryNotice } from "./usePromptDeliveryNotice";

const IDLE: CodingWorkbenchMutationState = {
  status: "idle",
  kind: null,
  requestId: null,
  error: null,
};
const pending = (kind: CodingWorkbenchMutationState["kind"]): CodingWorkbenchMutationState => ({
  status: "pending",
  kind,
  requestId: "req-1",
  error: null,
});
const failed = (kind: CodingWorkbenchMutationState["kind"]): CodingWorkbenchMutationState => ({
  status: "error",
  kind,
  requestId: "req-1",
  error: { code: "INVALID_INTENT", message: "no", retryable: false },
});

function setup(initial: CodingWorkbenchMutationState = IDLE): {
  readonly result: { readonly current: ReturnType<typeof usePromptDeliveryNotice> };
  readonly update: (mutation: CodingWorkbenchMutationState, runId?: string) => void;
} {
  const view = renderHook(
    (props: { mutation: CodingWorkbenchMutationState; runId: string }) =>
      usePromptDeliveryNotice(props.mutation, props.runId),
    { initialProps: { mutation: initial, runId: "run-1" } },
  );
  return {
    result: view.result,
    update: (mutation, runId = "run-1"): void => view.rerender({ mutation, runId }),
  };
}

describe("usePromptDeliveryNotice", () => {
  it("says nothing until a message was sent", () => {
    const { result, update } = setup();
    expect(result.current.notice).toBeNull();
    update(pending("follow-up"));
    update(IDLE);
    expect(result.current.notice, "a follow-up nobody announced as a delivery").toBeNull();
  });

  it.each(["steer", "queue"] as const)(
    "reports the %s message as accepted when its follow-up mutation returns to idle",
    (delivery) => {
      const { result, update } = setup();
      act(() => result.current.begin(delivery));
      update(pending("follow-up"));
      expect(result.current.notice, "nothing is claimed while it is in flight").toBeNull();
      update(IDLE);
      expect(result.current.notice).toBe(delivery);
    },
  );

  it("reports a refused message as failed, and never as sent", () => {
    const { result, update } = setup();
    act(() => result.current.begin("steer"));
    update(pending("follow-up"));
    update(failed("follow-up"));
    expect(result.current.notice).toBe("failed");
  });

  it("does not take another action's settlement for the message's", () => {
    const { result, update } = setup();
    act(() => result.current.begin("queue"));
    update(pending("pause"));
    update(IDLE);
    expect(result.current.notice).toBeNull();
    update(pending("follow-up"));
    update(IDLE);
    expect(result.current.notice).toBe("queue");
  });

  it("clears the notice when the next action starts and when another run begins", () => {
    const { result, update } = setup();
    act(() => result.current.begin("steer"));
    update(pending("follow-up"));
    update(IDLE);
    expect(result.current.notice).toBe("steer");
    update(pending("stop"));
    expect(result.current.notice).toBeNull();
    update(IDLE);

    act(() => result.current.begin("queue"));
    update(pending("follow-up"));
    update(IDLE);
    expect(result.current.notice).toBe("queue");
    update(IDLE, "run-2");
    expect(result.current.notice).toBeNull();
  });

  it("forgets a message announced for a run that is gone", () => {
    const { result, update } = setup();
    act(() => result.current.begin("steer"));
    update(IDLE, "run-2");
    update(pending("follow-up"), "run-2");
    update(IDLE, "run-2");
    expect(result.current.notice).toBeNull();
  });
});
