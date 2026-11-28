// Integration coverage for the Node governed Git mutation adapter (Issue #472) — AC3/AC5.
// Exercises the real spawn boundary against a disposable, hermetic git repository: governed local
// mutations actually run through `git` with the dedicated allowlist, and failures map to structured
// results without any string parsing. The suites that pass no HOME use local repo config only, so no
// global git state is read or written and the run is deterministic. The final suite drives the
// identity lane on purpose, against a DISPOSABLE HOME it creates itself — never the developer's.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync, type ChildProcess } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  readdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import type {
  GitDeliveryRepoPolicyPack,
  GitDeliveryApprovalRequirement,
} from "@oscharko-dev/keiko-contracts";
import { GIT_DELIVERY_POLICY_SCHEMA_VERSION } from "@oscharko-dev/keiko-contracts/runtime/git-delivery-policy";
import type { WorkspaceFs, WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import {
  createGitReadSession,
  createNodeGitMutationAdapter,
  type GitCleanupIncompleteReport,
  readGitStageSupport,
  type GitStageSupport,
} from "./git-mutation-node.js";
import { nodeSpawnFn, type SpawnFn } from "./exec.js";
import type {
  GitLocalMutationAdapter,
  GitVerifiedCommitPrecondition,
} from "./git-mutation-adapter.js";
import {
  readGitBlobTextsWithin,
  readGitBlobTextWithin,
  readGitIndexTreeDigest,
} from "./git-worktree-snapshot-node.js";
import type { GitWorktreeSnapshot } from "./git-mutation-preflight.js";
import { createInMemoryGitMutationJournal, runGitMutation } from "./git-mutation-orchestrator.js";

type GitDeliveryExecutionResultLike = Awaited<ReturnType<GitLocalMutationAdapter["commit"]>>;

let root: string;
let signingRoot: string;
let info: WorkspaceInfo;

function git(args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd: root, encoding: "utf8" });
}

function workspaceInfo(rootPath: string): WorkspaceInfo {
  return {
    root: rootPath,
    selectedRoot: rootPath,
    name: "demo",
    version: undefined,
    testFramework: "vitest",
    sourceDirs: ["src"],
    testDirs: ["tests"],
    languages: ["typescript"],
    ignoreLines: [],
  };
}

function adapter(): GitLocalMutationAdapter {
  // Only PATH is forwarded — deliberately NO HOME. The identity lane inherits HOME only when the
  // parent actually carries one, so with none present the spawn boundary falls back to the ephemeral
  // empty home and the commit identity comes from the repository's LOCAL config set in beforeEach —
  // never the developer's global git config. That keeps this suite hermetic.
  return createNodeGitMutationAdapter({
    workspace: info,
    processEnv: { PATH: process.env.PATH ?? "" },
    now: () => Date.now(),
  });
}

function configureSshCommitSigning(repoRoot: string, signingHome: string, email: string): void {
  const keyPath = join(signingHome, "keiko-test-signing-key");
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", email, "-f", keyPath], {
    cwd: signingHome,
  });
  const publicKeyPath = `${keyPath}.pub`;
  const publicKey = readFileSync(publicKeyPath, "utf8").trim();
  const allowedSigners = join(signingHome, "keiko-test-allowed-signers");
  writeFileSync(allowedSigners, `${email} ${publicKey}\n`, "utf8");
  execFileSync("git", ["config", "gpg.format", "ssh"], { cwd: repoRoot });
  execFileSync("git", ["config", "gpg.ssh.allowedSignersFile", allowedSigners], {
    cwd: repoRoot,
  });
  execFileSync("git", ["config", "user.signingkey", publicKeyPath], { cwd: repoRoot });
  execFileSync("git", ["config", "commit.gpgsign", "true"], { cwd: repoRoot });
}

function expectLastCommitSigned(repoRoot: string, home?: string): void {
  const env =
    home === undefined
      ? undefined
      : { PATH: process.env.PATH ?? "", HOME: home, GIT_CONFIG_NOSYSTEM: "1" };
  expect(
    execFileSync("git", ["-c", "gpg.ssh.program=ssh-keygen", "log", "-1", "--format=%G?"], {
      cwd: repoRoot,
      encoding: "utf8",
      ...(env === undefined ? {} : { env }),
    }).trim(),
  ).toBe("G");
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-git-mutation-")));
  signingRoot = realpathSync(mkdtempSync(join(tmpdir(), "keiko-git-signing-")));
  git(["init", "-q"]);
  git(["config", "user.email", "test@keiko.example"]);
  git(["config", "user.name", "Keiko Test"]);
  configureSshCommitSigning(root, signingRoot, "test@keiko.example");
  info = workspaceInfo(root);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(signingRoot, { recursive: true, force: true });
});

describe("node git mutation adapter — an interactive commit stays on the branch it was prepared for", () => {
  function preparedAdapter(
    branchName: string | undefined,
    whileDeciding: () => void,
  ): GitLocalMutationAdapter {
    return createNodeGitMutationAdapter({
      workspace: info,
      processEnv: { PATH: process.env.PATH ?? "" },
      now: () => Date.now(),
      preparedCheckout: { branchName },
      // The trusted branch-protection verdict is read asynchronously: the checkout moves meanwhile.
      signingRequiredByBranchProtection: (): Promise<boolean> => {
        whileDeciding();
        return Promise.resolve(false);
      },
    });
  }

  it("refuses the commit when the checkout moved to another branch while signing was decided", async () => {
    // Signing is not asked for by the person, so the branch-protection verdict decides.
    git(["config", "commit.gpgsign", "false"]);
    writeFileSync(join(root, "a.txt"), "hello\n", "utf8");
    const prepared = git(["branch", "--show-current"]).trim();
    const ad = preparedAdapter(prepared, () => {
      git(["checkout", "-q", "-b", "protected-branch"]);
    });
    expect((await ad.stage({ pathspecs: ["a.txt"] })).outcome).toBe("succeeded");

    const committed = await ad.commit({ message: "must not land", allowEmpty: false });

    expect(committed.outcome).toBe("failed");
    expect(git(["rev-list", "--count", "--all"]).trim()).toBe("0");
  });

  it("fails the commit when the checkout read throws after the decision", async () => {
    git(["config", "commit.gpgsign", "false"]);
    writeFileSync(join(root, "a.txt"), "hello\n", "utf8");
    // The checkout moves to a branch git accepts but the read refuses to name: only the read
    // fails, the commit itself would succeed on it, so a pass here would land a commit.
    const ad = preparedAdapter(git(["branch", "--show-current"]).trim(), () => {
      git(["checkout", "-q", "-b", "feature/ünsafe"]);
    });
    expect((await ad.stage({ pathspecs: ["a.txt"] })).outcome).toBe("succeeded");

    const committed = await ad.commit({ message: "must not land", allowEmpty: false });

    expect(committed.outcome).toBe("failed");
    expect(git(["rev-list", "--count", "--all"]).trim()).toBe("0");
  });

  it("moves only the prepared branch when the checkout switches right before the ref update", async () => {
    git(["config", "commit.gpgsign", "false"]);
    writeFileSync(join(root, "base.txt"), "base\n", "utf8");
    git(["add", "base.txt"]);
    git(["commit", "-q", "-m", "base"]);
    const prepared = git(["branch", "--show-current"]).trim();
    const baseSha = git(["rev-parse", "HEAD"]).trim();
    let authorizations = 0;
    const ad = createNodeGitMutationAdapter({
      workspace: info,
      processEnv: { PATH: process.env.PATH ?? "" },
      now: () => Date.now(),
      preparedCheckout: { branchName: prepared },
      // The last authorization check runs after the final checkout read and right before the ref
      // update: the checkout switches exactly there, past every read of the checkout.
      beforeCommitRefUpdate: (): boolean => {
        authorizations += 1;
        if (authorizations === 2) git(["checkout", "-q", "-b", "protected-branch"]);
        return true;
      },
    });
    writeFileSync(join(root, "a.txt"), "hello\n", "utf8");
    expect((await ad.stage({ pathspecs: ["a.txt"] })).outcome).toBe("succeeded");

    const committed = await ad.commit({ message: "bound", allowEmpty: false });

    expect(authorizations).toBe(2);
    expect(committed.outcome).toBe("succeeded");
    expect(git(["branch", "--show-current"]).trim()).toBe("protected-branch");
    // The commit and its signing decision belong to the prepared branch; the branch the checkout
    // moved to is untouched.
    expect(git(["rev-parse", `refs/heads/${prepared}~1`]).trim()).toBe(baseSha);
    expect(git(["log", "-1", "--format=%s", `refs/heads/${prepared}`]).trim()).toBe("bound");
    expect(git(["rev-parse", "refs/heads/protected-branch"]).trim()).toBe(baseSha);
  });

  it("commits the first commit of an unborn prepared branch", async () => {
    git(["config", "commit.gpgsign", "false"]);
    writeFileSync(join(root, "a.txt"), "hello\n", "utf8");
    const ad = preparedAdapter(git(["branch", "--show-current"]).trim(), () => undefined);
    expect((await ad.stage({ pathspecs: ["a.txt"] })).outcome).toBe("succeeded");

    expect((await ad.commit({ message: "root", allowEmpty: false })).outcome).toBe("succeeded");
    expect(git(["rev-list", "--count", "HEAD"]).trim()).toBe("1");
    expect(git(["log", "-1", "--format=%P"]).trim()).toBe("");
  });

  it("refuses an empty commit unless it is allowed", async () => {
    git(["config", "commit.gpgsign", "false"]);
    writeFileSync(join(root, "a.txt"), "hello\n", "utf8");
    git(["add", "a.txt"]);
    git(["commit", "-q", "-m", "base"]);
    const ad = preparedAdapter(git(["branch", "--show-current"]).trim(), () => undefined);

    expect((await ad.commit({ message: "nothing", allowEmpty: false })).outcome).toBe("failed");
    expect((await ad.commit({ message: "empty ok", allowEmpty: true })).outcome).toBe("succeeded");
    expect(git(["rev-list", "--count", "HEAD"]).trim()).toBe("2");
  });

  it.each(["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"])(
    "refuses a commit while %s is present",
    async (name) => {
      git(["config", "commit.gpgsign", "false"]);
      writeFileSync(join(root, "a.txt"), "hello\n", "utf8");
      git(["add", "a.txt"]);
      git(["commit", "-q", "-m", "base"]);
      const ad = preparedAdapter(git(["branch", "--show-current"]).trim(), () => undefined);
      writeFileSync(join(root, ".git", name), `${git(["rev-parse", "HEAD"]).trim()}\n`);

      expect((await ad.commit({ message: "mid", allowEmpty: true })).outcome).toBe("failed");
      expect(git(["rev-list", "--count", "HEAD"]).trim()).toBe("1");
    },
  );

  it("refuses the commit and writes nothing when the sequencer state cannot be read", async () => {
    git(["config", "commit.gpgsign", "false"]);
    writeFileSync(join(root, "a.txt"), "hello\n", "utf8");
    git(["add", "a.txt"]);
    git(["commit", "-q", "-m", "base"]);
    let failedReads = 0;
    const unreadable: WorkspaceFs = {
      ...nodeWorkspaceFs,
      // Only the sequencer-state read uses this port, so every resolution of it fails.
      realPath: () => {
        failedReads += 1;
        throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      },
    };
    const ad = createNodeGitMutationAdapter({
      workspace: info,
      processEnv: { PATH: process.env.PATH ?? "" },
      now: () => Date.now(),
      preparedCheckout: { branchName: git(["branch", "--show-current"]).trim() },
      metadataFs: unreadable,
    });
    const objectsBefore = git(["count-objects", "-v"]);

    const committed = await ad.commit({ message: "must not land", allowEmpty: true });

    expect(failedReads).toBeGreaterThan(0);
    expect(committed.outcome).toBe("failed");
    expect(committed.errorCode).toBe("precondition-failed");
    expect(git(["rev-list", "--count", "HEAD"]).trim()).toBe("1");
    expect(git(["count-objects", "-v"])).toBe(objectsBefore);
  });

  // The plumbing commit must record what `git commit` records: the same identity, the same dates
  // from the same environment and the same message bytes after Git's own cleanup.
  it.each([
    ["plain", "subject"],
    ["trailing blanks and tabs", "subject  \t\n\nbody line \n"],
    ["blank runs and edges", "\n\n  lead\n\n\n\nbody\r\n\n\n"],
    ["a carriage return line", "subject\r\n\r\nbody\r\n"],
    ["non-ASCII", "Änderung   \n\nKörper"],
  ])("records the same commit object as git commit for %s", async (_name, message) => {
    git(["config", "commit.gpgsign", "false"]);
    const env = {
      PATH: process.env.PATH ?? "",
      GIT_AUTHOR_NAME: "Author Env",
      GIT_AUTHOR_EMAIL: "author@env.example",
      GIT_AUTHOR_DATE: "2026-01-02T03:04:05Z",
      GIT_COMMITTER_NAME: "Committer Env",
      GIT_COMMITTER_EMAIL: "committer@env.example",
      GIT_COMMITTER_DATE: "2026-02-03T04:05:06Z",
    };
    const branch = git(["branch", "--show-current"]).trim();
    writeFileSync(join(root, "a.txt"), "hello\n", "utf8");
    const ad = createNodeGitMutationAdapter({
      workspace: info,
      processEnv: env,
      now: () => Date.now(),
      preparedCheckout: { branchName: branch },
    });
    expect((await ad.stage({ pathspecs: ["a.txt"] })).outcome).toBe("succeeded");
    expect((await ad.commit({ message, allowEmpty: false })).outcome).toBe("succeeded");
    const bound = git(["cat-file", "commit", "HEAD"]);

    git(["update-ref", "-d", `refs/heads/${branch}`]);
    // The reference is the plain `git commit` of the same adapter lane (no prepared checkout).
    const plain = createNodeGitMutationAdapter({
      workspace: info,
      processEnv: env,
      now: () => Date.now(),
    });
    expect((await plain.commit({ message, allowEmpty: false })).outcome).toBe("succeeded");

    // Dates come from the same lane; only a second boundary between the two runs may differ.
    const undated = (object: string): string => object.replace(/ \d+ [+-]\d{4}$/gmu, " <date>");
    expect(undated(bound)).toBe(undated(git(["cat-file", "commit", "HEAD"])));
  });

  it("signs the bound commit as git commit would, and fails closed when signing fails", async () => {
    writeFileSync(join(root, "a.txt"), "hello\n", "utf8");
    git(["add", "a.txt"]);
    git(["commit", "-q", "-m", "base"]);
    const ad = preparedAdapter(git(["branch", "--show-current"]).trim(), () => undefined);
    writeFileSync(join(root, "b.txt"), "more\n", "utf8");
    expect((await ad.stage({ pathspecs: ["b.txt"] })).outcome).toBe("succeeded");

    expect((await ad.commit({ message: "signed", allowEmpty: false })).outcome).toBe("succeeded");
    expectLastCommitSigned(root);

    const tip = git(["rev-parse", "HEAD"]).trim();
    git(["config", "user.signingkey", join(signingRoot, "missing-key.pub")]);
    writeFileSync(join(root, "c.txt"), "again\n", "utf8");
    expect((await ad.stage({ pathspecs: ["c.txt"] })).outcome).toBe("succeeded");

    expect((await ad.commit({ message: "unsignable", allowEmpty: false })).outcome).toBe("failed");
    expect(git(["rev-parse", "HEAD"]).trim()).toBe(tip);
  });

  it("commits on the prepared branch when the checkout did not move", async () => {
    writeFileSync(join(root, "a.txt"), "hello\n", "utf8");
    const ad = preparedAdapter(git(["branch", "--show-current"]).trim(), () => undefined);
    expect((await ad.stage({ pathspecs: ["a.txt"] })).outcome).toBe("succeeded");

    const committed = await ad.commit({ message: "lands", allowEmpty: false });

    expect(committed.outcome).toBe("succeeded");
    expect(git(["log", "--oneline"])).toContain("lands");
  });
});

