import { describe, expect, it } from "vitest";
import {
  validateGitSyncExecuteResponse as validatePublicSyncExecute,
  parseGitSyncPreview as parsePublicPreview,
  parseGitSyncExecuteResponse as parsePublicExecute,
} from "@oscharko-dev/keiko-contracts/runtime/git-sync";
import {
  GIT_SYNC_BLOCK_REASONS,
  GIT_SYNC_OPERATIONS,
  GIT_SYNC_OUTCOMES,
  GIT_SYNC_SCHEMA_VERSION,
  isGitSyncOperation,
  isGitSyncOutcome,
  validateGitSyncExecuteResponse,
  validateGitSyncPreview,
  parseGitSyncPreview,
  parseGitSyncExecuteResponse,
  type GitSyncOutcome,
} from "./git-sync.js";

// Object.freeze throws on a mutation attempt in strict-mode ESM (which this file is), but the
// assertion that matters is the post-attempt VALUE, not the throw — so a swallowed exception here
// still leaves the real regression signal (the unchanged read below) intact.
function attemptMutation(mutate: () => void): void {
  try {
    mutate();
  } catch {
    // Expected in strict mode: Object.freeze rejects the write.
  }
}

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

// GIT-SYNC-UPSTREAM-ADMISSION-01: a declared optional upstream must be admitted when supplied.
describe("Git sync execute upstream admission (#3918)", () => {
  for (const [surface, validate] of [
    ["source", validateGitSyncExecuteResponse],
    ["public", validatePublicSyncExecute],
  ] as const) {
    it.each([
      null,
      true,
      1,
      "private-upstream",
      [],
      {},
      { ref: 1 },
      { ref: "origin/main", remote: "origin" },
    ])(`${surface}: refuses malformed supplied upstream %j`, (upstream) => {
      expect(validate({ ...validExecute(), upstream })).toEqual({
        ok: false,
        reasons: ["upstream must be { ref, remote?, branch? } when present"],
      });
    });
  }
});

export function parsePublicGitSyncPreview(
  input: unknown,
): import("@oscharko-dev/keiko-contracts").GitRepositoryParseResult<
  import("@oscharko-dev/keiko-contracts").GitSyncPreview
> {
  const result = parsePublicPreview(input);
  return result;
}

export function parsePublicGitSyncExecute(
  input: unknown,
): import("@oscharko-dev/keiko-contracts").GitRepositoryParseResult<
  import("@oscharko-dev/keiko-contracts").GitSyncExecuteResponse
> {
  const result = parsePublicExecute(input);
  return result;
}

describe("Git sync typed parsers (#3918)", () => {
  for (const { phase, parse, fixture, surface } of [
    { phase: "preview", surface: "source", parse: parseGitSyncPreview, fixture: validPreview },
    {
      phase: "preview",
      surface: "public",
      parse: parsePublicGitSyncPreview,
      fixture: validPreview,
    },
    {
      phase: "execute",
      surface: "source",
      parse: parseGitSyncExecuteResponse,
      fixture: validExecute,
    },
    {
      phase: "execute",
      surface: "public",
      parse: parsePublicGitSyncExecute,
      fixture: validExecute,
    },
  ]) {
    it(`${surface} ${phase}: preserves original upstream and optional presence`, () => {
      for (const upstream of [
        undefined,
        { ref: "origin/main" },
        { ref: "origin/main", remote: "origin", branch: "main" },
      ]) {
        const input = { ...fixture(), upstream, branch: undefined };
        const result = parse(input);
        if (!result.ok) throw new TypeError("healthy sync refused");
        expect(result.value).toBe(input);
        expect(result.value.upstream).toBe(upstream);
        expect(Object.hasOwn(result.value, "branch")).toBe(true);
      }
      const omitted = fixture();
      delete omitted.upstream;
      delete omitted.branch;
      const result = parse(omitted);
      if (!result.ok) throw new TypeError("omitted optionals refused");
      expect(result.value).toBe(omitted);
      expect(Object.hasOwn(result.value, "upstream")).toBe(false);
      expect(Object.hasOwn(result.value, "branch")).toBe(false);
    });
    it(`${surface} ${phase}: refuses malformed ingress with eager ordered reasons`, () => {
      for (const input of [null, undefined, true, 1, "input", []])
        expect(parse(input)).toEqual({ ok: false, reasons: ["response must be an object"] });
      for (const upstream of [
        null,
        true,
        1,
        "input",
        [],
        {},
        { ref: 1 },
        { ref: "origin/main", remote: "origin" },
      ])
        expect(parse({ ...fixture(), upstream })).toEqual({
          ok: false,
          reasons: ["upstream must be { ref, remote?, branch? } when present"],
        });
      const input = {
        ...fixture(),
        schemaVersion: 0,
        operation: "push",
        branch: 1,
        upstream: null,
        available: 1,
        ahead: -1,
      };
      const reasons =
        phase === "preview"
          ? [
              "schemaVersion invalid",
              "operation invalid",
              "branch must be a string when present",
              "upstream must be { ref, remote?, branch? } when present",
              "available must be a boolean",
              "ahead must be a non-negative integer",
            ]
          : [
              "schemaVersion invalid",
              "operation invalid",
              "available must be a boolean",
              "ahead must be a non-negative integer when present",
              "branch must be a string when present",
              "upstream must be { ref, remote?, branch? } when present",
            ];
      expect(parse(input)).toEqual({ ok: false, reasons });
    });
    it(`${surface} ${phase}: retains executable gates outcomes and optional counter bounds`, () => {
      if (phase === "preview") {
        expect(parse({ ...fixture(), executable: false }).ok).toBe(false);
        expect(parse({ ...fixture(), blockReason: "no-upstream" }).ok).toBe(false);
        expect(parse({ ...fixture(), executable: false, blockReason: "no-upstream" }).ok).toBe(
          true,
        );
        expect(parse({ ...fixture(), executable: false, blockReason: "invalid" }).ok).toBe(false);
      } else {
        for (const status of GIT_SYNC_OUTCOMES)
          expect(parse({ ...fixture(), status }).ok).toBe(true);
        for (const [key, value] of [
          ["status", "invalid"],
          ["truncated", 1],
          ["available", 1],
          ["ahead", -1],
          ["behind", Infinity],
          ["branch", 1],
          ["remote", true],
        ] as const)
          expect(parse({ ...fixture(), [key]: value }).ok).toBe(false);
        const input = fixture();
        delete input.ahead;
        delete input.behind;
        expect(parse(input).ok).toBe(true);
        expect(parse({ ...input, ahead: undefined, behind: undefined }).ok).toBe(true);
      }
    });
  }
});

