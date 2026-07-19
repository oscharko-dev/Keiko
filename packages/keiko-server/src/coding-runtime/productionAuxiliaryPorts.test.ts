import { describe, expect, it } from "vitest";

import type { ModelPort } from "@oscharko-dev/keiko-harness";
import type { NormalizedResponse } from "@oscharko-dev/keiko-model-gateway";

import { createProductionAuxiliaryPorts } from "./productionAuxiliaryPorts.js";
import { createServerApprovedSkillCatalog } from "./skillCatalog.js";
import { createExplicitSkillInvocationTracker } from "./explicitSkillInvocation.js";

const AUTHORITY_EXPIRES_AT = "2026-07-20T01:00:00.000Z";

function response(): NormalizedResponse {
  return {
    modelId: "gpt-coding-safe",
    content: "Inspected",
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

function ports(
  modelId: string,
  observed: string[] = [],
): ReturnType<typeof createProductionAuxiliaryPorts> {
  const catalog = createServerApprovedSkillCatalog();
  return createProductionAuxiliaryPorts({
    authority: {
      state: () => ({
        schemaVersion: "1" as const,
        state: "running" as const,
        revision: 1,
        updatedAt: AUTHORITY_EXPIRES_AT,
        runId: "run-2387",
      }),
    },
    taskId: "task-2387",
    runId: "run-2387",
    workspaceId: () => "workspace-2387",
    workspaceRoot: "/workspace",
    modelId,
    authorityExpiresAt: AUTHORITY_EXPIRES_AT,
    catalog,
    explicitSkills: createExplicitSkillInvocationTracker(catalog),
    modelPortFactory: (requested): ModelPort | undefined => {
      observed.push(requested);
      return { call: (): Promise<NormalizedResponse> => Promise.resolve(response()) };
    },
    secureWorkspaceTextRead: {
      readText: () => Promise.resolve({ ok: true as const, text: "file text" }),
    },
    emit: () => undefined,
  });
}

describe("createProductionAuxiliaryPorts", () => {
  it("mounts the child-agent port when a provider model id is resolved", () => {
    expect(ports("gpt-coding-safe").childAgentAuthority).toBeDefined();
  });

  it("#2387: leaves the child-agent port unmounted when no coding-safe model resolved", () => {
    // An unmounted port makes the governed delegate answer "failed" for every child request. The
    // alternative — launching a child against a placeholder or a Keiko launch-profile identifier
    // such as "coding-safe-openai-compatible" — would fail on the child's first gateway call, on a
    // real installation only, because every test harness stubs the model port.
    const surface = ports("");

    expect(surface.childAgentAuthority).toBeUndefined();
    expect(surface.skillAuthority).toBeDefined();
  });

  it("always mounts the skill port, which needs no provider model", () => {
    expect(ports("").skillAuthority).toBeDefined();
  });
});
