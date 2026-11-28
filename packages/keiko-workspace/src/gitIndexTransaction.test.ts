import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PathDeniedError } from "./errors.js";
import { nodeWorkspaceFs } from "./fs.js";
import {
  GIT_STAGE_FILE_MAX_BYTES,
  assertGitStageFileUnchanged,
  inspectGitStageFile,
  isGitStageLargeFile,
  readGitStageFile,
  streamGitStageFile,
  withGitIndexTransaction,
} from "./gitIndexTransaction.js";
import { workspaceFsWithOwnedRootAuthority } from "./ownedRootMint.js";
let root: string;
function git(args: readonly string[], cwd = root): string {
  return execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  }).trim();
}
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-index-owner-")));
  git(["init", "-qb", "dev"]);
  git(["config", "user.name", "Test"]);
  git(["config", "user.email", "test@example.test"]);
  writeFileSync(join(root, "file"), "base\n");
  git(["add", "file"]);
  git(["-c", "commit.gpgsign=false", "commit", "-qm", "base"]);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});
describe("existing workspace Git metadata index owner", () => {
  // Owner review of PR #3452 (2026-09-10): a 64 KiB default kept a lockfile or a bundled asset from
  // ever being staged by a governed run. The default now equals the raw scan's content budget, and
  // a file beyond it is still refused rather than read in part.
  it("reads a stage file up to the raw scan's content budget and refuses one beyond it", async () => {
    writeFileSync(join(root, "lock.json"), Buffer.alloc(100 * 1024, 0x7b));
    const file = await readGitStageFile(root, "lock.json");
    expect(file.bytes.byteLength).toBe(100 * 1024);
    writeFileSync(join(root, "huge.bin"), Buffer.alloc(GIT_STAGE_FILE_MAX_BYTES + 1, 0x00));
    await expect(readGitStageFile(root, "huge.bin")).rejects.toThrow("git-stage-file-too-large");
  });

  // A file's size never fails an inspection: above the inline bound it is a handle (size and
  // identity) that is streamed in bounded chunks, whatever its size, and a change fails closed.
  it("inspects a file above the inline bound as a streamable handle, not an in-memory read", async () => {
    const bytes = Buffer.alloc(GIT_STAGE_FILE_MAX_BYTES + 5 * 1024 * 1024, 0x61);
    writeFileSync(join(root, "huge.bin"), bytes);
    writeFileSync(join(root, "small.txt"), "small\n");
    const small = await inspectGitStageFile(root, "small.txt");
    expect(isGitStageLargeFile(small)).toBe(false);
    const large = await inspectGitStageFile(root, "huge.bin");
    if (!isGitStageLargeFile(large)) throw new Error("expected a large handle");
    expect(large).toMatchObject({ path: "huge.bin", mode: "100644", size: bytes.length });
    let streamed = 0;
    let chunks = 0;
    await streamGitStageFile(root, large, {}, (chunk) => {
      streamed += chunk.byteLength;
      chunks += 1;
      expect(chunk.byteLength).toBeLessThanOrEqual(1024 * 1024);
    });
    expect(streamed).toBe(bytes.length);
    expect(chunks).toBeGreaterThan(1);
    expect(() => {
      assertGitStageFileUnchanged(root, large);
    }).not.toThrow();
  });

  it("fails closed with git-stage-file-changed when a large file changes or is swapped", async () => {
    writeFileSync(join(root, "huge.bin"), Buffer.alloc(200 * 1024, 0x61));
    const large = await inspectGitStageFile(root, "huge.bin");
    if (!isGitStageLargeFile(large)) throw new Error("expected a large handle");
    appendFileSync(join(root, "huge.bin"), "x");
    expect(() => {
      assertGitStageFileUnchanged(root, large);
    }).toThrow("git-stage-file-changed");
    await expect(streamGitStageFile(root, large, {}, () => undefined)).rejects.toThrow(
      "git-stage-file-changed",
    );
    const fresh = await inspectGitStageFile(root, "huge.bin");
    if (!isGitStageLargeFile(fresh)) throw new Error("expected a large handle");
    rmSync(join(root, "huge.bin"));
    symlinkSync("/etc/hosts", join(root, "huge.bin"));
    expect(() => {
      assertGitStageFileUnchanged(root, fresh);
    }).toThrow("git-stage-file-changed");
  });

  // A permanent refusal must not read as the transient `git-stage-file-changed` (which the model
  // retries): a directory or a hard-linked file above the inline bound can never be staged.
  it("names a non-regular or hard-linked entry above the inline bound with its own permanent code", async () => {
    mkdirSync(join(root, "folder"));
    await expect(inspectGitStageFile(root, "folder", { inlineMaxBytes: 0 })).rejects.toThrow(
      "git-stage-file-not-regular",
    );
    writeFileSync(join(root, "one.bin"), Buffer.alloc(100 * 1024, 0x61));
    linkSync(join(root, "one.bin"), join(root, "two.bin"));
    await expect(inspectGitStageFile(root, "one.bin")).rejects.toThrow(
      "git-stage-file-hard-linked",
    );
  });

  it("stops a streamed read at the next chunk once the signal is aborted", async () => {
    writeFileSync(join(root, "huge.bin"), Buffer.alloc(4 * 1024 * 1024, 0x61));
    const large = await inspectGitStageFile(root, "huge.bin");
    if (!isGitStageLargeFile(large)) throw new Error("expected a large handle");
    const controller = new AbortController();
    let chunks = 0;
    await expect(
      streamGitStageFile(root, large, { signal: controller.signal }, () => {
        chunks += 1;
        controller.abort();
      }),
    ).rejects.toThrow("git-stage-read-cancelled");
    expect(chunks).toBe(1);
  });

  // The staging write path keeps refusing a link that leaves the workspace; only the status read
  // (`symlinks: "read-only"`) compares the raw link bytes without following the target (#4491).
  it.each(["/etc/hosts", "../outside-target"])(
    "refuses staging a link to %s but reads its raw bytes in read-only mode",
    async (target) => {
      symlinkSync(target, join(root, "link"));
      await expect(readGitStageFile(root, "link")).rejects.toThrow();
      const file = await readGitStageFile(root, "link", { symlinks: "read-only" });
      expect(file.mode).toBe("120000");
      expect(Buffer.from(file.bytes).toString()).toBe(target);
    },
  );

  it("holds Git's own lock until the exact index transaction ends", async () => {
    const index = readFileSync(join(root, ".git/index"));
    await withGitIndexTransaction(
      root,
      (): Promise<boolean> => {
        expect(() => git(["add", "file"])).toThrow();
        return Promise.resolve(false);
      },
      (value) => value,
    );
    expect(readFileSync(join(root, ".git/index"))).toEqual(index);
    expect(existsSync(join(root, ".git/index.lock"))).toBe(false);
  });
  it("rechecks authority after asynchronous metadata validation before replacement", async () => {
    const index = readFileSync(join(root, ".git/index"));
    let checks = 0;
    await expect(
      withGitIndexTransaction(
        root,
        (): Promise<boolean> => Promise.resolve(true),
        () => ++checks === 1,
      ),
    ).rejects.toThrow("authority-denied");
    expect(readFileSync(join(root, ".git/index"))).toEqual(index);
  });
  it("accepts a genuine reciprocal managed worktree without widening metadata access", async () => {
    const workspace = join(root, "worktree");
    git(["worktree", "add", "-qb", "codex/task", workspace]);
    await expect(
      withGitIndexTransaction(
        workspace,
        (): Promise<boolean> => Promise.resolve(false),
        (value) => value,
      ),
    ).resolves.toBe(false);
    expect(git(["status", "--porcelain"], workspace)).toBe("");
  });
  it("refuses an index symlink and leaves its target untouched", async () => {
    const target = join(root, "target");
    writeFileSync(target, "private");
    rmSync(join(root, ".git/index"));
    symlinkSync(target, join(root, ".git/index"));
    await expect(
      withGitIndexTransaction(
        root,
        (): Promise<boolean> => Promise.resolve(true),
        (value) => value,
      ),
    ).rejects.toThrow("index-file-invalid");
    expect(readFileSync(target, "utf8")).toBe("private");
    expect(existsSync(join(root, ".git/index.lock"))).toBe(false);
  });
  it("refuses forged external Git metadata and escaping file parents", async () => {
    const outside = join(root, "outside");
    git(["init", "-q", outside]);
    const target = join(root, "linked");
    symlinkSync("/etc", target);
    await expect(readGitStageFile(root, "linked/passwd")).rejects.toThrow();
    const pointer = join(outside, ".git");
    rmSync(pointer, { recursive: true });
    writeFileSync(pointer, `gitdir: ${join(root, ".git")}\n`);
    await expect(
      withGitIndexTransaction(
        outside,
        (): Promise<boolean> => Promise.resolve(true),
        (value) => value,
      ),
    ).rejects.toThrow("metadata-unavailable");
  });
});

