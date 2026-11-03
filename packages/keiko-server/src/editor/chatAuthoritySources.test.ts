import { describe, expect, it } from "vitest";
import type {
  ChatToolAuthorityEnvelope,
  EditorAgentGovernedAuthorityReference,
} from "@oscharko-dev/keiko-contracts";
import {
  EditorAgentAuthorityRegistry,
  EDITOR_AGENT_AUTHORITY_MAX_RECORDS,
} from "./agentAuthorityRegistry.js";
import {
  CHAT_AUTHORITY_TEST_NOW as NOW,
  chatAuthorityFixture,
} from "./chatAuthority.test-support.js";

function sources(): readonly ChatToolAuthorityEnvelope[] {
  const jira = chatAuthorityFixture();
  return [
    jira,
    {
      ...jira,
      subject: {
        kind: "configured-mcp",
        actorDigest: jira.subject.actorDigest,
        chatId: jira.subject.chatId,
        configurationDigest: "d".repeat(64),
      },
      connectorScopes: ["mcp.tools"],
    },
  ];
}
function register(
  registry: EditorAgentAuthorityRegistry,
  values = sources(),
): readonly EditorAgentGovernedAuthorityReference[] {
  const result = registry.registerChatSources(values, "autonomous-delivery", NOW);
  if (!result.ok) throw new Error("Expected atomic source registration");
  return result.authorityRefs;
}

describe("one accepted Chat turn with both source authorities", () => {
  it("shares cumulative tool and prompt budgets, including duplicate registration", () => {
    const registry = new EditorAgentAuthorityRegistry();
    const values = sources();
    const refs = register(registry, values);
    const reserve = (index: number, toolCalls: number, promptTokens: number): boolean => {
      const ref = refs.at(index);
      const value = values.at(index);
      if (ref === undefined || value === undefined) throw new Error("Missing source");
      return registry.reserveForChat(
        ref,
        value.subject,
        "autonomous-delivery",
        { toolCalls, promptTokens, patchBytes: 0 },
        NOW,
      ).ok;
    };
    expect(reserve(0, 19, 9_999)).toBe(true);
    expect(register(registry, values)).toEqual(refs);
    expect(reserve(1, 2, 0)).toBe(false);
    expect(reserve(1, 1, 1)).toBe(true);
    expect(reserve(0, 1, 0)).toBe(false);
    expect(reserve(1, 0, 1)).toBe(false);
  });

  it.each([
    { runId: "other-turn" },
    { requestedMode: "governed-assist", effectiveMode: "governed-assist" },
    {
      budget: { maxRuntimeMs: 60_000, maxToolCalls: 21, maxPromptTokens: 10_000, maxPatchBytes: 0 },
    },
    { expiresAt: "2026-07-09T14:00:00.000Z" },
  ])("refuses mismatching turn facts atomically: %j", (patch) => {
    const registry = new EditorAgentAuthorityRegistry();
    const [jira, mcp] = sources();
    expect(
      registry.registerChatSources([jira, { ...mcp, ...patch }], "autonomous-delivery", NOW).ok,
    ).toBe(false);
    expect(registry.registerChat(jira, "autonomous-delivery", NOW).ok).toBe(true);
  });

  it("refuses duplicate source kinds and distinct actors without retaining either source", () => {
    const registry = new EditorAgentAuthorityRegistry();
    const [jira, mcp] = sources();
    if (mcp === undefined) throw new Error("Missing MCP source");
    expect(registry.registerChatSources([jira, jira], "autonomous-delivery", NOW).ok).toBe(false);
    expect(
      registry.registerChatSources(
        [jira, { ...mcp, subject: { ...mcp.subject, actorDigest: "e".repeat(64) } }],
        "autonomous-delivery",
        NOW,
      ).ok,
    ).toBe(false);
    expect(registry.registerChat(jira, "autonomous-delivery", NOW).ok).toBe(true);
  });

  it("cannot widen or shrink an already accepted turn's source set", () => {
    const registry = new EditorAgentAuthorityRegistry();
    const values = sources();
    expect(registry.registerChat(values[0], "autonomous-delivery", NOW).ok).toBe(true);
    expect(registry.registerChatSources(values, "autonomous-delivery", NOW).ok).toBe(false);
    registry.reset();
    register(registry, values);
    expect(registry.registerChat(values[0], "autonomous-delivery", NOW).ok).toBe(false);
    expect(registry.registerChatSources([values[1]], "autonomous-delivery", NOW).ok).toBe(false);
  });

  it("refuses partial registration at the shared capacity boundary", () => {
    const registry = new EditorAgentAuthorityRegistry();
    for (let index = 0; index < EDITOR_AGENT_AUTHORITY_MAX_RECORDS - 1; index++) {
      expect(
        registry.registerChat(
          chatAuthorityFixture({ runId: `filled-${String(index)}` }),
          "autonomous-delivery",
          NOW,
        ).ok,
      ).toBe(true);
    }
    expect(registry.registerChatSources(sources(), "autonomous-delivery", NOW).ok).toBe(false);
    expect(registry.registerChat(sources()[0], "autonomous-delivery", NOW).ok).toBe(true);
  });

  it("keeps revocation terminal across every source in the accepted group", () => {
    const registry = new EditorAgentAuthorityRegistry();
    const values = sources();
    const refs = register(registry, values);
    const first = refs[0];
    if (first === undefined) throw new Error("Missing first authority");
    registry.revoke(first);
    expect(registry.registerChatSources(values, "autonomous-delivery", NOW)).toEqual({
      ok: false,
      reason: "revoked",
    });
    for (const [index, reference] of refs.entries()) {
      const value = values[index];
      if (value === undefined) throw new Error("Missing source");
      expect(registry.resolveChat(reference, value.subject, "autonomous-delivery", NOW)).toEqual({
        ok: false,
        reason: "revoked",
      });
    }
  });
});
