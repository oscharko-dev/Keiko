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
  linkSync,
  unlinkSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { plantSymlinkOrSkip } from "../../../tests/support/symlink-fixture.js";
import type { WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import {
  createNodeGitMutationAdapter,
  readGitWorktreeSnapshot,
  readGitTreeDigest,
  readGitHeadState,
  readGitIndexTreeDigest,
} from "./git-mutation-node.js";
import { gitZeroObjectId, type GitHeadState } from "./git-head-state.js";
import type {
  GitCommitExecRequest,
  GitVerifiedCommitPrecondition,
} from "./git-mutation-adapter.js";

let root: string;
let signingRoot: string;
let workspace: WorkspaceInfo;
const git = (args: readonly string[]): string =>
  execFileSync("git", [...args], {
    cwd: root,
    encoding: "utf8",
    env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  }).trim();

function configureSshCommitSigning(email: string): void {
  const keyPath = join(signingRoot, "keiko-test-signing-key");
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", email, "-f", keyPath], {
    cwd: signingRoot,
  });
  const publicKeyPath = `${keyPath}.pub`;
  const publicKey = readFileSync(publicKeyPath, "utf8").trim();
  const allowedSigners = join(signingRoot, "keiko-test-allowed-signers");
  writeFileSync(allowedSigners, `${email} ${publicKey}\n`, "utf8");
  git(["config", "gpg.format", "ssh"]);
  git(["config", "gpg.ssh.allowedSignersFile", allowedSigners]);
  git(["config", "user.signingkey", publicKeyPath]);
  git(["config", "commit.gpgsign", "true"]);
}

function expectLastCommitSigned(): void {
  expect(git(["log", "-1", "--format=%G?"])).toBe("G");
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-verified-commit-")));
  signingRoot = realpathSync(mkdtempSync(join(tmpdir(), "keiko-verified-signing-")));
  git(["init", "-q", "-b", "dev"]);
  // The adapter's Git reads the host's SYSTEM scope, and Git for Windows sets `core.autocrlf=true`
  // there. Exact staging is refused while a conversion is in effect, so the fixture repository
  // declares its own line-ending policy instead of inheriting the host's.
  git(["config", "core.autocrlf", "false"]);
  git(["config", "user.name", "Keiko Test"]);
  git(["config", "user.email", "keiko@example.test"]);
  configureSshCommitSigning("keiko@example.test");
  writeFileSync(join(root, "code.txt"), "base\n");
  git(["add", "code.txt"]);
  git(["commit", "-qm", "base"]);
  expectLastCommitSigned();
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
  rmSync(signingRoot, { recursive: true, force: true });
});

function bornSha(head: GitHeadState): string {
  if (head.kind !== "born") throw new Error("expected a born head");
  return head.sha;
}

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
      head: { kind: "born", sha: snapshot.headSha },
      stagedTreeDigest: snapshot.stagedTreeDigest,
      branchName: "codex/task",
      baseRef: "dev",
      base: { kind: "born", sha: git(["rev-parse", "dev"]) },
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

