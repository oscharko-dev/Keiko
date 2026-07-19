import { describe, expect, it } from "vitest";
import {
  createServerApprovedSkillCatalog,
  SKILL_CATEGORIES,
  type SkillCatalogEntryInput,
} from "./skillCatalog.js";

// A hostile array cast helper: registration must runtime-validate every candidate, so tests feed
// it deliberately ill-typed input the TypeScript signature would otherwise forbid.
function seed(entries: readonly unknown[]): readonly SkillCatalogEntryInput[] {
  return entries as unknown as readonly SkillCatalogEntryInput[];
}

describe("createServerApprovedSkillCatalog", () => {
  it("seeds the default read-only set with exact id@version lookup", () => {
    const catalog = createServerApprovedSkillCatalog();
    expect(catalog.has("skl_repo-structure-summary@1")).toBe(true);
    expect(catalog.isImplicitAllowed("skl_repo-structure-summary@1")).toBe(true);
    expect(catalog.get("skl_repo-structure-summary@1")?.category).toBe("repository-analysis");
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
      { skillId: "skl_public-docs-lookup@1", implicitAllowed: false, category: "public-research" },
    ]);
    expect(catalog.isImplicitAllowed("skl_public-docs-lookup@1")).toBe(false);
    expect(catalog.get("skl_public-docs-lookup@1")?.category).toBe("public-research");
  });

  it("injected entries replace the default seed", () => {
    const catalog = createServerApprovedSkillCatalog([
      { skillId: "skl_only@1", implicitAllowed: true, category: "repository-analysis" },
    ]);
    expect(catalog.has("skl_only@1")).toBe(true);
    expect(catalog.has("skl_repo-structure-summary@1")).toBe(false);
    expect(catalog.list()).toHaveLength(1);
  });

  it("canonicalizes an entry and strips any free-form metadata", () => {
    const catalog = createServerApprovedSkillCatalog(
      seed([
        {
          skillId: "skl_docs@1",
          implicitAllowed: true,
          category: "public-research",
          grantAuthority: "autonomous-delivery",
          endpoint: "https://evil.example",
        },
      ]),
    );
    const entry = catalog.get("skl_docs@1");
    expect(entry).toBeDefined();
    expect(Object.keys(entry ?? {}).sort()).toEqual(["category", "implicitAllowed", "skillId"]);
    expect(SKILL_CATEGORIES).toContain(entry?.category);
  });

  it("drops every hostile or malformed entry (fail closed on registration)", () => {
    const catalog = createServerApprovedSkillCatalog(
      seed([
        { skillId: "not-a-skill-id", implicitAllowed: true, category: "public-research" },
        { skillId: "skl_bad-bool@1", implicitAllowed: "yes", category: "public-research" },
        { skillId: "skl_bad-cat@1", implicitAllowed: true, category: "arbitrary-scope" },
        42,
        null,
        "skl_string@1",
      ]),
    );
    expect(catalog.list()).toHaveLength(0);
    expect(catalog.has("skl_bad-bool@1")).toBe(false);
    expect(catalog.has("skl_bad-cat@1")).toBe(false);
  });

  it("keeps the first admission of a duplicate id so a later entry cannot override it", () => {
    const catalog = createServerApprovedSkillCatalog([
      { skillId: "skl_dup@1", implicitAllowed: false, category: "public-research" },
      { skillId: "skl_dup@1", implicitAllowed: true, category: "repository-analysis" },
    ]);
    expect(catalog.list()).toHaveLength(1);
    expect(catalog.isImplicitAllowed("skl_dup@1")).toBe(false);
    expect(catalog.get("skl_dup@1")?.category).toBe("public-research");
  });

  it("exposes an immutable snapshot from list()", () => {
    const catalog = createServerApprovedSkillCatalog();
    const list = catalog.list();
    expect(Object.isFrozen(list)).toBe(true);
    expect(list.every((entry) => Object.isFrozen(entry))).toBe(true);
  });
});
