import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { RetrievalQuery } from "@oscharko-dev/keiko-contracts/connected-context";
import { memFs } from "./_memfs.js";
import { PathDeniedError } from "./errors.js";
import { nodeWorkspaceFs, type WorkspaceFs } from "./fs.js";
import { gitHistoryAdapter } from "./gitHistory.js";
import { resolveExistingAllowedWorkspaceRealRoot } from "./realpath.js";
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
    selectedRoot: MEM_ROOT,
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

function realScope(root: string, scopeId: string): SearchScope {
  const workspace: WorkspaceInfo = {
    root,
    selectedRoot: root,
    name: "demo",
    version: "1.0.0",
    testFramework: "vitest",
    sourceDirs: ["src"],
    testDirs: ["tests"],
    languages: ["typescript", "javascript"],
    ignoreLines: [],
  };
  return { workspace, scopeId, relativePaths: [] };
}

function writeGitMetadata(gitdir: string): void {
  mkdirSync(join(gitdir, "logs"), { recursive: true });
  writeFileSync(join(gitdir, "HEAD"), "ref: refs/heads/main\n", "utf8");
  writeFileSync(join(gitdir, "logs", "HEAD"), SAMPLE_REFLOG, "utf8");
}

function writeReciprocalWorktreePointer(gitdir: string, dotGit: string): void {
  writeFileSync(join(gitdir, "gitdir"), `${dotGit}\n`, "utf8");
}

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
    expect(atoms).toHaveLength(1);
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

  it("fails closed without the contained descriptor lane and never falls back to raw UTF-8", async () => {
    const { scope, fs: baseFs } = makeScope({
      ".git/HEAD": "ref: refs/heads/main\n",
      ".git/logs/HEAD": SAMPLE_REFLOG,
    });
    const {
      readFileUtf8WithinRootSameDescriptor: _containedDescriptorRead,
      ...withoutContainedDescriptor
    } = baseFs;
    expect(_containedDescriptorRead).toBeDefined();
    let rawReads = 0;
    const unsafeFallbackFs: WorkspaceFs = {
      ...withoutContainedDescriptor,
      readFileUtf8: (path): string => {
        rawReads += 1;
        return baseFs.readFileUtf8(path);
      },
    };

    await expect(gitHistoryAdapter.isAvailable(scope, unsafeFallbackFs)).resolves.toBe(false);
    await expect(
      gitHistoryAdapter.lookup(scope, nlq("recent"), DEFAULT_SEARCH_LIMITS, unsafeFallbackFs, {
        nowMs: FIXED_NOW,
      }),
    ).resolves.toEqual([]);
    expect(rawReads).toBe(0);
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
    expect(atoms).toHaveLength(1);
  });

  it("keeps generic .git root admission denied while reading its authorized metadata", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "keiko-git-standard-"));
    tempDirs.push(workspaceRoot);
    const gitdir = join(workspaceRoot, ".git");
    writeGitMetadata(gitdir);
    const scope = realScope(workspaceRoot, "scope-standard-policy");

    expect(() => resolveExistingAllowedWorkspaceRealRoot(nodeWorkspaceFs, gitdir)).toThrow(
      PathDeniedError,
    );
    await expect(gitHistoryAdapter.isAvailable(scope, nodeWorkspaceFs)).resolves.toBe(true);
    const atoms = await gitHistoryAdapter.lookup(
      scope,
      nlq("recent"),
      DEFAULT_SEARCH_LIMITS,
      nodeWorkspaceFs,
      { nowMs: FIXED_NOW },
    );
    expect(atoms).toHaveLength(1);
  });

  it("rejects a symlinked .git metadata base", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "keiko-git-standard-"));
    const repoRoot = mkdtempSync(join(tmpdir(), "keiko-git-repo-"));
    tempDirs.push(workspaceRoot, repoRoot);
    const externalGitdir = join(repoRoot, ".git");
    writeGitMetadata(externalGitdir);
    symlinkSync(externalGitdir, join(workspaceRoot, ".git"), "dir");
    const scope = realScope(workspaceRoot, "scope-symlinked-dot-git");

    await expect(gitHistoryAdapter.isAvailable(scope, nodeWorkspaceFs)).resolves.toBe(false);
    await expect(
      gitHistoryAdapter.lookup(scope, nlq("recent"), DEFAULT_SEARCH_LIMITS, nodeWorkspaceFs, {
        nowMs: FIXED_NOW,
      }),
    ).resolves.toEqual([]);
  });

  it("rejects a hard-linked worktree pointer file", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "keiko-git-pointer-hardlink-"));
    tempDirs.push(fixtureRoot);
    const workspaceRoot = join(fixtureRoot, "workspace");
    const gitdir = join(workspaceRoot, ".git-real");
    const pointerSource = join(fixtureRoot, "pointer-source");
    mkdirSync(workspaceRoot);
    writeGitMetadata(gitdir);
    writeFileSync(pointerSource, "gitdir: .git-real\n", "utf8");
    linkSync(pointerSource, join(workspaceRoot, ".git"));
    const scope = realScope(workspaceRoot, "scope-hard-linked-pointer");

    await expect(gitHistoryAdapter.isAvailable(scope, nodeWorkspaceFs)).resolves.toBe(false);
    await expect(
      gitHistoryAdapter.lookup(scope, nlq("recent"), DEFAULT_SEARCH_LIMITS, nodeWorkspaceFs, {
        nowMs: FIXED_NOW,
      }),
    ).resolves.toEqual([]);
  });

  it("rejects hard-linked metadata while leaving HEAD availability intact", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "keiko-git-metadata-hardlink-"));
    tempDirs.push(workspaceRoot);
    const gitdir = join(workspaceRoot, ".git");
    const reflogSource = join(workspaceRoot, "reflog-source");
    mkdirSync(join(gitdir, "logs"), { recursive: true });
    writeFileSync(join(gitdir, "HEAD"), "ref: refs/heads/main\n", "utf8");
    writeFileSync(reflogSource, SAMPLE_REFLOG, "utf8");
    linkSync(reflogSource, join(gitdir, "logs", "HEAD"));
    const scope = realScope(workspaceRoot, "scope-hard-linked-metadata");

    await expect(gitHistoryAdapter.isAvailable(scope, nodeWorkspaceFs)).resolves.toBe(true);
    await expect(
      gitHistoryAdapter.lookup(scope, nlq("recent"), DEFAULT_SEARCH_LIMITS, nodeWorkspaceFs, {
        nowMs: FIXED_NOW,
      }),
    ).resolves.toEqual([]);
  });

  it("rejects metadata symlinks that escape the authorized .git base", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "keiko-git-metadata-symlink-"));
    const outsideRoot = mkdtempSync(join(tmpdir(), "keiko-git-outside-metadata-"));
    tempDirs.push(workspaceRoot, outsideRoot);
    const gitdir = join(workspaceRoot, ".git");
    const outsideReflog = join(outsideRoot, "HEAD");
    mkdirSync(join(gitdir, "logs"), { recursive: true });
    writeFileSync(join(gitdir, "HEAD"), "ref: refs/heads/main\n", "utf8");
    writeFileSync(outsideReflog, SAMPLE_REFLOG, "utf8");
    symlinkSync(outsideReflog, join(gitdir, "logs", "HEAD"), "file");
    const scope = realScope(workspaceRoot, "scope-symlinked-metadata");

    await expect(gitHistoryAdapter.isAvailable(scope, nodeWorkspaceFs)).resolves.toBe(true);
    await expect(
      gitHistoryAdapter.lookup(scope, nlq("recent"), DEFAULT_SEARCH_LIMITS, nodeWorkspaceFs, {
        nowMs: FIXED_NOW,
      }),
    ).resolves.toEqual([]);
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
    expect(atoms).toHaveLength(1);
    expect(atoms[0]?.provenance.tool).toBe("git-reflog");
  });

  it("returns isAvailable=false when worktree pointer target is outside workspace", async () => {
    // memFs realPath is identity, so a path like /outside is truly outside /ws
    const { scope, fs } = makeScope({
      ".git": "gitdir: /outside/.git-real",
    });
    await expect(gitHistoryAdapter.isAvailable(scope, fs)).resolves.toBe(false);
  });

  it("rejects a fabricated external worktree directory before reading HEAD or its reflog", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "keiko-git-worktree-"));
    const repoRoot = mkdtempSync(join(tmpdir(), "keiko-git-repo-"));
    tempDirs.push(workspaceRoot, repoRoot);
    const gitdir = join(repoRoot, ".git", "worktrees", "demo");
    writeGitMetadata(gitdir);
    writeFileSync(join(workspaceRoot, ".git"), `gitdir: ${gitdir}\n`, "utf8");
    const protectedReads: string[] = [];
    const containedRead = nodeWorkspaceFs.readFileUtf8WithinRootSameDescriptor;
    if (containedRead === undefined) throw new TypeError("missing contained descriptor read");
    const observedFs: WorkspaceFs = {
      ...nodeWorkspaceFs,
      readFileUtf8WithinRootSameDescriptor: (base, path, maxBytes, policy, completeness) => {
        if (path === join(gitdir, "HEAD") || path === join(gitdir, "logs", "HEAD")) {
          protectedReads.push(path);
        }
        return containedRead.call(nodeWorkspaceFs, base, path, maxBytes, policy, completeness);
      },
    };
    const scope = realScope(workspaceRoot, "scope-fabricated-worktree");

    await expect(gitHistoryAdapter.isAvailable(scope, observedFs)).resolves.toBe(false);
    await expect(
      gitHistoryAdapter.lookup(scope, nlq("recent"), DEFAULT_SEARCH_LIMITS, observedFs, {
        nowMs: FIXED_NOW,
      }),
    ).resolves.toEqual([]);
    expect(protectedReads).toEqual([]);
  });

  it("accepts reciprocal metadata from a real linked-worktree layout", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "keiko-git-worktree-"));
    const repoRoot = mkdtempSync(join(tmpdir(), "keiko-git-repo-"));
    tempDirs.push(workspaceRoot, repoRoot);
    const dotGit = join(workspaceRoot, ".git");
    const gitdir = join(repoRoot, ".git", "worktrees", "demo");
    writeGitMetadata(gitdir);
    writeReciprocalWorktreePointer(gitdir, dotGit);
    writeFileSync(dotGit, `gitdir: ${gitdir}\n`, "utf8");
    const scope = realScope(workspaceRoot, "scope-real-worktree");

    await expect(gitHistoryAdapter.isAvailable(scope, nodeWorkspaceFs)).resolves.toBe(true);
    const atoms = await gitHistoryAdapter.lookup(
      scope,
      nlq("recent"),
      DEFAULT_SEARCH_LIMITS,
      nodeWorkspaceFs,
      { nowMs: FIXED_NOW },
    );
    expect(atoms).toHaveLength(1);
    expect(atoms[0]?.scopePath).toBe(".git/HEAD");
  });

  it("rejects descendants below the exact .git/worktrees/<name> base", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "keiko-git-worktree-"));
    const repoRoot = mkdtempSync(join(tmpdir(), "keiko-git-repo-"));
    tempDirs.push(workspaceRoot, repoRoot);
    const descendant = join(repoRoot, ".git", "worktrees", "demo", "nested");
    writeGitMetadata(descendant);
    writeFileSync(join(workspaceRoot, ".git"), `gitdir: ${descendant}\n`, "utf8");
    const scope = realScope(workspaceRoot, "scope-worktree-descendant");

    await expect(gitHistoryAdapter.isAvailable(scope, nodeWorkspaceFs)).resolves.toBe(false);
    await expect(
      gitHistoryAdapter.lookup(scope, nlq("recent"), DEFAULT_SEARCH_LIMITS, nodeWorkspaceFs, {
        nowMs: FIXED_NOW,
      }),
    ).resolves.toEqual([]);
  });

  it("rejects a symlink alias for an external worktree metadata base", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "keiko-git-worktree-"));
    const repoRoot = mkdtempSync(join(tmpdir(), "keiko-git-repo-"));
    const targetRepoRoot = mkdtempSync(join(tmpdir(), "keiko-git-target-repo-"));
    tempDirs.push(workspaceRoot, repoRoot, targetRepoRoot);
    const gitdir = join(repoRoot, ".git", "worktrees", "demo");
    const targetGitdir = join(targetRepoRoot, ".git", "worktrees", "demo");
    writeGitMetadata(targetGitdir);
    mkdirSync(join(repoRoot, ".git", "worktrees"), { recursive: true });
    symlinkSync(targetGitdir, gitdir, "dir");
    writeFileSync(join(workspaceRoot, ".git"), `gitdir: ${gitdir}\n`, "utf8");
    const scope = realScope(workspaceRoot, "scope-symlinked-worktree-base");

    await expect(gitHistoryAdapter.isAvailable(scope, nodeWorkspaceFs)).resolves.toBe(false);
    await expect(
      gitHistoryAdapter.lookup(scope, nlq("recent"), DEFAULT_SEARCH_LIMITS, nodeWorkspaceFs, {
        nowMs: FIXED_NOW,
      }),
    ).resolves.toEqual([]);
  });

  it("rejects a worktree metadata base below another denied root", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "keiko-git-denied-parent-"));
    tempDirs.push(fixtureRoot);
    const workspaceRoot = join(fixtureRoot, "workspace");
    const gitdir = join(fixtureRoot, ".ssh", "repo", ".git", "worktrees", "demo");
    mkdirSync(workspaceRoot);
    writeGitMetadata(gitdir);
    writeFileSync(join(workspaceRoot, ".git"), `gitdir: ${gitdir}\n`, "utf8");
    const scope = realScope(workspaceRoot, "scope-denied-worktree-parent");

    await expect(gitHistoryAdapter.isAvailable(scope, nodeWorkspaceFs)).resolves.toBe(false);
    await expect(
      gitHistoryAdapter.lookup(scope, nlq("recent"), DEFAULT_SEARCH_LIMITS, nodeWorkspaceFs, {
        nowMs: FIXED_NOW,
      }),
    ).resolves.toEqual([]);
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
      selectedRoot: workspaceRoot,
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
      ".git": `gitdir: .git-real${" ".repeat(5000)}`,
      ".git-real/HEAD": "ref: refs/heads/feat\n",
      ".git-real/logs/HEAD": SAMPLE_REFLOG,
    });
    let utf8Reads = 0;
    const cappedFs: WorkspaceFs = {
      ...baseFs,
      readFileUtf8: (abs) => {
        utf8Reads += 1;
        return baseFs.readFileUtf8(abs);
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
  });
});

