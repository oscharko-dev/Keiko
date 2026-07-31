import { beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import type { ModelPort } from "@oscharko-dev/keiko-harness";
import type { NormalizedResponse } from "@oscharko-dev/keiko-model-gateway";
import type { SpawnFn } from "@oscharko-dev/keiko-tools";
import type { AppSession } from "./coding-app-session/sessionRegistry.js";
import { editorAgentAuthorityRegistry } from "./editor/agentAuthorityRegistry.js";
import {
  authorizeAgentRunMutation,
  createAgentRunBudgetedModelPort,
  createAgentRunBudgetedSpawn,
  createAgentRunGovernance,
  reserveAgentRunBudget,
  type AgentRunGovernanceBinding,
} from "./agent-run-governance.js";

const NOW = "2026-07-31T08:00:00.000Z";
const SESSION: AppSession = {
  sessionId: "sess_0123456789abcdef01234567",
  principalLabel: "local-user",
  issuedAtMs: Date.parse(NOW),
  lastSeenAtMs: Date.parse(NOW),
  rotationCount: 0,
};

function mint(
  requestedMode: AgentRunGovernanceBinding["requestedMode"],
  deploymentCeiling: AgentRunGovernanceBinding["deploymentCeiling"] = "autonomous-delivery",
  workflow: "unit-tests" | "bug-investigation" = "unit-tests",
): AgentRunGovernanceBinding {
  const result = createAgentRunGovernance({
    runId: randomUUID(),
    workflow,
    workspaceRoot: "/repo",
    modelId: "model-1",
    requestedMode,
    deploymentCeiling,
    session: SESSION,
    nowIso: NOW,
  });
  if (!result.ok) throw new Error(result.reason);
  return result.binding;
}

function response(): NormalizedResponse {
  return {
    modelId: "model-1",
    content: "ok",
    finishReason: "stop",
    toolCalls: [],
    structuredOutput: null,
    usage: {
      requestId: "request-1",
      promptTokens: 1,
      completionTokens: 1,
      latencyMs: 1,
      costClass: "low",
    },
  };
}

describe("agent-run governance", () => {
  beforeEach(() => {
    editorAgentAuthorityRegistry.reset();
  });

  it("mints one existing Authority Envelope and clamps the effective mode monotonically", () => {
    const binding = mint("autonomous-delivery", "supervised-coding");

    expect(binding).toMatchObject({
      requestedMode: "autonomous-delivery",
      deploymentCeiling: "supervised-coding",
      effectiveMode: "supervised-coding",
      sessionId: SESSION.sessionId,
      sessionRotationCount: 0,
      connectorExecution: "unavailable",
      deliveryExecution: "unavailable",
    });
    expect(
      editorAgentAuthorityRegistry.resolve(binding.authorityRef, "/repo", "supervised-coding", NOW)
        .ok,
    ).toBe(true);
  });

  it.each([
    ["governed-assist", "approval-required"],
    ["supervised-coding", "allowed"],
    ["autonomous-delivery", "allowed"],
  ] as const)("maps %s through the shared workspace policy as %s", (mode, effect) => {
    const binding = mint(mode);
    expect(
      authorizeAgentRunMutation({
        binding,
        workspaceRoot: "/repo",
        session: SESSION,
        nowIso: NOW,
      }),
    ).toEqual({ ok: true, effect });
  });

  it("keeps high-risk bug-fix mutation approval-required in supervised workspace mode", () => {
    const binding = mint("supervised-coding", "autonomous-delivery", "bug-investigation");

    expect(
      authorizeAgentRunMutation({
        binding,
        workspaceRoot: "/repo",
        session: SESSION,
        nowIso: NOW,
      }),
    ).toEqual({ ok: true, effect: "approval-required" });
  });

  it("fails closed when the paired session changes or the Authority Envelope expires", () => {
    const binding = mint("supervised-coding");
    expect(
      authorizeAgentRunMutation({
        binding,
        workspaceRoot: "/repo",
        session: { ...SESSION, rotationCount: 1 },
        nowIso: NOW,
      }),
    ).toEqual({ ok: false, reason: "session-invalid" });
    expect(
      authorizeAgentRunMutation({
        binding,
        workspaceRoot: "/repo",
        session: SESSION,
        nowIso: "2026-07-31T08:31:00.001Z",
      }),
    ).toEqual({ ok: false, reason: "authority-expired" });
  });

  it("atomically exhausts prompt budget before model dispatch with a body-free failure", async () => {
    const binding = mint("supervised-coding");
    expect(
      reserveAgentRunBudget({
        binding,
        workspaceRoot: "/repo",
        usage: { toolCalls: 0, patchBytes: 0, promptTokens: 128_000 },
        nowIso: NOW,
      }),
    ).toEqual({ ok: true });
    let modelCalls = 0;
    const model: ModelPort = {
      call: (): Promise<NormalizedResponse> => {
        modelCalls += 1;
        return Promise.resolve(response());
      },
    };
    const guarded = createAgentRunBudgetedModelPort({
      binding,
      workspaceRoot: "/repo",
      model,
      nowIso: () => NOW,
    });

    let error: unknown;
    try {
      await guarded.call(
        { modelId: "model-1", messages: [{ role: "user", content: "secret-prompt-marker" }] },
        new AbortController().signal,
      );
    } catch (caught) {
      error = caught;
    }

    expect(modelCalls).toBe(0);
    expect(error).toMatchObject({ name: "AgentRunBudgetExhaustedError" });
    expect(String(error)).not.toContain("secret-prompt-marker");
  });

  it("charges each tool dispatch and makes the exhausted attempt a zero-call denial", () => {
    const binding = mint("supervised-coding");
    let toolCalls = 0;
    const spawn: SpawnFn = (): ChildProcess => {
      toolCalls += 1;
      return new EventEmitter() as ChildProcess;
    };
    const guarded = createAgentRunBudgetedSpawn({
      binding,
      workspaceRoot: "/repo",
      spawn,
      nowIso: () => NOW,
    });
    const options = { cwd: "/repo", env: {}, shell: false as const, detached: false };

    for (let index = 0; index < 4; index += 1) guarded("node", [], options);
    expect(() => guarded("node", [], options)).toThrow("Agent run budget exhausted.");
    expect(toolCalls).toBe(4);
  });
});
