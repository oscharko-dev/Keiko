import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PathDeniedError, type WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import {
  workspaceFsWithOwnedRootAuthority,
  workspaceInfoWithOwnedRootAuthority,
} from "@oscharko-dev/keiko-workspace/internal/owned-root-mint";
import {
  GitRawWorktreeReadError,
  readGitRawChanges,
  readGitRawWorktreeSnapshot,
} from "./git-raw-worktree-node.js";
import {
  GitWorktreeReadError,
  readGitBlobText,
  readGitCommitIdentity,
  readGitFullRef,
  readGitIndexEntries,
  readGitIndexStat,
  readGitIndexTreeDigest,
  readGitRemoteAliases,
  readGitRevision,
  readGitStagedDiff,
  readGitTreeDigest,
  readGitTreeEntries,
  readGitUntrackedPaths,
  readGitWorktreeSnapshot,
  readStagedPaths,
} from "./git-worktree-snapshot-node.js";
import { indexStatMatches, readGitIndexWriteTimeNs } from "./git-index-stat.js";

// Owner audit finding b2-7: the racy-clean guard in `indexStatMatches` existed but was never
// supplied the `.git/index` write time at this reader's production call site (`workingStatus` in
// git-raw-worktree-node.ts), leaving it permanently unarmed. Spy on the real comparator (kept fully
// functional via `importOriginal`) to prove the wiring, rather than the comparator's own guard logic
// — that is already covered in isolation by git-index-stat.test.ts.
vi.mock("./git-index-stat.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./git-index-stat.js")>();
  return { ...actual, indexStatMatches: vi.fn(actual.indexStatMatches) };
});

let root: string;
let remote: string;
let workspace: WorkspaceInfo;
const git = (args: readonly string[], cwd = root): string =>
  execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  }).trim();

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-raw-worktree-")));
  remote = realpathSync(mkdtempSync(join(tmpdir(), "keiko-raw-worktree-remote-")));
  git(["init", "-q", "-b", "master"]);
  git(["config", "user.name", "Keiko Test"]);
  git(["config", "user.email", "keiko@example.test"]);
  writeFileSync(join(root, "code.txt"), "base\n");
  git(["add", "code.txt"]);
  git(["commit", "-qm", "base"]);
  git(["init", "--bare", "-q", "-b", "master", remote]);
  git(["remote", "add", "origin", remote]);
  git(["push", "-q", "-u", "origin", "master"]);
  // Advance the remote independently of the local worktree so the local branch is behind.
  const clone = realpathSync(mkdtempSync(join(tmpdir(), "keiko-raw-worktree-clone-")));
  git(["clone", "-q", remote, clone], tmpdir());
  writeFileSync(join(clone, "code.txt"), "advanced\n");
  git(["-C", clone, "add", "code.txt"]);
  git(["-C", clone, "config", "user.name", "Keiko Test"]);
  git(["-C", clone, "config", "user.email", "keiko@example.test"]);
  git(["-C", clone, "commit", "-qm", "advance"]);
  git(["-C", clone, "push", "-q", "origin", "master"]);
  git(["fetch", "-q", "origin"]);
  git(["branch", "--set-upstream-to=origin/master", "master"]);
  expect(git(["rev-parse", "@{upstream}"])).toBe(git(["rev-parse", "origin/master"]));
  rmSync(clone, { recursive: true, force: true });
  workspace = {
    root,
    selectedRoot: root,
    name: "test",
    version: undefined,
    testFramework: "vitest",
    sourceDirs: [],
    testDirs: [],
    languages: [],
    ignoreLines: [],
  };
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(remote, { recursive: true, force: true });
});

