import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withGitPublishView as publishView, type GitPublishView } from "./gitPublishView.js";
import { isWithinWorkspace } from "./paths.js";

function withGitPublishView<T>(
  root: string,
  commit: string,
  privateRoot: string,
  publish: (view: GitPublishView) => Promise<T>,
): Promise<T> {
  return publishView(root, commit, publish, privateRoot);
}

let root: string;
let privateRoot: string;
function git(args: readonly string[], cwd = root): string {
  return execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      PATH: process.env.PATH,
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    },
  }).trim();
}
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-publish-metadata-")));
  privateRoot = realpathSync(mkdtempSync(join(tmpdir(), "keiko-publish-private-")));
  git(["init", "-qb", "dev"]);
  git(["config", "user.name", "Test"]);
  git(["config", "user.email", "test@example.test"]);
  writeFileSync(join(root, "file"), "verified\n");
  git(["add", "file"]);
  git(["-c", "commit.gpgsign=false", "commit", "-qm", "verified"]);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(privateRoot, { recursive: true, force: true });
});

describe("authorized private Git publish metadata", () => {
  it("holds effect metadata outside both the checkout and its original Git metadata", async () => {
    await withGitPublishView(root, git(["rev-parse", "HEAD"]), privateRoot, (view) => {
      expect(isWithinWorkspace(root, view.gitDirectory)).toBe(false);
      expect(isWithinWorkspace(privateRoot, view.gitDirectory)).toBe(true);
      return Promise.resolve();
    });
    await expect(
      withGitPublishView(root, git(["rev-parse", "HEAD"]), join(root, ".git"), () =>
        Promise.resolve(),
      ),
    ).rejects.toThrow("private-root-overlap");
  });
  it("detects changes to effect configuration in addition to directory replacement", async () => {
    await withGitPublishView(root, git(["rev-parse", "HEAD"]), privateRoot, (view) => {
      writeFileSync(
        join(view.gitDirectory, "config"),
        '[url "https://example.test"]\ninsteadOf = https://github.com\n',
      );
      expect(view.isCurrent()).toBe(false);
      return Promise.resolve();
    });
  });
  it("copies no live configuration or refs and cleans its private metadata after success", async () => {
    const commit = git(["rev-parse", "HEAD"]);
    const originalConfig = readFileSync(join(root, ".git/config"));
    let directory = "";
    await withGitPublishView(root, commit, privateRoot, (view) => {
      directory = view.gitDirectory;
      expect(view.isCurrent()).toBe(true);
      expect(view.objectDirectory).toBe(join(root, ".git/objects"));
      expect(readFileSync(join(directory, "HEAD"), "utf8")).toBe(`${commit}\n`);
      expect(readFileSync(join(directory, "config"), "utf8")).toBe(
        "[core]\nrepositoryFormatVersion = 0\nbare = true\n",
      );
      expect(existsSync(join(directory, "refs/heads/dev"))).toBe(false);
      return Promise.resolve();
    });
    expect(existsSync(directory)).toBe(false);
    expect(readFileSync(join(root, ".git/config"))).toEqual(originalConfig);
    expect(git(["rev-parse", "HEAD"])).toBe(commit);
  });

  it("supports the reciprocal linked-worktree object store and SHA-256 metadata", async () => {
    const worktree = join(root, "worktree");
    git(["worktree", "add", "-qb", "feature/task", worktree]);
    await withGitPublishView(
      worktree,
      git(["rev-parse", "HEAD"], worktree),
      privateRoot,
      (view) => {
        expect(view.objectDirectory).toBe(join(root, ".git/objects"));
        return Promise.resolve();
      },
    );
    await withGitPublishView(root, "a".repeat(64), privateRoot, (view) => {
      expect(readFileSync(join(view.gitDirectory, "config"), "utf8")).toContain(
        "objectFormat = sha256",
      );
      return Promise.resolve();
    });
  });

  it("copies only bounded full shallow identities without loading original config", async () => {
    const commit = git(["rev-parse", "HEAD"]);
    writeFileSync(join(root, ".git/shallow"), `${commit}\n`);
    await withGitPublishView(root, commit, privateRoot, (view) => {
      expect(readFileSync(join(view.gitDirectory, "shallow"), "utf8")).toBe(`${commit}\n`);
      return Promise.resolve();
    });
    writeFileSync(join(root, ".git/shallow"), "HEAD~1\n");
    await expect(
      withGitPublishView(root, commit, privateRoot, () => Promise.resolve()),
    ).rejects.toThrow("shallow-metadata-invalid");
  });

  it("cleans metadata on a failed effect and detects replacement before dispatch", async () => {
    const commit = git(["rev-parse", "HEAD"]);
    let directory = "";
    await expect(
      withGitPublishView(root, commit, privateRoot, (view) => {
        directory = view.gitDirectory;
        return Promise.reject(new Error("effect failed"));
      }),
    ).rejects.toThrow("effect failed");
    expect(existsSync(directory)).toBe(false);
    await withGitPublishView(root, commit, privateRoot, (view) => {
      renameSync(view.gitDirectory, `${view.gitDirectory}-moved`);
      expect(view.isCurrent()).toBe(false);
      return Promise.resolve();
    });
  });

  it("refuses symlinked objects, forged common metadata and revision expressions", async () => {
    const commit = git(["rev-parse", "HEAD"]);
    const objects = join(root, ".git/objects");
    renameSync(objects, `${objects}-moved`);
    symlinkSync(`${objects}-moved`, objects, "dir");
    await expect(
      withGitPublishView(root, commit, privateRoot, () => Promise.resolve()),
    ).rejects.toThrow("object-directory-invalid");
    rmSync(objects);
    renameSync(`${objects}-moved`, objects);
    writeFileSync(join(root, ".git/commondir"), "../outside\n");
    await expect(
      withGitPublishView(root, commit, privateRoot, () => Promise.resolve()),
    ).rejects.toThrow("common-directory-unsupported");
    await expect(
      withGitPublishView(root, "HEAD", privateRoot, () => Promise.resolve()),
    ).rejects.toThrow("commit-invalid");
  });
});
