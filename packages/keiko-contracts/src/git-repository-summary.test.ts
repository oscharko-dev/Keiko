import { describe, expect, it } from "vitest";
import {
  GIT_REPOSITORY_SUMMARY_SCHEMA_VERSION,
  validateGitRemotesResponse,
  validateGitRepositorySummary,
} from "./git-repository-summary.js";

function validSummary(): Record<string, unknown> {
  return {
    schemaVersion: GIT_REPOSITORY_SUMMARY_SCHEMA_VERSION,
    root: "/repo",
    repositoryRoot: "/repo",
    state: "available",
    available: true,
    branch: "main",
    detached: false,
    upstream: { ref: "origin/main", remote: "origin", branch: "main" },
    ahead: 2,
    behind: 1,
    stagedCount: 1,
    unstagedCount: 2,
    untrackedCount: 0,
    conflictedCount: 0,
    clean: false,
    remotes: [{ name: "origin" }],
    lastSync: { lastFetchAtMs: 1700000000000 },
    truncated: false,
  };
}

function validRemotes(): Record<string, unknown> {
  return {
    schemaVersion: GIT_REPOSITORY_SUMMARY_SCHEMA_VERSION,
    root: "/repo",
    repositoryRoot: "/repo",
    state: "available",
    available: true,
    remotes: [{ name: "origin", fetchUrl: "u", pushUrl: "u" }],
    truncated: false,
  };
}

