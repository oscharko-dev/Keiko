// Deterministic unit coverage for the Node governed Git mutation adapter (Issue #472) — AC3/AC5.
// Uses an injected fake spawn so the failure-classification branches (non-zero exit, thrown spawn,
// cancellation) are exercised without a real process, and asserts that the EXACT governed argv
// reaches the spawn boundary — there is no path to an arbitrary command.

import { describe, expect, it } from "vitest";
import { makeWorkspace, recordingSpawn, type SpawnRecorder } from "./_support.js";
import {
  createNodeGitMutationAdapter,
  type GitCommitSigningReadFailureReport,
  type NodeGitMutationAdapterDeps,
} from "./git-mutation-node.js";
import type { GitLocalMutationAdapter } from "./git-mutation-adapter.js";
import type { HomeProvider } from "./exec.js";

const FAKE_HOME: HomeProvider = { make: () => "/tmp/keiko-fake-home", cleanup: () => undefined };

function makeAdapter(rec: SpawnRecorder, signal?: AbortSignal): GitLocalMutationAdapter {
  const { info } = makeWorkspace();
  return createNodeGitMutationAdapter({
    workspace: info,
    processEnv: { PATH: "/usr/bin" },
    now: () => 0,
    spawn: rec.fn,
    home: FAKE_HOME,
    // Skip PATH/fs resolution so the test is hermetic; the governed argv still flows to the spawn.
    resolveExecutable: () => "git",
    ...(signal !== undefined ? { signal } : {}),
  });
}

// Every mutating command's FIRST spawn is the version-gated lazy-fetch/replace-objects guard's own
// promisor-remote probe (`git config --get-regexp ^remote\..*\.(promisor|partialclonefilter)$`,
// git-worktree-snapshot-node.ts, reviewer 3941836280 / 3941943601) — re-probed on every call, never
// cached, since the repository's own config can change while Keiko runs (reviewer 3941943603).
// Exit 1 with no stdout means "no promisor remote configured" (not at risk), so the guard admits
// the real command without a version probe of its own.
async function continuePastLazyFetchGuardProbe(rec: SpawnRecorder): Promise<void> {
  const before = rec.calls().length;
  rec.child.emit("close", 1, null);
  await expect.poll(() => rec.calls().length).toBe(before + 1);
}

// A commit first reads Git's effective `commit.gpgsign` (a bare `git config` run, no guard probe) and
// only then takes the lazy-fetch guard probe and its own spawn. `stdout` is the boolean Git answers.
async function answerSigningRead(rec: SpawnRecorder, stdout: string, code = 0): Promise<void> {
  const before = rec.calls().length;
  expect(rec.calls()[before - 1]?.args).toEqual([
    "config",
    "--type=bool",
    "--get",
    "commit.gpgsign",
  ]);
  rec.child.stdout.emit("data", Buffer.from(stdout, "utf8"));
  rec.child.emit("close", code, null);
  await expect.poll(() => rec.calls().length).toBe(before + 1);
}

describe("node git mutation adapter — governed argv reaches the spawn boundary", () => {
  it("spawns exactly the governed literalized `git add -- <path>` and reports success on exit 0", async () => {
    const rec = recordingSpawn();
    const ad = makeAdapter(rec);
    const pending = ad.stage({ pathspecs: ["src/x.ts"] });
    await continuePastLazyFetchGuardProbe(rec);
    rec.child.emit("close", 0, null);
    const result = await pending;
    expect(result.outcome).toBe("succeeded");
    expect(rec.calls()).toHaveLength(2);
    expect(rec.calls()[0]?.args).toEqual([
      "config",
      "--get-regexp",
      String.raw`^remote\..*\.(promisor|partialclonefilter)$`,
    ]);
    expect(rec.calls()[1]?.command).toBe("git");
    expect(rec.calls()[1]?.args).toEqual([
      ...(process.platform === "win32" ? ["-c", "core.longpaths=true"] : []),
      "-c",
      "core.fsmonitor=false",
      "-c",
      `core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`,
      "-c",
      "core.pager=cat",
      "-c",
      "pager.commit=false",
      "-c",
      "alias.commit=",
      "-c",
      "gpg.program=gpg",
      "-c",
      "gpg.ssh.program=ssh-keygen",
      "-c",
      "protocol.ext.allow=never",
      "-c",
      "submodule.recurse=false",
      "add",
      "--",
      ":(literal)src/x.ts",
    ]);
    // The spawn is shell-less by construction.
    expect(rec.calls()[1]?.options.shell).toBe(false);
  });
});

