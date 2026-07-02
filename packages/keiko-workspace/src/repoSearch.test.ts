import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  RetrievalQuery,
  RetrievalQueryKind,
} from "@oscharko-dev/keiko-contracts/connected-context";
import {
  RepoSearchInvalidQueryError,
  RepoSearchInvalidRangeError,
  RepoSearchUnsupportedFileError,
} from "./errors.js";
import { PathEscapeError, WorkspaceError } from "@oscharko-dev/keiko-security/errors/workspace";
import { memFs } from "./_memfs.js";
import { nodeWorkspaceFs, type WorkspaceFs } from "./fs.js";
import {
  DEFAULT_SEARCH_LIMITS,
  findFiles,
  readExcerpt,
  searchText,
  type SearchLimits,
  type SearchScope,
} from "./repoSearch.js";
import type { SemanticSearchProvider } from "./repoSearchSemantic.js";
import type { WorkspaceInfo } from "./types.js";

const MEM_ROOT = "/ws";

function memScope(
  files: Readonly<Record<string, string>>,
  overrides: Partial<SearchScope> = {},
): { scope: SearchScope; fs: ReturnType<typeof memFs> } {
  const workspace: WorkspaceInfo = {
    root: MEM_ROOT,
    name: "demo",
    version: "1.0.0",
    testFramework: "vitest",
    sourceDirs: ["src"],
    testDirs: ["tests"],
    languages: ["typescript", "javascript"],
    ignoreLines: [],
  };
  const scope: SearchScope = {
    workspace,
    scopeId: "scope-1",
    relativePaths: [],
    ...overrides,
  };
  return { scope, fs: memFs(MEM_ROOT, files) };
}

function nlq(text: string, overrides: Partial<RetrievalQuery> = {}): RetrievalQuery {
  return {
    kind: "natural-language",
    text,
    caseSensitive: false,
    maxResults: 100,
    emittedAtMs: 0,
    ...overrides,
  };
}

function exq(text: string, overrides: Partial<RetrievalQuery> = {}): RetrievalQuery {
  return {
    kind: "exact-symbol",
    text,
    caseSensitive: false,
    maxResults: 100,
    emittedAtMs: 0,
    ...overrides,
  };
}

function rxq(text: string, overrides: Partial<RetrievalQuery> = {}): RetrievalQuery {
  return {
    kind: "regex",
    text,
    caseSensitive: false,
    maxResults: 100,
    emittedAtMs: 0,
    ...overrides,
  };
}

function fpq(text: string, overrides: Partial<RetrievalQuery> = {}): RetrievalQuery {
  return {
    kind: "file-pattern",
    text,
    caseSensitive: false,
    maxResults: 100,
    emittedAtMs: 0,
    ...overrides,
  };
}

const FIXED_NOW: () => number = () => 1_700_000_000_000;

// ─── memFs-based unit tests ───────────────────────────────────────────────────

