import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { RetrievalQuery } from "@oscharko-dev/keiko-contracts/connected-context";
import { memFs } from "./_memfs.js";
import { gitHistoryAdapter } from "./gitHistory.js";
import { DEFAULT_SEARCH_LIMITS, type SearchScope } from "./repoSearch.js";
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

const SAMPLE_REFLOG =
  "0000000000000000000000000000000000000000 abc123def456 Alice <alice@example.com> 1700000000 +0000\tcommit (initial): hello\n" +
  "abc123def456 def789abc123 Alice <alice@example.com> 1700000100 +0000\tcommit: change\n";

function nlq(text: string): RetrievalQuery {
  return { kind: "natural-language", text, caseSensitive: false, maxResults: 100, emittedAtMs: 0 };
}

describe("gitHistoryAdapter.isAvailable", () => {
  it("is false when there is no .git in the workspace", async () => {
    const { scope, fs } = makeScope({ "src/foo.ts": "x" });
    await expect(gitHistoryAdapter.isAvailable(scope, fs)).resolves.toBe(false);
  });

  it("is false when .git is a file that does not contain a gitdir pointer", async () => {
    // memFs treats every recorded path as a regular file, so `.git` here is a non-pointer file.
    const { scope, fs } = makeScope({ ".git": "not a real worktree pointer" });
    await expect(gitHistoryAdapter.isAvailable(scope, fs)).resolves.toBe(false);
  });

  it("is true when .git/HEAD is present (memFs treats .git as a file but HEAD as a sibling)", async () => {
    // memFs simulates directories implicitly: any key starting with ".git/" implies a directory.
    // To make isAvailable see `.git` as a directory we set a directory marker by leaving the
    // bare ".git" key out and only writing nested files.
    const { scope, fs } = makeScope({
      ".git/HEAD": "ref: refs/heads/main\n",
      ".git/logs/HEAD": SAMPLE_REFLOG,
    });
    await expect(gitHistoryAdapter.isAvailable(scope, fs)).resolves.toBe(true);
  });
});

describe("gitHistoryAdapter.lookup", () => {
  it("returns exactly one atom referencing .git/HEAD when reflog has entries", async () => {
    const { scope, fs } = makeScope({
      ".git/HEAD": "ref: refs/heads/main\n",
      ".git/logs/HEAD": SAMPLE_REFLOG,
    });
    const atoms = await gitHistoryAdapter.lookup(scope, nlq("recent"), DEFAULT_SEARCH_LIMITS, fs, {
      nowMs: FIXED_NOW,
    });
    expect(atoms.length).toBe(1);
    expect(atoms[0]?.scopePath).toBe(".git/HEAD");
    expect(atoms[0]?.provenance.kind).toBe("git-history");
    expect(atoms[0]?.provenance.tool).toBe("git-reflog");
    expect(atoms[0]?.score).toBe(1.0);
    expect(atoms[0]?.lineRange).toBeUndefined();
  });

  it("returns an empty array when the reflog is empty", async () => {
    const { scope, fs } = makeScope({
      ".git/HEAD": "ref: refs/heads/main\n",
      ".git/logs/HEAD": "",
    });
    const atoms = await gitHistoryAdapter.lookup(scope, nlq("recent"), DEFAULT_SEARCH_LIMITS, fs, {
      nowMs: FIXED_NOW,
    });
    expect(atoms).toEqual([]);
  });

  it("returns an empty array when .git/HEAD is missing", async () => {
    const { scope, fs } = makeScope({});
    const atoms = await gitHistoryAdapter.lookup(scope, nlq("recent"), DEFAULT_SEARCH_LIMITS, fs, {
      nowMs: FIXED_NOW,
    });
    expect(atoms).toEqual([]);
  });

  it("returns an empty array when reflog lines have no parseable timestamp", async () => {
    const { scope, fs } = makeScope({
      ".git/HEAD": "ref: refs/heads/main\n",
      ".git/logs/HEAD": "garbage with no ten-digit number in sight\n",
    });
    const atoms = await gitHistoryAdapter.lookup(scope, nlq("recent"), DEFAULT_SEARCH_LIMITS, fs, {
      nowMs: FIXED_NOW,
    });
    expect(atoms).toEqual([]);
  });

  it("does not import child_process or exec — source-text invariant", () => {
    // Read the on-disk source as a string and assert that the spawn surfaces are absent.
    const source = readFileSync(fileURLToPath(new URL("./gitHistory.ts", import.meta.url)), "utf8");
    expect(source).not.toMatch(/from\s+["']node:child_process["']/);
    expect(source).not.toMatch(/\bspawn\s*\(/);
    expect(source).not.toMatch(/\bexec\s*\(/);
    expect(source).not.toMatch(/\bexecSync\s*\(/);
  });
});
