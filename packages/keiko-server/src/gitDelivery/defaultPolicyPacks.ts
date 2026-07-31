import type { GitDeliveryActionKind } from "@oscharko-dev/keiko-contracts";

import type { GitDeliveryTrustedPolicyPacks } from "./actionSheetProjection.js";
import { KEIKO_DEFAULT_LOCAL_GIT_POLICY_PACK } from "./execution.js";
import { KEIKO_DEFAULT_MERGE_POLICY_PACK } from "./mergeExecution.js";
import { KEIKO_DEFAULT_PR_POLICY_PACK } from "./prExecution.js";
import { KEIKO_DEFAULT_PUBLISH_POLICY_PACK } from "./pushExecution.js";

/** Returns the exact trusted pack object used by the executing route for an action kind. */
export function defaultGitDeliveryPolicyPacksForAction(
  actionKind: GitDeliveryActionKind,
): GitDeliveryTrustedPolicyPacks {
  if (actionKind === "push") return { repoPack: KEIKO_DEFAULT_PUBLISH_POLICY_PACK };
  if (actionKind === "pr-create" || actionKind === "pr-update") {
    return { repoPack: KEIKO_DEFAULT_PR_POLICY_PACK };
  }
  if (actionKind === "merge") return { repoPack: KEIKO_DEFAULT_MERGE_POLICY_PACK };
  return { repoPack: KEIKO_DEFAULT_LOCAL_GIT_POLICY_PACK };
}