describe("searchText (memFs)", () => {
  it("returns a single atom for a single-line natural-language match", async () => {
    const { scope, fs } = memScope({ "src/a.ts": "hello world\n" });
    const result = await searchText(scope, nlq("hello"), DEFAULT_SEARCH_LIMITS, {
      fs,
      nowMs: FIXED_NOW,
    });
    expect(result.atoms).toHaveLength(1);
    const atom = result.atoms[0];
    expect(atom?.lineRange).toEqual({ startLine: 1, endLine: 1 });
    expect(atom?.provenance.kind).toBe("lexical-search");
    expect(atom?.provenance.tool).toBe("repo.searchText");
    expect(atom?.redactionState).toBe("redacted");
    expect(atom?.score).toBeGreaterThan(0);
    expect(atom?.score).toBeLessThanOrEqual(1);
    expect(result.coverage.incomplete).toBe(false);
    expect(result.coverage.reasons).toEqual([]);
    expect(result.coverage.filesScanned).toBe(1);
    expect(result.coverage.matchesReturned).toBe(1);
  });

  it("keeps semantic retrieval disabled unless an approved provider is injected", async () => {
    const { scope, fs } = memScope({
      "README.md": "CheckoutMismatch reports the wrong purchase sum.\n",
      "src/billing/calculateCharge.ts":
        "export function deriveCharge(amount: number, tax: number): number {\n  return amount + tax;\n}\n",
    });

    const result = await searchText(
      scope,
      nlq("Investigate CheckoutMismatch purchase sum"),
      DEFAULT_SEARCH_LIMITS,
      {
        fs,
        nowMs: FIXED_NOW,
      },
    );

    expect(result.atoms.map((atom) => atom.scopePath)).not.toContain(
      "src/billing/calculateCharge.ts",
    );
  });

  it("adds semantic-only evidence and explanations through an injected provider", async () => {
    const { scope, fs } = memScope({
      "README.md": "CheckoutMismatch reports the wrong purchase sum.\n",
      "src/billing/calculateCharge.ts":
        "export function deriveCharge(amount: number, tax: number): number {\n  return amount + tax;\n}\n",
    });
    const provider: SemanticSearchProvider = {
      name: "local fixture",
      search: ({ documents }) =>
        Promise.resolve(
          documents.some((document) => document.scopePath === "src/billing/calculateCharge.ts")
            ? [{ scopePath: "src/billing/calculateCharge.ts", score: 0.97, line: 1 }]
            : [],
        ),
    };

    const result = await searchText(
      scope,
      nlq("Investigate CheckoutMismatch purchase sum"),
      DEFAULT_SEARCH_LIMITS,
      {
        fs,
        nowMs: FIXED_NOW,
        semanticSearchProvider: provider,
      },
    );

    const semantic = result.atoms.find(
      (atom) => atom.scopePath === "src/billing/calculateCharge.ts",
    );
    expect(semantic?.provenance.kind).toBe("model-rerank");
    expect(semantic?.provenance.tool).toBe("repo.semanticSearch:local-fixture");
    expect(semantic?.score).toBe(0.97);
    expect(result.diagnostics?.rankedCandidates[0]?.scopePath).toBe(
      "src/billing/calculateCharge.ts",
    );
    expect(result.diagnostics?.rankedCandidates[0]?.signals.map((signal) => signal.name)).toContain(
      "semantic-score",
    );
    expect(JSON.stringify(result.diagnostics)).not.toContain("embedding");
  });

  it("honors an already-aborted signal before scanning files", async () => {
    const controller = new AbortController();
    controller.abort();
    const { scope, fs } = memScope({ "src/a.ts": "hello world\n" });
    const result = await searchText(scope, nlq("hello"), DEFAULT_SEARCH_LIMITS, {
      fs,
      nowMs: FIXED_NOW,
      signal: controller.signal,
    });
    expect(result.atoms).toHaveLength(0);
    expect(result.filesScanned).toBe(0);
    expect(result.truncated).toBe(true);
    expect(result.coverage.incomplete).toBe(true);
    expect(result.coverage.reasons).toContain("aborted");
  });

  it("scans files in sorted relative-path order", async () => {
    const { scope, fs } = memScope({
      "src/b.ts": "match\n",
      "src/a.ts": "match\n",
      "src/c.ts": "match\n",
    });
    const result = await searchText(scope, nlq("match"), DEFAULT_SEARCH_LIMITS, {
      fs,
      nowMs: FIXED_NOW,
    });
    expect(result.atoms.map((a) => a.scopePath)).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
  });

  it("matches multiple lines within one file", async () => {
    const { scope, fs } = memScope({ "src/a.ts": "alpha\nbeta\nalpha again\n" });
    const result = await searchText(scope, nlq("alpha"), DEFAULT_SEARCH_LIMITS, {
      fs,
      nowMs: FIXED_NOW,
    });
    expect(result.atoms.map((a) => a.lineRange?.startLine)).toEqual([1, 3]);
  });

  it("expands a matched line to the enclosing function window when available", async () => {
    const { scope, fs } = memScope({
      "src/payment.ts":
        "import { audit } from './audit';\n" +
        "\n" +
        "export function reconcilePayment(): string {\n" +
        "  const status = 'pending';\n" +
        "  if (status === 'pending') {\n" +
        "    return audit(status);\n" +
        "  }\n" +
        "  return 'done';\n" +
        "}\n" +
        "\n" +
        "export function unrelated(): string {\n" +
        "  return 'ok';\n" +
        "}\n",
    });
    const result = await searchText(scope, nlq("pending"), DEFAULT_SEARCH_LIMITS, {
      fs,
      nowMs: FIXED_NOW,
    });
    expect(result.atoms).toHaveLength(1);
    expect(result.atoms[0]?.lineRange).toEqual({ startLine: 3, endLine: 9 });
    expect(result.coverage.matchesReturned).toBe(1);
  });

  it("scores natural-language as tokensHit/tokensTotal", async () => {
    const { scope, fs } = memScope({ "src/a.ts": "hello there friend\n" });
    const both = await searchText(scope, nlq("hello there"), DEFAULT_SEARCH_LIMITS, {
      fs,
      nowMs: FIXED_NOW,
    });
    expect(both.atoms[0]?.score).toBeCloseTo(1, 6);
    const partial = await searchText(scope, nlq("hello missing"), DEFAULT_SEARCH_LIMITS, {
      fs,
      nowMs: FIXED_NOW,
    });
    expect(partial.atoms[0]?.score).toBeCloseTo(0.5, 6);
  });

  it("honors caseSensitive: false by default", async () => {
    const { scope, fs } = memScope({ "src/a.ts": "Foo\n" });
    const r = await searchText(scope, nlq("foo"), DEFAULT_SEARCH_LIMITS, { fs, nowMs: FIXED_NOW });
    expect(r.atoms).toHaveLength(1);
  });

  it("honors caseSensitive: true", async () => {
    const { scope, fs } = memScope({ "src/a.ts": "Foo\n" });
    const r = await searchText(scope, nlq("foo", { caseSensitive: true }), DEFAULT_SEARCH_LIMITS, {
      fs,
      nowMs: FIXED_NOW,
    });
    expect(r.atoms).toHaveLength(0);
  });

  // Epic #177 retrieval correctness — stop-word filtering, per-file diversity, and scan breadth.
  it("ignores stop words so a stop-word-only line does not match a content query", async () => {
    const { scope, fs } = memScope({ "src/a.ts": "the and to of in on are was\n" });
    // Every query word except the two content tokens is a stop word; the file contains neither
    // content token, so a correct matcher returns nothing. A matcher that scored raw whitespace
    // tokens would match on "the"/"are"/"on" and emit a spurious atom.
    const r = await searchText(
      scope,
      nlq("what are the widgetRegistry on the disk"),
      DEFAULT_SEARCH_LIMITS,
      { fs, nowMs: FIXED_NOW },
    );
    expect(r.atoms).toHaveLength(0);
  });

  it("ignores German stop words so localized prompts do not overmatch prose", async () => {
    const { scope, fs } = memScope({ "src/a.ts": "die mir welche kannst sagen und\n" });
    const r = await searchText(
      scope,
      nlq("Kannst du mir sagen welche Testumgebung genutzt wird?"),
      DEFAULT_SEARCH_LIMITS,
      { fs, nowMs: FIXED_NOW },
    );
    expect(r.atoms).toHaveLength(0);
  });

  it("caps emitted matches per file so one file cannot dominate the budget", async () => {
    const { scope, fs } = memScope({ "src/a.ts": "needle\n".repeat(20) });
    const r = await searchText(scope, nlq("needle"), DEFAULT_SEARCH_LIMITS, {
      fs,
      nowMs: FIXED_NOW,
    });
    const fromA = r.atoms.filter((a) => a.scopePath === "src/a.ts");
    expect(fromA.length).toBeGreaterThan(0);
    expect(fromA.length).toBeLessThanOrEqual(3);
  });

  it("examines a later-sorted file instead of saturating on the first one", async () => {
    const { scope, fs } = memScope({
      "src/a_early.ts": "shared\nshared\nshared\nshared\nshared\nshared\n",
      "src/z_late.ts": "shared target\n",
    });
    // Without the per-file cap the six 'shared' lines in the alphabetically-first file would
    // consume the whole match budget and z_late.ts would never be scanned.
    const limits: SearchLimits = { ...DEFAULT_SEARCH_LIMITS, maxMatchesReturned: 4 };
    const r = await searchText(scope, nlq("shared target"), limits, { fs, nowMs: FIXED_NOW });
    const files = new Set(r.atoms.map((a) => a.scopePath));
    expect(files.has("src/z_late.ts")).toBe(true);
  });

  it("reads an excerpt window from a file larger than the request byte budget", async () => {
    const big = `${"x\n".repeat(8000)}TARGET\n`;
    const { scope, fs } = memScope({ "src/big.ts": big });
    const r = await readExcerpt(
      scope,
      { scopePath: "src/big.ts", startLine: 8001, endLine: 8001, maxBytes: 8192 },
      { fs },
    );
    expect(r.content).toContain("TARGET");
  });

  it("rejects an exact-symbol query containing whitespace", async () => {
    const { scope, fs } = memScope({ "src/a.ts": "foo bar\n" });
    await expect(
      searchText(scope, exq("foo bar"), DEFAULT_SEARCH_LIMITS, { fs, nowMs: FIXED_NOW }),
    ).rejects.toBeInstanceOf(RepoSearchInvalidQueryError);
  });

  it("matches exact-symbol as substring with score 1", async () => {
    const { scope, fs } = memScope({ "src/a.ts": "callFoo();\nother\n" });
    const r = await searchText(scope, exq("Foo"), DEFAULT_SEARCH_LIMITS, {
      fs,
      nowMs: FIXED_NOW,
    });
    expect(r.atoms).toHaveLength(1);
    expect(r.atoms[0]?.score).toBe(1);
  });

  it("expands test-class names so source definitions are retrievable", async () => {
    const { scope, fs } = memScope({
      "src/payments/PaymentService.ts":
        "export class PaymentService {\n  authorize(): boolean { return true; }\n}\n",
      "tests/payments/PaymentService.test.ts":
        'describe("PaymentServiceTest", () => it("covers authorize", () => {}));\n',
    });
    const r = await searchText(
      scope,
      nlq("Where is the source implementation for PaymentServiceTest?"),
      DEFAULT_SEARCH_LIMITS,
      {
        fs,
        nowMs: FIXED_NOW,
        searchHints: { retrievalIntent: "targeted-code-search" },
      },
    );
    expect(r.atoms[0]?.scopePath).toBe("src/payments/PaymentService.ts");
    expect(r.atoms.some((atom) => atom.scopePath === "src/payments/PaymentService.ts")).toBe(true);
  });

  it("uses stack-frame paths as path and symbol terms", async () => {
    const { scope, fs } = memScope({
      "src/payments/AuthService.ts":
        "export class AuthService {\n  validateToken(): void { throw new Error('boom'); }\n}\n",
      "docs/errors.md": "Auth failures can mention validateToken in prose.\n",
    });
    const r = await searchText(
      scope,
      nlq("TypeError: boom at src/payments/AuthService.ts:42:13 in validateToken"),
      DEFAULT_SEARCH_LIMITS,
      {
        fs,
        nowMs: FIXED_NOW,
        searchHints: { retrievalIntent: "diagnostic-search" },
      },
    );
    expect(r.atoms[0]?.scopePath).toBe("src/payments/AuthService.ts");
  });

  it("recognizes Express-style route declarations over generic prose mentions", async () => {
    const { scope, fs } = memScope({
      "src/routes.ts":
        'router.post("/api/payments/:id/refund", async (req, res) => refundPayment(req, res));\n',
      "docs/routes.md": "The POST /api/payments/:id/refund endpoint refunds a payment.\n",
      "tests/routes.test.ts": "it('POST refund route works', () => {});\n",
    });
    const r = await searchText(
      scope,
      nlq("Which file implements the POST /api/payments/:id/refund route?"),
      DEFAULT_SEARCH_LIMITS,
      {
        fs,
        nowMs: FIXED_NOW,
        searchHints: { retrievalIntent: "targeted-code-search" },
      },
    );
    expect(r.atoms[0]?.scopePath).toBe("src/routes.ts");
    expect(r.atoms[0]?.score).toBeGreaterThan(
      r.atoms.find((a) => a.scopePath === "docs/routes.md")?.score ?? 0,
    );
  });

  it("keeps short identifier terms in the content gate for natural-language queries", async () => {
    const { scope, fs } = memScope({
      "src/http/ApiIdUrlMapper.ts":
        'export const API_ID_URL = "/api/id";\nexport function mapApiIdUrl(): string { return API_ID_URL; }\n',
      "docs/api.md": "The API id url constant is discussed in this document.\n",
    });
    const r = await searchText(
      scope,
      nlq("Which API id url constant is defined in source?"),
      DEFAULT_SEARCH_LIMITS,
      {
        fs,
        nowMs: FIXED_NOW,
        searchHints: { retrievalIntent: "targeted-code-search" },
      },
    );
    expect(r.atoms[0]?.scopePath).toBe("src/http/ApiIdUrlMapper.ts");
    expect(r.atoms.map((atom) => atom.scopePath)).toContain("src/http/ApiIdUrlMapper.ts");
  });

  // Issue #188 Case 2: exact-symbol question across a two-file scope where the named
  // symbol appears in both the defining file and a call site. exact-symbol is a substring
  // matcher (per repoSearchMatchers), so this regression locks two properties:
  //   1. the defining file still appears in the result set, and
  //   2. the caller file is not silently dropped from a multi-file match.
  // Mutation guard: if cross-file gathering collapses to a single atom or ranking drops one
  // file, the length / path assertions fail.
  it("returns the symbol-defining file when an exact-symbol query targets a named function", async () => {
    const { scope, fs } = memScope({
      "src/foo.ts": "export function foo(): void { return; }\n",
      "src/bar.ts": "import { foo } from './foo.js';\nfoo();\n",
    });
    const r = await searchText(scope, exq("foo"), DEFAULT_SEARCH_LIMITS, {
      fs,
      nowMs: FIXED_NOW,
    });
    // Both files contain the substring "foo", but the defining declaration is in src/foo.ts.
    // exact-symbol is a substring search so both should match.
    expect(r.atoms.length).toBeGreaterThanOrEqual(2);
    expect(r.atoms.map((atom) => atom.scopePath)).toEqual(
      expect.arrayContaining(["src/foo.ts", "src/bar.ts"]),
    );
    const definingAtom = r.atoms.find((a) => a.scopePath === "src/foo.ts");
    expect(definingAtom).toBeDefined();
    expect(definingAtom?.score).toBe(1);
    // Every returned atom must carry a valid relative scopePath.
    for (const atom of r.atoms) {
      expect(atom.scopePath.startsWith("/")).toBe(false);
      expect(atom.scopePath.includes("..")).toBe(false);
    }
  });

  it("rejects an invalid regex with RepoSearchInvalidQueryError", async () => {
    const { scope, fs } = memScope({ "src/a.ts": "anything\n" });
    await expect(
      searchText(scope, rxq("("), DEFAULT_SEARCH_LIMITS, { fs, nowMs: FIXED_NOW }),
    ).rejects.toBeInstanceOf(RepoSearchInvalidQueryError);
  });

  it("rejects a regex with group-then-quantifier as a ReDoS guard", async () => {
    const { scope, fs } = memScope({ "src/a.ts": "anything\n" });
    await expect(
      searchText(scope, rxq("(a+)+"), DEFAULT_SEARCH_LIMITS, { fs, nowMs: FIXED_NOW }),
    ).rejects.toBeInstanceOf(RepoSearchInvalidQueryError);
  });

  it("rejects a regex with character-class-then-quantifier as a ReDoS guard", async () => {
    const { scope, fs } = memScope({ "src/a.ts": "anything\n" });
    await expect(
      searchText(scope, rxq("[abc]+{2,}"), DEFAULT_SEARCH_LIMITS, { fs, nowMs: FIXED_NOW }),
    ).rejects.toBeInstanceOf(RepoSearchInvalidQueryError);
  });

  it("rejects adjacent quantified atoms as a ReDoS guard", async () => {
    const { scope, fs } = memScope({ "src/a.ts": "aaaaaaaaaaaaaaaaaaaaaaaaaaaa\n" });
    await expect(
      searchText(scope, rxq("^(a*a*a*a*a*b)$"), DEFAULT_SEARCH_LIMITS, { fs, nowMs: FIXED_NOW }),
    ).rejects.toBeInstanceOf(RepoSearchInvalidQueryError);
  });

  it("rejects a regex longer than the safety cap", async () => {
    const { scope, fs } = memScope({ "src/a.ts": "anything\n" });
    const tooLong = "x".repeat(201);
    await expect(
      searchText(scope, rxq(tooLong), DEFAULT_SEARCH_LIMITS, { fs, nowMs: FIXED_NOW }),
    ).rejects.toBeInstanceOf(RepoSearchInvalidQueryError);
  });

  it("supports a valid regex query and scores monotonically with hit count", async () => {
    const { scope, fs } = memScope({
      "src/a.ts": "abc\nabcabc\nabcabcabc\n",
    });
    const r = await searchText(scope, rxq("abc"), DEFAULT_SEARCH_LIMITS, {
      fs,
      nowMs: FIXED_NOW,
    });
    expect(r.atoms).toHaveLength(3);
    const s1 = r.atoms[0]?.score ?? 0;
    const s3 = r.atoms[2]?.score ?? 0;
    expect(s3).toBeGreaterThan(s1);
  });

  it("rejects file-pattern queries", async () => {
    const { scope, fs } = memScope({ "src/a.ts": "x\n" });
    await expect(
      searchText(scope, fpq("**/*.ts"), DEFAULT_SEARCH_LIMITS, { fs, nowMs: FIXED_NOW }),
    ).rejects.toBeInstanceOf(RepoSearchInvalidQueryError);
  });

  it("rejects an empty query text", async () => {
    const { scope, fs } = memScope({ "src/a.ts": "x\n" });
    await expect(
      searchText(scope, nlq(""), DEFAULT_SEARCH_LIMITS, { fs, nowMs: FIXED_NOW }),
    ).rejects.toBeInstanceOf(RepoSearchInvalidQueryError);
  });

  it("rejects an empty workspace root", async () => {
    const { scope, fs } = memScope({ "src/a.ts": "x\n" }, {});
    const bad: SearchScope = { ...scope, workspace: { ...scope.workspace, root: "" } };
    await expect(
      searchText(bad, nlq("x"), DEFAULT_SEARCH_LIMITS, { fs, nowMs: FIXED_NOW }),
    ).rejects.toBeInstanceOf(RepoSearchInvalidQueryError);
  });

  it("emits stableId that depends on lineRange", async () => {
    const { scope, fs } = memScope({ "src/a.ts": "match\nmatch\n" });
    const r = await searchText(scope, nlq("match"), DEFAULT_SEARCH_LIMITS, {
      fs,
      nowMs: FIXED_NOW,
    });
    expect(r.atoms[0]?.stableId).not.toBe(r.atoms[1]?.stableId);
  });

  it("emits stableId that depends on queryFingerprint", async () => {
    const { scope, fs } = memScope({ "src/a.ts": "match\n" });
    const r1 = await searchText(scope, nlq("match"), DEFAULT_SEARCH_LIMITS, {
      fs,
      nowMs: FIXED_NOW,
    });
    const r2 = await searchText(scope, nlq("ma"), DEFAULT_SEARCH_LIMITS, {
      fs,
      nowMs: FIXED_NOW,
    });
    expect(r1.atoms[0]?.stableId).not.toBe(r2.atoms[0]?.stableId);
  });

  it("is deterministic across runs for fixed inputs and clock", async () => {
    const { scope, fs } = memScope({
      "src/a.ts": "alpha\nbeta\n",
      "src/b.ts": "alpha beta\n",
    });
    const a = await searchText(scope, nlq("alpha"), DEFAULT_SEARCH_LIMITS, {
      fs,
      nowMs: FIXED_NOW,
    });
    const b = await searchText(scope, nlq("alpha"), DEFAULT_SEARCH_LIMITS, {
      fs,
      nowMs: FIXED_NOW,
    });
    expect(a.atoms.map((x) => x.stableId)).toEqual(b.atoms.map((x) => x.stableId));
  });

  it("omits files that match the deny list (node_modules)", async () => {
    const { scope, fs } = memScope({
      "src/a.ts": "match\n",
      "node_modules/foo.ts": "match\n",
    });
    const r = await searchText(scope, nlq("match"), DEFAULT_SEARCH_LIMITS, {
      fs,
      nowMs: FIXED_NOW,
    });
    expect(r.atoms.map((a) => a.scopePath)).toEqual(["src/a.ts"]);
  });

  it("omits .env files (deny list)", async () => {
    const { scope, fs } = memScope({
      "src/a.ts": "secret-value\n",
      ".env": "secret-value\n",
    });
    const r = await searchText(scope, nlq("secret-value"), DEFAULT_SEARCH_LIMITS, {
      fs,
      nowMs: FIXED_NOW,
    });
    expect(r.atoms.every((a) => a.scopePath !== ".env")).toBe(true);
  });

  it("omits internal runtime state while grounding package.json metadata", async () => {
    const { scope, fs } = memScope({
      "package.json": '{\n  "packageManager": "npm@10.9.8"\n}\n',
      ".keiko/evidence/qi/run.candidates.json":
        '{"packageManager":"stale-internal-value","connected":"repository","context":"evidence"}\n',
      ".codex/history.jsonl":
        '{"packageManager":"stale-codex-value","connected":"repository","context":"history"}\n',
      ".claude/transcript.jsonl":
        '{"packageManager":"stale-claude-value","connected":"repository","context":"history"}\n',
    });
    const r = await searchText(
      scope,
      nlq(
        "Using only the connected repository context, what is the exact packageManager value in package.json?",
      ),
      DEFAULT_SEARCH_LIMITS,
      { fs, nowMs: FIXED_NOW },
    );
    expect(r.atoms.map((a) => a.scopePath)).toEqual(["package.json"]);
    expect(r.atoms[0]?.lineRange).toEqual({ startLine: 2, endLine: 2 });
    expect(r.atoms.every((a) => !a.scopePath.startsWith(".keiko/"))).toBe(true);
    expect(r.atoms.every((a) => !a.scopePath.startsWith(".codex/"))).toBe(true);
    expect(r.atoms.every((a) => !a.scopePath.startsWith(".claude/"))).toBe(true);
  });

  it("omits safe gitignored files from workspace-root text search", async () => {
    const { scope, fs } = memScope(
      { "src/a.ts": "match\n", "generated/b.ts": "match\n", ".hidden.ts": "match\n" },
      {
        workspace: {
          root: MEM_ROOT,
          name: "demo",
          version: "1.0.0",
          testFramework: "vitest",
          sourceDirs: ["src"],
          testDirs: ["tests"],
          languages: ["typescript"],
          ignoreLines: ["generated/", ".hidden.ts"],
        },
      },
    );
    const r = await searchText(scope, nlq("match"), DEFAULT_SEARCH_LIMITS, {
      fs,
      nowMs: FIXED_NOW,
    });
    expect(r.atoms.map((a) => a.scopePath)).toEqual(["src/a.ts"]);
    expect(r.diagnostics?.policyMode).toBe("workspace-root-default");
    expect(r.diagnostics?.ignoredByDiscovery).toBe(2);
  });

  it("respects maxMatchesReturned with truncated=true", async () => {
    const { scope, fs } = memScope({ "src/a.ts": "x\nx\nx\nx\nx\n" });
    const limits: SearchLimits = { ...DEFAULT_SEARCH_LIMITS, maxMatchesReturned: 2 };
    const r = await searchText(scope, nlq("x"), limits, { fs, nowMs: FIXED_NOW });
    expect(r.atoms).toHaveLength(2);
    expect(r.truncated).toBe(true);
    expect(r.coverage.incomplete).toBe(true);
    expect(r.coverage.reasons).toEqual(["match-cap"]);
    expect(r.coverage.matchesReturned).toBe(2);
    expect(r.coverage.limits.maxMatchesReturned).toBe(2);
  });

  it("respects maxFilesScanned with truncated=true", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 5; i += 1) {
      files[`src/f${i.toString()}.ts`] = "match\n";
    }
    const { scope, fs } = memScope(files);
    const limits: SearchLimits = { ...DEFAULT_SEARCH_LIMITS, maxFilesScanned: 1 };
    const r = await searchText(scope, nlq("match"), limits, { fs, nowMs: FIXED_NOW });
    expect(r.filesScanned).toBeLessThanOrEqual(1);
    expect(r.atoms.map((a) => a.scopePath)).toEqual(["src/f0.ts"]);
    expect(r.truncated).toBe(true);
    expect(r.coverage.incomplete).toBe(true);
    expect(r.coverage.reasons).toEqual(["file-cap"]);
    expect(r.coverage.filesScanned).toBe(1);
    expect(r.coverage.filesSkipped).toBeGreaterThan(0);
    expect(r.coverage.limits.maxFilesScanned).toBe(1);
  });

  it("reports truncated when whole-workspace discovery hits maxFilesScanned without matches", async () => {
    const { scope, fs } = memScope({
      "src/f0.ts": "alpha\n",
      "src/f1.ts": "alpha\n",
      "src/f2.ts": "alpha\n",
    });
    const limits: SearchLimits = { ...DEFAULT_SEARCH_LIMITS, maxFilesScanned: 1 };
    const r = await searchText(scope, nlq("absent"), limits, { fs, nowMs: FIXED_NOW });
    expect(r.atoms).toHaveLength(0);
    expect(r.filesScanned).toBe(1);
    expect(r.truncated).toBe(true);
    expect(r.coverage.reasons).toEqual(["file-cap"]);
    expect(r.coverage.matchesReturned).toBe(0);
    expect(r.coverage.filesSkipped).toBeGreaterThan(0);
  });

  it("includes safe gitignored files from explicit-scope text search", async () => {
    const { scope, fs } = memScope(
      {
        "packages/a/generated/0.ts": "match\n",
        "packages/a/generated/1.ts": "match\n",
        "packages/a/generated/2.ts": "match\n",
        "packages/a/src/ok.ts": "match\n",
      },
      {
        workspace: {
          root: MEM_ROOT,
          name: "demo",
          version: "1.0.0",
          testFramework: "vitest",
          sourceDirs: ["packages/a/src"],
          testDirs: ["packages/a/tests"],
          languages: ["typescript"],
          ignoreLines: ["/packages/a/generated/"],
        },
        relativePaths: ["packages/a"],
      },
    );
    const limits: SearchLimits = { ...DEFAULT_SEARCH_LIMITS, maxFilesScanned: 10 };
    const r = await searchText(scope, nlq("match"), limits, { fs, nowMs: FIXED_NOW });
    expect(r.atoms.map((a) => a.scopePath)).toEqual([
      "packages/a/src/ok.ts",
      "packages/a/generated/0.ts",
      "packages/a/generated/1.ts",
      "packages/a/generated/2.ts",
    ]);
    expect(r.diagnostics?.policyMode).toBe("explicit-scope");
    expect(r.truncated).toBe(false);
    expect(r.coverage.incomplete).toBe(false);
    expect(r.coverage.reasons).toEqual([]);
  });

  it("respects elapsedMsMax via injected nowMs (truncated=true)", async () => {
    const { scope, fs } = memScope({ "src/a.ts": "match\n", "src/b.ts": "match\n" });
    let tick = 0;
    const nowMs = (): number => {
      const v = tick;
      tick += 100;
      return v;
    };
    const limits: SearchLimits = { ...DEFAULT_SEARCH_LIMITS, elapsedMsMax: 0 };
    const r = await searchText(scope, nlq("match"), limits, { fs, nowMs });
    expect(r.truncated).toBe(true);
    expect(r.coverage.incomplete).toBe(true);
    expect(r.coverage.reasons).toEqual(["timeout"]);
    expect(r.coverage.elapsedMs).toBeGreaterThan(r.coverage.limits.elapsedMsMax);
  });

  it("surfaces max-depth pruning as incomplete coverage without implying a file-cap hit", async () => {
    const deepPath = `${Array.from({ length: 14 }, (_, i) => `d${String(i)}`).join("/")}/deep.ts`;
    const { scope, fs } = memScope({
      "src/top.ts": "match\n",
      [deepPath]: "match\n",
    });
    const r = await searchText(scope, nlq("match"), DEFAULT_SEARCH_LIMITS, {
      fs,
      nowMs: FIXED_NOW,
    });
    expect(r.atoms.map((a) => a.scopePath)).toEqual(["src/top.ts"]);
    expect(r.truncated).toBe(true);
    expect(r.coverage.incomplete).toBe(true);
    expect(r.coverage.reasons).toEqual(["depth-pruned"]);
    expect(r.coverage.depthPrunedByDiscovery).toBeGreaterThan(0);
    expect(r.coverage.filesSkipped).toBeGreaterThan(0);
  });

  it("omits oversize files as size-exceeded candidates rather than failing the run", async () => {
    const head = "alpha\n".repeat(20);
    const tail = "needle\n";
    const { scope, fs } = memScope({ "src/a.ts": head + tail });
    const limits: SearchLimits = {
      ...DEFAULT_SEARCH_LIMITS,
      maxBytesPerFileScanned: 50,
    };
    const r = await searchText(scope, nlq("needle"), limits, { fs, nowMs: FIXED_NOW });
    expect(r.atoms).toHaveLength(0);
    expect(
      r.candidates.some((c) => c.scopePath === "src/a.ts" && c.omitted === "size-exceeded"),
    ).toBe(true);
  });

  it("returns an empty result for an empty workspace", async () => {
    const { scope, fs } = memScope({});
    const r = await searchText(scope, nlq("anything"), DEFAULT_SEARCH_LIMITS, {
      fs,
      nowMs: FIXED_NOW,
    });
    expect(r.atoms).toHaveLength(0);
    expect(r.candidates).toHaveLength(0);
    expect(r.truncated).toBe(false);
    expect(r.coverage.incomplete).toBe(false);
    expect(r.coverage.reasons).toEqual([]);
  });

  it("can be driven by an injected fs (port-driven proof)", async () => {
    const { scope, fs } = memScope({ "src/a.ts": "needle\n" });
    const r = await searchText(scope, nlq("needle"), DEFAULT_SEARCH_LIMITS, {
      fs,
      nowMs: FIXED_NOW,
    });
    expect(r.atoms).toHaveLength(1);
  });

  it("scope.relativePaths restricts to a subdirectory", async () => {
    const { scope, fs } = memScope(
      { "src/a.ts": "match\n", "docs/b.md": "match\n" },
      { relativePaths: ["src"] },
    );
    const r = await searchText(scope, nlq("match"), DEFAULT_SEARCH_LIMITS, {
      fs,
      nowMs: FIXED_NOW,
    });
    expect(r.atoms.map((a) => a.scopePath)).toEqual(["src/a.ts"]);
  });

  it("scope.relativePaths can pin a single file", async () => {
    const { scope, fs } = memScope(
      { "src/a.ts": "match\n", "src/b.ts": "match\n" },
      { relativePaths: ["src/a.ts"] },
    );
    const r = await searchText(scope, nlq("match"), DEFAULT_SEARCH_LIMITS, {
      fs,
      nowMs: FIXED_NOW,
    });
    expect(r.atoms.map((a) => a.scopePath)).toEqual(["src/a.ts"]);
  });

  it("rejects scope.relativePaths containing a parent-traversal entry", async () => {
    const { scope, fs } = memScope({ "src/a.ts": "match\n" }, { relativePaths: ["../escape"] });
    await expect(
      searchText(scope, nlq("match"), DEFAULT_SEARCH_LIMITS, { fs, nowMs: FIXED_NOW }),
    ).rejects.toBeInstanceOf(RepoSearchInvalidQueryError);
  });

  it("rejects scope.relativePaths containing a Windows drive prefix", async () => {
    const { scope, fs } = memScope({ "src/a.ts": "match\n" }, { relativePaths: ["C:/etc/passwd"] });
    await expect(
      searchText(scope, nlq("match"), DEFAULT_SEARCH_LIMITS, { fs, nowMs: FIXED_NOW }),
    ).rejects.toBeInstanceOf(RepoSearchInvalidQueryError);
  });

  it("rejects an unknown query kind", async () => {
    const { scope, fs } = memScope({ "src/a.ts": "x\n" });
    const bad = { ...nlq("x"), kind: "weird" as RetrievalQueryKind };
    await expect(
      searchText(scope, bad, DEFAULT_SEARCH_LIMITS, { fs, nowMs: FIXED_NOW }),
    ).rejects.toBeInstanceOf(RepoSearchInvalidQueryError);
  });

  it("emits provenance.queryFingerprint as a 16-char hex string", async () => {
    const { scope, fs } = memScope({ "src/a.ts": "match\n" });
    const r = await searchText(scope, nlq("match"), DEFAULT_SEARCH_LIMITS, {
      fs,
      nowMs: FIXED_NOW,
    });
    expect(r.atoms[0]?.provenance.queryFingerprint).toMatch(/^[0-9a-f]{16}$/);
  });

  it("prioritizes canonical manifests for project metadata questions", async () => {
    const { scope, fs } = memScope({
      "src/noise.ts": "// TypeScript helper mention\n",
      "package.json": '{\n  "devDependencies": { "typescript": "^6.0.3" }\n}\n',
      "packages/keiko-ui/package.json": '{\n  "devDependencies": { "typescript": "5.7.3" }\n}\n',
    });
    const r = await searchText(
      scope,
      nlq("Welche Type-Script Version verwendet die App?"),
      DEFAULT_SEARCH_LIMITS,
      {
        fs,
        nowMs: FIXED_NOW,
        searchHints: { retrievalIntent: "project-metadata" },
      },
    );
    expect(r.atoms[0]?.scopePath).toBe("package.json");
    expect(r.atoms.map((a) => a.scopePath)).toEqual(
      expect.arrayContaining(["package.json", "packages/keiko-ui/package.json"]),
    );
    expect(r.diagnostics?.intent).toBe("project-metadata");
  });

  it("prioritizes symbol implementation files over docs for targeted questions", async () => {
    const { scope, fs } = memScope({
      "docs/window-frame.md": "WindowFrame is documented here.\n",
      "packages/keiko-ui/src/app/components/desktop/windows/WindowFrame.tsx":
        "export function WindowFrame(): JSX.Element { return <section />; }\n",
      "packages/keiko-ui/src/app/components/desktop/AppShell.tsx":
        "import { WindowFrame } from './windows/WindowFrame.js';\n",
    });
    const r = await searchText(
      scope,
      nlq("Wo ist WindowFrame implementiert?"),
      DEFAULT_SEARCH_LIMITS,
      {
        fs,
        nowMs: FIXED_NOW,
        searchHints: { retrievalIntent: "targeted-code-search" },
      },
    );
    expect(r.atoms[0]?.scopePath).toBe(
      "packages/keiko-ui/src/app/components/desktop/windows/WindowFrame.tsx",
    );
  });

  it("omits low-value workspace-root files before they consume match budget", async () => {
    const { scope, fs } = memScope({
      "dist/needle.ts": "needle\n",
      "generated/needle.ts": "needle\n",
      "src/needle.ts": "needle\n",
    });
    const r = await searchText(scope, nlq("needle"), DEFAULT_SEARCH_LIMITS, {
      fs,
      nowMs: FIXED_NOW,
      searchHints: { retrievalIntent: "targeted-code-search" },
    });
    expect(r.atoms.map((a) => a.scopePath)).toEqual(["src/needle.ts"]);
    expect(r.candidates.filter((c) => c.omitted === "generated")).toHaveLength(0);
    expect(r.diagnostics?.ignoredByDiscovery).toBeGreaterThan(0);
    expect(r.atoms.some((a) => a.scopePath === "dist/needle.ts")).toBe(false);
  });

  it("finds relevant source when a 10k generated tree would otherwise exhaust discovery", async () => {
    const files: Record<string, string> = { "src/target.ts": "needle\n" };
    for (let i = 0; i < 10_000; i += 1) {
      files[`generated/f${i.toString().padStart(5, "0")}.ts`] = "needle\n";
    }
    const { scope, fs } = memScope(files);
    const limits: SearchLimits = { ...DEFAULT_SEARCH_LIMITS, maxFilesScanned: 2 };
    const r = await searchText(scope, nlq("needle"), limits, {
      fs,
      nowMs: FIXED_NOW,
      searchHints: { retrievalIntent: "targeted-code-search" },
    });
    expect(r.atoms.map((a) => a.scopePath)).toEqual(["src/target.ts"]);
    expect(r.diagnostics?.ignoredByDiscovery).toBeGreaterThan(0);
    expect(r.truncated).toBe(false);
  });

  it("includes allowlisted generated source without relaxing denied secret paths", async () => {
    const { scope, fs } = memScope({
      "generated/contracts/OrderClient.java": "class OrderClient { String auditNeedle; }\n",
      "src/ordinary.ts": "export const ordinary = 'auditNeedle';\n",
      ".env": "auditNeedle=secret\n",
    });
    const r = await searchText(scope, nlq("auditNeedle"), DEFAULT_SEARCH_LIMITS, {
      fs,
      nowMs: FIXED_NOW,
      searchHints: {
        retrievalIntent: "targeted-code-search",
        lowValuePathAllowlist: ["generated/contracts/OrderClient.java", ".env"],
      },
    });
    expect(r.atoms.map((a) => a.scopePath)).toContain("generated/contracts/OrderClient.java");
    expect(r.atoms.map((a) => a.scopePath)).not.toContain(".env");
    expect(r.coverage.deniedByDiscovery).toBeGreaterThan(0);
  });

  it("boosts injected git-recent files in candidate ranking diagnostics", async () => {
    const { scope, fs } = memScope({
      "src/old.ts": "export const sharedNeedle = 1;\n",
      "src/recent.ts": "export const sharedNeedle = 2;\n",
    });
    const r = await searchText(scope, nlq("sharedNeedle"), DEFAULT_SEARCH_LIMITS, {
      fs,
      nowMs: FIXED_NOW,
      searchHints: {
        retrievalIntent: "targeted-code-search",
        recentPaths: ["src/recent.ts"],
      },
    });
    expect(r.atoms[0]?.scopePath).toBe("src/recent.ts");
    expect(r.diagnostics?.rankedCandidates[0]?.scopePath).toBe("src/recent.ts");
    expect(r.diagnostics?.rankedCandidates[0]?.signals).toContainEqual({
      name: "git-recency",
      value: 28,
    });
  });
});

