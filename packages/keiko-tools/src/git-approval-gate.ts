// Shared required-approver membership check for every governed git delivery gate (KEIKO-0147).
//
// An unexpired approval token is NOT sufficient authority. When the policy decision names a
// required-approver set, the identity that granted the approval must be a member of it —
// otherwise an unrelated operator's valid token integrates work for which a specific reviewer
// was mandated.
//
// This lives in one module on purpose. The same gate shape is resolved in four places
// (`git-merge-gateway`, `git-publish-gateway`, `git-pr-gateway`, `git-mutation-orchestrator`),
// and the original audit finding's `doNot` called out fixing only one of them as the failure
// mode to avoid. A single predicate means a future approver rule cannot drift between the
// surfaces that enforce it (AGENTS.md §7: fix the whole class at the owning layer).
//
// Semantics, deliberately preserved from ADR-0080 D5:
//   - an EMPTY `requiredApprovers` array still means "any authenticated approval";
//   - `approvedByUserId` exists only on the `required: true` branch, so a not-required
//     approval can never be blocked here;
//   - the check applies only to an `approval-gated` decision — `allowed` / `constrained`
//     outcomes never carry a required-approver set.

import type {
  GitDeliveryApprovalRequirement,
  GitDeliveryPolicyDecision,
} from "@oscharko-dev/keiko-contracts";

/**
 * True when the decision mandates a specific approver set and the granting identity is NOT in it.
 * Callers translate a `true` into their own gate's policy-block shape with the
 * `approver-not-authorized` reason.
 */
export function approverIsNotAuthorized(
  decision: GitDeliveryPolicyDecision,
  approval: GitDeliveryApprovalRequirement,
): boolean {
  if (decision.outcome !== "approval-gated") return false;
  if (decision.requiredApprovers.length === 0) return false;
  if (!approval.required) return false;
  return !decision.requiredApprovers.includes(approval.approvedByUserId);
}
