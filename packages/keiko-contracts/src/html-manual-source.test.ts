import { describe, expect, it } from "vitest";
import {
  DEFAULT_DOCUMENTATION_MANUAL_SCOPE_LIMITS,
  type DocumentationIndexingApproval,
} from "./documentation-manual-proposal.js";
import { validateKnowledgeSourceScope } from "./local-knowledge-validation.js";
import {
  deriveHtmlManualSource,
  htmlManualLocalFolderScope,
  htmlManualReachableFilesScope,
  HTML_MANUAL_INCLUDE_GLOBS,
  HTML_MANUAL_SOURCE_SCHEMA_VERSION,
  isSafeManualOrigin,
  isSafeManualPathPrefix,
  summarizeHtmlManualSource,
  validateHtmlManualCrawlScope,
  validateHtmlManualScopeLimits,
  validateHtmlManualSource,
  type HtmlManualCrawlScope,
  type HtmlManualSource,
} from "./html-manual-source.js";

const RLO = String.fromCodePoint(0x202e);

function approvalFixture(
  overrides: Partial<DocumentationIndexingApproval> = {},
): DocumentationIndexingApproval {
  return {
    schemaVersion: "1",
    approved: true,
    sourceKind: "html-manual-http",
    sourceFingerprint: "fp-abc123",
    originSummary: "https://docs.internal",
    pathPrefixSummary: "/…",
    proposedPodName: "docs.internal manual",
    limits: DEFAULT_DOCUMENTATION_MANUAL_SCOPE_LIMITS,
    ...overrides,
  };
}

function httpScope(overrides: Partial<{ origin: string; pathPrefix: string | null }> = {}): {
  readonly kind: "html-manual-http";
  readonly origin: string;
  readonly pathPrefix: string | null;
} {
  return {
    kind: "html-manual-http",
    origin: overrides.origin ?? "https://docs.internal",
    pathPrefix: overrides.pathPrefix === undefined ? "/docs" : overrides.pathPrefix,
  };
}

function sourceFixture(overrides: Partial<HtmlManualSource> = {}): HtmlManualSource {
  return {
    schemaVersion: HTML_MANUAL_SOURCE_SCHEMA_VERSION,
    scope: httpScope(),
    limits: DEFAULT_DOCUMENTATION_MANUAL_SCOPE_LIMITS,
    sourceFingerprint: "fp-abc123",
    proposedPodName: "docs.internal manual",
    ...overrides,
  };
}

describe("isSafeManualOrigin", () => {
  it("accepts a canonical origin with and without an explicit port", () => {
    expect(isSafeManualOrigin("https://docs.internal")).toBe(true);
    expect(isSafeManualOrigin("http://10.0.0.5:8080")).toBe(true);
  });

  it("rejects a trailing path, query, fragment, credentials, or non-http scheme", () => {
    expect(isSafeManualOrigin("https://docs.internal/")).toBe(false);
    expect(isSafeManualOrigin("https://docs.internal/docs")).toBe(false);
    expect(isSafeManualOrigin("https://docs.internal?a=1")).toBe(false);
    expect(isSafeManualOrigin("https://user:pass@docs.internal")).toBe(false);
    expect(isSafeManualOrigin("ftp://docs.internal")).toBe(false);
    expect(isSafeManualOrigin("not a url")).toBe(false);
  });
});

describe("isSafeManualPathPrefix", () => {
  it("accepts null and safe absolute-style prefixes", () => {
    expect(isSafeManualPathPrefix(null)).toBe(true);
    expect(isSafeManualPathPrefix("/")).toBe(true);
    expect(isSafeManualPathPrefix("/docs/handbook")).toBe(true);
  });

  it("rejects relative, traversal, query, fragment, credential, and NUL forms", () => {
    expect(isSafeManualPathPrefix("")).toBe(false);
    expect(isSafeManualPathPrefix("docs")).toBe(false);
    expect(isSafeManualPathPrefix("/docs/../secrets")).toBe(false);
    expect(isSafeManualPathPrefix("/docs?token=x")).toBe(false);
    expect(isSafeManualPathPrefix("/docs#frag")).toBe(false);
    expect(isSafeManualPathPrefix("/docs@evil")).toBe(false);
    expect(isSafeManualPathPrefix("/docs\0")).toBe(false);
  });
});