describe("readGitRawWorktreeSnapshot documented tracking limits", () => {
  it("preserves machine identities when accepted task context contains the same values", async () => {
    writeFileSync(join(root, "code.txt"), "updated\n");
    git(["add", "code.txt"]);
    writeFileSync(join(root, "untracked.txt"), "new\n");
    const clean = { workspace, processEnv: { PATH: process.env.PATH } };
    const headSha = await readGitRevision(clean, "HEAD");
    const contextual = {
      workspace,
      processEnv: {
        ...clean.processEnv,
        KEIKO_QUALIFICATION_RESUME_HEAD_SHA: headSha,
        GITHUB_REF: "refs/heads/master",
        GITHUB_HEAD_REF: "master",
        GITHUB_REF_TYPE: "branch",
        TASK_SOURCE_PATH: "code.txt",
        TASK_NEW_PATH: "untracked.txt",
        TASK_REMOTE_ALIAS: "origin",
      },
    };
    const readers = [
      readGitRawWorktreeSnapshot,
      readGitIndexEntries,
      readGitIndexStat,
      readGitIndexTreeDigest,
      readGitRemoteAliases,
      readGitUntrackedPaths,
      readGitWorktreeSnapshot,
      readStagedPaths,
      (deps: typeof clean): ReturnType<typeof readGitRevision> => readGitRevision(deps, "HEAD"),
      (deps: typeof clean): ReturnType<typeof readGitFullRef> => readGitFullRef(deps, "master"),
      (deps: typeof clean): ReturnType<typeof readGitTreeDigest> =>
        readGitTreeDigest(deps, headSha),
      (deps: typeof clean): ReturnType<typeof readGitTreeEntries> =>
        readGitTreeEntries(deps, headSha),
      (deps: typeof clean): ReturnType<typeof readGitCommitIdentity> =>
        readGitCommitIdentity(deps, "HEAD"),
    ];
    for (const read of readers) expect(await read(contextual)).toEqual(await read(clean));
  });

  it("refuses credential-redacted metadata without disabling content redaction", async () => {
    const clean = { workspace, processEnv: { PATH: process.env.PATH } };
    const headSha = await readGitRevision(clean, "HEAD");
    const credential = { ...clean, processEnv: { ...clean.processEnv, MY_DEPLOY_TOKEN: headSha } };
    await expect(readGitRevision(credential, "HEAD")).rejects.toBeInstanceOf(GitWorktreeReadError);
    const pathCredential = {
      ...clean,
      processEnv: { ...clean.processEnv, MY_DEPLOY_TOKEN: "code.txt" },
    };
    await expect(readGitIndexTreeDigest(pathCredential)).rejects.toBeInstanceOf(
      GitWorktreeReadError,
    );
    writeFileSync(join(root, "code.txt"), "private-environment-value\n");
    git(["add", "code.txt"]);
    const content = {
      ...clean,
      processEnv: { ...clean.processEnv, TASK_CONTEXT: "private-environment-value" },
    };
    const blob = git(["rev-parse", ":code.txt"]);
    expect(await readGitBlobText(content, blob)).toContain("[REDACTED]");
    expect(await readGitStagedDiff(content)).toContain("[REDACTED]");
    expect(await readGitBlobText(content, blob)).not.toContain("private-environment-value");
    expect(await readGitStagedDiff(content)).not.toContain("private-environment-value");
  });

  it("retains tracking headers when CI context values overlap the Git protocol", async () => {
    const real = await readGitWorktreeSnapshot({
      workspace,
      processEnv: { PATH: process.env.PATH, GITHUB_REF_TYPE: "branch", GITHUB_HEAD_REF: "master" },
    });
    expect(real).toMatchObject({
      currentBranchName: "master",
      hasUpstream: true,
      aheadCount: 0,
      behindCount: 1,
    });
  });

  it("refuses a credential-redacted snapshot instead of reporting no upstream", async () => {
    await expect(
      readGitWorktreeSnapshot({
        workspace,
        processEnv: { PATH: process.env.PATH, MY_DEPLOY_TOKEN: "branch" },
      }),
    ).rejects.toBeInstanceOf(GitWorktreeReadError);
  });

  it("never reflects the real upstream/ahead/behind state, unlike readGitWorktreeSnapshot", async () => {
    // The real reader sees the local branch is behind its configured upstream.
    const real = await readGitWorktreeSnapshot({ workspace });
    expect(real.hasUpstream).toBe(true);
    expect(real.behindCount).toBeGreaterThan(0);
    // The content-scoped raw reader (commit-facts / editor-diff path) fixes these fields at their
    // disengaged values regardless of the real tracking relation — this is why it must never back a
    // push effect's snapshotReader (see the header comment and doc comment in
    // git-raw-worktree-node.ts). This pin fails if the raw reader is ever changed to derive these
    // fields without also updating the callers that rely on the documented limitation.
    const raw = await readGitRawWorktreeSnapshot({ workspace });
    expect(raw.hasUpstream).toBe(false);
    expect(raw.aheadCount).toBe(0);
    expect(raw.behindCount).toBe(0);
  });
});

describe("racy-clean guard wiring (owner audit finding b2-7)", () => {
  it("supplies the real .git/index write time to indexStatMatches, not the unarmed 3-arg call", async () => {
    const mocked = vi.mocked(indexStatMatches);
    mocked.mockClear();
    await readGitRawWorktreeSnapshot({ workspace });
    const call = mocked.mock.calls.find(([, path]) => path === "code.txt");
    expect(call).toBeDefined();
    // Before the fix this 4th argument was always omitted (undefined), so the guard in
    // indexStatMatches never triggered on this production path no matter how racy the real
    // filesystem state was.
    expect(call?.[3]).toBeDefined();
    expect(call?.[3]).toBe(readGitIndexWriteTimeNs(root));
  });
});

