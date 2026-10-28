import { afterEach, describe, expect, it, vi } from "vitest";
import {
  codingWorkbenchRuntimeApiError,
  decideCodingWorkbenchRuntimeApproval,
  getCodingWorkbenchRuntimeStatus,
  startCodingWorkbenchRuntime,
  stopCodingWorkbenchRuntime,
} from "./coding-workbench-runtime-api";

vi.mock("./browser-approval-client", () => ({
  createLocalBrowserApprovalClient: vi
    .fn()
    .mockReturnValue({ restore: vi.fn().mockResolvedValue(false) }),
}));

// A BFF handler that accepts the request and never answers: the promise settles only when the
// request's own signal aborts, exactly as a real fetch would.
function stallingFetch(): ReturnType<typeof vi.fn> {
  return vi.fn().mockImplementation(
    (_path: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init.signal;
        if (signal === undefined || signal === null) return;
        const fail = (): void => {
          reject(signal.reason as unknown);
        };
        if (signal.aborted) fail();
        else signal.addEventListener("abort", fail, { once: true });
      }),
  );
}

function expiredDeadline(): AbortSignal {
  return AbortSignal.abort(new DOMException("The operation timed out.", "TimeoutError"));
}

describe("Coding Workbench runtime request deadlines", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("bounds every run control with a deadline instead of waiting forever", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(expiredDeadline);
    vi.stubGlobal("fetch", stallingFetch());

    await expect(
      stopCodingWorkbenchRuntime("run-1", { requestId: "r1", expectedRevision: 1 } as never),
    ).rejects.toMatchObject({ name: "TimeoutError" });
    await expect(
      decideCodingWorkbenchRuntimeApproval("run-1", {
        requestId: "r2",
        expectedRevision: 1,
      } as never),
    ).rejects.toMatchObject({ name: "TimeoutError" });
    expect(timeout).toHaveBeenCalledTimes(2);
  });

  it("gives a start a longer bound than a control, and a status read a shorter one", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(expiredDeadline);
    vi.stubGlobal("fetch", stallingFetch());

    await expect(
      startCodingWorkbenchRuntime({ requestId: "s", taskIntent: "x" } as never),
    ).rejects.toMatchObject({ name: "TimeoutError" });
    await expect(getCodingWorkbenchRuntimeStatus()).rejects.toMatchObject({
      name: "TimeoutError",
    });
    const [start, status] = timeout.mock.calls.map(([ms]) => ms);
    expect(start).toBeGreaterThan(60_000);
    expect(status).toBeLessThan(60_000);
  });

  it("names an expired deadline with a closed, retryable runtime code", () => {
    expect(
      codingWorkbenchRuntimeApiError(new DOMException("timed out", "TimeoutError")),
    ).toMatchObject({ code: "CODING_RUNTIME_REQUEST_TIMEOUT", retryable: true });
  });
});
