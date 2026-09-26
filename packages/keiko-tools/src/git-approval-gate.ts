// Shared approval-gate resolution for every governed git delivery gate (KEIKO-0147, KEIKO-0535).
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
  GitDeliveryBlockReason,
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

// ─── Approval-gate resolution (KEIKO-0535) ───────────────────────────────────────────────────
//
// Below `approverIsNotAuthorized` sits the wider question each of the four gateways used to
// answer with its own copy: given a policy decision that has already reached the approval-gated
// branch (every allowed/blocked/constrained outcome is handled by the caller first), is the
// supplied approval valid, expired, or absent — and if valid, is the granting identity authorized?
// `resolveApprovalState` and `resolveGitDeliveryApprovalGate` are the one implementation of that
// question; each gateway's own local Gate union (MergeGate/PublishGate/PrGate/PolicyGate) is kept
// as-is and maps this function's canonical result onto its own field names at a single call site,
// so no observable behavior changes for any of the four gateways' existing callers or tests.

function resolveApprovalState(
  approval: GitDeliveryApprovalRequirement,
  now: number,
): "valid" | "absent" | "expired" {
  if (!approval.required) {
    return "absent";
  }
  if (approval.expiresAtMs !== undefined && approval.expiresAtMs <= now) {
    return "expired";
  }
  return "valid";
}

export type GitDeliveryApprovalGateResult =
  | { readonly proceed: true }
  | {
      readonly proceed: false;
      readonly status: "approval-required";
      readonly approvers: readonly string[];
    }
  | {
      readonly proceed: false;
      readonly status: "policy-block";
      readonly blockReason: GitDeliveryBlockReason;
    };

/**
 * Resolves the approval-gated branch of a governed git delivery decision (KEIKO-0535): valid,
 * expired, or absent, and — when valid — whether the granting identity is an authorized approver
 * (KEIKO-0147). `decision` is expected to already be known `approval-gated` by the caller (every
 * current caller reaches this only after handling `allowed`/`blocked`/`constrained`); if it is not,
 * `approvers` simply resolves to an empty array rather than this function narrowing or asserting
 * the decision's shape, so a caller may pass either the wide `GitDeliveryPolicyDecision` or an
 * already branch-narrowed one.
 */
export function resolveGitDeliveryApprovalGate(
  decision: GitDeliveryPolicyDecision,
  approval: GitDeliveryApprovalRequirement,
  now: number,
): GitDeliveryApprovalGateResult {
  const approvers = decision.outcome === "approval-gated" ? decision.requiredApprovers : [];
  const state = resolveApprovalState(approval, now);
  if (state === "valid") {
    if (approverIsNotAuthorized(decision, approval)) {
      return { proceed: false, status: "policy-block", blockReason: "approver-not-authorized" };
    }
    return { proceed: true };
  }
  if (state === "expired") {
    return { proceed: false, status: "policy-block", blockReason: "approval-expired" };
  }
  return { proceed: false, status: "approval-required", approvers };
}