// Run 5 (2026-09-10): the first `keiko_verification` inside a managed task worktree failed with
// PathDeniedError from this reader's stat comparator -- the git commands already resolved their cwd
// through the owned-root port the prover bound to the WorkspaceInfo (git-worktree-snapshot-node),
// but the reader's own filesystem helpers still asked the plain node port with a bare root string.
// Every filesystem helper now resolves through the same bound port; the plain projection of the
// same root keeps failing closed.
describe("a managed worktree below an always-denied segment", () => {
  const dirs: string[] = [];
  function deniedRepository(): string {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "keiko-raw-worktree-denied-")));
    dirs.push(base);
    const managed = join(base, ".keiko", "ui", "task-workspaces", "repo_1", "ws_1");
    mkdirSync(managed, { recursive: true });
    git(["init", "-q", "-b", "main"], managed);
    git(["config", "user.name", "Keiko Test"], managed);
    git(["config", "user.email", "keiko@example.test"], managed);
    writeFileSync(join(managed, "a.txt"), "v1\n");
    writeFileSync(join(managed, "b.txt"), "b\n");
    git(["add", "a.txt", "b.txt"], managed);
    git(["-c", "commit.gpgsign=false", "commit", "-qm", "base"], managed);
    // One modified tracked file (content read), one unchanged tracked file (stat comparison) and
    // one untracked file exercise every filesystem helper of the reader.
    writeFileSync(join(managed, "a.txt"), "v2\n");
    writeFileSync(join(managed, "untracked.txt"), "new\n");
    return managed;
  }
  function plainWorkspace(rootPath: string): WorkspaceInfo {
    return { ...workspace, root: rootPath, selectedRoot: rootPath };
  }

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("fails closed for the plain projection of the root", async () => {
    const managed = deniedRepository();
    await expect(
      readGitRawChanges({
        workspace: plainWorkspace(managed),
        processEnv: { PATH: process.env.PATH },
      }),
    ).rejects.toBeInstanceOf(PathDeniedError);
  });

  it("reads status and content once the WorkspaceInfo carries the owned-root authority", async () => {
    const managed = deniedRepository();
    const bound = workspaceInfoWithOwnedRootAuthority(
      plainWorkspace(managed),
      workspaceFsWithOwnedRootAuthority(nodeWorkspaceFs, managed),
    );
    const raw = await readGitRawChanges({
      workspace: bound,
      processEnv: { PATH: process.env.PATH },
    });
    expect(raw.branch).toBe("main");
    expect(raw.truncated).toBe(false);
    expect(raw.changes.map((change) => [change.path, change.worktreeStatus])).toEqual([
      ["a.txt", "M"],
      ["untracked.txt", "?"],
    ]);
    const snapshot = await readGitRawWorktreeSnapshot({
      workspace: bound,
      processEnv: { PATH: process.env.PATH },
    });
    expect(snapshot.unstagedFileCount).toBe(1);
    expect(snapshot.untrackedFileCount).toBe(1);
  });
});

// Run 6 (2026-09-10): the target repository tracked `.idea/.gitignore`; `.idea` is on the workspace
// deny list, and one such path marked the whole snapshot truncated, so every verification and
// commit-facts read failed with a bare `Error` -- for any repository that tracks IDE metadata.
// Deny-listed paths are outside Keiko's governed content surface: never read, never listed, counted.
describe("paths the workspace deny list protects", () => {
  it("excludes them from the listing, counts them, and keeps the snapshot complete", async () => {
    mkdirSync(join(root, ".idea"));
    writeFileSync(join(root, ".idea", ".gitignore"), "shelf/\n");
    git(["add", ".idea/.gitignore"]);
    git(["-c", "commit.gpgsign=false", "commit", "-qm", "ide metadata"]);
    // One tracked and one untracked deny-listed path; neither is git-ignored, so git reports both.
    writeFileSync(join(root, ".idea", "misc.xml"), "<project/>\n");
    writeFileSync(join(root, "code.txt"), "updated\n");
    const deps = { workspace, processEnv: { PATH: process.env.PATH } };

    const raw = await readGitRawChanges(deps);
    expect(raw.truncated).toBe(false);
    expect(raw.deniedPathCount).toBe(2);
    expect(raw.changes.map((change) => change.path)).toEqual(["code.txt"]);
    expect(JSON.stringify(raw)).not.toContain(".idea");

    const snapshot = await readGitRawWorktreeSnapshot(deps);
    expect(snapshot.deniedPathCount).toBe(2);
    expect(snapshot.unstagedFileCount).toBe(1);
    expect(snapshot.untrackedFileCount).toBe(0);
  });

  it("still fails closed, with its closed code, when the content budget leaves the snapshot incomplete", async () => {
    // Nine untracked files of exactly 1 MiB: the eighth exhausts the 8 MiB content budget and the
    // ninth marks the inspection incomplete.
    for (let index = 0; index < 9; index += 1) {
      writeFileSync(join(root, `blob-${String(index)}.bin`), Buffer.alloc(1_048_576, index));
    }
    const deps = { workspace, processEnv: { PATH: process.env.PATH } };
    const raw = await readGitRawChanges(deps);
    expect(raw.truncated).toBe(true);
    expect(raw.deniedPathCount).toBe(0);
    const failure = await readGitRawWorktreeSnapshot(deps).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(GitRawWorktreeReadError);
    expect(failure).toMatchObject({
      name: "GitRawWorktreeReadError",
      code: "git-raw-snapshot-incomplete",
      message: "git-raw-snapshot-incomplete",
    });
  });
});
