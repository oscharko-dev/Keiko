// Unit coverage for the KEIKO-0526 mintability guard (#3386/#3387, ADR-0138 D2): a policy pack may
// only name `approval-gated` for an action kind whose route group actually exposes an `/approve`
// mint route. `merge`, `commit`, `push`, `pr-create`, and `pr-update` are mintable; `fetch`/`pull`
// and any other unwired kind are not.

import { describe, expect, it } from "vitest";
import type {
  GitDeliveryOrgPolicyPack,
  GitDeliveryRepoPolicyPack,
} from "@oscharko-dev/keiko-contracts";
import { GIT_DELIVERY_POLICY_SCHEMA_VERSION } from "@oscharko-dev/keiko-contracts/runtime/git-delivery-policy";
import {
  assertPolicyPackMintable,
  assertPolicyPacksMintable,
  defaultMintableRepoPack,
} from "./policyPackMintability.js";

function repoPack(overrides: Partial<GitDeliveryRepoPolicyPack> = {}): GitDeliveryRepoPolicyPack {
  return {
    schemaVersion: GIT_DELIVERY_POLICY_SCHEMA_VERSION,
    repoId: "repo",
    rules: [],
    defaultRule: { decision: "constrained", constraints: [] },
    ...overrides,
  };
}

describe("assertPolicyPackMintable", () => {
  it("accepts approval-gated for merge", () => {
    expect(() => {
      assertPolicyPackMintable(
        repoPack({ rules: [{ actionKind: "merge", decision: "approval-gated" }] }),
      );
    }).not.toThrow();
  });

  // #3386: the failing-before-fix case — before this change, an approval-gated commit rule
  // threw here, which is exactly why the commit execute route could never rely on the pack to
  // enforce approval and needed its own unconditional check instead.
  it("accepts approval-gated for commit now that its mint route exists", () => {
    expect(() => {
      assertPolicyPackMintable(
        repoPack({ rules: [{ actionKind: "commit", decision: "approval-gated" }] }),
      );
    }).not.toThrow();
  });

  it.each(["push", "pull-request", "fetch", "pull", "branch-create"] as const)(
    "still throws for approval-gated %s: no mint route exists for it yet",
    (actionKind) => {
      expect(() => {
        assertPolicyPackMintable(repoPack({ rules: [{ actionKind, decision: "approval-gated" }] }));
      }).toThrow(/no mint route exists/);
    },
  );

  it("throws when the default rule itself is approval-gated", () => {
    expect(() => {
      assertPolicyPackMintable(
        repoPack({ defaultRule: { decision: "approval-gated", requiredApprovers: [] } }),
      );
    }).toThrow(/default rule is approval-gated/);
  });

  it("accepts a pack with no approval-gated rule at all", () => {
    expect(() => {
      assertPolicyPackMintable(repoPack());
    }).not.toThrow();
  });
});

describe("assertPolicyPacksMintable", () => {
  it("validates both the repo and the org pack when both are present", () => {
    const orgPack: GitDeliveryOrgPolicyPack = {
      schemaVersion: GIT_DELIVERY_POLICY_SCHEMA_VERSION,
      orgId: "org",
      rules: [{ actionKind: "push", decision: "approval-gated" }],
      defaultRule: { decision: "constrained", constraints: [] },
    };
    expect(() => {
      assertPolicyPacksMintable({ repoPack: repoPack(), orgPack });
    }).toThrow(/no mint route exists/);
  });

  it("passes when neither pack is present", () => {
    expect(() => {
      assertPolicyPacksMintable({});
    }).not.toThrow();
  });
});

describe("defaultMintableRepoPack", () => {
  it("wraps a mintable pack as the repo pack", () => {
    expect(defaultMintableRepoPack(repoPack())).toEqual({ repoPack: repoPack() });
  });

  it("throws for a pack that names a non-mintable approval-gated action kind", () => {
    expect(() =>
      defaultMintableRepoPack(
        repoPack({ rules: [{ actionKind: "push", decision: "approval-gated" }] }),
      ),
    ).toThrow(/no mint route exists/);
  });
});
