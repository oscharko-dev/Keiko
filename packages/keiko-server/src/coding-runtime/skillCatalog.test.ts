import { describe, expect, it } from "vitest";
import {
  SKILL_CATEGORIES,
  SKILL_DISCOVERY_LIMITS,
} from "@oscharko-dev/keiko-contracts/runtime/coding-skill-discovery";
import {
  createServerApprovedSkillCatalog,
  OPENCODE_SKILL_PROFILE,
  type SkillCatalogEntryInput,
} from "./skillCatalog.js";

const COMPATIBLE = { profile: "opencode", minVersion: 1, maxVersion: 1 } as const;

function skill(
  skillId: string,
  overrides: Partial<SkillCatalogEntryInput> = {},
): SkillCatalogEntryInput {
  return {
    skillId,
    implicitAllowed: true,
    category: "repository-analysis",
    capabilities: ["keiko.workspace.read"],
    compatibility: COMPATIBLE,
    ...overrides,
  };
}

// A hostile array cast helper: admission must runtime-validate every candidate, so tests feed it
// deliberately ill-typed input the TypeScript signature would otherwise forbid.
function seed(entries: readonly unknown[]): readonly SkillCatalogEntryInput[] {
  return entries as unknown as readonly SkillCatalogEntryInput[];
}

