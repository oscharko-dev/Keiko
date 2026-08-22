import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CodingWorkbenchRuntimeResearchChannelPayload,
  CodingWorkbenchRuntimeResearchGrant,
} from "@oscharko-dev/keiko-contracts";

import {
  useCodingWorkbenchResearch,
  type UseCodingWorkbenchResearchInput,
} from "./useCodingWorkbenchResearch";
import { ApiError } from "./api";
import { resetClientDiagnosticWriter, setClientDiagnosticWriter } from "./client-diagnostics";
import {
  fanOutClientDiagnostic,
  resetClientDiagnosticPostStateForTests,
} from "./install-client-diagnostics";

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
  expiresAt: "2099-07-20T00:02:00.000Z",
} as const;

const GRANT: CodingWorkbenchRuntimeResearchGrant = {
  grantId: "grant-1",
  domains: ["docs.example.org"],
  expiresAt: "2099-07-20T00:05:00.000Z",
};

function active(): CodingWorkbenchRuntimeResearchChannelPayload {
  return {
    session: "active",
    pending: PENDING,
    grant: GRANT,
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

async function flushResearchRead(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("useCodingWorkbenchResearch", () => {
  beforeEach(() => {
    getResearchMock.mockReset();
    pairingSettledMock.mockReset();
    pairingSettledMock.mockResolvedValue(false);
  });

  afterEach(() => {
    vi.useRealTimers();
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

  // Wave 5 follow-up (epic #3233) — the fatal-flaw fix: a real caught `ApiError` must carry its
  // correlation id all the way onto the `POST /api/diagnostics/client` wire body, through
  // `reportClientDiagnostic`'s structured second argument and `install-client-diagnostics.ts`'s
  // transport, not just through a mock standing in for either. Installing the REAL transport (not a
  // spy on `reportClientDiagnostic`) is what makes this end-to-end: it fails if the wiring line in
  // `useCodingWorkbenchResearch.ts`'s catch block is ever removed, same as it would fail if
  // `clientDiagnosticPostBody` stopped forwarding a valid id.
  describe("correlationId wiring to the diagnostic ingest POST", () => {
    afterEach(() => {
      resetClientDiagnosticWriter();
      resetClientDiagnosticPostStateForTests();
      vi.unstubAllGlobals();
    });

    it("carries the failed request's correlationId onto the diagnostic ingest POST body", async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
      vi.stubGlobal("fetch", fetchMock);
      setClientDiagnosticWriter(fanOutClientDiagnostic);
      const failure = new ApiError("INTERNAL", "research channel unavailable", 502);
      failure.correlationId = "req-research-000001";
      getResearchMock.mockRejectedValue(failure);

      const { result } = renderHook(() => useCodingWorkbenchResearch(RUN));

      await waitFor(() => {
        expect(result.current.status).toBe("unavailable");
      });
      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalled();
      });
      const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(path).toBe("/api/diagnostics/client");
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(body["correlationId"]).toBe("req-research-000001");
    });
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

  it("revalidates each expiry and never retains server-expired research state", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-07-20T00:00:00.000Z");
    const pending = { ...PENDING, expiresAt: "2026-07-20T00:00:01.000Z" };
    const grant = { ...GRANT, expiresAt: "2026-07-20T00:00:02.000Z" };
    const afterPendingExpiry = deferred<CodingWorkbenchRuntimeResearchChannelPayload>();
    const afterGrantExpiry = deferred<CodingWorkbenchRuntimeResearchChannelPayload>();
    getResearchMock
      .mockResolvedValueOnce({ session: "active", pending, grant })
      .mockReturnValueOnce(afterPendingExpiry.promise)
      .mockReturnValueOnce(afterGrantExpiry.promise);

    const { result, unmount } = renderHook(() => useCodingWorkbenchResearch(RUN));
    await flushResearchRead();
    expect(result.current).toMatchObject({ status: "ready", ask: pending, grant });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_001);
    });
    expect(getResearchMock).toHaveBeenCalledTimes(2);
    expect(result.current).toMatchObject({ status: "ready", ask: null, grant });
    await act(async () => {
      afterPendingExpiry.resolve({ session: "active", grant });
      await afterPendingExpiry.promise;
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(getResearchMock).toHaveBeenCalledTimes(3);
    expect(result.current).toEqual({ status: "ready", ask: null, grant: null });
    await act(async () => {
      afterGrantExpiry.resolve({ session: "active" });
      await afterGrantExpiry.promise;
    });

    unmount();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(getResearchMock).toHaveBeenCalledTimes(3);
  });

  it("fails closed when a response already contains expired research state", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-07-20T00:00:00.000Z");
    getResearchMock.mockResolvedValue({
      session: "active",
      pending: { ...PENDING, expiresAt: "2026-07-19T23:59:59.999Z" },
      grant: { ...GRANT, expiresAt: "not-a-timestamp" },
    });

    const { result } = renderHook(() => useCodingWorkbenchResearch(RUN));
    await flushResearchRead();

    expect(result.current).toEqual({ status: "ready", ask: null, grant: null });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(getResearchMock).toHaveBeenCalledTimes(1);
  });
});
