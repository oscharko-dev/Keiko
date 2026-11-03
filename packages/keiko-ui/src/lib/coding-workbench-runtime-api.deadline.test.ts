import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CLIENT_CODING_RUNTIME_CALLS,
  type ClientCodingRuntimeCall,
} from "@oscharko-dev/keiko-contracts/runtime/diagnostics";
import {
  acknowledgeCodingWorkbenchRuntimeRecovery,
  answerCodingWorkbenchRuntimeQuestion,
  CodingWorkbenchPreemptedError,
  codingWorkbenchRuntimeApiError,
  decideCodingWorkbenchRuntimeApproval,
  getCodingWorkbenchRuntimeSnapshot,
  getCodingWorkbenchRuntimeStatus,
  isCodingWorkbenchPreempted,
  pauseCodingWorkbenchRuntime,
  rejectCodingWorkbenchRuntimeQuestion,
  resumeCodingWorkbenchRuntime,
  retryCodingWorkbenchRuntime,
  revertCodingWorkbenchRuntime,
  revokeCodingWorkbenchRuntimeResearchGrant,
  startCodingWorkbenchRuntime,
  stopCodingWorkbenchRuntime,
  submitCodingWorkbenchRuntimeFollowUp,
  submitCodingWorkbenchRuntimeInboxAction,
  takeOverCodingWorkbenchRuntime,
} from "./coding-workbench-runtime-api";
import {
  resetClientDiagnosticWriter,
  setClientDiagnosticWriter,
  type ClientDiagnosticMeta,
} from "./client-diagnostics";

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

// A deadline that never expires: a caller's abort is then the only thing that can end the wait.
function openDeadline(): AbortSignal {
  return new AbortController().signal;
}

interface TimeoutCase {
  readonly call: ClientCodingRuntimeCall;
  readonly deadlineMs: number;
  readonly invoke: () => Promise<unknown>;
}

const OPERATION = { requestId: "r1", expectedRevision: 1 } as never;
const TIMEOUT_CASES: readonly TimeoutCase[] = [
  // Measured against real Gemma under shared load (issue #4109): status p95 6 ms.
  { call: "status", deadlineMs: 10_000, invoke: () => getCodingWorkbenchRuntimeStatus() },
  {
    call: "snapshot",
    deadlineMs: 10_000,
    invoke: () => getCodingWorkbenchRuntimeSnapshot("run-1"),
  },
  // A cold model load and a cold OpenCode start are not measured, so a start keeps its bound.
  {
    call: "start",
    deadlineMs: 180_000,
    invoke: () => startCodingWorkbenchRuntime({ requestId: "s", taskIntent: "x" } as never),
  },
  // Measured stop p95 2,558 ms: a 15 s deadline is about six times that.
  {
    call: "stop",
    deadlineMs: 15_000,
    invoke: () => stopCodingWorkbenchRuntime("run-1", { requestId: "run-1" }),
  },
  // Not measured: every other mutation keeps the 60 s bound it always had.
  {
    call: "approval",
    deadlineMs: 60_000,
    invoke: () => decideCodingWorkbenchRuntimeApproval("run-1", OPERATION),
  },
  {
    call: "takeover",
    deadlineMs: 60_000,
    invoke: () => takeOverCodingWorkbenchRuntime("run-1", { requestId: "run-1" }),
  },
  {
    call: "retry",
    deadlineMs: 60_000,
    invoke: () => retryCodingWorkbenchRuntime("run-1", OPERATION),
  },
  {
    call: "recovery-ack",
    deadlineMs: 60_000,
    invoke: () => acknowledgeCodingWorkbenchRuntimeRecovery("run-1", OPERATION),
  },
  {
    call: "pause",
    deadlineMs: 60_000,
    invoke: () => pauseCodingWorkbenchRuntime("run-1", { requestId: "run-1" }),
  },
  {
    call: "resume",
    deadlineMs: 60_000,
    invoke: () => resumeCodingWorkbenchRuntime("run-1", OPERATION),
  },
  {
    call: "follow-up",
    deadlineMs: 60_000,
    invoke: () => submitCodingWorkbenchRuntimeFollowUp("run-1", OPERATION),
  },
  {
    call: "revert",
    deadlineMs: 60_000,
    invoke: () => revertCodingWorkbenchRuntime("run-1", OPERATION),
  },
  {
    call: "inbox",
    deadlineMs: 60_000,
    invoke: () => submitCodingWorkbenchRuntimeInboxAction("run-1", OPERATION),
  },
  {
    call: "research-revoke",
    deadlineMs: 60_000,
    invoke: () => revokeCodingWorkbenchRuntimeResearchGrant("run-1", OPERATION),
  },
  {
    call: "question-answer",
    deadlineMs: 60_000,
    invoke: () => answerCodingWorkbenchRuntimeQuestion("run-1", OPERATION),
  },
  {
    call: "question-reject",
    deadlineMs: 60_000,
    invoke: () => rejectCodingWorkbenchRuntimeQuestion("run-1", OPERATION),
  },
];