it("public sync parsers retain concrete output and refusal types", () => {
  const preview = parsePublicPreview(validPreview());
  const execute = parsePublicExecute(validExecute());
  if (!preview.ok || !execute.ok) throw new TypeError("healthy sync refused");
  const first: import("@oscharko-dev/keiko-contracts").GitSyncPreview = preview.value;
  const second: import("@oscharko-dev/keiko-contracts").GitSyncExecuteResponse = execute.value;
  expect(first.executable).toBe(true);
  expect(second.status).toBe("succeeded");
  // @ts-expect-error Execute results do not carry the preview executable gate.
  const wrong: import("@oscharko-dev/keiko-contracts").GitSyncPreview = execute.value;
  expect(wrong).toBe(second);
  const refused = parsePublicPreview(null);
  if (refused.ok) throw new TypeError("primitive admitted");
  // @ts-expect-error Refusal has no successfully admitted value.
  expect(refused.value).toBeUndefined();
});

describe("frozen governance tables (KEIKO-0879)", () => {
  it("GIT_SYNC_OPERATIONS is frozen and a mutation attempt leaves it unchanged", () => {
    expect(Object.isFrozen(GIT_SYNC_OPERATIONS)).toBe(true);
    const before = [...GIT_SYNC_OPERATIONS];
    attemptMutation(() => {
      (GIT_SYNC_OPERATIONS as unknown as string[]).push("clone");
    });
    expect([...GIT_SYNC_OPERATIONS]).toEqual(before);
  });

  it("GIT_SYNC_OUTCOMES is frozen and a mutation attempt leaves it unchanged", () => {
    expect(Object.isFrozen(GIT_SYNC_OUTCOMES)).toBe(true);
    const before = [...GIT_SYNC_OUTCOMES];
    attemptMutation(() => {
      (GIT_SYNC_OUTCOMES as unknown as string[]).push("bogus-outcome");
    });
    expect([...GIT_SYNC_OUTCOMES]).toEqual(before);
  });

  it("GIT_SYNC_BLOCK_REASONS is frozen and a mutation attempt leaves it unchanged", () => {
    expect(Object.isFrozen(GIT_SYNC_BLOCK_REASONS)).toBe(true);
    const before = [...GIT_SYNC_BLOCK_REASONS];
    attemptMutation(() => {
      (GIT_SYNC_BLOCK_REASONS as unknown as string[]).push("bogus-reason");
    });
    expect([...GIT_SYNC_BLOCK_REASONS]).toEqual(before);
  });
});

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

  // Strengthened from a magic-number length check, which a rename or a duplicated entry passes. The
  // total Record makes a member added to GitSyncOutcome but omitted from GIT_SYNC_OUTCOMES a COMPILE
  // error, and the set comparison catches the reverse; the union and the runtime list cannot drift.
  it("lists every member of the union exactly once", () => {
    const declared: Readonly<Record<GitSyncOutcome, true>> = {
      succeeded: true,
      "up-to-date": true,
      "no-remote": true,
      "no-upstream": true,
      "detached-head": true,
      "dirty-worktree": true,
      "not-fast-forward": true,
      "authority-denied": true,
      "auth-failed": true,
      "untrusted-host-key": true,
      "remote-unavailable": true,
      timeout: true,
      "output-truncated": true,
      "git-missing": true,
      "unsafe-repository": true,
      "git-error": true,
    };
    expect(new Set(GIT_SYNC_OUTCOMES).size).toBe(GIT_SYNC_OUTCOMES.length);
    expect([...GIT_SYNC_OUTCOMES].sort((a, b) => a.localeCompare(b))).toEqual(
      Object.keys(declared).sort((a, b) => a.localeCompare(b)),
    );
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

// KEIKO-0310: reason, branch, remote, and upstream were all declared but unvalidated when present;
// the executable/blockReason correlation the field comments imply was never checked at all.
describe("validateGitSyncPreview optional fields and the executable/blockReason correlation (KEIKO-0310)", () => {
  it("accepts every declared unavailable reason", () => {
    for (const reason of ["not-a-repository", "unsafe-repository", "git-error"] as const) {
      expect(validateGitSyncPreview({ ...validPreview(), available: false, reason })).toEqual({
        ok: true,
      });
    }
  });

  it("rejects a reason outside the closed union", () => {
    const result = validateGitSyncPreview({ ...validPreview(), reason: "not-a-known-reason" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasons).toContain("reason invalid");
  });

  it.each(["branch", "remote"] as const)("rejects a non-string %s when present", (key) => {
    const result = validateGitSyncPreview({ ...validPreview(), [key]: 5 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasons).toContain(`${key} must be a string when present`);
  });

  it("rejects a malformed upstream", () => {
    expect(validateGitSyncPreview({ ...validPreview(), upstream: { ref: 7 } }).ok).toBe(false);
    expect(validateGitSyncPreview({ ...validPreview(), upstream: "origin/main" }).ok).toBe(false);
  });

  it("accepts an upstream with only ref", () => {
    expect(validateGitSyncPreview({ ...validPreview(), upstream: { ref: "origin/main" } })).toEqual(
      { ok: true },
    );
  });

  // The producer (keiko-server syncExecution.ts buildSyncPreview) sets
  // `executable: blockReason === undefined` directly, so the two are exact complements.
  it("rejects executable: true with a blockReason present", () => {
    const result = validateGitSyncPreview({
      ...validPreview(),
      executable: true,
      blockReason: "no-upstream",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reasons).toContain("blockReason must be absent when executable is true");
    }
  });

  it("rejects executable: false with no blockReason", () => {
    const input = validPreview();
    input.executable = false;
    delete input.blockReason;
    const result = validateGitSyncPreview(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reasons).toContain("blockReason must be present when executable is false");
    }
  });

  it("accepts executable: true with no blockReason, and executable: false with one", () => {
    const ready = validPreview();
    ready.executable = true;
    delete ready.blockReason;
    expect(validateGitSyncPreview(ready)).toEqual({ ok: true });
    expect(
      validateGitSyncPreview({ ...validPreview(), executable: false, blockReason: "no-remote" }),
    ).toEqual({ ok: true });
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

// Preserve both required-preview and optional-execute integer admission on ORIGINAL and SAME.
describe("Git sync scalar integer preservation", () => {
  for (const [surface, phase, parse, fixture] of [
    ["source", "preview", parseGitSyncPreview, validPreview],
    ["public", "preview", parsePublicPreview, validPreview],
    ["source", "execute", parseGitSyncExecuteResponse, validExecute],
    ["public", "execute", parsePublicExecute, validExecute],
  ] as const) {
    it(`${surface} ${phase}: retains negative zero and unsafe integers without coercion`, () => {
      for (const count of [-0, 0, 1, 9_007_199_254_740_992]) {
        const input = { ...fixture(), ahead: count };
        const result = parse(input);
        if (!result.ok) throw new TypeError("Expected the existing integer admission");
        expect(result.value).toBe(input);
        expect(result.value.ahead).toBe(count);
      }
      for (const count of [-1, 0.5, NaN, Infinity, "0", true, null]) {
        expect(parse({ ...fixture(), ahead: count })).toEqual({
          ok: false,
          reasons: [
            phase === "preview"
              ? "ahead must be a non-negative integer"
              : "ahead must be a non-negative integer when present",
          ],
        });
      }
    });
  }
});