describe("node git mutation adapter — failure-classification branches", () => {
  it("maps a signing failure to a signature-failed result", async () => {
    const rec = recordingSpawn();
    const ad = makeAdapter(rec);
    const pending = ad.commit({ message: "m", allowEmpty: false });
    await expect.poll(() => rec.calls().length).toBe(1);
    await answerSigningRead(rec, "true\n");
    await continuePastLazyFetchGuardProbe(rec);
    rec.child.stderr.emit("data", Buffer.from("error: gpg failed to sign the data\n", "utf8"));
    rec.child.emit("close", 1, null);
    const result = await pending;
    expect(result.outcome).toBe("failed");
    expect(result.errorCode).toBe("signature-failed");
  });

  it("maps a thrown spawn to an internal-error failure", async () => {
    const rec = recordingSpawn();
    const ad = makeAdapter(rec);
    const pending = ad.stage({ pathspecs: ["a"] });
    await continuePastLazyFetchGuardProbe(rec);
    rec.child.emit("error", new Error("spawn failed"));
    const result = await pending;
    expect(result.outcome).toBe("failed");
    expect(result.errorCode).toBe("internal-error");
  });

  it("maps a cancelled run to an aborted result", async () => {
    const controller = new AbortController();
    controller.abort();
    const rec = recordingSpawn();
    const ad = makeAdapter(rec, controller.signal);
    const pending = ad.unstage({ pathspecs: ["a"] });
    rec.child.emit("close", null, "SIGTERM");
    const result = await pending;
    expect(result.outcome).toBe("aborted");
    expect(result.errorCode).toBeUndefined();
  });

  it("maps cancellation during the commit guard to an aborted result", async () => {
    const controller = new AbortController();
    const rec = recordingSpawn();
    const ad = makeAdapter(rec, controller.signal);
    const pending = ad.commit({ message: "m", allowEmpty: false });
    controller.abort();
    rec.child.emit("close", null, "SIGTERM");
    const result = await pending;
    expect(result.outcome).toBe("aborted");
    expect(result.errorCode).toBeUndefined();
    expect(rec.calls()).toHaveLength(1);
  });

  it("rejects an invalid operand before any spawn", async () => {
    const rec = recordingSpawn();
    const ad = makeAdapter(rec);
    const result = await ad.createBranch({ branchName: "-D", startPointRefHash: "abc" });
    expect(result.outcome).toBe("failed");
    expect(result.errorCode).toBe("internal-error");
    expect(rec.calls()).toHaveLength(0); // never reached the spawn boundary
  });
});

// Reviewer 3941836280 / wave-2 D2 need: the SAME version-gated, fail-closed lazy-fetch guard
// (git-worktree-snapshot-node.ts) protects the write lane too, via `ensureGitLazyFetchGuardSupported`
// inside `runOne`. These pin both halves for a mutating call against a scripted spawn.
describe("node git mutation adapter — lazy-fetch guard, version-gated and fail-closed", () => {
  it("refuses the mutation outright when the repository is a promisor clone and the installed git cannot enforce the guard", async () => {
    const rec = recordingSpawn();
    const ad = makeAdapter(rec);
    const pending = ad.stage({ pathspecs: ["a"] });
    rec.child.stdout.emit("data", Buffer.from("remote.origin.promisor true\n", "utf8"));
    rec.child.emit("close", 0, null);
    await expect.poll(() => rec.calls()).toHaveLength(2);
    rec.child.stdout.emit("data", Buffer.from("git version 2.43.0\n", "utf8"));
    rec.child.emit("close", 0, null);
    const result = await pending;
    expect(result.outcome).toBe("failed");
    expect(result.errorCode).toBe("internal-error");
    // The real `add` never spawned — refused, not staged unprotected.
    expect(rec.calls()).toHaveLength(2);
  });

  it("admits the mutation once the installed git is new enough to enforce the guard", async () => {
    const rec = recordingSpawn();
    const ad = makeAdapter(rec);
    const pending = ad.stage({ pathspecs: ["a"] });
    rec.child.stdout.emit("data", Buffer.from("remote.origin.promisor true\n", "utf8"));
    rec.child.emit("close", 0, null);
    await expect.poll(() => rec.calls()).toHaveLength(2);
    rec.child.stdout.emit("data", Buffer.from("git version 2.45.0\n", "utf8"));
    rec.child.emit("close", 0, null);
    await expect.poll(() => rec.calls()).toHaveLength(3);
    rec.child.emit("close", 0, null);
    const result = await pending;
    expect(result.outcome).toBe("succeeded");
    expect(rec.calls()[2]?.args.at(-1)).toBe(":(literal)a");
  });
});

