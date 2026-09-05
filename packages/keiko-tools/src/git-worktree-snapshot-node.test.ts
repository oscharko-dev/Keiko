// Integration coverage for the read-only worktree snapshot reader (Issue #475). Exercises the real
// read-only spawn boundary against a disposable, hermetic git repository: the reader builds a content-
// free GitWorktreeSnapshot from live `git status/branch/remote` output and lists staged paths, without
// any write subcommand reaching the dedicated read allowlist.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gitEnv } from "@oscharko-dev/keiko-git";
import type { WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import { recordingSpawn } from "./_support.js";
import {
  GIT_WORKTREE_READ_COMMAND_RULES,
  GitWorktreeReadError,
  readGitRemoteAliases,
  readGitRemoteUrl,
  readGitPushRemoteUrls,
  readGitWorktreeSnapshot,
  readStagedConflictMarkerFileCount,
  readStagedPaths,
  type NodeGitWorktreeReaderDeps,
} from "./git-worktree-snapshot-node.js";
import { isCommandAllowed } from "./sandbox.js";
import { DEFAULT_SANDBOX_POLICY, GOVERNED_GIT_REMOTE_CREDENTIAL_ENV_ALLOWLIST } from "./types.js";

let root: string;
let info: WorkspaceInfo;
// Disposable directories a test created beside the repository (fake homes/config dirs).
const scratchDirs: string[] = [];

function git(args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd: root, encoding: "utf8" });
}

const CONFIGURED_REMOTE_URL = "https://github.com/alicedev-team/App.git";

// A disposable directory carrying ONE global-scope git config whose `url.<base>.insteadOf` rule
// rewrites every github.com URL onto an enterprise mirror — the exact shape of a corporate
// `~/.gitconfig` (`home`) or `$XDG_CONFIG_HOME/git/config` (`xdg`).
function makeRewritingConfigDir(scope: "home" | "xdg", mirrorBase: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `keiko-git-${scope}-`)));
  scratchDirs.push(dir);
  const configPath = scope === "home" ? join(dir, ".gitconfig") : join(dir, "git", "config");
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, `[url "${mirrorBase}"]\n\tinsteadOf = https://github.com/\n`, "utf8");
  return dir;
}

