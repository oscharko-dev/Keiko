import { describe, expect, it } from "vitest";
import {
  GIT_SYNC_OUTCOMES,
  GIT_SYNC_SCHEMA_VERSION,
  isGitSyncOperation,
  isGitSyncOutcome,
  validateGitSyncExecuteResponse,
  validateGitSyncPreview,
} from "./git-sync.js";

function validPreview(): Record<string, unknown> {
  return {
    schemaVersion: GIT_SYNC_SCHEMA_VERSION,
    operation: "pull",
    available: true,
    state: "available",
    branch: "main",
    detached: false,
    upstream: { ref: "origin/main", remote: "origin", branch: "main" },
    remote: "origin",
    ahead: 0,
    behind: 3,
    hasRemote: true,
    hasUpstream: true,
    dirty: false,
    executable: true,
  };
}

function validExecute(): Record<string, unknown> {
  return {
    schemaVersion: GIT_SYNC_SCHEMA_VERSION,
    operation: "fetch",
    status: "succeeded",
    available: true,
    branch: "main",
    upstream: { ref: "origin/main" },
    remote: "origin",
    ahead: 0,
    behind: 0,
    truncated: false,
  };
}

describe("isGitSyncOperation", () => {
  it.each(["fetch", "pull"] as const)("accepts %s", (op) => {
    expect(isGitSyncOperation(op)).toBe(true);
  });

  it.each(["push", "clone", "", 5, null, undefined])("rejects %s", (value) => {
    expect(isGitSyncOperation(value)).toBe(false);
  });
});

describe("isGitSyncOutcome", () => {
  it("accepts every member of the taxonomy", () => {
    for (const outcome of GIT_SYNC_OUTCOMES) {
      expect(isGitSyncOutcome(outcome)).toBe(true);
    }
  });

  it("has exactly twelve outcomes", () => {
    expect(GIT_SYNC_OUTCOMES).toHaveLength(12);
  });

  it.each(["ok", "failed", "", 0, null, undefined])("rejects %s", (value) => {
    expect(isGitSyncOutcome(value)).toBe(false);
  });
});

describe("validateGitSyncPreview", () => {
  it("accepts a ready pull preview", () => {
    expect(validateGitSyncPreview(validPreview())).toEqual({ ok: true });
  });

  it("accepts a blocked preview with a block reason", () => {
    const input = { ...validPreview(), executable: false, blockReason: "no-upstream" };
    expect(validateGitSyncPreview(input)).toEqual({ ok: true });
  });

  it("rejects a non-object", () => {
    const result = validateGitSyncPreview(7);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasons).toContain("response must be an object");
  });

  it("rejects an invalid schemaVersion", () => {
    const result = validateGitSyncPreview({ ...validPreview(), schemaVersion: "2" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasons).toContain("schemaVersion invalid");
  });

  it("rejects an invalid operation", () => {
    const result = validateGitSyncPreview({ ...validPreview(), operation: "push" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasons).toContain("operation invalid");
  });

  it("rejects an invalid state", () => {
    const result = validateGitSyncPreview({ ...validPreview(), state: "bogus" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasons).toContain("state invalid");
  });

  it.each(["available", "detached", "hasRemote", "hasUpstream", "dirty", "executable"] as const)(
    "rejects a non-boolean %s",
    (key) => {
      const result = validateGitSyncPreview({ ...validPreview(), [key]: "x" });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reasons).toContain(`${key} must be a boolean`);
    },
  );

  it.each(["ahead", "behind"] as const)("rejects a negative %s", (key) => {
    const result = validateGitSyncPreview({ ...validPreview(), [key]: -1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasons).toContain(`${key} must be a non-negative integer`);
  });

  it("rejects an invalid blockReason", () => {
    const result = validateGitSyncPreview({ ...validPreview(), blockReason: "bogus" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasons).toContain("blockReason invalid");
  });
});

describe("validateGitSyncExecuteResponse", () => {
  it("accepts a populated execute response", () => {
    expect(validateGitSyncExecuteResponse(validExecute())).toEqual({ ok: true });
  });

  it("accepts an execute response with optional fields omitted", () => {
    const input = validExecute();
    delete input.branch;
    delete input.upstream;
    delete input.remote;
    delete input.ahead;
    delete input.behind;
    expect(validateGitSyncExecuteResponse(input)).toEqual({ ok: true });
  });

  it("rejects a non-object", () => {
    const result = validateGitSyncExecuteResponse([]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasons).toContain("response must be an object");
  });

  it("rejects an invalid schemaVersion", () => {
    const result = validateGitSyncExecuteResponse({ ...validExecute(), schemaVersion: "3" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasons).toContain("schemaVersion invalid");
  });

  it("rejects an invalid operation", () => {
    const result = validateGitSyncExecuteResponse({ ...validExecute(), operation: "rebase" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasons).toContain("operation invalid");
  });

  it("rejects an invalid status", () => {
    const result = validateGitSyncExecuteResponse({ ...validExecute(), status: "done" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasons).toContain("status invalid");
  });

  it("rejects a non-boolean available", () => {
    const result = validateGitSyncExecuteResponse({ ...validExecute(), available: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasons).toContain("available must be a boolean");
  });

  it("rejects a non-boolean truncated", () => {
    const result = validateGitSyncExecuteResponse({ ...validExecute(), truncated: "no" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasons).toContain("truncated must be a boolean");
  });

  it.each(["ahead", "behind"] as const)("rejects a negative %s when present", (key) => {
    const result = validateGitSyncExecuteResponse({ ...validExecute(), [key]: -1 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reasons).toContain(`${key} must be a non-negative integer when present`);
    }
  });

  it.each(["branch", "remote"] as const)("rejects a non-string %s when present", (key) => {
    const result = validateGitSyncExecuteResponse({ ...validExecute(), [key]: 5 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasons).toContain(`${key} must be a string when present`);
  });
});