describe("node git mutation adapter — the bound commit leaves the repository as git commit does", () => {
  const SCENARIO_ENV = { PATH: process.env.PATH ?? "" };
  let commitSequence = 0;
  const tempRepos: string[] = [];

  afterEach(() => {
    for (const repo of tempRepos.splice(0)) rmSync(repo, { recursive: true, force: true });
  });

  function gitIn(repo: string, args: readonly string[]): string {
    return execFileSync("git", [...args], { cwd: repo, encoding: "utf8" });
  }

  function newRepo(): string {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), "keiko-git-bound-")));
    tempRepos.push(repo);
    gitIn(repo, ["init", "-q", "-b", "main"]);
    gitIn(repo, ["config", "user.email", "test@keiko.example"]);
    gitIn(repo, ["config", "user.name", "Keiko Test"]);
    gitIn(repo, ["config", "commit.gpgsign", "false"]);
    return repo;
  }

  function adapterFor(
    repo: string,
    bound: boolean,
    extra: Partial<Parameters<typeof createNodeGitMutationAdapter>[0]> = {},
  ): GitLocalMutationAdapter {
    return createNodeGitMutationAdapter({
      workspace: workspaceInfo(repo),
      processEnv: SCENARIO_ENV,
      now: () => Date.now(),
      ...(bound ? { preparedCheckout: { branchName: "main" } } : {}),
      ...extra,
    });
  }

  function seedBase(repo: string): void {
    writeFileSync(join(repo, "base.txt"), "base\n", "utf8");
    gitIn(repo, ["add", "base.txt"]);
    gitIn(repo, ["commit", "-q", "-m", "base"]);
  }

  async function commitOn(
    repo: string,
    bound: boolean,
    message: string,
    extra: Partial<Parameters<typeof createNodeGitMutationAdapter>[0]> = {},
  ): Promise<GitDeliveryExecutionResultLike> {
    const ad = adapterFor(repo, bound, extra);
    writeFileSync(
      join(repo, "a.txt"),
      `${String(message.length)}-${String(++commitSequence)}\n`,
      "utf8",
    );
    expect((await ad.stage({ pathspecs: ["a.txt"] })).outcome).toBe("succeeded");
    return ad.commit({ message, allowEmpty: false });
  }

  function reflogs(repo: string): { branch: string[]; head: string[] } {
    const lines = (ref: string): string[] =>
      gitIn(repo, ["reflog", "--format=%gs", ref]).trim().split("\n");
    return { branch: lines("refs/heads/main"), head: lines("HEAD") };
  }

  it.each([
    ["a normal commit", true, "subject  \n\nbody", "commit: subject"],
    [
      "a normal commit with a multi-line first paragraph",
      true,
      "first\nsecond\n\nbody",
      "commit: first",
    ],
    ["an indented continuation line", true, "first\n  second\nthird", "commit: first"],
    [
      "the root commit of an unborn branch",
      false,
      "root subject\n",
      "commit (initial): root subject",
    ],
    ["a message with leading blank lines", true, "\n\n  lead\nbody\n", "commit: lead"],
  ])("writes the reflog git commit writes for %s", async (_name, born, message, expected) => {
    const plainRepo = newRepo();
    const boundRepo = newRepo();
    if (born) {
      seedBase(plainRepo);
      seedBase(boundRepo);
    }

    expect((await commitOn(plainRepo, false, message)).outcome).toBe("succeeded");
    expect((await commitOn(boundRepo, true, message)).outcome).toBe("succeeded");

    expect(reflogs(boundRepo)).toEqual(reflogs(plainRepo));
    // What real git writes, not only what the two lanes agree on: the first line, on both refs.
    expect(reflogs(plainRepo).branch[0]).toBe(expected);
    expect(reflogs(boundRepo).branch[0]).toBe(expected);
    expect(reflogs(boundRepo).head[0]).toBe(expected);
  });

  it("leaves the same merge state files as git commit after a squash merge", async () => {
    async function squashAndCommit(bound: boolean): Promise<string[]> {
      const repo = newRepo();
      seedBase(repo);
      gitIn(repo, ["checkout", "-q", "-b", "side"]);
      writeFileSync(join(repo, "side.txt"), "side\n", "utf8");
      gitIn(repo, ["add", "side.txt"]);
      gitIn(repo, ["commit", "-q", "-m", "side"]);
      gitIn(repo, ["checkout", "-q", "main"]);
      gitIn(repo, ["merge", "--squash", "side"]);
      writeFileSync(join(repo, ".git", "MERGE_MSG"), "stale\n", "utf8");
      writeFileSync(join(repo, ".git", "MERGE_MODE"), "", "utf8");
      expect(existsSync(join(repo, ".git", "SQUASH_MSG"))).toBe(true);
      const ad = adapterFor(repo, bound);
      expect((await ad.commit({ message: "squashed", allowEmpty: false })).outcome).toBe(
        "succeeded",
      );
      return readdirSync(join(repo, ".git")).filter((name) => /^(MERGE_|SQUASH_)/u.test(name));
    }

    const plain = await squashAndCommit(false);
    expect(plain).toEqual([]);
    expect(await squashAndCommit(true)).toEqual(plain);
  });

  it("reports a merge state file that cannot be removed without replacing the success", async () => {
    const repo = newRepo();
    seedBase(repo);
    writeFileSync(join(repo, ".git", "SQUASH_MSG"), "squash\n", "utf8");
    const reports: GitCleanupIncompleteReport[] = [];

    const committed = await commitOn(repo, true, "lands", {
      onCleanupIncomplete: (report) => reports.push(report),
      removePath: () => {
        throw Object.assign(new Error("busy"), { code: "EBUSY" });
      },
    });

    expect(committed.outcome).toBe("succeeded");
    expect(reports).toEqual([
      {
        caller: "commit-state",
        quarantines: 0,
        temporaryIndex: false,
        lock: false,
        descriptors: 0,
        refLocks: 0,
        directories: 0,
        stateFiles: 1,
      },
    ]);
  });

  // The message bytes git commit -m records, for every effective cleanup mode: the bound lane must
  // produce exactly them (the cleanup is made by Git itself, never by a hand-written copy of it).
  const CLEANUP_MESSAGES = [
    "plain",
    "  lead  \n\n\n\nbody  \n\n",
    "# comment\nbody\n# x\n",
    ";semi\n#hash\nbody",
    "sub\n\n  \n\ttab\t\n",
    "a\r\nb\r\n",
    "\n\nlead\nbody",
    "tail   ",
    "a\n\n#c\n\n\nb",
    "//s\nb",
  ];
  // Messages that only `auto` (Git picks a character that starts no line) can commit.
  const AUTO_ONLY_MESSAGES = ["#a\n#b", "# one\nbody\n; two", "#a\n;b\nbody"];

  function commitBodies(repo: string): string[] {
    return gitIn(repo, ["rev-list", "--reverse", "HEAD"])
      .trim()
      .split("\n")
      .map((sha) => gitIn(repo, ["cat-file", "commit", sha]).split("\n\n").slice(1).join("\n\n"));
  }

  const CLEANUP_CASES: readonly (readonly [string, readonly [string, string] | undefined])[] = [
    ["default", undefined],
    ["whitespace", undefined],
    ["scissors", undefined],
    ["strip", undefined],
    ["strip", ["core.commentChar", ";"]],
    ["strip", ["core.commentChar", "auto"]],
    ["strip", ["core.commentString", "auto"]],
    ["strip", ["core.commentString", "//"]],
    ["verbatim", undefined],
  ];

  it.each(CLEANUP_CASES)(
    "records the message bytes of git commit -m for commit.cleanup=%s (comment marker %j)",
    async (mode, comment) => {
      // The oracle is real `git commit -m` run directly, so the lanes cannot agree on a wrong answer.
      const gitRepo = newRepo();
      const plainRepo = newRepo();
      const boundRepo = newRepo();
      for (const repo of [gitRepo, plainRepo, boundRepo]) {
        seedBase(repo);
        gitIn(repo, ["config", "commit.cleanup", mode]);
        if (comment !== undefined) gitIn(repo, ["config", ...comment]);
      }
      const messages = [
        ...CLEANUP_MESSAGES,
        ...(comment?.[1] === "auto" ? AUTO_ONLY_MESSAGES : []),
      ];
      for (const [index, message] of messages.entries()) {
        writeFileSync(join(gitRepo, "a.txt"), `${String(index)}\n`, "utf8");
        gitIn(gitRepo, ["add", "a.txt"]);
        gitIn(gitRepo, ["commit", "-q", "-m", message]);
        expect((await commitOn(plainRepo, false, message)).outcome).toBe("succeeded");
        expect((await commitOn(boundRepo, true, message)).outcome).toBe("succeeded");
      }

      expect(commitBodies(boundRepo)).toEqual(commitBodies(gitRepo));
      expect(commitBodies(plainRepo)).toEqual(commitBodies(gitRepo));
      expect(reflogs(boundRepo)).toEqual(reflogs(gitRepo));
      expect(commitBodies(boundRepo)).toHaveLength(messages.length + 1);
    },
  );

  it("refuses like git when every candidate comment character starts a line (auto)", async () => {
    const message = ["x", "#a", ";b", "@c", "!d", "$e", "%f", "^g", "&h", "|i", ":j", "k"].join(
      "\n",
    );
    const gitRepo = newRepo();
    const boundRepo = newRepo();
    for (const repo of [gitRepo, boundRepo]) {
      seedBase(repo);
      gitIn(repo, ["config", "commit.cleanup", "strip"]);
      gitIn(repo, ["config", "core.commentChar", "auto"]);
    }
    writeFileSync(join(gitRepo, "a.txt"), "x\n", "utf8");
    gitIn(gitRepo, ["add", "a.txt"]);
    expect(() => gitIn(gitRepo, ["commit", "-q", "-m", message])).toThrow();

    const causes: string[] = [];
    const refused = await commitOn(boundRepo, true, message, {
      onCommitRefused: (report) => {
        causes.push(report.cause);
      },
    });

    expect(refused.outcome).toBe("failed");
    expect(refused.errorCode).toBe("precondition-failed");
    expect(causes).toEqual(["cleanup-unavailable"]);
    expect(gitIn(boundRepo, ["rev-list", "--count", "HEAD"]).trim()).toBe("1");
  });

  it("refuses an invalid commit.cleanup on both lanes without writing anything", async () => {
    for (const bound of [false, true]) {
      const repo = newRepo();
      seedBase(repo);
      gitIn(repo, ["config", "commit.cleanup", "bogus"]);
      const causes: string[] = [];
      const ad = adapterFor(repo, bound, { onCommitRefused: (r) => causes.push(r.cause) });
      writeFileSync(join(repo, "a.txt"), "x\n", "utf8");
      expect((await ad.stage({ pathspecs: ["a.txt"] })).outcome).toBe("succeeded");
      // The bound lane reports the closed cause; the plain lane lets Git refuse it and writes nothing.
      const refused = await ad.commit({ message: "m", allowEmpty: false });
      expect(refused.outcome).toBe("failed");
      expect(refused.errorCode).toBe("precondition-failed");
      expect(gitIn(repo, ["rev-list", "--count", "HEAD"]).trim()).toBe("1");
      if (bound) expect(causes).toEqual(["cleanup-unavailable"]);
    }
  });

  // The limit is on the effective message (after the cleanup), 65,535 bytes without its line break.
  it.each([true, false])(
    "accepts 65,535 bytes after cleanup and refuses 65,536 (bound lane: %s)",
    async (bound) => {
      const repo = newRepo();
      seedBase(repo);
      const causes: string[] = [];
      const extra = {
        onCommitRefused: (r: { cause: string }): void => {
          causes.push(r.cause);
        },
      };

      expect((await commitOn(repo, bound, "x".repeat(65_535), extra)).outcome).toBe("succeeded");
      // 65,536 raw bytes whose trailing blanks are cleaned away fit once cleaned.
      expect((await commitOn(repo, bound, `${"y".repeat(65_533)}   `, extra)).outcome).toBe(
        "succeeded",
      );
      const before = gitIn(repo, ["rev-list", "--count", "HEAD"]).trim();
      const refused = await commitOn(repo, bound, "z".repeat(65_536), extra);

      expect(refused.outcome).toBe("failed");
      expect(refused.errorCode).toBe("precondition-failed");
      expect(causes).toEqual(["message-too-large"]);
      expect(gitIn(repo, ["rev-list", "--count", "HEAD"]).trim()).toBe(before);
    },
  );

  it("treats an update-ref that fails after the branch names the new commit as a success", async () => {
    const repo = newRepo();
    seedBase(repo);
    const causes: string[] = [];
    const lateFailure: SpawnFn = (command, args, options) => {
      const child = nodeSpawnFn(command, args, options);
      if (!args.includes("update-ref")) return child;
      // The real update lands; only the exit code the adapter sees is a failure.
      return new Proxy(child, {
        get(target, property): unknown {
          const value: unknown = Reflect.get(target, property, target);
          if (property !== "on") return typeof value === "function" ? value.bind(target) : value;
          return (event: string, listener: (...args: unknown[]) => void): ChildProcess =>
            target.on(event, (...received: unknown[]) => {
              if (event === "close") listener(1, received[1]);
              else listener(...received);
            });
        },
      });
    };

    const committed = await commitOn(repo, true, "lands anyway", {
      spawn: lateFailure,
      onCommitRefused: (report) => causes.push(report.cause),
    });

    expect(committed.outcome).toBe("succeeded");
    // The late error is not invisible: the success carries a closed note the UI shows.
    expect(committed.completionNote).toBe("recorded-despite-late-error");
    expect(committed.externalId).toBe(gitIn(repo, ["rev-parse", "HEAD"]).trim());
    expect(gitIn(repo, ["log", "-1", "--format=%s"]).trim()).toBe("lands anyway");
    expect(causes).toEqual(["landed-after-failure"]);
  });

  // A port that fails the way the Node port does: the real lstat error codes of one entry.
  function statFaultOn(name: string, code: string): WorkspaceFs {
    return {
      ...nodeWorkspaceFs,
      stat: (path): ReturnType<WorkspaceFs["stat"]> => {
        if (path.endsWith(`${sep}${name}`)) throw Object.assign(new Error(code), { code });
        return nodeWorkspaceFs.stat(path);
      },
    };
  }

  it("counts an unreadable merge state file instead of reading it as absent", async () => {
    const repo = newRepo();
    seedBase(repo);
    writeFileSync(join(repo, ".git", "SQUASH_MSG"), "squash\n", "utf8");
    const reports: GitCleanupIncompleteReport[] = [];

    const committed = await commitOn(repo, true, "lands", {
      metadataFs: statFaultOn("SQUASH_MSG", "EACCES"),
      onCleanupIncomplete: (report) => reports.push(report),
    });

    expect(committed.outcome).toBe("succeeded");
    expect(reports.map((report) => [report.caller, report.stateFiles])).toEqual([
      ["commit-state", 1],
    ]);
  });

  it("keeps the error class when the merge state cannot be examined at all", async () => {
    const repo = newRepo();
    seedBase(repo);
    const reports: GitCleanupIncompleteReport[] = [];
    let refUpdates = 0;
    const committed = await commitOn(repo, true, "lands", {
      // The last authorization runs right before the ref update: from there on the gitdir cannot
      // be resolved, so the cleanup after the commit cannot examine the merge state.
      beforeCommitRefUpdate: (): boolean => {
        refUpdates += 1;
        return true;
      },
      metadataFs: {
        ...nodeWorkspaceFs,
        realPath: (path) => {
          if (refUpdates >= 2) throw Object.assign(new Error("EIO"), { code: "EIO" });
          return nodeWorkspaceFs.realPath(path);
        },
      },
      onCleanupIncomplete: (report) => reports.push(report),
    });

    expect(committed.outcome).toBe("succeeded");
    expect(reports).toHaveLength(1);
    expect(reports[0]?.stateFiles).toBe(1);
    expect(reports[0]?.error).toBeInstanceOf(Error);
  });

  it("cuts a long reflog subject by code points, never inside a surrogate pair", async () => {
    const repo = newRepo();
    seedBase(repo);
    const message = `${"x".repeat(1_023)}\u{1F600}\u{1F600}`;

    expect((await commitOn(repo, true, message)).outcome).toBe("succeeded");

    const subject = reflogs(repo).branch[0] ?? "";
    expect(subject).toBe(`commit: ${"x".repeat(1_023)}\u{1F600}`);
    expect(Buffer.from(subject, "utf8").toString("utf8")).toBe(subject);
    expect(subject).not.toContain("\uFFFD");
  });

  it("commits a message of 60 KiB through stdin, byte for byte as git cleans it", async () => {
    const repo = newRepo();
    seedBase(repo);
    const message = `subject\n\n${"x".repeat(60_000)}`;

    expect((await commitOn(repo, true, message)).outcome).toBe("succeeded");

    expect(gitIn(repo, ["cat-file", "commit", "HEAD"]).endsWith(`\n\n${message}\n`)).toBe(true);
  });

  describe("refusals carry their own cause and code", () => {
    interface Refusal {
      readonly result: GitDeliveryExecutionResultLike;
      readonly causes: string[];
    }

    async function refused(
      repo: string,
      message: string,
      allowEmpty: boolean,
      extra: Partial<Parameters<typeof createNodeGitMutationAdapter>[0]> = {},
    ): Promise<Refusal> {
      const causes: string[] = [];
      const ad = adapterFor(repo, true, {
        onCommitRefused: (report) => causes.push(report.cause),
        ...extra,
      });
      return { result: await ad.commit({ message, allowEmpty }), causes };
    }

    it("names a checkout that is not on the prepared branch", async () => {
      const repo = newRepo();
      seedBase(repo);
      gitIn(repo, ["checkout", "-q", "-b", "elsewhere"]);
      const { result, causes } = await refused(repo, "m", true);
      expect(result.errorCode).toBe("precondition-failed");
      expect(causes).toEqual(["not-on-prepared-branch"]);
    });

    it("names a sequencer operation in progress", async () => {
      const repo = newRepo();
      seedBase(repo);
      writeFileSync(join(repo, ".git", "MERGE_HEAD"), "x\n", "utf8");
      const { result, causes } = await refused(repo, "m", true);
      expect(result.errorCode).toBe("precondition-failed");
      expect(causes).toEqual(["sequencer-in-progress"]);
    });

    it("names an unreadable sequencer state and keeps the cause", async () => {
      const repo = newRepo();
      seedBase(repo);
      const reports: { cause: string; error?: unknown }[] = [];
      const { result } = await refused(repo, "m", true, {
        metadataFs: statFaultOn("MERGE_HEAD", "EACCES"),
        onCommitRefused: (report) => reports.push(report),
      });
      expect(result.errorCode).toBe("precondition-failed");
      expect(reports.map((report) => report.cause)).toEqual(["sequencer-unreadable"]);
      expect(reports[0]?.error).toBeInstanceOf(Error);
    });

    it("does not read an unreadable MERGE_HEAD as no merge in progress", async () => {
      const repo = newRepo();
      seedBase(repo);
      writeFileSync(join(repo, ".git", "MERGE_HEAD"), "x\n", "utf8");
      const before = gitIn(repo, ["rev-parse", "HEAD"]).trim();
      const { result, causes } = await refused(repo, "m", true, {
        metadataFs: statFaultOn("MERGE_HEAD", "EIO"),
      });
      expect(result.outcome).toBe("failed");
      expect(causes).toEqual(["sequencer-unreadable"]);
      expect(gitIn(repo, ["rev-parse", "HEAD"]).trim()).toBe(before);
    });

    it("keeps a git failure that is not a moved branch out of `conflict`", async () => {
      const repo = newRepo();
      seedBase(repo);
      const before = gitIn(repo, ["rev-parse", "HEAD"]).trim();
      let authorizations = 0;
      const { result, causes } = await refused(repo, "mine", true, {
        // A held ref lock makes `update-ref` fail while the branch itself did not move.
        beforeCommitRefUpdate: (): boolean => {
          authorizations += 1;
          if (authorizations === 2)
            writeFileSync(join(repo, ".git", "refs", "heads", "main.lock"), "");
          return true;
        },
      });
      rmSync(join(repo, ".git", "refs", "heads", "main.lock"), { force: true });
      expect(result.outcome).toBe("failed");
      expect(result.errorCode).toBe("precondition-failed");
      expect(causes).toEqual(["git-command-failed"]);
      expect(gitIn(repo, ["rev-parse", "HEAD"]).trim()).toBe(before);
    });

    it("refuses the same oversized message on the plain lane", async () => {
      const repo = newRepo();
      seedBase(repo);
      const causes: string[] = [];
      const ad = adapterFor(repo, false, {
        onCommitRefused: (report) => causes.push(report.cause),
      });
      const result = await ad.commit({ message: "x".repeat(70_000), allowEmpty: true });
      expect(result.errorCode).toBe("precondition-failed");
      expect(causes).toEqual(["message-too-large"]);
      expect(gitIn(repo, ["rev-list", "--count", "HEAD"]).trim()).toBe("1");
    });

    it("never lets a throwing log port replace the refusal", async () => {
      const repo = newRepo();
      seedBase(repo);
      const { result } = await refused(repo, " \n", true, {
        onCommitRefused: () => {
          throw new Error("port failed");
        },
      });
      expect(result.outcome).toBe("failed");
      expect(result.errorCode).toBe("precondition-failed");
    });

    it("never moves the branch a symbolic prepared branch points to", async () => {
      const repo = newRepo();
      seedBase(repo);
      gitIn(repo, ["branch", "other"]);
      // `refs/heads/task` is a symref to `refs/heads/other`, and the checkout is on it: the branch the
      // signing decision was made for is not the ref an update would move.
      gitIn(repo, ["symbolic-ref", "refs/heads/task", "refs/heads/other"]);
      gitIn(repo, ["symbolic-ref", "HEAD", "refs/heads/task"]);
      const otherBefore = gitIn(repo, ["rev-parse", "refs/heads/other"]).trim();
      const { result, causes } = await refused(repo, "mine", true, {
        preparedCheckout: { branchName: "task" },
      });
      expect(result.outcome).toBe("failed");
      expect(result.errorCode).toBe("precondition-failed");
      // The checkout reads as the branch the symref resolves to, so it is not the prepared one.
      expect(causes).toEqual(["not-on-prepared-branch"]);
      expect(gitIn(repo, ["rev-parse", "refs/heads/other"]).trim()).toBe(otherBefore);
      expect(gitIn(repo, ["symbolic-ref", "refs/heads/task"]).trim()).toBe("refs/heads/other");
    });

    it("refuses a destination that turns symbolic after the commit object was written", async () => {
      const repo = newRepo();
      seedBase(repo);
      gitIn(repo, ["branch", "other"]);
      const otherBefore = gitIn(repo, ["rev-parse", "refs/heads/other"]).trim();
      let authorizations = 0;
      const { result, causes } = await refused(repo, "mine", true, {
        // The last authorization runs right before the ref update: the branch becomes a symref there.
        beforeCommitRefUpdate: (): boolean => {
          authorizations += 1;
          if (authorizations === 2)
            gitIn(repo, ["symbolic-ref", "refs/heads/main", "refs/heads/other"]);
          return true;
        },
      });
      expect(result.outcome).toBe("failed");
      expect(result.errorCode).toBe("precondition-failed");
      expect(causes).toEqual(["ref-symbolic"]);
      expect(gitIn(repo, ["rev-parse", "refs/heads/other"]).trim()).toBe(otherBefore);
    });

    it("names an empty message", async () => {
      const repo = newRepo();
      seedBase(repo);
      const { result, causes } = await refused(repo, " \n\t\n", true);
      expect(result.errorCode).toBe("precondition-failed");
      expect(causes).toEqual(["empty-message"]);
    });

    it("names a commit that would change nothing", async () => {
      const repo = newRepo();
      seedBase(repo);
      const { result, causes } = await refused(repo, "m", false);
      expect(result.errorCode).toBe("precondition-failed");
      expect(causes).toEqual(["nothing-to-commit"]);
    });

    it("names a message too large for the bounded input", async () => {
      const repo = newRepo();
      seedBase(repo);
      const { result, causes } = await refused(repo, "x".repeat(70_000), true);
      expect(result.errorCode).toBe("precondition-failed");
      expect(causes).toEqual(["message-too-large"]);
    });

    it("answers `conflict` and writes nothing when the prepared branch moves before the ref update", async () => {
      const repo = newRepo();
      seedBase(repo);
      const before = gitIn(repo, ["rev-parse", "HEAD"]).trim();
      let authorizations = 0;
      let racer = "";
      const { result, causes } = await refused(repo, "mine", true, {
        // The second authorization runs after the commit object exists and right before the ref
        // update: the branch itself moves exactly there.
        beforeCommitRefUpdate: (): boolean => {
          authorizations += 1;
          if (authorizations === 2) {
            gitIn(repo, ["commit", "-q", "--allow-empty", "-m", "racer"]);
            racer = gitIn(repo, ["rev-parse", "HEAD"]).trim();
          }
          return true;
        },
      });

      expect(result.outcome).toBe("failed");
      expect(result.errorCode).toBe("conflict");
      expect(causes).toEqual(["ref-moved"]);
      expect(racer).not.toBe(before);
      expect(gitIn(repo, ["rev-parse", "refs/heads/main"]).trim()).toBe(racer);
      expect(gitIn(repo, ["log", "-1", "--format=%s", "refs/heads/main"]).trim()).toBe("racer");
    });
  });
});

