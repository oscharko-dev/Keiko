import { describe, expect, it } from "vitest";
import {
  SDK_VERSION,
  investigateBug,
  BUG_INVESTIGATION_WORKFLOW_DESCRIPTOR,
  isSensitivePath,
} from "../../src/sdk/index.js";
import * as root from "../../src/index.js";
import { memFs } from "../workspace/_memfs.js";
import type { ModelPort } from "../../src/harness/ports.js";
import type { NormalizedResponse } from "../../src/gateway/types.js";

describe("SDK surface", () => {
  it("exposes a semver SDK_VERSION", () => {
    expect(SDK_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("re-exports the SDK from the package root", () => {
    expect(root.SDK_VERSION).toBe(SDK_VERSION);
  });
});

describe("bug-investigation workflow via the SDK barrel (AC #2 round-trip)", () => {
  const FIX = [
    "```diff",
    "--- a/src/buggy.ts",
    "+++ b/src/buggy.ts",
    "@@ -1 +1 @@",
    "-export const half = (n: number): number => n / 3;",
    "+export const half = (n: number): number => n / 2;",
    "```",
    "## Root cause",
    "wrong divisor",
  ].join("\n");

  function model(content: string): ModelPort {
    const response: NormalizedResponse = {
      modelId: "m",
      content,
      finishReason: "stop",
      toolCalls: [],
      structuredOutput: null,
      usage: {
        requestId: "r",
        promptTokens: 1,
        completionTokens: 1,
        latencyMs: 1,
        costClass: "high",
      },
    };
    return { call: (): Promise<NormalizedResponse> => Promise.resolve(response) };
  }

  it("runs investigateBug imported from the SDK with injected deps (no stdout)", async () => {
    const fs = memFs("/repo", {
      "package.json": JSON.stringify({ name: "demo", devDependencies: { vitest: "^4" } }),
      "src/buggy.ts": "export const half = (n: number): number => n / 3;\n",
    });
    const report = await investigateBug(
      {
        workspaceRoot: "/repo",
        report: { description: "half wrong", stackTrace: "at half (src/buggy.ts:1:40)" },
        modelId: "m",
      },
      { model: model(FIX), fs },
    );
    expect(report.workflowId).toBe("bug-investigation");
    expect(report.status).toBe("fix-proposed");
    expect(report.verified.failureFrames).toContainEqual({ file: "src/buggy.ts", line: 1 });
    expect(report.hypothesis.rootCause).toContain("wrong divisor");
  });

  it("exposes the descriptor and the scope guard through the SDK and the root barrel", () => {
    expect(BUG_INVESTIGATION_WORKFLOW_DESCRIPTOR.workflowId).toBe("bug-investigation");
    expect(isSensitivePath(".github/workflows/ci.yml")).toBe(true);
    expect(root.BUG_INVESTIGATION_WORKFLOW_DESCRIPTOR).toBe(BUG_INVESTIGATION_WORKFLOW_DESCRIPTOR);
    expect(typeof root.renderBugInvestigationReport).toBe("function");
  });
});
