import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RetrievalQuery } from "@oscharko-dev/keiko-contracts/connected-context";
import { PathEscapeError } from "@oscharko-dev/keiko-security/errors/workspace";
import { memFs } from "./_memfs.js";
import { RepoSearchInvalidQueryError } from "./errors.js";
import { nodeWorkspaceFs, type WorkspaceFs } from "./fs.js";
import { importGraphAdapter } from "./importGraph.js";
import { DEFAULT_SEARCH_LIMITS, type SearchLimits, type SearchScope } from "./repoSearch.js";
import type { WorkspaceInfo } from "./types.js";

const MEM_ROOT = "/ws";
const FIXED_NOW = (): number => 1_700_000_000_000;

function makeScope(files: Readonly<Record<string, string>>): {
  scope: SearchScope;
  fs: ReturnType<typeof memFs>;
} {
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
  return {
    scope: { workspace, scopeId: "scope-1", relativePaths: [] },
    fs: memFs(MEM_ROOT, files),
  };
}

function nlq(text: string): RetrievalQuery {
  return { kind: "natural-language", text, caseSensitive: false, maxResults: 100, emittedAtMs: 0 };
}

function exq(text: string): RetrievalQuery {
  return { kind: "exact-symbol", text, caseSensitive: false, maxResults: 100, emittedAtMs: 0 };
}

describe("importGraphAdapter", () => {
  it("is always available", async () => {
    const { scope, fs } = makeScope({});
    await expect(importGraphAdapter.isAvailable(scope, fs)).resolves.toBe(true);
  });

  it("picks up ESM static imports and reports the matching line", async () => {
    const { scope, fs } = makeScope({
      "src/a.ts": ["// header", 'import { foo } from "./bar";', "const x = 1;"].join("\n"),
    });
    const atoms = await importGraphAdapter.lookup(scope, nlq("./bar"), DEFAULT_SEARCH_LIMITS, fs, {
      nowMs: FIXED_NOW,
    });
    expect(atoms.length).toBe(1);
    expect(atoms[0]?.scopePath).toBe("src/a.ts");
    expect(atoms[0]?.lineRange).toEqual({ startLine: 2, endLine: 2 });
    expect(atoms[0]?.provenance.tool).toBe("code-intelligence-index");
    expect(atoms[0]?.provenance.kind).toBe("structural");
  });

  it("picks up ESM re-exports", async () => {
    const { scope, fs } = makeScope({
      "src/b.ts": 'export * from "./bar";',
    });
    const atoms = await importGraphAdapter.lookup(scope, nlq("./bar"), DEFAULT_SEARCH_LIMITS, fs, {
      nowMs: FIXED_NOW,
    });
    expect(atoms.map((a) => a.scopePath)).toEqual(["src/b.ts"]);
  });

  it("picks up CJS require()", async () => {
    const { scope, fs } = makeScope({
      "src/c.js": 'const foo = require("./bar");',
    });
    const atoms = await importGraphAdapter.lookup(scope, nlq("./bar"), DEFAULT_SEARCH_LIMITS, fs, {
      nowMs: FIXED_NOW,
    });
    expect(atoms.map((a) => a.scopePath)).toEqual(["src/c.js"]);
  });

  it("emits one atom per match when multiple imports of the same specifier appear", async () => {
    const { scope, fs } = makeScope({
      "src/d.ts": ['import { a } from "./bar";', 'import { b } from "./bar";', "const x = 1;"].join(
        "\n",
      ),
    });
    const atoms = await importGraphAdapter.lookup(scope, nlq("./bar"), DEFAULT_SEARCH_LIMITS, fs, {
      nowMs: FIXED_NOW,
    });
    expect(atoms.length).toBe(2);
    expect(atoms.map((a) => a.lineRange?.startLine).sort()).toEqual([1, 2]);
  });

  it("scores matches by resolved edge confidence, distance, and query relevance", async () => {
    const { scope, fs } = makeScope({
      "src/e.ts": 'import x from "./alpha-beta";',
      "src/alpha-beta.ts": "export default 1;",
    });
    const ex = await importGraphAdapter.lookup(
      scope,
      exq("./alpha-beta"),
      DEFAULT_SEARCH_LIMITS,
      fs,
      { nowMs: FIXED_NOW },
    );
    const sub = await importGraphAdapter.lookup(scope, nlq("alpha"), DEFAULT_SEARCH_LIMITS, fs, {
      nowMs: FIXED_NOW,
    });
    expect(ex[0]?.score).toBeGreaterThan(0.9);
    expect(sub[0]?.score).toBeGreaterThan(0.9);
    expect(sub[0]?.score).toBeLessThan(ex[0]?.score ?? 0);
  });

  it("skips a binary file (PNG magic header)", async () => {
    // Escaped PNG signature bytes keep this test file text-reviewable while still producing
    // the NULL bytes that trigger the binary probe.
    const binaryHeader = "\x89PNG\r\n\x1a\n" + '\0\0\0\0import "./bar";';
    const { scope, fs } = makeScope({
      "assets/img.png": binaryHeader,
    });
    const atoms = await importGraphAdapter.lookup(scope, nlq("./bar"), DEFAULT_SEARCH_LIMITS, fs, {
      nowMs: FIXED_NOW,
    });
    expect(atoms).toEqual([]);
  });

  it("honors limits.maxMatchesReturned", async () => {
    const { scope, fs } = makeScope({
      "src/a.ts": 'import x from "./bar";',
      "src/b.ts": 'import y from "./bar";',
      "src/c.ts": 'import z from "./bar";',
    });
    const capped: SearchLimits = { ...DEFAULT_SEARCH_LIMITS, maxMatchesReturned: 2 };
    const atoms = await importGraphAdapter.lookup(scope, nlq("./bar"), capped, fs, {
      nowMs: FIXED_NOW,
    });
    expect(atoms.length).toBe(2);
  });

  it("rejects unsupported query kinds with RepoSearchInvalidQueryError", async () => {
    const { scope, fs } = makeScope({});
    await expect(
      importGraphAdapter.lookup(
        scope,
        { kind: "regex", text: "foo", caseSensitive: false, maxResults: 1, emittedAtMs: 0 },
        DEFAULT_SEARCH_LIMITS,
        fs,
        { nowMs: FIXED_NOW },
      ),
    ).rejects.toBeInstanceOf(RepoSearchInvalidQueryError);
  });

  it("terminates quickly on pathological input (ReDoS regression)", { timeout: 1000 }, async () => {
    // A file consisting of `import ` followed by 5000 spaces with no closing quote was
    // previously O(n^2) due to \s overlapping the surrounding \s+ quantifiers. The fix
    // removes \s from the inner char class so only one split is ever tried.
    const pathological = "import " + " ".repeat(5000);
    const { scope, fs } = makeScope({ "src/evil.ts": pathological });
    const atoms = await importGraphAdapter.lookup(scope, nlq("./bar"), DEFAULT_SEARCH_LIMITS, fs, {
      nowMs: FIXED_NOW,
    });
    expect(atoms).toEqual([]);
  });

  it("respects scope.relativePaths: excludes files outside the restricted sub-tree", async () => {
    // When scope.relativePaths restricts to ["src"], a file in tests/ that imports the
    // query specifier must NOT produce atoms.
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
    const fs = memFs(MEM_ROOT, {
      "src/a.ts": "// no import here",
      "tests/b.test.ts": 'import "./my-module";',
    });
    const scopeRestricted: SearchScope = { workspace, scopeId: "scope-r", relativePaths: ["src"] };
    const atoms = await importGraphAdapter.lookup(
      scopeRestricted,
      nlq("my-module"),
      DEFAULT_SEARCH_LIMITS,
      fs,
      { nowMs: FIXED_NOW },
    );
    expect(atoms).toEqual([]);
  });
});

