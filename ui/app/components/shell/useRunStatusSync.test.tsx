// Issue #66 — useRunStatusSync hook tests. Drives the polling loop with fake timers and a mocked
// @/lib/api surface; verifies PATCH dispatch + onPatched + unavailable state + backoff.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, cleanup, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import * as api from "@/lib/api";
import { ApiError } from "@/lib/api";
import type { ChatMessage } from "@/lib/types";
import { useRunStatusSync } from "./useRunStatusSync";

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof api>("@/lib/api");
  return {
    ...actual,
    fetchRunReport: vi.fn(),
    fetchEvidenceManifest: vi.fn(),
    patchChatMessage: vi.fn(),
  };
});

function makeMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "msg-1",
    chatId: "chat-1",
    role: "system",
    content: "Verify started",
    timestamp: 1,
    runId: "run-1",
    workflowStatus: "running",
    taskType: "verify",
    ...overrides,
  };
}

interface ProbeProps {
  message: ChatMessage;
  onPatched: (m: ChatMessage) => void;
}

function Probe({ message, onPatched }: ProbeProps): ReactNode {
  const { unavailable } = useRunStatusSync(message, onPatched);
  return <span data-testid="unavailable">{unavailable ? "yes" : "no"}</span>;
}

function patchedReply(patch: Partial<ChatMessage>): { message: ChatMessage } {
  return { message: { ...makeMessage(), ...patch } };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(api.patchChatMessage).mockReset();
  vi.mocked(api.fetchRunReport).mockReset();
  vi.mocked(api.fetchEvidenceManifest).mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  vi.restoreAllMocks();
});

describe("useRunStatusSync", () => {
  it("no-ops when persisted status is terminal", async () => {
    const onPatched = vi.fn();
    render(<Probe message={makeMessage({ workflowStatus: "completed" })} onPatched={onPatched} />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(api.fetchRunReport).not.toHaveBeenCalled();
    expect(onPatched).not.toHaveBeenCalled();
  });

  it("no-ops when runId is missing", async () => {
    const onPatched = vi.fn();
    const base = makeMessage();
    const { runId: _runId, ...rest } = base;
    void _runId;
    const noRun: ChatMessage = rest;
    render(<Probe message={noRun} onPatched={onPatched} />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(api.fetchRunReport).not.toHaveBeenCalled();
  });

  it("running → terminal: PATCH the row and call onPatched", async () => {
    vi.mocked(api.fetchRunReport)
      .mockResolvedValueOnce({ report: { status: "running" } as never })
      .mockResolvedValueOnce({
        report: {
          status: "completed",
          verificationSummary: { results: [{}, {}] },
        } as never,
      });
    vi.mocked(api.patchChatMessage).mockResolvedValue(
      patchedReply({ workflowStatus: "completed", shortResult: "Verification passed: 2 classifications." }),
    );
    const onPatched = vi.fn();
    render(<Probe message={makeMessage()} onPatched={onPatched} />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(api.fetchRunReport).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(api.fetchRunReport).toHaveBeenCalledTimes(2);
    expect(api.patchChatMessage).toHaveBeenCalledWith("msg-1", {
      workflowStatus: "completed",
      shortResult: "Verification passed: 2 classifications.",
    });
    expect(onPatched).toHaveBeenCalledTimes(1);
  });

  it("run 404 → evidence 200: PATCH from manifest outcome", async () => {
    vi.mocked(api.fetchRunReport).mockRejectedValue(new ApiError("NOT_FOUND", "x", 404));
    vi.mocked(api.fetchEvidenceManifest).mockResolvedValue({
      manifest: { run: { outcome: "completed" } } as never,
    });
    vi.mocked(api.patchChatMessage).mockResolvedValue(
      patchedReply({ workflowStatus: "completed", shortResult: "Verification passed." }),
    );
    const onPatched = vi.fn();
    render(<Probe message={makeMessage()} onPatched={onPatched} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(api.fetchEvidenceManifest).toHaveBeenCalledTimes(1);
    expect(api.patchChatMessage).toHaveBeenCalledWith("msg-1", {
      workflowStatus: "completed",
      shortResult: "Verification passed.",
    });
  });

  it("run 404 + evidence 404: surfaces unavailable, never PATCHes", async () => {
    vi.mocked(api.fetchRunReport).mockRejectedValue(new ApiError("NOT_FOUND", "x", 404));
    vi.mocked(api.fetchEvidenceManifest).mockRejectedValue(new ApiError("NOT_FOUND", "x", 404));
    const onPatched = vi.fn();
    render(<Probe message={makeMessage()} onPatched={onPatched} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByTestId("unavailable").textContent).toBe("yes");
    expect(api.patchChatMessage).not.toHaveBeenCalled();
    expect(onPatched).not.toHaveBeenCalled();
  });

  it("backs off to 6000ms after 60s of running", async () => {
    vi.mocked(api.fetchRunReport).mockResolvedValue({ report: { status: "running" } as never });
    const onPatched = vi.fn();
    render(<Probe message={makeMessage()} onPatched={onPatched} />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(api.fetchRunReport).toHaveBeenCalledTimes(1);
    // 40 ticks × 1500 ms = 60s.
    for (let i = 0; i < 40; i += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1500);
      });
    }
    const beforeBackoff = vi.mocked(api.fetchRunReport).mock.calls.length;
    // After crossing the threshold the next gap should be 6000ms — advancing 1500ms should not
    // trigger a new fetch.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(vi.mocked(api.fetchRunReport).mock.calls.length).toBe(beforeBackoff);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4500);
    });
    expect(vi.mocked(api.fetchRunReport).mock.calls.length).toBe(beforeBackoff + 1);
  });

  it("unmount cancels the polling loop", async () => {
    vi.mocked(api.fetchRunReport).mockResolvedValue({ report: { status: "running" } as never });
    const onPatched = vi.fn();
    const { unmount } = render(<Probe message={makeMessage()} onPatched={onPatched} />);
    await act(async () => {
      await Promise.resolve();
    });
    unmount();
    const before = vi.mocked(api.fetchRunReport).mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(vi.mocked(api.fetchRunReport).mock.calls.length).toBe(before);
  });

  it("does not PATCH after unmount even if a fetch resolved late", async () => {
    let resolveReport: ((value: unknown) => void) | undefined;
    vi.mocked(api.fetchRunReport).mockImplementation(
      () =>
        new Promise<never>((res) => {
          resolveReport = res as (value: unknown) => void;
        }),
    );
    vi.mocked(api.patchChatMessage).mockResolvedValue(
      patchedReply({ workflowStatus: "completed" }),
    );
    const onPatched = vi.fn();
    const { unmount } = render(<Probe message={makeMessage()} onPatched={onPatched} />);
    await act(async () => {
      await Promise.resolve();
    });
    unmount();
    await act(async () => {
      resolveReport?.({ report: { status: "completed" } });
      await Promise.resolve();
    });
    expect(onPatched).not.toHaveBeenCalled();
  });
});
