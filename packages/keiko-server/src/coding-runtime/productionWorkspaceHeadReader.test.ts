import { execFileSync } from "node:child_process";
import {
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  readProductionWorkspaceHead,
  type ProductionWorkspaceHeadFileSystem,
} from "./productionWorkspaceHeadReader.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("production workspace HEAD reader", () => {
  it("reads the exact managed worktree HEAD without ambient Git lookup", () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-runtime-head-"));
    roots.push(root);
    git(root, ["init", "-q", "-b", "main"]);
    git(root, ["config", "user.email", "runtime@keiko.example"]);
    git(root, ["config", "user.name", "Keiko Runtime"]);
    writeFileSync(join(root, "file.txt"), "bounded");
    git(root, ["add", "file.txt"]);
    git(root, ["commit", "-q", "-m", "fixture"]);

    expect(readProductionWorkspaceHead(root, root)).toBe(git(root, ["rev-parse", "HEAD"]));
    expect(readProductionWorkspaceHead(join(root, "missing"), root)).toBeUndefined();
  });

  it("rejects a pathname swap between lstat and handle open", () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-runtime-head-swap-"));
    roots.push(root);
    git(root, ["init", "-q", "-b", "main"]);
    git(root, ["config", "user.email", "runtime@keiko.example"]);
    git(root, ["config", "user.name", "Keiko Runtime"]);
    writeFileSync(join(root, "file.txt"), "bounded");
    git(root, ["add", "file.txt"]);
    git(root, ["commit", "-q", "-m", "fixture"]);
    const headPath = join(realpathSync(root), ".git", "HEAD");
    let swapped = false;
    const fileSystem: ProductionWorkspaceHeadFileSystem = {
      close: closeSync,
      fstat: fstatSync,
      lstat: lstatSync,
      open: (path) => {
        if (path === headPath && !swapped) {
          swapped = true;
          renameSync(headPath, `${headPath}.before-swap`);
          writeFileSync(headPath, `${"f".repeat(40)}\n`, "utf8");
        }
        return openSync(path, "r");
      },
      read: readSync,
      realpath: realpathSync,
    };

    expect(readProductionWorkspaceHead(root, root, fileSystem)).toBeUndefined();
    expect(swapped).toBe(true);
  });
});

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd, encoding: "utf8" }).trim();
}

const MAIN_SHA = "0123456789abcdef0123456789abcdef01234567";
const TAG_SHA = "fedcba9876543210fedcba9876543210fedcba98";

interface WorktreeFixture {
  readonly repoRoot: string;
  readonly worktreeRoot: string;
  readonly worktreeGitDir: string;
  readonly commonGitDir: string;
}

