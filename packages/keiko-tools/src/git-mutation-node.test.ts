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
  it("spawns exactly the governed `git add -- <path>` and reports success on exit 0", async () => {
    const rec = recordingSpawn();
    const ad = makeAdapter(rec);
    const pending = ad.stage({ pathspecs: ["src/x.ts"] });
    rec.child.emit("close", 0, null);
    const result = await pending;
    expect(result.outcome).toBe("succeeded");
    expect(rec.calls()).toHaveLength(1);
    expect(rec.calls()[0]?.command).toBe("git");
    expect(rec.calls()[0]?.args).toEqual(["add", "--", "src/x.ts"]);
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
