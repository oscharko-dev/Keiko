import { execFileSync } from "node:child_process";
import {
  existsSync,
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
import { readGitStageFile, withGitIndexTransaction } from "./gitIndexTransaction.js";
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
