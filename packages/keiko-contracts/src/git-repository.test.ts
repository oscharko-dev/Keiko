import { describe, expect, it } from "vitest";
import {
  GIT_DIFF_TRUNCATION_MAX_OVERAGE_BYTES,
  GIT_REPOSITORY_SCHEMA_VERSION,
  GIT_REPOSITORY_STATES,
  GIT_STATUS_CODES,
  isSafeGitRefName,
  parseGitRepositoryStatusResponse,
  parseGitRepositoryDiffResponse,
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

// KfQ Major: UNSAFE_REF_SUFFIXES applied `.lock` with endsWith() against the WHOLE ref, but git's
// rule is per slash-separated component -- `git check-ref-format --allow-onelevel` refuses
// `a.lock/b` as surely as `a.lock`. The sibling leading-dot rule in the same predicate was already
// per component, so `a.lock/b`, `x.lock/y/z` and `refs/heads/a.lock/b` passed contract validation
// and were then rejected at the git boundary: the exact divergence class the consolidation of the
// predicate into this file claimed to close. Every row below was checked against
// `git check-ref-format --allow-onelevel <ref>` (git 2.55) and agrees with it. The predicate is
// deliberately stricter than git elsewhere (length cap, charset allowlist), so the "accepts" rows
// are the floor the deterministic shapes Keiko emits rely on, not a claim of equivalence.
describe("isSafeGitRefName", () => {
  it.each(["a.lock/b", "x.lock/y/z", "refs/heads/a.lock/b", "a.lock.lock/b", "a/b.lock", "a.lock"])(
    "rejects %j: a component ending in .lock, as git does",
    (ref) => {
      expect(isSafeGitRefName(ref)).toBe(false);
    },
  );

  it.each(["a.lock-not-suffix/b", "feature/lock", "lock/a", "a.locked/b", "a.lockb/c", "x.Lock/y"])(
    "accepts %j: .lock that is not a component suffix, as git does",
    (ref) => {
      expect(isSafeGitRefName(ref)).toBe(true);
    },
  );

  it.each([
    "a..b",
    "a/",
    "a.",
    "-a",
    "a@{b}",
    "a~1",
    "a^",
    "a\\b",
    "a b",
    ".a",
    "a/.b",
    "a//b",
    "/a",
    "a:b",
    "a?b",
    "a*b",
    "a[b",
    "@",
    "a\tb",
    "",
  ])("rejects %j, as git check-ref-format --allow-onelevel does", (ref) => {
    expect(isSafeGitRefName(ref)).toBe(false);
  });

  // Field defect, 1.1.1: the customer's base branch is `feat(GDZ-917)/MAK-Prozess-Start-
  // Produktauswahl`. The allowlist assumed every ref Keiko handles is one Keiko derived, but a base
  // branch is the user's own, and conventional-commit style names with parentheses are ordinary.
  // The bind was refused as "unsafe base ref" and the Workbench could not be used on that
  // repository at all. Every row was checked against `git check-ref-format --allow-onelevel`.
  it.each([
    "feat(GDZ-917)/MAK-Prozess-Start-Produktauswahl",
    "fix(ui)/button",
    "fix+hotfix",
    "user@feature",
    "a=b",
    "a,b",
  ])("accepts the user-owned branch name %j, as git does", (ref) => {
    expect(isSafeGitRefName(ref)).toBe(true);
  });

  // The widening is a vetted set, not git's whole grammar: every ref reaches git as one argv
  // element, but refs also travel into URLs and operator-visible text, so characters that are
  // shell, URL or markup syntax stay refused even though git itself would take them.
  it.each([
    "a;b",
    "a|b",
    "a$b",
    "a&b",
    "a#b",
    "a%b",
    'a"b',
    "a'b",
    "a`b",
    "a<b",
    "a>b",
    "a{b",
    "a!b",
  ])("still refuses %j", (ref) => {
    expect(isSafeGitRefName(ref)).toBe(false);
  });

  // git's trailing-dot rule is whole-ref only (`a.` is refused, `a./b` is not), unlike the
  // leading-dot and `.lock` rules, which are per component: pinned so the per-component treatment
  // is not extended to it by analogy.
  it.each([
    "main",
    "refs/heads/main",
    "feature/x-1.2",
    "release/1.0",
    "a/b/c",
    "a.b",
    "a./b",
    "keiko/task/my-task-abc12345",
  ])("accepts %j, as git check-ref-format --allow-onelevel does", (ref) => {
    expect(isSafeGitRefName(ref)).toBe(true);
  });
});

describe("optional complete Git directory metadata", () => {
  it("accepts additive complete metadata without requiring it on legacy envelopes", () => {
    expect(validateGitRepositoryStatusResponse(makeValidStatusResponse()).ok).toBe(true);
    expect(
      validateGitRepositoryStatusResponse(
        makeValidStatusResponse({ selectedRootIgnored: true, untrackedDirectories: ["new"] }),
      ).ok,
    ).toBe(true);
  });
  it.each([
    { selectedRootIgnored: "true" },
    { untrackedDirectories: [false] },
    { untrackedDirectories: "new" },
    { untrackedDirectories: ["one", "two"], maxChanges: 1 },
  ])("rejects malformed or unbounded metadata %j", (metadata) => {
    expect(validateGitRepositoryStatusResponse(makeValidStatusResponse(metadata)).ok).toBe(false);
  });
});

import {
  validateGitRepositoryDiffResponse as validatePublicGitDiffResponse,
  validateGitRepositoryStatusResponse as validatePublicGitStatusResponse,
  parseGitRepositoryStatusResponse as parsePublicGitStatusResponse,
  parseGitRepositoryDiffResponse as parsePublicGitDiffResponse,
} from "@oscharko-dev/keiko-contracts/runtime/git-repository";

describe("Git diff scope primitive admission (#3918)", () => {
  for (const [surface, validate] of [
    ["source", validateGitRepositoryDiffResponse],
    ["public", validatePublicGitDiffResponse],
  ] as const) {
    it(`${surface}: refuses an array scope from actual JSON without coercion`, () => {
      const response: unknown = JSON.parse(
        JSON.stringify(makeValidDiffResponse({ scope: ["all"] })),
      );
      expect(validate(response)).toEqual({ ok: false, reasons: ["scope invalid"] });
    });
    it.each(["all", "worktree", "staged"])(`${surface}: admits the primitive %s scope`, (scope) => {
      expect(validate(makeValidDiffResponse({ scope }))).toEqual({ ok: true });
    });
    it.each([null, undefined, 1, true, [], ["worktree"], {}, { toString: (): string => "all" }])(
      `${surface}: refuses non-primitive scope %j`,
      (scope) => {
        expect(validate(makeValidDiffResponse({ scope }))).toEqual({
          ok: false,
          reasons: ["scope invalid"],
        });
      },
    );
    it(`${surface}: never invokes caller-controlled scope coercion`, () => {
      let calls = 0;
      const scope = {
        toString(): never {
          calls += 1;
          throw new TypeError("untrusted coercion");
        },
      };
      expect(validate(makeValidDiffResponse({ scope }))).toEqual({
        ok: false,
        reasons: ["scope invalid"],
      });
      expect(calls).toBe(0);
    });
  }
});

it("preserves exact repository-state vocabulary admission without unknown-valued projection", () => {
  for (const state of GIT_REPOSITORY_STATES) {
    expect(validateGitRepositoryStatusResponse(makeValidStatusResponse({ state }))).toEqual({
      ok: true,
    });
    expect(validateGitRepositoryDiffResponse(makeValidDiffResponse({ state }))).toEqual({
      ok: true,
    });
  }
  for (const state of [undefined, null, ["available"], 1, true, {}, "AVAILABLE", "foreign"]) {
    expect(validateGitRepositoryStatusResponse(makeValidStatusResponse({ state }))).toEqual({
      ok: false,
      reasons: ["state invalid"],
    });
    expect(validateGitRepositoryDiffResponse(makeValidDiffResponse({ state }))).toEqual({
      ok: false,
      reasons: ["state invalid"],
    });
  }
});

describe("Git status actual array element admission (#3918)", () => {
  for (const [surface, validate] of [
    ["source", validateGitRepositoryStatusResponse],
    ["public", validatePublicGitStatusResponse],
  ] as const) {
    it(`${surface}: rejects changes holes and caller-controlled traversal bypasses`, () => {
      const sparse: unknown[] = [];
      sparse.length = 1;
      const spoofed = Object.assign([null], { forEach: (): undefined => undefined });
      for (const changes of [sparse, spoofed, [null]]) {
        expect(validate(makeValidStatusResponse({ changes }))).toEqual({
          ok: false,
          reasons: ["changes[0] must be an object"],
        });
      }
    });
    it(`${surface}: rejects directory holes and caller-controlled traversal bypasses`, () => {
      const sparse: unknown[] = [];
      sparse.length = 1;
      const spoofed = Object.assign([null], { every: (): boolean => true });
      for (const untrackedDirectories of [sparse, spoofed, [null]]) {
        expect(validate(makeValidStatusResponse({ untrackedDirectories }))).toEqual({
          ok: false,
          reasons: ["untrackedDirectories must be a bounded string array when present"],
        });
      }
    });
  }
});

export function parsePublicGitStatus(
  input: unknown,
): import("@oscharko-dev/keiko-contracts").GitRepositoryParseResult<
  import("@oscharko-dev/keiko-contracts").GitRepositoryStatusResponse
> {
  const result = parsePublicGitStatusResponse(input);
  return result;
}

export function parsePublicGitDiff(
  input: unknown,
): import("@oscharko-dev/keiko-contracts").GitRepositoryParseResult<
  import("@oscharko-dev/keiko-contracts").GitRepositoryDiffResponse
> {
  const result = parsePublicGitDiffResponse(input);
  return result;
}

describe("Git typed owning and public parsers (#3918)", () => {
  for (const [surface, status, diff] of [
    ["source", parseGitRepositoryStatusResponse, parseGitRepositoryDiffResponse],
    ["public", parsePublicGitStatus, parsePublicGitDiff],
  ] as const) {
    it(`${surface}: retains original values, nested references and omitted versus own undefined`, () => {
      const input = makeValidStatusResponse({
        selectedRootIgnored: undefined,
        untrackedDirectories: ["new"],
      });
      delete input.branch;
      const parsed = status(input);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) throw new TypeError("valid status fixture refused");
      expect(parsed.value).toBe(input);
      expect(parsed.value.changes).toBe(input.changes);
      expect(parsed.value.untrackedDirectories).toBe(input.untrackedDirectories);
      expect(Object.hasOwn(parsed.value, "branch")).toBe(false);
      expect(Object.hasOwn(parsed.value, "selectedRootIgnored")).toBe(true);
      const diffInput = makeValidDiffResponse({ path: undefined });
      const parsedDiff = diff(diffInput);
      expect(parsedDiff.ok).toBe(true);
      if (!parsedDiff.ok) throw new TypeError("valid diff fixture refused");
      expect(parsedDiff.value).toBe(diffInput);
      expect(Object.hasOwn(parsedDiff.value, "path")).toBe(true);
    });
    it(`${surface}: checks later fields eagerly and retains ordered legacy reasons`, () => {
      const invalidStatus = makeValidStatusResponse({
        schemaVersion: 0,
        state: [],
        message: 4,
        branch: 4,
        available: 4,
        changes: [null],
        selectedRootIgnored: 4,
      });
      expect(status(invalidStatus)).toEqual(validateGitRepositoryStatusResponse(invalidStatus));
      expect(status(invalidStatus)).toEqual({
        ok: false,
        reasons: [
          "schemaVersion invalid",
          "state invalid",
          "message must be a bounded string when present",
          "branch must be a string when present",
          "available must be a boolean",
          "changes[0] must be an object",
          "selectedRootIgnored must be a boolean when present",
        ],
      });
      const invalidDiff = makeValidDiffResponse({
        schemaVersion: 0,
        state: [],
        reason: 4,
        scope: ["all"],
        diff: "long",
        truncated: false,
        maxBytes: 0,
      });
      expect(diff(invalidDiff)).toEqual(validateGitRepositoryDiffResponse(invalidDiff));
      expect(diff(invalidDiff)).toEqual({
        ok: false,
        reasons: [
          "schemaVersion invalid",
          "state invalid",
          "reason invalid",
          "scope invalid",
          "truncated must be true when diff exceeds maxBytes",
          `diff must not exceed maxBytes by more than ${String(GIT_DIFF_TRUNCATION_MAX_OVERAGE_BYTES)} bytes`,
        ],
      });
    });
    it(`${surface}: refuses primitive input and the actual malformed array bypasses`, () => {
      for (const input of [undefined, null, true, 1, "value", []]) {
        expect(status(input)).toEqual({ ok: false, reasons: ["response must be an object"] });
        expect(diff(input)).toEqual({ ok: false, reasons: ["response must be an object"] });
      }
      const sparse: unknown[] = [];
      sparse.length = 1;
      const arrays = [
        sparse,
        Object.assign([null], { forEach: (): undefined => undefined, every: (): boolean => true }),
      ];
      for (const items of arrays) {
        expect(status(makeValidStatusResponse({ changes: items })).ok).toBe(false);
        expect(status(makeValidStatusResponse({ untrackedDirectories: items })).ok).toBe(false);
      }
    });
    it(`${surface}: preserves getter observation counts and propagates getter failure`, () => {
      const reads: string[] = [];
      const input = new Proxy(makeValidStatusResponse(), {
        get(target, key, receiver): unknown {
          reads.push(String(key));
          return Reflect.get(target, key, receiver);
        },
      });
      expect(validateGitRepositoryStatusResponse(input)).toEqual({ ok: true });
      const legacyReads = [...reads];
      reads.length = 0;
      expect(status(input).ok).toBe(true);
      expect(reads).toEqual(legacyReads);
      const thrown = new TypeError("fixture getter failure");
      Object.defineProperty(input, "root", {
        get(): never {
          throw thrown;
        },
      });
      expect(() => status(input)).toThrow(thrown);
    });
  }
});

it("public Git parser results carry distinct closed domain types without assertions", () => {
  const result = parsePublicGitStatusResponse(makeValidStatusResponse());
  if (result.ok) {
    const value: import("@oscharko-dev/keiko-contracts").GitRepositoryStatusResponse = result.value;
    expect(value.stagedCount).toBe(1);
    // @ts-expect-error A validated status is not a validated diff response.
    const wrong: import("@oscharko-dev/keiko-contracts").GitRepositoryDiffResponse = result.value;
    expect(wrong).toBe(value);
  } else {
    // @ts-expect-error Failed admission carries reasons, never a typed value.
    expect(result.value).toBeUndefined();
  }
});