describe("findFiles (memFs)", () => {
  it("emits one file-listing atom per matching path", async () => {
    const { scope, fs } = memScope({
      "src/a.ts": "x",
      "src/b.ts": "x",
      "src/c.js": "x",
    });
    const r = await findFiles(scope, fpq("**/*.ts"), DEFAULT_SEARCH_LIMITS, {
      fs,
      nowMs: FIXED_NOW,
    });
    expect(r.atoms.map((a) => a.scopePath)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(r.atoms[0]?.provenance.kind).toBe("file-listing");
    expect(r.atoms[0]?.lineRange).toBeUndefined();
    expect(r.atoms[0]?.score).toBe(1);
  });

  it("honors an already-aborted signal before listing files", async () => {
    const controller = new AbortController();
    controller.abort();
    const { scope, fs } = memScope({ "src/a.ts": "x" });
    const r = await findFiles(scope, fpq("**/*.ts"), DEFAULT_SEARCH_LIMITS, {
      fs,
      nowMs: FIXED_NOW,
      signal: controller.signal,
    });
    expect(r.atoms).toHaveLength(0);
    expect(r.filesScanned).toBe(0);
    expect(r.truncated).toBe(true);
    expect(r.coverage.incomplete).toBe(true);
    expect(r.coverage.reasons).toContain("aborted");
  });

  it("rejects non-file-pattern queries", async () => {
    const { scope, fs } = memScope({ "src/a.ts": "x" });
    await expect(
      findFiles(scope, nlq("anything"), DEFAULT_SEARCH_LIMITS, { fs, nowMs: FIXED_NOW }),
    ).rejects.toBeInstanceOf(RepoSearchInvalidQueryError);
  });

  it("treats `**` as any-segments and `*` as within-segment", async () => {
    const { scope, fs } = memScope({
      "a.ts": "x",
      "src/a.ts": "x",
      "src/deep/a.ts": "x",
    });
    const r = await findFiles(scope, fpq("**/a.ts"), DEFAULT_SEARCH_LIMITS, {
      fs,
      nowMs: FIXED_NOW,
    });
    expect(r.atoms.map((a) => a.scopePath).sort()).toEqual(["a.ts", "src/a.ts", "src/deep/a.ts"]);
  });

  it("matches file patterns case-insensitively when requested", async () => {
    const { scope, fs } = memScope({
      "packages/keiko-ui/src/app/components/desktop/windows/WindowFrame.tsx": "x",
    });
    const r = await findFiles(scope, fpq("**/windowframe.tsx"), DEFAULT_SEARCH_LIMITS, {
      fs,
      nowMs: FIXED_NOW,
    });
    expect(r.atoms.map((a) => a.scopePath)).toEqual([
      "packages/keiko-ui/src/app/components/desktop/windows/WindowFrame.tsx",
    ]);
  });

  it("returns nothing when no files match", async () => {
    const { scope, fs } = memScope({ "src/a.ts": "x" });
    const r = await findFiles(scope, fpq("**/*.md"), DEFAULT_SEARCH_LIMITS, {
      fs,
      nowMs: FIXED_NOW,
    });
    expect(r.atoms).toHaveLength(0);
  });

  it("respects maxMatchesReturned with truncated=true", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 5; i += 1) {
      files[`f${i.toString()}.ts`] = "x";
    }
    const { scope, fs } = memScope(files);
    const limits: SearchLimits = { ...DEFAULT_SEARCH_LIMITS, maxMatchesReturned: 2 };
    const r = await findFiles(scope, fpq("**/*.ts"), limits, { fs, nowMs: FIXED_NOW });
    expect(r.atoms).toHaveLength(2);
    expect(r.truncated).toBe(true);
    expect(r.coverage.incomplete).toBe(true);
    expect(r.coverage.reasons).toEqual(["match-cap"]);
    expect(r.coverage.matchesReturned).toBe(2);
  });

  it("reports truncated when whole-workspace file discovery hits maxFilesScanned", async () => {
    const { scope, fs } = memScope({
      "src/f0.ts": "",
      "src/f1.ts": "",
      "src/f2.ts": "",
    });
    const limits: SearchLimits = { ...DEFAULT_SEARCH_LIMITS, maxFilesScanned: 1 };
    const r = await findFiles(scope, fpq("**/*.ts"), limits, { fs, nowMs: FIXED_NOW });
    expect(r.atoms.map((a) => a.scopePath)).toEqual(["src/f0.ts"]);
    expect(r.truncated).toBe(true);
    expect(r.coverage.incomplete).toBe(true);
    expect(r.coverage.reasons).toEqual(["file-cap"]);
    expect(r.coverage.filesSkipped).toBeGreaterThan(0);
  });

  it("includes safe gitignored files from explicit-scope file search", async () => {
    const { scope, fs } = memScope(
      {
        "packages/a/generated/0.ts": "",
        "packages/a/generated/1.ts": "",
        "packages/a/generated/2.ts": "",
        "packages/a/src/ok.ts": "",
      },
      {
        workspace: {
          root: MEM_ROOT,
          name: "demo",
          version: "1.0.0",
          testFramework: "vitest",
          sourceDirs: ["packages/a/src"],
          testDirs: ["packages/a/tests"],
          languages: ["typescript"],
          ignoreLines: ["/packages/a/generated/"],
        },
        relativePaths: ["packages/a"],
      },
    );
    const limits: SearchLimits = { ...DEFAULT_SEARCH_LIMITS, maxFilesScanned: 10 };
    const r = await findFiles(scope, fpq("**/*.ts"), limits, { fs, nowMs: FIXED_NOW });
    expect(r.atoms.map((a) => a.scopePath)).toEqual([
      "packages/a/src/ok.ts",
      "packages/a/generated/0.ts",
      "packages/a/generated/1.ts",
      "packages/a/generated/2.ts",
    ]);
    expect(r.diagnostics?.policyMode).toBe("explicit-scope");
    expect(r.truncated).toBe(false);
    expect(r.coverage.incomplete).toBe(false);
    expect(r.coverage.reasons).toEqual([]);
  });

  it("omits node_modules from candidates", async () => {
    const { scope, fs } = memScope({
      "src/a.ts": "x",
      "node_modules/x.ts": "x",
    });
    const r = await findFiles(scope, fpq("**/*.ts"), DEFAULT_SEARCH_LIMITS, {
      fs,
      nowMs: FIXED_NOW,
    });
    expect(r.atoms.map((a) => a.scopePath)).toEqual(["src/a.ts"]);
  });

  it("emits stableId determined by scopePath + scopeId + queryFingerprint", async () => {
    const { scope, fs } = memScope({ "src/a.ts": "x" });
    const r1 = await findFiles(scope, fpq("**/*.ts"), DEFAULT_SEARCH_LIMITS, {
      fs,
      nowMs: FIXED_NOW,
    });
    const r2 = await findFiles(scope, fpq("**/*.ts"), DEFAULT_SEARCH_LIMITS, {
      fs,
      nowMs: FIXED_NOW,
    });
    expect(r1.atoms[0]?.stableId).toBe(r2.atoms[0]?.stableId);
  });
});

