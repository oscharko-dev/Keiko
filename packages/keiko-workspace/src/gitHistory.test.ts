import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { RetrievalQuery } from "@oscharko-dev/keiko-contracts/connected-context";
import { memFs } from "./_memfs.js";
import { nodeWorkspaceFs, type WorkspaceFs } from "./fs.js";
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

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

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

describe("gitHistoryAdapter.isAvailable — scope.relativePaths (Finding 8)", () => {
  it("returns false when scope.relativePaths is non-empty", async () => {
    const { scope: base, fs } = makeScope({
      ".git/HEAD": "ref: refs/heads/main\n",
      ".git/logs/HEAD": SAMPLE_REFLOG,
    });
    const scopeRestricted = { ...base, relativePaths: ["src"] };
    await expect(gitHistoryAdapter.isAvailable(scopeRestricted, fs)).resolves.toBe(false);
  });

  it("returns [] from lookup when scope.relativePaths is non-empty", async () => {
    const { scope: base, fs } = makeScope({
      ".git/HEAD": "ref: refs/heads/main\n",
      ".git/logs/HEAD": SAMPLE_REFLOG,
    });
    const scopeRestricted = { ...base, relativePaths: ["src"] };
    const atoms = await gitHistoryAdapter.lookup(
      scopeRestricted,
      nlq("recent"),
      DEFAULT_SEARCH_LIMITS,
      fs,
      {
        nowMs: FIXED_NOW,
      },
    );
    expect(atoms).toEqual([]);
  });
});

describe("gitHistoryAdapter — worktree pointer support (Finding 7)", () => {
  it("reads HEAD from .git/HEAD in a standard directory layout", async () => {
    // .git is a directory (simulated by memFs key prefix ".git/")
    const { scope, fs } = makeScope({
      ".git/HEAD": "ref: refs/heads/main\n",
      ".git/logs/HEAD": SAMPLE_REFLOG,
    });
    await expect(gitHistoryAdapter.isAvailable(scope, fs)).resolves.toBe(true);
    const atoms = await gitHistoryAdapter.lookup(scope, nlq("recent"), DEFAULT_SEARCH_LIMITS, fs, {
      nowMs: FIXED_NOW,
    });
    expect(atoms.length).toBe(1);
  });

  it("resolves HEAD via a valid worktree pointer and returns an atom", async () => {
    // .git is a file containing "gitdir: .git-real"
    // .git-real/ is the real gitdir that contains HEAD and logs/HEAD
    const { scope, fs } = makeScope({
      ".git": "gitdir: .git-real",
      ".git-real/HEAD": "ref: refs/heads/feat\n",
      ".git-real/logs/HEAD": SAMPLE_REFLOG,
    });
    await expect(gitHistoryAdapter.isAvailable(scope, fs)).resolves.toBe(true);
    const atoms = await gitHistoryAdapter.lookup(scope, nlq("recent"), DEFAULT_SEARCH_LIMITS, fs, {
      nowMs: FIXED_NOW,
    });
    expect(atoms.length).toBe(1);
    expect(atoms[0]?.provenance.tool).toBe("git-reflog");
  });

  it("returns isAvailable=false when worktree pointer target is outside workspace", async () => {
    // memFs realPath is identity, so a path like /outside is truly outside /ws
    const { scope, fs } = makeScope({
      ".git": "gitdir: /outside/.git-real",
    });
    await expect(gitHistoryAdapter.isAvailable(scope, fs)).resolves.toBe(false);
  });

  it("accepts a real git worktree pointer to an external .git/worktrees directory", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "keiko-git-worktree-"));
    const repoRoot = mkdtempSync(join(tmpdir(), "keiko-git-repo-"));
    tempDirs.push(workspaceRoot, repoRoot);
    const gitdir = join(repoRoot, ".git", "worktrees", "demo");
    mkdirSync(join(gitdir, "logs"), { recursive: true });
    writeFileSync(join(workspaceRoot, ".git"), `gitdir: ${gitdir}\n`, "utf8");
    writeFileSync(join(gitdir, "HEAD"), "ref: refs/heads/main\n", "utf8");
    writeFileSync(join(gitdir, "logs", "HEAD"), SAMPLE_REFLOG, "utf8");
    const workspace: WorkspaceInfo = {
      root: workspaceRoot,
      name: "demo",
      version: "1.0.0",
      testFramework: "vitest",
      sourceDirs: ["src"],
      testDirs: ["tests"],
      languages: ["typescript", "javascript"],
      ignoreLines: [],
    };
    const scope: SearchScope = { workspace, scopeId: "scope-real-worktree", relativePaths: [] };
    await expect(gitHistoryAdapter.isAvailable(scope, nodeWorkspaceFs)).resolves.toBe(true);
    const atoms = await gitHistoryAdapter.lookup(
      scope,
      nlq("recent"),
      DEFAULT_SEARCH_LIMITS,
      nodeWorkspaceFs,
      { nowMs: FIXED_NOW },
    );
    expect(atoms.length).toBe(1);
    expect(atoms[0]?.scopePath).toBe(".git/HEAD");
  });

  it("rejects external worktree pointers that traverse out after the allowlisted segment", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "keiko-git-worktree-"));
    const repoRoot = mkdtempSync(join(tmpdir(), "keiko-git-repo-"));
    tempDirs.push(workspaceRoot, repoRoot);
    const gitdir = join(repoRoot, ".git", "worktrees", "demo");
    const victim = join(repoRoot, "victim");
    mkdirSync(join(gitdir, "logs"), { recursive: true });
    mkdirSync(join(victim, "logs"), { recursive: true });
    writeFileSync(join(workspaceRoot, ".git"), `gitdir: ${gitdir}/../../../victim\n`, "utf8");
    writeFileSync(join(victim, "HEAD"), "ref: refs/heads/main\n", "utf8");
    writeFileSync(join(victim, "logs", "HEAD"), SAMPLE_REFLOG, "utf8");
    const workspace: WorkspaceInfo = {
      root: workspaceRoot,
      name: "demo",
      version: "1.0.0",
      testFramework: "vitest",
      sourceDirs: ["src"],
      testDirs: ["tests"],
      languages: ["typescript", "javascript"],
      ignoreLines: [],
    };
    const scope: SearchScope = { workspace, scopeId: "scope-traversal", relativePaths: [] };
    await expect(gitHistoryAdapter.isAvailable(scope, nodeWorkspaceFs)).resolves.toBe(false);
  });

  it("does not read oversized .git pointer files", async () => {
    const { scope, fs: baseFs } = makeScope({
      ".git": `gitdir: .git-real\n`,
      ".git-real/HEAD": "ref: refs/heads/feat\n",
      ".git-real/logs/HEAD": SAMPLE_REFLOG,
    });
    let utf8Reads = 0;
    let byteReads = 0;
    const cappedFs: WorkspaceFs = {
      ...baseFs,
      stat: (abs) => {
        const stat = baseFs.stat(abs);
        return abs.endsWith("/.git") ? { ...stat, size: 50_000 } : stat;
      },
      readFileUtf8: (abs) => {
        utf8Reads += 1;
        return baseFs.readFileUtf8(abs);
      },
      readFileBytes: async (abs, maxBytes) => {
        byteReads += 1;
        return baseFs.readFileBytes?.(abs, maxBytes) ?? new Uint8Array();
      },
    };
    await expect(gitHistoryAdapter.isAvailable(scope, cappedFs)).resolves.toBe(false);
    const atoms = await gitHistoryAdapter.lookup(
      scope,
      nlq("recent"),
      DEFAULT_SEARCH_LIMITS,
      cappedFs,
      {
        nowMs: FIXED_NOW,
      },
    );
    expect(atoms).toEqual([]);
    expect(utf8Reads).toBe(0);
    expect(byteReads).toBe(0);
  });
});