describe("node git mutation adapter — successful local mutations", () => {
  it("stages and commits a file through the governed boundary", async () => {
    writeFileSync(join(root, "a.txt"), "hello\n", "utf8");
    const ad = adapter();

    const staged = await ad.stage({ pathspecs: ["a.txt"] });
    expect(staged.outcome).toBe("succeeded");
    expect(git(["diff", "--cached", "--name-only"]).trim()).toBe("a.txt");

    const committed = await ad.commit({ message: "initial commit", allowEmpty: false });
    expect(committed.outcome).toBe("succeeded");
    expect(git(["log", "--oneline"])).toContain("initial commit");
    expectLastCommitSigned(root);
  });

  it("creates a branch from an existing ref", async () => {
    writeFileSync(join(root, "a.txt"), "hello\n", "utf8");
    const ad = adapter();
    await ad.stage({ pathspecs: ["a.txt"] });
    await ad.commit({ message: "base", allowEmpty: false });

    const branched = await ad.createBranch({ branchName: "feature/x", startPointRefHash: "HEAD" });
    expect(branched.outcome).toBe("succeeded");
    expect(git(["branch", "--list", "feature/x"])).toContain("feature/x");
  });

  it("switches HEAD to an existing branch through the governed boundary (#475)", async () => {
    writeFileSync(join(root, "a.txt"), "hello\n", "utf8");
    const ad = adapter();
    await ad.stage({ pathspecs: ["a.txt"] });
    await ad.commit({ message: "base", allowEmpty: false });
    const startBranch = git(["rev-parse", "--abbrev-ref", "HEAD"]).trim();
    await ad.createBranch({ branchName: "feature/x", startPointRefHash: "HEAD" });

    const switched = await ad.switchBranch({ branchName: "feature/x" });
    expect(switched.outcome).toBe("succeeded");
    expect(git(["rev-parse", "--abbrev-ref", "HEAD"]).trim()).toBe("feature/x");
    expect(git(["rev-parse", "--abbrev-ref", "HEAD"]).trim()).not.toBe(startBranch);
  });

  it("reports precondition-failed when switching to a non-existent branch (#475)", async () => {
    writeFileSync(join(root, "a.txt"), "hello\n", "utf8");
    const ad = adapter();
    await ad.stage({ pathspecs: ["a.txt"] });
    await ad.commit({ message: "base", allowEmpty: false });

    const failed = await ad.switchBranch({ branchName: "feature/does-not-exist" });
    expect(failed.outcome).toBe("failed");
    expect(failed.errorCode).toBe("precondition-failed");
  });

  it("unstages a staged file", async () => {
    writeFileSync(join(root, "a.txt"), "hello\n", "utf8");
    const ad = adapter();
    await ad.stage({ pathspecs: ["a.txt"] });
    await ad.commit({ message: "base", allowEmpty: false });

    writeFileSync(join(root, "b.txt"), "world\n", "utf8");
    await ad.stage({ pathspecs: ["b.txt"] });
    expect(git(["diff", "--cached", "--name-only"]).trim()).toBe("b.txt");

    const unstaged = await ad.unstage({ pathspecs: ["b.txt"] });
    expect(unstaged.outcome).toBe("succeeded");
    expect(git(["diff", "--cached", "--name-only"]).trim()).toBe("");
  });

  it("treats pathspec-magic-looking filenames as literal files (#1575)", async (context) => {
    if (process.platform === "win32") {
      context.skip(
        "NTFS forbids ':' and '*' in file names; the literal ':(top)*' file cannot exist",
      );
    }
    writeFileSync(join(root, "base.txt"), "base\n", "utf8");
    git(["add", "base.txt"]);
    git(["commit", "-m", "base"]);
    writeFileSync(join(root, ":(top)*"), "magic-looking name\n", "utf8");
    writeFileSync(join(root, "another.txt"), "must stay unstaged\n", "utf8");

    const staged = await adapter().stage({ pathspecs: [":(top)*"] });

    expect(staged.outcome).toBe("succeeded");
    expect(git(["diff", "--cached", "--name-only"]).trim()).toBe(":(top)*");
    expect(git(["status", "--short"])).toContain("?? another.txt");
  });
});

