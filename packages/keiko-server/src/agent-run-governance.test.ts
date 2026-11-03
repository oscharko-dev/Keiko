import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { EDITOR_AGENT_CHANGESET_MAX_PATCH_BYTES } from "@oscharko-dev/keiko-contracts/runtime/editor-agent";
import type { ModelPort } from "@oscharko-dev/keiko-harness";
import type { GatewayStreamChunk, NormalizedResponse } from "@oscharko-dev/keiko-model-gateway";
import type { SpawnFn } from "@oscharko-dev/keiko-tools";
import type { AppSession } from "./coding-app-session/sessionRegistry.js";
import { editorAgentAuthorityRegistry } from "./editor/agentAuthorityRegistry.js";
import {
  authorizeAgentRunMutation,
  createAgentRunBudgetedModelPort,
  createAgentRunBudgetedSpawn,
  createAgentRunGovernance,
  reserveAgentRunBudget,
  revokeAgentRunGovernance,
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

  // #2906 round-3 review (KEIKO-0532 sibling finding): createAgentRunGovernance,
  // authorizeAgentRunMutation, and reserveAgentRunBudget each resolve the same registry and
  // previously collapsed a revoked authority into the same generic "authority-invalid" reason as a
  // genuinely malformed envelope. Pinned across all three producers so a regression back to
  // collapsing revocation is caught regardless of which governed path exercises it first.
  it("maps a revoked authority to authority-revoked across creation, mutation, and budget", () => {
    const createInput = {
      runId: randomUUID(),
      workflow: "unit-tests" as const,
      workspaceRoot: "/repo",
      modelId: "model-1",
      requestedMode: "supervised-coding" as const,
      deploymentCeiling: "autonomous-delivery" as const,
      session: SESSION,
      nowIso: NOW,
    };
    const first = createAgentRunGovernance(createInput);
    if (!first.ok) throw new Error(first.reason);
    const binding = first.binding;
    revokeAgentRunGovernance(binding);

    expect(
      authorizeAgentRunMutation({ binding, workspaceRoot: "/repo", session: SESSION, nowIso: NOW }),
    ).toEqual({ ok: false, reason: "authority-revoked" });
    expect(
      reserveAgentRunBudget({
        binding,
        workspaceRoot: "/repo",
        usage: { toolCalls: 1, patchBytes: 0, promptTokens: 0 },
        nowIso: NOW,
      }),
    ).toEqual({ ok: false, reason: "authority-revoked" });
    // Re-registering the identical envelope after revocation hits the registry's
    // existing-record-is-revoked branch, which createAgentRunGovernance must also surface
    // distinctly rather than folding into "authority-invalid".
    expect(createAgentRunGovernance(createInput)).toEqual({
      ok: false,
      reason: "authority-revoked",
    });
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

  it("preserves lazy asynchronous delegation, consumer errors and iterator cleanup", async () => {
    const first: GatewayStreamChunk = { type: "delta", token: "first" };
    const recovered: GatewayStreamChunk = { type: "delta", token: "recovered" };
    const next = vi.fn().mockResolvedValue({ done: false, value: first });
    const thrown = vi.fn().mockResolvedValue({ done: false, value: recovered });
    const returned = vi.fn().mockResolvedValue({ done: true, value: undefined });
    const upstream: AsyncIterator<GatewayStreamChunk> = { next, throw: thrown, return: returned };
    const callStream = vi.fn((): AsyncIterable<GatewayStreamChunk> => ({
      [Symbol.asyncIterator]: (): AsyncIterator<GatewayStreamChunk> => upstream,
    }));
    const guarded = createAgentRunBudgetedModelPort({
      binding: mint("supervised-coding"),
      workspaceRoot: "/repo",
      model: { call: (): Promise<NormalizedResponse> => Promise.resolve(response()), callStream },
      nowIso: () => NOW,
    });
    const iterator = guarded
      .callStream?.({ modelId: "model-1", messages: [] }, new AbortController().signal)
      [Symbol.asyncIterator]();
    expect(callStream).not.toHaveBeenCalled();
    await expect(iterator?.next()).resolves.toEqual({ done: false, value: first });
    expect(callStream).toHaveBeenCalledOnce();
    const consumerError = new Error("consumer-recovery");
    await expect(iterator?.throw?.(consumerError)).resolves.toEqual({
      done: false,
      value: recovered,
    });
    expect(thrown).toHaveBeenCalledWith(consumerError);
    await expect(iterator?.return?.()).resolves.toEqual({ done: true, value: undefined });
    expect(returned).toHaveBeenCalledOnce();
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

  // Owner decision 2026-10-28: no coding path refuses a patch at 64 KiB. An agent run's apply
  // reserves one changeset's worth of patch bytes, so its envelope budget is the changeset cap.
  it("carries a patch budget of exactly one changeset", () => {
    const binding = mint("supervised-coding");
    const reserve = (patchBytes: number): ReturnType<typeof reserveAgentRunBudget> =>
      reserveAgentRunBudget({
        binding,
        workspaceRoot: "/repo",
        usage: { toolCalls: 0, patchBytes, promptTokens: 0 },
        nowIso: NOW,
      });

    expect(reserve(EDITOR_AGENT_CHANGESET_MAX_PATCH_BYTES + 1)).toEqual({
      ok: false,
      reason: "budget-exceeded",
    });
    expect(reserve(EDITOR_AGENT_CHANGESET_MAX_PATCH_BYTES)).toEqual({ ok: true });
    expect(reserve(1)).toEqual({ ok: false, reason: "budget-exceeded" });
  });
});
