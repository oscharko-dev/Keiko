import { GIT_DELIVERY_POLICY_SCHEMA_VERSION } from "@oscharko-dev/keiko-contracts/runtime/git-delivery-policy";
import type { GitDeliveryTrustedPolicyPacks } from "./actionSheetProjection.js";
import { defaultMintableRepoPack } from "./policyPackMintability.js";

// One base-pinned pull-request policy for both PR-shaped effects a governed run performs against
// a base branch it has already resolved from the provider: the issue-bound draft creation
// (`draftDeliveryEffects.ts`) and the body-only description apply (`prDescriptionService.ts`).
// Epic #3384 live-flow defect: the draft was admitted against the repository's OWN base (the
// controlled repository's `master`), but the description apply re-checked the same pull request
// against KEIKO_DEFAULT_PR_POLICY_PACK's Keiko-convention base list and refused every repository
// whose default branch is not `dev`/`main`/`release/*`/`feat/*`. Pinning the base to the exact
// ref both effects were resolved for keeps the two checks identical; an explicitly configured
// deployment pack (`execution.policyPacks`) still takes precedence at every call site, and the
// risk-class ceiling, the Authority Envelope and the one-use approval remain the live gates.
export function basePinnedPrPolicyPacks(
  actionKind: "pr-create" | "pr-update",
  baseRef: string,
): GitDeliveryTrustedPolicyPacks {
  // KEIKO-0526: the same fail-loud mintability guard every sibling default-pack site runs, so a
  // future approval-gated rule for an unmintable action kind throws here instead of failing
  // silently at execute time.
  return defaultMintableRepoPack({
    schemaVersion: GIT_DELIVERY_POLICY_SCHEMA_VERSION,
    repoId: actionKind === "pr-create" ? "issue-bound-draft" : "base-pinned-description",
    rules: [
      {
        actionKind,
        decision: "constrained",
        constraints: [
          { kind: "risk-class-ceiling", maxRiskClass: "protected-or-merge" },
          { kind: "branch-pattern", patterns: [{ matchKind: "exact", value: baseRef }] },
        ],
      },
    ],
    defaultRule: { decision: "blocked" },
  });
}