function worktreeFixture(): WorktreeFixture {
  const root = mkdtempSync(join(tmpdir(), "keiko-runtime-head-worktree-"));
  roots.push(root);
  const repoRoot = join(root, "repo");
  const commonGitDir = join(repoRoot, ".git");
  const worktreeGitDir = join(commonGitDir, "worktrees", "wt");
  const worktreeRoot = join(root, "wt");
  mkdirSync(worktreeGitDir, { recursive: true });
  mkdirSync(worktreeRoot);
  writeFileSync(join(commonGitDir, "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(
    join(commonGitDir, "packed-refs"),
    `# pack-refs with: peeled fully-peeled sorted\nmalformed-line-without-ref\n${TAG_SHA} refs/tags/v1\n^${TAG_SHA}\n${MAIN_SHA} refs/heads/main\n`,
  );
  writeFileSync(join(worktreeGitDir, "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(worktreeGitDir, "commondir"), "../..\n");
  writeFileSync(join(worktreeRoot, ".git"), `gitdir: ${worktreeGitDir}\n`);
  return { repoRoot, worktreeRoot, worktreeGitDir, commonGitDir };
}

describe("production workspace HEAD reader worktree layouts", () => {
  it("resolves a linked-worktree HEAD through commondir and packed refs", () => {
    const fixture = worktreeFixture();
    expect(readProductionWorkspaceHead(fixture.worktreeRoot, fixture.repoRoot)).toBe(MAIN_SHA);
  });

  it("prefers a loose common-root ref over the packed ref", () => {
    const fixture = worktreeFixture();
    mkdirSync(join(fixture.commonGitDir, "refs", "heads"), { recursive: true });
    writeFileSync(join(fixture.commonGitDir, "refs", "heads", "main"), `${TAG_SHA}\n`);
    expect(readProductionWorkspaceHead(fixture.worktreeRoot, fixture.repoRoot)).toBe(TAG_SHA);
  });

  it("reads a detached HEAD when the repository root is itself a linked worktree", () => {
    const fixture = worktreeFixture();
    writeFileSync(join(fixture.worktreeGitDir, "HEAD"), `${MAIN_SHA}\n`);
    expect(readProductionWorkspaceHead(fixture.worktreeRoot, fixture.worktreeRoot)).toBe(MAIN_SHA);
  });

  it("matches linked-worktree internals using platform filesystem identity", () => {
    const fixture = worktreeFixture();
    const actualGitDir = realpathSync(fixture.worktreeGitDir);
    const disguisedGitDir = `${actualGitDir.slice(0, -2)}WT`;
    const actualPath = (path: string): string =>
      path.startsWith(disguisedGitDir)
        ? `${actualGitDir}${path.slice(disguisedGitDir.length)}`
        : path;
    const fileSystem: ProductionWorkspaceHeadFileSystem = {
      close: closeSync,
      fstat: fstatSync,
      lstat: (path) => lstatSync(actualPath(path)),
      open: (path) => openSync(actualPath(path), "r"),
      read: readSync,
      realpath: (path) => {
        if (path.startsWith(disguisedGitDir)) return path;
        const canonical = realpathSync(actualPath(path));
        return canonical === actualGitDir ? disguisedGitDir : canonical;
      },
    };
    const expected =
      process.platform === "darwin" || process.platform === "win32" ? MAIN_SHA : undefined;

    expect(readProductionWorkspaceHead(fixture.worktreeRoot, fixture.repoRoot, fileSystem)).toBe(
      expected,
    );
  });

  it("fails closed when the commondir pointer escapes the repository git directory", () => {
    const fixture = worktreeFixture();
    writeFileSync(join(fixture.worktreeGitDir, "commondir"), "../../../..\n");
    expect(readProductionWorkspaceHead(fixture.worktreeRoot, fixture.repoRoot)).toBeUndefined();
  });

  it("rejects malformed gitdir pointers and symlinked loose refs", () => {
    const fixture = worktreeFixture();
    writeFileSync(join(fixture.worktreeRoot, ".git"), "not-a-pointer\n");
    expect(readProductionWorkspaceHead(fixture.worktreeRoot, fixture.repoRoot)).toBeUndefined();

    const symlinked = worktreeFixture();
    mkdirSync(join(symlinked.commonGitDir, "refs", "heads"), { recursive: true });
    writeFileSync(join(symlinked.commonGitDir, "loose-target"), `${TAG_SHA}\n`);
    symlinkSync(
      join(symlinked.commonGitDir, "loose-target"),
      join(symlinked.commonGitDir, "refs", "heads", "main"),
    );
    // The symlinked loose ref must be ignored; the packed ref stays authoritative.
    expect(readProductionWorkspaceHead(symlinked.worktreeRoot, symlinked.repoRoot)).toBe(MAIN_SHA);
  });

  it("returns nothing for a packed ref whose recorded object id is malformed", () => {
    const fixture = worktreeFixture();
    writeFileSync(join(fixture.commonGitDir, "packed-refs"), "not-hex refs/heads/main\n");
    expect(readProductionWorkspaceHead(fixture.worktreeRoot, fixture.repoRoot)).toBeUndefined();
  });

  it("rejects a HEAD file whose size races between read and fstat", () => {
    const fixture = worktreeFixture();
    const fileSystem: ProductionWorkspaceHeadFileSystem = {
      close: closeSync,
      fstat: fstatSync,
      lstat: lstatSync,
      open: (path) => openSync(path, "r"),
      read: () => 0,
      realpath: realpathSync,
    };
    expect(
      readProductionWorkspaceHead(fixture.worktreeRoot, fixture.repoRoot, fileSystem),
    ).toBeUndefined();
  });

  it("rejects a directory whose canonical identity does not match its path", () => {
    const fixture = worktreeFixture();
    const decoy = mkdtempSync(join(tmpdir(), "keiko-runtime-head-decoy-"));
    roots.push(decoy);
    const fileSystem: ProductionWorkspaceHeadFileSystem = {
      close: closeSync,
      fstat: fstatSync,
      lstat: lstatSync,
      open: (path) => openSync(path, "r"),
      read: readSync,
      realpath: (path) => (path === fixture.worktreeRoot ? decoy : realpathSync(path)),
    };
    expect(
      readProductionWorkspaceHead(fixture.worktreeRoot, fixture.repoRoot, fileSystem),
    ).toBeUndefined();
  });
});