// #3902 AC2 (PR #4064 review 4372101954): an unstaging reviewed against a head, a base and a staged
// tree changes the index only while all three still hold. The adapter checks them at the mutation
// boundary, inside the index transaction and again just before the swap, so a change that lands
// after the proposal was reviewed or approved is never accepted as the effect's new snapshot.
describe("node git mutation adapter — verified unstage", () => {
  // `work` on top of `base`, with b.txt staged on it: the state an unstage proposal reviews.
  async function reviewedState(): Promise<GitVerifiedCommitPrecondition> {
    writeFileSync(join(root, "a.txt"), "hello\n", "utf8");
    git(["add", "a.txt"]);
    git(["commit", "-qm", "base"]);
    git(["branch", "base"]);
    git(["checkout", "-qb", "work"]);
    writeFileSync(join(root, "b.txt"), "world\n", "utf8");
    git(["add", "b.txt"]);
    const headSha = git(["rev-parse", "HEAD"]).trim();
    return {
      head: { kind: "born", sha: headSha },
      stagedTreeDigest: await readGitIndexTreeDigest({
        workspace: info,
        processEnv: { PATH: process.env.PATH ?? "" },
      }),
      branchName: "work",
      baseRef: "base",
      base: { kind: "born", sha: headSha },
    };
  }

  const DRIFTS: Readonly<Record<string, () => void>> = {
    index: () => {
      writeFileSync(join(root, "c.txt"), "another\n", "utf8");
      git(["add", "c.txt"]);
    },
    head: () => {
      git(["commit", "-qm", "moved", "--allow-empty", "--no-gpg-sign"]);
    },
    base: () => {
      git([
        "update-ref",
        "refs/heads/base",
        git(["commit-tree", "-p", "base", "-m", "x", "base^{tree}"]).trim(),
      ]);
    },
  };

  it("gives the reviewed staged change back to the worktree while the review still holds", async () => {
    const verified = await reviewedState();
    const unstaged = await adapter().unstage({ pathspecs: ["b.txt"], verified });
    expect(unstaged.outcome).toBe("succeeded");
    expect(git(["diff", "--cached", "--name-only"]).trim()).toBe("");
    expect(git(["status", "--short"])).toContain("?? b.txt");
  });

  it.each(Object.keys(DRIFTS))(
    "changes nothing when the %s moved after the review",
    async (drift) => {
      const verified = await reviewedState();
      DRIFTS[drift]?.();
      const index = git(["ls-files", "--stage"]);
      const unstaged = await adapter().unstage({ pathspecs: ["b.txt"], verified });
      expect(unstaged.outcome).toBe("failed");
      expect(git(["ls-files", "--stage"])).toBe(index);
    },
  );

  // The change lands while the effect runs: after its first check, before the index transaction.
  it.each(Object.keys(DRIFTS))(
    "changes nothing when the %s moves while the effect runs",
    async (drift) => {
      const verified = await reviewedState();
      let index: string | undefined;
      const racing = createNodeGitMutationAdapter({
        workspace: info,
        processEnv: { PATH: process.env.PATH ?? "" },
        now: () => Date.now(),
        beforeIndexUpdate: () => {
          if (index === undefined) {
            DRIFTS[drift]?.();
            index = git(["ls-files", "--stage"]);
          }
          return true;
        },
      });
      const unstaged = await racing.unstage({ pathspecs: ["b.txt"], verified });
      expect(index).toBeDefined();
      expect(unstaged.outcome).toBe("failed");
      expect(git(["ls-files", "--stage"])).toBe(index);
    },
  );

  it("refuses at the swap when the run's authority lapsed during the effect", async () => {
    const verified = await reviewedState();
    let calls = 0;
    const lapsing = createNodeGitMutationAdapter({
      workspace: info,
      processEnv: { PATH: process.env.PATH ?? "" },
      now: () => Date.now(),
      beforeIndexUpdate: () => (calls += 1) < 3,
    });
    // The lapse is a thrown failure; the orchestrator's adapter boundary reports it as failed.
    await expect(lapsing.unstage({ pathspecs: ["b.txt"], verified })).rejects.toThrow(
      "git-unstage-authority-denied",
    );
    expect(git(["diff", "--cached", "--name-only"]).trim()).toBe("b.txt");
  });
});