describe("gitHistoryAdapter — size cap before read (Finding 6)", () => {
  it("returns [] when .git/logs/HEAD exceeds REFLOG_MAX_BYTES and readFileBytes is absent", async () => {
    // Craft a memFs where the reflog stat reports a very large size but the FS has no readFileBytes.
    // We achieve this by using a custom WorkspaceFs whose stat reports size > REFLOG_MAX_BYTES.
    // REFLOG_MAX_BYTES is 1_048_576 (1 MiB).
    const { scope, fs: baseFs } = makeScope({
      ".git/HEAD": "ref: refs/heads/main\n",
      ".git/logs/HEAD": SAMPLE_REFLOG,
    });
    // Override stat to inflate size for logs/HEAD only; omit readFileBytes to force fallback path
    // (exactOptionalPropertyTypes forbids `readFileBytes: undefined`; destructure-to-exclude instead).
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { readFileBytes: _dropped, ...baseWithoutBytes } = baseFs;
    const hugeStatFs: typeof baseWithoutBytes & {
      stat: (abs: string) => ReturnType<typeof baseFs.stat>;
    } = {
      ...baseWithoutBytes,
      stat: (abs: string) => {
        const s = baseFs.stat(abs);
        if (abs.includes("logs/HEAD")) {
          return { ...s, size: 2_000_000 };
        }
        return s;
      },
    };
    const atoms = await gitHistoryAdapter.lookup(
      scope,
      nlq("recent"),
      DEFAULT_SEARCH_LIMITS,
      hugeStatFs,
      { nowMs: FIXED_NOW },
    );
    expect(atoms).toEqual([]);
  });
});
