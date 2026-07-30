// Deterministic unit coverage for the Node governed Git mutation adapter (Issue #472) — AC3/AC5.
// Uses an injected fake spawn so the failure-classification branches (non-zero exit, thrown spawn,
// cancellation) are exercised without a real process, and asserts that the EXACT governed argv
// reaches the spawn boundary — there is no path to an arbitrary command.

import { describe, expect, it } from "vitest";
import { makeWorkspace, recordingSpawn, type SpawnRecorder } from "./_support.js";
import { createNodeGitMutationAdapter } from "./git-mutation-node.js";
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

describe("node git mutation adapter — governed argv reaches the spawn boundary", () => {
  it("spawns exactly the governed literalized `git add -- <path>` and reports success on exit 0", async () => {
    const rec = recordingSpawn();
    const ad = makeAdapter(rec);
    const pending = ad.stage({ pathspecs: ["src/x.ts"] });
    rec.child.emit("close", 0, null);
    const result = await pending;
    expect(result.outcome).toBe("succeeded");
    expect(rec.calls()).toHaveLength(1);
    expect(rec.calls()[0]?.command).toBe("git");
    expect(rec.calls()[0]?.args).toEqual(["add", "--", ":(literal)src/x.ts"]);
    // The spawn is shell-less by construction.
    expect(rec.calls()[0]?.options.shell).toBe(false);
  });
});

describe("node git mutation adapter — failure-classification branches", () => {
  it("maps a non-zero exit to a precondition-failed failure", async () => {
    const rec = recordingSpawn();
    const ad = makeAdapter(rec);
    const pending = ad.commit({ message: "m", allowEmpty: false });
    rec.child.emit("close", 1, null);
    const result = await pending;
    expect(result.outcome).toBe("failed");
    expect(result.errorCode).toBe("precondition-failed");
  });

  it("maps a thrown spawn to an internal-error failure", async () => {
    const rec = recordingSpawn();
    const ad = makeAdapter(rec);
    const pending = ad.stage({ pathspecs: ["a"] });
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

  it("rejects an invalid operand before any spawn", async () => {
    const rec = recordingSpawn();
    const ad = makeAdapter(rec);
    const result = await ad.createBranch({ branchName: "-D", startPointRefHash: "abc" });
    expect(result.outcome).toBe("failed");
    expect(result.errorCode).toBe("internal-error");
    expect(rec.calls()).toHaveLength(0); // never reached the spawn boundary
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
  rec.child.emit("close", 0, null);
  await pending;
  return rec.calls()[0]?.options.env ?? {};
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