describe("node git mutation adapter — structured failure classification", () => {
  it("maps a non-zero git exit to a precondition-failed result", async () => {
    writeFileSync(join(root, "a.txt"), "hello\n", "utf8");
    const ad = adapter();
    await ad.stage({ pathspecs: ["a.txt"] });
    await ad.commit({ message: "base", allowEmpty: false });

    // Index is clean now; committing with nothing staged makes git exit non-zero.
    const failed = await ad.commit({ message: "nothing to commit", allowEmpty: false });
    expect(failed.outcome).toBe("failed");
    expect(failed.errorCode).toBe("precondition-failed");
  });

  it("rejects an invalid operand before any spawn (internal-error, no git run)", async () => {
    const ad = adapter();
    const bad = await ad.commit({ message: "", allowEmpty: false });
    expect(bad.outcome).toBe("failed");
    expect(bad.errorCode).toBe("internal-error");
    // No commit happened: there is no HEAD in the fresh repo.
    expect(() => git(["rev-parse", "HEAD"])).toThrow();
  });
});

// Seeds a base commit and returns the current branch name and the base commit SHA.
function seedBaseCommit(): { branch: string; base: string } {
  writeFileSync(join(root, "f.txt"), "v1\n", "utf8");
  git(["add", "f.txt"]);
  git(["commit", "-m", "v1"]);
  return {
    branch: git(["rev-parse", "--abbrev-ref", "HEAD"]).trim(),
    base: git(["rev-parse", "HEAD"]).trim(),
  };
}

describe("node git mutation adapter — abort through the real boundary", () => {
  it("aborts an in-progress merge and clears the merge state", async () => {
    const { branch } = seedBaseCommit();
    git(["checkout", "-b", "feature"]);
    writeFileSync(join(root, "f.txt"), "feature\n", "utf8");
    git(["commit", "-am", "feature"]);
    git(["checkout", branch]);
    writeFileSync(join(root, "f.txt"), "mainline\n", "utf8");
    git(["commit", "-am", "mainline"]);
    // A conflicting merge leaves the repository in a merge-in-progress state (git exits non-zero).
    expect(() => git(["merge", "feature"])).toThrow();
    expect(git(["rev-parse", "-q", "--verify", "MERGE_HEAD"]).trim().length).toBeGreaterThan(0);

    const aborted = await adapter().abort({ operationToAbort: "merge" });
    expect(aborted.outcome).toBe("succeeded");
    // MERGE_HEAD is gone: the merge was aborted.
    expect(() => git(["rev-parse", "-q", "--verify", "MERGE_HEAD"])).toThrow();
  });
});

describe("node git mutation adapter — multi-step recovery through the real boundary", () => {
  it("stash-and-reset runs both steps: HEAD moves back and the work is preserved in a stash", async () => {
    const { base } = seedBaseCommit();
    writeFileSync(join(root, "f.txt"), "v2\n", "utf8");
    git(["commit", "-am", "v2"]);
    // Dirty the worktree (tracked edit + an untracked file) so the stash has work to preserve.
    writeFileSync(join(root, "f.txt"), "dirty\n", "utf8");
    writeFileSync(join(root, "untracked.txt"), "u\n", "utf8");

    const recovered = await adapter().recover({
      recoveryStrategyHint: "stash-and-reset",
      targetRefHash: base,
      pathspecs: [],
    });
    expect(recovered.outcome).toBe("succeeded");
    expect(git(["rev-parse", "HEAD"]).trim()).toBe(base); // reset to the target
    expect(git(["stash", "list"]).trim().length).toBeGreaterThan(0); // work preserved, not lost
  });

  it("reports a partial result when the second recovery step fails", async () => {
    seedBaseCommit();
    writeFileSync(join(root, "f.txt"), "dirty\n", "utf8");
    // Step 1 (stash) succeeds; step 2 (reset --hard <unknown ref>) fails.
    const partial = await adapter().recover({
      recoveryStrategyHint: "stash-and-reset",
      targetRefHash: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      pathspecs: [],
    });
    expect(partial.outcome).toBe("partial");
    expect(partial.partialDetail).toEqual({ attemptedUnitCount: 2, succeededUnitCount: 1 });
  });
});

