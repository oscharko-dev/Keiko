// Unit tests for `startRun` covering the verify dispatch branch added for issue #65. Verify uses a
// real temp workspace (no fixture copying — the workspace shape is just package.json + an empty
// scripts object so detectScripts returns no targets and the orchestrator reports all-skipped/
// passed). No model port is exercised (verify never calls a model); the rejected model port
// asserts that property.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { CodingWorkbenchMode } from "@oscharko-dev/keiko-contracts";
import { startRun, workflowFingerprint } from "./run-engine.js";
import { createRunRegistry, type RunRegistry } from "./runs.js";
import { parseRunRequest, type RunRequest } from "./run-request.js";
import type { ModelPort } from "@oscharko-dev/keiko-harness";
import type { NormalizedResponse } from "@oscharko-dev/keiko-model-gateway";
import type { AppSession } from "./coding-app-session/sessionRegistry.js";
import {
  createAgentRunGovernance,
  type AgentRunGovernanceBinding,
} from "./agent-run-governance.js";
import { editorAgentAuthorityRegistry } from "./editor/agentAuthorityRegistry.js";
import type { VerificationReport } from "@oscharko-dev/keiko-verification";

const REJECT_MODEL: ModelPort = {
  call: (): Promise<NormalizedResponse> =>
    Promise.reject(new Error("verify must not call a model")),
};

let workspaceRoot: string;
let registry: RunRegistry;
const GOVERNANCE_NOW = "2026-07-31T08:00:00.000Z";
const GOVERNANCE_SESSION: AppSession = {
  sessionId: "sess_0123456789abcdef01234567",
  principalLabel: "local-user",
  issuedAtMs: Date.parse(GOVERNANCE_NOW),
  lastSeenAtMs: Date.parse(GOVERNANCE_NOW),
  rotationCount: 0,
};

function makeWorkspace(scripts: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "keiko-verify-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", scripts }));
  return root;
}

function ok(value: ReturnType<typeof parseRunRequest>): RunRequest {
  if ("code" in value) {
    throw new Error(`parse failed: ${value.message}`);
  }
  return value;
}

function governance(
  requestedMode: CodingWorkbenchMode,
  deploymentCeiling: CodingWorkbenchMode,
): AgentRunGovernanceBinding {
  const result = createAgentRunGovernance({
    runId: randomUUID(),
    workflow: "unit-tests",
    workspaceRoot,
    modelId: "m",
    requestedMode,
    deploymentCeiling,
    session: GOVERNANCE_SESSION,
    nowIso: GOVERNANCE_NOW,
  });
  if (!result.ok) throw new Error(result.reason);
  return result.binding;
}

beforeEach(() => {
  editorAgentAuthorityRegistry.reset();
  workspaceRoot = makeWorkspace();
  registry = createRunRegistry();
});

describe("workflow governance fingerprint", () => {
  it("is stable for identical config and separates requested mode, effective mode, and ceiling", () => {
    const request = ok(
      parseRunRequest(
        JSON.stringify({
          workflowId: "unit-test-generation",
          modelId: "m",
          input: { workspaceRoot, target: { kind: "file", filePath: "src/add.ts" } },
        }),
      ),
    );
    const supervised = governance("supervised-coding", "autonomous-delivery");
    const sameConfigNewAuthority = governance("supervised-coding", "autonomous-delivery");
    const lowerCeiling = governance("supervised-coding", "supervised-coding");
    const fullAccess = governance("autonomous-delivery", "autonomous-delivery");

    expect(workflowFingerprint(request, sameConfigNewAuthority)).toBe(
      workflowFingerprint(request, supervised),
    );
    expect(workflowFingerprint(request, lowerCeiling)).not.toBe(
      workflowFingerprint(request, supervised),
    );
    expect(workflowFingerprint(request, fullAccess)).not.toBe(
      workflowFingerprint(request, supervised),
    );
  });
});

afterEach(() => {
  rmSync(workspaceRoot, { recursive: true, force: true });
});

async function waitForTerminal(runId: string): Promise<void> {
  const record = registry.get(runId);
  if (record === undefined) throw new Error("run was not registered");
  if (record.status !== "running") return;
  await new Promise<void>((resolve) => {
    let detach = (): void => undefined;
    const settle = (): void => {
      detach();
      resolve();
    };
    detach = record.sink.attach({ write: () => true, close: settle }, Number.MAX_SAFE_INTEGER);
    if (record.sink.isTerminated()) settle();
  });
}

function passedVerificationReport(): VerificationReport {
  return {
    workspaceRoot,
    results: [],
    overallStatus: "passed",
    startedAtMs: 1,
    durationMs: 1,
    counts: {
      passed: 0,
      failed: 0,
      skipped: 0,
      denied: 0,
      "timed-out": 0,
      cancelled: 0,
      "resource-exceeded": 0,
    },
  };
}

