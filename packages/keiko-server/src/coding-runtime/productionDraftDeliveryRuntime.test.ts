import { describe, expect, it } from "vitest";
import type { CodingRuntimeDeliveryResult } from "@oscharko-dev/keiko-contracts/runtime/coding-runtime-delivery";
import type { DraftDeliveryService } from "../gitDelivery/draftDeliveryTypes.js";
import type { ProductionManagedWorktreeToolInput } from "./productionManagedWorktreeTools.js";
import type { CodingToolMutationGuard } from "./codingToolFacadePorts.js";
import type { DraftToolRequest } from "./codingRuntimeDeliveryIpc.js";
import { runDraftDeliveryRequest } from "./productionDraftDeliveryRuntime.js";

function unavailableService(result: CodingRuntimeDeliveryResult): DraftDeliveryService {
  return {
    proposePush: () => Promise.resolve(result),
    proposePullRequest: () => Promise.resolve(result),
    reconcile: () => Promise.resolve(result),
    review: () => undefined,
    issueApproval: () => undefined,
    matchesApproval: () => false,
    consumeApproval: () => undefined,
    executeApproved: () => Promise.resolve(result),
    invalidate: () => undefined,
  };
}

const reconcileRequest: DraftToolRequest = {
  action: "delivery",
  actionId: "delivery-action-1",
  idempotencyKey: "delivery-key-1",
  intent: "push",
  phase: "reconcile",
};

const guard: CodingToolMutationGuard = { check: () => true };

describe("production draft-delivery runtime", () => {
  it("projects an unavailable delivery result as a governed failure", async () => {
    const result: CodingRuntimeDeliveryResult = {
      status: "unavailable",
      reason: "proposal-unavailable",
    };
    const input = {
      draftDeliveryService: unavailableService(result),
    } as ProductionManagedWorktreeToolInput;

    await expect(
      runDraftDeliveryRequest(input, reconcileRequest, guard, undefined),
    ).resolves.toEqual({
      status: "failed",
      reasonCode: "proposal-unavailable",
    });
  });
});
