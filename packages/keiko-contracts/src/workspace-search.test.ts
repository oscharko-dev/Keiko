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