// ─── Governed identity lane (#2843) ────────────────────────────────────────────────────────────
// The local mutation adapter must run under the GOVERNED IDENTITY env profile, not the fully
// isolated default. With the default profile the child gets an EMPTY HOME, so `git commit` cannot
// see the user's ~/.gitconfig identity or `commit.gpgsign`/`user.signingkey` — a governed commit is
// then structurally unsigned, and in a repository with no local identity it cannot run at all.

const IDENTITY_PARENT_ENV: NodeJS.ProcessEnv = {
  PATH: "/usr/bin",
  HOME: "/Users/dev",
  GNUPGHOME: "/Users/dev/.gnupg",
  SSH_AUTH_SOCK: "/tmp/ssh-agent.sock",
  EMAIL: "dev@example.com",
  GITHUB_TOKEN: "ghp_identity_lane_must_not_see_this",
  AWS_SECRET_ACCESS_KEY: "aws-identity-lane-must-not-see-this",
};

function identityLaneAdapter(rec: SpawnRecorder): GitLocalMutationAdapter {
  const { info } = makeWorkspace();
  return createNodeGitMutationAdapter({
    workspace: info,
    processEnv: IDENTITY_PARENT_ENV,
    now: () => 0,
    spawn: rec.fn,
    resolveExecutable: () => "git",
  });
}

async function identityLaneEnv(): Promise<Record<string, string>> {
  const rec = recordingSpawn();
  const ad = identityLaneAdapter(rec);
  const pending = ad.commit({ message: "feat: governed commit", allowEmpty: false });
  await expect.poll(() => rec.calls().length).toBe(1);
  await answerSigningRead(rec, "true\n");
  await continuePastLazyFetchGuardProbe(rec);
  // calls: [0] the commit.gpgsign read, [1] lazy-fetch guard probe, [2] the real `commit` — the one
  // whose env this helper exists to inspect.
  const commitEnv = rec.calls()[2]?.options.env ?? {};
  rec.child.emit("close", 0, null);
  // The commit's success triggers a follow-up readGitRevision("HEAD"). It runs in the commit's own
  // read session, so the probe the commit already took covers it (the verdict is held for ONE
  // operation and never across operations — see git-worktree-snapshot-node.ts), PROVIDED the
  // installed git itself enforces GIT_NO_LAZY_FETCH: reusing a verdict is the one place the version
  // matters, so it is read here, once per spawn function. The rev-parse follows it.
  const probesBefore = rec.calls().length;
  await expect.poll(() => rec.calls()).toHaveLength(probesBefore + 1);
  expect(rec.calls()[3]?.args).toEqual(["version"]);
  rec.child.stdout.emit("data", Buffer.from("git version 2.50.0\n"));
  rec.child.emit("close", 0, null);
  await expect.poll(() => rec.calls()).toHaveLength(5);
  expect(rec.calls()[4]?.args).toContain("rev-parse");
  expect(rec.calls().filter((call) => call.args.includes("--get-regexp"))).toHaveLength(1);
  rec.child.stdout.emit("data", Buffer.from(`${"a".repeat(40)}\n`));
  rec.child.emit("close", 0, null);
  await pending;
  return commitEnv;
}

