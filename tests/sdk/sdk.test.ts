import { describe, expect, it } from "vitest";
import {
  SDK_VERSION,
  buildWorkspaceSummary,
  createInMemoryEvidenceStore,
  detectWorkspace,
  investigateBug,
  loadEvidence,
  runAgent,
  BUG_INVESTIGATION_WORKFLOW_DESCRIPTOR,
  isSensitivePath,
  summarizeForAudit,
} from "../../src/sdk/index.js";
import * as root from "../../src/index.js";
import { memFs } from "../workspace/_memfs.js";
import { DryRunToolPort, MemoryEventSink } from "../../src/harness/index.js";
import type { ModelPort } from "../../src/harness/ports.js";
import type { NormalizedResponse } from "../../src/gateway/types.js";

describe("SDK surface", () => {
  it("exposes a semver SDK_VERSION", () => {
    expect(SDK_VERSION).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  });

  it("re-exports the SDK from the package root", () => {
    expect(root.SDK_VERSION).toBe(SDK_VERSION);
    expect(root.runAgent).toBe(runAgent);
  });

  it("exposes the safe workspace summary API through the SDK and root barrels", () => {
    expect(typeof detectWorkspace).toBe("function");
    expect(typeof buildWorkspaceSummary).toBe("function");
    expect(typeof summarizeForAudit).toBe("function");
    expect(root.detectWorkspace).toBe(detectWorkspace);
    expect(root.buildWorkspaceSummary).toBe(buildWorkspaceSummary);
    expect(root.summarizeForAudit).toBe(summarizeForAudit);
    expect(root).not.toHaveProperty("nodeWorkspaceFs");
  });
});

describe("SDK runAgent evidence persistence", () => {
  function model(content = "done"): ModelPort {
    const response: NormalizedResponse = {
      modelId: "m",
      content,
      finishReason: "stop",
      toolCalls: [],
      structuredOutput: null,
      usage: {
        requestId: "sdk-run",
        promptTokens: 1,
        completionTokens: 2,
        latencyMs: 3,
        costClass: "low",
      },
    };
    return { call: (): Promise<NormalizedResponse> => Promise.resolve(response) };
  }

  it("persists a redacted evidence manifest by default through the SDK runAgent", async () => {
    const store = createInMemoryEvidenceStore();
    const session = runAgent(
      { taskType: "explain-plan", input: { filePath: "src/foo.ts" } },
      {
        model: "m",
        workingDirectory: "/repo",
        evidence: { store },
      },
      { model: model(), tools: new DryRunToolPort(), sink: new MemoryEventSink() },
    );
    const result = await session.result;
    expect(store.list()).toEqual([result.runId]);
    const loaded = loadEvidence(store, result.runId);
    expect(loaded?.run.runId).toBe(result.runId);
    expect(loaded?.run.fingerprint).toBe(session.fingerprint);
    expect(loaded?.usageTotals.requestCount).toBe(1);
  });

  it("allows SDK callers to opt out of evidence writes explicitly", async () => {
    const store = createInMemoryEvidenceStore();
    const session = runAgent(
      { taskType: "explain-plan", input: { filePath: "src/foo.ts" } },
      {
        model: "m",
        workingDirectory: "/repo",
        evidence: { store, write: false },
      },
      { model: model(), tools: new DryRunToolPort(), sink: new MemoryEventSink() },
    );
    await session.result;
    expect(store.list()).toEqual([]);
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
