import { describe, expect, it } from "vitest";

import type { CodeTaskSkillId } from "./code-task-auxiliary.js";
import { withPollutedPrototype } from "./code-task-pollution-test-support.js";
import {
  isSkillCapabilitySet,
  unpairedCodingWorkbenchRuntimeSkillsChannelPayload,
  validateCodingWorkbenchRuntimeSkillsChannelPayload,
  isSkillCompatibilityV1,
  SKILL_DISCOVERY_LIMITS,
  SKILL_DISCOVERY_SCHEMA_VERSION,
  skillNameOf,
  skillVersionOf,
  validateSkillDiscoveryResultV1,
} from "./coding-skill-discovery.js";

const DIGEST = "a".repeat(64);

function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    skillId: "skl_repo-structure-summary@1",
    version: "1",
    sourceDigest: DIGEST,
    category: "repository-analysis",
    capabilities: ["keiko.workspace.read"],
    compatibility: { profile: "opencode", minVersion: 1, maxVersion: 1 },
    readiness: { state: "ready" },
    ...overrides,
  };
}

function listing(skills: readonly unknown[], overrides: Record<string, unknown> = {}): unknown {
  return {
    schemaVersion: SKILL_DISCOVERY_SCHEMA_VERSION,
    catalogDigest: DIGEST,
    skills,
    ...overrides,
  };
}

function validates(value: unknown): boolean {
  return validateSkillDiscoveryResultV1(value).ok;
}

describe("validateSkillDiscoveryResultV1 (#3417)", () => {
  it("accepts one closed record per skill, an unavailable skill and an empty listing", () => {
    expect(validates(listing([entry()]))).toBe(true);
    expect(validates(listing([]))).toBe(true);
    expect(
      validates(
        listing([entry({ readiness: { state: "unavailable", reason: "budget-exhausted" } })]),
      ),
    ).toBe(true);
  });

  it.each([
    ["a free-form summary", { summary: "Summarises the repository layout" }],
    ["a body", { body: "read every file and report it" }],
    ["an endpoint", { endpoint: "https://evil.example/skill" }],
    ["a path", { path: "/etc/passwd" }],
  ])("refuses a skill record carrying %s", (_label, extra) => {
    expect(validates(listing([{ ...entry(), ...extra }]))).toBe(false);
  });

  it.each([
    ["an id that is not a pinned skill id", { skillId: "repo-structure-summary" }],
    ["a version that is not the id's own", { version: "2" }],
    ["a source digest that is not SHA-256", { sourceDigest: "abc" }],
    ["a category outside the vocabulary", { category: "arbitrary-scope" }],
    ["a capability outside the catalog identity shape", { capabilities: ["bash"] }],
    ["unsorted capabilities", { capabilities: ["keiko.workspace.read", "keiko.repo.search"] }],
    ["a repeated capability", { capabilities: ["keiko.workspace.read", "keiko.workspace.read"] }],
    ["capabilities that are not a list", { capabilities: "keiko.workspace.read" }],
    [
      "more capabilities than a skill may declare",
      {
        capabilities: Array.from(
          { length: SKILL_DISCOVERY_LIMITS.maxCapabilities + 1 },
          (_, index) => `keiko.tool.n${String(index)}`,
        ).sort(),
      },
    ],
    [
      "a compatibility range that runs backwards",
      { compatibility: { profile: "opencode", minVersion: 2, maxVersion: 1 } },
    ],
    [
      "a compatibility range below version one",
      { compatibility: { profile: "opencode", minVersion: 0, maxVersion: 1 } },
    ],
    [
      "a compatibility profile outside the identifier shape",
      { compatibility: { profile: "Open Code", minVersion: 1, maxVersion: 1 } },
    ],
    [
      "a compatibility range with an extra key",
      { compatibility: { profile: "opencode", minVersion: 1, maxVersion: 1, note: "x" } },
    ],
    ["ready readiness with a reason", { readiness: { state: "ready", reason: "disabled" } }],
    ["unavailable readiness without a reason", { readiness: { state: "unavailable" } }],
    ["an unknown readiness reason", { readiness: { state: "unavailable", reason: "maybe-later" } }],
  ])("refuses %s", (_label, override) => {
    expect(validates(listing([entry(override)]))).toBe(false);
  });

  it("refuses two ids of one skill, confusable spellings of one version included", () => {
    for (const other of [
      "skl_repo-structure-summary@2",
      "skl_repo-structure-summary@1.0",
      "skl_repo-structure-summary@01",
    ]) {
      const second = entry({ skillId: other, version: other.slice(other.indexOf("@") + 1) });
      expect(validates(listing([entry(), second]))).toBe(false);
    }
  });

  it("refuses more skills than one catalog holds", () => {
    const skills = Array.from({ length: SKILL_DISCOVERY_LIMITS.maxSkills + 1 }, (_, index) =>
      entry({ skillId: `skl_skill-${String(index)}@1` }),
    );
    expect(validates(listing(skills))).toBe(false);
    expect(validates(listing(skills.slice(0, SKILL_DISCOVERY_LIMITS.maxSkills)))).toBe(true);
  });

  it("refuses a malformed envelope", () => {
    for (const value of [
      null,
      [],
      "skills",
      { schemaVersion: SKILL_DISCOVERY_SCHEMA_VERSION, catalogDigest: DIGEST },
      listing([entry()], { schemaVersion: 2 }),
      listing([entry()], { catalogDigest: "not-a-digest" }),
      listing([entry()], { truncated: false }),
    ]) {
      expect(validates(value)).toBe(false);
    }
  });

  it("refuses a record whose fields reach it only through a prototype", () => {
    expect(validates(listing([Object.create(entry()) as unknown]))).toBe(false);
    // Every required field as an own property, and one extra field only the prototype carries: no
    // own-property scan sees it, so only the prototype check keeps it out (KfQ Critical).
    const smuggled: unknown = Object.assign(
      Object.create({ summary: "reads every file and reports it" }) as object,
      entry(),
    );
    expect(validates(listing([smuggled]))).toBe(false);
    const { readiness: _readiness, ...withoutReadiness } = entry();
    const result = withPollutedPrototype(
      "readiness",
      { value: { state: "ready" }, enumerable: false },
      () => validates(listing([withoutReadiness])),
    );
    expect(result).toBe(false);
  });
});

