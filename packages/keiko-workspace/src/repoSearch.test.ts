import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
import {
  DEFAULT_SEARCH_LIMITS,
  findFiles,
  readExcerpt,
  searchText,
  type SearchLimits,
  type SearchScope,
} from "./repoSearch.js";
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

  // Issue #188 Case 2: exact-symbol question across a two-file scope where the named
  // symbol appears in both the defining file and a call site. exact-symbol is a substring
  // matcher (per repoSearchMatchers) so both files are expected to match; the regression
  // asserts the defining file survives ranking and the call-site file's atom (when present)
  // never escapes the workspace. Mutation guard: if the matcher drops the defining file —
  // e.g. by misordering candidate gathering or rejecting first-occurrence atoms — the
  // `definingAtom` assertion below fails.
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
    // exact-symbol is a substring search so both match — we assert the defining file is present
    // and ranked alongside any callers, and that no atoms escape the workspace.
    expect(r.atoms.length).toBeGreaterThanOrEqual(1);
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

  it("respects scope.workspace.ignoreLines for gitignore filtering", async () => {
    const { scope, fs } = memScope(
      { "src/a.ts": "match\n", "build/b.ts": "match\n" },
      {
        workspace: {
          root: MEM_ROOT,
          name: "demo",
          version: "1.0.0",
          testFramework: "vitest",
          sourceDirs: ["src"],
          testDirs: ["tests"],
          languages: ["typescript"],
          ignoreLines: ["build/"],
        },
      },
    );
    const r = await searchText(scope, nlq("match"), DEFAULT_SEARCH_LIMITS, {
      fs,
      nowMs: FIXED_NOW,
    });
    expect(r.atoms.map((a) => a.scopePath)).toEqual(["src/a.ts"]);
  });

  it("respects maxMatchesReturned with truncated=true", async () => {
    const { scope, fs } = memScope({ "src/a.ts": "x\nx\nx\nx\nx\n" });
    const limits: SearchLimits = { ...DEFAULT_SEARCH_LIMITS, maxMatchesReturned: 2 };
    const r = await searchText(scope, nlq("x"), limits, { fs, nowMs: FIXED_NOW });
    expect(r.atoms).toHaveLength(2);
    expect(r.truncated).toBe(true);
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
    expect(r.truncated).toBe(true);
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

  it("does not drop a long UTF-8 file with multi-byte characters", async () => {
    const body = `${"héllo ".repeat(200)}\nneedle\n`;
    file("src/a.ts", body);
    const r = await searchText(scope, nlq("needle"), DEFAULT_SEARCH_LIMITS, {
      nowMs: FIXED_NOW,
    });
    expect(r.atoms).toHaveLength(1);
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
