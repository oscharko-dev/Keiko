import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./api";
import {
  acknowledgeCodingWorkbenchRuntimeRecovery,
  codingWorkbenchFailureStatus,
  codingWorkbenchRuntimeActionError,
  codingWorkbenchRuntimeApiError,
  createCodingWorkbenchRuntimeEventSource,
  decideCodingWorkbenchRuntimeApproval,
  getCodingWorkbenchRuntimeReadiness,
  getCodingWorkbenchRuntimeSnapshot,
  getCodingWorkbenchRuntimeStatus,
  listCodingWorkbenchRuntimeQuestions,
  newCodingWorkbenchRuntimeRequestId,
  parseCodingWorkbenchRuntimeEvent,
  retryCodingWorkbenchRuntime,
  startCodingWorkbenchRuntime,
  stopCodingWorkbenchRuntime,
  takeOverCodingWorkbenchRuntime,
} from "./coding-workbench-runtime-api";

const UPDATED_AT = "2026-07-13T12:00:00.000Z";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function snapshot(): Record<string, unknown> {
  return {
    schemaVersion: "1",
    state: "awaiting-approval",
    revision: 3,
    updatedAt: UPDATED_AT,
    runId: "run-1",
    pendingPermission: {
      requestId: "permission-1",
      kind: "delivery-substrate",
      actionClass: "delivery-substrate",
      reasonCode: "approval-required",
      actionKind: "push",
      scopeLabel: "workspace-scope",
      risk: "high",
      policyReason: "approval-required",
      expiresAt: "2026-07-13T12:05:00.000Z",
    },
  };
}

describe("Coding Workbench runtime API", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads only the server-owned readiness projection and rejects a forged effective mode", async () => {
    const readiness = {
      schemaVersion: "1",
      requestedMode: "supervised-coding",
      deploymentCeiling: "governed-assist",
      effectiveMode: "governed-assist",
      runtimeAvailable: true,
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(readiness));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getCodingWorkbenchRuntimeReadiness("supervised-coding")).resolves.toEqual(
      readiness,
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/coding-workbench/runtime/readiness?requestedMode=supervised-coding",
      expect.objectContaining({
        cache: "no-store",
        headers: expect.objectContaining({ Accept: "application/json" }),
      }),
    );

    fetchMock.mockResolvedValueOnce(
      jsonResponse({ ...readiness, effectiveMode: "supervised-coding" }),
    );
    await expect(getCodingWorkbenchRuntimeReadiness("supervised-coding")).rejects.toMatchObject({
      code: "CONTRACT_VALIDATION_FAILED",
      status: 502,
    });
  });

  it("posts a revision-bound approval to an encoded run route with CSRF protection", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(snapshot()));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      decideCodingWorkbenchRuntimeApproval("run 1/alpha", {
        requestId: "permission-1",
        expectedRevision: 3,
        decision: "approved",
      }),
    ).resolves.toMatchObject({ state: "awaiting-approval", revision: 3 });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/coding-workbench/runtime/runs/run%201%2Falpha/approvals",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          requestId: "permission-1",
          expectedRevision: 3,
          decision: "approved",
        }),
        headers: expect.objectContaining({
          "Content-Type": "application/json",
          "X-Keiko-CSRF": "1",
        }),
      }),
    );
  });

  it("rejects malformed stream payloads without including stream content in the client error", () => {
    const hostileEvent = '{"prompt":"customer task private content"}';

    expect(() => parseCodingWorkbenchRuntimeEvent(hostileEvent)).toThrow(ApiError);
    try {
      parseCodingWorkbenchRuntimeEvent(hostileEvent);
    } catch (error) {
      expect(error).toMatchObject({ code: "CONTRACT_VALIDATION_FAILED", status: 502 });
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toContain("customer task private content");
    }
  });
});

describe("Coding Workbench runtime API error mapping", () => {
  it("maps transport-level ApiErrors with a retryability verdict", () => {
    expect(
      codingWorkbenchRuntimeApiError(new ApiError("RUNTIME_TIMEOUT", "timed out", 408)),
    ).toEqual({ code: "RUNTIME_TIMEOUT", message: "timed out", retryable: true });
    expect(codingWorkbenchRuntimeApiError(new ApiError("RUN_NOT_FOUND", "missing", 404))).toEqual({
      code: "RUN_NOT_FOUND",
      message: "missing",
      retryable: false,
    });
  });

  it("maps unknown failures to a retryable client error without leaking values", () => {
    expect(codingWorkbenchRuntimeApiError("hostile string")).toEqual({
      code: "CODING_RUNTIME_CLIENT_ERROR",
      message: "The runtime request failed.",
      retryable: true,
    });
    expect(codingWorkbenchRuntimeApiError(new Error("socket closed")).message).toBe(
      "socket closed",
    );
  });

  it("derives the resource failure status from the error code", () => {
    expect(
      codingWorkbenchFailureStatus({ code: "RUNTIME_UNAVAILABLE", message: "", retryable: false }),
    ).toBe("unavailable");
    expect(
      codingWorkbenchFailureStatus({ code: "BAD_REQUEST", message: "", retryable: false }),
    ).toBe("error");
  });

  it("issues unique request ids and a conflict-coded action error", () => {
    const first = newCodingWorkbenchRuntimeRequestId();
    const second = newCodingWorkbenchRuntimeRequestId();
    expect(first).not.toBe(second);
    expect(first.length).toBeGreaterThan(0);

    const error = codingWorkbenchRuntimeActionError("not ready");
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ code: "CODING_RUNTIME_ACTION_UNAVAILABLE", status: 409 });
  });
});

