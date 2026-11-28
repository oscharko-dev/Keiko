// Integration coverage for the Node governed Git mutation adapter (Issue #472) — AC3/AC5.
// Exercises the real spawn boundary against a disposable, hermetic git repository: governed local
// mutations actually run through `git` with the dedicated allowlist, and failures map to structured
// results without any string parsing. The suites that pass no HOME use local repo config only, so no
// global git state is read or written and the run is deterministic. The final suite drives the
// identity lane on purpose, against a DISPOSABLE HOME it creates itself — never the developer's.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  GitDeliveryRepoPolicyPack,
  GitDeliveryApprovalRequirement,
} from "@oscharko-dev/keiko-contracts";
import { GIT_DELIVERY_POLICY_SCHEMA_VERSION } from "@oscharko-dev/keiko-contracts/runtime/git-delivery-policy";
import type { WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import {
  createGitReadSession,
  createNodeGitMutationAdapter,
  readGitStageSupport,
} from "./git-mutation-node.js";
import { nodeSpawnFn, type SpawnFn } from "./exec.js";
import type {
  GitLocalMutationAdapter,
  GitVerifiedCommitPrecondition,
} from "./git-mutation-adapter.js";
import { readGitIndexTreeDigest } from "./git-worktree-snapshot-node.js";
import type { GitWorktreeSnapshot } from "./git-mutation-preflight.js";
import { createInMemoryGitMutationJournal, runGitMutation } from "./git-mutation-orchestrator.js";

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

  function countingAdapter(options: { readonly readSession?: boolean } = {}): {
    readonly adapter: GitLocalMutationAdapter;
    readonly probes: () => number;
    readonly processes: () => number;
  } {
    let probes = 0;
    let processes = 0;
    const spawn: SpawnFn = (command, args, spawnOptions) => {
      processes += 1;
      if (args.includes(PROMISOR_PROBE)) probes += 1;
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

  function stageSupported(): Promise<boolean> {
    return readGitStageSupport(
      {
        workspace: info,
        processEnv: { PATH: process.env.PATH ?? "", HOME: normalizationHome },
        now: () => Date.now(),
      },
      ["a.txt"],
    );
  }

  function writeHomeGitConfig(body: string): void {
    writeFileSync(join(normalizationHome, ".gitconfig"), body, "utf8");
  }

  it("admits exact staging when the repository-local scope disables an outer autocrlf", async () => {
    writeHomeGitConfig("[core]\n\tautocrlf = true\n\tsafecrlf = true\n");
    git(["config", "core.autocrlf", "false"]);
    git(["config", "core.safecrlf", "false"]);

    expect(await stageSupported()).toBe(true);
  });

  it("admits a file Git stores unchanged under an outer autocrlf that is not overridden", async () => {
    writeHomeGitConfig("[core]\n\tautocrlf = true\n");

    expect(await stageSupported()).toBe(true);
  });

  it("admits a file whose every line break is CRLF under an outer autocrlf", async () => {
    writeHomeGitConfig("[core]\n\tautocrlf = true\n");
    writeFileSync(join(root, "a.txt"), "hello\r\nworld\r\n", "utf8");

    expect(await stageSupported()).toBe(true);
  });

  it("refuses a file with mixed line breaks under an outer autocrlf", async () => {
    writeHomeGitConfig("[core]\n\tautocrlf = true\n");
    writeFileSync(join(root, "a.txt"), "hello\r\nworld\n", "utf8");

    expect(await stageSupported()).toBe(false);
  });

  // Audit of #4491: Git keeps the bytes of a path whose index entry already stores a CR, so a mixed
  // file over a CRLF index entry is admitted, while the same file over an LF entry is refused above.
  it("admits a mixed file whose index entry already stores CRLF under an outer autocrlf", async () => {
    writeHomeGitConfig("[core]\n\tautocrlf = true\n");
    writeFileSync(join(root, "a.txt"), "hello\r\n", "utf8");
    git(["-c", "core.autocrlf=false", "add", "a.txt"]);
    writeFileSync(join(root, "a.txt"), "hello\r\nworld\n", "utf8");

    expect(await stageSupported()).toBe(true);
  });

  // Git still honours the legacy `crlf` attribute (`crlf=input` acts as `eol=lf`): a raw stage of a
  // CRLF file there would differ from what Git checks against, so it stays refused. `text` and `eol`
  // are admitted since #4491 and judged by their round trip (git-stage-node.test.ts).
  it("refuses exact staging when the legacy crlf attribute asks for a conversion", async () => {
    writeHomeGitConfig("[core]\n\tautocrlf = false\n\tsafecrlf = false\n");
    writeFileSync(join(root, ".gitattributes"), "*.txt crlf=input\n", "utf8");
    writeFileSync(join(root, "a.txt"), "hello\r\n", "utf8");

    expect(await stageSupported()).toBe(false);
  });

  it("refuses a CRLF file when the repository-local scope enables autocrlf=input", async () => {
    writeHomeGitConfig("[core]\n\tautocrlf = false\n\tsafecrlf = false\n");
    git(["config", "core.autocrlf", "input"]);
    git(["config", "core.safecrlf", "false"]);
    writeFileSync(join(root, "a.txt"), "hello\r\n", "utf8");

    expect(await stageSupported()).toBe(false);
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

    expect(await stageSupported()).toBe(false);
  });

  // PR #4568 audit: a configured filter driver whose name cannot be overridden on the command line
  // refuses the stage as unsupported instead of failing the proposal with an unhandled error.
  it("refuses, without throwing, a conversion while a filter driver name cannot be neutralized", async () => {
    writeHomeGitConfig("[core]\n\tautocrlf = true\n");
    appendFileSync(join(root, ".git", "config"), '[filter "a=b"]\n\tclean = cat\n', "utf8");
    writeFileSync(join(root, "a.txt"), "hello\r\nworld\r\n", "utf8");

    await expect(stageSupported()).resolves.toBe(false);
  });

  it("refuses exact staging while core.safecrlf resolves to anything but false", async () => {
    writeHomeGitConfig("[core]\n\tautocrlf = false\n\tsafecrlf = warn\n");

    expect(await stageSupported()).toBe(false);
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

    expect(await stageSupported()).toBe(false);
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