describe("node git mutation adapter — the user's git identity reaches the commit", () => {
  it("forwards the real HOME so ~/.gitconfig identity and signing configuration are readable", async () => {
    const env = await identityLaneEnv();
    expect(env.HOME).toBe("/Users/dev");
    expect(env.USERPROFILE).toBe("/Users/dev");
  });

  it("forwards the signing-agent state a signed commit needs", async () => {
    const env = await identityLaneEnv();
    expect(env.GNUPGHOME).toBe("/Users/dev/.gnupg");
    expect(env.SSH_AUTH_SOCK).toBe("/tmp/ssh-agent.sock");
    expect(env.EMAIL).toBe("dev@example.com");
  });

  it("pins the fail-closed, deterministic values instead of inheriting them", async () => {
    const env = await identityLaneEnv();
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(env.GIT_PAGER).toBe("cat");
    expect(env.LC_ALL).toBe("C");
  });

  it("still forwards NO credential: the local lane never egresses", async () => {
    const env = await identityLaneEnv();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
  });
});

describe("node git mutation adapter — the signing flag follows commit.gpgsign at the argv", () => {
  async function commitArgv(answer: string, code = 0): Promise<readonly string[]> {
    const rec = recordingSpawn();
    const pending = makeAdapter(rec).commit({ message: "m", allowEmpty: false });
    await expect.poll(() => rec.calls().length).toBe(1);
    await answerSigningRead(rec, answer, code);
    await continuePastLazyFetchGuardProbe(rec);
    const argv = rec.calls()[2]?.args ?? [];
    rec.child.emit("close", 1, null);
    await pending;
    return argv;
  }

  it.each([
    ["true\n", 0, true],
    ["false\n", 0, false],
    ["", 1, false],
    ["", 128, true],
    ["maybe\n", 0, true],
  ])(
    "answer %j / exit %i signs: %s, and never passes --no-gpg-sign",
    async (answer, code, signs) => {
      const argv = await commitArgv(answer, code);
      expect(argv.includes("--gpg-sign")).toBe(signs);
      expect(argv).not.toContain("--no-gpg-sign");
    },
  );
});

