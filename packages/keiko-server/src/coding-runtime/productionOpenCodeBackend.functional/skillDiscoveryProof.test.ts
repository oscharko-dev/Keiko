import { describe, expect, it } from "vitest";
import { scriptedResponse, type ScriptState } from "./_support.js";
import {
  FUNCTIONAL_REPOSITORY_SKILL_NAME,
  SKILL_DISCOVERY_PROOF_CALL_ID,
  functionalRepositorySkillText,
  skillInvocationHandoff,
  type SkillDiscoveryConsumptionProof,
} from "./skillDiscoveryProof.js";

// The pinned 2.1.4 system prompt lists the skills it can load; this is its observed shape.
function listing(...skills: readonly (readonly [id: string, name: string])[]): string {
  const entries = skills.map(
    ([id, name]) =>
      `  <skill>\n    <id>${id}</id>\n    <name>${name}</name>\n    <description>d</description>\n  </skill>`,
  );
  return `Skills provide specialized instructions.\n<available_skills>\n${entries.join("\n")}\n</available_skills>\n`;
}

function transcript(system: string): string {
  return JSON.stringify([{ role: "system", content: system }]);
}

const LISTED = listing(
  ["opencode", "OpenCode"],
  ["listed-by-runtime", FUNCTIONAL_REPOSITORY_SKILL_NAME],
);

describe("real-binary skill discovery model response boundary (#3417, #3897)", () => {
  it("invokes the skill the runtime's own listing names, after its search-derived read", () => {
    const script = {
      mode: "productive-search",
      proveSkillDiscovery: true,
      calls: 2,
      old: "export const marker = true;\n",
      next: "export const marker = false;\n",
    } as ScriptState;
    expect(scriptedResponse(script, transcript(LISTED)).toolCalls[0]).toMatchObject({
      id: SKILL_DISCOVERY_PROOF_CALL_ID,
      name: "skill",
      arguments: { id: "listed-by-runtime" },
    });
    // The ordinary productive journey continues afterwards, starting with its question.
    expect(scriptedResponse(script).toolCalls[0]?.name).toBe("question");
  });

  it("keeps the productive search journey unchanged without the skill proof", () => {
    const script = {
      mode: "productive-search",
      calls: 2,
      old: "export const marker = true;\n",
      next: "export const marker = false;\n",
    } as ScriptState;
    expect(scriptedResponse(script).toolCalls[0]?.name).toBe("question");
  });

  it("derives the invocation from the runtime listing and records a body-free proof", () => {
    const evidence: SkillDiscoveryConsumptionProof[] = [];
    expect(
      skillInvocationHandoff(transcript(LISTED), FUNCTIONAL_REPOSITORY_SKILL_NAME, (proof) => {
        evidence.push(proof);
      }),
    ).toEqual({ id: "listed-by-runtime" });
    expect(evidence).toEqual([
      expect.objectContaining({
        toolCallId: SKILL_DISCOVERY_PROOF_CALL_ID,
        listedCount: 2,
        invokedSkillDerivedFromResult: true,
      }),
    ]);
    expect(evidence.at(0)?.skillIdDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(evidence.at(0)?.listingDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(evidence)).not.toContain("listed-by-runtime");
  });

  it.each([
    ["a listing that does not carry the admitted skill", listing(["opencode", "OpenCode"])],
    ["an empty listing", listing()],
    ["a prompt without a listing", "No skills here."],
  ])("refuses %s instead of invoking a canned skill", (_name, system) => {
    expect(() =>
      skillInvocationHandoff(transcript(system), FUNCTIONAL_REPOSITORY_SKILL_NAME, undefined),
    ).toThrow(TypeError);
  });

  it("carries a fixture skill the repository-item admission accepts", () => {
    const text = functionalRepositorySkillText();
    expect(text).toContain(`name: ${FUNCTIONAL_REPOSITORY_SKILL_NAME}`);
    expect(text).toMatch(/^---\nname: [a-z-]+\ndescription: .+\n---\n.+\n$/u);
  });
});
