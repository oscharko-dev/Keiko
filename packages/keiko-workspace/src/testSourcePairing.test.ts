import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RetrievalQuery } from "@oscharko-dev/keiko-contracts/connected-context";
import { PathEscapeError } from "@oscharko-dev/keiko-security/errors/workspace";
import { memFs } from "./_memfs.js";
import { nodeWorkspaceFs } from "./fs.js";
import { DEFAULT_SEARCH_LIMITS, type SearchLimits, type SearchScope } from "./repoSearch.js";
import { testSourcePairingAdapter } from "./testSourcePairing.js";
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

describe("testSourcePairingAdapter", () => {
  it("is always available", async () => {
    const { scope, fs } = makeScope({});
    await expect(testSourcePairingAdapter.isAvailable(scope, fs)).resolves.toBe(true);
  });

  it("pairs src/foo.ts to tests/foo.test.ts when present", async () => {
    const { scope, fs } = makeScope({
      "src/foo.ts": "export const x = 1;",
      "tests/foo.test.ts": "test('x', () => {});",
    });
    const atoms = await testSourcePairingAdapter.lookup(
      scope,
      nlq("src/foo.ts"),
      DEFAULT_SEARCH_LIMITS,
      fs,
      { nowMs: FIXED_NOW },
    );
    expect(atoms.length).toBe(1);
    expect(atoms[0]?.scopePath).toBe("tests/foo.test.ts");
    expect(atoms[0]?.provenance.kind).toBe("structural");
    expect(atoms[0]?.provenance.tool).toBe("test-source-pairing");
    expect(atoms[0]?.score).toBe(0.8);
    expect(atoms[0]?.lineRange).toBeUndefined();
  });

  it("falls back to src/foo.spec.ts when tests/foo.test.ts and src/foo.test.ts are absent", async () => {
    const { scope, fs } = makeScope({
      "src/foo.ts": "x",
      "src/foo.spec.ts": "spec",
    });
    const atoms = await testSourcePairingAdapter.lookup(
      scope,
      nlq("src/foo.ts"),
      DEFAULT_SEARCH_LIMITS,
      fs,
      { nowMs: FIXED_NOW },
    );
    expect(atoms.map((a) => a.scopePath)).toEqual(["src/foo.spec.ts"]);
  });

  it("pairs tests/foo.test.ts back to src/foo.ts (reverse direction)", async () => {
    const { scope, fs } = makeScope({
      "src/foo.ts": "src",
      "tests/foo.test.ts": "test",
    });
    const atoms = await testSourcePairingAdapter.lookup(
      scope,
      nlq("tests/foo.test.ts"),
      DEFAULT_SEARCH_LIMITS,
      fs,
      { nowMs: FIXED_NOW },
    );
    expect(atoms.map((a) => a.scopePath)).toEqual(["src/foo.ts"]);
  });

  it("pairs src/foo.tsx to tests/foo.test.tsx", async () => {
    const { scope, fs } = makeScope({
      "src/foo.tsx": "x",
      "tests/foo.test.tsx": "y",
    });
    const atoms = await testSourcePairingAdapter.lookup(
      scope,
      nlq("src/foo.tsx"),
      DEFAULT_SEARCH_LIMITS,
      fs,
      { nowMs: FIXED_NOW },
    );
    expect(atoms.map((a) => a.scopePath)).toEqual(["tests/foo.test.tsx"]);
  });

  it("returns an empty array when no pair exists", async () => {
    const { scope, fs } = makeScope({
      "src/foo.ts": "only source",
    });
    const atoms = await testSourcePairingAdapter.lookup(
      scope,
      nlq("src/foo.ts"),
      DEFAULT_SEARCH_LIMITS,
      fs,
      { nowMs: FIXED_NOW },
    );
    expect(atoms).toEqual([]);
  });

  it("produces deterministic stable IDs across two runs with the same input", async () => {
    const { scope, fs } = makeScope({
      "src/foo.ts": "x",
      "tests/foo.test.ts": "y",
    });
    const q = nlq("src/foo.ts");
    const first = await testSourcePairingAdapter.lookup(scope, q, DEFAULT_SEARCH_LIMITS, fs, {
      nowMs: FIXED_NOW,
    });
    const second = await testSourcePairingAdapter.lookup(scope, q, DEFAULT_SEARCH_LIMITS, fs, {
      nowMs: FIXED_NOW,
    });
    expect(first.map((a) => a.stableId)).toEqual(second.map((a) => a.stableId));
  });

  it("honors limits.maxMatchesReturned when scanning by symbol", async () => {
    const { scope, fs } = makeScope({
      "src/foo.ts": "src",
      "tests/foo.test.ts": "test",
    });
    const cappedLimits: SearchLimits = { ...DEFAULT_SEARCH_LIMITS, maxMatchesReturned: 0 };
    const atoms = await testSourcePairingAdapter.lookup(scope, exq("foo"), cappedLimits, fs, {
      nowMs: FIXED_NOW,
    });
    expect(atoms.length).toBe(0);
  });

  it("rejects other query kinds with an empty result (not throw)", async () => {
    const { scope, fs } = makeScope({});
    const atoms = await testSourcePairingAdapter.lookup(
      scope,
      { kind: "file-pattern", text: "*.ts", caseSensitive: false, maxResults: 10, emittedAtMs: 0 },
      DEFAULT_SEARCH_LIMITS,
      fs,
      { nowMs: FIXED_NOW },
    );
    expect(atoms).toEqual([]);
  });

  it("respects scope.relativePaths when scanning by symbol (pathsForSymbol)", async () => {
    // When scope.relativePaths restricts to ["src"], pathsForSymbol must only scan src/.
    // A file "tests/only-in-tests.ts" that matches the symbol "only-in-tests" must NOT be
    // surfaced as an input path (and therefore must not produce a pairing atom), because it
    // lives outside the restricted scope. Only files discovered within src/ feed pathsForSymbol.
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
      // "only-in-tests" exists only in tests/ — outside the restricted scope.
      "tests/only-in-tests.ts": "x",
      // Its pair would be src/only-in-tests.ts — but since pathsForSymbol is scoped to src/
      // and tests/only-in-tests.ts is not visited, no atom is produced.
    });
    const scopeRestricted: SearchScope = { workspace, scopeId: "scope-r2", relativePaths: ["src"] };
    const atoms = await testSourcePairingAdapter.lookup(
      scopeRestricted,
      exq("only-in-tests"),
      DEFAULT_SEARCH_LIMITS,
      fs,
      { nowMs: FIXED_NOW },
    );
    // pathsForSymbol only scans src/ — no match found — no atom returned.
    expect(atoms).toEqual([]);
  });

  it("does not emit a paired file outside scope.relativePaths for a direct path query", async () => {
    const { scope: base, fs } = makeScope({
      "src/foo.ts": "src",
      "tests/foo.test.ts": "test",
    });
    const scopeRestricted: SearchScope = { ...base, relativePaths: ["src"] };
    const atoms = await testSourcePairingAdapter.lookup(
      scopeRestricted,
      nlq("src/foo.ts"),
      DEFAULT_SEARCH_LIMITS,
      fs,
      { nowMs: FIXED_NOW },
    );
    expect(atoms).toEqual([]);
  });

  it("does not emit a paired file outside scope.relativePaths for a symbol query", async () => {
    const { scope: base, fs } = makeScope({
      "src/foo.ts": "src",
      "tests/foo.test.ts": "test",
    });
    const scopeRestricted: SearchScope = { ...base, relativePaths: ["src"] };
    const atoms = await testSourcePairingAdapter.lookup(
      scopeRestricted,
      exq("foo"),
      DEFAULT_SEARCH_LIMITS,
      fs,
      { nowMs: FIXED_NOW },
    );
    expect(atoms).toEqual([]);
  });
});

describe("testSourcePairingAdapter (real fs symlink containment)", () => {
  let root: string;
  let outside: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "keiko-pair-"));
    outside = mkdtempSync(join(tmpdir(), "keiko-out-"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "demo" }), "utf8");
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "foo.ts"), "x", "utf8");
    writeFileSync(join(outside, "rogue.txt"), "evil", "utf8");
    // Create a symlinked tests/ directory that points OUTSIDE the workspace.
    symlinkSync(outside, join(root, "tests"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  function file(rel: string, body = "x"): void {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body, "utf8");
  }

  it("rejects escapes via a symlinked candidate directory", async () => {
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
    const scope: SearchScope = { workspace, scopeId: "real-1", relativePaths: [] };
    // The pairing candidate is `tests/foo.test.ts`; that path traverses the symlinked
    // tests/ dir whose real target is outside the workspace, so the containment check fires.
    await expect(
      testSourcePairingAdapter.lookup(
        scope,
        nlq("src/foo.ts"),
        DEFAULT_SEARCH_LIMITS,
        nodeWorkspaceFs,
      ),
    ).rejects.toBeInstanceOf(PathEscapeError);
    void file;
  });
});