// Windows lab (1.5.10): every Git process costs 70 to 130 ms there, and each governed step used to
// probe the repository's promisor remotes again before its own process. The probe is the guard's
// `git config --get-regexp ^remote\..*\.(promisor|partialclonefilter)$`.
describe("node git mutation adapter — one promisor verdict per operation", () => {
  const PROMISOR_PROBE = String.raw`^remote\..*\.(promisor|partialclonefilter)$`;

  // The host's own git decides whether a negative verdict may be held (git 2.45 or later), so the
  // pins below fix the version the adapter sees: the cached-verdict path and the re-probe path are
  // each under test on every host, whatever git is installed.
  const GUARD_ENFORCING_BANNER = "git version 2.50.0";
  const GUARD_IGNORING_BANNER = "git version 2.43.0";

  function countingAdapter(
    options: { readonly readSession?: boolean; readonly versionBanner?: string } = {},
  ): {
    readonly adapter: GitLocalMutationAdapter;
    readonly probes: () => number;
    readonly processes: () => number;
  } {
    let probes = 0;
    let processes = 0;
    const spawn: SpawnFn = (command, args, spawnOptions) => {
      // The installed git's version is read once per spawn function, never per step or operation:
      // it is what makes a negative promisor verdict safe to hold for the whole operation.
      if (args[0] !== "version") processes += 1;
      if (args.includes(PROMISOR_PROBE)) probes += 1;
      if (args[0] === "version") {
        const banner = options.versionBanner ?? GUARD_ENFORCING_BANNER;
        return nodeSpawnFn(
          process.execPath,
          ["-e", `console.log(${JSON.stringify(banner)})`],
          spawnOptions,
        );
      }
      return nodeSpawnFn(command, args, spawnOptions);
    };
    return {
      adapter: createNodeGitMutationAdapter({
        workspace: info,
        processEnv: { PATH: process.env.PATH ?? "" },
        now: () => Date.now(),
        spawn,
        ...(options.readSession === true ? { readSession: createGitReadSession() } : {}),
      }),
      probes: () => probes,
      processes: () => processes,
    };
  }

  function dirtyRepositoryTwoCommitsDeep(): string {
    const { base } = seedBaseCommit();
    writeFileSync(join(root, "f.txt"), "v2\n", "utf8");
    git(["commit", "-am", "v2"]);
    writeFileSync(join(root, "f.txt"), "dirty\n", "utf8");
    return base;
  }

  it("probes once for a two-step operation, where it probed before each step", async () => {
    const base = dirtyRepositoryTwoCommitsDeep();
    const { adapter: counted, probes, processes } = countingAdapter();
    const recovered = await counted.recover({
      recoveryStrategyHint: "stash-and-reset",
      targetRefHash: base,
      pathspecs: [],
    });
    expect(recovered.outcome).toBe("succeeded");
    expect(processes()).toBe(3);
    expect(probes()).toBe(1);
  });

  it("probes before each effect on a git that does not enforce the lazy-fetch guard", async () => {
    const base = dirtyRepositoryTwoCommitsDeep();
    const {
      adapter: counted,
      probes,
      processes,
    } = countingAdapter({
      versionBanner: GUARD_IGNORING_BANNER,
    });
    const recovered = await counted.recover({
      recoveryStrategyHint: "stash-and-reset",
      targetRefHash: base,
      pathspecs: [],
    });
    expect(recovered.outcome).toBe("succeeded");
    // Stash and reset are two effects: each is preceded by its own probe, so the probes are the
    // processes beyond the two steps.
    expect(probes()).toBe(2);
    expect(processes()).toBe(2 + probes());
  });

  it("probes again for the next operation of the same adapter", async () => {
    const base = dirtyRepositoryTwoCommitsDeep();
    const { adapter: counted, probes } = countingAdapter();
    await counted.recover({
      recoveryStrategyHint: "stash-and-reset",
      targetRefHash: base,
      pathspecs: [],
    });
    expect(probes()).toBe(1);
    // A promisor remote configured between two operations is seen by the second one.
    git(["config", "remote.origin.url", "https://example.invalid/repo.git"]);
    git(["config", "remote.origin.promisor", "true"]);
    await counted.switchBranch({ branchName: "main" });
    await counted.switchBranch({ branchName: "main" });
    expect(probes()).toBe(3);
  });

  it("shares the verdict of a scope the caller owns across the operations inside it", async () => {
    const base = dirtyRepositoryTwoCommitsDeep();
    const { adapter: scoped, probes } = countingAdapter({ readSession: true });
    await scoped.recover({
      recoveryStrategyHint: "stash-and-reset",
      targetRefHash: base,
      pathspecs: [],
    });
    await scoped.switchBranch({ branchName: "main" });
    expect(probes()).toBe(1);
  });
});

describe("many blob texts in a few processes", () => {
  function blob(bytes: Uint8Array): string {
    return execFileSync("git", ["hash-object", "-w", "--stdin"], {
      cwd: root,
      input: bytes,
      encoding: "utf8",
    }).trim();
  }

  it("reads exactly what one blob read answers, whatever the bytes are", async () => {
    const ids = [
      blob(new TextEncoder().encode("plain\nlines\n")),
      blob(new TextEncoder().encode("ünïcödé ✓ 😀\n")),
      blob(Uint8Array.from([0x61, 0xff, 0xfe, 0x62, 0x0a])),
      blob(Uint8Array.from([0x61, 0x00, 0x62])),
      blob(new Uint8Array(0)),
      blob(new TextEncoder().encode("x".repeat(5000))),
    ];
    let processes = 0;
    const spawn: SpawnFn = (command, args, options) => {
      processes += 1;
      return nodeSpawnFn(command, args, options);
    };
    const deps = {
      workspace: info,
      processEnv: { PATH: process.env.PATH ?? "" },
      spawn,
      readSession: createGitReadSession(),
    };
    const many = await readGitBlobTextsWithin(deps, ids, 4096);
    const batched = processes;
    for (const id of ids)
      expect(many.get(id), id).toEqual(await readGitBlobTextWithin(deps, id, 4096));
    expect(many.get(ids[5] ?? "")).toBeUndefined();
    // The promisor probe, the sizes, the batches halved around the one byte sequence a UTF-8
    // decoder cannot carry through, and that blob by itself.
    expect(batched).toBeLessThanOrEqual(10);
  });

  it("starts the same number of processes for three blobs as for three hundred", async () => {
    const few = Array.from({ length: 3 }, (_, at) =>
      blob(new TextEncoder().encode(`few ${String(at)}\n`)),
    );
    const many = Array.from({ length: 300 }, (_, at) =>
      blob(new TextEncoder().encode(`many ${String(at)}\n`)),
    );
    let processes = 0;
    const spawn: SpawnFn = (command, args, options) => {
      processes += 1;
      return nodeSpawnFn(command, args, options);
    };
    const deps = { workspace: info, processEnv: { PATH: process.env.PATH ?? "" }, spawn };
    await readGitBlobTextsWithin(deps, few, 4096);
    const forFew = processes;
    processes = 0;
    await readGitBlobTextsWithin(deps, many, 4096);
    expect(processes).toBe(forFew);
  });

  it("refuses a blob that does not exist as an unreadable read", async () => {
    await expect(
      readGitBlobTextsWithin(
        { workspace: info, processEnv: { PATH: process.env.PATH ?? "" } },
        ["a".repeat(40)],
        4096,
      ),
    ).rejects.toMatchObject({ reason: "exit-nonzero" });
  });
});

describe("governed lifecycle — idempotent commit through the orchestrator + real adapter", () => {
  const ALLOW_ALL: GitDeliveryRepoPolicyPack = {
    schemaVersion: GIT_DELIVERY_POLICY_SCHEMA_VERSION,
    repoId: "repo",
    rules: [],
    defaultRule: { decision: "allowed" },
  };
  const NO_APPROVAL: GitDeliveryApprovalRequirement = { required: false };

  it("replays a recorded commit without creating a second commit", async () => {
    writeFileSync(join(root, "f.txt"), "x\n", "utf8");
    const ad = adapter();
    await ad.stage({ pathspecs: ["f.txt"] });

    const snapshot: GitWorktreeSnapshot = {
      headDetached: false,
      currentBranchName: "main",
      stagedFileCount: 1,
      unstagedFileCount: 0,
      untrackedFileCount: 0,
      hasUpstream: false,
      aheadCount: 0,
      behindCount: 0,
      existingLocalBranchNames: ["main"],
      remoteAliases: [],
      remoteReachable: undefined,
      operationInProgress: undefined,
    };
    const journal = createInMemoryGitMutationJournal();
    const request = {
      command: { kind: "commit" as const, message: "once", allowEmpty: false },
      approval: NO_APPROVAL,
      idempotencyKey: "commit-once",
    };
    const orchestratorDeps = {
      adapter: ad,
      snapshot,
      repoPolicyPack: ALLOW_ALL,
      now: (): number => 1,
      newActionId: (): string => "action-1",
      journal,
    };

    const first = await runGitMutation(request, orchestratorDeps);
    expect(first.outcome.status).toBe("succeeded");
    const second = await runGitMutation(request, orchestratorDeps);
    expect(second).toBe(first); // replayed from the journal, not re-executed
    expect(git(["rev-list", "--count", "HEAD"]).trim()).toBe("1"); // exactly one commit exists
  });
});

// ─── The user's git identity and signing configuration must reach the commit ───────────────────
//
// The suites above deliberately pass NO HOME, so the identity lane falls back to the ephemeral
// empty home and the commit identity comes from the repository's LOCAL config — that keeps them
// hermetic. These two exercise the opposite, production-shaped case: a repository with NO local
// identity, and a real HOME whose ~/.gitconfig carries the identity and the signing policy. With an
// empty HOME neither is readable, so a governed commit either cannot run at all or lands UNSIGNED
// while reporting success in a repository whose configuration demands a signature.

let identityHome: string;
let identityRepo: string;

function homeGit(args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd: identityRepo, encoding: "utf8" });
}

function identityAdapter(): GitLocalMutationAdapter {
  return createNodeGitMutationAdapter({
    workspace: workspaceInfo(identityRepo),
    processEnv: { PATH: process.env.PATH ?? "", HOME: identityHome },
    now: () => Date.now(),
  });
}

function writeGlobalGitConfig(body: string): void {
  writeFileSync(join(identityHome, ".gitconfig"), body, "utf8");
}

// A git-config value treats `\` as an escape, so a Windows path written verbatim (`C:\Users\…`) is
// a malformed config line. Escaping the backslash keeps the exact path; POSIX paths are unchanged.
function gitConfigPathValue(path: string): string {
  return path.replaceAll("\\", "\\\\");
}

function globalSshSigningConfig(email: string): string {
  const keyPath = join(identityHome, "global-ssh-signing-key");
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", email, "-f", keyPath], {
    cwd: identityHome,
  });
  const publicKey = readFileSync(`${keyPath}.pub`, "utf8").trim();
  const allowedSigners = join(identityHome, "global-allowed-signers");
  writeFileSync(allowedSigners, `${email} ${publicKey}\n`, "utf8");
  return (
    `[user]\n\tname = Global Dev\n\temail = ${email}\n\tsigningkey = ${gitConfigPathValue(`${keyPath}.pub`)}\n` +
    `[commit]\n\tgpgsign = true\n[gpg]\n\tformat = ssh\n` +
    `[gpg "ssh"]\n\tallowedSignersFile = ${gitConfigPathValue(allowedSigners)}\n`
  );
}

