// Regression coverage for the fetch/pull sync outcome classifier's `cancelled` remote-failure arm
// (Issue #2903 audit remediation). SYNC_OUTCOME_FOR_REMOTE_FAILURE.cancelled is deliberately mapped
// to `undefined` — a caller-aborted run is NOT a remote-access verdict, so it falls through to the
// unresolved-remote fallback (`unresolvedRemoteOutcome`) and lands as "git-error" on the wire. The
// `GitSyncOutcome` wire contract was intentionally NOT widened with a "cancelled" member (see the
// comment on SYNC_OUTCOME_FOR_REMOTE_FAILURE in syncExecution.ts), so a future reader must not "fix"
// an aborted sync into `timeout` or a new outcome. Hermetic: no real git, an injected fake runner.

import { describe, expect, it } from "vitest";
// Load-bearing side-effect import, keep it: this is the only test file in the package that enters
// the module graph through gitDelivery/syncExecution.ts before anything has loaded routes.ts. Doing
// so exposes a pre-existing circular-import ordering hazard (routes.ts's module-scope route table
// spreads a route group that transitively imports back into gitRoutes.ts/syncExecution.ts, which
// this file's own import of `./syncExecution.js` — via `../gitRoutes.js` — is then still mid-loading
// when the cycle closes), producing a partially-initialized route table and a `TypeError` at import
// time rather than anything in this file's own tests. Every other route-adjacent suite in this
// package avoids it only because it happens to import routes.ts (directly or via the server barrel)
// before the module under test. Forcing that same order here — before `./syncExecution.js` — is not
// a fix for `syncExecution.ts` (its production behaviour is unaffected either way); it makes this
// suite resilient to which file vitest happens to load first.
import "../routes.js";
import type { GitProcessResult, GitProcessRunner } from "../gitRoutes.js";
import { captureActivityLog } from "../activityLogCapture.test-support.js";
import { buildSyncPreview, runSyncExecute } from "./syncExecution.js";

function ok(stdout: string, stderr = ""): GitProcessResult {
  return { exitCode: 0, signal: null, stdout, stderr, truncated: false };
}

// Porcelain-v2 branch header for a clean branch with a configured upstream and nothing ahead/behind
// — makes the preview executable so runSyncExecute proceeds to the network op instead of
// short-circuiting on a blockReason.
function readyPorcelain(): string {
  return "# branch.head main\0# branch.upstream origin/main\0# branch.ab +0 -0\0";
}

// The runner sets `truncated` on BOTH of its stops (byte cap AND abort — see GitProcessResult), so
// `aborted` alone must discriminate a caller cancellation from a byte-cap cut.
function abortedNetworkResult(): GitProcessResult {
  return {
    exitCode: null,
    signal: "SIGTERM",
    stdout: "",
    stderr: "",
    truncated: true,
    timedOut: false,
    aborted: true,
  };
}

// args = [...GIT_BASE_ARGS, "-C", repoRoot, <subcommand>, ...] — subcommand is index 4.
function subcommand(args: readonly string[]): string {
  return args[4] ?? "";
}

function abortingRunner(): GitProcessRunner {
  return (args): Promise<GitProcessResult> => {
    const cmd = subcommand(args);
    if (cmd === "status") return Promise.resolve(ok(readyPorcelain()));
    if (cmd === "remote") return Promise.resolve(ok("origin\n"));
    // fetch or pull: the bounded caller disconnected mid-run.
    return Promise.resolve(abortedNetworkResult());
  };
}

describe("runSyncExecute — cancelled remote failure (SYNC_OUTCOME_FOR_REMOTE_FAILURE.cancelled)", () => {
  it.each(["fetch", "pull"] as const)(
    "does not classify a byte-capped %s with exit zero as succeeded",
    async (operation) => {
      const runner: GitProcessRunner = (args): Promise<GitProcessResult> => {
        if (subcommand(args) === "status") return Promise.resolve(ok(readyPorcelain()));
        if (subcommand(args) === "remote") return Promise.resolve(ok("origin\n"));
        return Promise.resolve({ ...ok(""), truncated: true });
      };
      const result = await runSyncExecute(operation, "/repo", undefined, { runner });
      expect(result.outcome).toBe("output-truncated");
    },
  );

  it("resolves an aborted fetch to git-error — never timeout, never a success", async () => {
    const result = await runSyncExecute("fetch", "/repo", undefined, { runner: abortingRunner() });
    // Deliberately "git-error": see the module-level comment above and on
    // SYNC_OUTCOME_FOR_REMOTE_FAILURE.cancelled in syncExecution.ts for why this is correct.
    expect(result.outcome).toBe("git-error");
    expect(result.outcome).not.toBe("timeout");
    expect(result.outcome).not.toBe("succeeded");
  });

  it("resolves an aborted pull to git-error as well", async () => {
    const result = await runSyncExecute("pull", "/repo", undefined, { runner: abortingRunner() });
    expect(result.outcome).toBe("git-error");
  });
});