describe("gitHistoryAdapter — size cap before read (Finding 6)", () => {
  it("reads an oversized reflog only through the bounded contained-prefix lane", async () => {
    const { scope, fs: baseFs } = makeScope({
      ".git/HEAD": "ref: refs/heads/main\n",
      ".git/logs/HEAD": `${SAMPLE_REFLOG}${"x".repeat(1_100_000)}`,
    });
    const safeRead = baseFs.readFileUtf8WithinRootSameDescriptor;
    if (safeRead === undefined) throw new TypeError("missing contained descriptor read");
    const reflogReads: { readonly maxBytes: number; readonly mode: string }[] = [];
    const boundedFs: WorkspaceFs = {
      ...baseFs,
      readFileUtf8WithinRootSameDescriptor: (base, path, maxBytes, policy, mode) => {
        if (path.endsWith("/logs/HEAD")) {
          reflogReads.push({ maxBytes, mode });
        }
        return safeRead.call(baseFs, base, path, maxBytes, policy, mode);
      },
    };
    const atoms = await gitHistoryAdapter.lookup(
      scope,
      nlq("recent"),
      DEFAULT_SEARCH_LIMITS,
      boundedFs,
      { nowMs: FIXED_NOW },
    );
    expect(atoms).toHaveLength(1);
    expect(reflogReads).toEqual([{ maxBytes: 1_048_576, mode: "prefix" }]);
  });
});