describe("node git mutation adapter — global identity and signing policy", () => {
  beforeEach(() => {
    identityHome = realpathSync(mkdtempSync(join(tmpdir(), "keiko-git-home-")));
    identityRepo = realpathSync(mkdtempSync(join(tmpdir(), "keiko-git-identity-")));
    execFileSync("git", ["init", "-q"], { cwd: identityRepo });
    // Deliberately NO local user.name / user.email: the only identity is the global one below.
    writeFileSync(join(identityRepo, "a.txt"), "hello\n", "utf8");
  });

  afterEach(() => {
    rmSync(identityRepo, { recursive: true, force: true });
    rmSync(identityHome, { recursive: true, force: true });
  });

  it("commits as the identity in the user's global ~/.gitconfig", async () => {
    writeGlobalGitConfig(globalSshSigningConfig("global@example.com"));
    const ad = identityAdapter();

    expect((await ad.stage({ pathspecs: ["a.txt"] })).outcome).toBe("succeeded");
    const committed = await ad.commit({ message: "feat: governed commit", allowEmpty: false });

    expect(committed.outcome).toBe("succeeded");
    expect(homeGit(["log", "-1", "--format=%an <%ae>"]).trim()).toBe(
      "Global Dev <global@example.com>",
    );
    expectLastCommitSigned(identityRepo, identityHome);
  });

  it("FAILS the commit when signing is required and the signing key cannot sign", async () => {
    writeGlobalGitConfig(
      `[user]\n\tname = Global Dev\n\temail = global@example.com\n\tsigningkey = ${gitConfigPathValue(
        join(identityHome, "missing-key.pub"),
      )}\n[commit]\n\tgpgsign = true\n[gpg]\n\tformat = ssh\n`,
    );
    const ad = identityAdapter();
    expect((await ad.stage({ pathspecs: ["a.txt"] })).outcome).toBe("succeeded");

    const committed = await ad.commit({ message: "feat: governed commit", allowEmpty: false });

    // A commit that cannot carry the required signature must never be reported as succeeded, and
    // must leave no unsigned commit behind.
    expect(committed.outcome).toBe("failed");
    expect(committed.errorCode).toBe("signature-failed");
    expect(homeGit(["rev-list", "--count", "--all"]).trim()).toBe("0");
  });

  it("ignores repository-local signing executables while retaining the global identity", async () => {
    const signerMarker = join(identityHome, "repository-signer-invoked");
    const repositorySigner = join(identityRepo, "repository-signer.sh");
    writeFileSync(repositorySigner, `#!/bin/sh\ntouch ${signerMarker}\nexit 1\n`, "utf8");
    chmodSync(repositorySigner, 0o755);
    writeGlobalGitConfig(globalSshSigningConfig("global@example.com"));
    execFileSync("git", ["config", "commit.gpgSign", "true"], { cwd: identityRepo });
    execFileSync("git", ["config", "gpg.ssh.program", repositorySigner], { cwd: identityRepo });
    const ad = identityAdapter();
    expect((await ad.stage({ pathspecs: ["a.txt"] })).outcome).toBe("succeeded");

    const committed = await ad.commit({ message: "feat: governed commit", allowEmpty: false });

    expect(committed.outcome).toBe("succeeded");
    expect(existsSync(signerMarker)).toBe(false);
    expect(homeGit(["log", "-1", "--format=%an <%ae>"]).trim()).toBe(
      "Global Dev <global@example.com>",
    );
    expectLastCommitSigned(identityRepo, identityHome);
  });
});

// ─── Exact staging follows Git's EFFECTIVE line-ending configuration ─────────────────────────────
//
// Git resolves `core.autocrlf` / `core.safecrlf` like every single-valued key: the most specific
// scope that sets it wins. Git for Windows installs `core.autocrlf=true` in its SYSTEM scope by
// default, so a check that refuses on ANY scope's `true` refused every repository on a stock Windows
// host. The effective value decides: with no conversion the verified bytes are staged as they are;
// under a conversion a file is admitted only when Git's built-in conversion of it checks the verified
// bytes out again exactly (#4491), and every other file is still refused.
describe("node git mutation adapter — stage normalization follows the effective Git configuration", () => {
  let normalizationHome: string;

  beforeEach(() => {
    normalizationHome = realpathSync(mkdtempSync(join(tmpdir(), "keiko-git-normalization-")));
    writeFileSync(join(root, "a.txt"), "hello\n", "utf8");
  });

  afterEach(() => {
    rmSync(normalizationHome, { recursive: true, force: true });
  });

  function stageSupported(paths: readonly string[] = ["a.txt"]): Promise<GitStageSupport> {
    return readGitStageSupport(
      {
        workspace: info,
        processEnv: { PATH: process.env.PATH ?? "", HOME: normalizationHome },
        now: () => Date.now(),
      },
      paths,
    );
  }

  function writeHomeGitConfig(body: string): void {
    writeFileSync(join(normalizationHome, ".gitconfig"), body, "utf8");
  }

  it("admits exact staging when the repository-local scope disables an outer autocrlf", async () => {
    writeHomeGitConfig("[core]\n\tautocrlf = true\n\tsafecrlf = true\n");
    git(["config", "core.autocrlf", "false"]);
    git(["config", "core.safecrlf", "false"]);

    expect(await stageSupported()).toBe("supported");
  });

  it("admits a file Git stores unchanged under an outer autocrlf that is not overridden", async () => {
    writeHomeGitConfig("[core]\n\tautocrlf = true\n");

    expect(await stageSupported()).toBe("supported");
  });

  it("admits a file whose every line break is CRLF under an outer autocrlf", async () => {
    writeHomeGitConfig("[core]\n\tautocrlf = true\n");
    writeFileSync(join(root, "a.txt"), "hello\r\nworld\r\n", "utf8");

    expect(await stageSupported()).toBe("supported");
  });

  it("refuses a file with mixed line breaks under an outer autocrlf", async () => {
    writeHomeGitConfig("[core]\n\tautocrlf = true\n");
    writeFileSync(join(root, "a.txt"), "hello\r\nworld\n", "utf8");

    expect(await stageSupported()).toBe("content-conversion");
  });

  // Audit of #4491: Git keeps the bytes of a path whose index entry already stores a CR, so a mixed
  // file over a CRLF index entry is admitted, while the same file over an LF entry is refused above.
  it("admits a mixed file whose index entry already stores CRLF under an outer autocrlf", async () => {
    writeHomeGitConfig("[core]\n\tautocrlf = true\n");
    writeFileSync(join(root, "a.txt"), "hello\r\n", "utf8");
    git(["-c", "core.autocrlf=false", "add", "a.txt"]);
    writeFileSync(join(root, "a.txt"), "hello\r\nworld\n", "utf8");

    expect(await stageSupported()).toBe("supported");
  });

  // Git still honours the legacy `crlf` attribute (`crlf=input` acts as `eol=lf`): a raw stage of a
  // CRLF file there would differ from what Git checks against, so it stays refused. `text` and `eol`
  // are admitted since #4491 and judged by their round trip (git-stage-node.test.ts).
  it("refuses exact staging when the legacy crlf attribute asks for a conversion", async () => {
    writeHomeGitConfig("[core]\n\tautocrlf = false\n\tsafecrlf = false\n");
    writeFileSync(join(root, ".gitattributes"), "*.txt crlf=input\n", "utf8");
    writeFileSync(join(root, "a.txt"), "hello\r\n", "utf8");

    expect(await stageSupported()).toBe("attribute-line-ending");
  });

  it("refuses a CRLF file when the repository-local scope enables autocrlf=input", async () => {
    writeHomeGitConfig("[core]\n\tautocrlf = false\n\tsafecrlf = false\n");
    git(["config", "core.autocrlf", "input"]);
    git(["config", "core.safecrlf", "false"]);
    writeFileSync(join(root, "a.txt"), "hello\r\n", "utf8");

    expect(await stageSupported()).toBe("content-conversion");
  });

  // PR #4568 review: a configured value may hold a newline. Read as lines, the continuation of a
  // filter command would pose as a later `core.autocrlf` and override the effective one.
  it("never reads a newline inside a configured value as another key", async () => {
    writeHomeGitConfig("[core]\n\tautocrlf = input\n\tsafecrlf = false\n");
    appendFileSync(
      join(root, ".git", "config"),
      '[filter "lab"]\n\tclean = "cat\\ncore.autocrlf false"\n',
      "utf8",
    );
    expect(git(["config", "--get", "filter.lab.clean"])).toContain("\ncore.autocrlf false");
    writeFileSync(join(root, "a.txt"), "hello\r\n", "utf8");

    expect(await stageSupported()).toBe("content-conversion");
  });

  // PR #4568 audit: a configured filter driver whose name cannot be overridden on the command line
  // refuses the stage as unsupported instead of failing the proposal with an unhandled error.
  it("refuses, without throwing, a conversion while a filter driver name cannot be neutralized", async () => {
    writeHomeGitConfig("[core]\n\tautocrlf = true\n");
    appendFileSync(join(root, ".git", "config"), '[filter "a=b"]\n\tclean = cat\n', "utf8");
    writeFileSync(join(root, "a.txt"), "hello\r\nworld\r\n", "utf8");

    await expect(stageSupported()).resolves.toBe("filter-driver");
  });

  it("refuses exact staging while core.safecrlf resolves to anything but false", async () => {
    writeHomeGitConfig("[core]\n\tautocrlf = false\n\tsafecrlf = warn\n");

    expect(await stageSupported()).toBe("config-unsupported");
  });

  // Review finding on PR #4568: the mode a verified staging hashed under is read once, so a change
  // to `core.autocrlf` while it runs would have left the converted blob in an index promoted under
  // the other mode. The check before promotion rereads it and refuses.
  it("refuses a verified staging whose core.autocrlf changes while it runs, leaving the index alone", async () => {
    git(["config", "core.autocrlf", "false"]);
    writeFileSync(join(root, "a.txt"), "hello\n", "utf8");
    git(["add", "a.txt"]);
    git(["commit", "-qm", "base"]);
    git(["branch", "base"]);
    git(["checkout", "-qb", "work"]);
    git(["config", "core.autocrlf", "true"]);
    writeFileSync(join(root, "b.txt"), "one\r\ntwo\r\n", "utf8");
    const headSha = git(["rev-parse", "HEAD"]).trim();
    const verified: GitVerifiedCommitPrecondition = {
      head: { kind: "born", sha: headSha },
      stagedTreeDigest: await readGitIndexTreeDigest({
        workspace: info,
        processEnv: { PATH: process.env.PATH ?? "" },
      }),
      branchName: "work",
      baseRef: "base",
      base: { kind: "born", sha: headSha },
    };
    const index = git(["ls-files", "--stage"]);
    let flipped = false;
    const racing = createNodeGitMutationAdapter({
      workspace: info,
      processEnv: { PATH: process.env.PATH ?? "" },
      now: () => Date.now(),
      beforeIndexUpdate: () => {
        if (!flipped) {
          flipped = true;
          git(["config", "core.autocrlf", "false"]);
        }
        return true;
      },
    });

    const staged = await racing.stage({ pathspecs: ["b.txt"], verified });

    expect(flipped).toBe(true);
    expect(staged.outcome).toBe("failed");
    expect(git(["ls-files", "--stage"])).toBe(index);
  });

  it("refuses exact staging when a key is set without a value, which Git reads as true", async () => {
    writeHomeGitConfig("[core]\n\tautocrlf = false\n");
    git(["config", "core.autocrlf", "false"]);
    writeFileSync(
      join(root, ".git", "config"),
      `${readFileSync(join(root, ".git", "config"), "utf8")}[core]\n\tsafecrlf\n`,
      "utf8",
    );

    expect(await stageSupported()).toBe("config-unsupported");
  });

  // #4491: the refusal names ONE closed cause. An attribute rule that matches only Markdown refuses
  // the Markdown file while a TypeScript file stages, in a repository whose autocrlf and safecrlf are
  // unset everywhere (the config hint the model used to receive could not have helped).
  describe("names the cause of a refusal", () => {
    beforeEach(() => {
      writeHomeGitConfig("[user]\n\tname = x\n");
      writeFileSync(join(root, "doc.md"), "# doc\n", "utf8");
      writeFileSync(join(root, "code.ts"), "export {};\n", "utf8");
    });

    it("refuses an attribute rule for *.md only and stages *.ts", async () => {
      writeFileSync(join(root, ".gitattributes"), "*.md filter=lfs\n", "utf8");

      expect(await stageSupported(["doc.md"])).toBe("attribute-filter");
      expect(await stageSupported(["code.ts"])).toBe("supported");
      expect(await stageSupported(["code.ts", "doc.md"])).toBe("attribute-filter");
    });

    it("reads a rule that lives only in .git/info/attributes", async () => {
      appendFileSync(join(root, ".git", "info", "attributes"), "*.md ident\n", "utf8");

      expect(await stageSupported(["doc.md"])).toBe("attribute-ident");
      expect(await stageSupported(["code.ts"])).toBe("supported");
    });

    it("names a working-tree-encoding rule", async () => {
      writeFileSync(join(root, ".gitattributes"), "*.md working-tree-encoding=UTF-16\n", "utf8");

      expect(await stageSupported(["doc.md"])).toBe("attribute-encoding");
    });

    it("names a line-ending rule outside the admitted values", async () => {
      writeFileSync(join(root, ".gitattributes"), "*.md eol=bogus\n", "utf8");

      expect(await stageSupported(["doc.md"])).toBe("attribute-line-ending");
    });

    it("names a configuration Git cannot read as a verified staging admits", async () => {
      git(["config", "core.autocrlf", "bogus"]);

      expect(await stageSupported(["code.ts"])).toBe("config-unsupported");
    });

    it("names a filter driver that cannot be neutralised before any attribute", async () => {
      appendFileSync(join(root, ".git", "config"), '[filter "a=b"]\n\tclean = cat\n', "utf8");
      writeFileSync(join(root, ".gitattributes"), "*.md filter=lfs\n", "utf8");

      expect(await stageSupported(["doc.md"])).toBe("filter-driver");
    });

    it("names a file whose line breaks would not round-trip", async () => {
      git(["config", "core.autocrlf", "true"]);
      writeFileSync(join(root, "code.ts"), "a\r\nb\n", "utf8");

      expect(await stageSupported(["code.ts"])).toBe("content-conversion");
    });
  });
});