// A managed task worktree lives below the state directory's always-denied `.keiko` segment. The
// stage-file reader and the index transaction resolved the root through the plain node port, so
// the coding runtime's raw status read (and, one step later, its staging) were refused inside such a
// worktree (run 5, 2026-09-10). Both now take the port the prover bound to the root; the plain
// default keeps refusing the same root.
describe("a workspace root below an always-denied segment", () => {
  let base: string;
  let managed: string;
  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), "keiko-index-denied-")));
    managed = join(base, ".keiko", "ui", "task-workspaces", "repo_1", "ws_1");
    mkdirSync(managed, { recursive: true });
    git(["init", "-qb", "dev"], managed);
    git(["config", "user.name", "Test"], managed);
    git(["config", "user.email", "test@example.test"], managed);
    writeFileSync(join(managed, "file"), "base\n");
    git(["add", "file"], managed);
    git(["-c", "commit.gpgsign=false", "commit", "-qm", "base"], managed);
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it("refuses the plain port and reads the stage file through the owned-root port", async () => {
    await expect(readGitStageFile(managed, "file")).rejects.toBeInstanceOf(PathDeniedError);
    const fs = workspaceFsWithOwnedRootAuthority(nodeWorkspaceFs, managed);
    const file = await readGitStageFile(managed, "file", { fs });
    expect(file.mode).toBe("100644");
    expect(Buffer.from(file.bytes).toString("utf8")).toBe("base\n");
  });

  it("opens the index transaction only through the owned-root port", async () => {
    await expect(
      withGitIndexTransaction(
        managed,
        () => Promise.resolve(true),
        (result) => result,
      ),
    ).rejects.toThrow("git-index-metadata-unavailable");
    const fs = workspaceFsWithOwnedRootAuthority(nodeWorkspaceFs, managed);
    await expect(
      withGitIndexTransaction(
        managed,
        (transaction) => Promise.resolve(existsSync(transaction.temporaryIndexPath)),
        (result) => result,
        fs,
      ),
    ).resolves.toBe(true);
    expect(existsSync(join(managed, ".git", "index.lock"))).toBe(false);
  });
});
