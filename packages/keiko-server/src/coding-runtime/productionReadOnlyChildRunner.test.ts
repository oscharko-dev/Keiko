import { describe, expect, it } from "vitest";

import type { CodeTaskChildRunId } from "@oscharko-dev/keiko-contracts";
import type { NormalizedResponse } from "@oscharko-dev/keiko-model-gateway";

import { createProductionReadOnlyChildRunner } from "./productionReadOnlyChildRunner.js";

function response(): NormalizedResponse {
  return {
    modelId: "child-model",
    content: "Repository inspected",
    finishReason: "stop",
    toolCalls: [],
    structuredOutput: null,
    usage: {
      requestId: "child-request",
      promptTokens: 1,
      completionTokens: 1,
      latencyMs: 1,
      costClass: "low",
    },
  };
}

describe("createProductionReadOnlyChildRunner", () => {
  it("runs a bounded harness session without exposing mutation tools", async () => {
    const runner = createProductionReadOnlyChildRunner({
      modelPortFactory: () => ({ call: () => Promise.resolve(response()) }),
      secureWorkspaceTextRead: { readText: () => Promise.resolve({ ok: true, text: "text" }) },
    });

    const outcome = await runner.run({
      envelope: {
        parentRunId: "run-2387",
        childRunId: "chr_test-child" as CodeTaskChildRunId,
        childDepth: 1,
        oneLayer: true,
        allowedActionClasses: ["workspace-read"],
        networkPolicy: { mode: "deny-all", allowLoopback: false, connectorScopes: [] },
        canMintGrant: false,
      },
      objective: "Inspect repository",
      modelId: "child-model",
      workspaceRoot: "/workspace",
      maxToolCalls: 2,
      signal: new AbortController().signal,
      gate: () => ({ ok: true }),
    });

    expect(outcome.resultCount).toBe(0);
    expect(outcome.resultDigest.outcome).toBe("known");
  });
});