// ─── Signing follows Git's effective `commit.gpgsign` (ADR-0006, #4491) ─────────────────────────
//
// A person who never set up commit signing gets the commit Git itself would make: unsigned, with
// neither `--gpg-sign` nor `--no-gpg-sign` on the argv. A person who did gets a signed commit, and a
// signer that cannot sign fails visibly instead of falling back to an unsigned commit. An unreadable
// or malformed value fails closed toward signing.
describe("node git mutation adapter — signing follows the effective commit.gpgsign", () => {
  function lastSignatureState(): string {
    return git(["log", "-1", "--format=%G?"]).trim();
  }

  async function stagedCommit(): Promise<Awaited<ReturnType<GitLocalMutationAdapter["commit"]>>> {
    writeFileSync(join(root, "a.txt"), "hello\n", "utf8");
    const ad = adapter();
    expect((await ad.stage({ pathspecs: ["a.txt"] })).outcome).toBe("succeeded");
    return ad.commit({ message: "feat: governed commit", allowEmpty: false });
  }

  it("signs and reports `configured` when the repository enables signing", async () => {
    const committed = await stagedCommit();

    expect(committed.outcome).toBe("succeeded");
    expect(committed.signing).toBe("configured");
    expectLastCommitSigned(root);
  });

  it("commits unsigned, as Git itself would, when commit.gpgsign is not set anywhere", async () => {
    git(["config", "--unset", "commit.gpgsign"]);

    const committed = await stagedCommit();

    expect(committed.outcome).toBe("succeeded");
    expect(committed.signing).toBe("not-configured");
    expect(lastSignatureState()).toBe("N");
  });

  it("commits unsigned when commit.gpgsign is false", async () => {
    git(["config", "commit.gpgsign", "false"]);

    const committed = await stagedCommit();

    expect(committed.outcome).toBe("succeeded");
    expect(committed.signing).toBe("not-configured");
    expect(lastSignatureState()).toBe("N");
  });

  it("reads Git boolean spellings: `off` does not sign, `yes` does", async () => {
    git(["config", "commit.gpgsign", "off"]);
    expect((await stagedCommit()).signing).toBe("not-configured");
    expect(lastSignatureState()).toBe("N");

    git(["config", "commit.gpgsign", "yes"]);
    const signed = await adapter().commit({ message: "feat: second", allowEmpty: true });
    expect(signed.signing).toBe("configured");
    expectLastCommitSigned(root);
  });

  it("never falls back to an unsigned commit when the configured signer fails", async () => {
    git(["config", "user.signingkey", join(root, "missing-key.pub")]);

    const committed = await stagedCommit();

    expect(committed.outcome).toBe("failed");
    expect(committed.errorCode).toBe("signature-failed");
    expect(committed.signing).toBe("configured");
    expect(git(["rev-list", "--count", "--all"]).trim()).toBe("0");
  });

  it("fails closed on a malformed value: it attempts to sign and commits nothing unsigned", async () => {
    git(["config", "commit.gpgsign", "maybe"]);

    const committed = await stagedCommit();

    expect(committed.signing).toBe("unknown-fail-closed");
    expect(committed.outcome).toBe("failed");
    expect(git(["rev-list", "--count", "--all"]).trim()).toBe("0");
  });
});

describe("node git mutation adapter — signing scopes and branch protection", () => {
  let scopeHome: string;

  beforeEach(() => {
    scopeHome = realpathSync(mkdtempSync(join(tmpdir(), "keiko-git-scope-home-")));
  });

  afterEach(() => {
    rmSync(scopeHome, { recursive: true, force: true });
  });

  function scopedAdapter(required?: boolean): GitLocalMutationAdapter {
    return createNodeGitMutationAdapter({
      workspace: info,
      processEnv: { PATH: process.env.PATH ?? "", HOME: scopeHome },
      now: () => Date.now(),
      ...(required === undefined
        ? {}
        : { signingRequiredByBranchProtection: () => Promise.resolve(required) }),
    });
  }

  async function commitWith(
    ad: GitLocalMutationAdapter,
  ): Promise<Awaited<ReturnType<GitLocalMutationAdapter["commit"]>>> {
    writeFileSync(join(root, "a.txt"), "hello\n", "utf8");
    expect((await ad.stage({ pathspecs: ["a.txt"] })).outcome).toBe("succeeded");
    return ad.commit({ message: "feat: governed commit", allowEmpty: false });
  }

  it("follows Git: a repository commit.gpgsign=false beats a global true, so the commit is unsigned", async () => {
    writeFileSync(join(scopeHome, ".gitconfig"), "[commit]\n\tgpgsign = true\n", "utf8");
    git(["config", "commit.gpgsign", "false"]);

    const committed = await commitWith(scopedAdapter());

    expect(committed.outcome).toBe("succeeded");
    expect(committed.signing).toBe("not-configured");
    expect(git(["log", "-1", "--format=%G?"]).trim()).toBe("N");
  });

  it("signs when the true value comes from an included file", async () => {
    const included = join(scopeHome, "signing.inc");
    writeFileSync(included, "[commit]\n\tgpgsign = true\n", "utf8");
    git(["config", "--unset", "commit.gpgsign"]);
    git(["config", "include.path", included]);

    const committed = await commitWith(scopedAdapter());

    expect(committed.outcome).toBe("succeeded");
    expect(committed.signing).toBe("configured");
    expectLastCommitSigned(root);
  });

  it("signs an unset commit.gpgsign when branch protection requires signatures", async () => {
    git(["config", "--unset", "commit.gpgsign"]);

    const committed = await commitWith(scopedAdapter(true));

    expect(committed.outcome).toBe("succeeded");
    expect(committed.signing).toBe("required-by-branch-protection");
    expectLastCommitSigned(root);
  });

  it("fails visibly, and commits nothing unsigned, when a required signature cannot be made", async () => {
    git(["config", "--unset", "commit.gpgsign"]);
    git(["config", "user.signingkey", join(root, "missing-key.pub")]);

    const committed = await commitWith(scopedAdapter(true));

    expect(committed.outcome).toBe("failed");
    expect(committed.errorCode).toBe("signature-failed");
    expect(committed.signing).toBe("required-by-branch-protection");
    expect(git(["rev-list", "--count", "--all"]).trim()).toBe("0");
  });

  it("commits unsigned when commit.gpgsign is unset and branch protection does not require it", async () => {
    git(["config", "--unset", "commit.gpgsign"]);

    const committed = await commitWith(scopedAdapter(false));

    expect(committed.outcome).toBe("succeeded");
    expect(committed.signing).toBe("not-configured");
    expect(git(["log", "-1", "--format=%G?"]).trim()).toBe("N");
  });
});

// A blob a UTF-8 decoder cannot carry through (a binary file) cannot be told from its batch answer,
// so the batch is halved around it. That isolation is paid from a budget: a selection of nothing but
// binaries must cost no more than the one-by-one read always did.
describe("blob texts of binary selections", () => {
  function counting(): {
    readonly deps: Parameters<typeof readGitBlobTextsWithin>[0];
    readonly argvs: string[][];
  } {
    const argvs: string[][] = [];
    const spawn: SpawnFn = (command, args, options) => {
      argvs.push([...args]);
      return nodeSpawnFn(command, args, options);
    };
    return {
      deps: {
        workspace: info,
        processEnv: { PATH: process.env.PATH ?? "" },
        spawn,
        readSession: createGitReadSession(),
      },
      argvs,
    };
  }

  function binary(seed: number): string {
    return execFileSync("git", ["hash-object", "-w", "--stdin"], {
      cwd: root,
      input: Uint8Array.from([0x89, 0x50, 0xff, 0xfe, seed % 256, Math.floor(seed / 256)]),
      encoding: "utf8",
    }).trim();
  }

  function text(seed: number): string {
    return execFileSync("git", ["hash-object", "-w", "--stdin"], {
      cwd: root,
      input: `text ${String(seed)}\n`,
      encoding: "utf8",
    }).trim();
  }

  it.each([1, 2, 3, 20])(
    "never costs more for %i binary blobs than reading them one by one",
    async (count) => {
      const ids = Array.from({ length: count }, (_, at) => binary(at));
      const old = counting();
      for (const id of ids) await readGitBlobTextWithin(old.deps, id, 4096);
      const oldProcesses = old.argvs.length;
      const batched = counting();
      const texts = await readGitBlobTextsWithin(batched.deps, ids, 4096);
      expect(batched.argvs.length).toBeLessThanOrEqual(oldProcesses);
      for (const id of ids)
        expect(texts.get(id), id).toBe(await readGitBlobTextWithin(old.deps, id, 4096));
    },
  );

  it("isolates a few binary blobs among many texts without a process per blob", async () => {
    const ids = Array.from({ length: 60 }, (_, at) => (at % 20 === 7 ? binary(at) : text(at)));
    const { deps, argvs } = counting();
    const texts = await readGitBlobTextsWithin(deps, ids, 4096);
    expect(texts.size).toBe(60);
    expect(argvs.length).toBeLessThan(60);
  });

  it("asks for the sizes of many blobs in runs the stdin bound carries", async () => {
    const ids = Array.from({ length: 450 }, (_, at) => text(at));
    const { deps, argvs } = counting();
    await readGitBlobTextsWithin(deps, ids, 4096);
    expect(argvs.filter((argv) => argv.includes("--batch-check"))).toHaveLength(2);
  });
});
