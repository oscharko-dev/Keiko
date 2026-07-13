import { describe, expect, it, vi } from "vitest";
import { CODING_WORKBENCH_RUNTIME_QUESTIONS_MAX_UTF8_BYTES } from "@oscharko-dev/keiko-contracts";

import { createProductionOpenCodeQuestionPort } from "./productionOpenCodeQuestionPort.js";
import {
  createProductionCodingRuntimeHost,
  type QualifiedProductionCodingRuntime,
} from "./productionCodingRuntimeHost.js";

describe("production OpenCode question port", () => {
  it("projects the qualified run port without session or tool internals", async () => {
    const runPort = {
      listQuestions: vi.fn(() =>
        Promise.resolve([
          {
            id: "que_1",
            sessionID: "ses_private",
            tool: { messageID: "msg_private", callID: "call_private" },
            questions: [
              {
                header: "Decision",
                question: "Untrusted question text",
                options: [{ label: "Continue", description: "Proceed" }],
              },
            ],
          },
        ]),
      ),
      answerQuestion: vi.fn(() => Promise.resolve(true)),
      rejectQuestion: vi.fn(() => Promise.resolve(true)),
    };
    const port = createProductionOpenCodeQuestionPort(
      new Map([["run-1", { composition: { runPort } }]]),
    );

    await expect(port.list("run-1")).resolves.toEqual({
      questions: [
        {
          id: "que_1",
          questions: [
            {
              header: "Decision",
              question: "Untrusted question text",
              options: [{ label: "Continue", description: "Proceed" }],
            },
          ],
        },
      ],
    });
    await expect(port.answer("run-1", "que_1", [["Continue"]])).resolves.toBe(true);
    await expect(port.reject("run-1", "que_1")).resolves.toBe(true);
    await expect(port.list("stale-run")).resolves.toBeUndefined();
    await expect(port.answer("stale-run", "que_1", [["Continue"]])).resolves.toBe(false);
    expect(runPort.answerQuestion).toHaveBeenCalledWith("run-1", "que_1", [["Continue"]]);
    expect(runPort.rejectQuestion).toHaveBeenCalledWith("run-1", "que_1");
  });

  it("exposes question controls only when the qualified dispatcher owns them", () => {
    const questionPort = createProductionOpenCodeQuestionPort(new Map());
    const taskDispatcher = {
      dispatch: (): Promise<{ readonly ok: false }> => Promise.resolve({ ok: false }),
      abort: (): Promise<boolean> => Promise.resolve(false),
      ...questionPort,
    };
    const runtime = {
      taskDispatcher,
      createManager: vi.fn(),
      mintLaunch: {},
      approvalAuthority: {},
      recovery: {},
      cancellationRegistry: {},
    } as unknown as QualifiedProductionCodingRuntime;

    const host = createProductionCodingRuntimeHost({ resolve: () => runtime });

    expect(host?.questionPort).toBe(taskDispatcher);
  });

  it("fails closed without leaking a valid prefix when aggregate nested content is oversized", async () => {
    const prefix = "SENTINEL_VALID_PREFIX";
    const runPort = {
      listQuestions: vi.fn(() =>
        Promise.resolve([
          {
            id: "que_1",
            sessionID: "ses_private",
            questions: [
              {
                header: "Decision",
                question: prefix,
                options: Array.from({ length: 32 }, (_, index) => ({
                  label: `Option ${String(index)}`,
                  description: "x".repeat(4_096),
                })),
              },
            ],
          },
        ]),
      ),
      answerQuestion: vi.fn(() => Promise.resolve(false)),
      rejectQuestion: vi.fn(() => Promise.resolve(false)),
    };
    const port = createProductionOpenCodeQuestionPort(
      new Map([["run-1", { composition: { runPort } }]]),
    );

    const result = await port.list("run-1");
    expect(JSON.stringify(result ?? null)).not.toContain(prefix);
    expect(result).toBeUndefined();
    expect(
      Buffer.byteLength(JSON.stringify((await runPort.listQuestions())[0]), "utf8"),
    ).toBeGreaterThan(CODING_WORKBENCH_RUNTIME_QUESTIONS_MAX_UTF8_BYTES);
  });
});
