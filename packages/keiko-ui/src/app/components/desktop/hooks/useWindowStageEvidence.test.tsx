import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useWindowStageEvidence } from "./useWindowStageEvidence";

const reportClientDiagnostic = vi.hoisted(() => vi.fn());
vi.mock("@/lib/client-diagnostics", () => ({ reportClientDiagnostic }));

function messages(): readonly string[] {
  return reportClientDiagnostic.mock.calls.map(([message]) => String(message));
}

describe("useWindowStageEvidence", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("reports the stage start on mount and its settlement, with the elapsed time, on unmount", () => {
    vi.useFakeTimers();
    const { unmount } = renderHook(() => {
      useWindowStageEvidence("chat bind");
    });

    expect(messages()).toEqual([expect.stringMatching(/^desktop chat bind #\d+: started$/)]);

    vi.advanceTimersByTime(1250);
    unmount();

    expect(messages()).toHaveLength(2);
    expect(messages()[1]).toMatch(/^desktop chat bind #\d+: settled after 1250ms$/);
  });

  // A stall is reconstructed from a `started` line with no `settled` line: the hook must not settle a
  // stage that is merely re-rendered, or the evidence would read as a fast bind that never was.
  it("does not settle a stage that is still mounted", () => {
    const { rerender } = renderHook(() => {
      useWindowStageEvidence("window chunk");
    });

    rerender();
    rerender();

    expect(messages()).toEqual([expect.stringMatching(/^desktop window chunk #\d+: started$/)]);
  });

  // Two windows of one kind binding at the same time: the sequence number is what keeps each
  // settlement attributable, and it carries no identity of the window itself.
  it("keeps concurrent mounts of one stage attributable through distinct sequence numbers", () => {
    // The previous test's hook is unmounted by the library's own cleanup AFTER the suite's
    // afterEach cleared the mock, so its settlement would otherwise be counted here.
    reportClientDiagnostic.mockClear();
    const first = renderHook(() => {
      useWindowStageEvidence("chat bind");
    });
    const second = renderHook(() => {
      useWindowStageEvidence("chat bind");
    });
    const tokens = messages().map((message) => /#(\d+):/.exec(message)?.[1]);
    expect(tokens).toHaveLength(2);
    expect(new Set(tokens).size).toBe(2);

    second.unmount();

    expect(messages()[2]).toMatch(
      new RegExp(`^desktop chat bind #${String(tokens[1])}: settled after \\d+ms$`),
    );
    first.unmount();
  });
});