function requiredAdapter(): ReturnType<typeof createNodeGitMutationAdapter> {
  return createNodeGitMutationAdapter({
    workspace,
    processEnv: { PATH: process.env.PATH, HOME: root },
    signingRequiredByBranchProtection: () => Promise.resolve(true),
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
  // The governed spawn boundary bounds a command's stdin at 64 KiB, so a file above it travels by
  // path, never on stdin and never in memory. Owner decision 2026-11-24: no size ends healthy work.
  it("stages files above the stdin bound and above the old 8 MiB read bound through the governed lane", async () => {
    const approved = await candidate();
    writeFileSync(join(root, "mid.bin"), Buffer.alloc(200 * 1024, 0x6d));
    writeFileSync(join(root, "huge.bin"), Buffer.alloc(9 * 1024 * 1024, 0x68));
    const result = await adapter().stage({
      pathspecs: ["mid.bin", "huge.bin"],
      verified: approved.verified,
    });
    expect(result.outcome).toBe("succeeded");
    for (const path of ["mid.bin", "huge.bin"])
      expect(git(["rev-parse", `:${path}`])).toBe(git(["hash-object", "--no-filters", path]));
    expect(existsSync(join(root, ".git/index.lock"))).toBe(false);
  });
  it("refuses a large hard-linked file at the adapter, with no digest to bind it, and changes nothing", async () => {
    const approved = await candidate();
    writeFileSync(join(root, "linked.bin"), Buffer.alloc(200 * 1024, 0x6c));
    linkSync(join(root, "linked.bin"), join(root, "second-name.bin"));
    const index = git(["write-tree"]);
    const result = await adapter().stage({
      pathspecs: ["linked.bin"],
      verified: approved.verified,
    });
    expect(result.outcome).toBe("failed");
    expect(git(["write-tree"])).toBe(index);
    expect(existsSync(join(root, ".git/index.lock"))).toBe(false);
  });
  // Windows has no executable bit (and this host class cannot create the symlink), so the full
  // mode-preserving case runs unchanged on POSIX only; the binary-bytes half also runs below on
  // every host.
  it.skipIf(process.platform === "win32")(
    "stages binary bytes, executable mode, and a contained symlink without executing helpers",
    async () => {
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
    },
  );
  it("stages binary bytes and a regular-mode file without executing helpers", async () => {
    const approved = await candidate();
    writeFileSync(join(root, "binary.dat"), Buffer.from([0, 255, 128, 1]));
    writeFileSync(join(root, "script.sh"), "safe text\n");
    expect(
      (
        await adapter().stage({
          pathspecs: ["binary.dat", "script.sh"],
          verified: approved.verified,
        })
      ).outcome,
    ).toBe("succeeded");
    expect(git(["ls-files", "--stage", "--", "script.sh"])).toMatch(/^100644 /u);
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
  it("refuses a changed approved index before any index write", async () => {
    const approved = await candidate();
    writeFileSync(join(root, "code.txt"), "different index\n");
    git(["add", "code.txt"]);
    const index = git(["write-tree"]);
    expect(
      (await adapter().stage({ pathspecs: ["code.txt"], verified: approved.verified })).outcome,
    ).toBe("failed");
    expect(git(["write-tree"])).toBe(index);
  });
  it("refuses changed approved index and escaped symlink operands before any index write", async (context) => {
    const approved = await candidate();
    const index = git(["write-tree"]);
    plantSymlinkOrSkip(context, "/etc/passwd", join(root, "escape"));
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
  it("refuses a broken signing key instead of committing an unsigned object", async () => {
    const request = await candidate();
    git(["config", "user.signingkey", join(root, "missing-key.pub")]);
    const result = await adapter().commit(request);
    expect(result.outcome).toBe("failed");
    expect(result.errorCode).toBe("signature-failed");
    expect(result.signing).toBe("configured");
    expect(git(["rev-parse", "HEAD"])).toBe(bornSha(request.verified.head));
  });
  it("signs the verified commit and reports `configured` while commit.gpgsign is on", async () => {
    const result = await adapter().commit(await candidate());
    expect(result.outcome).toBe("succeeded");
    expect(result.signing).toBe("configured");
    expectLastCommitSigned();
  });
  it("creates an unsigned verified commit, as Git would, when commit.gpgsign is not set", async () => {
    git(["config", "--unset", "commit.gpgsign"]);
    const request = await candidate();
    const result = await adapter().commit(request);
    expect(result.outcome).toBe("succeeded");
    expect(result.signing).toBe("not-configured");
    expect(result.externalId).toBe(git(["rev-parse", "HEAD"]));
    expect(git(["rev-parse", "HEAD^"])).toBe(bornSha(request.verified.head));
    expect(git(["log", "-1", "--format=%G?"])).toBe("N");
  });
  it("creates an unsigned verified commit when commit.gpgsign is false", async () => {
    git(["config", "commit.gpgsign", "false"]);
    const result = await adapter().commit(await candidate());
    expect(result.outcome).toBe("succeeded");
    expect(result.signing).toBe("not-configured");
    expect(git(["log", "-1", "--format=%G?"])).toBe("N");
  });
  it("signs the verified commit when commit.gpgsign is unset but branch protection requires it", async () => {
    git(["config", "--unset", "commit.gpgsign"]);
    const result = await requiredAdapter().commit(await candidate());
    expect(result.outcome).toBe("succeeded");
    expect(result.signing).toBe("required-by-branch-protection");
    expectLastCommitSigned();
  });
  it("fails visibly when a required verified signature cannot be made", async () => {
    git(["config", "--unset", "commit.gpgsign"]);
    git(["config", "user.signingkey", join(root, "missing-key.pub")]);
    const request = await candidate();
    const result = await requiredAdapter().commit(request);
    expect(result.outcome).toBe("failed");
    expect(result.errorCode).toBe("signature-failed");
    expect(result.signing).toBe("required-by-branch-protection");
    expect(git(["rev-parse", "HEAD"])).toBe(bornSha(request.verified.head));
  });
  it("still signs the verified commit when commit.gpgsign is malformed (fail closed)", async () => {
    git(["config", "commit.gpgsign", "maybe"]);
    const result = await adapter().commit(await candidate());
    expect(result.signing).toBe("unknown-fail-closed");
    expect(result.outcome).toBe("succeeded");
    expectLastCommitSigned();
  });
  it("commits the approved tree and returns its exact SHA while preserving unrelated files", async () => {
    const request = await candidate();
    writeFileSync(join(root, "unrelated.txt"), "keep me\n");
    const result = await adapter().commit(request);
    expect(result.outcome).toBe("succeeded");
    expect(result.externalId).toBe(git(["rev-parse", "HEAD"]));
    expect(git(["rev-parse", "HEAD^"])).toBe(bornSha(request.verified.head));
    expect(await readGitTreeDigest({ workspace }, result.externalId ?? "")).toBe(
      request.verified.stagedTreeDigest,
    );
    expect(readFileSync(join(root, "unrelated.txt"), "utf8")).toBe("keep me\n");
    expectLastCommitSigned();
  });
  it("refuses a changed candidate without changing HEAD", async () => {
    const request = await candidate();
    writeFileSync(join(root, "code.txt"), "unverified\n");
    git(["add", "code.txt"]);
    expect((await adapter().commit(request)).outcome).toBe("failed");
    expect(git(["rev-parse", "HEAD"])).toBe(bornSha(request.verified.head));
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
    expect(git(["rev-parse", "HEAD"])).toBe(bornSha(request.verified.head));
  });
  // #3907 AC3: a human who checks out the task branch locally gives the run that branch as its own
  // base. Git refuses a ref transaction that both verifies and updates one ref, so the governed
  // commit used to fail after creating its signed object, and the run could never commit.
  it("commits on a branch that is its own base", async () => {
    const request = await candidate();
    const ownBase = {
      ...request,
      verified: { ...request.verified, baseRef: "codex/task", base: request.verified.head },
    };
    const result = await adapter().commit(ownBase);
    expect(result.outcome).toBe("succeeded");
    expect(result.externalId).toBe(git(["rev-parse", "HEAD"]));
    expect(git(["rev-parse", "HEAD^"])).toBe(bornSha(request.verified.head));
    expectLastCommitSigned();
  });
  it("atomically refuses movement of a branch that is its own base", async () => {
    const request = await candidate();
    const ownBase = {
      ...request,
      verified: { ...request.verified, baseRef: "codex/task", base: request.verified.head },
    };
    const other = git([
      "commit-tree",
      git(["write-tree"]),
      "-p",
      git(["rev-parse", "HEAD"]),
      "-m",
      "concurrent branch movement",
    ]);
    let checks = 0;
    const result = await adapter(() => {
      if (++checks === 3) git(["update-ref", "refs/heads/codex/task", other]);
      return true;
    }).commit(ownBase);
    expect(result.outcome).toBe("failed");
    expect(git(["rev-parse", "HEAD"])).toBe(other);
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
    expect(git(["rev-parse", "HEAD"])).toBe(bornSha(request.verified.head));
  });
});

// #4491: a fresh repository has an unborn HEAD. Its first commit is a root commit created without a
// parent and published with the all-zero old value, so a branch that appears meanwhile loses the race
// instead of being overwritten. `checkout --orphan` keeps the fixture's index and gives that state.
describe("the first commit of an unborn branch at the sole mutation adapter", () => {
  async function unbornPrecondition(): Promise<GitVerifiedCommitPrecondition> {
    const head = await readGitHeadState({ workspace });
    if (head.kind !== "unborn") throw new Error("expected an unborn head");
    return {
      head,
      stagedTreeDigest: await readGitIndexTreeDigest({ workspace }),
      branchName: "fresh",
      baseRef: "fresh",
      base: head,
    };
  }
  async function unbornCandidate(): Promise<
    GitCommitExecRequest & { readonly verified: GitVerifiedCommitPrecondition }
  > {
    return {
      message: "feat: the first commit",
      allowEmpty: false,
      verified: await unbornPrecondition(),
    };
  }
  beforeEach(() => {
    git(["checkout", "-q", "--orphan", "fresh"]);
  });

  it("re-points HEAD at a new unborn branch, writing no object and keeping the index", async () => {
    const before = git(["ls-files", "--stage"]);
    const result = await adapter().createBranch({
      branchName: "feature/first",
      startPointRefHash: gitZeroObjectId(40),
      fromUnbornBranch: "fresh",
    });
    expect(result.outcome).toBe("succeeded");
    expect(git(["symbolic-ref", "HEAD"])).toBe("refs/heads/feature/first");
    expect(git(["ls-files", "--stage"])).toBe(before);
    expect(await readGitHeadState({ workspace })).toEqual({
      kind: "unborn",
      branch: "feature/first",
      objectIdLength: 40,
    });
  });
  it("refuses the re-point when HEAD no longer names the unborn branch or the name exists", async () => {
    const stale = await adapter().createBranch({
      branchName: "feature/first",
      startPointRefHash: gitZeroObjectId(40),
      fromUnbornBranch: "other",
    });
    expect(stale.outcome).not.toBe("succeeded");
    const taken = await adapter().createBranch({
      branchName: "dev",
      startPointRefHash: gitZeroObjectId(40),
      fromUnbornBranch: "fresh",
    });
    expect(taken.outcome).not.toBe("succeeded");
    expect(git(["symbolic-ref", "HEAD"])).toBe("refs/heads/fresh");
  });
  // A first commit made by another process just before the re-point must never be skipped over: the
  // old and the new branch are locked from the proof to the write, so the other commit fails on
  // Git's own lock instead of landing on a branch HEAD is about to leave.
  it("holds the old and new branch locks from the proof to the write", async () => {
    let attempt: { readonly threw: boolean } | undefined;
    const racing = createNodeGitMutationAdapter({
      workspace,
      processEnv: { PATH: process.env.PATH, HOME: root },
      spawn: (command, args, options) => {
        if (args.includes("symbolic-ref") && attempt === undefined) {
          let threw = false;
          try {
            git(["commit", "-qm", "external first commit"]);
          } catch {
            threw = true;
          }
          attempt = { threw };
        }
        return nodeSpawnFn(command, args, options);
      },
    });
    const result = await racing.createBranch({
      branchName: "feature/first",
      startPointRefHash: gitZeroObjectId(40),
      fromUnbornBranch: "fresh",
    });
    expect(result.outcome).toBe("succeeded");
    expect(attempt?.threw).toBe(true);
    expect(existsSync(join(root, ".git", "refs", "heads", "fresh"))).toBe(false);
    expect(existsSync(join(root, ".git", "refs", "heads", "fresh.lock"))).toBe(false);
    expect(git(["symbolic-ref", "HEAD"])).toBe("refs/heads/feature/first");
  });
  it("writes nothing when another writer already holds a lock on the old branch", async () => {
    const lock = join(root, ".git", "refs", "heads", "fresh.lock");
    writeFileSync(lock, "");
    const result = await adapter().createBranch({
      branchName: "feature/first",
      startPointRefHash: gitZeroObjectId(40),
      fromUnbornBranch: "fresh",
    });
    expect(result.outcome).toBe("failed");
    expect(git(["symbolic-ref", "HEAD"])).toBe("refs/heads/fresh");
    // The foreign lock is not ours to remove.
    expect(existsSync(lock)).toBe(true);
  });
  it("reads the orphan branch as an explicit unborn state", async () => {
    const head: GitHeadState = await readGitHeadState({ workspace });
    expect(head).toEqual({ kind: "unborn", branch: "fresh", objectIdLength: 40 });
  });
  it("creates a signed root commit with no parent and the reviewed tree", async () => {
    const request = await unbornCandidate();
    const result = await adapter().commit(request);
    expect(result.outcome).toBe("succeeded");
    expect(result.externalId).toBe(git(["rev-parse", "HEAD"]));
    expect(git(["rev-list", "--parents", "-n", "1", "HEAD"])).toBe(git(["rev-parse", "HEAD"]));
    expect(await readGitTreeDigest({ workspace }, result.externalId ?? "")).toBe(
      request.verified.stagedTreeDigest,
    );
    expectLastCommitSigned();
  });
  it("loses the race to a branch created while the commit object is being prepared", async () => {
    const request = await unbornCandidate();
    const other = git(["commit-tree", git(["write-tree"]), "-m", "concurrent root"]);
    let checks = 0;
    const result = await adapter(() => {
      if (++checks === 3) git(["update-ref", "refs/heads/fresh", other]);
      return true;
    }).commit(request);
    expect(result.outcome).toBe("failed");
    expect(git(["rev-parse", "HEAD"])).toBe(other);
  });
  it("refuses an unborn review once the branch exists", async () => {
    const request = await unbornCandidate();
    const dev = git(["rev-parse", "dev"]);
    git(["update-ref", "refs/heads/fresh", dev]);
    const result = await adapter().commit(request);
    expect(result.outcome).toBe("failed");
    expect(git(["rev-parse", "HEAD"])).toBe(dev);
  });
  it("refuses a born review against a branch that is unborn", async () => {
    const request = await unbornCandidate();
    const born = {
      ...request,
      verified: {
        ...request.verified,
        head: { kind: "born", sha: git(["rev-parse", "dev"]) } as const,
      },
    };
    expect((await adapter().commit(born)).outcome).toBe("failed");
    expect(() => git(["rev-parse", "--verify", "--quiet", "refs/heads/fresh"])).toThrow();
  });
  it("stages exact files into the empty index of an unborn branch", async () => {
    git(["rm", "-q", "--cached", "code.txt"]);
    const verified = await unbornPrecondition();
    const result = await adapter().stage({ pathspecs: ["code.txt"], verified });
    expect(result.outcome).toBe("succeeded");
    expect(git(["ls-files", "--stage", "code.txt"])).toContain("code.txt");
  });
  it("refuses to stage when the unborn branch was born after the review", async () => {
    git(["rm", "-q", "--cached", "code.txt"]);
    const verified = await unbornPrecondition();
    git(["update-ref", "refs/heads/fresh", git(["rev-parse", "dev"])]);
    const result = await adapter().stage({ pathspecs: ["code.txt"], verified });
    expect(result.outcome).toBe("failed");
  });
});

// A repository in SHA-256 object format: the zero old value of the ref transaction is 64 characters.
// Detected by asking the installed Git to create one, never by its version string.
const sha256Supported = ((): boolean => {
  const probe = mkdtempSync(join(tmpdir(), "keiko-sha256-probe-"));
  try {
    execFileSync("git", ["init", "-q", "--object-format=sha256", probe], {
      env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
    });
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
})();

describe.skipIf(!sha256Supported)("the first commit of an unborn SHA-256 branch", () => {
  beforeEach(() => {
    rmSync(join(root, ".git"), { recursive: true, force: true });
    git(["init", "-q", "-b", "fresh", "--object-format=sha256"]);
    git(["config", "user.name", "Keiko Test"]);
    git(["config", "user.email", "keiko@example.test"]);
    git(["config", "core.autocrlf", "false"]);
    rmSync(signingRoot, { recursive: true, force: true });
    signingRoot = realpathSync(mkdtempSync(join(tmpdir(), "keiko-sha256-signing-")));
    configureSshCommitSigning("keiko@example.test");
    writeFileSync(join(root, "code.txt"), "sha256\n");
    git(["add", "code.txt"]);
  });
  async function precondition(): Promise<GitVerifiedCommitPrecondition> {
    const head = await readGitHeadState({ workspace });
    expect(head).toEqual({ kind: "unborn", branch: "fresh", objectIdLength: 64 });
    return {
      head,
      stagedTreeDigest: await readGitIndexTreeDigest({ workspace }),
      branchName: "fresh",
      baseRef: "fresh",
      base: head,
    };
  }
  it("creates a 64-character root commit with no parent", async () => {
    const result = await adapter().commit({
      message: "feat: sha256 root",
      allowEmpty: false,
      verified: await precondition(),
    });
    expect(result.outcome).toBe("succeeded");
    expect(git(["rev-parse", "HEAD"])).toMatch(/^[a-f0-9]{64}$/u);
    expect(git(["rev-list", "--parents", "-n", "1", "HEAD"])).toBe(git(["rev-parse", "HEAD"]));
  });
  it("loses the compare-and-swap against a branch created meanwhile", async () => {
    const verified = await precondition();
    const other = git(["commit-tree", git(["write-tree"]), "-m", "concurrent root"]);
    let checks = 0;
    const result = await adapter(() => {
      if (++checks === 3) git(["update-ref", "refs/heads/fresh", other]);
      return true;
    }).commit({ message: "feat: sha256 root", allowEmpty: false, verified });
    expect(result.outcome).toBe("failed");
    expect(git(["rev-parse", "HEAD"])).toBe(other);
    expect(gitZeroObjectId(64)).toMatch(/^0{64}$/u);
  });
});

// Operands that contradict each other never reach Git: no process is spawned for them.
describe("verified operands that contradict each other", () => {
  const unborn = { kind: "unborn", branch: "fresh", objectIdLength: 40 } as const;
  const born = { kind: "born", sha: "a".repeat(40) } as const;
  const cases: readonly (readonly [string, Partial<GitVerifiedCommitPrecondition>])[] = [
    ["an unborn head of another branch", { head: { ...unborn, branch: "other" }, base: unborn }],
    ["an unborn base that is not the branch", { head: unborn, base: unborn, baseRef: "dev" }],
    ["an unborn base under a born head", { head: born, base: unborn }],
    ["an unborn head with a unsafe branch name", { head: { ...unborn, branch: "-x" } }],
    ["a born head with a malformed sha", { head: { kind: "born", sha: "zz" } }],
  ];
  it.each(cases)("refuses %s before any Git process starts", async (_name, override) => {
    let spawns = 0;
    const counting = createNodeGitMutationAdapter({
      workspace,
      processEnv: { PATH: process.env.PATH, HOME: root },
      spawn: (command, args, options) => {
        spawns += 1;
        return nodeSpawnFn(command, args, options);
      },
    });
    const verified: GitVerifiedCommitPrecondition = {
      head: unborn,
      base: unborn,
      stagedTreeDigest: "a".repeat(64),
      branchName: "fresh",
      baseRef: "fresh",
      ...override,
    };
    const result = await counting.commit({ message: "feat: x", allowEmpty: false, verified });
    expect(result.outcome).toBe("failed");
    expect(spawns).toBe(0);
  });
});
