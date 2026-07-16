import { describe, expect, it } from "vitest";
import {
  createInMemorySupervisedCodingApprovalStore,
  type SupervisedCodingApprovalBinding,
} from "./supervisedCodingApprovalStore.js";

const binding = (runId: string, requestId: string): SupervisedCodingApprovalBinding => ({
  runId,
  requestId,
  actionKind: "system-mutation" as const,
  scopeDigest: "a".repeat(64),
  connectorScopes: [],
});

describe("SupervisedCodingApprovalStore", () => {
  it("invalidates outstanding approvals for only the requested run", () => {
    const store = createInMemorySupervisedCodingApprovalStore();
    const first = store.issue({
      binding: binding("run-1", "request-1"),
      approvedByUserId: "user",
      nowMs: 1,
    });
    const second = store.issue({
      binding: binding("run-2", "request-2"),
      approvedByUserId: "user",
      nowMs: 1,
    });

    store.invalidateRun("run-1");

    expect(
      store.consume({ approval: first.approval, binding: binding("run-1", "request-1"), nowMs: 2 }),
    ).toBeUndefined();
    expect(
      store.consume({
        approval: second.approval,
        binding: binding("run-2", "request-2"),
        nowMs: 2,
      }),
    ).toMatchObject({ approvedByUserId: "user" });
  });
});
