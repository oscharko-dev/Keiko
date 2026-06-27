import { describe, expect, it } from "vitest";
import { GIT_HISTORY_SCHEMA_VERSION, validateGitHistoryResponse } from "./git-history.js";

function validEntry(): Record<string, unknown> {
  return {
    sha: "0123456789abcdef0123456789abcdef01234567",
    shortSha: "0123456",
    subject: "Initial commit",
    author: "Ada Lovelace",
    date: "2026-06-27T10:00:00+02:00",
    refs: ["HEAD -> main", "origin/main"],
    parentCount: 1,
    changedFileCount: 3,
  };
}

function validResponse(): Record<string, unknown> {
  return {
    schemaVersion: GIT_HISTORY_SCHEMA_VERSION,
    root: "/repo",
    repositoryRoot: "/repo",
    state: "available",
    available: true,
    entries: [validEntry()],
    limit: 50,
    skip: 0,
    truncated: false,
  };
}

describe("validateGitHistoryResponse", () => {
  it("accepts a fully populated history response", () => {
    expect(validateGitHistoryResponse(validResponse())).toEqual({ ok: true });
  });

  it("accepts an empty-history response (no commits)", () => {
    const input = validResponse();
    input.entries = [];
    expect(validateGitHistoryResponse(input)).toEqual({ ok: true });
  });

  it("accepts a merge entry with two parents and zero changed files", () => {
    const input = validResponse();
    input.entries = [{ ...validEntry(), parentCount: 2, changedFileCount: 0 }];
    expect(validateGitHistoryResponse(input)).toEqual({ ok: true });
  });

  it("rejects a non-object", () => {
    const result = validateGitHistoryResponse(null);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasons).toContain("response must be an object");
  });

  it("rejects an invalid schemaVersion", () => {
    const result = validateGitHistoryResponse({ ...validResponse(), schemaVersion: "0" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasons).toContain("schemaVersion invalid");
  });

  it("rejects an invalid state", () => {
    const result = validateGitHistoryResponse({ ...validResponse(), state: "bogus" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasons).toContain("state invalid");
  });

  it("rejects a non-boolean available", () => {
    const result = validateGitHistoryResponse({ ...validResponse(), available: "yes" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasons).toContain("available must be a boolean");
  });

  it("rejects a non-boolean truncated", () => {
    const result = validateGitHistoryResponse({ ...validResponse(), truncated: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasons).toContain("truncated must be a boolean");
  });

  it.each(["limit", "skip"] as const)("rejects a negative %s", (key) => {
    const result = validateGitHistoryResponse({ ...validResponse(), [key]: -1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasons).toContain(`${key} must be a non-negative integer`);
  });

  it("rejects a non-array entries", () => {
    const result = validateGitHistoryResponse({ ...validResponse(), entries: "nope" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasons).toContain("entries must be an array");
  });

  it("rejects a non-object entry", () => {
    const result = validateGitHistoryResponse({ ...validResponse(), entries: ["x"] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasons).toContain("entries[0] must be an object");
  });

  it.each(["sha", "shortSha", "subject", "author", "date"] as const)(
    "rejects a non-string entry.%s",
    (key) => {
      const input = validResponse();
      input.entries = [{ ...validEntry(), [key]: 5 }];
      const result = validateGitHistoryResponse(input);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reasons).toContain(`entries[0].${key} must be a string`);
    },
  );

  it.each(["parentCount", "changedFileCount"] as const)("rejects a negative entry.%s", (key) => {
    const input = validResponse();
    input.entries = [{ ...validEntry(), [key]: -2 }];
    const result = validateGitHistoryResponse(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reasons).toContain(`entries[0].${key} must be a non-negative integer`);
    }
  });

  it("rejects a non-array entry.refs", () => {
    const input = validResponse();
    input.entries = [{ ...validEntry(), refs: "main" }];
    const result = validateGitHistoryResponse(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasons).toContain("entries[0].refs must be an array");
  });

  it("rejects entry.refs containing a non-string", () => {
    const input = validResponse();
    input.entries = [{ ...validEntry(), refs: ["main", 7] }];
    const result = validateGitHistoryResponse(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasons).toContain("entries[0].refs must contain only strings");
  });
});