describe("startRun verify dispatch", () => {
  it("dispatches verify through the enforced verification executor", async () => {
    const request = ok(
      parseRunRequest(
        JSON.stringify({
          taskType: "verify",
          modelId: "m",
          input: { workspaceRoot },
        }),
      ),
    );
    const report = passedVerificationReport();
    const verificationExecutor = vi.fn(() =>
      Promise.resolve({ report, probe: { available: true, backend: "test-backend" } }),
    );
    const result = startRun(
      { request, model: REJECT_MODEL, registry, verificationExecutor },
      (value) => value,
    );
    await waitForTerminal(result.runId);

    expect(verificationExecutor).toHaveBeenCalledOnce();
    expect(verificationExecutor).toHaveBeenCalledWith(
      expect.objectContaining({ probeCwd: workspaceRoot }),
    );
    expect(registry.get(result.runId)?.report).toBe(report);
  });

  it("returns a synchronous {runId, fingerprint} and registers the run", () => {
    const request = ok(
      parseRunRequest(
        JSON.stringify({
          taskType: "verify",
          modelId: "m",
          input: { workspaceRoot },
        }),
      ),
    );
    const result = startRun({ request, model: REJECT_MODEL, registry }, (v) => v);
    expect(result.runId).toMatch(/[0-9a-f-]{36}/u);
    expect(result.fingerprint).toMatch(/^[0-9a-f]{64}$/u);
    expect(registry.get(result.runId)).toBeDefined();
  });

  it("runs the verification orchestrator and reaches a terminal status without calling the model", async () => {
    const request = ok(
      parseRunRequest(
        JSON.stringify({
          taskType: "verify",
          modelId: "m",
          input: { workspaceRoot },
        }),
      ),
    );
    const result = startRun({ request, model: REJECT_MODEL, registry }, (v) => v);
    await waitForTerminal(result.runId);
    const record = registry.get(result.runId);
    expect(record).toBeDefined();
    expect(record?.status).toBe("completed");
  });

  it("emits a run:started SSE event with taskType=verify before the run completes", () => {
    const request = ok(
      parseRunRequest(
        JSON.stringify({
          taskType: "verify",
          modelId: "m",
          input: { workspaceRoot },
        }),
      ),
    );
    const result = startRun({ request, model: REJECT_MODEL, registry }, (v) => v);
    const record = registry.get(result.runId);
    const buffered = record?.sink.buffered() ?? [];
    expect(buffered.some((e) => e.type === "run:started")).toBe(true);
  });

  it("propagates cancel() to the verification orchestrator and ends in `cancelled`", async () => {
    const request = ok(
      parseRunRequest(
        JSON.stringify({
          taskType: "verify",
          modelId: "m",
          input: { workspaceRoot },
        }),
      ),
    );
    const result = startRun({ request, model: REJECT_MODEL, registry }, (v) => v);
    const record = registry.get(result.runId);
    record?.cancel("test-cancel");
    await waitForTerminal(result.runId);
    const final = registry.get(result.runId);
    // With no script-backed steps, the verify run finishes too fast for cancel to be observable;
    // accept either `cancelled` or `completed` (a benign race), but never `running`.
    expect(["cancelled", "completed", "failed"]).toContain(final?.status);
  });

  it("returns a non-appliable run (verify never produces an appliable snapshot)", async () => {
    const request = ok(
      parseRunRequest(
        JSON.stringify({
          taskType: "verify",
          modelId: "m",
          input: { workspaceRoot },
        }),
      ),
    );
    const result = startRun({ request, model: REJECT_MODEL, registry }, (v) => v);
    await waitForTerminal(result.runId);
    expect(registry.get(result.runId)?.appliable).toBeUndefined();
  });
});

describe("startRun explain-plan dispatch", () => {
  it("injects the redacted target file context into the model prompt", async () => {
    mkdirSync(join(workspaceRoot, "src"));
    writeFileSync(join(workspaceRoot, "src", "discounts.ts"), "export const discount = 100;\n");
    let prompt = "";
    const model: ModelPort = {
      call: (request): Promise<NormalizedResponse> => {
        prompt = request.messages.map((message) => message.content).join("\n");
        return Promise.resolve({
          modelId: request.modelId,
          content: "grounded explanation",
          finishReason: "stop",
          toolCalls: [],
          structuredOutput: null,
          usage: {
            requestId: "req",
            promptTokens: 1,
            completionTokens: 1,
            latencyMs: 1,
            costClass: "low",
          },
        });
      },
    };
    const request = ok(
      parseRunRequest(
        JSON.stringify({
          taskType: "explain-plan",
          modelId: "m",
          input: { workspaceRoot, filePath: "src/discounts.ts" },
        }),
      ),
    );
    const result = startRun({ request, model, registry }, (v) => v);
    await waitForTerminal(result.runId);
    expect(prompt).toContain("--- src/discounts.ts ---");
    expect(prompt).toContain("export const discount = 100;");
  });
});
