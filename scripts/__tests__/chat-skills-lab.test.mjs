import { describe, expect, it } from "vitest";
import { requestObservation, responseObservation } from "../testing/chat-skills-lab/runtime.mjs";
import {
  extractGeneratedTest,
  containerArguments,
} from "../testing/chat-skills-lab/verify-tests.mjs";
import { SUMMARY_SYSTEM_PROMPT } from "../../packages/keiko-server/dist/chat-compaction-model-summary.js";
import { PROMPT_COMPACTION_SYSTEM } from "../../packages/keiko-server/dist/chat-prompt-compaction.js";

const scope = {
  question: "Review the boundary",
  skillBody: "# Synthetic method\nCheck the boundary.",
  source: "Synthetic source",
  compactionPrompts: new Set([SUMMARY_SYSTEM_PROMPT, PROMPT_COMPACTION_SYSTEM]),
};
describe("private Chat skill qualification observations", () => {
  it("distinguishes real synthesis from summaries containing the same question without losing physical attempts", () => {
    const body = "Synthetic request bytes";
    for (const system of scope.compactionPrompts) {
      const result = requestObservation(
        {
          messages: [
            { role: "system", content: system },
            { role: "user", content: scope.question },
          ],
        },
        body.length,
        body,
        scope,
      );
      expect(result).toMatchObject({
        operation: "compaction",
        caseRequest: false,
        skillOccurrences: 0,
      });
    }
    const result = requestObservation(
      {
        messages: [
          { role: "system", content: scope.skillBody },
          { role: "user", content: scope.question },
        ],
      },
      body.length,
      body,
      scope,
    );
    expect(result).toMatchObject({
      operation: "conversation",
      caseRequest: true,
      skillOccurrences: 1,
    });
  });
  it("retains final SSE usage and refuses malformed provider data", () => {
    const raw =
      'data: {"choices":[{"finish_reason":"stop"}]}\n\ndata: {"usage":{"prompt_tokens":7,"completion_tokens":11}}\n\ndata: [DONE]\n';
    expect(responseObservation(raw)).toMatchObject({
      finishReason: "stop",
      usage: { prompt_tokens: 7, completion_tokens: 11 },
      responseKind: "complete",
    });
    expect(() => responseObservation("not-json")).toThrow();
  });
  it("refuses ambiguous generated files and retains the offline, read-only execution boundary", () => {
    const code = "```tsx\nexport const value = 1;\n```";
    expect(extractGeneratedTest(code)).toBe("export const value = 1;\n");
    expect(() => extractGeneratedTest(code + code)).toThrow("one-complete-test-file-required");
    const args = containerArguments("/synthetic/input", "/synthetic/deps", "synthetic-container");
    expect(args).toEqual(
      expect.arrayContaining([
        "--network",
        "none",
        "--read-only",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        "--pids-limit=128",
        "--memory=1g",
        "--cpus=2",
      ]),
    );
    expect(args).toContain(
      "type=bind,source=/synthetic/deps,target=/opt/qualification/node_modules,readonly",
    );
    expect(args).toContain("type=bind,source=/synthetic/input,target=/input,readonly");
  });
});
