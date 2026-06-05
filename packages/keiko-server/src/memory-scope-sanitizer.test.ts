// Unit tests for memory-scope-sanitizer.ts (Issue #214 audit gaps).
// These are pure-function tests — no vault, no SQLite, no IO.

import { describe, expect, it } from "vitest";
import type {
  MemoryId,
  MemoryProjectId,
  MemoryUserId,
  MemoryWorkflowDefinitionId,
  MemoryWorkspaceId,
} from "@oscharko-dev/keiko-contracts";
import type { MemoryAuditEvent } from "@oscharko-dev/keiko-contracts";
import { createAuditRedactor } from "@oscharko-dev/keiko-evidence";
import {
  auditEventTouchesScope,
  memoryScopeKey,
  sanitizeAuditEvent,
  sanitizeMemoryScope,
} from "./memory-scope-sanitizer.js";

// ── Branding helpers ──────────────────────────────────────────────────────────
// Mirrors the pattern in memory-audit-handler.test.ts: cast through `unknown`
// to satisfy branded types without production logic.

function brandUserId(value: string): MemoryUserId {
  const u: unknown = value;
  return u as MemoryUserId;
}

function brandWorkspaceId(value: string): MemoryWorkspaceId {
  const u: unknown = value;
  return u as MemoryWorkspaceId;
}

function brandProjectId(value: string): MemoryProjectId {
  const u: unknown = value;
  return u as MemoryProjectId;
}

function brandWorkflowDefinitionId(value: string): MemoryWorkflowDefinitionId {
  const u: unknown = value;
  return u as MemoryWorkflowDefinitionId;
}

function brandMemoryId(value: string): MemoryId {
  const u: unknown = value;
  return u as MemoryId;
}

// Identity redactor: returns the same string unchanged, so maskedCoordinate falls
// through to the SHA-256 path.
function identityRedact(s: string): string {
  return s;
}

// A recognising redactor: returns "[REDACTED]" for a specific known value, mimicking
// the real audit redactor's behaviour when it matches a credential shape.
function recognisingRedact(knownValue: string) {
  return (s: string): string => (s === knownValue ? "[REDACTED]" : s);
}

// Shared minimal envelope required by every MemoryAuditEvent member.
const ENVELOPE = {
  schemaVersion: "1" as const,
  eventId: "evt-test-1",
  occurredAt: 1_750_000_000_000,
  initiatorSurface: "memory-center" as const,
  summary: "test summary",
};

// ── sanitizeMemoryScope ───────────────────────────────────────────────────────

describe("sanitizeMemoryScope", () => {
  describe("scope coordinate masking (identity redactor — SHA-256 path)", () => {
    it("masks the userId in a user scope", () => {
      const userId = "user-abc-123";
      const scope = { kind: "user" as const, userId: brandUserId(userId) };
      const result = sanitizeMemoryScope(scope, identityRedact);
      expect(result.kind).toBe("user");
      if (result.kind === "user") {
        expect(result.userId).not.toBe(userId);
        expect(result.userId).toMatch(/^\[redacted:[0-9a-f]{12}\]$/);
      }
    });

    it("masks the workspaceId in a workspace scope", () => {
      const workspaceId = "ws-xyz-789";
      const scope = {
        kind: "workspace" as const,
        workspaceId: brandWorkspaceId(workspaceId),
      };
      const result = sanitizeMemoryScope(scope, identityRedact);
      expect(result.kind).toBe("workspace");
      if (result.kind === "workspace") {
        expect(result.workspaceId).not.toBe(workspaceId);
        expect(result.workspaceId).toMatch(/^\[redacted:[0-9a-f]{12}\]$/);
      }
    });

    it("masks the projectId in a project scope", () => {
      const projectId = "proj-def-456";
      const scope = { kind: "project" as const, projectId: brandProjectId(projectId) };
      const result = sanitizeMemoryScope(scope, identityRedact);
      expect(result.kind).toBe("project");
      if (result.kind === "project") {
        expect(result.projectId).not.toBe(projectId);
        expect(result.projectId).toMatch(/^\[redacted:[0-9a-f]{12}\]$/);
      }
    });

    it("masks the workflowDefinitionId in a workflow scope", () => {
      const workflowDefinitionId = "workflow-ghi-012";
      const scope = {
        kind: "workflow" as const,
        workflowDefinitionId: brandWorkflowDefinitionId(workflowDefinitionId),
      };
      const result = sanitizeMemoryScope(scope, identityRedact);
      expect(result.kind).toBe("workflow");
      if (result.kind === "workflow") {
        expect(result.workflowDefinitionId).not.toBe(workflowDefinitionId);
        expect(result.workflowDefinitionId).toMatch(/^\[redacted:[0-9a-f]{12}\]$/);
      }
    });

    it("returns global scope unchanged (no coordinate to mask)", () => {
      const scope = { kind: "global" as const };
      const result = sanitizeMemoryScope(scope, identityRedact);
      expect(result).toStrictEqual({ kind: "global" });
    });
  });

  describe("redactString recognition path (redactor changes the value)", () => {
    it("uses the redactor output when the redactor recognises the userId", () => {
      const userId = "known-credential-user";
      const scope = { kind: "user" as const, userId: brandUserId(userId) };
      const result = sanitizeMemoryScope(scope, recognisingRedact(userId));
      expect(result.kind).toBe("user");
      if (result.kind === "user") {
        // Must use the redactor's output, NOT a SHA-256 hex digest.
        expect(result.userId).toBe("[REDACTED]");
      }
    });

    it("uses the SHA-256 digest when the redactor does NOT recognise the value", () => {
      const userId = "user-abc-123";
      const scope = { kind: "user" as const, userId: brandUserId(userId) };
      // Redactor only recognises a different value, so it returns `userId` unchanged.
      const result = sanitizeMemoryScope(scope, recognisingRedact("other-value"));
      expect(result.kind).toBe("user");
      if (result.kind === "user") {
        // The 12-char prefix of SHA-256("user-abc-123") is 25b4a3ce57a1.
        expect(result.userId).toBe("[redacted:25b4a3ce57a1]");
      }
    });
  });

  describe("SHA-256 digest is deterministic", () => {
    it("produces the same masked coordinate on repeated calls for the same input", () => {
      const userId = "stable-user-id";
      const scope = { kind: "user" as const, userId: brandUserId(userId) };
      const first = sanitizeMemoryScope(scope, identityRedact);
      const second = sanitizeMemoryScope(scope, identityRedact);
      if (first.kind === "user" && second.kind === "user") {
        expect(first.userId).toBe(second.userId);
      }
    });
  });
});