describe("readExcerpt (memFs)", () => {
  it("returns lines [start..end] joined by \\n with redactionState=redacted", async () => {
    const { scope, fs } = memScope({ "src/a.ts": "L1\nL2\nL3\nL4\n" });
    const r = await readExcerpt(
      scope,
      { scopePath: "src/a.ts", startLine: 1, endLine: 3, maxBytes: 256 },
      { fs, nowMs: FIXED_NOW },
    );
    expect(r.content).toBe("L1\nL2\nL3");
    expect(r.atom.redactionState).toBe("redacted");
    expect(r.atom.provenance.kind).toBe("excerpt-read");
  });

  it("truncates the excerpt to maxBytes and reports truncated=true", async () => {
    const { scope, fs } = memScope({ "src/a.ts": "0123456789\n" });
    const r = await readExcerpt(
      scope,
      { scopePath: "src/a.ts", startLine: 1, endLine: 1, maxBytes: 5 },
      { fs, nowMs: FIXED_NOW },
    );
    expect(r.truncated).toBe(true);
    expect(new TextEncoder().encode(r.content).length).toBeLessThanOrEqual(5);
  });

  it("rejects an absolute scopePath", async () => {
    const { scope, fs } = memScope({ "src/a.ts": "x\n" });
    await expect(
      readExcerpt(
        scope,
        { scopePath: "/etc/passwd", startLine: 1, endLine: 1, maxBytes: 16 },
        { fs, nowMs: FIXED_NOW },
      ),
    ).rejects.toBeInstanceOf(RepoSearchInvalidRangeError);
  });

  it("rejects a scopePath containing ..", async () => {
    const { scope, fs } = memScope({ "src/a.ts": "x\n" });
    await expect(
      readExcerpt(
        scope,
        { scopePath: "../etc/passwd", startLine: 1, endLine: 1, maxBytes: 16 },
        { fs, nowMs: FIXED_NOW },
      ),
    ).rejects.toBeInstanceOf(RepoSearchInvalidRangeError);
  });

  it("rejects a Windows-drive-prefixed scopePath", async () => {
    const { scope, fs } = memScope({ "src/a.ts": "x\n" });
    await expect(
      readExcerpt(
        scope,
        { scopePath: "C:/etc/passwd", startLine: 1, endLine: 1, maxBytes: 16 },
        { fs, nowMs: FIXED_NOW },
      ),
    ).rejects.toBeInstanceOf(RepoSearchInvalidRangeError);
  });

  it("rejects a zero startLine", async () => {
    const { scope, fs } = memScope({ "src/a.ts": "x\n" });
    await expect(
      readExcerpt(
        scope,
        { scopePath: "src/a.ts", startLine: 0, endLine: 1, maxBytes: 16 },
        { fs, nowMs: FIXED_NOW },
      ),
    ).rejects.toBeInstanceOf(RepoSearchInvalidRangeError);
  });

  it("rejects an endLine smaller than startLine", async () => {
    const { scope, fs } = memScope({ "src/a.ts": "x\ny\n" });
    await expect(
      readExcerpt(
        scope,
        { scopePath: "src/a.ts", startLine: 2, endLine: 1, maxBytes: 16 },
        { fs, nowMs: FIXED_NOW },
      ),
    ).rejects.toBeInstanceOf(RepoSearchInvalidRangeError);
  });

  it("rejects a non-integer startLine", async () => {
    const { scope, fs } = memScope({ "src/a.ts": "x\n" });
    await expect(
      readExcerpt(
        scope,
        { scopePath: "src/a.ts", startLine: 1.5, endLine: 2, maxBytes: 16 },
        { fs, nowMs: FIXED_NOW },
      ),
    ).rejects.toBeInstanceOf(RepoSearchInvalidRangeError);
  });

  it("emits stableId that depends on lineRange", async () => {
    const { scope, fs } = memScope({ "src/a.ts": "L1\nL2\nL3\n" });
    const a = await readExcerpt(
      scope,
      { scopePath: "src/a.ts", startLine: 1, endLine: 1, maxBytes: 16 },
      { fs, nowMs: FIXED_NOW },
    );
    const b = await readExcerpt(
      scope,
      { scopePath: "src/a.ts", startLine: 2, endLine: 2, maxBytes: 16 },
      { fs, nowMs: FIXED_NOW },
    );
    expect(a.atom.stableId).not.toBe(b.atom.stableId);
  });
});