describe("node git mutation adapter — signing read failures and branch protection", () => {
  function adapterWith(
    rec: SpawnRecorder,
    extra: Partial<NodeGitMutationAdapterDeps>,
  ): GitLocalMutationAdapter {
    const { info } = makeWorkspace();
    return createNodeGitMutationAdapter({
      workspace: info,
      processEnv: { PATH: "/usr/bin" },
      now: () => 0,
      spawn: rec.fn,
      home: FAKE_HOME,
      resolveExecutable: () => "git",
      ...extra,
    });
  }

  interface Observed {
    readonly argv: readonly string[];
    readonly result: Awaited<ReturnType<GitLocalMutationAdapter["commit"]>>;
    readonly failures: readonly GitCommitSigningReadFailureReport[];
  }

  // Runs one commit whose `commit.gpgsign` read is answered by `respond`, then fails the commit
  // itself so no follow-up revision read is needed.
  async function observe(
    respond: (rec: SpawnRecorder) => void,
    extra: Partial<NodeGitMutationAdapterDeps> = {},
  ): Promise<Observed> {
    const rec = recordingSpawn();
    const failures: GitCommitSigningReadFailureReport[] = [];
    const ad = adapterWith(rec, { onSigningReadFailure: (r) => failures.push(r), ...extra });
    const pending = ad.commit({ message: "m", allowEmpty: false });
    await expect.poll(() => rec.calls().length).toBe(1);
    respond(rec);
    await expect.poll(() => rec.calls().length).toBe(2);
    await continuePastLazyFetchGuardProbe(rec);
    const argv = rec.calls()[2]?.args ?? [];
    rec.child.emit("close", 1, null);
    return { argv, result: await pending, failures };
  }

  const answer =
    (stdout: string, code: number, stderr = "") =>
    (rec: SpawnRecorder): void => {
      rec.child.stdout.emit("data", Buffer.from(stdout, "utf8"));
      if (stderr !== "") rec.child.stderr.emit("data", Buffer.from(stderr, "utf8"));
      rec.child.emit("close", code, null);
    };

  it("carries a thrown read as the closed `spawn` class with its cause, and still signs", async () => {
    const cause = new Error("spawn failed");
    const seen = await observe((rec) => rec.child.emit("error", cause));

    expect(seen.argv).toContain("--gpg-sign");
    expect(seen.result.signing).toBe("unknown-fail-closed");
    expect(seen.result.signingReadFailure).toBe("spawn");
    expect(seen.failures).toHaveLength(1);
    expect(seen.failures[0]?.readFailure).toBe("spawn");
    expect(seen.failures[0]?.error).toBeInstanceOf(Error);
  });

  it("classifies a read cut short as `truncated`", async () => {
    const seen = await observe((rec) => {
      rec.child.stdout.emit("data", Buffer.alloc(8_000_000, "a"));
      rec.child.emit("close", 0, null);
    });

    expect(seen.argv).toContain("--gpg-sign");
    expect(seen.result.signingReadFailure).toBe("truncated");
    expect(seen.failures[0]?.readFailure).toBe("truncated");
  });

  it.each([
    ["maybe\n", 0, "", "malformed"],
    ["", 128, "fatal: bad boolean config value 'maybe' for 'commit.gpgsign'\n", "malformed"],
    ["", 2, "fatal: could not lock config file\n", "exit"],
  ] as const)("classifies %j / exit %i as `%s` and signs", async (out, code, err, expected) => {
    const seen = await observe(answer(out, code, err));

    expect(seen.argv).toContain("--gpg-sign");
    expect(seen.result.signing).toBe("unknown-fail-closed");
    expect(seen.result.signingReadFailure).toBe(expected);
  });

  it("reports no read failure for an answered read", async () => {
    const seen = await observe(answer("true\n", 0));

    expect(seen.result.signing).toBe("configured");
    expect(seen.result.signingReadFailure).toBeUndefined();
    expect(seen.failures).toHaveLength(0);
  });

  it("signs an unset commit.gpgsign when branch protection requires signatures", async () => {
    const seen = await observe(answer("", 1), {
      signingRequiredByBranchProtection: () => Promise.resolve(true),
    });

    expect(seen.argv).toContain("--gpg-sign");
    expect(seen.argv).not.toContain("--no-gpg-sign");
    expect(seen.result.signing).toBe("required-by-branch-protection");
  });

  it("commits unsigned when commit.gpgsign is unset and branch protection does not require it", async () => {
    const seen = await observe(answer("", 1), {
      signingRequiredByBranchProtection: () => Promise.resolve(false),
    });

    expect(seen.argv).not.toContain("--gpg-sign");
    expect(seen.result.signing).toBe("not-configured");
  });

  it("commits unsigned and records that the branch-protection read was unavailable", async () => {
    const seen = await observe(answer("", 1), {
      signingRequiredByBranchProtection: () => Promise.resolve("unavailable"),
    });

    expect(seen.argv).not.toContain("--gpg-sign");
    expect(seen.argv).not.toContain("--no-gpg-sign");
    expect(seen.result.signing).toBe("not-configured-protection-unavailable");
  });

  it("does not consult branch protection when commit.gpgsign already signs", async () => {
    let consulted = false;
    const seen = await observe(answer("true\n", 0), {
      signingRequiredByBranchProtection: () => {
        consulted = true;
        return Promise.resolve(true);
      },
    });

    expect(consulted).toBe(false);
    expect(seen.result.signing).toBe("configured");
  });

  it("does not commit when the branch-protection verdict cannot be produced", async () => {
    const rec = recordingSpawn();
    const ad = adapterWith(rec, {
      signingRequiredByBranchProtection: () => Promise.reject(new Error("verdict unavailable")),
    });
    const pending = ad.commit({ message: "m", allowEmpty: false });
    await expect.poll(() => rec.calls().length).toBe(1);
    answer("", 1)(rec);

    await expect(pending).rejects.toThrow("verdict unavailable");
    expect(rec.calls()).toHaveLength(1);
  });
});
