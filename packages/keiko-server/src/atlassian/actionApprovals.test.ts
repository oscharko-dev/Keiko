// Hermetic tests for the bounded pending-approval registry (Issue #2244): injected clock (no
// wall-clock races), TTL eviction, capacity, and single-use consumption.

import { describe, expect, it } from "vitest";
import type { AtlassianConnectorPendingApproval } from "@oscharko-dev/keiko-contracts";
import {
  ATLASSIAN_ACTION_APPROVAL_MAX_PENDING,
  ATLASSIAN_ACTION_APPROVAL_TTL_MS,
  AtlassianActionApprovalRegistry,
  type PendingAtlassianActionEntry,
} from "./actionApprovals.js";

const T0 = 1_700_000_000_000;

function approval(approvalId: string, requestedAt = T0): AtlassianConnectorPendingApproval {
  return {
    schemaVersion: "1",
    approvalId,
    connectorId: "cred-abc",
    provider: "jira",
    actionType: "create-issue",
    actionClass: "connector-write",
    requiredScope: "issue-tracker.write",
    risk: "high",
    reviewReason: "deterministic-risk-approval-required",
    targetRef: "PROJ",
    correlationId: `corr-${approvalId}`,
    requestedAt,
    expiresAt: requestedAt + ATLASSIAN_ACTION_APPROVAL_TTL_MS,
  };
}

function entry(approvalId: string, requestedAt = T0): PendingAtlassianActionEntry {
  return {
    approval: approval(approvalId, requestedAt),
    authority: { runId: "run-1", envelopeDigest: "d".repeat(64), workspaceRoot: "/repo" },
    authRef: "atlassian-cred:AbCdEfGhIjKlMnOpQrStUv",
    payload: {
      kind: "write-action",
      action: {
        type: "create-issue",
        projectKey: "PROJ",
        issueTypeId: "1",
        summary: "held server-side only",
      },
    },
  };
}

describe("AtlassianActionApprovalRegistry", () => {
  it("stores, lists, and single-use-consumes entries", () => {
    const registry = new AtlassianActionApprovalRegistry(() => T0);
    expect(registry.create(entry("a1"))).toEqual({ ok: true });
    expect(registry.listPending().map((item) => item.approvalId)).toEqual(["a1"]);
    expect(registry.get("a1")?.approval.approvalId).toBe("a1");
    expect(registry.consume("a1")?.approval.approvalId).toBe("a1");
    expect(registry.consume("a1")).toBeUndefined();
    expect(registry.listPending()).toEqual([]);
  });

  it("evicts expired entries on every operation: an expired approval is unresolvable", () => {
    let now = T0;
    const registry = new AtlassianActionApprovalRegistry(() => now);
    registry.create(entry("a1"));
    now = T0 + ATLASSIAN_ACTION_APPROVAL_TTL_MS - 1;
    expect(registry.get("a1")).toBeDefined();
    now = T0 + ATLASSIAN_ACTION_APPROVAL_TTL_MS;
    expect(registry.get("a1")).toBeUndefined();
    expect(registry.consume("a1")).toBeUndefined();
    expect(registry.reject("a1")).toBeUndefined();
    expect(registry.listPending()).toEqual([]);
  });

  it("is bounded: refuses past capacity and frees capacity through expiry", () => {
    let now = T0;
    const registry = new AtlassianActionApprovalRegistry(() => now);
    for (let index = 0; index < ATLASSIAN_ACTION_APPROVAL_MAX_PENDING; index += 1) {
      expect(registry.create(entry(`a${String(index)}`)).ok).toBe(true);
    }
    expect(registry.create(entry("overflow"))).toEqual({
      ok: false,
      reason: "capacity-exhausted",
    });
    now = T0 + ATLASSIAN_ACTION_APPROVAL_TTL_MS + 1;
    expect(registry.create(entry("after-expiry", now)).ok).toBe(true);
  });

  it("reject removes the entry exactly like consume (never executable afterwards)", () => {
    const registry = new AtlassianActionApprovalRegistry(() => T0);
    registry.create(entry("a1"));
    expect(registry.reject("a1")?.approval.approvalId).toBe("a1");
    expect(registry.consume("a1")).toBeUndefined();
  });

  it("reset clears all state (test isolation seam)", () => {
    const registry = new AtlassianActionApprovalRegistry(() => T0);
    registry.create(entry("a1"));
    registry.reset();
    expect(registry.listPending()).toEqual([]);
  });
});
