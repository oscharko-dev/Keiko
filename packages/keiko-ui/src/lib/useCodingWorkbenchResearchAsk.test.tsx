import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CodingWorkbenchRuntimeResearchChannelPayload } from "@oscharko-dev/keiko-contracts";

import {
  useCodingWorkbenchResearchAsk,
  type UseCodingWorkbenchResearchAskInput,
} from "./useCodingWorkbenchResearchAsk";

const getResearchAskMock = vi.hoisted(() => vi.fn());

vi.mock("./coding-workbench-runtime-api", () => ({
  getCodingWorkbenchRuntimeResearchAsk: getResearchAskMock,
}));

const PENDING = {
  requestId: "research-approval-1",
  host: "docs.example.org",
  requestLine: "/guide/streams topic=backpressure",
  expiresAt: "2026-07-20T00:02:00.000Z",
} as const;

function active(): CodingWorkbenchRuntimeResearchChannelPayload {
  return { session: "active", pending: PENDING };
}

const EGRESS: UseCodingWorkbenchResearchAskInput = {
  runId: "run-1",
  permissionRequestId: "research-approval-1",
  isNetworkEgress: true,
};

describe("useCodingWorkbenchResearchAsk", () => {
  beforeEach(() => {
    getResearchAskMock.mockReset();
  });

  it("reads the destination while a network-egress approval is on screen", async () => {
    getResearchAskMock.mockResolvedValue(active());

    const { result } = renderHook(() => useCodingWorkbenchResearchAsk(EGRESS));

    await waitFor(() => {
      expect(result.current.status).toBe("ready");
    });
    expect(result.current.ask).toEqual(PENDING);
    expect(getResearchAskMock).toHaveBeenCalledTimes(1);
    expect(getResearchAskMock.mock.calls[0]?.[0]).toBe("run-1");
  });

  it("stays idle and reads nothing for an approval that is not network egress", () => {
    const { result } = renderHook(() =>
      useCodingWorkbenchResearchAsk({ ...EGRESS, isNetworkEgress: false }),
    );

    expect(result.current).toEqual({ status: "idle", ask: null });
    expect(getResearchAskMock).not.toHaveBeenCalled();
  });

  it("stays idle with no run and with no pending permission", () => {
    const withoutRun = renderHook(() =>
      useCodingWorkbenchResearchAsk({ ...EGRESS, runId: undefined }),
    );
    const withoutPermission = renderHook(() =>
      useCodingWorkbenchResearchAsk({ ...EGRESS, permissionRequestId: undefined }),
    );

    expect(withoutRun.result.current.status).toBe("idle");
    expect(withoutPermission.result.current.status).toBe("idle");
    expect(getResearchAskMock).not.toHaveBeenCalled();
  });

  it("reports unavailable — never a silent empty — when the window is unpaired", async () => {
    getResearchAskMock.mockResolvedValue({ session: "unpaired" });

    const { result } = renderHook(() => useCodingWorkbenchResearchAsk(EGRESS));

    await waitFor(() => {
      expect(result.current.status).toBe("unavailable");
    });
    expect(result.current.ask).toBeNull();
  });

  it("reports unavailable when the read fails, so the panel never implies there is no destination", async () => {
    getResearchAskMock.mockRejectedValue(new Error("network"));

    const { result } = renderHook(() => useCodingWorkbenchResearchAsk(EGRESS));

    await waitFor(() => {
      expect(result.current.status).toBe("unavailable");
    });
    // The whole state must clear: a retained ask would leave a stale destination on screen while
    // the panel claims the read failed.
    expect(result.current).toEqual({ status: "unavailable", ask: null });
  });

  it("re-reads when a NEW ask replaces the current one", async () => {
    getResearchAskMock.mockResolvedValue(active());

    const { result, rerender } = renderHook(
      (props: UseCodingWorkbenchResearchAskInput) => useCodingWorkbenchResearchAsk(props),
      { initialProps: EGRESS },
    );

    await waitFor(() => {
      expect(result.current.status).toBe("ready");
    });

    getResearchAskMock.mockResolvedValue({
      session: "active",
      pending: { ...PENDING, requestId: "research-approval-2", host: "other.example.org" },
    });
    rerender({ ...EGRESS, permissionRequestId: "research-approval-2" });

    await waitFor(() => {
      expect(result.current.ask?.host).toBe("other.example.org");
    });
    expect(getResearchAskMock).toHaveBeenCalledTimes(2);
  });

  it("aborts the in-flight read when the approval disappears", async () => {
    let observed: AbortSignal | undefined;
    getResearchAskMock.mockImplementation(
      (_runId: string, signal?: AbortSignal): Promise<never> => {
        observed = signal;
        return new Promise<never>(() => undefined);
      },
    );

    const { rerender } = renderHook(
      (props: UseCodingWorkbenchResearchAskInput) => useCodingWorkbenchResearchAsk(props),
      {
        initialProps: EGRESS,
      },
    );
    await waitFor(() => {
      expect(observed).toBeDefined();
    });
    rerender({ ...EGRESS, permissionRequestId: undefined });

    expect(observed?.aborted).toBe(true);
  });
});