// ── memoryScopeKey ────────────────────────────────────────────────────────────

describe("memoryScopeKey", () => {
  it("returns 'user:{userId}' for a user scope", () => {
    const userId = "u-42";
    const scope = { kind: "user" as const, userId: brandUserId(userId) };
    expect(memoryScopeKey(scope)).toBe("user:u-42");
  });

  it("returns 'workspace:{workspaceId}' for a workspace scope", () => {
    const workspaceId = "ws-99";
    const scope = { kind: "workspace" as const, workspaceId: brandWorkspaceId(workspaceId) };
    expect(memoryScopeKey(scope)).toBe("workspace:ws-99");
  });

  it("returns 'project:{projectId}' for a project scope", () => {
    const projectId = "proj-17";
    const scope = { kind: "project" as const, projectId: brandProjectId(projectId) };
    expect(memoryScopeKey(scope)).toBe("project:proj-17");
  });

  it("returns 'workflow:{workflowDefinitionId}' for a workflow scope", () => {
    const workflowDefinitionId = "wf-def-5";
    const scope = {
      kind: "workflow" as const,
      workflowDefinitionId: brandWorkflowDefinitionId(workflowDefinitionId),
    };
    expect(memoryScopeKey(scope)).toBe("workflow:wf-def-5");
  });

  it("returns 'global' for the global scope", () => {
    const scope = { kind: "global" as const };
    expect(memoryScopeKey(scope)).toBe("global");
  });
});

// ── sanitizeAuditEvent ────────────────────────────────────────────────────────

describe("sanitizeAuditEvent", () => {
  it("sanitizes the scope coordinate in a single-scope event (memory:proposed)", () => {
    const userId = "raw-user-id-proposed";
    const event: MemoryAuditEvent = {
      ...ENVELOPE,
      kind: "memory:proposed",
      memoryId: brandMemoryId("mem-1"),
      scope: { kind: "user", userId: brandUserId(userId) },
    };
    const result = sanitizeAuditEvent(event, identityRedact);
    // Raw userId must not appear anywhere in the sanitized event's JSON.
    expect(JSON.stringify(result)).not.toContain(userId);
    expect(result.kind).toBe("memory:proposed");
    if (result.kind === "memory:proposed") {
      expect(result.scope.kind).toBe("user");
    }
  });

  it("sanitizes each scope in the scopes array of memory:retrieved", () => {
    const userId1 = "raw-user-id-retrieved-1";
    const userId2 = "raw-user-id-retrieved-2";
    const event: MemoryAuditEvent = {
      ...ENVELOPE,
      kind: "memory:retrieved",
      scopes: [
        { kind: "user", userId: brandUserId(userId1) },
        { kind: "user", userId: brandUserId(userId2) },
      ],
      matchedMemoryIds: [brandMemoryId("mem-2")],
    };
    const result = sanitizeAuditEvent(event, identityRedact);
    const json = JSON.stringify(result);
    expect(json).not.toContain(userId1);
    expect(json).not.toContain(userId2);
    expect(result.kind).toBe("memory:retrieved");
    if (result.kind === "memory:retrieved") {
      // Both scopes should be present but with masked coordinates.
      expect(result.scopes).toHaveLength(2);
      for (const scope of result.scopes) {
        expect(scope.kind).toBe("user");
        if (scope.kind === "user") {
          expect(scope.userId).toMatch(/^\[redacted:[0-9a-f]{12}\]$/);
        }
      }
    }
  });

  it("returns memory:workflow-used unchanged (no scope coordinates to mask)", () => {
    const workflowRunId = "run-abc-workflow";
    const usedMemoryIds: readonly MemoryId[] = [
      brandMemoryId("mem-wf-1"),
      brandMemoryId("mem-wf-2"),
    ];
    const event: MemoryAuditEvent = {
      ...ENVELOPE,
      kind: "memory:workflow-used",
      workflowRunId,
      usedMemoryIds,
    };
    const result = sanitizeAuditEvent(event, identityRedact);
    expect(result.kind).toBe("memory:workflow-used");
    if (result.kind === "memory:workflow-used") {
      expect(result.workflowRunId).toBe(workflowRunId);
      expect(result.usedMemoryIds).toStrictEqual(usedMemoryIds);
    }
  });

  it("redacts a credential-shaped token in the summary field (M1 hardening — direct emitter path)", () => {
    // Use createAuditRedactor so the real secret-pattern engine runs.
    const secret = ["sk-", "proj", "_", "secret12345678901234"].join("");
    const redact = createAuditRedactor({ additionalSecrets: [secret] }, {});
    const event: MemoryAuditEvent = {
      ...ENVELOPE,
      summary: `workflow retrieved memory with key ${secret}`,
      kind: "memory:retrieved",
      scopes: [{ kind: "user", userId: brandUserId("u-m1") }],
      matchedMemoryIds: [brandMemoryId("mem-m1")],
    };
    const result = sanitizeAuditEvent(event, redact);
    expect(result.summary).not.toContain(secret);
    expect(result.kind).toBe("memory:retrieved");
  });
});

