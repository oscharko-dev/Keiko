// Hermetic tests for the bounded pending-approval registry (Issue #2244): injected clock (no
// wall-clock races), TTL eviction, capacity, and single-use consumption.

import { describe, expect, it } from "vitest";
import {
  ATLASSIAN_APPROVAL_CONTENT_PREVIEW_MAX_CHARS,
  type AtlassianConnectorPendingApproval,
} from "@oscharko-dev/keiko-contracts";
import {
  ATLASSIAN_ACTION_APPROVAL_MAX_PENDING,
  ATLASSIAN_ACTION_APPROVAL_TTL_MS,
  AtlassianActionApprovalRegistry,
  contentPreviewFor,
  type AtlassianWriteActionInput,
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

// KEIKO-0186: the pure extraction the pending-approval wire projection derives its bounded
// content preview from. Every write-action variant, plus the two hostile-input axes the finding
// calls out explicitly: overlong input and control characters.
describe("contentPreviewFor", () => {
  it("combines summary and descriptionText for create-issue", () => {
    const action: AtlassianWriteActionInput = {
      type: "create-issue",
      projectKey: "PROJ",
      summary: "Fix the flaky gate",
      descriptionText: "Fails on retries",
    };
    expect(contentPreviewFor(action)).toBe("Fix the flaky gate\n\nFails on retries");
  });

  it("uses summary alone for create-issue when descriptionText is absent", () => {
    const action: AtlassianWriteActionInput = {
      type: "create-issue",
      projectKey: "PROJ",
      summary: "Fix the flaky gate",
    };
    expect(contentPreviewFor(action)).toBe("Fix the flaky gate");
  });

  it("combines summary and descriptionText for update-issue-fields when both are present", () => {
    const action: AtlassianWriteActionInput = {
      type: "update-issue-fields",
      issueKey: "PROJ-9",
      summary: "Sharper",
      descriptionText: "Clarified acceptance criteria",
    };
    expect(contentPreviewFor(action)).toBe("Sharper\n\nClarified acceptance criteria");
  });

  it("returns undefined for update-issue-fields when neither summary nor descriptionText is set", () => {
    const action: AtlassianWriteActionInput = {
      type: "update-issue-fields",
      issueKey: "PROJ-9",
      labels: ["urgent"],
      priorityName: "High",
    };
    expect(contentPreviewFor(action)).toBeUndefined();
  });

  it("always returns undefined for transition-issue (no text field exists)", () => {
    const action: AtlassianWriteActionInput = {
      type: "transition-issue",
      issueKey: "PROJ-9",
      transitionId: "31",
    };
    expect(contentPreviewFor(action)).toBeUndefined();
  });

  it("uses commentText for add-issue-comment and add-page-comment", () => {
    expect(
      contentPreviewFor({
        type: "add-issue-comment",
        issueKey: "PROJ-9",
        commentText: "Verified on staging",
      }),
    ).toBe("Verified on staging");
    expect(
      contentPreviewFor({
        type: "add-page-comment",
        pageId: "123",
        commentText: "Looks right",
      }),
    ).toBe("Looks right");
  });

  it("combines title and bodyText for create-page and update-page", () => {
    expect(
      contentPreviewFor({
        type: "create-page",
        spaceId: "777",
        title: "Runbook",
        bodyText: "Steps here",
      }),
    ).toBe("Runbook\n\nSteps here");
    expect(
      contentPreviewFor({
        type: "update-page",
        pageId: "123",
        title: "Runbook",
        bodyText: "New body",
        currentVersion: 4,
      }),
    ).toBe("Runbook\n\nNew body");
  });

  it("truncates to exactly ATLASSIAN_APPROVAL_CONTENT_PREVIEW_MAX_CHARS when the combined text is longer", () => {
    const summary = "S".repeat(200);
    const descriptionText = "D".repeat(200);
    const preview = contentPreviewFor({
      type: "create-issue",
      projectKey: "PROJ",
      summary,
      descriptionText,
    });
    expect(preview).toBeDefined();
    expect(preview).toHaveLength(ATLASSIAN_APPROVAL_CONTENT_PREVIEW_MAX_CHARS);
    // The combined, untruncated text is exactly the prefix this preview equals.
    const combined = `${summary}\n\n${descriptionText}`;
    expect(preview).toBe(combined.slice(0, ATLASSIAN_APPROVAL_CONTENT_PREVIEW_MAX_CHARS));
  });

  it("strips a real control character (BELL, U+0007) before bounding, never surfacing it", () => {
    const hostileSummary = `visible\u0007bell`;
    const preview = contentPreviewFor({
      type: "create-issue",
      projectKey: "PROJ",
      summary: hostileSummary,
    });
    expect(preview).toBe("visiblebell");
  });

  it("strips a bidi override character (RIGHT-TO-LEFT OVERRIDE, U+202E) before bounding, never surfacing it", () => {
    const hostileSummary = `visible\u202Eevil`;
    const preview = contentPreviewFor({
      type: "create-issue",
      projectKey: "PROJ",
      summary: hostileSummary,
    });
    expect(preview).toBe("visibleevil");
  });

  it("strips a zero-width space (U+200B) before bounding, never surfacing it", () => {
    const hostileSummary = `visible\u200Bzerowidth`;
    const preview = contentPreviewFor({
      type: "create-issue",
      projectKey: "PROJ",
      summary: hostileSummary,
    });
    expect(preview).toBe("visiblezerowidth");
  });

  it("preserves TAB/LF/CR (legitimate multi-line formatting) while stripping other control characters", () => {
    const preview = contentPreviewFor({
      type: "create-page",
      spaceId: "777",
      title: "Runbook",
      bodyText: "Step 1\tdo this\nStep 2\r\ndo that",
    });
    expect(preview).toBe("Runbook\n\nStep 1\tdo this\nStep 2\r\ndo that");
  });

  it("an oversized AND hostile payload is both stripped and truncated to the bound", () => {
    const hostile = `\u202EA${"x".repeat(ATLASSIAN_APPROVAL_CONTENT_PREVIEW_MAX_CHARS + 500)}`;
    const preview = contentPreviewFor({
      type: "add-issue-comment",
      issueKey: "PROJ-9",
      commentText: hostile,
    });
    expect(preview).toBeDefined();
    expect(preview).toHaveLength(ATLASSIAN_APPROVAL_CONTENT_PREVIEW_MAX_CHARS);
    expect(preview).toBe(`A${"x".repeat(ATLASSIAN_APPROVAL_CONTENT_PREVIEW_MAX_CHARS - 1)}`);
  });
});
