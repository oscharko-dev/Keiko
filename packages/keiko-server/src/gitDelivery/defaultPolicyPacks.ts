import type { GitDeliveryActionKind } from "@oscharko-dev/keiko-contracts";

import type { GitDeliveryTrustedPolicyPacks } from "./actionSheetProjection.js";
import { KEIKO_DEFAULT_LOCAL_GIT_POLICY_PACK } from "./execution.js";
import { KEIKO_DEFAULT_MERGE_POLICY_PACK } from "./mergeExecution.js";
import { assertPolicyPacksMintable } from "./policyPackMintability.js";
import { KEIKO_DEFAULT_PR_POLICY_PACK } from "./prExecution.js";
import { KEIKO_DEFAULT_PUBLISH_POLICY_PACK } from "./pushExecution.js";

// KEIKO-0526: the guards themselves live in policyPackMintability.ts (not here) precisely so they
// can be imported by mergeExecution.ts/execution.ts/prExecution.ts/pushExecution.ts and their
// *Routes.ts siblings without an import cycle -- this module already depends on all four for their
// KEIKO_DEFAULT_*_POLICY_PACK constants. Re-exported below so existing callers/tests that resolve
// the guards through defaultPolicyPacks.ts keep working unchanged. `export ... from` (Sonar S3512)
// is a direct pass-through and avoids an intermediate local binding.
export { assertPolicyPackMintable, assertPolicyPacksMintable } from "./policyPackMintability.js";

/** Returns the exact trusted pack object used by the executing route for an action kind. */
export function defaultGitDeliveryPolicyPacksForAction(
  actionKind: GitDeliveryActionKind,
): GitDeliveryTrustedPolicyPacks {
  const packs = resolvePacks(actionKind);
  assertPolicyPacksMintable(packs);
  return packs;
}

function resolvePacks(actionKind: GitDeliveryActionKind): GitDeliveryTrustedPolicyPacks {
  if (actionKind === "push") return { repoPack: KEIKO_DEFAULT_PUBLISH_POLICY_PACK };
  if (actionKind === "pr-create" || actionKind === "pr-update") {
    return { repoPack: KEIKO_DEFAULT_PR_POLICY_PACK };
  }
  if (actionKind === "merge") return { repoPack: KEIKO_DEFAULT_MERGE_POLICY_PACK };
  return { repoPack: KEIKO_DEFAULT_LOCAL_GIT_POLICY_PACK };
}
