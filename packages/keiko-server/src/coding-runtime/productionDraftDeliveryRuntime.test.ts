import { describe, expect, it } from "vitest";
import type { CodingRuntimeDeliveryResult } from "@oscharko-dev/keiko-contracts/runtime/coding-runtime-delivery";
import type { DraftDeliveryService } from "../gitDelivery/draftDeliveryTypes.js";
import type { ProductionManagedWorktreeToolInput } from "./productionManagedWorktreeTools.js";
import type { CodingToolMutationGuard } from "./codingToolFacadePorts.js";
import type { DraftToolRequest } from "./codingRuntimeDeliveryIpc.js";
import type { CodingWorkbenchRuntimeEvent } from "@oscharko-dev/keiko-contracts";
import {
  requestDraftDeliveryApproval,
  runDraftDeliveryRequest,
} from "./productionDraftDeliveryRuntime.js";

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

// #3610 (W12): the push and pull-request approval cards read "Scope: Not specified" and "Policy
// reason: Not specified"; the supervised policy's canonical builder states both for every action.
describe("draft delivery approval request", () => {
  it.each([
    ["push-proposed", "push"],
    ["pr-proposed", "pull-request"],
  ] as const)("states the scope and policy reason for a %s draft", (phase, actionKind) => {
    const events: CodingWorkbenchRuntimeEvent[] = [];
    const service = {
      review: () => ({
        record: {
          phase,
          binding: { runId: "run-delivery" },
          recordedAt: "2026-09-25T11:00:00.000Z",
        },
        expiresAtMs: Date.parse("2026-09-25T12:00:00.000Z"),
      }),
    } as unknown as DraftDeliveryService;
    requestDraftDeliveryApproval(service, "delivery-1", (event) => void events.push(event));
    expect(events[0]?.permissionRequest).toMatchObject({
      actionKind,
      scopeLabel: "workspace-scope",
      policyReason: "approval-required",
    });
  });
});
