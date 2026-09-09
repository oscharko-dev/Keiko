import { nodeSpawnFn } from "./exec.js";
import { readGitRawChanges } from "./git-raw-worktree-node.js";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
  readFileSync,
  symlinkSync,
  chmodSync,
  unlinkSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import {
  createNodeGitMutationAdapter,
  readGitWorktreeSnapshot,
  readGitTreeDigest,
} from "./git-mutation-node.js";
import type { GitCommitExecRequest } from "./git-mutation-adapter.js";

let root: string;
let workspace: WorkspaceInfo;
const git = (args: readonly string[]): string =>
  execFileSync("git", [...args], {
    cwd: root,
    encoding: "utf8",
    env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  }).trim();

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-verified-commit-")));
  git(["init", "-q", "-b", "dev"]);
  git(["config", "user.name", "Keiko Test"]);
  git(["config", "user.email", "keiko@example.test"]);
  writeFileSync(join(root, "code.txt"), "base\n");
  git(["add", "code.txt"]);
  git(["commit", "-qm", "base"]);
  git(["checkout", "-qb", "codex/task"]);
  writeFileSync(join(root, "code.txt"), "verified\n");
  git(["add", "code.txt"]);
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
});

async function candidate(): Promise<
  GitCommitExecRequest & { readonly verified: NonNullable<GitCommitExecRequest["verified"]> }
> {
  const snapshot = await readGitWorktreeSnapshot({ workspace });
  if (snapshot.headSha === undefined || snapshot.stagedTreeDigest === undefined)
    throw new Error("missing candidate identity");
  return {
    message: "feat: exact verified tree",
    allowEmpty: false,
    verified: {
      headSha: snapshot.headSha,
      stagedTreeDigest: snapshot.stagedTreeDigest,
      branchName: "codex/task",
      baseRef: "dev",
      baseSha: git(["rev-parse", "dev"]),
    },
  };
}

function adapter(
  beforeCommitRefUpdate?: () => boolean,
): ReturnType<typeof createNodeGitMutationAdapter> {
  return createNodeGitMutationAdapter({
    workspace,
    processEnv: { PATH: process.env.PATH, HOME: root },
    beforeCommitRefUpdate,
  });
}

