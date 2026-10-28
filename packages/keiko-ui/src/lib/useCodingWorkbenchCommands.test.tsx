import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodingWorkbenchRuntimeCommandsChannelPayload } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime-api";
import { encodeCodingAppSessionPairingFragment } from "@oscharko-dev/keiko-contracts/runtime/coding-app-session";

import {
  redeemCodingAppSessionPairingNavigation,
  type CodingAppSessionPairingSeams,
} from "./coding-app-session-client";
import { ApiError } from "./api";
import { resetClientDiagnosticWriter, setClientDiagnosticWriter } from "./client-diagnostics";
import {
  useCodingWorkbenchCommands,
  type UseCodingWorkbenchCommandsInput,
} from "./useCodingWorkbenchCommands";

const fetchCommandsMock = vi.hoisted(() => vi.fn());
const pairingSettledMock = vi.hoisted(() => vi.fn());

vi.mock("./coding-app-session-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./coding-app-session-client")>()),
  codingAppSessionPairingSettled: pairingSettledMock,
}));

vi.mock("./coding-workbench-runtime-api", () => ({
  fetchCodingWorkbenchRuntimeCommands: fetchCommandsMock,
}));

const LISTING = [
  { name: "init", description: "Set up AGENTS.md" },
  { name: "review" },
  { name: "team:deploy-check", description: "Check a deployment" },
] as const;

function active(
  commands: CodingWorkbenchRuntimeCommandsChannelPayload["commands"] = LISTING,
): CodingWorkbenchRuntimeCommandsChannelPayload {
  return { session: "active", commands };
}

const WANTED: UseCodingWorkbenchCommandsInput = { runId: "run-1", wanted: true };

beforeEach(() => {
  fetchCommandsMock.mockReset();
  pairingSettledMock.mockReset();
  pairingSettledMock.mockResolvedValue(true);
});

afterEach(() => {
  resetClientDiagnosticWriter();
});

