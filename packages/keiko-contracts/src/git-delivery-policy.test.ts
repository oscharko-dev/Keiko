// Behavioral tests for git-delivery-policy.ts (Issue #471, Epic #470). Covers every exported guard,
// every parser (ok + each distinct error path), and the full evaluateGitPolicy precedence matrix:
// org-blocked, repo-blocked, org-gated, repo-gated, constrained-union, allowed, fail-closed
// no-applicable-rule with empty packs, deny-by-default via defaultRule, and org-tighten-over-repo-loosen.

import { describe, expect, it } from "vitest";

import {
  GIT_DELIVERY_POLICY_SCHEMA_VERSION,
  evaluateGitPolicy,
  isGitDeliveryPolicyRule,
  parseGitOrgPolicyPack,
  parseGitPolicyPack,
  parseGitRepoPolicyPack,
} from "./git-delivery-policy.js";
import type {
  GitDeliveryConstraint,
  GitDeliveryOrgPolicyPack,
  GitDeliveryPolicyContext,
  GitDeliveryRepoPolicyPack,
} from "./index.js";

const CTX: GitDeliveryPolicyContext = {
  actionKind: "push",
  activeProviderCapabilities: [],
};

function orgPack(partial: Partial<GitDeliveryOrgPolicyPack>): GitDeliveryOrgPolicyPack {
  return {
    schemaVersion: GIT_DELIVERY_POLICY_SCHEMA_VERSION,
    orgId: "org-1",
    rules: [],
    ...partial,
  };
}

function repoPack(partial: Partial<GitDeliveryRepoPolicyPack>): GitDeliveryRepoPolicyPack {
  return {
    schemaVersion: GIT_DELIVERY_POLICY_SCHEMA_VERSION,
    repoId: "repo-1",
    rules: [],
    ...partial,
  };
}

describe("isGitDeliveryPolicyRule", () => {
  it("accepts each well-formed decision shape", () => {
    expect(isGitDeliveryPolicyRule({ actionKind: "push", decision: "allowed" })).toBe(true);
    expect(isGitDeliveryPolicyRule({ actionKind: "push", decision: "blocked" })).toBe(true);
    expect(
      isGitDeliveryPolicyRule({
        actionKind: "push",
        decision: "approval-gated",
        requiredApprovers: ["lead"],
      }),
    ).toBe(true);
    // approval-gated with no approvers list is structurally valid (means any one approver).
    expect(isGitDeliveryPolicyRule({ actionKind: "push", decision: "approval-gated" })).toBe(true);
    expect(
      isGitDeliveryPolicyRule({
        actionKind: "merge",
        decision: "constrained",
        constraints: [{ kind: "provider-capability", capability: "required-checks" }],
      }),
    ).toBe(true);
  });

  it("rejects malformed rules", () => {
    expect(isGitDeliveryPolicyRule({ actionKind: "", decision: "allowed" })).toBe(false);
    expect(isGitDeliveryPolicyRule({ actionKind: "push", decision: "maybe" })).toBe(false);
    expect(
      isGitDeliveryPolicyRule({
        actionKind: "push",
        decision: "approval-gated",
        requiredApprovers: [1],
      }),
    ).toBe(false);
    expect(
      isGitDeliveryPolicyRule({
        actionKind: "merge",
        decision: "constrained",
        constraints: [{ kind: "min-risk-class" }],
      }),
    ).toBe(false);
    expect(isGitDeliveryPolicyRule(null)).toBe(false);
  });
});