// ─── Copilot review findings on PR #248 (memFs) ───────────────────────────────
describe("Copilot finding fixes (memFs)", () => {
  it("searchText clamps matches to min(limits.maxMatchesReturned, query.maxResults)", async () => {
    const { scope, fs } = memScope({ "src/a.ts": "match\nmatch\nmatch\nmatch\nmatch\n" });
    const q: RetrievalQuery = nlq("match", { maxResults: 2 });
    const r = await searchText(scope, q, DEFAULT_SEARCH_LIMITS, { fs, nowMs: FIXED_NOW });
    expect(r.atoms).toHaveLength(2);
    expect(r.truncated).toBe(true);
  });

  it("findFiles clamps to min(limits.maxMatchesReturned, query.maxResults)", async () => {
    const { scope, fs } = memScope({
      "a.ts": "",
      "b.ts": "",
      "c.ts": "",
      "d.ts": "",
    });
    const q: RetrievalQuery = fpq("**/*.ts", { maxResults: 2 });
    const r = await findFiles(scope, q, DEFAULT_SEARCH_LIMITS, { fs, nowMs: FIXED_NOW });
    expect(r.atoms).toHaveLength(2);
    expect(r.truncated).toBe(true);
  });

  it("readExcerpt rejects a negative maxBytes with RepoSearchInvalidRangeError", async () => {
    const { scope, fs } = memScope({ "src/a.ts": "alpha\n" });
    await expect(
      readExcerpt(
        scope,
        { scopePath: "src/a.ts", startLine: 1, endLine: 1, maxBytes: -1 },
        { fs, nowMs: FIXED_NOW },
      ),
    ).rejects.toBeInstanceOf(RepoSearchInvalidRangeError);
  });

  it("readExcerpt rejects a non-integer maxBytes", async () => {
    const { scope, fs } = memScope({ "src/a.ts": "alpha\n" });
    await expect(
      readExcerpt(
        scope,
        { scopePath: "src/a.ts", startLine: 1, endLine: 1, maxBytes: 1.5 },
        { fs, nowMs: FIXED_NOW },
      ),
    ).rejects.toBeInstanceOf(RepoSearchInvalidRangeError);
    await expect(
      readExcerpt(
        scope,
        { scopePath: "src/a.ts", startLine: 1, endLine: 1, maxBytes: Number.NaN },
        { fs, nowMs: FIXED_NOW },
      ),
    ).rejects.toBeInstanceOf(RepoSearchInvalidRangeError);
    await expect(
      readExcerpt(
        scope,
        { scopePath: "src/a.ts", startLine: 1, endLine: 1, maxBytes: Number.POSITIVE_INFINITY },
        { fs, nowMs: FIXED_NOW },
      ),
    ).rejects.toBeInstanceOf(RepoSearchInvalidRangeError);
  });

  it("readExcerpt refuses a denied path BEFORE the binary probe touches any bytes", async () => {
    const { scope, fs } = memScope({ ".env": "SECRET=value\n" });
    await expect(
      readExcerpt(
        scope,
        { scopePath: ".env", startLine: 1, endLine: 1, maxBytes: 100 },
        { fs, nowMs: FIXED_NOW },
      ),
    ).rejects.toBeInstanceOf(WorkspaceError);
  });

  it("readExcerpt refuses internal .keiko evidence paths", async () => {
    const { scope, fs } = memScope({
      ".keiko/evidence/qi/run.candidates.json": '{"packageManager":"stale-internal-value"}\n',
    });
    await expect(
      readExcerpt(
        scope,
        {
          scopePath: ".keiko/evidence/qi/run.candidates.json",
          startLine: 1,
          endLine: 1,
          maxBytes: 100,
        },
        { fs, nowMs: FIXED_NOW },
      ),
    ).rejects.toBeInstanceOf(RepoSearchUnsupportedFileError);
  });

  it("readExcerpt refuses local tool runtime state paths", async () => {
    const { scope, fs } = memScope({
      ".codex/history.jsonl": '{"private":"state"}\n',
      ".claude/transcript.jsonl": '{"private":"state"}\n',
    });

    await expect(
      readExcerpt(
        scope,
        { scopePath: ".codex/history.jsonl", startLine: 1, endLine: 1, maxBytes: 100 },
        { fs, nowMs: FIXED_NOW },
      ),
    ).rejects.toBeInstanceOf(RepoSearchUnsupportedFileError);
    await expect(
      readExcerpt(
        scope,
        { scopePath: ".claude/transcript.jsonl", startLine: 1, endLine: 1, maxBytes: 100 },
        { fs, nowMs: FIXED_NOW },
      ),
    ).rejects.toBeInstanceOf(RepoSearchUnsupportedFileError);
  });

  it("readExcerpt refuses a path outside scope.relativePaths", async () => {
    const { scope, fs } = memScope(
      { "src/a.ts": "alpha\n", "docs/b.md": "secret\n" },
      { relativePaths: ["src"] },
    );
    await expect(
      readExcerpt(
        scope,
        { scopePath: "docs/b.md", startLine: 1, endLine: 1, maxBytes: 64 },
        { fs, nowMs: FIXED_NOW },
      ),
    ).rejects.toMatchObject({ reason: "outside-scope" });
  });

  it("readExcerpt rejects a path that shares a prefix but is outside the scoped directory", async () => {
    // Guards against a startsWith(selectedPath) bug: `src-extra/foo.ts` starts with `src`
    // but is NOT inside the `src/` directory. The check must use `startsWith(`${path}/`)`.
    const { scope, fs } = memScope(
      { "src/a.ts": "alpha\n", "src-extra/foo.ts": "secret\n" },
      { relativePaths: ["src"] },
    );
    await expect(
      readExcerpt(
        scope,
        { scopePath: "src-extra/foo.ts", startLine: 1, endLine: 1, maxBytes: 64 },
        { fs, nowMs: FIXED_NOW },
      ),
    ).rejects.toMatchObject({ reason: "outside-scope" });
  });

  it("readExcerpt allows a file explicitly selected in scope.relativePaths", async () => {
    const { scope, fs } = memScope(
      { "src/a.ts": "alpha\n", "docs/b.md": "secret\n" },
      { relativePaths: ["docs/b.md"] },
    );
    const result = await readExcerpt(
      scope,
      { scopePath: "docs/b.md", startLine: 1, endLine: 1, maxBytes: 64 },
      { fs, nowMs: FIXED_NOW },
    );
    expect(result.content).toBe("secret");
  });

  it("readExcerpt allows safe gitignored and hidden files", async () => {
    const { scope, fs } = memScope(
      { "generated/report.txt": "generated context\n", ".toolrc": "hidden config\n" },
      {
        workspace: {
          root: MEM_ROOT,
          name: "demo",
          version: "1.0.0",
          testFramework: "vitest",
          sourceDirs: ["src"],
          testDirs: ["tests"],
          languages: ["typescript"],
          ignoreLines: ["generated/", ".toolrc"],
        },
      },
    );

    const generated = await readExcerpt(
      scope,
      { scopePath: "generated/report.txt", startLine: 1, endLine: 1, maxBytes: 64 },
      { fs, nowMs: FIXED_NOW },
    );
    const hidden = await readExcerpt(
      scope,
      { scopePath: ".toolrc", startLine: 1, endLine: 1, maxBytes: 64 },
      { fs, nowMs: FIXED_NOW },
    );

    expect(generated.content).toBe("generated context");
    expect(hidden.content).toBe("hidden config");
  });

  it("searchText denies node_modules when explicitly listed in scope.relativePaths", async () => {
    const { scope, fs } = memScope(
      { "node_modules/foo.ts": "match\n", "src/a.ts": "match\n" },
      { relativePaths: ["node_modules", "src"] },
    );
    const r = await searchText(scope, nlq("match"), DEFAULT_SEARCH_LIMITS, {
      fs,
      nowMs: FIXED_NOW,
    });
    expect(r.atoms.map((a) => a.scopePath)).toEqual(["src/a.ts"]);
  });

  it("scope.relativePaths cumulatively respects maxFilesScanned across entries", async () => {
    const { scope, fs } = memScope(
      { "x/1.ts": "match\n", "x/2.ts": "match\n", "y/3.ts": "match\n", "y/4.ts": "match\n" },
      { relativePaths: ["x", "y"] },
    );
    const limits: SearchLimits = { ...DEFAULT_SEARCH_LIMITS, maxFilesScanned: 2 };
    const r = await searchText(scope, nlq("match"), limits, { fs, nowMs: FIXED_NOW });
    expect(r.atoms.length).toBeLessThanOrEqual(2);
    expect(r.truncated).toBe(true);
  });
});