describe("Coding Workbench runtime request deadlines", () => {
  const reports: ClientDiagnosticMeta[] = [];

  beforeEach(() => {
    reports.length = 0;
    setClientDiagnosticWriter((_message, meta): void => {
      if (meta !== undefined) reports.push(meta);
    });
  });

  afterEach(() => {
    resetClientDiagnosticWriter();
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

  it("covers every call kind of the closed report vocabulary", () => {
    expect(TIMEOUT_CASES.map((entry) => entry.call).sort()).toEqual(
      [...CLIENT_CODING_RUNTIME_CALLS].sort(),
    );
  });

  describe.each(TIMEOUT_CASES)("$call", ({ call, deadlineMs, invoke }) => {
    it(`waits ${deadlineMs.toString()} ms and records the expiry with its request id`, async () => {
      const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(expiredDeadline);
      const fetchMock = stallingFetch();
      vi.stubGlobal("fetch", fetchMock);

      await expect(invoke()).rejects.toMatchObject({ name: "TimeoutError" });

      expect(timeout).toHaveBeenCalledExactlyOnceWith(deadlineMs);
      const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
      const sent = (init.headers as Record<string, string>)["X-Keiko-Correlation-Id"];
      expect(sent).toMatch(/^[A-Za-z0-9._-]{8,128}$/u);
      const timeouts = reports.filter((meta) => meta.codingRequestTimeout !== undefined);
      expect(timeouts).toEqual([
        { codingRequestTimeout: { call, deadlineMs }, correlationId: sent },
      ]);
    });
  });

  describe("a wait that ends for another reason", () => {
    it("does not report a preempted mutation as a timeout", async () => {
      vi.spyOn(AbortSignal, "timeout").mockImplementation(openDeadline);
      vi.stubGlobal("fetch", stallingFetch());
      const controller = new AbortController();

      const approval = decideCodingWorkbenchRuntimeApproval("run-1", OPERATION, controller.signal);
      controller.abort(new CodingWorkbenchPreemptedError());

      const error: unknown = await approval.catch((reason: unknown) => reason);
      expect(isCodingWorkbenchPreempted(error)).toBe(true);
      expect(reports).toEqual([]);
    });

    it("does not report a caller's own cancellation as a timeout", async () => {
      vi.spyOn(AbortSignal, "timeout").mockImplementation(openDeadline);
      vi.stubGlobal("fetch", stallingFetch());
      const controller = new AbortController();

      const approval = decideCodingWorkbenchRuntimeApproval("run-1", OPERATION, controller.signal);
      controller.abort(new DOMException("The user aborted a request.", "AbortError"));

      await expect(approval).rejects.toMatchObject({ name: "AbortError" });
      expect(isCodingWorkbenchPreempted(new DOMException("x", "AbortError"))).toBe(false);
      expect(reports).toEqual([]);
    });

    it("does not report a refusal the server answered", async () => {
      vi.spyOn(AbortSignal, "timeout").mockImplementation(openDeadline);
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response(JSON.stringify({ error: { code: "CONFLICT", message: "stale" } }), {
            status: 409,
            headers: { "content-type": "application/json" },
          }),
        ),
      );

      await expect(stopCodingWorkbenchRuntime("run-1", { requestId: "run-1" })).rejects.toThrow();
      expect(reports).toEqual([]);
    });
  });

  it("keeps a timeout of a caller-supplied signal on the same deadline and still reports it", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(expiredDeadline);
    vi.stubGlobal("fetch", stallingFetch());
    const controller = new AbortController();

    await expect(
      stopCodingWorkbenchRuntime("run-1", { requestId: "run-1" }, controller.signal),
    ).rejects.toMatchObject({ name: "TimeoutError" });

    expect(timeout).toHaveBeenCalledExactlyOnceWith(15_000);
    expect(reports.map((meta) => meta.codingRequestTimeout)).toEqual([
      { call: "stop", deadlineMs: 15_000 },
    ]);
  });
});
