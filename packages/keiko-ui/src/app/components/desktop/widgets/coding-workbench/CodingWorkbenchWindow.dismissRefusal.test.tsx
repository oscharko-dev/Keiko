import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CodingHistoryDetail } from "@oscharko-dev/keiko-contracts/bff-wire";
import { useDismissRefusalOnTaskSwitch } from "./CodingWorkbenchWindow";

function detail(id: string): CodingHistoryDetail {
  return { task: { id }, messages: [], truncated: false } as unknown as CodingHistoryDetail;
}

interface Props {
  readonly root: string | undefined;
  readonly detail: CodingHistoryDetail | null;
}

function setup(initial: Props): {
  readonly dismiss: ReturnType<typeof vi.fn>;
  readonly change: (next: Props) => void;
} {
  const dismiss = vi.fn();
  const view = renderHook(
    (props: Props) => {
      useDismissRefusalOnTaskSwitch(dismiss, props.root, props.detail);
    },
    { initialProps: initial },
  );
  return { dismiss, change: (next) => view.rerender(next) };
}

describe("useDismissRefusalOnTaskSwitch (U-42)", () => {
  it("does not dismiss on the first render or while nothing changes", () => {
    const { dismiss, change } = setup({ root: "/repo/a", detail: detail("t1") });
    change({ root: "/repo/a", detail: detail("t1") });
    expect(dismiss).not.toHaveBeenCalled();
  });

  it("dismisses when the repository changes", () => {
    const { dismiss, change } = setup({ root: "/repo/a", detail: null });
    change({ root: "/repo/b", detail: null });
    expect(dismiss).toHaveBeenCalledTimes(1);
  });

  it("dismisses when the shown task changes or is left", () => {
    const { dismiss, change } = setup({ root: "/repo/a", detail: detail("t1") });
    change({ root: "/repo/a", detail: detail("t2") });
    expect(dismiss).toHaveBeenCalledTimes(1);
    change({ root: "/repo/a", detail: null });
    expect(dismiss).toHaveBeenCalledTimes(2);
  });

  it("does not dismiss when a task or repository appears for the first time", () => {
    const { dismiss, change } = setup({ root: undefined, detail: null });
    change({ root: undefined, detail: detail("t1") });
    change({ root: "/repo/a", detail: detail("t1") });
    expect(dismiss).not.toHaveBeenCalled();
  });
});
