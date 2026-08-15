import { describe, expect, it } from "vitest";
import {
  GIT_DIFF_TRUNCATION_MAX_OVERAGE_BYTES,
  GIT_REPOSITORY_SCHEMA_VERSION,
  GIT_STATUS_CODES,
  validateGitRepositoryDiffResponse,
  validateGitRepositoryStatusResponse,
} from "./git-repository.js";

const TEXT_ENCODER = new TextEncoder();

// The exact operation the producer performs to clamp `diff` to `maxBytes`
// (keiko-server gitRoutes.ts): cut the encoded byte buffer at an arbitrary offset, which can land
// inside a multi-byte UTF-8 sequence, then decode back to a string. Exercising this real mechanism
// (rather than asserting a fixed fixture number) is what proves
// GIT_DIFF_TRUNCATION_MAX_OVERAGE_BYTES bounds every case, not just the one this test happened to
// pick.
function truncateUtf8Bytes(text: string, maxBytes: number): string {
  return Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8");
}

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

  // KfQ Major (thread 3788736976): `truncated: true` used to waive the maxBytes bound entirely --
  // this exact case ("0123456789" at maxBytes 5, an overage of 5 bytes) passed pre-fix even though
  // no real truncation could ever produce that much overage. `truncated: true` describes that the
  // SOURCE was cut, not a waiver on the OUTPUT bound, so only the producer's own legitimate
  // partial-UTF-8 overage (GIT_DIFF_TRUNCATION_MAX_OVERAGE_BYTES) may still pass.
  it("accepts a diff exceeding maxBytes by exactly the legitimate truncation overage", () => {
    const maxBytes = 5;
    const diff = "0".repeat(maxBytes + GIT_DIFF_TRUNCATION_MAX_OVERAGE_BYTES);
    expect(
      validateGitRepositoryDiffResponse(makeValidDiffResponse({ diff, maxBytes, truncated: true })),
    ).toEqual({ ok: true });
  });

  it("rejects a diff exceeding maxBytes by more than the legitimate truncation overage, even when truncated is true", () => {
    const maxBytes = 5;
    const diff = "0".repeat(maxBytes + GIT_DIFF_TRUNCATION_MAX_OVERAGE_BYTES + 1);
    const result = validateGitRepositoryDiffResponse(
      makeValidDiffResponse({ diff, maxBytes, truncated: true }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reasons).toContain(
        `diff must not exceed maxBytes by more than ${String(GIT_DIFF_TRUNCATION_MAX_OVERAGE_BYTES)} bytes`,
      );
    }
  });

  // Does not assert a fixed fixture number: it performs the producer's actual truncation mechanism
  // (see truncateUtf8Bytes above) across every possible cut point of representative 2/3/4-byte UTF-8
  // characters and every maxBytes in range, then proves GIT_DIFF_TRUNCATION_MAX_OVERAGE_BYTES bounds
  // the real re-encoded overage in every case -- so this test would fail if either the decoder's
  // replacement behaviour or the derived bound stopped matching reality, rather than staying green
  // by construction.
  it("bounds the real re-encoded overage from truncating inside a multi-byte UTF-8 character", () => {
    const samples = ["é", "中", "😀"]; // 2-byte, 3-byte, 4-byte (surrogate pair) UTF-8 sequences
    let sawOverage = false;
    for (const character of samples) {
      const text = `a${character}`;
      const fullBytes = TEXT_ENCODER.encode(text).length;
      for (let maxBytes = 1; maxBytes < fullBytes; maxBytes += 1) {
        const truncated = truncateUtf8Bytes(text, maxBytes);
        const actualBytes = TEXT_ENCODER.encode(truncated).length;
        if (actualBytes > maxBytes) sawOverage = true;
        expect(
          actualBytes,
          `truncating ${JSON.stringify(text)} to ${String(maxBytes)} bytes re-encoded to ${String(actualBytes)}`,
        ).toBeLessThanOrEqual(maxBytes + GIT_DIFF_TRUNCATION_MAX_OVERAGE_BYTES);
      }
    }
    // The loop above is only a meaningful proof if at least one cut point actually produced an
    // overage -- otherwise every assertion would pass vacuously against a bound that does nothing.
    expect(sawOverage).toBe(true);
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