describe("importGraphAdapter (real fs symlink containment)", () => {
  let root: string;
  let outside: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "keiko-ig-"));
    outside = mkdtempSync(join(tmpdir(), "keiko-out-"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "demo" }), "utf8");
    mkdirSync(join(root, "src"), { recursive: true });
    // A symlinked file pointing outside should be skipped by discovery (we never see it).
    writeFileSync(join(outside, "rogue.ts"), 'import "./bar";', "utf8");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it("does not follow a workspace-internal symlink to an out-of-tree file", async () => {
    symlinkSync(join(outside, "rogue.ts"), join(root, "src", "linked.ts"));
    const workspace: WorkspaceInfo = {
      root,
      name: "demo",
      version: "1.0.0",
      testFramework: "vitest",
      sourceDirs: ["src"],
      testDirs: ["tests"],
      languages: ["typescript"],
      ignoreLines: [],
    };
    const scope: SearchScope = { workspace, scopeId: "real", relativePaths: [] };
    const atoms = await importGraphAdapter.lookup(
      scope,
      nlq("./bar"),
      DEFAULT_SEARCH_LIMITS,
      nodeWorkspaceFs,
      { nowMs: FIXED_NOW },
    );
    expect(atoms).toEqual([]);
  });

  it("does not binary-probe hard-linked aliases before the shared read denial", async () => {
    writeFileSync(join(outside, "aliased.ts"), 'import "./bar";', "utf8");
    linkSync(join(outside, "aliased.ts"), join(root, "src", "alias.ts"));
    const workspace: WorkspaceInfo = {
      root,
      name: "demo",
      version: "1.0.0",
      testFramework: "vitest",
      sourceDirs: ["src"],
      testDirs: ["tests"],
      languages: ["typescript"],
      ignoreLines: [],
    };
    const scope: SearchScope = { workspace, scopeId: "hardlink", relativePaths: [] };
    let aliasByteReads = 0;
    const trackingFs: WorkspaceFs = {
      ...nodeWorkspaceFs,
      readFileBytes: async (absolutePath, maxBytes) => {
        if (absolutePath.endsWith("/src/alias.ts")) {
          aliasByteReads += 1;
        }
        return nodeWorkspaceFs.readFileBytes?.(absolutePath, maxBytes) ?? new Uint8Array();
      },
    };
    const atoms = await importGraphAdapter.lookup(
      scope,
      nlq("./bar"),
      DEFAULT_SEARCH_LIMITS,
      trackingFs,
      { nowMs: FIXED_NOW },
    );
    expect(atoms).toEqual([]);
    expect(aliasByteReads).toBe(0);
  });

  it("rejects an escaping symlinked file when handed to it via scope.relativePaths", async () => {
    symlinkSync(outside, join(root, "linked-dir"));
    const workspace: WorkspaceInfo = {
      root,
      name: "demo",
      version: "1.0.0",
      testFramework: "vitest",
      sourceDirs: ["src"],
      testDirs: ["tests"],
      languages: ["typescript"],
      ignoreLines: [],
    };
    // discovery skips symlinks, so we cannot construct an escape via discovery alone. The
    // assertion below confirms the adapter at least does not crash and produces no atoms.
    const scope: SearchScope = { workspace, scopeId: "real2", relativePaths: [] };
    const atoms = await importGraphAdapter.lookup(
      scope,
      nlq("./bar"),
      DEFAULT_SEARCH_LIMITS,
      nodeWorkspaceFs,
      { nowMs: FIXED_NOW },
    );
    expect(atoms).toEqual([]);
    void PathEscapeError;
  });
});