describe("verified commit at the sole mutation adapter", () => {
  it("rejects index movement while collecting immutable status metadata", async () => {
    let moved = false;
    const read = readGitRawChanges({
      workspace,
      spawn: (command, args, spawnOptions) => {
        if (!moved && args.includes("ls-tree")) {
          moved = true;
          writeFileSync(join(root, "code.txt"), "concurrent index\n");
          git(["add", "code.txt"]);
        }
        return nodeSpawnFn(command, args, spawnOptions);
      },
    });
    await expect(read).rejects.toThrow("git-raw-snapshot-drift");
  });
  it("does not execute repository clean filters during an agent-authorized stage", async () => {
    const approved = await candidate();
    const index = git(["write-tree"]);
    writeFileSync(
      join(root, "filter.cjs"),
      'require("node:fs").writeFileSync("filter-ran", "ran"); process.stdout.write("filtered");',
    );
    writeFileSync(join(root, ".gitattributes"), "*.txt filter=unsafe\n");
    git(["config", "filter.unsafe.clean", `"${process.execPath}" "${join(root, "filter.cjs")}"`]);
    writeFileSync(join(root, "code.txt"), "unstaged candidate\n");
    const request = { pathspecs: ["code.txt"], verified: approved.verified };
    expect((await adapter().stage(request)).outcome).toBe("failed");
    expect(git(["write-tree"])).toBe(index);
    expect(() => readFileSync(join(root, "filter-ran"))).toThrow();
  });

  it("stages only exact selected raw bytes and preserves unrelated index entries", async () => {
    const approved = await candidate();
    writeFileSync(join(root, "code.txt"), "selected raw bytes\n");
    writeFileSync(join(root, "other.txt"), "untracked remains\n");
    const result = await adapter().stage({ pathspecs: ["code.txt"], verified: approved.verified });
    expect(result.outcome).toBe("succeeded");
    expect(git(["show", ":code.txt"])).toBe("selected raw bytes");
    expect(git(["ls-files", "--", "other.txt"])).toBe("");
    expect(existsSync(join(root, ".git/index.lock"))).toBe(false);
  });
  it("stages binary bytes, executable mode, and a contained symlink without executing helpers", async () => {
    const approved = await candidate();
    writeFileSync(join(root, "binary.dat"), Buffer.from([0, 255, 128, 1]));
    writeFileSync(join(root, "script.sh"), "safe text\n");
    chmodSync(join(root, "script.sh"), 0o755);
    symlinkSync("code.txt", join(root, "link"));
    expect(
      (
        await adapter().stage({
          pathspecs: ["binary.dat", "script.sh", "link"],
          verified: approved.verified,
        })
      ).outcome,
    ).toBe("succeeded");
    expect(git(["ls-files", "--stage", "--", "script.sh"])).toMatch(/^100755 /u);
    expect(git(["ls-files", "--stage", "--", "link"])).toMatch(/^120000 /u);
    expect(execFileSync("git", ["show", ":binary.dat"], { cwd: root })).toEqual(
      Buffer.from([0, 255, 128, 1]),
    );
  });
  it("stages a tracked deletion while preserving other index content", async () => {
    const approved = await candidate();
    unlinkSync(join(root, "code.txt"));
    expect(
      (await adapter().stage({ pathspecs: ["code.txt"], verified: approved.verified })).outcome,
    ).toBe("succeeded");
    expect(git(["ls-files", "--", "code.txt"])).toBe("");
  });
  it("refuses a concurrent index lock and preserves its owner", async () => {
    const approved = await candidate();
    writeFileSync(join(root, ".git/index.lock"), "another owner");
    expect(
      (await adapter().stage({ pathspecs: ["code.txt"], verified: approved.verified })).outcome,
    ).toBe("failed");
    expect(readFileSync(join(root, ".git/index.lock"), "utf8")).toBe("another owner");
  });
  it("refuses changed approved index and escaped symlink operands before any index write", async () => {
    const approved = await candidate();
    const index = git(["write-tree"]);
    symlinkSync("/etc/passwd", join(root, "escape"));
    expect(
      (await adapter().stage({ pathspecs: ["escape"], verified: approved.verified })).outcome,
    ).toBe("failed");
    expect(git(["write-tree"])).toBe(index);
    writeFileSync(join(root, "code.txt"), "different index\n");
    git(["add", "code.txt"]);
    expect(
      (await adapter().stage({ pathspecs: ["code.txt"], verified: approved.verified })).outcome,
    ).toBe("failed");
  });
  it("refuses required repository signing instead of committing an unsigned object", async () => {
    const request = await candidate();
    git(["config", "commit.gpgsign", "true"]);
    git(["config", "gpg.program", "/keiko/missing-signing-program"]);
    const result = await adapter().commit(request);
    expect(result.outcome).toBe("failed");
    expect(git(["rev-parse", "HEAD"])).toBe(request.verified.headSha);
  });
  it("commits the approved tree and returns its exact SHA while preserving unrelated files", async () => {
    const request = await candidate();
    writeFileSync(join(root, "unrelated.txt"), "keep me\n");
    const result = await adapter().commit(request);
    expect(result.outcome).toBe("succeeded");
    expect(result.externalId).toBe(git(["rev-parse", "HEAD"]));
    expect(git(["rev-parse", "HEAD^"])).toBe(request.verified.headSha);
    expect(await readGitTreeDigest({ workspace }, result.externalId ?? "")).toBe(
      request.verified.stagedTreeDigest,
    );
    expect(readFileSync(join(root, "unrelated.txt"), "utf8")).toBe("keep me\n");
  });
  it("refuses a changed candidate without changing HEAD", async () => {
    const request = await candidate();
    writeFileSync(join(root, "code.txt"), "unverified\n");
    git(["add", "code.txt"]);
    expect((await adapter().commit(request)).outcome).toBe("failed");
    expect(git(["rev-parse", "HEAD"])).toBe(request.verified.headSha);
  });
  it("cannot include changes staged during the final effect boundary", async () => {
    const request = await candidate();
    let checks = 0;
    const result = await adapter(() => {
      checks += 1;
      if (checks === 3) {
        writeFileSync(join(root, "unrelated.txt"), "concurrent\n");
        git(["add", "unrelated.txt"]);
      }
      return true;
    }).commit(request);
    expect(result.outcome).toBe("succeeded");
    expect(git(["ls-tree", "--name-only", "HEAD"])).toBe("code.txt");
    expect(git(["diff", "--cached", "--name-only"])).toBe("unrelated.txt");
  });
  it("revocation at the final boundary has no branch effect", async () => {
    const request = await candidate();
    let checks = 0;
    const result = await adapter(() => ++checks < 3).commit(request);
    expect(result.outcome).toBe("failed");
    expect(git(["rev-parse", "HEAD"])).toBe(request.verified.headSha);
  });
  it("atomically refuses base movement during the last authority check", async () => {
    const request = await candidate();
    const other = git([
      "commit-tree",
      git(["write-tree"]),
      "-p",
      git(["rev-parse", "HEAD"]),
      "-m",
      "different base",
    ]);
    let checks = 0;
    const result = await adapter(() => {
      if (++checks === 3) git(["update-ref", "refs/heads/dev", other]);
      return true;
    }).commit(request);
    expect(result.outcome).toBe("failed");
    expect(git(["rev-parse", "HEAD"])).toBe(request.verified.headSha);
  });
});