describe("validateHtmlManualCrawlScope", () => {
  it("accepts a safe local scope with and without an entry path", () => {
    expect(
      validateHtmlManualCrawlScope({ kind: "html-manual-local", rootPath: "manuals/x" }).ok,
    ).toBe(true);
    expect(
      validateHtmlManualCrawlScope({
        kind: "html-manual-local",
        rootPath: "manuals/x",
        entryPath: "guide/index.html",
      }).ok,
    ).toBe(true);
  });

  it("rejects a traversal entry path on a local scope", () => {
    const result = validateHtmlManualCrawlScope({
      kind: "html-manual-local",
      rootPath: "manuals/x",
      entryPath: "../../etc/passwd",
    });
    expect(result.ok).toBe(false);
  });

  it("accepts a safe http scope with a root or sub-path prefix", () => {
    expect(validateHtmlManualCrawlScope(httpScope({ pathPrefix: null })).ok).toBe(true);
    expect(validateHtmlManualCrawlScope(httpScope({ pathPrefix: "/docs" })).ok).toBe(true);
  });

  it("rejects a traversal local root", () => {
    const result = validateHtmlManualCrawlScope({
      kind: "html-manual-local",
      rootPath: "../escape",
    });
    expect(result.ok).toBe(false);
  });

  it("rejects a credentialed or path-bearing http origin", () => {
    expect(
      validateHtmlManualCrawlScope(httpScope({ origin: "https://u:p@docs.internal" })).ok,
    ).toBe(false);
    expect(
      validateHtmlManualCrawlScope(httpScope({ origin: "https://docs.internal/docs" })).ok,
    ).toBe(false);
  });

  it("rejects an unsafe http path prefix and an unknown kind", () => {
    expect(validateHtmlManualCrawlScope(httpScope({ pathPrefix: "/a/../b" })).ok).toBe(false);
    expect(validateHtmlManualCrawlScope({ kind: "html-manual-remote" }).ok).toBe(false);
    expect(validateHtmlManualCrawlScope(null).ok).toBe(false);
  });

  it("rejects a non-string http path prefix", () => {
    const result = validateHtmlManualCrawlScope({
      kind: "html-manual-http",
      origin: "https://docs.internal",
      pathPrefix: 5,
    });
    expect(result.ok).toBe(false);
  });
});

describe("validateHtmlManualScopeLimits", () => {
  it("accepts the governed defaults and any narrowing", () => {
    expect(validateHtmlManualScopeLimits(DEFAULT_DOCUMENTATION_MANUAL_SCOPE_LIMITS)).toEqual([]);
    expect(
      validateHtmlManualScopeLimits({
        ...DEFAULT_DOCUMENTATION_MANUAL_SCOPE_LIMITS,
        maxPages: 10,
        maxDepth: 1,
      }),
    ).toEqual([]);
  });

  it("rejects any widening beyond the governed default", () => {
    expect(
      validateHtmlManualScopeLimits({
        ...DEFAULT_DOCUMENTATION_MANUAL_SCOPE_LIMITS,
        maxPages: 201,
      }).length,
    ).toBeGreaterThan(0);
  });

  it("rejects non-integer limits and a redirect override", () => {
    expect(
      validateHtmlManualScopeLimits({
        ...DEFAULT_DOCUMENTATION_MANUAL_SCOPE_LIMITS,
        maxBytes: 1.5,
      }).length,
    ).toBeGreaterThan(0);
    expect(
      validateHtmlManualScopeLimits({
        ...DEFAULT_DOCUMENTATION_MANUAL_SCOPE_LIMITS,
        followRedirects: true,
      }).length,
    ).toBeGreaterThan(0);
    expect(validateHtmlManualScopeLimits(null).length).toBeGreaterThan(0);
  });
});