// ── auditEventTouchesScope ────────────────────────────────────────────────────

describe("auditEventTouchesScope", () => {
  const userId = brandUserId("u-touch-1");
  const userScope = { kind: "user" as const, userId };

  it("returns true when the single-scope event's scope key is in the allowed set", () => {
    const event: MemoryAuditEvent = {
      ...ENVELOPE,
      kind: "memory:proposed",
      memoryId: brandMemoryId("mem-touch-1"),
      scope: userScope,
    };
    const allowed = new Set<string>(["user:u-touch-1"]) as ReadonlySet<string>;
    expect(auditEventTouchesScope(event, allowed)).toBe(true);
  });

  it("returns false when the single-scope event's scope key is NOT in the allowed set", () => {
    const event: MemoryAuditEvent = {
      ...ENVELOPE,
      kind: "memory:proposed",
      memoryId: brandMemoryId("mem-touch-2"),
      scope: userScope,
    };
    const allowed = new Set<string>(["user:u-other"]) as ReadonlySet<string>;
    expect(auditEventTouchesScope(event, allowed)).toBe(false);
  });

  it("returns true for memory:retrieved when at least one scope key is in the allowed set", () => {
    const userId2 = brandUserId("u-touch-2");
    const event: MemoryAuditEvent = {
      ...ENVELOPE,
      kind: "memory:retrieved",
      scopes: [userScope, { kind: "user", userId: userId2 }],
      matchedMemoryIds: [brandMemoryId("mem-touch-3")],
    };
    // Only the second user is in the allowed set.
    const allowed = new Set<string>(["user:u-touch-2"]) as ReadonlySet<string>;
    expect(auditEventTouchesScope(event, allowed)).toBe(true);
  });

  it("returns false for memory:retrieved when no scope key is in the allowed set", () => {
    const userId2 = brandUserId("u-touch-2");
    const event: MemoryAuditEvent = {
      ...ENVELOPE,
      kind: "memory:retrieved",
      scopes: [userScope, { kind: "user", userId: userId2 }],
      matchedMemoryIds: [brandMemoryId("mem-touch-4")],
    };
    const allowed = new Set<string>(["user:u-unrelated"]) as ReadonlySet<string>;
    expect(auditEventTouchesScope(event, allowed)).toBe(false);
  });

  it("always returns false for memory:workflow-used regardless of content", () => {
    const event: MemoryAuditEvent = {
      ...ENVELOPE,
      kind: "memory:workflow-used",
      workflowRunId: "run-wf-touch",
      usedMemoryIds: [brandMemoryId("mem-touch-5")],
    };
    // Even with a superset of keys the result must be false.
    const allowed = new Set<string>([
      "user:u-touch-1",
      "run-wf-touch",
      "global",
    ]) as ReadonlySet<string>;
    expect(auditEventTouchesScope(event, allowed)).toBe(false);
  });

  it("returns false for memory:workflow-used when the allowed set is empty", () => {
    const event: MemoryAuditEvent = {
      ...ENVELOPE,
      kind: "memory:workflow-used",
      workflowRunId: "run-wf-empty",
      usedMemoryIds: [],
    };
    const allowed = new Set<string>() as ReadonlySet<string>;
    expect(auditEventTouchesScope(event, allowed)).toBe(false);
  });
});
