import type {
  GitDeliveryActionKind,
  GitDeliveryOrgPolicyPack,
  GitDeliveryRepoPolicyPack,
} from "@oscharko-dev/keiko-contracts";

import type { GitDeliveryTrustedPolicyPacks } from "./actionSheetProjection.js";

// KEIKO-0526: only `merge` currently exposes an /approve mint route. If a future policy pack ever
// declared `approval-gated` for a different action kind, no HTTP surface could satisfy the resulting
// approval claim and the action would silently fail closed with no diagnostic pointer to the
// misconfiguration. This set makes that ceiling explicit; extending it requires wiring the matching
// mint route first.
//
// This module is deliberately dependency-free within gitDelivery/ (only contract types) so every
// pack-resolution site -- including defaultPolicyPacks.ts, which itself imports each action kind's
// KEIKO_DEFAULT_*_POLICY_PACK constant from its owning *Execution.ts module -- can import the guard
// without creating an import cycle back through those same execution modules.
const MINTABLE_ACTION_KINDS: ReadonlySet<GitDeliveryActionKind> = new Set(["merge"]);

/**
 * Fails loudly at pack-resolution time when a policy pack names `approval-gated` for an action kind
 * whose route group has no matching `/approve` mint endpoint. Without this guard, such a rule
 * converts to a permanent unexplained denial at execute time (an availability/lockout defect that
 * fails closed with no operator-actionable diagnostic).
 */
export function assertPolicyPackMintable(
  pack: GitDeliveryRepoPolicyPack | GitDeliveryOrgPolicyPack,
): void {
  for (const rule of pack.rules) {
    if (rule.decision === "approval-gated" && !MINTABLE_ACTION_KINDS.has(rule.actionKind)) {
      throw new Error(
        `git-delivery policy pack names approval-gated for '${rule.actionKind}' ` +
          "but no mint route exists for it (only 'merge' currently exposes /approve)",
      );
    }
  }
  const defaultRule = pack.defaultRule;
  if (defaultRule?.decision === "approval-gated") {
    throw new Error(
      "git-delivery policy pack default rule is approval-gated, but the default rule " +
        "applies to every action kind including those with no mint route",
    );
  }
}

/**
 * Validates every pack present in a resolved org/repo pair. Used by `defaultGitDeliveryPolicyPacksForAction`,
 * which has no notion of a caller-supplied override to skip -- `resolvePacks` is a pure function of the
 * action kind alone, so its result is unconditionally validated every time.
 */
export function assertPolicyPacksMintable(packs: GitDeliveryTrustedPolicyPacks): void {
  if (packs.repoPack !== undefined) {
    assertPolicyPackMintable(packs.repoPack);
  }
  if (packs.orgPack !== undefined) {
    assertPolicyPackMintable(packs.orgPack);
  }
}

/**
 * Wraps a route's own default repo policy pack constant as a resolved `GitDeliveryTrustedPolicyPacks`,
 * validating it first. Designed for exactly the `seams.policyPacks ?? { repoPack:
 * KEIKO_DEFAULT_*_POLICY_PACK }` fallback every mutating route's pack-resolution site uses:
 * `??`'s right-hand side is only ever EVALUATED when the seam did not supply an override, so this
 * validates precisely the DEFAULT constant actually reaching production traffic -- never a caller- or
 * test-supplied `seams.policyPacks` override. That matters because several existing regression tests
 * legitimately exercise the kernel's generic (action-kind-agnostic) approval-gating evaluation by
 * injecting a custom approval-gated pack for a non-merge action kind via `seams.policyPacks` (e.g.
 * commitRoutes.test.ts's "holds for approval when the trusted pack is approval-gated") -- that is a
 * kernel-correctness concern, wholly separate from KEIKO-0526's HTTP-mint-route-reachability concern,
 * and must keep working. A future edit that makes a SHIPPED default approval-gated for a non-mintable
 * action kind fails loudly the first time that default is actually resolved.
 */
export function defaultMintableRepoPack(
  repoPack: GitDeliveryRepoPolicyPack,
): GitDeliveryTrustedPolicyPacks {
  assertPolicyPackMintable(repoPack);
  return { repoPack };
}
