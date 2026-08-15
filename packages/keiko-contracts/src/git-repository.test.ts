import { describe, expect, it } from "vitest";
import {
  GIT_REPOSITORY_SCHEMA_VERSION,
  GIT_STATUS_CODES,
  validateGitRepositoryDiffResponse,
  validateGitRepositoryStatusResponse,
} from "./git-repository.js";

function makeChange(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    path: "src/app.ts",
    indexStatus: "M",
    worktreeStatus: " ",
    staged: true,
    unstaged: false,
    untracked: false,
    conflicted: false,
    ...overrides,
  };
}

function makeValidStatusResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: GIT_REPOSITORY_SCHEMA_VERSION,
    root: "/repo",
    repositoryRoot: "/repo",
    state: "available",
    available: true,
    branch: "main",
    detached: false,
    clean: false,
    stagedCount: 1,
    unstagedCount: 0,
    untrackedCount: 0,
    conflictedCount: 0,
    changes: [makeChange()],
    truncated: false,
    maxChanges: 500,
    ...overrides,
  };
}

function makeValidDiffResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: GIT_REPOSITORY_SCHEMA_VERSION,
    root: "/repo",
    repositoryRoot: "/repo",
    state: "available",
    available: true,
    path: "src/app.ts",
    scope: "all",
    diff: "diff --git a/src/app.ts b/src/app.ts\n",
    truncated: false,
    maxBytes: 128,
    ...overrides,
  };
}

describe("git repository wire validators", () => {
  it("accepts a bounded status response with staged, unstaged, and untracked changes", () => {
    expect(
      validateGitRepositoryStatusResponse({
        schemaVersion: GIT_REPOSITORY_SCHEMA_VERSION,
        root: "/repo",
        repositoryRoot: "/repo",
        state: "available",
        available: true,
        branch: "main",
        detached: false,
        clean: false,
        stagedCount: 1,
        unstagedCount: 1,
        untrackedCount: 1,
        conflictedCount: 0,
        changes: [
          {
            path: "src/app.ts",
            indexStatus: "M",
            worktreeStatus: " ",
            staged: true,
            unstaged: false,
            untracked: false,
            conflicted: false,
          },
          {
            path: "src/new.ts",
            indexStatus: "?",
            worktreeStatus: "?",
            staged: false,
            unstaged: false,
            untracked: true,
            conflicted: false,
          },
        ],
        truncated: false,
        maxChanges: 500,
      }),
    ).toEqual({ ok: true });
  });

  it("rejects malformed status responses", () => {
    const result = validateGitRepositoryStatusResponse({
      schemaVersion: "wrong",
      root: "/repo",
      state: "available",
      available: true,
      detached: false,
      clean: true,
      stagedCount: 0,
      unstagedCount: 0,
      untrackedCount: 0,
      conflictedCount: 0,
      changes: "nope",
      truncated: false,
      maxChanges: 500,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reasons).toContain("schemaVersion invalid");
      expect(result.reasons).toContain("changes must be an array");
    }
  });

  it("accepts bounded diff responses", () => {
    expect(
      validateGitRepositoryDiffResponse({
        schemaVersion: GIT_REPOSITORY_SCHEMA_VERSION,
        root: "/repo",
        repositoryRoot: "/repo",
        state: "available",
        available: true,
        path: "src/app.ts",
        scope: "all",
        diff: "diff --git a/src/app.ts b/src/app.ts\n",
        truncated: true,
        maxBytes: 128,
      }),
    ).toEqual({ ok: true });
  });
});

// KEIKO-0310: indexStatus/worktreeStatus were validated as plain strings even though GitStatusCode
// is a closed 9-member set. This is the finding's own mustFailBeforeFix case, verbatim: it failed
// against the pre-fix validateChange (which accepted any string) and passes once the GIT_STATUS_CODES
// check is in place.
describe("changes[].indexStatus / worktreeStatus (KEIKO-0310)", () => {
  it("accepts every closed git status code", () => {
    for (const code of GIT_STATUS_CODES) {
      expect(
        validateGitRepositoryStatusResponse(
          makeValidStatusResponse({
            changes: [makeChange({ indexStatus: code, worktreeStatus: code })],
          }),
        ),
      ).toEqual({ ok: true });
    }
  });

  it("rejects an indexStatus outside the closed set", () => {
    const result = validateGitRepositoryStatusResponse(
      makeValidStatusResponse({ changes: [makeChange({ indexStatus: "Z" })] }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reasons).toContain(
        "changes[0].indexStatus must be one of the closed git status codes",
      );
    }
  });

  it("rejects a worktreeStatus outside the closed set", () => {
    const result = validateGitRepositoryStatusResponse(
      makeValidStatusResponse({ changes: [makeChange({ worktreeStatus: "Z" })] }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reasons).toContain(
        "changes[0].worktreeStatus must be one of the closed git status codes",
      );
    }
  });
});