describe("validateGitRepositorySummary", () => {
  it("accepts a fully populated summary", () => {
    expect(validateGitRepositorySummary(validSummary())).toEqual({ ok: true });
  });

  it("accepts a summary with optional fields omitted (no upstream, no lastSync)", () => {
    const input = validSummary();
    delete input.upstream;
    delete input.lastSync;
    delete input.repositoryRoot;
    delete input.branch;
    expect(validateGitRepositorySummary(input)).toEqual({ ok: true });
  });

  it("rejects a non-object", () => {
    const result = validateGitRepositorySummary("nope");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasons).toContain("response must be an object");
  });

  it("rejects an invalid schemaVersion", () => {
    const result = validateGitRepositorySummary({ ...validSummary(), schemaVersion: "2" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasons).toContain("schemaVersion invalid");
  });

  it("rejects an invalid state", () => {
    const result = validateGitRepositorySummary({ ...validSummary(), state: "bogus" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasons).toContain("state invalid");
  });

  it.each(["available", "detached", "clean", "truncated"] as const)(
    "rejects a non-boolean %s",
    (key) => {
      const result = validateGitRepositorySummary({ ...validSummary(), [key]: "yes" });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reasons).toContain(`${key} must be a boolean`);
    },
  );

  it.each([
    "ahead",
    "behind",
    "stagedCount",
    "unstagedCount",
    "untrackedCount",
    "conflictedCount",
  ] as const)("rejects a negative %s", (key) => {
    const result = validateGitRepositorySummary({ ...validSummary(), [key]: -1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasons).toContain(`${key} must be a non-negative integer`);
  });

  it.each([
    "ahead",
    "behind",
    "stagedCount",
    "unstagedCount",
    "untrackedCount",
    "conflictedCount",
  ] as const)("rejects a non-integer %s", (key) => {
    const result = validateGitRepositorySummary({ ...validSummary(), [key]: 1.5 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasons).toContain(`${key} must be a non-negative integer`);
  });

  it("rejects a non-string root", () => {
    const result = validateGitRepositorySummary({ ...validSummary(), root: 42 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasons).toContain("root must be a string");
  });

  it("rejects a non-array remotes", () => {
    const result = validateGitRepositorySummary({ ...validSummary(), remotes: {} });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasons).toContain("remotes must be an array");
  });

  it("rejects a remote with a non-string name", () => {
    const result = validateGitRepositorySummary({ ...validSummary(), remotes: [{ name: 5 }] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasons).toContain("remotes[0].name must be a string");
  });

  it("rejects remote URL fields in the compact summary", () => {
    const result = validateGitRepositorySummary({
      ...validSummary(),
      remotes: [{ name: "origin", fetchUrl: "https://example.invalid/repo.git" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reasons).toContain("remotes[0].fetchUrl is not allowed in summary");
    }
  });

  it("rejects remote push URL fields in the compact summary", () => {
    const result = validateGitRepositorySummary({
      ...validSummary(),
      remotes: [{ name: "origin", pushUrl: "https://example.invalid/repo.git" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reasons).toContain("remotes[0].pushUrl is not allowed in summary");
    }
  });

  it("rejects a non-object remote entry", () => {
    const result = validateGitRepositorySummary({ ...validSummary(), remotes: ["origin"] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasons).toContain("remotes[0] must be an object");
  });
});

// KEIKO-0310: reason, message, repositoryRoot, branch, upstream, and lastSync are all declared on
// GitRepositorySummary but none were validated when present.
describe("validateGitRepositorySummary optional fields (KEIKO-0310)", () => {
  it("accepts every declared unavailable reason with a bounded message", () => {
    for (const reason of ["not-a-repository", "unsafe-repository", "git-error"] as const) {
      const input = validSummary();
      delete input.upstream;
      delete input.lastSync;
      expect(
        validateGitRepositorySummary({
          ...input,
          available: false,
          reason,
          message: "Git summary is unavailable for this folder.",
        }),
      ).toEqual({ ok: true });
    }
  });

  it("rejects a reason outside the closed union", () => {
    const result = validateGitRepositorySummary({
      ...validSummary(),
      reason: "not-a-known-reason",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasons).toContain("reason invalid");
  });

  it("rejects a non-string / over-cap message", () => {
    expect(validateGitRepositorySummary({ ...validSummary(), message: 7 }).ok).toBe(false);
    expect(validateGitRepositorySummary({ ...validSummary(), message: "x".repeat(1_025) }).ok).toBe(
      false,
    );
  });

  it("rejects a non-string repositoryRoot and a non-string branch", () => {
    expect(validateGitRepositorySummary({ ...validSummary(), repositoryRoot: 7 }).ok).toBe(false);
    expect(validateGitRepositorySummary({ ...validSummary(), branch: 7 }).ok).toBe(false);
  });

  it("rejects a malformed upstream", () => {
    expect(validateGitRepositorySummary({ ...validSummary(), upstream: { ref: 7 } }).ok).toBe(
      false,
    );
    expect(
      validateGitRepositorySummary({
        ...validSummary(),
        // remote without branch: the producer's parseUpstreamRef always sets both together.
        upstream: { ref: "origin/main", remote: "origin" },
      }).ok,
    ).toBe(false);
    expect(validateGitRepositorySummary({ ...validSummary(), upstream: "origin/main" }).ok).toBe(
      false,
    );
  });

  it("accepts an upstream with only ref (no remote/branch split available)", () => {
    expect(
      validateGitRepositorySummary({
        ...validSummary(),
        upstream: { ref: "origin/main" },
      }),
    ).toEqual({ ok: true });
  });

  it("rejects a malformed lastSync", () => {
    expect(
      validateGitRepositorySummary({ ...validSummary(), lastSync: { lastFetchAtMs: -1 } }).ok,
    ).toBe(false);
    expect(
      validateGitRepositorySummary({ ...validSummary(), lastSync: { lastFetchAtMs: "x" } }).ok,
    ).toBe(false);
    expect(validateGitRepositorySummary({ ...validSummary(), lastSync: "never" }).ok).toBe(false);
  });

  it("accepts a lastSync with no lastFetchAtMs", () => {
    expect(validateGitRepositorySummary({ ...validSummary(), lastSync: {} })).toEqual({ ok: true });
  });
});

describe("validateGitRemotesResponse", () => {
  it("accepts a valid remotes response", () => {
    expect(validateGitRemotesResponse(validRemotes())).toEqual({ ok: true });
  });

  it("rejects an invalid schemaVersion", () => {
    const result = validateGitRemotesResponse({ ...validRemotes(), schemaVersion: "9" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasons).toContain("schemaVersion invalid");
  });

  it("rejects an invalid state", () => {
    const result = validateGitRemotesResponse({ ...validRemotes(), state: "bogus" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasons).toContain("state invalid");
  });

  it("rejects a non-boolean available", () => {
    const result = validateGitRemotesResponse({ ...validRemotes(), available: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasons).toContain("available must be a boolean");
  });

  it("rejects a non-boolean truncated", () => {
    const result = validateGitRemotesResponse({ ...validRemotes(), truncated: "no" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasons).toContain("truncated must be a boolean");
  });

  it("rejects a malformed remote entry", () => {
    const result = validateGitRemotesResponse({ ...validRemotes(), remotes: [{ name: 1 }] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasons).toContain("remotes[0].name must be a string");
  });

  it("rejects a remote with a non-string fetchUrl when present", () => {
    const result = validateGitRemotesResponse({
      ...validRemotes(),
      remotes: [{ name: "origin", fetchUrl: 1 }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reasons).toContain("remotes[0].fetchUrl must be a string when present");
    }
  });

  it("rejects a remote with a non-string pushUrl when present", () => {
    const result = validateGitRemotesResponse({
      ...validRemotes(),
      remotes: [{ name: "origin", pushUrl: 1 }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reasons).toContain("remotes[0].pushUrl must be a string when present");
    }
  });

  it("rejects a non-object remote entry", () => {
    const result = validateGitRemotesResponse({ ...validRemotes(), remotes: ["origin"] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasons).toContain("remotes[0] must be an object");
  });

  it("accepts every declared unavailable reason (KEIKO-0310)", () => {
    for (const reason of ["not-a-repository", "unsafe-repository", "git-error"] as const) {
      expect(
        validateGitRemotesResponse({ ...validRemotes(), available: false, remotes: [], reason }),
      ).toEqual({ ok: true });
    }
  });

  it("rejects a reason outside the closed union (KEIKO-0310)", () => {
    const result = validateGitRemotesResponse({
      ...validRemotes(),
      reason: "not-a-known-reason",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasons).toContain("reason invalid");
  });

  it("rejects a non-string repositoryRoot (KEIKO-0310)", () => {
    const result = validateGitRemotesResponse({ ...validRemotes(), repositoryRoot: 7 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reasons).toContain("repositoryRoot must be a string when present");
    }
  });
});
