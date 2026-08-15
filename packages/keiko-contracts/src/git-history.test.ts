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

  it.each(["sha", "shortSha", "subject", "author"] as const)(
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

// KEIKO-0310: entry.date is documented as "strict ISO 8601 (author date, %aI)" but was previously
// validated as any non-empty string. Confirmed empirically against the real git binary before
// writing these: a UTC-offset commit's `%aI` renders with a literal `Z`; every other offset renders
// numerically as `+HH:MM`/`-HH:MM` -- both must be accepted.
describe("entry.date strict ISO 8601 (KEIKO-0310)", () => {
  it("accepts both a UTC 'Z' date and a numeric-offset date", () => {
    expect(
      validateGitHistoryResponse({
        ...validResponse(),
        entries: [{ ...validEntry(), date: "2023-01-15T10:30:00Z" }],
      }),
    ).toEqual({ ok: true });
    expect(
      validateGitHistoryResponse({
        ...validResponse(),
        entries: [{ ...validEntry(), date: "2023-01-15T10:30:00-05:00" }],
      }),
    ).toEqual({ ok: true });
  });

  it.each([
    5,
    "2026-06-27 10:00:00Z",
    "2026-06-27T10:00:00",
    "2026-06-27T10:00:00.000Z",
    "2026-13-01T10:00:00Z",
    "2026-06-27T25:00:00Z",
    "not-a-date",
    "",
  ])("rejects %j as not strict ISO 8601", (date) => {
    const input = validResponse();
    input.entries = [{ ...validEntry(), date }];
    const result = validateGitHistoryResponse(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reasons).toContain("entries[0].date must be a strict ISO 8601 date");
    }
  });

  it("rejects a calendar-invalid date instead of silently rolling it over (Date.parse quirk)", () => {
    // Date.parse("2023-02-30...") does not return NaN -- it silently normalizes to March 2nd. The
    // validator checks the parsed calendar components instead of relying on parseability alone.
    const input = validResponse();
    input.entries = [{ ...validEntry(), date: "2023-02-30T10:00:00Z" }];
    const result = validateGitHistoryResponse(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reasons).toContain("entries[0].date must be a strict ISO 8601 date");
    }
  });
});

describe("optional envelope fields: reason, message, repositoryRoot (KEIKO-0310)", () => {
  it("accepts every declared unavailable reason alongside a bounded message", () => {
    for (const reason of [
      "not-a-repository",
      "git-missing",
      "repository-root-outside-root",
      "unknown",
      "unsafe-repository",
      "git-error",
    ] as const) {
      expect(
        validateGitHistoryResponse({
          ...validResponse(),
          available: false,
          reason,
          message: "Git history is unavailable for this folder.",
        }),
      ).toEqual({ ok: true });
    }
  });

  it("rejects a reason outside the closed union", () => {
    const result = validateGitHistoryResponse({
      ...validResponse(),
      reason: "not-a-known-reason",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasons).toContain("reason invalid");
  });

  it("rejects a non-string and an over-cap message", () => {
    expect(validateGitHistoryResponse({ ...validResponse(), message: 7 }).ok).toBe(false);
    expect(validateGitHistoryResponse({ ...validResponse(), message: "x".repeat(1_025) }).ok).toBe(
      false,
    );
  });

  it("rejects a non-string repositoryRoot", () => {
    const result = validateGitHistoryResponse({ ...validResponse(), repositoryRoot: 7 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reasons).toContain("repositoryRoot must be a string when present");
    }
  });
});

// KEIKO-0310: entries.length was never bounded against limit at all. The producer (keiko-server
// gitRepositoryReads.ts handleGitHistory) runs `git log --max-count=<limit>` and always sets
// `truncated = result.truncated || entries.length === limit`, so hitting the cap unconditionally
// implies truncated: true for every real response.
describe("entries bounded by limit, with truncated consistency (KEIKO-0310)", () => {
  it("rejects entries.length exceeding limit", () => {
    const input = validResponse();
    input.limit = 1;
    input.entries = [validEntry(), validEntry()];
    const result = validateGitHistoryResponse(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasons).toContain("entries.length must not exceed limit");
  });

  it("rejects entries.length equal to limit when truncated is false -- the exact case that used to pass", () => {
    const input = validResponse();
    input.limit = 1;
    input.entries = [validEntry()];
    input.truncated = false;
    const result = validateGitHistoryResponse(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reasons).toContain("truncated must be true when entries.length equals limit");
    }
  });

  it("accepts entries.length equal to limit when truncated is true", () => {
    const input = validResponse();
    input.limit = 1;
    input.entries = [validEntry()];
    input.truncated = true;
    expect(validateGitHistoryResponse(input)).toEqual({ ok: true });
  });

  it("accepts entries.length below limit with truncated false", () => {
    const input = validResponse();
    input.limit = 50;
    input.entries = [validEntry()];
    input.truncated = false;
    expect(validateGitHistoryResponse(input)).toEqual({ ok: true });
  });
});
