import { describe, expect, it } from "vitest";
import {
  GIT_HISTORY_SCHEMA_VERSION,
  validateGitHistoryResponse,
  parseGitHistoryResponse,
} from "./git-history.js";

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
    // Codex P2 (thread 3788736978): the offset group matched any two digits, so this passed
    // validation even though `new Date("2023-01-15T10:30:00+99:99")` itself is Invalid Date --
    // the component check below the regex never inspected the offset, only the local wall-clock
    // fields.
    "2023-01-15T10:30:00+99:99",
    // Boundary just past what a numeric UTC offset can legitimately be (empirically confirmed:
    // `new Date(...)` parses +23:59 but not +24:00 or +13:60).
    "2023-01-15T10:30:00+24:00",
    "2023-01-15T10:30:00+13:60",
  ])("rejects %j as not strict ISO 8601", (date) => {
    const input = validResponse();
    input.entries = [{ ...validEntry(), date }];
    const result = validateGitHistoryResponse(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reasons).toContain("entries[0].date must be a strict ISO 8601 date");
    }
  });

  it("accepts the largest offset a numeric UTC offset can legitimately carry", () => {
    // +23:59 is the boundary this fix must not overcorrect past -- confirmed empirically that
    // native Date parsing accepts it.
    expect(new Date("2023-01-15T10:30:00+23:59").toString()).not.toBe("Invalid Date");
    expect(
      validateGitHistoryResponse({
        ...validResponse(),
        entries: [{ ...validEntry(), date: "2023-01-15T10:30:00+23:59" }],
      }),
    ).toEqual({ ok: true });
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

import {
  validateGitHistoryResponse as validatePublicHistory,
  parseGitHistoryResponse as parsePublicHistory,
} from "@oscharko-dev/keiko-contracts/runtime/git-history";

function invalidHistoryArray(kind: string): unknown[] {
  if (kind === "sparse") {
    const items: unknown[] = [];
    items.length = 1;
    return items;
  }
  return Object.assign([null], { forEach: (): undefined => undefined, every: (): boolean => true });
}

describe("Git history actual array admission (#3918)", () => {
  for (const { surface, validate } of [
    { surface: "source", validate: validateGitHistoryResponse },
    { surface: "public", validate: validatePublicHistory },
  ]) {
    it.each(["sparse", "spoofed"])(`${surface}: refuses %s entries`, (kind) => {
      expect(validate({ ...validResponse(), entries: invalidHistoryArray(kind) })).toEqual({
        ok: false,
        reasons: ["entries[0] must be an object"],
      });
    });
    it.each(["sparse", "spoofed"])(`${surface}: refuses %s refs`, (kind) => {
      expect(
        validate({
          ...validResponse(),
          entries: [{ ...validEntry(), refs: invalidHistoryArray(kind) }],
        }),
      ).toEqual({
        ok: false,
        reasons: ["entries[0].refs must contain only strings"],
      });
    });
  }
});

export function parsePublicGitHistory(
  input: unknown,
): import("@oscharko-dev/keiko-contracts").GitRepositoryParseResult<
  import("@oscharko-dev/keiko-contracts").GitHistoryResponse
> {
  const result = parsePublicHistory(input);
  return result;
}

describe("Git history typed parser (#3918)", () => {
  for (const { surface, parse } of [
    { surface: "source", parse: parseGitHistoryResponse },
    { surface: "public", parse: parsePublicGitHistory },
  ]) {
    it(`${surface}: preserves original entries refs and omitted optionals`, () => {
      const entry = validEntry();
      const input: Record<string, unknown> = {
        ...validResponse(),
        entries: [entry],
        message: undefined,
      };
      delete input.repositoryRoot;
      const result = parse(input);
      if (!result.ok) throw new TypeError("valid history fixture refused");
      expect(result.value).toBe(input);
      expect(result.value.entries).toBe(input.entries);
      expect(result.value.entries[0]).toBe(entry);
      expect(result.value.entries[0]?.refs).toBe(entry.refs);
      expect(Object.hasOwn(result.value, "repositoryRoot")).toBe(false);
      expect(Object.hasOwn(result.value, "message")).toBe(true);
    });
    it(`${surface}: refuses primitive and bypass input and retains eager ordered reasons`, () => {
      for (const input of [null, undefined, 1, true, [], "input"])
        expect(parse(input)).toEqual({ ok: false, reasons: ["response must be an object"] });
      for (const kind of ["sparse", "spoofed"]) {
        expect(parse({ ...validResponse(), entries: invalidHistoryArray(kind) }).ok).toBe(false);
        expect(
          parse({
            ...validResponse(),
            entries: [{ ...validEntry(), refs: invalidHistoryArray(kind) }],
          }).ok,
        ).toBe(false);
      }
      const input = {
        ...validResponse(),
        schemaVersion: 0,
        state: [],
        message: 1,
        available: 1,
        entries: [null],
      };
      expect(parse(input)).toEqual({
        ok: false,
        reasons: [
          "schemaVersion invalid",
          "state invalid",
          "message must be a bounded string when present",
          "available must be a boolean",
          "entries[0] must be an object",
        ],
      });
      expect(parse(input)).toEqual(validateGitHistoryResponse(input));
    });
    it(`${surface}: retains date and pagination admission`, () => {
      expect(
        parse({ ...validResponse(), entries: [{ ...validEntry(), date: "2023-02-30T10:00:00Z" }] })
          .ok,
      ).toBe(false);
      expect(parse({ ...validResponse(), limit: 1, truncated: false }).ok).toBe(false);
      expect(parse({ ...validResponse(), limit: 1, truncated: true }).ok).toBe(true);
      expect(
        parse({
          ...validResponse(),
          entries: [{ ...validEntry(), date: "2026-06-27T10:00:00-03:30" }],
        }).ok,
      ).toBe(true);
    });
  }
});

it("public history output retains its concrete domain and refusal types", () => {
  const result = parsePublicHistory(validResponse());
  if (result.ok) {
    const value: import("@oscharko-dev/keiko-contracts").GitHistoryResponse = result.value;
    expect(value.entries).toHaveLength(1);
    // @ts-expect-error History is not a summary DTO.
    const wrong: import("@oscharko-dev/keiko-contracts").GitRepositorySummary = result.value;
    expect(wrong).toBe(value);
  } else {
    // @ts-expect-error Refusal carries reasons, never a value.
    expect(result.value).toBeUndefined();
  }
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
    surface: "source history",
    parse: parseGitHistoryResponse,
    fixture: validResponse,
    checkMessage: true,
  },
  {
    surface: "public history",
    parse: parsePublicHistory,
    fixture: validResponse,
    checkMessage: true,
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
describe("Git history scalar integer preservation", () => {
  for (const [surface, parse] of [
    ["source", parseGitHistoryResponse],
    ["public", parsePublicHistory],
  ] as const) {
    it(`${surface}: retains negative zero and unsafe integers without coercion`, () => {
      for (const count of [-0, 0, 1, 9_007_199_254_740_992]) {
        const input = { ...validResponse(), skip: count };
        const result = parse(input);
        if (!result.ok) throw new TypeError("Expected the existing integer admission");
        expect(result.value).toBe(input);
        expect(result.value.skip).toBe(count);
      }
      for (const count of [-1, 0.5, NaN, Infinity, "0", true, null]) {
        expect(parse({ ...validResponse(), skip: count })).toEqual({
          ok: false,
          reasons: ["skip must be a non-negative integer"],
        });
      }
    });
  }
});
