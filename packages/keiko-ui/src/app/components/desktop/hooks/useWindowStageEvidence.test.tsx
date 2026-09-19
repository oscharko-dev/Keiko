import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CLIENT_STAGE_DURATION_MS_MAX } from "@oscharko-dev/keiko-contracts/runtime/diagnostics";
import { useWindowStageEvidence } from "./useWindowStageEvidence";
import type { ClientDiagnosticStageReport } from "@/lib/client-diagnostics";

const reportClientDiagnostic = vi.hoisted(() => vi.fn());
vi.mock("@/lib/client-diagnostics", () => ({ reportClientDiagnostic }));

function messages(): readonly string[] {
  return reportClientDiagnostic.mock.calls.map(([message]) => String(message));
}

// KEIKO-3557: the structured, closed-vocabulary report `useWindowStageEvidence` now sends alongside
// the console-visible message — this, not the message text, is what the server persists as the new
// `client.stage.started`/`client.stage.settled` lifecycle operations instead of the failure-shaped
// `client.diagnostic`.
function stageReports(): readonly (ClientDiagnosticStageReport | undefined)[] {
  return reportClientDiagnostic.mock.calls.map((call) => {
    const meta = call[1] as { readonly stageReport?: ClientDiagnosticStageReport } | undefined;
    return meta?.stageReport;
  });
}

function correlationIds(): readonly (string | undefined)[] {
  return reportClientDiagnostic.mock.calls.map((call) => {
    const meta = call[1] as { readonly correlationId?: string } | undefined;
    return meta?.correlationId;
  });
}

describe("useWindowStageEvidence", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  // #3557 review: without one id across both phases, a started and a settled line of one mount
  // could not be joined, least of all when another tab reuses the same stage and ordinal.
  it("reports both phases of one mount under one correlation id, distinct per mount", () => {
    reportClientDiagnostic.mockClear();
    const first = renderHook(() => {
      useWindowStageEvidence("chat bind");
    });
    const second = renderHook(() => {
      useWindowStageEvidence("chat bind");
    });
    first.unmount();
    second.unmount();

    const [firstStarted, secondStarted, firstSettled, secondSettled] = correlationIds();
    expect(firstStarted).toEqual(expect.any(String));
    expect(firstSettled).toBe(firstStarted);
    expect(secondSettled).toBe(secondStarted);
    expect(secondStarted).not.toBe(firstStarted);
  });

  // #3557 review: a wall-clock step or a tab left open for days must still settle the stage with
  // a duration the contract accepts, or the server refuses the report and a false stall remains.
  it("measures monotonically and bounds the settled duration to the contract's ceiling", () => {
    vi.useFakeTimers();
    reportClientDiagnostic.mockClear();
    const backwards = renderHook(() => {
      useWindowStageEvidence("window chunk");
    });
    // The clock reads earlier at cleanup than at mount: the duration floors at 0, never below.
    const now = vi.spyOn(performance, "now").mockReturnValue(performance.now() - 4_000);
    backwards.unmount();
    now.mockRestore();
    const longLived = renderHook(() => {
      useWindowStageEvidence("window chunk");
    });
    vi.advanceTimersByTime(CLIENT_STAGE_DURATION_MS_MAX + 60_000);
    longLived.unmount();

    const settled = stageReports().filter((report) => report?.phase === "settled");
    expect(settled.map((report) => (report?.phase === "settled" ? report.durationMs : -1))).toEqual(
      [0, CLIENT_STAGE_DURATION_MS_MAX],
    );
  });

  it("reports the stage start on mount and its settlement, with the elapsed time, on unmount", () => {
    vi.useFakeTimers();
    const { unmount } = renderHook(() => {
      useWindowStageEvidence("chat bind");
    });

    expect(messages()).toEqual([expect.stringMatching(/^desktop chat bind #\d+: started$/)]);
    const [started] = stageReports();
    expect(started).toMatchObject({ stage: "chat bind", phase: "started" });
    expect(typeof started?.ordinal).toBe("number");

    vi.advanceTimersByTime(1250);
    unmount();

    expect(messages()).toHaveLength(2);
    expect(messages()[1]).toMatch(/^desktop chat bind #\d+: settled after 1250ms$/);
    const [, settled] = stageReports();
    expect(settled).toEqual({
      stage: "chat bind",
      phase: "settled",
      ordinal: started?.ordinal,
      durationMs: 1250,
    });
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
    expect(stageReports()).toHaveLength(1);
    expect(stageReports()[0]).toMatchObject({ stage: "window chunk", phase: "started" });
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
    const [firstReport, secondReport] = stageReports();
    expect(firstReport?.ordinal).toBe(Number(tokens[0]));
    expect(secondReport?.ordinal).toBe(Number(tokens[1]));
    expect(firstReport?.ordinal).not.toBe(secondReport?.ordinal);

    second.unmount();

    expect(messages()[2]).toMatch(
      new RegExp(`^desktop chat bind #${String(tokens[1])}: settled after \\d+ms$`),
    );
    expect(stageReports()[2]).toMatchObject({
      stage: "chat bind",
      phase: "settled",
      ordinal: secondReport?.ordinal,
    });
    first.unmount();
  });
});
