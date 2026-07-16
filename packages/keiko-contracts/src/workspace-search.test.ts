import { describe, expect, it } from "vitest";
import {
  validateWorkspaceReplacePreviewRequest,
  validateWorkspaceSearchRequest,
  validateWorkspaceSymbolSearchRequest,
  type ValidationResult,
  type WorkspaceReplacePreviewRequest,
  type WorkspaceSearchRequest,
  type WorkspaceSymbolSearchRequest,
} from "./index.js";
import { hasDangerousGroupOrClassRepetition } from "./workspace-search.js";

function expectInvalidWithReason(result: ValidationResult, fragment: string): void {
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.reasons.some((reason) => reason.includes(fragment))).toBe(true);
  }
}

function searchRequest(overrides: Partial<WorkspaceSearchRequest> = {}): WorkspaceSearchRequest {
  return {
    root: "/workspace",
    query: "parseConfig",
    mode: "literal",
    caseSensitive: false,
    includeGlobs: ["src/**/*.ts"],
    excludeGlobs: ["**/*.test.ts"],
    maxResults: 50,
    ...overrides,
  };
}

function replaceRequest(
  overrides: Partial<WorkspaceReplacePreviewRequest> = {},
): WorkspaceReplacePreviewRequest {
  return {
    root: "/workspace",
    query: "parseConfig",
    mode: "literal",
    caseSensitive: false,
    includeGlobs: ["src/**/*.ts"],
    excludeGlobs: [],
    replacement: "readConfig",
    maxFiles: 20,
    ...overrides,
  };
}

function symbolRequest(
  overrides: Partial<WorkspaceSymbolSearchRequest> = {},
): WorkspaceSymbolSearchRequest {
  return {
    root: "/workspace",
    query: "parseConfig",
    maxResults: 50,
    ...overrides,
  };
}

describe("workspace search wire validators", () => {
  it("accepts a valid workspace search request", () => {
    expect(validateWorkspaceSearchRequest(searchRequest())).toEqual({ ok: true });
  });

  it("keeps literal and regex mode separate from case sensitivity", () => {
    expect(
      validateWorkspaceSearchRequest(searchRequest({ mode: "regex", query: "parse\\w+" })),
    ).toEqual({
      ok: true,
    });
    expectInvalidWithReason(
      validateWorkspaceSearchRequest(searchRequest({ mode: "case-sensitive" as "literal" })),
      "mode",
    );
  });

  it("accepts an optional whole-word flag and rejects non-boolean values", () => {
    expect(validateWorkspaceSearchRequest({ ...searchRequest(), wholeWord: true })).toEqual({
      ok: true,
    });
    expectInvalidWithReason(
      validateWorkspaceSearchRequest({ ...searchRequest(), wholeWord: "yes" }),
      "wholeWord",
    );
  });

  it("rejects empty and whitespace-only queries", () => {
    expectInvalidWithReason(validateWorkspaceSearchRequest(searchRequest({ query: "" })), "query");
    expectInvalidWithReason(
      validateWorkspaceSearchRequest(searchRequest({ query: "   " })),
      "query",
    );
  });

  it("rejects unsafe or invalid regex queries before route execution", () => {
    expectInvalidWithReason(
      validateWorkspaceSearchRequest(searchRequest({ mode: "regex", query: "(a+)+" })),
      "regex",
    );
    expectInvalidWithReason(
      validateWorkspaceSearchRequest(searchRequest({ mode: "regex", query: "(" })),
      "regex",
    );
  });

  it("rejects out-of-range maxResults values", () => {
    expectInvalidWithReason(
      validateWorkspaceSearchRequest(searchRequest({ maxResults: 0 })),
      "max",
    );
    expectInvalidWithReason(
      validateWorkspaceSearchRequest(searchRequest({ maxResults: 201 })),
      "max",
    );
  });

  it("rejects malformed include and exclude globs", () => {
    expectInvalidWithReason(
      validateWorkspaceSearchRequest(searchRequest({ includeGlobs: ["/abs/*.ts"] })),
      "includeGlobs",
    );
    expectInvalidWithReason(
      validateWorkspaceSearchRequest(searchRequest({ excludeGlobs: ["../secret"] })),
      "excludeGlobs",
    );
  });
});

describe("workspace symbol search wire validators", () => {
  it("accepts a valid workspace symbol request with an optional scope", () => {
    expect(
      validateWorkspaceSymbolSearchRequest(symbolRequest({ scopePath: "src/features" })),
    ).toEqual({
      ok: true,
    });
  });

  it("rejects invalid symbol request fields", () => {
    expectInvalidWithReason(
      validateWorkspaceSymbolSearchRequest(symbolRequest({ query: " " })),
      "query",
    );
    expectInvalidWithReason(
      validateWorkspaceSymbolSearchRequest(symbolRequest({ maxResults: 201 })),
      "maxResults",
    );
    expectInvalidWithReason(
      validateWorkspaceSymbolSearchRequest(symbolRequest({ scopePath: "../secret" })),
      "scopePath",
    );
  });
});

describe("workspace replace preview wire validators", () => {
  it("accepts a valid replace preview request", () => {
    expect(validateWorkspaceReplacePreviewRequest(replaceRequest())).toEqual({ ok: true });
  });

  it("rejects invalid replacement and maxFiles fields", () => {
    expectInvalidWithReason(
      validateWorkspaceReplacePreviewRequest({
        ...replaceRequest(),
        replacement: undefined as unknown as string,
      }),
      "replacement",
    );
    expectInvalidWithReason(
      validateWorkspaceReplacePreviewRequest(replaceRequest({ maxFiles: 0 })),
      "maxFiles",
    );
  });

  it("rejects unsafe regex queries for replace preview", () => {
    expectInvalidWithReason(
      validateWorkspaceReplacePreviewRequest(replaceRequest({ mode: "regex", query: "(a+)+" })),
      "regex",
    );
  });
});

// SonarCloud S8786: the old `/\([^)]*\)[+*{]|\[[^\]]*\][+*{]/` check is unanchored, so a
// backtracking engine retries every start position; when a "(" or "[" is present but the string
// never gives it a satisfying close + quantifier, each of the O(n) positions costs O(n) to
// disprove. hasDangerousGroupOrClassRepetition replaces it with a single left-to-right scan.
describe("hasDangerousGroupOrClassRepetition", () => {
  it.each([
    ["(a+)+", true],
    ["[abc]+", true],
    ["(abc){2}", true],
    ["[abc]*", true],
    ["a(b)c", false],
    ["(abc)", false],
    ["[abc]", false],
    ["abc+", false],
    ["(", false],
    [")", false],
    ["]", false],
    ["([)]+", true],
    ["(a))+", false],
    ["", false],
  ])("flags %s as dangerous=%s", (source, expected) => {
    expect(hasDangerousGroupOrClassRepetition(source)).toBe(expected);
  });

  it("completes within a tight budget for many unresolved opens before a single close", () => {
    // The adversarial shape for the OLD regex: many "(" characters, each of which independently
    // scans all the way to the single "(...)" close before the engine can conclude that position
    // doesn't lead to a satisfying quantifier — O(n) work repeated at O(n) start positions.
    const adversarial = `${"(".repeat(20_000)})`;
    const start = Date.now();
    const result = hasDangerousGroupOrClassRepetition(adversarial);
    const elapsedMs = Date.now() - start;
    expect(elapsedMs).toBeLessThan(200);
    expect(result).toBe(false);
  });
});
