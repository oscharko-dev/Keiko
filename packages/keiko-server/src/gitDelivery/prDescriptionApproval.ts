import type { GitDeliveryApprovalRequirement } from "@oscharko-dev/keiko-contracts";
import { PR_DESCRIPTION_APPLICATION_MAX_AGE_MS } from "@oscharko-dev/keiko-contracts/runtime/pr-description-application";
import {
  DEFAULT_GIT_DELIVERY_APPROVAL_STORE,
  GIT_DELIVERY_LOCAL_OPERATOR_ID,
  type GitDeliveryIssuedApproval,
  type GitDeliveryApprovalStore,
} from "./approvalStore.js";
import type { PreparedPrDescription } from "./prDescriptionTypes.js";

/** Transient one-use continuation of the existing approval store. No serialized lease or recovery authority. */
export class PrDescriptionApprovals {
  private leases = new WeakMap<
    object,
    { proposal: PreparedPrDescription; requirement: GitDeliveryApprovalRequirement }
  >();
  public constructor(
    private readonly store: GitDeliveryApprovalStore = DEFAULT_GIT_DELIVERY_APPROVAL_STORE,
  ) {}
  public issue(proposal: PreparedPrDescription, now: number): GitDeliveryIssuedApproval {
    const issued = this.store.issue({
      binding: proposal.approvalBinding,
      approvedByUserId: GIT_DELIVERY_LOCAL_OPERATOR_ID,
      nowMs: now,
      // One observation window from ISSUANCE, never whatever happens to be left of the proposal's
      // retention. #3390: with the retention window separated from the observation window, an
      // inherited remainder would silently lengthen the approval — the one place a longer retention
      // could have widened anything. Measuring from issuance is also stricter than the old
      // behaviour, where approving near the end of a preview yielded a one-second lease.
      ttlMs: Math.min(
        PR_DESCRIPTION_APPLICATION_MAX_AGE_MS,
        Date.parse(proposal.review.expiresAt) - now,
      ),
    });
    proposal.approval = issued.approval;
    return issued;
  }
  public matches(proposal: PreparedPrDescription, now: number): boolean {
    return (
      proposal.approval !== undefined &&
      this.store.matches({
        approval: proposal.approval,
        binding: proposal.approvalBinding,
        nowMs: now,
      })
    );
  }
  public consume(proposal: PreparedPrDescription, now: number): object | undefined {
    if (proposal.approval === undefined) return undefined;
    const requirement = this.store.consume({
      approval: proposal.approval,
      binding: proposal.approvalBinding,
      nowMs: now,
    });
    if (requirement === undefined) return undefined;
    const lease = Object.freeze({});
    this.leases.set(lease, { proposal, requirement });
    return lease;
  }
  public redeem(
    proposal: PreparedPrDescription,
    lease: object,
  ): GitDeliveryApprovalRequirement | undefined {
    const held = this.leases.get(lease);
    this.leases.delete(lease);
    return held?.proposal === proposal ? held.requirement : undefined;
  }
  public clear(): void {
    this.leases = new WeakMap();
  }
}