describe("evaluateGitPolicy precedence matrix", () => {
  it("1. org-blocked dominates everything (even a repo allow)", () => {
    const decision = evaluateGitPolicy(
      orgPack({ rules: [{ actionKind: "push", decision: "blocked" }] }),
      repoPack({ rules: [{ actionKind: "push", decision: "allowed" }] }),
      CTX,
    );
    expect(decision).toEqual({ outcome: "blocked", reason: "policy-pack-blocked" });
  });

  it("1. repo-blocked also blocks (even when org allows)", () => {
    const decision = evaluateGitPolicy(
      orgPack({ rules: [{ actionKind: "push", decision: "allowed" }] }),
      repoPack({ rules: [{ actionKind: "push", decision: "blocked" }] }),
      CTX,
    );
    expect(decision).toEqual({ outcome: "blocked", reason: "policy-pack-blocked" });
  });

  it("2. org approval-gated wins over a repo loosen (org tighten dominates)", () => {
    const decision = evaluateGitPolicy(
      orgPack({
        rules: [
          { actionKind: "push", decision: "approval-gated", requiredApprovers: ["org-lead"] },
        ],
      }),
      repoPack({ rules: [{ actionKind: "push", decision: "allowed" }] }),
      CTX,
    );
    expect(decision).toEqual({ outcome: "approval-gated", requiredApprovers: ["org-lead"] });
  });

  it("3. repo approval-gated applies when org is allowed/none", () => {
    const decision = evaluateGitPolicy(
      orgPack({ rules: [{ actionKind: "push", decision: "allowed" }] }),
      repoPack({
        rules: [
          { actionKind: "push", decision: "approval-gated", requiredApprovers: ["repo-lead"] },
        ],
      }),
      CTX,
    );
    expect(decision).toEqual({ outcome: "approval-gated", requiredApprovers: ["repo-lead"] });
  });

  it("4. constrained unions org constraints first, then repo constraints", () => {
    const orgConstraint: GitDeliveryConstraint = {
      kind: "provider-capability",
      capability: "branch-protection",
    };
    const repoConstraint: GitDeliveryConstraint = {
      kind: "risk-class-ceiling",
      maxRiskClass: "publish",
    };
    const decision = evaluateGitPolicy(
      orgPack({
        rules: [{ actionKind: "push", decision: "constrained", constraints: [orgConstraint] }],
      }),
      repoPack({
        rules: [{ actionKind: "push", decision: "constrained", constraints: [repoConstraint] }],
      }),
      CTX,
    );
    expect(decision).toEqual({
      outcome: "constrained",
      constraints: [orgConstraint, repoConstraint],
    });
  });

  it("4. constrained on one level only still yields constrained", () => {
    const repoConstraint: GitDeliveryConstraint = {
      kind: "branch-pattern",
      patterns: [{ matchKind: "exact", value: "main" }],
    };
    const decision = evaluateGitPolicy(
      orgPack({ rules: [{ actionKind: "push", decision: "allowed" }] }),
      repoPack({
        rules: [{ actionKind: "push", decision: "constrained", constraints: [repoConstraint] }],
      }),
      CTX,
    );
    expect(decision).toEqual({ outcome: "constrained", constraints: [repoConstraint] });
  });

  it("5. allowed when either level allows and neither tightens", () => {
    const decision = evaluateGitPolicy(
      orgPack({ rules: [{ actionKind: "push", decision: "allowed" }] }),
      repoPack({ rules: [] }),
      CTX,
    );
    expect(decision).toEqual({ outcome: "allowed" });
  });

  it("6. fail-closed no-applicable-rule when both packs are empty", () => {
    const decision = evaluateGitPolicy(orgPack({ rules: [] }), repoPack({ rules: [] }), CTX);
    expect(decision).toEqual({ outcome: "blocked", reason: "no-applicable-rule" });
  });

  it("6. fail-closed no-applicable-rule when both packs are undefined", () => {
    const decision = evaluateGitPolicy(undefined, undefined, CTX);
    expect(decision).toEqual({ outcome: "blocked", reason: "no-applicable-rule" });
  });

  it("deny-by-default via org defaultRule blocks an unmatched kind", () => {
    const decision = evaluateGitPolicy(
      orgPack({ rules: [], defaultRule: { decision: "blocked" } }),
      repoPack({ rules: [{ actionKind: "push", decision: "allowed" }] }),
      CTX,
    );
    expect(decision).toEqual({ outcome: "blocked", reason: "policy-pack-blocked" });
  });

  it("repo defaultRule applies when no specific rule matches and org is none", () => {
    const decision = evaluateGitPolicy(
      undefined,
      repoPack({
        rules: [],
        defaultRule: { decision: "approval-gated", requiredApprovers: ["fallback"] },
      }),
      CTX,
    );
    expect(decision).toEqual({ outcome: "approval-gated", requiredApprovers: ["fallback"] });
  });

  it("a specific rule overrides the defaultRule at the same level", () => {
    const decision = evaluateGitPolicy(
      undefined,
      repoPack({
        rules: [{ actionKind: "push", decision: "allowed" }],
        defaultRule: { decision: "blocked" },
      }),
      CTX,
    );
    expect(decision).toEqual({ outcome: "allowed" });
  });

  it("empty approvers on an explicit approval-gated rule is NOT the fail-closed case", () => {
    const decision = evaluateGitPolicy(
      orgPack({
        rules: [{ actionKind: "push", decision: "approval-gated", requiredApprovers: [] }],
      }),
      undefined,
      CTX,
    );
    expect(decision).toEqual({ outcome: "approval-gated", requiredApprovers: [] });
  });
});