// Drives readGitRemoteUrl through the injected spawn seam and returns the env the git child
// RECEIVED. The fake child answers with one URL line so the read completes on its normal path.
async function captureRemoteUrlReadEnv(
  processEnv: NodeJS.ProcessEnv,
): Promise<Record<string, string>> {
  const spawn = recordingSpawn();
  const pending = readGitRemoteUrl(
    { workspace: info, processEnv, now: () => Date.now(), spawn: spawn.fn },
    "origin",
  );
  spawn.child.stdout.emit("data", Buffer.from(`${CONFIGURED_REMOTE_URL}\n`, "utf8"));
  spawn.child.emit("close", 0, null);
  await pending;
  return spawn.calls()[0]?.options.env ?? {};
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

function deps(): NodeGitWorktreeReaderDeps {
  return { workspace: info, processEnv: { PATH: process.env.PATH ?? "" }, now: () => Date.now() };
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-git-read-")));
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "test@keiko.example"]);
  git(["config", "user.name", "Keiko Test"]);
  git(["config", "commit.gpgsign", "false"]);
  info = workspaceInfo(root);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  for (const dir of scratchDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("read-only allowlist", () => {
  it("permits only inspection subcommands and denies every mutation/network verb", () => {
    for (const sub of ["status", "rev-parse", "branch", "remote", "diff"]) {
      expect(isCommandAllowed(GIT_WORKTREE_READ_COMMAND_RULES, "git", [sub]).allowed).toBe(true);
    }
    for (const sub of ["commit", "add", "switch", "reset", "push", "fetch"]) {
      expect(isCommandAllowed(GIT_WORKTREE_READ_COMMAND_RULES, "git", [sub]).allowed).toBe(false);
    }
  });
});

describe("read-only lane git-version compatibility", () => {
  // Regression pin: this lane used to prepend `--no-lazy-fetch --no-replace-objects` as CLI flags
  // to every read (git-mutation-node.ts's write lane still does, correctly, for its own reason).
  // `--no-lazy-fetch` is a newer global option — absent on the git 2.43 that `ubuntu-latest` ships
  // — so on CI every read here exited 129 ("unknown option: --no-lazy-fetch") while the identical
  // read stayed green on a workstation with a newer git (#3384 CI: git-raw-worktree-node.test.ts
  // "never reflects the real upstream/ahead/behind state", draftDeliveryEffects.test.ts "refuses a
  // behind-upstream push"). Git's own docs state each flag is "equivalent to setting the
  // GIT_NO_(LAZY_FETCH|REPLACE_OBJECTS) environment variable", and `immutableReadPolicy` already
  // pins both env vars into every read this lane performs — so the CLI flags were a redundant,
  // version-incompatible duplicate. This pin fails if either flag reappears in the spawned argv.
  it("never passes --no-lazy-fetch/--no-replace-objects as CLI flags, only as pinned env vars", async () => {
    const spawn = recordingSpawn();
    const pending = readGitRemoteAliases({
      workspace: info,
      spawn: spawn.fn,
      now: () => Date.now(),
    });
    spawn.child.stdout.emit("data", Buffer.from("origin\n", "utf8"));
    spawn.child.emit("close", 0, null);
    await pending;
    const call = spawn.calls()[0];
    expect(call?.args).toEqual(["remote"]);
    expect(call?.options.env.GIT_NO_LAZY_FETCH).toBe("1");
    expect(call?.options.env.GIT_NO_REPLACE_OBJECTS).toBe("1");
  });
});

describe("readGitWorktreeSnapshot", () => {
  it("reports the current branch, staged/unstaged/untracked counts, and local branches", async () => {
    writeFileSync(join(root, "a.txt"), "v1\n", "utf8");
    git(["add", "a.txt"]);
    git(["commit", "-m", "base"]);
    git(["branch", "feature/x"]);
    // staged change
    writeFileSync(join(root, "a.txt"), "v2\n", "utf8");
    git(["add", "a.txt"]);
    // unstaged change to a tracked file
    writeFileSync(join(root, "a.txt"), "v3\n", "utf8");
    // untracked file
    writeFileSync(join(root, "u.txt"), "new\n", "utf8");

    const snap = await readGitWorktreeSnapshot(deps());
    expect(snap.headDetached).toBe(false);
    expect(snap.currentBranchName).toBe("main");
    expect(snap.stagedFileCount).toBe(1);
    expect(snap.unstagedFileCount).toBe(1);
    expect(snap.untrackedFileCount).toBe(1);
    expect([...snap.existingLocalBranchNames].sort()).toEqual(["feature/x", "main"]);
    expect(snap.hasUpstream).toBe(false);
    expect(snap.remoteAliases).toEqual([]);
    expect(snap.headSha).toBe(git(["rev-parse", "HEAD"]).trim());
    expect(snap.stagedTreeDigest).toMatch(/^[a-f0-9]{64}$/u);
    const stagedDigest = snap.stagedTreeDigest;
    git(["add", "a.txt"]);
    expect((await readGitWorktreeSnapshot(deps())).stagedTreeDigest).not.toBe(stagedDigest);
  });

  it("reports a detached HEAD", async () => {
    writeFileSync(join(root, "a.txt"), "v1\n", "utf8");
    git(["add", "a.txt"]);
    git(["commit", "-m", "base"]);
    git(["checkout", "--detach", "HEAD"]);

    const snap = await readGitWorktreeSnapshot(deps());
    expect(snap.headDetached).toBe(true);
    expect(snap.currentBranchName).toBeUndefined();
  });

  it("throws a content-free GitWorktreeReadError outside a git repository", async () => {
    const bare = realpathSync(mkdtempSync(join(tmpdir(), "keiko-not-git-")));
    try {
      await expect(
        readGitWorktreeSnapshot({ ...deps(), workspace: workspaceInfo(bare) }),
      ).rejects.toBeInstanceOf(GitWorktreeReadError);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});

describe("readStagedPaths", () => {
  it("lists exactly the staged relative paths", async () => {
    writeFileSync(join(root, "a.txt"), "v1\n", "utf8");
    git(["add", "a.txt"]);
    git(["commit", "-m", "base"]);
    writeFileSync(join(root, "b.txt"), "x\n", "utf8");
    writeFileSync(join(root, "c.txt"), "y\n", "utf8");
    git(["add", "b.txt", "c.txt"]);

    const staged = await readStagedPaths(deps());
    expect([...staged].sort()).toEqual(["b.txt", "c.txt"]);
  });

  it("returns an empty list when nothing is staged", async () => {
    writeFileSync(join(root, "a.txt"), "v1\n", "utf8");
    git(["add", "a.txt"]);
    git(["commit", "-m", "base"]);
    expect(await readStagedPaths(deps())).toEqual([]);
  });
});

describe("readGitRemoteUrl", () => {
  it("resolves exactly the configured URL for a safe remote alias", async () => {
    git(["remote", "add", "origin", "git@github.com:example/repository.git"]);
    expect(await readGitRemoteUrl(deps(), "origin")).toBe("git@github.com:example/repository.git");
  });

  it("rejects flag-shaped remote aliases before spawning git", async () => {
    await expect(readGitRemoteUrl(deps(), "--upload-pack=evil")).rejects.toBeInstanceOf(
      GitWorktreeReadError,
    );
  });

  // The case above cannot see this defect: `example/repository` collides with no environment value,
  // so it stayed green while every real owner that DID collide came back corrupted.
  //
  // `runCommand` scrubs the value of every env var that is not on the policy's `envAllowlist`. The
  // account names are exactly the ones that appear in a personal GitHub owner, so under the default
  // policy a user `alice` owning `alice-dev/App` read their own remote back as
  // `https://github.com/[REDACTED]-dev/App` and every consumer derived a repository that does not
  // exist. Reading this remote is a governed-identity operation, so it runs under the lane that
  // allowlists those names; that lane still grants no credential, so a token can never survive here.
  it("preserves an owner that collides with the account identity", async () => {
    git(["remote", "add", "origin", "https://github.com/alicedev-team/App.git"]);

    const url = await readGitRemoteUrl(
      {
        workspace: info,
        // At least MIN_SCRUBBABLE_VALUE_LENGTH characters on purpose: a shorter account name is
        // never scrubbed, so a fixture using one would pass under BOTH policies and pin nothing.
        processEnv: { PATH: process.env.PATH ?? "", USER: "alicedev", LOGNAME: "alicedev" },
        now: () => Date.now(),
      },
      "origin",
    );

    expect(url).toBe("https://github.com/alicedev-team/App.git");
    expect(url).not.toContain("[REDACTED]");
  });

  // The identity lane widens which NAMES are allowlisted, never what a credential may do: a token
  // value is still scrubbed out of this reader's output.
  // The defect that turned CI red on 56ffa39c, and that the first repair only hid from the tests:
  // a CI runner exports GITHUB_REPOSITORY=<owner/repo>, the default scrub treats that value as a
  // secret, and the checkout's OWN remote came back as `https://github.com/[REDACTED].git`. This
  // read's stdout IS the URL; a context value the parent happens to carry must not corrupt it.
  it("preserves the configured remote when a context variable carries the same owner/repo", async () => {
    git(["remote", "add", "origin", "https://github.com/alicedev-team/App.git"]);

    const url = await readGitRemoteUrl(
      {
        workspace: info,
        processEnv: {
          PATH: process.env.PATH ?? "",
          GITHUB_REPOSITORY: "alicedev-team/App",
          GITHUB_REPOSITORY_OWNER: "alicedev-team",
        },
        now: () => Date.now(),
      },
      "origin",
    );

    expect(url).toBe("https://github.com/alicedev-team/App.git");
  });

  // Narrowing the scrub to credentials must not narrow it below "anything whose name says it is a
  // credential": a token under a name the governed lanes never forward is still a token.
  it("still scrubs a credential-named value the governed lanes never forward", async () => {
    git(["remote", "add", "origin", "https://github.com/alicedev-team/deploy-tok3n-value.git"]);

    const url = await readGitRemoteUrl(
      {
        workspace: info,
        processEnv: { PATH: process.env.PATH ?? "", MY_DEPLOY_TOKEN: "deploy-tok3n-value" },
        now: () => Date.now(),
      },
      "origin",
    );

    expect(url).not.toContain("deploy-tok3n-value");
    expect(url).toContain("[REDACTED]");
  });

  it("still scrubs a credential value that appears in the output", async () => {
    git(["remote", "add", "origin", "https://github.com/alicedev-team/s3cr3t-token-value.git"]);

    const url = await readGitRemoteUrl(
      {
        workspace: info,
        processEnv: {
          PATH: process.env.PATH ?? "",
          USER: "alicedev",
          GH_TOKEN: "s3cr3t-token-value",
        },
        now: () => Date.now(),
      },
      "origin",
    );

    expect(url).not.toContain("s3cr3t-token-value");
    expect(url).toContain("[REDACTED]");
  });

  // The consumers use this URL as an AUTHORIZATION operand — which repository a checkout may read —
  // so it must be the remote the CHECKOUT configures, never a global rewrite of it. Under the
  // identity lane the child inherited the user's HOME, and `git remote get-url` applies every
  // `url.<base>.insteadOf` rule from `~/.gitconfig`: an enterprise mirror rule turned the resolved
  // URL into a non-GitHub one (every consumer denied), and an owner-rewriting rule changed the
  // owner the consumers authorized against.
  it("resolves the CONFIGURED remote, not a ~/.gitconfig insteadOf rewrite of it", async () => {
    git(["remote", "add", "origin", CONFIGURED_REMOTE_URL]);
    const fakeHome = makeRewritingConfigDir("home", "https://ghe.corp.example/mirror/");

    const url = await readGitRemoteUrl(
      {
        workspace: info,
        processEnv: { PATH: process.env.PATH ?? "", HOME: fakeHome, USER: "alicedev" },
        now: () => Date.now(),
      },
      "origin",
    );

    expect(url).toBe(CONFIGURED_REMOTE_URL);
  });

  // Same defect through git's OTHER global-scope location. `XDG_CONFIG_HOME` is on the identity
  // allowlist (the identity lane needs it for signing configuration), so isolating HOME alone
  // still let `$XDG_CONFIG_HOME/git/config` rewrite the URL; the global scope has to be switched
  // off as a whole.
  it("resolves the CONFIGURED remote, not an $XDG_CONFIG_HOME/git/config rewrite of it", async () => {
    git(["remote", "add", "origin", CONFIGURED_REMOTE_URL]);
    const fakeXdg = makeRewritingConfigDir("xdg", "https://xdg.corp.example/mirror/");

    const url = await readGitRemoteUrl(
      {
        workspace: info,
        processEnv: { PATH: process.env.PATH ?? "", XDG_CONFIG_HOME: fakeXdg, USER: "alicedev" },
        now: () => Date.now(),
      },
      "origin",
    );

    expect(url).toBe(CONFIGURED_REMOTE_URL);
  });

  // The "still scrubs a credential value" case above proves only OUTPUT scrubbing, which holds
  // under every lane. This pins the INPUT side: the read grants no credential, so none of the names
  // the remote-delivery lane forwards may reach the git child — while the account identity that
  // this read exists to keep unscrubbed still does.
  it("forwards no credential to the git child while keeping the account identity", async () => {
    const credentialNames = GOVERNED_GIT_REMOTE_CREDENTIAL_ENV_ALLOWLIST;
    expect(credentialNames.length).toBeGreaterThan(0);
    const env = await captureRemoteUrlReadEnv({
      PATH: process.env.PATH ?? "",
      USER: "alicedev",
      // Scrubbable-length values on purpose: a value below the scrub floor is never forwarded by
      // the credential lane either, so a short fixture would pass under BOTH lanes and pin nothing.
      ...Object.fromEntries(credentialNames.map((name) => [name, `${name}-must-not-reach-git`])),
    });

    for (const name of credentialNames) {
      expect(name in env, name).toBe(false);
    }
    expect(env.USER).toBe("alicedev");
  });

  // The two config scopes this read must NOT see, pinned on the child env itself: the system scope
  // cannot be exercised hermetically (no test may own the host's system gitconfig), and the global
  // scope must stay off even when the parent carries a real HOME.
  it("pins the child to the checkout's own git config scopes under an isolated home", async () => {
    const env = await captureRemoteUrlReadEnv({
      PATH: process.env.PATH ?? "",
      HOME: "/Users/parent",
      XDG_CONFIG_HOME: "/Users/parent/.config",
      USER: "alicedev",
    });

    expect(env.HOME).not.toBe("/Users/parent");
    expect(env.GIT_CONFIG_NOSYSTEM).toBe("1");
    // keiko-git's `gitEnv` is the product's config-isolated local-read profile; the platform null
    // device it pins for the global scope is the one this read must pin too.
    expect(env.GIT_CONFIG_GLOBAL).toBe(gitEnv({}).GIT_CONFIG_GLOBAL);
  });
});

describe("readStagedConflictMarkerFileCount", () => {
  // The gate FAILED OPEN here (PR #3355 review, P1). `git diff --cached --check` output is capped
  // like any other command; when the cap trips, runCommand kills git and replaces stdout with the
  // literal "[TRUNCATED OUTPUT REDACTED]". That placeholder is non-empty (so the emptiness guard let
  // it through) and matches no `path:line: leftover conflict marker` line (so the count came back
  // 0) — indistinguishable from a clean changeset. commitRoutes then permitted the commit and baked
  // the marker lines into history, which is the exact outcome this reader exists to prevent.
  //
  // Driven by a REAL truncation — a 1-byte output cap against a genuinely conflicted staged file —
  // rather than by a hand-built result object, so it stays true if the placeholder text ever changes.
  it("refuses to report a count when the diagnostic output was truncated", async () => {
    writeFileSync(join(root, "shared.txt"), "base\n", "utf8");
    git(["add", "shared.txt"]);
    git(["commit", "-m", "base"]);
    // A staged file carrying literal conflict markers: `--check` reports it and exits non-zero.
    writeFileSync(join(root, "shared.txt"), "<<<<<<< HEAD\na\n=======\nb\n>>>>>>> other\n", "utf8");
    git(["add", "shared.txt"]);

    const capped = {
      ...deps(),
      policy: { ...DEFAULT_SANDBOX_POLICY, maxOutputBytes: 1 },
    };
    await expect(readStagedConflictMarkerFileCount(capped)).rejects.toBeInstanceOf(
      GitWorktreeReadError,
    );
  });

  it("returns 0 for an ordinary staged change with no conflict markers", async () => {
    writeFileSync(join(root, "a.txt"), "v1\n", "utf8");
    git(["add", "a.txt"]);
    git(["commit", "-m", "base"]);
    writeFileSync(join(root, "a.txt"), "v2\n", "utf8");
    git(["add", "a.txt"]);
    expect(await readStagedConflictMarkerFileCount(deps())).toBe(0);
  });

  // Reproduces the exact defect (issue #4 of the audit): a real, unresolved merge conflict whose
  // markers are staged (`git add`-ed) WITHOUT being resolved. `git add` clears git's own "unmerged
  // path" state for that file — it is no longer reported as a conflict by `git status` — so nothing
  // upstream of this reader would ever notice; a commit of the current staged tree would silently
  // bake the literal `<<<<<<<`/`=======`/`>>>>>>>` marker lines into history.
  it("counts a REAL staged, unresolved merge conflict whose markers were git-add-ed without being resolved", async () => {
    writeFileSync(join(root, "shared.txt"), "base\n", "utf8");
    git(["add", "shared.txt"]);
    git(["commit", "-m", "base"]);
    git(["checkout", "-b", "branch-a"]);
    writeFileSync(join(root, "shared.txt"), "change-a\n", "utf8");
    git(["commit", "-am", "change on a"]);
    git(["checkout", "-b", "branch-b", "main"]);
    writeFileSync(join(root, "shared.txt"), "change-b\n", "utf8");
    git(["commit", "-am", "change on b"]);
    try {
      git(["merge", "branch-a"]);
    } catch {
      // Expected: the merge conflicts. The working tree now holds git's own conflict markers.
    }
    const conflicted = readFileSync(join(root, "shared.txt"), "utf8");
    expect(conflicted).toContain("<<<<<<<");
    // Stage the STILL-CONFLICTED content verbatim — the exact "staged conflicted file" scenario the
    // fix targets, never actually resolving the conflict.
    git(["add", "shared.txt"]);
    expect(await readStagedConflictMarkerFileCount(deps())).toBe(1);
  });

  it("does not flag a staged whitespace-only issue as a conflict marker (distinct --check diagnostic)", async () => {
    writeFileSync(join(root, "a.txt"), "line one\n", "utf8");
    git(["add", "a.txt"]);
    git(["commit", "-m", "base"]);
    // Trailing whitespace: `git diff --check` reports THIS too, but under a different diagnostic
    // ("trailing whitespace"), never "leftover conflict marker" — must not be conflated with one.
    writeFileSync(join(root, "a.txt"), "line one \n", "utf8");
    git(["add", "a.txt"]);
    expect(await readStagedConflictMarkerFileCount(deps())).toBe(0);
  });

  it("throws a content-free GitWorktreeReadError outside a git repository", async () => {
    const bare = realpathSync(mkdtempSync(join(tmpdir(), "keiko-not-git-conflict-")));
    try {
      await expect(
        readStagedConflictMarkerFileCount({ ...deps(), workspace: workspaceInfo(bare) }),
      ).rejects.toBeInstanceOf(GitWorktreeReadError);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});

describe("effective push destination inspection", () => {
  it("retains every push URL so the issue-bound owner can reject multiplicity", async () => {
    git(["remote", "add", "origin", CONFIGURED_REMOTE_URL]);
    git(["config", "--add", "remote.origin.pushurl", "https://github.com/owner/first.git"]);
    git(["config", "--add", "remote.origin.pushurl", "https://github.com/owner/second.git"]);
    expect(await readGitPushRemoteUrls(deps(), "origin")).toEqual([
      "https://github.com/owner/first.git",
      "https://github.com/owner/second.git",
    ]);
  });
  it("observes user push rewrites while the existing fetch-identity reader stays isolated", async () => {
    git(["remote", "add", "origin", CONFIGURED_REMOTE_URL]);
    const home = makeRewritingConfigDir("home", "https://elsewhere.example/");
    const input = { ...deps(), processEnv: { PATH: process.env.PATH, HOME: home } };
    expect(await readGitPushRemoteUrls(input, "origin")).toEqual([
      "https://elsewhere.example/alicedev-team/App.git",
    ]);
    expect(await readGitRemoteUrl(input, "origin")).toBe(CONFIGURED_REMOTE_URL);
  });
  it("fails closed on truncated destination metadata", async () => {
    git(["remote", "add", "origin", CONFIGURED_REMOTE_URL]);
    await expect(
      readGitPushRemoteUrls(
        { ...deps(), policy: { ...DEFAULT_SANDBOX_POLICY, maxOutputBytes: 8 } },
        "origin",
      ),
    ).rejects.toThrow("truncated");
  });
});
