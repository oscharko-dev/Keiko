import { describe, expect, it } from "vitest";
import {
  GIT_REPOSITORY_SUMMARY_SCHEMA_VERSION,
  validateGitRemotesResponse,
  validateGitRepositorySummary,
  parseGitRepositorySummary,
  parseGitRemotesResponse,
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
    remotes: [
      {
        name: "origin",
        fetchUrl: "https://example.invalid/a.git",
        pushUrl: "https://example.invalid/a.git",
      },
    ],
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

  // KEIKO-0904: a remote URL carrying userinfo (username or password) or exceeding the shared
  // length cap must not cross this wire — the summary path already rejects URLs entirely, and the
  // detailed path (allowUrls=true) is where the redaction discipline is enforced.
  it("rejects a fetchUrl/pushUrl carrying embedded credentials (KEIKO-0904)", () => {
    const withUser = validateGitRemotesResponse({
      ...validRemotes(),
      remotes: [{ name: "origin", fetchUrl: "https://user:token@example.invalid/a.git" }],
    });
    expect(withUser.ok).toBe(false);
    if (!withUser.ok) {
      expect(withUser.reasons).toContain("remotes[0].fetchUrl is not a redaction-safe URL");
    }
    const withPushCredential = validateGitRemotesResponse({
      ...validRemotes(),
      remotes: [
        {
          name: "origin",
          fetchUrl: "https://example.invalid/a.git",
          pushUrl: "https://:token@example.invalid/a.git",
        },
      ],
    });
    expect(withPushCredential.ok).toBe(false);
    if (!withPushCredential.ok) {
      expect(withPushCredential.reasons).toContain(
        "remotes[0].pushUrl is not a redaction-safe URL",
      );
    }
  });

  it("rejects an unparseable or empty remote URL (KEIKO-0904)", () => {
    const empty = validateGitRemotesResponse({
      ...validRemotes(),
      remotes: [{ name: "origin", fetchUrl: "" }],
    });
    expect(empty.ok).toBe(false);
    const notAUrl = validateGitRemotesResponse({
      ...validRemotes(),
      remotes: [{ name: "origin", fetchUrl: "not a url with spaces" }],
    });
    expect(notAUrl.ok).toBe(false);
  });

  // KEIKO-0904: `git remote -v` emits two canonical no-secret shapes that `new URL()` either
  // cannot parse or treats as credentialed; both must be accepted.
  it("accepts the scp-like SSH remote form (KEIKO-0904)", () => {
    for (const remote of [
      "git@github.com:oscharko-dev/Keiko.git",
      "user@gitlab.internal:group/subgroup/repo.git",
    ]) {
      const result = validateGitRemotesResponse({
        ...validRemotes(),
        remotes: [{ name: "origin", fetchUrl: remote }],
      });
      expect(result).toEqual({ ok: true });
    }
  });

  it("accepts an ssh:// remote whose user is the well-known service account (KEIKO-0904)", () => {
    for (const remote of [
      "ssh://git@github.com/oscharko-dev/Keiko.git",
      "ssh://git@ssh.dev.azure.com:22/org/proj/_git/repo",
    ]) {
      const result = validateGitRemotesResponse({
        ...validRemotes(),
        remotes: [{ name: "origin", fetchUrl: remote }],
      });
      expect(result).toEqual({ ok: true });
    }
  });

  it("still rejects a non-service-user URL with an explicit password (KEIKO-0904)", () => {
    const result = validateGitRemotesResponse({
      ...validRemotes(),
      remotes: [{ name: "origin", fetchUrl: "ssh://someuser:token@host.example/repo" }],
    });
    expect(result.ok).toBe(false);
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

import {
  validateGitRepositorySummary as validatePublicSummary,
  validateGitRemotesResponse as validatePublicRemotes,
  parseGitRepositorySummary as parsePublicSummary,
  parseGitRemotesResponse as parsePublicRemotes,
} from "@oscharko-dev/keiko-contracts/runtime/git-repository-summary";

function invalidRemoteArray(kind: string): unknown[] {
  if (kind === "sparse") {
    const items: unknown[] = [];
    items.length = 1;
    return items;
  }
  return Object.assign([null], { forEach: (): undefined => undefined });
}

describe("Git summary and remotes actual array admission (#3918)", () => {
  for (const { surface, validate, fixture } of [
    { surface: "source summary", validate: validateGitRepositorySummary, fixture: validSummary },
    { surface: "public summary", validate: validatePublicSummary, fixture: validSummary },
    { surface: "source remotes", validate: validateGitRemotesResponse, fixture: validRemotes },
    { surface: "public remotes", validate: validatePublicRemotes, fixture: validRemotes },
  ]) {
    it.each(["sparse", "spoofed"])(`${surface}: refuses %s remotes`, (kind) => {
      expect(validate({ ...fixture(), remotes: invalidRemoteArray(kind) })).toEqual({
        ok: false,
        reasons: ["remotes[0] must be an object"],
      });
    });
  }
});

export function parsePublicGitSummary(
  input: unknown,
): import("@oscharko-dev/keiko-contracts").GitRepositoryParseResult<
  import("@oscharko-dev/keiko-contracts").GitRepositorySummary
> {
  const result = parsePublicSummary(input);
  return result;
}

export function parsePublicGitRemotes(
  input: unknown,
): import("@oscharko-dev/keiko-contracts").GitRepositoryParseResult<
  import("@oscharko-dev/keiko-contracts").GitRemotesResponse
> {
  const result = parsePublicRemotes(input);
  return result;
}

describe("Git summary and remotes typed parsers (#3918)", () => {
  for (const { surface, summary, remotes } of [
    { surface: "source", summary: parseGitRepositorySummary, remotes: parseGitRemotesResponse },
    { surface: "public", summary: parsePublicGitSummary, remotes: parsePublicGitRemotes },
  ]) {
    it(`${surface}: preserves original nested values and optional presence`, () => {
      const input = validSummary();
      input.message = undefined;
      delete input.branch;
      const result = summary(input);
      if (!result.ok) throw new TypeError("valid summary refused");
      expect(result.value).toBe(input);
      expect(result.value.remotes).toBe(input.remotes);
      expect(result.value.upstream).toBe(input.upstream);
      expect(result.value.lastSync).toBe(input.lastSync);
      expect(Object.hasOwn(result.value, "branch")).toBe(false);
      expect(Object.hasOwn(result.value, "message")).toBe(true);
      const remoteInput = validRemotes();
      const remoteResult = remotes(remoteInput);
      if (!remoteResult.ok) throw new TypeError("valid remotes refused");
      expect(remoteResult.value).toBe(remoteInput);
      expect(remoteResult.value.remotes).toBe(remoteInput.remotes);
    });
    it(`${surface}: refuses primitives sparse and spoofed remotes with eager reasons`, () => {
      for (const input of [undefined, null, 1, true, [], "input"]) {
        expect(summary(input)).toEqual({ ok: false, reasons: ["response must be an object"] });
        expect(remotes(input)).toEqual({ ok: false, reasons: ["response must be an object"] });
      }
      for (const kind of ["sparse", "spoofed"]) {
        expect(summary({ ...validSummary(), remotes: invalidRemoteArray(kind) }).ok).toBe(false);
        expect(remotes({ ...validRemotes(), remotes: invalidRemoteArray(kind) }).ok).toBe(false);
      }
      const input = {
        ...validSummary(),
        schemaVersion: 0,
        state: [],
        message: 1,
        available: 1,
        remotes: [null],
      };
      expect(summary(input)).toEqual({
        ok: false,
        reasons: [
          "schemaVersion invalid",
          "state invalid",
          "message must be a bounded string when present",
          "available must be a boolean",
          "remotes[0] must be an object",
        ],
      });
      expect(summary(input)).toEqual(validateGitRepositorySummary(input));
    });
    it(`${surface}: retains URL redaction and upstream pair admission`, () => {
      expect(
        summary({
          ...validSummary(),
          remotes: [{ name: "origin", fetchUrl: "https://example.invalid/repo" }],
        }).ok,
      ).toBe(false);
      expect(
        remotes({
          ...validRemotes(),
          remotes: [{ name: "origin", fetchUrl: "https://user:password@example.invalid/repo" }],
        }).ok,
      ).toBe(false);
      expect(
        remotes({
          ...validRemotes(),
          remotes: [{ name: "origin", fetchUrl: "git@example.invalid:org/repo.git" }],
        }).ok,
      ).toBe(true);
      expect(
        summary({ ...validSummary(), upstream: { ref: "origin/main", remote: "origin" } }).ok,
      ).toBe(false);
      expect(
        summary({ ...validSummary(), upstream: { ref: "origin/main" }, lastSync: {} }).ok,
      ).toBe(true);
    });
  }
});

it("public summary and remotes retain distinct typed values", () => {
  const summary = parsePublicSummary(validSummary());
  const remotes = parsePublicRemotes(validRemotes());
  if (!summary.ok || !remotes.ok) throw new TypeError("valid Git fixtures refused");
  const value: import("@oscharko-dev/keiko-contracts").GitRepositorySummary = summary.value;
  const remoteValue: import("@oscharko-dev/keiko-contracts").GitRemotesResponse = remotes.value;
  expect(value.ahead).toBe(2);
  expect(remoteValue.remotes[0]?.fetchUrl).toBeDefined();
  // @ts-expect-error The reduced remotes envelope is not a complete repository summary.
  const wrong: import("@oscharko-dev/keiko-contracts").GitRepositorySummary = remotes.value;
  expect(wrong).toBe(remoteValue);
});

function observedReadEnvelope(
  input: Record<string, unknown>,
  reads: string[],
): Record<string, unknown> {
  const observed: ReadonlySet<PropertyKey> = new Set([
    "schemaVersion",
    "root",
    "state",
    "reason",
    "message",
    "repositoryRoot",
  ]);
  return new Proxy(input, {
    get(target, key, receiver): unknown {
      if (observed.has(key)) reads.push(String(key));
      return Reflect.get(target, key, receiver);
    },
  });
}

for (const { surface, parse, fixture, checkMessage } of [
  {
    surface: "source summary",
    parse: parseGitRepositorySummary,
    fixture: validSummary,
    checkMessage: true,
  },
  {
    surface: "public summary",
    parse: parsePublicSummary,
    fixture: validSummary,
    checkMessage: true,
  },
  {
    surface: "source remotes",
    parse: parseGitRemotesResponse,
    fixture: validRemotes,
    checkMessage: false,
  },
  {
    surface: "public remotes",
    parse: parsePublicRemotes,
    fixture: validRemotes,
    checkMessage: false,
  },
]) {
  it(`${surface}: retains Git read envelope admission`, () => {
    const healthy = fixture();
    const admitted = parse(healthy);
    expect(admitted.ok).toBe(true);
    if (admitted.ok) expect(admitted.value).toBe(healthy);
    const reads: string[] = [];
    const input = observedReadEnvelope(
      {
        ...healthy,
        schemaVersion: 0,
        root: 0,
        state: 0,
        reason: 0,
        message: 0,
        repositoryRoot: 0,
      },
      reads,
    );
    expect(parse(input)).toEqual({
      ok: false,
      reasons: [
        "schemaVersion invalid",
        "root must be a string",
        "state invalid",
        "reason invalid",
        ...(checkMessage ? ["message must be a bounded string when present"] : []),
        "repositoryRoot must be a string when present",
      ],
    });
    expect(reads).toEqual([
      "schemaVersion",
      "root",
      "state",
      "reason",
      "reason",
      ...(checkMessage ? ["message", "message"] : []),
      "repositoryRoot",
      "repositoryRoot",
    ]);
  });
}

// Preserve the current wire integer contract; these are characterization cases on ORIGINAL and SAME.
describe("Git summary scalar integer preservation", () => {
  for (const [surface, parse] of [
    ["source", parseGitRepositorySummary],
    ["public", parsePublicSummary],
  ] as const) {
    it(`${surface}: retains negative zero and unsafe integers without coercion`, () => {
      for (const count of [-0, 0, 1, 9_007_199_254_740_992]) {
        const input = { ...validSummary(), ahead: count };
        const result = parse(input);
        if (!result.ok) throw new TypeError("Expected the existing integer admission");
        expect(result.value).toBe(input);
        expect(result.value.ahead).toBe(count);
      }
      for (const count of [-1, 0.5, NaN, Infinity, "0", true, null]) {
        expect(parse({ ...validSummary(), ahead: count })).toEqual({
          ok: false,
          reasons: ["ahead must be a non-negative integer"],
        });
      }
    });
  }
});