describe("validateHtmlManualSource", () => {
  it("accepts a well-formed source", () => {
    expect(validateHtmlManualSource(sourceFixture()).ok).toBe(true);
  });

  it("rejects a bad schema version, empty fingerprint, and unsafe pod name", () => {
    expect(validateHtmlManualSource(sourceFixture({ schemaVersion: "2" as "1" })).ok).toBe(false);
    expect(validateHtmlManualSource(sourceFixture({ sourceFingerprint: "" })).ok).toBe(false);
    expect(validateHtmlManualSource(sourceFixture({ proposedPodName: `bad${RLO}name` })).ok).toBe(
      false,
    );
  });

  it("rejects a non-object and an unsafe fingerprint carrying a path", () => {
    expect(validateHtmlManualSource(null).ok).toBe(false);
    expect(
      validateHtmlManualSource(sourceFixture({ sourceFingerprint: "/Users/alice/secret" })).ok,
    ).toBe(false);
  });
});

describe("deriveHtmlManualSource", () => {
  it("builds an internal source when the fingerprint and kind match the approval", () => {
    const approval = approvalFixture();
    const result = deriveHtmlManualSource({
      approval,
      scope: httpScope(),
      computedFingerprint: approval.sourceFingerprint,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.sourceFingerprint).toBe("fp-abc123");
      expect(result.value.proposedPodName).toBe("docs.internal manual");
      expect(result.value.limits).toEqual(DEFAULT_DOCUMENTATION_MANUAL_SCOPE_LIMITS);
    }
  });

  it("fails closed when the recomputed fingerprint does not match the approval", () => {
    const approval = approvalFixture();
    const result = deriveHtmlManualSource({
      approval,
      scope: httpScope(),
      computedFingerprint: "fp-different",
    });
    expect(result.ok).toBe(false);
  });

  it("fails closed when the scope kind does not match the approved sourceKind", () => {
    const approval = approvalFixture({ sourceKind: "html-manual-local" });
    const result = deriveHtmlManualSource({
      approval,
      scope: httpScope(),
      computedFingerprint: approval.sourceFingerprint,
    });
    expect(result.ok).toBe(false);
  });
});

describe("summarizeHtmlManualSource", () => {
  it("collapses a local source to a body-free summary", () => {
    const summary = summarizeHtmlManualSource(
      sourceFixture({ scope: { kind: "html-manual-local", rootPath: "manuals/private/x" } }),
    );
    expect(summary.originSummary).toBe("local file");
    expect(summary.pathPrefixSummary).toBeNull();
    expect(JSON.stringify(summary)).not.toContain("manuals/private");
  });

  it("exposes only the origin and a path shape for http sources", () => {
    expect(
      summarizeHtmlManualSource(sourceFixture({ scope: httpScope({ pathPrefix: null }) })),
    ).toMatchObject({ originSummary: "https://docs.internal", pathPrefixSummary: "/" });
    expect(
      summarizeHtmlManualSource(sourceFixture({ scope: httpScope({ pathPrefix: "/docs/deep" }) }))
        .pathPrefixSummary,
    ).toBe("/…");
  });
});

describe("mapping onto existing KnowledgeSourceScope", () => {
  it("maps a local manual onto a folder scope with html globs", () => {
    const scope = htmlManualLocalFolderScope({ kind: "html-manual-local", rootPath: "manuals/x" });
    expect(scope).toEqual({
      kind: "folder",
      rootPath: "manuals/x",
      recursive: true,
      includeGlobs: HTML_MANUAL_INCLUDE_GLOBS,
    });
    expect(validateKnowledgeSourceScope(scope).ok).toBe(true);
  });

  it("maps a reachable page set onto a files scope, rejecting unsafe entries", () => {
    const scope = htmlManualReachableFilesScope("manuals/x", ["index.html", "guide/intro.html"]);
    expect(scope).not.toBeNull();
    if (scope) expect(validateKnowledgeSourceScope(scope).ok).toBe(true);
    expect(htmlManualReachableFilesScope("manuals/x", [])).toBeNull();
    expect(htmlManualReachableFilesScope("manuals/x", ["../escape.html"])).toBeNull();
    expect(htmlManualReachableFilesScope("../bad", ["index.html"])).toBeNull();
  });
});

describe("additive: existing scope union is untouched", () => {
  it("does not teach the existing scope validator the new html-manual kinds", () => {
    const localCrawlScope: HtmlManualCrawlScope = { kind: "html-manual-local", rootPath: "m/x" };
    expect(validateKnowledgeSourceScope(localCrawlScope).ok).toBe(false);
    expect(
      validateKnowledgeSourceScope({ kind: "folder", rootPath: "m/x", recursive: true }).ok,
    ).toBe(true);
  });
});
