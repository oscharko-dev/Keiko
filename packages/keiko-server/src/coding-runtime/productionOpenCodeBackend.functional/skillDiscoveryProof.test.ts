import { describe, expect, it } from "vitest";
import { scriptedResponse, type ScriptState } from "./_support.js";
import {
  SKILL_DISCOVERY_PROOF_CALL_ID,
  skillInvocationHandoff,
  type SkillDiscoveryConsumptionProof,
} from "./skillDiscoveryProof.js";

function transcript(skills: unknown, callId = SKILL_DISCOVERY_PROOF_CALL_ID): string {
  return JSON.stringify([
    { role: "tool", toolCallId: callId, content: JSON.stringify({ status: "completed", skills }) },
  ]);
}

const LISTING = {
  schemaVersion: 1,
  catalogDigest: "c".repeat(64),
  skills: [
    {
      skillId: "skl_listed-by-runtime@1",
      version: "1",
      sourceDigest: "d".repeat(64),
      category: "repository-analysis",
      capabilities: ["keiko.workspace.read"],
      compatibility: { profile: "opencode", minVersion: 1, maxVersion: 1 },
      readiness: { state: "ready" },
    },
  ],
};

describe("real-binary skill discovery model response boundary (#3417)", () => {
  it("discovers the approved skills before it invokes one", () => {
    const script = {
      mode: "productive-search",
      proveSkillDiscovery: true,
      calls: 3,
      old: "export const marker = true;\n",
      next: "export const marker = false;\n",
    } as ScriptState;
    expect(scriptedResponse(script).toolCalls[0]).toMatchObject({
      id: SKILL_DISCOVERY_PROOF_CALL_ID,
      name: "keiko_skill_discover",
      arguments: {},
    });
    expect(scriptedResponse(script, transcript(LISTING)).toolCalls[0]).toMatchObject({
      name: "keiko_skill",
      arguments: { skillId: "skl_listed-by-runtime@1" },
    });
    // The ordinary productive journey continues afterwards, starting with its question.
    expect(scriptedResponse(script).toolCalls[0]?.name).toBe("question");
  });

  it("keeps the productive search journey unchanged without the skill proof", () => {
    const script = {
      mode: "productive-search",
      calls: 3,
      old: "export const marker = true;\n",
      next: "export const marker = false;\n",
    } as ScriptState;
    expect(scriptedResponse(script).toolCalls[0]?.name).toBe("question");
  });

  it("derives the invocation from the correlated result and records a body-free proof", () => {
    const evidence: SkillDiscoveryConsumptionProof[] = [];
    expect(
      skillInvocationHandoff(transcript(LISTING), (proof) => {
        evidence.push(proof);
      }),
    ).toEqual({ skillId: "skl_listed-by-runtime@1" });
    expect(evidence).toEqual([
      expect.objectContaining({
        toolCallId: SKILL_DISCOVERY_PROOF_CALL_ID,
        listedCount: 1,
        catalogDigest: "c".repeat(64),
        invokedSkillDerivedFromResult: true,
      }),
    ]);
    expect(evidence.at(0)?.skillIdDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(evidence)).not.toContain("listed-by-runtime");
  });

  it.each([
    { ...LISTING, skills: [] },
    { ...LISTING, skills: [{ ...LISTING.skills[0], readiness: { state: "unavailable" } }] },
    { ...LISTING, catalogDigest: undefined },
    "not-a-listing",
  ])("refuses an unusable discovery result instead of invoking a canned skill", (skills) => {
    expect(() => skillInvocationHandoff(transcript(skills), undefined)).toThrow(TypeError);
  });

  it("rejects a discovery result without its original tool-call identity", () => {
    expect(() => skillInvocationHandoff(transcript(LISTING, "unrelated-call"), undefined)).toThrow(
      TypeError,
    );
  });
});