describe("policy-pack parsers", () => {
  it("parseGitRepoPolicyPack parses a valid pack with a defaultRule", () => {
    const result = parseGitRepoPolicyPack({
      schemaVersion: GIT_DELIVERY_POLICY_SCHEMA_VERSION,
      repoId: "repo-1",
      rules: [{ actionKind: "push", decision: "blocked" }],
      defaultRule: { decision: "blocked" },
    });
    expect(result.ok).toBe(true);
  });

  it("parseGitRepoPolicyPack rejects a non-object, bad schemaVersion, bad rules, missing repoId", () => {
    expect(parseGitRepoPolicyPack(null).ok).toBe(false);
    const badVersion = parseGitRepoPolicyPack({
      schemaVersion: "9",
      repoId: "r",
      rules: [],
    });
    expect(badVersion.ok).toBe(false);
    if (!badVersion.ok) {
      expect(badVersion.errors.some((e) => e.includes("schemaVersion"))).toBe(true);
    }
    const badRules = parseGitRepoPolicyPack({
      schemaVersion: GIT_DELIVERY_POLICY_SCHEMA_VERSION,
      repoId: "r",
      rules: "nope",
    });
    expect(badRules.ok).toBe(false);
    if (!badRules.ok) {
      expect(badRules.errors.some((e) => e.includes("rules must be an array"))).toBe(true);
    }
    const missingRepoId = parseGitRepoPolicyPack({
      schemaVersion: GIT_DELIVERY_POLICY_SCHEMA_VERSION,
      rules: [],
    });
    expect(missingRepoId.ok).toBe(false);
    if (!missingRepoId.ok) {
      expect(missingRepoId.errors.some((e) => e.includes("repoId"))).toBe(true);
    }
  });

  it("parseGitRepoPolicyPack rejects an invalid rule entry", () => {
    const result = parseGitRepoPolicyPack({
      schemaVersion: GIT_DELIVERY_POLICY_SCHEMA_VERSION,
      repoId: "r",
      rules: [{ actionKind: "push", decision: "maybe" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("invalid GitDeliveryPolicyRule"))).toBe(true);
    }
  });

  it("parseGitRepoPolicyPack rejects an invalid defaultRule", () => {
    const result = parseGitRepoPolicyPack({
      schemaVersion: GIT_DELIVERY_POLICY_SCHEMA_VERSION,
      repoId: "r",
      rules: [],
      defaultRule: { decision: "constrained", constraints: [{ kind: "bogus" }] },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("defaultRule"))).toBe(true);
    }
  });

  it("parseGitOrgPolicyPack parses a valid pack and rejects a missing orgId", () => {
    expect(
      parseGitOrgPolicyPack({
        schemaVersion: GIT_DELIVERY_POLICY_SCHEMA_VERSION,
        orgId: "org-1",
        rules: [],
      }).ok,
    ).toBe(true);
    const missing = parseGitOrgPolicyPack({
      schemaVersion: GIT_DELIVERY_POLICY_SCHEMA_VERSION,
      rules: [],
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.errors.some((e) => e.includes("orgId"))).toBe(true);
    }
    expect(parseGitOrgPolicyPack(7).ok).toBe(false);
  });

  it("parseGitPolicyPack discriminates repo vs org by id presence", () => {
    const repo = parseGitPolicyPack({
      schemaVersion: GIT_DELIVERY_POLICY_SCHEMA_VERSION,
      repoId: "r",
      rules: [],
    });
    expect(repo.ok).toBe(true);
    if (repo.ok) {
      expect("repoId" in repo.value).toBe(true);
    }
    const org = parseGitPolicyPack({
      schemaVersion: GIT_DELIVERY_POLICY_SCHEMA_VERSION,
      orgId: "o",
      rules: [],
    });
    expect(org.ok).toBe(true);
    if (org.ok) {
      expect("orgId" in org.value).toBe(true);
    }
  });

  it("parseGitPolicyPack rejects a pack with neither repoId nor orgId, and a non-object", () => {
    const neither = parseGitPolicyPack({
      schemaVersion: GIT_DELIVERY_POLICY_SCHEMA_VERSION,
      rules: [],
    });
    expect(neither.ok).toBe(false);
    if (!neither.ok) {
      expect(neither.errors.some((e) => e.includes("repoId or orgId"))).toBe(true);
    }
    expect(parseGitPolicyPack("x").ok).toBe(false);
  });
});