// ─── Real-fs tests (mkdtemp + nodeWorkspaceFs) ────────────────────────────────

describe("repoSearch (mkdtemp / real fs)", () => {
  let tmp: string;
  let scope: SearchScope;

  function file(rel: string, body: string): void {
    const abs = join(tmp, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "keiko-search-"));
    scope = {
      workspace: {
        root: tmp,
        name: "demo",
        version: "1.0.0",
        testFramework: "vitest",
        sourceDirs: ["src"],
        testDirs: ["tests"],
        languages: ["typescript"],
        ignoreLines: [],
      },
      scopeId: "scope-1",
      relativePaths: [],
    };
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("scans real files and emits an atom", async () => {
    file("src/a.ts", "needle\n");
    const r = await searchText(scope, nlq("needle"), DEFAULT_SEARCH_LIMITS, {
      nowMs: FIXED_NOW,
    });
    expect(r.atoms.map((a) => a.scopePath)).toEqual(["src/a.ts"]);
  });

  it("drops a binary file (PNG-magic + NUL) from text search", async () => {
    const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00]);
    writeFileSync(join(tmp, "img.png"), buf);
    file("src/a.ts", "needle\n");
    const r = await searchText(scope, nlq("needle"), DEFAULT_SEARCH_LIMITS, {
      nowMs: FIXED_NOW,
    });
    expect(r.atoms.map((a) => a.scopePath)).toEqual(["src/a.ts"]);
    expect(r.candidates.some((c) => c.scopePath === "img.png" && c.omitted === "binary")).toBe(
      true,
    );
  });

  it("drops text-looking image extensions before scanning content", async () => {
    file("img.png", "needle hidden in a fake image payload\n");
    file("src/a.ts", "needle\n");

    const r = await searchText(scope, nlq("needle"), DEFAULT_SEARCH_LIMITS, {
      nowMs: FIXED_NOW,
    });

    expect(r.atoms.map((a) => a.scopePath)).toEqual(["src/a.ts"]);
    expect(r.candidates.some((c) => c.scopePath === "img.png" && c.omitted === "binary")).toBe(
      true,
    );
  });

  it("refuses to read excerpts from image extensions even when bytes look textual", async () => {
    file("img.png", "looks like text but must not be processed\n");

    await expect(
      readExcerpt(scope, { scopePath: "img.png", startLine: 1, endLine: 1, maxBytes: 64 }),
    ).rejects.toBeInstanceOf(RepoSearchUnsupportedFileError);
  });

  it("does not drop a long UTF-8 file with multi-byte characters", async () => {
    const body = `${"héllo ".repeat(200)}\nneedle\n`;
    file("src/a.ts", body);
    const r = await searchText(scope, nlq("needle"), DEFAULT_SEARCH_LIMITS, {
      nowMs: FIXED_NOW,
    });
    expect(r.atoms).toHaveLength(1);
  });

  it("searches UTF-16LE source files instead of classifying them as binary", async () => {
    mkdirSync(join(tmp, "src"), { recursive: true });
    writeFileSync(
      join(tmp, "src", "utf16.ts"),
      Buffer.from("\ufeffexport const utf16Needle = 1;\n", "utf16le"),
    );
    const r = await searchText(scope, nlq("utf16Needle"), DEFAULT_SEARCH_LIMITS, {
      nowMs: FIXED_NOW,
    });
    expect(r.atoms.map((a) => a.scopePath)).toEqual(["src/utf16.ts"]);
    expect(r.candidates.some((candidate) => candidate.scopePath === "src/utf16.ts")).toBe(false);
  });

  it("blocks a symlink that escapes the workspace root", async () => {
    const outside = mkdtempSync(join(tmpdir(), "keiko-outside-"));
    try {
      writeFileSync(join(outside, "secret.txt"), "top-secret\n");
      symlinkSync(join(outside, "secret.txt"), join(tmp, "escape.txt"));
      await expect(
        readExcerpt(
          scope,
          { scopePath: "escape.txt", startLine: 1, endLine: 1, maxBytes: 64 },
          { nowMs: FIXED_NOW },
        ),
      ).rejects.toBeInstanceOf(PathEscapeError);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("readExcerpt rejects a symlink whose resolved target is outside scope.relativePaths", async () => {
    file("docs/b.md", "secret\n");
    mkdirSync(join(tmp, "src"), { recursive: true });
    symlinkSync(join(tmp, "docs/b.md"), join(tmp, "src/link.md"));
    scope = { ...scope, relativePaths: ["src"] };

    await expect(
      readExcerpt(
        scope,
        { scopePath: "src/link.md", startLine: 1, endLine: 1, maxBytes: 64 },
        { nowMs: FIXED_NOW },
      ),
    ).rejects.toMatchObject({ reason: "outside-scope" });
  });

  it("readExcerpt denies a symlink resolved target before the binary probe reads bytes", async () => {
    file(".env", "SECRET=value\n");
    mkdirSync(join(tmp, "src"), { recursive: true });
    symlinkSync(join(tmp, ".env"), join(tmp, "src/link.txt"));
    let byteProbeCalls = 0;
    const readFileBytes = nodeWorkspaceFs.readFileBytes;
    if (readFileBytes === undefined) {
      throw new Error("nodeWorkspaceFs.readFileBytes is required for this test");
    }
    const fs: WorkspaceFs = {
      ...nodeWorkspaceFs,
      readFileBytes: async (absolutePath, maxBytes): Promise<Uint8Array> => {
        byteProbeCalls += 1;
        return await readFileBytes(absolutePath, maxBytes);
      },
    };

    await expect(
      readExcerpt(
        scope,
        { scopePath: "src/link.txt", startLine: 1, endLine: 1, maxBytes: 64 },
        { fs, nowMs: FIXED_NOW },
      ),
    ).rejects.toMatchObject({ reason: "denied" });
    expect(byteProbeCalls).toBe(0);
  });

  it("readExcerpt reports a denied symlink target before outside-scope for narrowed scopes", async () => {
    file(".env", "SECRET=value\n");
    mkdirSync(join(tmp, "src"), { recursive: true });
    symlinkSync(join(tmp, ".env"), join(tmp, "src/link.txt"));
    scope = { ...scope, relativePaths: ["src"] };

    await expect(
      readExcerpt(
        scope,
        { scopePath: "src/link.txt", startLine: 1, endLine: 1, maxBytes: 64 },
        { nowMs: FIXED_NOW },
      ),
    ).rejects.toMatchObject({ reason: "denied" });
  });

  it("searchText skips a symlink resolved target before the binary probe reads bytes", async () => {
    file(".env", "SECRET=1\n");
    mkdirSync(join(tmp, "src"), { recursive: true });
    symlinkSync(join(tmp, ".env"), join(tmp, "src/link.txt"));
    scope = { ...scope, relativePaths: ["src/link.txt"] };
    let byteProbeCalls = 0;
    const readFileBytes = nodeWorkspaceFs.readFileBytes;
    if (readFileBytes === undefined) {
      throw new Error("nodeWorkspaceFs.readFileBytes is required for this test");
    }
    const fs: WorkspaceFs = {
      ...nodeWorkspaceFs,
      readFileBytes: async (absolutePath, maxBytes): Promise<Uint8Array> => {
        byteProbeCalls += 1;
        return await readFileBytes(absolutePath, maxBytes);
      },
    };

    const result = await searchText(scope, nlq("SECRET"), DEFAULT_SEARCH_LIMITS, {
      fs,
      nowMs: FIXED_NOW,
    });
    expect(result.atoms).toHaveLength(0);
    expect(result.candidates).toHaveLength(0);
    expect(byteProbeCalls).toBe(0);
  });

  it("searchText skips a hard-linked alias before the binary probe reads bytes", async () => {
    const outside = mkdtempSync(join(tmpdir(), "keiko-hardlink-"));
    try {
      writeFileSync(join(outside, "aliased.ts"), "export const secret = 'do not ingest';\n");
      mkdirSync(join(tmp, "src"), { recursive: true });
      linkSync(join(outside, "aliased.ts"), join(tmp, "src/alias.ts"));
      scope = { ...scope, relativePaths: ["src/alias.ts"] };
      let byteProbeCalls = 0;
      const readFileBytes = nodeWorkspaceFs.readFileBytes;
      if (readFileBytes === undefined) {
        throw new Error("nodeWorkspaceFs.readFileBytes is required for this test");
      }
      const fs: WorkspaceFs = {
        ...nodeWorkspaceFs,
        readFileBytes: async (absolutePath, maxBytes): Promise<Uint8Array> => {
          byteProbeCalls += 1;
          return await readFileBytes(absolutePath, maxBytes);
        },
      };

      const result = await searchText(scope, nlq("secret"), DEFAULT_SEARCH_LIMITS, {
        fs,
        nowMs: FIXED_NOW,
      });
      expect(result.atoms).toHaveLength(0);
      expect(result.candidates).toContainEqual({
        scopePath: "src/alias.ts",
        score: 0,
        signals: [],
        omitted: "ignored",
      });
      expect(byteProbeCalls).toBe(0);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("readExcerpt refuses a binary file with RepoSearchUnsupportedFileError", async () => {
    const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x00]);
    writeFileSync(join(tmp, "img.png"), buf);
    await expect(
      readExcerpt(
        scope,
        { scopePath: "img.png", startLine: 1, endLine: 1, maxBytes: 64 },
        { nowMs: FIXED_NOW },
      ),
    ).rejects.toBeInstanceOf(RepoSearchUnsupportedFileError);
  });

  it("readExcerpt returns a line slice from a real file", async () => {
    file("src/a.ts", "alpha\nbeta\ngamma\n");
    const r = await readExcerpt(
      scope,
      { scopePath: "src/a.ts", startLine: 2, endLine: 2, maxBytes: 64 },
      { nowMs: FIXED_NOW },
    );
    expect(r.content).toBe("beta");
    expect(r.truncated).toBe(false);
  });

  it("findFiles enumerates a glob across real directories", async () => {
    file("src/a.ts", "x");
    file("src/deep/b.ts", "x");
    file("src/c.js", "x");
    const r = await findFiles(scope, fpq("**/*.ts"), DEFAULT_SEARCH_LIMITS, {
      nowMs: FIXED_NOW,
    });
    expect(r.atoms.map((a) => a.scopePath).sort()).toEqual(["src/a.ts", "src/deep/b.ts"]);
  });

  it("file-listing atoms have emittedAtMs from the injected clock", async () => {
    file("src/a.ts", "x");
    const r = await findFiles(scope, fpq("**/*.ts"), DEFAULT_SEARCH_LIMITS, {
      nowMs: FIXED_NOW,
    });
    expect(r.atoms[0]?.emittedAtMs).toBe(FIXED_NOW());
  });
});

// ─── Audit findings: IO-error resilience (release criteria #179) ─────────────

function makeErrnoError(code: string): Error & { code: string } {
  const err = new Error(`${code}: permission denied`) as Error & { code: string };
  err.code = code;
  return err;
}

describe("IO-error resilience (Audit Finding 1 – scan path)", () => {
  // WorkspaceFs fake whose readFileBytes rejects with EACCES for a specific file.
  // Models the TOCTOU window between discovery and binary probe (Finding 1).
  it("searchText degrades to tool-unavailable candidate when probeBinary throws EACCES", async () => {
    const { scope, fs: baseFs } = memScope({
      "src/secret.ts": "needle\n",
      "src/ok.ts": "needle\n",
    });
    const fs: WorkspaceFs = {
      ...baseFs,
      readFileBytes: (absolutePath, maxBytes): Promise<Uint8Array> => {
        if (absolutePath.includes("secret.ts")) {
          return Promise.reject(makeErrnoError("EACCES"));
        }
        if (baseFs.readFileBytes !== undefined) {
          return baseFs.readFileBytes(absolutePath, maxBytes);
        }
        return Promise.resolve(new Uint8Array());
      },
    };
    const r = await searchText(scope, nlq("needle"), DEFAULT_SEARCH_LIMITS, {
      fs,
      nowMs: FIXED_NOW,
    });
    // The readable file still produces an atom; the EACCES file is a skip candidate, not a crash.
    expect(r.atoms.some((a) => a.scopePath === "src/ok.ts")).toBe(true);
    expect(
      r.candidates.some((c) => c.scopePath === "src/secret.ts" && c.omitted === "tool-unavailable"),
    ).toBe(true);
  });

  it("searchText degrades to tool-unavailable candidate when readWorkspaceFile throws EACCES", async () => {
    const { scope, fs: baseFs } = memScope({
      "src/secret.ts": "needle\n",
      "src/ok.ts": "needle\n",
    });
    const fs: WorkspaceFs = {
      ...baseFs,
      readFileUtf8: (absolutePath): string => {
        if (absolutePath.includes("secret.ts")) {
          throw makeErrnoError("EACCES");
        }
        return baseFs.readFileUtf8(absolutePath);
      },
      readFileBytes: (absolutePath, maxBytes): Promise<Uint8Array> => {
        if (absolutePath.includes("secret.ts")) {
          return Promise.reject(makeErrnoError("EACCES"));
        }
        if (baseFs.readFileBytes !== undefined) {
          return baseFs.readFileBytes(absolutePath, maxBytes);
        }
        return Promise.resolve(new Uint8Array());
      },
    };
    const r = await searchText(scope, nlq("needle"), DEFAULT_SEARCH_LIMITS, {
      fs,
      nowMs: FIXED_NOW,
    });
    expect(r.atoms.some((a) => a.scopePath === "src/ok.ts")).toBe(true);
    expect(
      r.candidates.some((c) => c.scopePath === "src/secret.ts" && c.omitted === "tool-unavailable"),
    ).toBe(true);
  });
});

describe("IO-error resilience (Audit Finding 2 – excerpt path)", () => {
  // readExcerpt must re-classify an EACCES during the binary probe as
  // RepoSearchUnsupportedFileError so that readKeptExcerpts skips the file instead of
  // crashing the grounded answer (the orchestrator comment explicitly promises this).
  it("readExcerpt throws RepoSearchUnsupportedFileError when probeBinary throws EACCES", async () => {
    const { scope, fs: baseFs } = memScope({ "src/a.ts": "content\n" });
    const fs: WorkspaceFs = {
      ...baseFs,
      readFileBytes: (): Promise<Uint8Array> => Promise.reject(makeErrnoError("EACCES")),
    };
    await expect(
      readExcerpt(
        scope,
        { scopePath: "src/a.ts", startLine: 1, endLine: 1, maxBytes: 64 },
        { fs, nowMs: FIXED_NOW },
      ),
    ).rejects.toBeInstanceOf(RepoSearchUnsupportedFileError);
  });

  it("readExcerpt re-throws TypeError (non-IO) from probeBinary unchanged", async () => {
    const { scope, fs: baseFs } = memScope({ "src/a.ts": "content\n" });
    const fs: WorkspaceFs = {
      ...baseFs,
      readFileBytes: (): Promise<Uint8Array> => Promise.reject(new TypeError("unexpected shape")),
    };
    await expect(
      readExcerpt(
        scope,
        { scopePath: "src/a.ts", startLine: 1, endLine: 1, maxBytes: 64 },
        { fs, nowMs: FIXED_NOW },
      ),
    ).rejects.toBeInstanceOf(TypeError);
  });
});