describe("useCodingWorkbenchCommands", () => {
  it("reads nothing until the menu asks, and says idle meanwhile", async () => {
    const { result, rerender } = renderHook(
      (input: UseCodingWorkbenchCommandsInput) => useCodingWorkbenchCommands(input),
      { initialProps: { runId: "run-1", wanted: false } as UseCodingWorkbenchCommandsInput },
    );

    expect(result.current).toMatchObject({ status: "idle", commands: [] });
    await act(async () => {
      await Promise.resolve();
    });
    expect(fetchCommandsMock).not.toHaveBeenCalled();

    fetchCommandsMock.mockResolvedValue(active());
    rerender(WANTED);
    expect(result.current.status).toBe("loading");
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.commands).toEqual(LISTING);
    expect(fetchCommandsMock).toHaveBeenCalledExactlyOnceWith("run-1", {
      signal: expect.any(AbortSignal) as unknown,
    });
  });

  it("keeps the run's listing once read: closing and reopening the menu reads nothing again", async () => {
    fetchCommandsMock.mockResolvedValue(active());
    const { result, rerender } = renderHook(
      (input: UseCodingWorkbenchCommandsInput) => useCodingWorkbenchCommands(input),
      { initialProps: WANTED },
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    rerender({ runId: "run-1", wanted: false });
    expect(result.current).toMatchObject({ status: "ready", commands: LISTING });
    rerender(WANTED);
    expect(result.current.status).toBe("ready");

    await act(async () => {
      await Promise.resolve();
    });
    expect(fetchCommandsMock).toHaveBeenCalledOnce();
  });

  it("reads nothing for a composer with no run, even when asked", async () => {
    const { result } = renderHook(() =>
      useCodingWorkbenchCommands({ runId: undefined, wanted: true }),
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current).toMatchObject({ status: "idle", commands: [] });
    expect(fetchCommandsMock).not.toHaveBeenCalled();
  });

  it("reports a run that lists none as ready and empty: the server said so", async () => {
    fetchCommandsMock.mockResolvedValue({ session: "active" });

    const { result } = renderHook(() => useCodingWorkbenchCommands(WANTED));

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.commands).toEqual([]);
  });

  it("reports an unpaired window as an error, never as an empty listing", async () => {
    fetchCommandsMock.mockResolvedValue({ session: "unpaired" });

    const { result } = renderHook(() => useCodingWorkbenchCommands(WANTED));

    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.commands).toEqual([]);
  });

  it("reports a failed read as a retryable error and keeps the failure diagnosable, body-free", async () => {
    const written: { readonly message: string; readonly correlationId?: string }[] = [];
    setClientDiagnosticWriter((message, options) => {
      written.push({
        message,
        ...(options?.correlationId === undefined ? {} : { correlationId: options.correlationId }),
      });
    });
    const failure = new ApiError("INTERNAL", "PRIVATE_FAILURE_TEXT", 503);
    failure.correlationId = "corr-77";
    fetchCommandsMock.mockRejectedValue(failure);

    const { result } = renderHook(() => useCodingWorkbenchCommands(WANTED));

    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.commands).toEqual([]);
    expect(written.at(-1)?.message).toContain("commands channel read failed");
    expect(written.at(-1)?.correlationId).toBe("corr-77");
    expect(JSON.stringify(written)).not.toContain("PRIVATE_FAILURE_TEXT");
  });

  it("reads again on retry() after a failure and then shows the listing", async () => {
    fetchCommandsMock.mockRejectedValueOnce(new Error("offline"));
    const { result } = renderHook(() => useCodingWorkbenchCommands(WANTED));
    await waitFor(() => expect(result.current.status).toBe("error"));

    fetchCommandsMock.mockResolvedValue(active());
    act(() => {
      result.current.retry();
    });

    expect(result.current.status).toBe("loading");
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.commands).toEqual(LISTING);
    expect(fetchCommandsMock).toHaveBeenCalledTimes(2);
  });

  it("never shows another run's listing, and drops an answer that arrives after the run changed", async () => {
    let settle: ((payload: CodingWorkbenchRuntimeCommandsChannelPayload) => void) | undefined;
    fetchCommandsMock.mockReturnValueOnce(
      new Promise<CodingWorkbenchRuntimeCommandsChannelPayload>((resolve) => {
        settle = resolve;
      }),
    );
    const { result, rerender } = renderHook(
      (input: UseCodingWorkbenchCommandsInput) => useCodingWorkbenchCommands(input),
      { initialProps: WANTED },
    );
    await waitFor(() => expect(fetchCommandsMock).toHaveBeenCalledOnce());

    fetchCommandsMock.mockResolvedValue(active([{ name: "second-run" }]));
    rerender({ runId: "run-2", wanted: true });
    expect(result.current.commands).toEqual([]);
    await act(async () => {
      settle?.(active([{ name: "first-run" }]));
      await Promise.resolve();
    });

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.commands).toEqual([{ name: "second-run" }]);
    expect(fetchCommandsMock).toHaveBeenLastCalledWith("run-2", expect.anything());
  });

  it("does not offer a run's listing once the composer has another run, or none", async () => {
    fetchCommandsMock.mockResolvedValue(active());
    const { result, rerender } = renderHook(
      (input: UseCodingWorkbenchCommandsInput) => useCodingWorkbenchCommands(input),
      { initialProps: WANTED },
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    rerender({ runId: undefined, wanted: true });
    expect(result.current).toMatchObject({ status: "idle", commands: [] });
    rerender({ runId: "run-9", wanted: false });
    expect(result.current).toMatchObject({ status: "idle", commands: [] });
  });
});

// A launcher re-pair that arrives without a page load (F65): a fragment, and a pair endpoint that
// acknowledges it.
const REPAIR_SEAMS: CodingAppSessionPairingSeams = {
  readFragment: (): string =>
    encodeCodingAppSessionPairingFragment({
      requestId: "req_commands-re-pair",
      issuedAtMs: 1,
      claim: "e".repeat(64),
    }),
  stripFragment: (): void => undefined,
  postPairing: (): Promise<unknown> => Promise.resolve({ schemaVersion: "1" }),
};

describe("useCodingWorkbenchCommands after a re-pair without a page load (F65)", () => {
  it("reads the commands channel again, but only for a run the menu asked about", async () => {
    fetchCommandsMock.mockResolvedValue(active());
    renderHook(() => useCodingWorkbenchCommands(WANTED));
    await waitFor(() => expect(fetchCommandsMock).toHaveBeenCalled());
    const before = fetchCommandsMock.mock.calls.length;

    await act(async () => {
      await redeemCodingAppSessionPairingNavigation(REPAIR_SEAMS);
    });

    await waitFor(() => expect(fetchCommandsMock.mock.calls.length).toBeGreaterThan(before));
  });
});