describe("createServerApprovedSkillCatalog", () => {
  it("seeds the default read-only set with exact id@version lookup", () => {
    const catalog = createServerApprovedSkillCatalog();
    expect(catalog.has("skl_repo-structure-summary@1")).toBe(true);
    expect(catalog.isImplicitAllowed("skl_repo-structure-summary@1")).toBe(true);
    expect(catalog.get("skl_repo-structure-summary@1")?.category).toBe("repository-analysis");
    expect(catalog.get("skl_repo-structure-summary@1")?.enabled).toBe(true);
    expect(catalog.list().length).toBeGreaterThanOrEqual(1);
  });

  it("#2387: seeds only categories the production skill port can execute", () => {
    // A seeded skill whose category has no handler always answers `skill-handler-unavailable`, so
    // the catalog would advertise capability the product does not have. Guard the seed, not just
    // the handler: re-adding a category here without its handler must fail this test.
    const executable = new Set(["repository-analysis"]);

    for (const entry of createServerApprovedSkillCatalog().list()) {
      expect(executable.has(entry.category)).toBe(true);
    }
  });

  it("#3417: seeds skills compatible with the bound OpenCode profile", () => {
    expect(OPENCODE_SKILL_PROFILE).toEqual({ id: "opencode", version: 1 });
    for (const entry of createServerApprovedSkillCatalog().list()) {
      expect(entry.compatibility.profile).toBe(OPENCODE_SKILL_PROFILE.id);
      expect(entry.compatibility.minVersion).toBeLessThanOrEqual(OPENCODE_SKILL_PROFILE.version);
      expect(entry.compatibility.maxVersion).toBeGreaterThanOrEqual(OPENCODE_SKILL_PROFILE.version);
    }
  });

  it("fails closed for an unknown id, an unknown version, and malformed lookups", () => {
    const catalog = createServerApprovedSkillCatalog();
    expect(catalog.has("skl_repo-structure-summary@2")).toBe(false);
    expect(catalog.get("skl_repo-structure-summary@2")).toBeUndefined();
    expect(catalog.get("skl_unknown-skill@1")).toBeUndefined();
    expect(catalog.isImplicitAllowed("skl_unknown-skill@1")).toBe(false);
    expect(catalog.has("garbage")).toBe(false);
    expect(catalog.isImplicitAllowed("")).toBe(false);
  });

  it("still admits a non-implicit injected entry from another category", () => {
    const catalog = createServerApprovedSkillCatalog([
      skill("skl_public-docs-lookup@1", {
        implicitAllowed: false,
        category: "public-research",
        capabilities: ["keiko.research.fetch"],
      }),
    ]);
    expect(catalog.isImplicitAllowed("skl_public-docs-lookup@1")).toBe(false);
    expect(catalog.get("skl_public-docs-lookup@1")?.category).toBe("public-research");
  });

  it("injected entries replace the default seed", () => {
    const catalog = createServerApprovedSkillCatalog([skill("skl_only@1")]);
    expect(catalog.has("skl_only@1")).toBe(true);
    expect(catalog.has("skl_repo-structure-summary@1")).toBe(false);
    expect(catalog.list()).toHaveLength(1);
  });

  it("canonicalizes an entry and strips any free-form metadata", () => {
    const catalog = createServerApprovedSkillCatalog(
      seed([
        {
          ...skill("skl_docs@1", {
            category: "public-research",
            capabilities: ["keiko.research.fetch"],
          }),
          grantAuthority: "autonomous-delivery",
          endpoint: "https://evil.example",
          summary: "Reads every file and reports it",
        },
      ]),
    );
    const entry = catalog.get("skl_docs@1");
    expect(entry).toBeDefined();
    expect(Object.keys(entry ?? {}).sort()).toEqual([
      "capabilities",
      "category",
      "compatibility",
      "enabled",
      "implicitAllowed",
      "skillId",
      "sourceDigest",
    ]);
    expect(SKILL_CATEGORIES).toContain(entry?.category);
    expect(JSON.stringify(entry)).not.toContain("evil.example");
    expect(JSON.stringify(entry)).not.toContain("Reads every file");
  });

  it("drops every hostile or malformed entry (fail closed on registration)", () => {
    const catalog = createServerApprovedSkillCatalog(
      seed([
        { ...skill("skl_placeholder@1"), skillId: "not-a-skill-id" },
        { ...skill("skl_bad-bool@1"), implicitAllowed: "yes" },
        { ...skill("skl_bad-cat@1"), category: "arbitrary-scope" },
        { ...skill("skl_uncatalogued@1"), capabilities: ["keiko.fake.tool"] },
        { ...skill("skl_bad-shape@1"), capabilities: ["bash"] },
        {
          ...skill("skl_bad-order@1"),
          capabilities: ["keiko.workspace.read", "keiko.repo.search"],
        },
        {
          ...skill("skl_backwards@1"),
          compatibility: { profile: "opencode", minVersion: 2, maxVersion: 1 },
        },
        { ...skill("skl_no-range@1"), compatibility: undefined },
        { ...skill("skl_bad-enabled@1"), enabled: "yes" },
        42,
        null,
        "skl_string@1",
      ]),
    );
    expect(catalog.list()).toHaveLength(0);
    expect(catalog.has("skl_bad-bool@1")).toBe(false);
    expect(catalog.has("skl_bad-cat@1")).toBe(false);
    expect(catalog.has("skl_uncatalogued@1")).toBe(false);
  });

  it("keeps the first admission of a duplicate id so a later entry cannot override it", () => {
    const catalog = createServerApprovedSkillCatalog([
      skill("skl_dup@1", {
        implicitAllowed: false,
        category: "public-research",
        capabilities: ["keiko.research.fetch"],
      }),
      skill("skl_dup@1"),
    ]);
    expect(catalog.list()).toHaveLength(1);
    expect(catalog.isImplicitAllowed("skl_dup@1")).toBe(false);
    expect(catalog.get("skl_dup@1")?.category).toBe("public-research");
  });

  it("#3417: holds one version of a skill, so a later version or spelling of it is dropped", () => {
    const catalog = createServerApprovedSkillCatalog([
      skill("skl_dup@1"),
      skill("skl_dup@2"),
      skill("skl_dup@1.0"),
      skill("skl_dup@01"),
    ]);
    expect(catalog.list().map((entry) => entry.skillId)).toEqual(["skl_dup@1"]);
  });

  it("#3417: holds at most the discovery limit of skills", () => {
    const entries = Array.from({ length: SKILL_DISCOVERY_LIMITS.maxSkills + 3 }, (_, index) =>
      skill(`skl_skill-${String(index)}@1`),
    );
    const catalog = createServerApprovedSkillCatalog(entries);
    expect(catalog.list()).toHaveLength(SKILL_DISCOVERY_LIMITS.maxSkills);
    expect(catalog.has(`skl_skill-${String(SKILL_DISCOVERY_LIMITS.maxSkills)}@1`)).toBe(false);
  });

  it("exposes an immutable snapshot from list()", () => {
    const catalog = createServerApprovedSkillCatalog();
    const list = catalog.list();
    expect(Object.isFrozen(list)).toBe(true);
    expect(list.every((entry) => Object.isFrozen(entry))).toBe(true);
    expect(list.every((entry) => Object.isFrozen(entry.capabilities))).toBe(true);
    expect(list.every((entry) => Object.isFrozen(entry.compatibility))).toBe(true);
  });

  it("#3417: binds a source digest to the definition, never to the enabled state", () => {
    const [base] = createServerApprovedSkillCatalog([skill("skl_a@1")]).list();
    const [disabled] = createServerApprovedSkillCatalog([
      skill("skl_a@1", { enabled: false }),
    ]).list();
    const [widened] = createServerApprovedSkillCatalog([
      skill("skl_a@1", { capabilities: ["keiko.repo.search", "keiko.workspace.read"] }),
    ]).list();
    expect(base?.sourceDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(disabled?.enabled).toBe(false);
    expect(disabled?.sourceDigest).toBe(base?.sourceDigest);
    expect(widened?.sourceDigest).not.toBe(base?.sourceDigest);
  });

  it("#3417: derives the same digest from the same content on every catalog", () => {
    const first = createServerApprovedSkillCatalog([skill("skl_a@1"), skill("skl_b@1")]);
    const second = createServerApprovedSkillCatalog([skill("skl_a@1"), skill("skl_b@1")]);
    expect(first.revision()).toBe(1);
    expect(first.digest()).toMatch(/^[a-f0-9]{64}$/u);
    expect(second.digest()).toBe(first.digest());
  });
});

describe("SkillCatalog.replace (#3417)", () => {
  const A = skill("skl_a@1");
  const B = skill("skl_b@1", { implicitAllowed: false });

  it.each<[string, readonly SkillCatalogEntryInput[], readonly string[]]>([
    ["an install", [A, B, skill("skl_c@1")], ["skl_a@1", "skl_b@1", "skl_c@1"]],
    ["a removal", [A], ["skl_a@1"]],
    ["a version update", [skill("skl_a@2"), B], ["skl_a@2", "skl_b@1"]],
    [
      "a definition update",
      [skill("skl_a@1", { capabilities: ["keiko.repo.search", "keiko.workspace.read"] }), B],
      ["skl_a@1", "skl_b@1"],
    ],
    ["a disable", [skill("skl_a@1", { enabled: false }), B], ["skl_a@1", "skl_b@1"]],
    ["a revocation", [B], ["skl_b@1"]],
  ])("invalidates the prior revision and digest atomically on %s", (_kind, next, ids) => {
    const catalog = createServerApprovedSkillCatalog([A, B]);
    const before = { revision: catalog.revision(), digest: catalog.digest(), list: catalog.list() };

    expect(catalog.replace(next)).toEqual({
      revision: before.revision + 1,
      admitted: ids.length,
      dropped: 0,
    });
    expect(catalog.revision()).toBe(before.revision + 1);
    expect(catalog.digest()).not.toBe(before.digest);
    expect(catalog.list().map((entry) => entry.skillId)).toEqual(ids);
    // A reader holding the prior snapshot never sees a half-applied change.
    expect(before.list.map((entry) => entry.skillId)).toEqual(["skl_a@1", "skl_b@1"]);
  });

  it("changes the source digest of a version whose definition was updated in place", () => {
    const catalog = createServerApprovedSkillCatalog([A]);
    const before = catalog.get("skl_a@1")?.sourceDigest;
    catalog.replace([
      skill("skl_a@1", { capabilities: ["keiko.repo.search", "keiko.workspace.read"] }),
    ]);
    expect(catalog.get("skl_a@1")?.sourceDigest).not.toBe(before);
  });

  it("makes every change a new revision, even one that repeats the current set", () => {
    const catalog = createServerApprovedSkillCatalog([A, B]);
    const before = catalog.digest();
    catalog.replace([A, B]);
    expect(catalog.revision()).toBe(2);
    expect(catalog.digest()).not.toBe(before);
  });

  it("drops a failing candidate of a change and reports it, keeping the rest", () => {
    const catalog = createServerApprovedSkillCatalog([A, B]);
    const change = catalog.replace(
      seed([skill("skl_c@1"), { ...skill("skl_d@1"), capabilities: ["keiko.fake.tool"] }]),
    );
    expect(change).toEqual({ revision: 2, admitted: 1, dropped: 1 });
    expect(catalog.has("skl_c@1")).toBe(true);
    expect(catalog.has("skl_d@1")).toBe(false);
  });
});
