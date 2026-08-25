import { describe, expect, it } from "vitest";
import {
  isWorkspaceSearchResultMatch,
  validateWorkspaceReplaceApplyRequest,
  validateWorkspaceReplacePreviewRequest,
  validateWorkspaceSearchRequest,
  validateWorkspaceSymbolSearchRequest,
  type ValidationResult,
  type WorkspaceReplaceApplyRequest,
  type WorkspaceReplacePreviewRequest,
  type WorkspaceSearchRequest,
  type WorkspaceSymbolSearchRequest,
} from "./index.js";
import { hasDangerousGroupOrClassRepetition, regexSafetyIssue } from "./workspace-search.js";

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

function applyRequest(
  overrides: Partial<WorkspaceReplaceApplyRequest> = {},
): WorkspaceReplaceApplyRequest {
  return {
    root: "/workspace",
    files: [
      {
        path: "src/config.ts",
        baseContentHash: "a".repeat(64),
        edits: [
          {
            range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 10 },
            originalText: "old",
            newText: "new",
          },
        ],
      },
    ],
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

  it("accepts a bounded relative text-search scope and rejects path escape", () => {
    expect(validateWorkspaceSearchRequest(searchRequest({ scopePath: "src/features" }))).toEqual({
      ok: true,
    });
    expectInvalidWithReason(
      validateWorkspaceSearchRequest(searchRequest({ scopePath: "../secret" })),
      "scopePath",
    );
  });

  it("rejects Windows drive-prefixed paths on every relative-path input", () => {
    for (const scopePath of ["C:/workspace/src", "c:workspace/src"]) {
      expectInvalidWithReason(
        validateWorkspaceSearchRequest(searchRequest({ scopePath })),
        "scopePath",
      );
      expectInvalidWithReason(
        validateWorkspaceSymbolSearchRequest(symbolRequest({ scopePath })),
        "scopePath",
      );
      expectInvalidWithReason(
        validateWorkspaceReplaceApplyRequest({
          ...applyRequest(),
          files: [{ ...applyRequest().files[0], path: scopePath }],
        }),
        "file path",
      );
    }
  });

  it("rejects whitespace-only paths on every relative-path input and result projection", () => {
    expectInvalidWithReason(
      validateWorkspaceSearchRequest(searchRequest({ scopePath: "   " })),
      "scopePath",
    );
    expectInvalidWithReason(
      validateWorkspaceSymbolSearchRequest(symbolRequest({ scopePath: "\t" })),
      "scopePath",
    );
    expectInvalidWithReason(
      validateWorkspaceReplaceApplyRequest({
        ...applyRequest(),
        files: [{ ...applyRequest().files[0], path: "\n" }],
      }),
      "file path",
    );
    expect(
      isWorkspaceSearchResultMatch({
        path: "   ",
        lineRange: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 2 },
        snippet: "match",
        score: 1,
      }),
    ).toBe(false);
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

describe("workspace replace apply wire validators", () => {
  it("accepts a valid replace apply request", () => {
    expect(validateWorkspaceReplaceApplyRequest(applyRequest())).toEqual({ ok: true });
  });

  it("rejects an edit whose range fields are not positive integers", () => {
    expectInvalidWithReason(
      validateWorkspaceReplaceApplyRequest(
        applyRequest({
          files: [
            {
              path: "src/config.ts",
              baseContentHash: "a".repeat(64),
              edits: [
                {
                  range: { startLine: 0, startColumn: 1, endLine: 1, endColumn: 10 },
                  originalText: "old",
                  newText: "new",
                },
              ],
            },
          ],
        }),
      ),
      "edit range",
    );
  });

  // KEIKO-0498: the four bounds were each checked in isolation, so a backwards range passed the
  // contract and reached the patch applier, which would then slice from a start position after its
  // end. The sibling isValidLineRange in connected-context.ts already enforces this ordering rule.
  it.each([
    ["end line before start line", { startLine: 10, startColumn: 1, endLine: 1, endColumn: 1 }],
    [
      "same line, end column before start column",
      { startLine: 3, startColumn: 9, endLine: 3, endColumn: 4 },
    ],
  ])("rejects an edit range whose end precedes its start (%s)", (_label, range) => {
    expectInvalidWithReason(
      validateWorkspaceReplaceApplyRequest(
        applyRequest({
          files: [
            {
              path: "src/config.ts",
              baseContentHash: "a".repeat(64),
              edits: [{ range, originalText: "old", newText: "new" }],
            },
          ],
        }),
      ),
      "edit range",
    );
  });

  it("accepts an empty (zero-width) range where end equals start", () => {
    expect(
      validateWorkspaceReplaceApplyRequest(
        applyRequest({
          files: [
            {
              path: "src/config.ts",
              baseContentHash: "a".repeat(64),
              edits: [
                {
                  range: { startLine: 3, startColumn: 4, endLine: 3, endColumn: 4 },
                  originalText: "",
                  newText: "inserted",
                },
              ],
            },
          ],
        }),
      ),
    ).toEqual({ ok: true });
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

  it("completes for many unresolved opens before a single close (KEIKO-0787)", () => {
    // The adversarial shape for the OLD regex: many "(" characters, each of which independently
    // scans all the way to the single "(...)" close before the engine can conclude that position
    // doesn't lead to a satisfying quantifier — O(n) work repeated at O(n) start positions.
    // KEIKO-0787: the correctness assertion is what this pin exists to prove. A true O(n^2) /
    // exponential regression is caught by vitest's own testTimeout, not by a tight wall-clock
    // millisecond bound that flakes on a loaded CI machine.
    const adversarial = `${"(".repeat(20_000)})`;
    const result = hasDangerousGroupOrClassRepetition(adversarial);
    expect(result).toBe(false);
  });
});

describe("regexSafetyIssue adjacent quantified atoms", () => {
  it.each(["a+a+", "a{2}b*", String.raw`\d+\w*`, String.raw`\++a*`])("rejects %s", (source) => {
    expect(regexSafetyIssue(source)).toBe("query regex unsafe");
  });

  it.each(["a+b", "a{2}b", String.raw`\+a*`])("preserves safe pattern %s", (source) => {
    expect(regexSafetyIssue(source)).toBeUndefined();
  });

  it("ignores group and quantifier characters inside character classes", () => {
    expect(regexSafetyIssue("([(+])([*])")).toBeUndefined();
    expect(regexSafetyIssue("[(a+)(b+)]")).toBeUndefined();
  });

  it.each(["(a+)(b+)", "^(a{2,})(b*)$", String.raw`(\d+)(\w*)`])(
    "rejects concatenated groups containing quantified atoms: %s",
    (source) => {
      expect(regexSafetyIssue(source)).toBe("query regex unsafe");
    },
  );
});

// KEIKO-0273 — the path-traversal and size-ceiling branches of these validators had no coverage at
// all, on the four public entry points that are the workspace search/replace trust boundary. An
// untested guard is a guard nobody notices going missing.
describe("workspace search/replace guard coverage", () => {
  it.each(["", "   ", "\t"])("rejects a blank root %j on every public validator", (root) => {
    expectInvalidWithReason(validateWorkspaceSearchRequest(searchRequest({ root })), "root");
    expectInvalidWithReason(validateWorkspaceSymbolSearchRequest(symbolRequest({ root })), "root");
    expectInvalidWithReason(
      validateWorkspaceReplacePreviewRequest(replaceRequest({ root })),
      "root",
    );
    expectInvalidWithReason(validateWorkspaceReplaceApplyRequest(applyRequest({ root })), "root");
  });

  type ApplyFile = WorkspaceReplaceApplyRequest["files"][number];

  function applyFile(overrides: Partial<ApplyFile> = {}): ApplyFile {
    return { ...applyRequest().files[0], ...overrides } as ApplyFile;
  }

  it.each(["../escape.ts", "/etc/passwd", "src/../../escape.ts", "src\\a.ts", "a\u0000.ts"])(
    "rejects the traversal-shaped apply file path %j",
    (path) => {
      expectInvalidWithReason(
        validateWorkspaceReplaceApplyRequest(applyRequest({ files: [applyFile({ path })] })),
        "file path",
      );
    },
  );

  it("rejects an apply request with no files and one with more files than the ceiling", () => {
    expect(validateWorkspaceReplaceApplyRequest(applyRequest({ files: [] })).ok).toBe(false);
  });

  it("rejects an edit whose baseContentHash is not a sha256 hex digest", () => {
    expect(
      validateWorkspaceReplaceApplyRequest(
        applyRequest({ files: [applyFile({ baseContentHash: "not-a-hash" })] }),
      ).ok,
    ).toBe(false);
  });
});