describe("Coding Workbench runtime API endpoints", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetch(body: unknown): ReturnType<typeof vi.fn> {
    // A fresh Response per call: the body of a Response is single-use.
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse(body)));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  // #2478: the question list rides the authenticated channel payload; the client validator
  // accepts both session facets and rejects anything that is not the channel shape.
  it("lists questions as the channel payload and contract-validates it", async () => {
    const fetchMock = stubFetch({ session: "unpaired", questions: [] });
    await expect(
      listCodingWorkbenchRuntimeQuestions("run-1", { requestId: "req-1", expectedRevision: 3 }),
    ).resolves.toEqual({ session: "unpaired", questions: [] });
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/coding-workbench/runtime/runs/run-1/questions",
      expect.objectContaining({ method: "POST" }),
    );

    stubFetch({ questions: [] });
    await expect(
      listCodingWorkbenchRuntimeQuestions("run-1", { requestId: "req-2", expectedRevision: 3 }),
    ).rejects.toMatchObject({ code: "CONTRACT_VALIDATION_FAILED" });
  });

  it("reads the global status and a run-scoped snapshot from their routes", async () => {
    const fetchMock = stubFetch(snapshot());
    await expect(getCodingWorkbenchRuntimeStatus()).resolves.toMatchObject({ runId: "run-1" });
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/coding-workbench/runtime/status",
      expect.objectContaining({ cache: "no-store" }),
    );

    await expect(getCodingWorkbenchRuntimeSnapshot("run-1")).resolves.toMatchObject({
      revision: 3,
    });
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/coding-workbench/runtime/runs/run-1",
      expect.objectContaining({ cache: "no-store" }),
    );
  });

  it("posts lifecycle mutations to their run-scoped routes", async () => {
    const fetchMock = stubFetch(snapshot());

    await startCodingWorkbenchRuntime({
      requestId: "request-1",
      taskIntent: "add a test",
      requestedMode: "governed-assist",
      runtimePreference: "managed-gateway",
    });
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/coding-workbench/runtime/runs",
      expect.objectContaining({ method: "POST" }),
    );

    await stopCodingWorkbenchRuntime("run-1", { requestId: "run-1" });
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/coding-workbench/runtime/runs/run-1/stop",
      expect.objectContaining({ method: "POST" }),
    );

    await takeOverCodingWorkbenchRuntime("run-1", { requestId: "run-1" });
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/coding-workbench/runtime/runs/run-1/takeover",
      expect.objectContaining({ method: "POST" }),
    );

    await retryCodingWorkbenchRuntime("run-1", {
      requestId: "request-2",
      taskIntent: "retry the task",
      requestedMode: "governed-assist",
      runtimePreference: "managed-gateway",
    });
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/coding-workbench/runtime/runs/run-1/retry",
      expect.objectContaining({ method: "POST" }),
    );

    await acknowledgeCodingWorkbenchRuntimeRecovery("run-1", {
      requestId: "run-1",
      acknowledged: true,
    });
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/coding-workbench/runtime/runs/run-1/recovery-ack",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("rejects a non-JSON stream payload with a stream-invalid contract error", () => {
    expect(() => parseCodingWorkbenchRuntimeEvent("not json")).toThrowError(
      expect.objectContaining({ code: "CODING_RUNTIME_STREAM_INVALID", status: 502 }),
    );
  });

  it("opens the run event stream same-origin and fails closed without EventSource", () => {
    class FakeEventSource {
      public readonly url: string;
      public constructor(url: string) {
        this.url = url;
      }
    }
    vi.stubGlobal("EventSource", FakeEventSource);
    const source = createCodingWorkbenchRuntimeEventSource("run-1");
    expect(source).toBeInstanceOf(FakeEventSource);
    expect((source as unknown as FakeEventSource).url).toBe(
      "/api/coding-workbench/runtime/runs/run-1/events",
    );

    vi.unstubAllGlobals();
    expect(() => createCodingWorkbenchRuntimeEventSource("run-1")).toThrowError(
      expect.objectContaining({ code: "CODING_RUNTIME_STREAM_UNAVAILABLE" }),
    );
  });
});