describe("status response: reason, message, repositoryRoot, branch, changes/maxChanges (KEIKO-0310)", () => {
  it("accepts every declared unavailable reason with a bounded message", () => {
    for (const reason of ["not-a-repository", "git-missing", "unsafe-repository"] as const) {
      expect(
        validateGitRepositoryStatusResponse(
          makeValidStatusResponse({
            available: false,
            changes: [],
            reason,
            message: "Git status is unavailable for this folder.",
          }),
        ),
      ).toEqual({ ok: true });
    }
  });

  it("rejects a reason outside the closed union", () => {
    const result = validateGitRepositoryStatusResponse(
      makeValidStatusResponse({ reason: "not-a-known-reason" }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasons).toContain("reason invalid");
  });

  it("rejects a non-string message, and one over the character cap", () => {
    expect(validateGitRepositoryStatusResponse(makeValidStatusResponse({ message: 7 })).ok).toBe(
      false,
    );
    expect(
      validateGitRepositoryStatusResponse(makeValidStatusResponse({ message: "x".repeat(1_025) }))
        .ok,
    ).toBe(false);
  });

  it("rejects a non-string repositoryRoot and a non-string branch", () => {
    expect(
      validateGitRepositoryStatusResponse(makeValidStatusResponse({ repositoryRoot: 7 })).ok,
    ).toBe(false);
    expect(validateGitRepositoryStatusResponse(makeValidStatusResponse({ branch: 7 })).ok).toBe(
      false,
    );
  });

  it("rejects changes.length exceeding maxChanges", () => {
    const result = validateGitRepositoryStatusResponse(
      makeValidStatusResponse({
        changes: [makeChange(), makeChange()],
        maxChanges: 1,
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasons).toContain("changes.length must not exceed maxChanges");
  });

  it("accepts changes.length equal to maxChanges with truncated false -- unlike entries/limit, this is a legitimate combination here", () => {
    // computeStatusTruncated in the real producer compares the raw NUL-separated porcelain record
    // count (which over-counts by one record per rename/copy) against maxChanges, not
    // changes.length itself, so landing exactly on the cap with no renames correctly reports
    // truncated: false. A stricter truncated-consistency check here would reject that legitimate
    // response, unlike the analogous git-history entries/limit case.
    expect(
      validateGitRepositoryStatusResponse(
        makeValidStatusResponse({ changes: [makeChange()], maxChanges: 1, truncated: false }),
      ),
    ).toEqual({ ok: true });
  });
});

describe("diff response: reason, repositoryRoot, truncated/maxBytes consistency (KEIKO-0310)", () => {
  it("accepts every declared unavailable reason", () => {
    for (const reason of ["not-a-repository", "git-missing", "git-error"] as const) {
      expect(
        validateGitRepositoryDiffResponse(
          makeValidDiffResponse({ available: false, diff: "", reason }),
        ),
      ).toEqual({ ok: true });
    }
  });

  it("rejects a reason outside the closed union", () => {
    const result = validateGitRepositoryDiffResponse(
      makeValidDiffResponse({ reason: "not-a-known-reason" }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasons).toContain("reason invalid");
  });

  it("rejects a non-string repositoryRoot", () => {
    const result = validateGitRepositoryDiffResponse(makeValidDiffResponse({ repositoryRoot: 7 }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reasons).toContain("repositoryRoot must be a string when present");
    }
  });

  it("rejects a diff exceeding maxBytes (measured in UTF-8 bytes) with truncated false", () => {
    const result = validateGitRepositoryDiffResponse(
      makeValidDiffResponse({ diff: "0123456789", maxBytes: 5, truncated: false }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reasons).toContain("truncated must be true when diff exceeds maxBytes");
    }
  });

  it("accepts a diff exceeding maxBytes when truncated is true", () => {
    expect(
      validateGitRepositoryDiffResponse(
        makeValidDiffResponse({ diff: "0123456789", maxBytes: 5, truncated: true }),
      ),
    ).toEqual({ ok: true });
  });

  it("measures maxBytes in UTF-8 bytes, not UTF-16 code units", () => {
    // Each "é" is 1 UTF-16 code unit but 2 UTF-8 bytes: 5 of them is 5 code units (<= a length-based
    // check of 8) but 10 UTF-8 bytes (> the byte cap of 8), so this must be rejected as
    // inconsistent -- a length-based comparison would have silently missed it.
    const diff = "é".repeat(5);
    expect(diff).toHaveLength(5);
    const result = validateGitRepositoryDiffResponse(
      makeValidDiffResponse({ diff, maxBytes: 8, truncated: false }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reasons).toContain("truncated must be true when diff exceeds maxBytes");
    }
  });
});
