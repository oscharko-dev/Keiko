import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./api";
import {
  answerCodingWorkbenchRuntimeQuestion,
  decideCodingWorkbenchRuntimeApproval,
  getCodingWorkbenchRuntimeQuestions,
  getCodingWorkbenchRuntimeReadiness,
  parseCodingWorkbenchRuntimeEvent,
  rejectCodingWorkbenchRuntimeQuestion,
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

  it("reads contract-validated pending questions from the encoded active-run route", async () => {
    const questions = {
      questions: [
        {
          id: "que_1",
          questions: [
            {
              header: "Decision",
              question: "Continue with <untrusted> text?",
              options: [{ label: "Continue", description: "Proceed once" }],
            },
          ],
        },
      ],
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(questions));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getCodingWorkbenchRuntimeQuestions("run 1/alpha")).resolves.toEqual(questions);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/coding-workbench/runtime/runs/run%201%2Falpha/questions",
      expect.objectContaining({
        cache: "no-store",
        headers: expect.objectContaining({ Accept: "application/json" }),
      }),
    );

    fetchMock.mockResolvedValueOnce(jsonResponse({ questions: [{ id: "forged", questions: [] }] }));
    await expect(getCodingWorkbenchRuntimeQuestions("run-1")).rejects.toMatchObject({
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

  it("answers or rejects one encoded pending question with exact contract bodies", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() => Promise.resolve(jsonResponse({ accepted: true })));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      answerCodingWorkbenchRuntimeQuestion("run/1", "que_1", {
        answers: [["Proceed"], ["Custom answer"]],
      }),
    ).resolves.toEqual({ accepted: true });
    await expect(rejectCodingWorkbenchRuntimeQuestion("run/1", "que_1")).resolves.toEqual({
      accepted: true,
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/coding-workbench/runtime/runs/run%2F1/questions/que_1/answer",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ answers: [["Proceed"], ["Custom answer"]] }),
        headers: expect.objectContaining({ "X-Keiko-CSRF": "1" }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/coding-workbench/runtime/runs/run%2F1/questions/que_1/reject",
      expect.objectContaining({ method: "POST", body: "{}" }),
    );

    fetchMock.mockResolvedValueOnce(jsonResponse({ accepted: false }));
    await expect(rejectCodingWorkbenchRuntimeQuestion("run-1", "que_1")).rejects.toMatchObject({
      code: "CONTRACT_VALIDATION_FAILED",
      status: 502,
    });
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
