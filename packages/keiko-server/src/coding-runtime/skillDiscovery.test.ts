import { describe, expect, it, vi } from "vitest";
import { validateSkillDiscoveryResultV1 } from "@oscharko-dev/keiko-contracts/runtime/coding-skill-discovery";
import {
  createServerApprovedSkillCatalog,
  OPENCODE_SKILL_PROFILE,
  type SkillCatalogEntry,
  type SkillCatalogEntryInput,
} from "./skillCatalog.js";
import {
  approvedSkillProjection,
  operatorSkillProjection,
  invocableSkillDiscovery,
  skillReadiness,
  staticSkillReadiness,
  unavailableSkillCounts,
  type SkillReadinessFacts,
} from "./skillDiscovery.js";

function skill(
  skillId: string,
  overrides: Partial<SkillCatalogEntryInput> = {},
): SkillCatalogEntryInput {
  return {
    skillId,
    implicitAllowed: true,
    category: "repository-analysis",
    capabilities: ["keiko.workspace.read"],
    compatibility: { profile: "opencode", minVersion: 1, maxVersion: 1 },
    ...overrides,
  };
}

function entry(overrides: Partial<SkillCatalogEntryInput> = {}): SkillCatalogEntry {
  const [admitted] = createServerApprovedSkillCatalog([skill("skl_a@1", overrides)]).list();
  if (admitted === undefined) throw new Error("fixture skill not admitted");
  return admitted;
}

function facts(overrides: Partial<SkillReadinessFacts> = {}): SkillReadinessFacts {
  return {
    profile: OPENCODE_SKILL_PROFILE,
    handlerMounted: (category) => category === "repository-analysis",
    authorityAllowsRead: () => true,
    delegatedReadFits: () => true,
    ...overrides,
  };
}

describe("skill readiness (#3417)", () => {
  it("is ready only when enabled, compatible, handled, authorized and within budget", () => {
    expect(skillReadiness(entry(), facts())).toEqual({ state: "ready" });
  });

  it.each([
    ["disabled", entry({ enabled: false }), facts()],
    [
      "incompatible",
      entry({ compatibility: { profile: "codex", minVersion: 1, maxVersion: 1 } }),
      facts(),
    ],
    [
      "incompatible",
      entry({ compatibility: { profile: "opencode", minVersion: 2, maxVersion: 3 } }),
      facts(),
    ],
    [
      "handler-unavailable",
      entry({ category: "public-research", capabilities: ["keiko.research.fetch"] }),
      facts(),
    ],
    ["authority-denied", entry(), facts({ authorityAllowsRead: () => false })],
    ["budget-exhausted", entry(), facts({ delegatedReadFits: () => false })],
  ] as const)("reports %s with its closed reason", (reason, subject, context) => {
    expect(skillReadiness(subject, context)).toEqual({ state: "unavailable", reason });
  });

  it("decides a skill's own state before it asks any live question", () => {
    const authorityAllowsRead = vi.fn(() => false);
    const delegatedReadFits = vi.fn(() => false);
    expect(
      skillReadiness(entry({ enabled: false }), facts({ authorityAllowsRead, delegatedReadFits })),
    ).toEqual({ state: "unavailable", reason: "disabled" });
    expect(authorityAllowsRead).not.toHaveBeenCalled();
    expect(delegatedReadFits).not.toHaveBeenCalled();
  });

  it("judges advertisability from the skill and the run alone", () => {
    expect(staticSkillReadiness(entry(), facts())).toEqual({ state: "ready" });
    expect(staticSkillReadiness(entry({ enabled: false }), facts())).toEqual({
      state: "unavailable",
      reason: "disabled",
    });
  });
});

describe("skill discovery projection (#3417)", () => {
  const catalog = createServerApprovedSkillCatalog([
    skill("skl_ready@1"),
    skill("skl_explicit@1", { implicitAllowed: false }),
    skill("skl_off@1", { enabled: false }),
    skill("skl_web@1", { category: "public-research", capabilities: ["keiko.research.fetch"] }),
  ]);

  it("projects every approved skill with its readiness, closed and body-free", () => {
    const projection = approvedSkillProjection(catalog, facts());
    expect(validateSkillDiscoveryResultV1(projection).ok).toBe(true);
    expect(projection.catalogDigest).toBe(catalog.digest());
    expect(projection.skills.map((listed) => [listed.skillId, listed.readiness])).toEqual([
      ["skl_ready@1", { state: "ready" }],
      ["skl_explicit@1", { state: "ready" }],
      ["skl_off@1", { state: "unavailable", reason: "disabled" }],
      ["skl_web@1", { state: "unavailable", reason: "handler-unavailable" }],
    ]);
    expect(unavailableSkillCounts(projection)).toEqual({
      disabled: 1,
      "handler-unavailable": 1,
    });
  });

  it("asks the live authority and budget questions once per projection", () => {
    const authorityAllowsRead = vi.fn(() => true);
    const delegatedReadFits = vi.fn(() => false);
    const projection = approvedSkillProjection(
      catalog,
      facts({ authorityAllowsRead, delegatedReadFits }),
    );
    expect(authorityAllowsRead).toHaveBeenCalledOnce();
    expect(delegatedReadFits).toHaveBeenCalledOnce();
    expect(unavailableSkillCounts(projection)).toEqual({
      "budget-exhausted": 2,
      disabled: 1,
      "handler-unavailable": 1,
    });
  });

  it("gives the model only the ready skills it may invoke now", () => {
    const projection = approvedSkillProjection(catalog, facts());
    const implicit = invocableSkillDiscovery(projection, (skillId) =>
      catalog.isImplicitAllowed(skillId),
    );
    expect(implicit.skills.map((listed) => listed.skillId)).toEqual(["skl_ready@1"]);
    expect(implicit.catalogDigest).toBe(projection.catalogDigest);
    const requested = invocableSkillDiscovery(projection, () => true);
    expect(requested.skills.map((listed) => listed.skillId)).toEqual([
      "skl_ready@1",
      "skl_explicit@1",
    ]);
  });
});

describe("the operator's skill projection (#3417)", () => {
  it("lists every approved skill with the readiness a run can tell before any live question", () => {
    const catalog = createServerApprovedSkillCatalog([
      skill("skl_a@1"),
      skill("skl_b@1", { enabled: false }),
    ]);

    const projection = operatorSkillProjection(catalog, facts());

    expect(validateSkillDiscoveryResultV1(projection).ok).toBe(true);
    expect(projection.catalogDigest).toBe(catalog.digest());
    expect(projection.skills.map((entry) => [entry.skillId, entry.readiness])).toEqual([
      ["skl_a@1", { state: "ready" }],
      ["skl_b@1", { state: "unavailable", reason: "disabled" }],
    ]);
  });

  it("asks neither the live authority nor the budget, so the operator's view spends nothing", () => {
    const authorityAllowsRead = vi.fn(() => false);
    const delegatedReadFits = vi.fn(() => false);

    const projection = operatorSkillProjection(
      createServerApprovedSkillCatalog([skill("skl_a@1")]),
      facts({ authorityAllowsRead, delegatedReadFits }),
    );

    expect(projection.skills[0]?.readiness).toEqual({ state: "ready" });
    expect(authorityAllowsRead).not.toHaveBeenCalled();
    expect(delegatedReadFits).not.toHaveBeenCalled();
  });
});
