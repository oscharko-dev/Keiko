import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import type { UiHandlerDeps } from "../deps.js";
import { matchRoute, type RouteContext } from "../routes.js";
import {
  CODING_RUNTIME_QUESTION_ROUTE_GROUP,
  handleCodingRuntimeQuestionAnswer,
  handleCodingRuntimeQuestionReject,
  handleCodingRuntimeQuestions,
} from "./codingRuntimeQuestionRoutes.js";

const pending = {
  questions: [
    {
      id: "que_1",
      questions: [
        {
          header: "Decision",
          question: "Continue with <untrusted> text?",
          options: [{ label: "Continue", description: "Proceed" }],
        },
      ],
    },
  ],
} as const;

function context(
  body = "",
  params: Record<string, string> = { runId: "run-1" },
  path = "/api/coding-workbench/runtime/runs/run-1/questions",
): RouteContext {
  const req = new PassThrough() as unknown as RouteContext["req"];
  req.headers = {};
  queueMicrotask(() => (req as unknown as PassThrough).end(body));
  return {
    req,
    res: {} as RouteContext["res"],
    params,
    url: new URL(`http://localhost${path}`),
  };
}

function deps(overrides: Partial<UiHandlerDeps> = {}): UiHandlerDeps {
  return {
    codingRuntimeOrchestrator: {
      status: () => ({
        schemaVersion: "1",
        state: "running",
        revision: 4,
        updatedAt: "2026-07-13T12:00:00.000Z",
        runId: "run-1",
      }),
    },
    codingRuntimeQuestionPort: {
      list: vi.fn(() => Promise.resolve(pending)),
      answer: vi.fn(() => Promise.resolve(true)),
      reject: vi.fn(() => Promise.resolve(true)),
    },
    ...overrides,
  } as unknown as UiHandlerDeps;
}

describe("coding runtime question routes", () => {
  it("lists only validated questions for the active run", async () => {
    const runtimeDeps = deps();

    await expect(handleCodingRuntimeQuestions(context(), runtimeDeps)).resolves.toEqual({
      status: 200,
      body: pending,
    });
    expect(runtimeDeps.codingRuntimeQuestionPort?.list).toHaveBeenCalledWith("run-1");
    expect(JSON.stringify(pending)).not.toContain("sessionID");
    expect(CODING_RUNTIME_QUESTION_ROUTE_GROUP[0]).toMatchObject({
      method: "GET",
      pattern: "/api/coding-workbench/runtime/runs/:runId/questions",
    });
    expect(matchRoute("GET", "/api/coding-workbench/runtime/runs/run-1/questions")).toMatchObject({
      params: { runId: "run-1" },
    });
  });

  it("rejects forged, stale, terminal, and malformed upstream question lists content-free", async () => {
    for (const [ctx, runtimeDeps] of [
      [context("", { runId: "../forged" }), deps()],
      [context("", { runId: "run-other" }), deps()],
      [
        context(),
        deps({
          codingRuntimeOrchestrator: {
            status: () => ({ ...deps().codingRuntimeOrchestrator?.status(), state: "succeeded" }),
          } as UiHandlerDeps["codingRuntimeOrchestrator"],
        }),
      ],
      [
        context(),
        deps({
          codingRuntimeQuestionPort: {
            list: () => Promise.resolve({ questions: [{ id: "forged", questions: [] }] }),
            answer: () => Promise.resolve(false),
            reject: () => Promise.resolve(false),
          } as unknown as UiHandlerDeps["codingRuntimeQuestionPort"],
        }),
      ],
      [
        context(),
        deps({
          codingRuntimeQuestionPort: {
            list: () => Promise.reject(new Error("private question text")),
            answer: () => Promise.resolve(false),
            reject: () => Promise.resolve(false),
          },
        }),
      ],
    ] as const) {
      const result = await handleCodingRuntimeQuestions(ctx, runtimeDeps);
      expect(result.status).toBeGreaterThanOrEqual(400);
      expect(JSON.stringify(result.body)).toBe(
        '{"error":{"code":"CODING_RUNTIME_QUESTION_REJECTED","message":"Runtime question request was rejected."}}',
      );
    }
  });

  it("answers or rejects a currently owned pending question exactly once", async () => {
    const runtimeDeps = deps();
    const params = { runId: "run-1", questionId: "que_1" };

    await expect(
      handleCodingRuntimeQuestionAnswer(context('{"answers":[["Continue"]]}', params), runtimeDeps),
    ).resolves.toEqual({ status: 200, body: { accepted: true } });
    await expect(
      handleCodingRuntimeQuestionReject(context("{}", params), runtimeDeps),
    ).resolves.toEqual({ status: 200, body: { accepted: true } });
    expect(runtimeDeps.codingRuntimeQuestionPort?.answer).toHaveBeenCalledWith("run-1", "que_1", [
      ["Continue"],
    ]);
    expect(runtimeDeps.codingRuntimeQuestionPort?.reject).toHaveBeenCalledWith("run-1", "que_1");
    expect(
      CODING_RUNTIME_QUESTION_ROUTE_GROUP.map(({ method, pattern }) => `${method} ${pattern}`),
    ).toEqual([
      "GET /api/coding-workbench/runtime/runs/:runId/questions",
      "POST /api/coding-workbench/runtime/runs/:runId/questions/:questionId/answer",
      "POST /api/coding-workbench/runtime/runs/:runId/questions/:questionId/reject",
    ]);
  });

  it("rejects malformed, forged, and replayed mutations without reflecting content", async () => {
    const port = {
      list: vi.fn(() => Promise.resolve(pending)),
      answer: vi.fn(() => Promise.resolve(false)),
      reject: vi.fn(() => Promise.resolve(false)),
    };
    const runtimeDeps = deps({ codingRuntimeQuestionPort: port });
    for (const [handler, ctx] of [
      [
        handleCodingRuntimeQuestionAnswer,
        context('{"answers":[["private"]],"forged":true}', {
          runId: "run-1",
          questionId: "que_1",
        }),
      ],
      [
        handleCodingRuntimeQuestionAnswer,
        context('{"answers":[["private"]]}', { runId: "run-1", questionId: "que_1" }),
      ],
      [
        handleCodingRuntimeQuestionReject,
        context('{"reason":"private"}', { runId: "run-1", questionId: "que_1" }),
      ],
      [handleCodingRuntimeQuestionReject, context("{}", { runId: "run-1", questionId: "forged" })],
    ] as const) {
      const result = await handler(ctx, runtimeDeps);
      expect(result.status).toBeGreaterThanOrEqual(400);
      expect(result).toMatchObject({
        body: { error: { code: "CODING_RUNTIME_QUESTION_REJECTED" } },
      });
      expect(JSON.stringify(result.body)).not.toContain("private");
    }
  });
});