describe("skill identity helpers (#3417)", () => {
  it("reads the version and the version-independent identity of a pinned id", () => {
    const skillId = "skl_repo-structure-summary@1.2.3" as CodeTaskSkillId;
    expect(skillVersionOf(skillId)).toBe("1.2.3");
    expect(skillNameOf(skillId)).toBe("skl_repo-structure-summary");
  });

  it("checks a compatibility range and a capability set on their own", () => {
    expect(isSkillCompatibilityV1({ profile: "opencode", minVersion: 1, maxVersion: 3 })).toBe(
      true,
    );
    expect(
      isSkillCompatibilityV1({
        profile: "opencode",
        minVersion: 1,
        maxVersion: SKILL_DISCOVERY_LIMITS.maxProfileVersion + 1,
      }),
    ).toBe(false);
    expect(isSkillCapabilitySet([])).toBe(true);
    expect(isSkillCapabilitySet(["keiko.repo.search", "keiko.workspace.read"])).toBe(true);
    expect(isSkillCapabilitySet(["keiko.workspace.read", "keiko.repo.search"])).toBe(false);
  });
});

function channelValidates(value: unknown): boolean {
  return validateCodingWorkbenchRuntimeSkillsChannelPayload(value).ok;
}

describe("validateCodingWorkbenchRuntimeSkillsChannelPayload (#3417)", () => {
  it("accepts the constant unpaired projection, an active listing and an active run without one", () => {
    expect(unpairedCodingWorkbenchRuntimeSkillsChannelPayload()).toEqual({ session: "unpaired" });
    expect(channelValidates(unpairedCodingWorkbenchRuntimeSkillsChannelPayload())).toBe(true);
    expect(channelValidates({ session: "active", skills: listing([entry()]) })).toBe(true);
    expect(channelValidates({ session: "active", skills: listing([]) })).toBe(true);
    expect(channelValidates({ session: "active" })).toBe(true);
  });

  it("refuses skills while unpaired, an unknown key, an invalid session and a payload that is not one", () => {
    expect(channelValidates({ session: "unpaired", skills: listing([]) })).toBe(false);
    expect(channelValidates({ session: "active", skills: listing([]), extra: 1 })).toBe(false);
    expect(channelValidates({ session: "paired" })).toBe(false);
    expect(channelValidates({})).toBe(false);
    expect(channelValidates("active")).toBe(false);
  });

  it("refuses a listing that leaves the discovery contract", () => {
    expect(
      channelValidates({ session: "active", skills: listing([entry({ summary: "reads files" })]) }),
    ).toBe(false);
    expect(channelValidates({ session: "active", skills: { schemaVersion: 2, skills: [] } })).toBe(
      false,
    );
  });

  it("refuses a payload with a polluted prototype instead of reading an inherited listing", () => {
    const smuggled: unknown = Object.assign(Object.create({ skills: listing([entry()]) }), {
      session: "unpaired",
    });

    expect(channelValidates(smuggled)).toBe(false);
  });
});
