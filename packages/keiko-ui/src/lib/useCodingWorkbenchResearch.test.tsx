import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CodingWorkbenchRuntimeResearchChannelPayload } from "@oscharko-dev/keiko-contracts";

import {
  useCodingWorkbenchResearch,
  type UseCodingWorkbenchResearchInput,
} from "./useCodingWorkbenchResearch";

const getResearchMock = vi.hoisted(() => vi.fn());
const pairingSettledMock = vi.hoisted(() => vi.fn());

vi.mock("./coding-app-session-client", () => ({
  codingAppSessionPairingSettled: pairingSettledMock,
}));

vi.mock("./coding-workbench-runtime-api", () => ({
  getCodingWorkbenchRuntimeResearch: getResearchMock,
}));

const PENDING = {
  requestId: "research-approval-1",
  host: "docs.example.org",
  requestLine: "/guide/streams topic=backpressure",
  expiresAt: "2026-07-20T00:02:00.000Z",
} as const;

function active(): CodingWorkbenchRuntimeResearchChannelPayload {
  return {
    session: "active",
    pending: PENDING,
    grant: {
      grantId: "grant-1",
      domains: ["docs.example.org"],
      expiresAt: "2026-07-20T00:05:00.000Z",
    },
  };
}

const RUN: UseCodingWorkbenchResearchInput = {
  runId: "run-1",
  revision: 4,
  permissionRequestId: "research-approval-1",
};

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve = (_value: T): void => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe("useCodingWorkbenchResearch", () => {
  beforeEach(() => {
    getResearchMock.mockReset();
    pairingSettledMock.mockReset();
    pairingSettledMock.mockResolvedValue(false);
  });

  it("reads pending and approved state from the one authenticated channel", async () => {
    getResearchMock.mockResolvedValue(active());

    const { result } = renderHook(() => useCodingWorkbenchResearch(RUN));

    await waitFor(() => {
      expect(result.current.status).toBe("ready");
    });
    expect(result.current.ask).toEqual(PENDING);
    expect(result.current.grant?.domains).toEqual(["docs.example.org"]);
    expect(getResearchMock).toHaveBeenCalledTimes(1);
    expect(getResearchMock.mock.calls[0]?.[0]).toBe("run-1");
  });

  it("stays idle with no run", () => {
    const withoutRun = renderHook(() => useCodingWorkbenchResearch({ ...RUN, runId: undefined }));

    expect(withoutRun.result.current).toEqual({ status: "idle", ask: null, grant: null });
    expect(getResearchMock).not.toHaveBeenCalled();
  });

  it("reports unavailable — never a silent empty — when the window is unpaired", async () => {
    getResearchMock.mockResolvedValue({ session: "unpaired" });

    const { result } = renderHook(() => useCodingWorkbenchResearch(RUN));

    await waitFor(() => {
      expect(result.current.status).toBe("unavailable");
    });
    expect(result.current.ask).toBeNull();
    expect(result.current.grant).toBeNull();
  });

  it("reports unavailable when the read fails, so the panel never implies there is no destination", async () => {
    getResearchMock.mockRejectedValue(new Error("network"));

    const { result } = renderHook(() => useCodingWorkbenchResearch(RUN));

    await waitFor(() => {
      expect(result.current.status).toBe("unavailable");
    });
    // The whole state must clear: a retained ask would leave a stale destination on screen while
    // the panel claims the read failed.
    expect(result.current).toEqual({ status: "unavailable", ask: null, grant: null });
  });

  it("re-reads when a new ask or runtime revision replaces current research truth", async () => {
    getResearchMock.mockResolvedValue(active());

    const { result, rerender } = renderHook(
      (props: UseCodingWorkbenchResearchInput) => useCodingWorkbenchResearch(props),
      { initialProps: RUN },
    );

    await waitFor(() => {
      expect(result.current.status).toBe("ready");
    });

    const replacement = deferred<CodingWorkbenchRuntimeResearchChannelPayload>();
    getResearchMock.mockReturnValue(replacement.promise);
    rerender({ ...RUN, revision: 5, permissionRequestId: "research-approval-2" });

    expect(result.current).toEqual({ status: "loading", ask: null, grant: null });
    await act(async () => {
      replacement.resolve({
        session: "active",
        pending: { ...PENDING, requestId: "research-approval-2", host: "other.example.org" },
      });
      await replacement.promise;
    });

    await waitFor(() => {
      expect(result.current.ask?.host).toBe("other.example.org");
    });
    expect(getResearchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps stale completion idle after the in-flight read is aborted", async () => {
    const pairing = deferred<boolean>();
    const inFlight = deferred<CodingWorkbenchRuntimeResearchChannelPayload>();
    let observed: AbortSignal | undefined;
    pairingSettledMock.mockReturnValue(pairing.promise);
    getResearchMock.mockImplementation((_runId: string, signal?: AbortSignal) => {
      observed = signal;
      return inFlight.promise;
    });

    const { result, rerender } = renderHook(
      (props: UseCodingWorkbenchResearchInput) => useCodingWorkbenchResearch(props),
      { initialProps: RUN },
    );
    await act(async () => {
      pairing.resolve(false);
      await pairing.promise;
    });
    await waitFor(() => {
      expect(observed).toBeDefined();
    });

    rerender({ ...RUN, runId: undefined });
    expect(result.current).toEqual({ status: "idle", ask: null, grant: null });
    expect(observed?.aborted).toBe(true);

    await act(async () => {
      inFlight.resolve(active());
      await inFlight.promise;
    });
    expect(result.current).toEqual({ status: "idle", ask: null, grant: null });
  });

  it("does not start a read when pairing settles after the run disappears", async () => {
    const pairing = deferred<boolean>();
    pairingSettledMock.mockReturnValue(pairing.promise);
    getResearchMock.mockResolvedValue({
      session: "active",
      pending: PENDING,
    });

    const { result, rerender } = renderHook(
      (props: UseCodingWorkbenchResearchInput) => useCodingWorkbenchResearch(props),
      { initialProps: RUN },
    );
    rerender({ ...RUN, runId: undefined });
    await act(async () => {
      pairing.resolve(false);
      await pairing.promise;
    });

    expect(result.current).toEqual({ status: "idle", ask: null, grant: null });
    expect(getResearchMock).not.toHaveBeenCalled();
  });
});