// A large untracked tree makes `git status` outgrow the sync byte cap; the runner then kills git and
// returns this exact shape. The branch header (upstream, ahead, behind) is complete, so the cut must
// neither fail the preview nor the post-sync re-read, and `dirty` must stay truthful.
describe("sync status read — byte-cap cut (large untracked tree)", () => {
  const capCut = (stdout: string, overrides: Partial<GitProcessResult> = {}): GitProcessResult => ({
    exitCode: null,
    signal: "SIGTERM",
    stdout,
    stderr: "",
    truncated: true,
    ...overrides,
  });
  const header = "# branch.head main\0# branch.upstream origin/main\0# branch.ab +1 -2\0";

  function runnerWith(status: GitProcessResult): GitProcessRunner {
    return (args): Promise<GitProcessResult> => {
      if (subcommand(args) === "status") return Promise.resolve(status);
      if (subcommand(args) === "remote") return Promise.resolve(ok("origin\n"));
      return Promise.resolve(ok(""));
    };
  }

  it.each([
    { name: "inside a plain record", tail: "? node_mod" },
    { name: "right after a NUL", tail: "? a.ts\0" },
    { name: "inside a rename's old path", tail: "2 R. N... 1 1 1 a b R100 new.ts\0old" },
  ])("previews a pull whose status the cap cut $name", async ({ tail }) => {
    const activity = captureActivityLog();

    const preview = await buildSyncPreview("pull", "/repo", undefined, {
      runner: runnerWith(capCut(header + tail)),
      activityLog: activity.sink,
      correlationId: "corr-sync-cut-01",
    });

    expect(preview).toMatchObject({
      available: true,
      branch: "main",
      upstream: { ref: "origin/main" },
      ahead: 1,
      behind: 2,
      // The cut proves the tree has more than the header.
      dirty: true,
      executable: true,
    });
    expect(activity.withOp("git.process.failed")).toHaveLength(0);
    expect(activity.withOp("git.status.bounded")[0]).toMatchObject({
      correlationId: "corr-sync-cut-01",
      extra: { surface: "sync-preview", maxBytes: 128 * 1024 },
    });
  });

  it("keeps a status cut inside the branch header a failed preview", async () => {
    await expect(
      buildSyncPreview("fetch", "/repo", undefined, {
        runner: runnerWith(capCut("# branch.head ma")),
      }),
    ).rejects.toThrow("git status failed for the sync preview");
  });

  it.each([
    { name: "a timeout", overrides: { timedOut: true } },
    { name: "an abort", overrides: { aborted: true } },
    { name: "git error output", overrides: { stderr: "fatal" } },
    { name: "exit 128", overrides: { exitCode: 128 } },
  ])("keeps $name a failed preview", async ({ overrides }) => {
    await expect(
      buildSyncPreview("fetch", "/repo", undefined, {
        runner: runnerWith(capCut(header, overrides)),
      }),
    ).rejects.toThrow("git status failed for the sync preview");
  });

  it("reports the position after a sync from a cut post-state read", async () => {
    const runner: GitProcessRunner = (args): Promise<GitProcessResult> => {
      const cmd = subcommand(args);
      if (cmd === "status") return Promise.resolve(capCut(header + "? node_mod"));
      if (cmd === "remote") return Promise.resolve(ok("origin\n"));
      return Promise.resolve(ok(""));
    };

    const result = await runSyncExecute("fetch", "/repo", undefined, { runner });

    expect(result).toMatchObject({ outcome: "succeeded", branch: "main", ahead: 1, behind: 2 });
  });
});
