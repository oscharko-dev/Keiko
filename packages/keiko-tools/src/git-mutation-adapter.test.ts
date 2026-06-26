import { describe, expect, it } from "vitest";
import {
  buildAbortArgv,
  buildBranchCreateArgv,
  buildBranchSwitchArgv,
  buildCommitArgv,
  buildRecoveryArgv,
  buildStageArgv,
  buildUnstageArgv,
  GIT_MUTATION_ALLOWED_SUBCOMMANDS,
  GIT_MUTATION_COMMAND_RULES,
  gitMutationPlanIsGoverned,
  GitMutationArgvError,
} from "./git-mutation-adapter.js";
import { isCommandAllowed } from "./sandbox.js";
import { isTerminalCommandAllowed } from "./terminal-policy.js";

const NUL = "\u0000";

describe("argv builders — fixed, governed argument vectors", () => {
  it("branch-create builds `git branch <name> <start>`", () => {
    expect(buildBranchCreateArgv({ branchName: "feature/x", startPointRefHash: "abc123" })).toEqual(
      [["branch", "feature/x", "abc123"]],
    );
  });

  it("branch-switch builds `git switch <name>` (branch-only, no path checkout)", () => {
    expect(buildBranchSwitchArgv({ branchName: "feature/x" })).toEqual([["switch", "feature/x"]]);
  });

  it("branch-switch rejects a flag-injecting branch name", () => {
    expect(() => buildBranchSwitchArgv({ branchName: "-D" })).toThrow(GitMutationArgvError);
    expect(() => buildBranchSwitchArgv({ branchName: "" })).toThrow(GitMutationArgvError);
  });

  it("stage places pathspecs after the `--` sentinel", () => {
    expect(buildStageArgv({ pathspecs: ["src/a.ts", "src/b.ts"] })).toEqual([
      ["add", "--", "src/a.ts", "src/b.ts"],
    ]);
  });

  it("unstage uses restore --staged after `--`", () => {
    expect(buildUnstageArgv({ pathspecs: ["src/a.ts"] })).toEqual([
      ["restore", "--staged", "--", "src/a.ts"],
    ]);
  });

  it("commit passes the message as a single `--message` token", () => {
    expect(buildCommitArgv({ message: "fix: thing", allowEmpty: false })).toEqual([
      ["commit", "--message", "fix: thing"],
    ]);
  });

  it("commit adds --allow-empty only when requested", () => {
    expect(buildCommitArgv({ message: "empty", allowEmpty: true })).toEqual([
      ["commit", "--allow-empty", "--message", "empty"],
    ]);
  });

  it("abort maps each operation to its termination form", () => {
    expect(buildAbortArgv({ operationToAbort: "merge" })).toEqual([["merge", "--abort"]]);
    expect(buildAbortArgv({ operationToAbort: "rebase" })).toEqual([["rebase", "--abort"]]);
    expect(buildAbortArgv({ operationToAbort: "cherry-pick" })).toEqual([
      ["cherry-pick", "--abort"],
    ]);
    expect(buildAbortArgv({ operationToAbort: "revert" })).toEqual([["revert", "--abort"]]);
    expect(buildAbortArgv({ operationToAbort: "bisect" })).toEqual([["bisect", "reset"]]);
  });

  it("recovery stash-and-reset stashes before the hard reset (two-step plan)", () => {
    expect(
      buildRecoveryArgv({
        recoveryStrategyHint: "stash-and-reset",
        targetRefHash: "abc",
        pathspecs: [],
      }),
    ).toEqual([
      ["stash", "push", "--include-untracked"],
      ["reset", "--hard", "abc"],
    ]);
  });

  it("recovery reset strategies map to the matching reset mode", () => {
    expect(
      buildRecoveryArgv({
        recoveryStrategyHint: "soft-reset",
        targetRefHash: "abc",
        pathspecs: [],
      }),
    ).toEqual([["reset", "--soft", "abc"]]);
    expect(
      buildRecoveryArgv({
        recoveryStrategyHint: "mixed-reset",
        targetRefHash: "abc",
        pathspecs: [],
      }),
    ).toEqual([["reset", "--mixed", "abc"]]);
    expect(
      buildRecoveryArgv({
        recoveryStrategyHint: "restore-index",
        targetRefHash: "abc",
        pathspecs: ["a.ts"],
      }),
    ).toEqual([["restore", "--source", "abc", "--staged", "--", "a.ts"]]);
  });
});

describe("operand validation — flag injection and malformed operands", () => {
  it("rejects a ref that would be read as a flag", () => {
    expect(() => buildBranchCreateArgv({ branchName: "-D", startPointRefHash: "abc" })).toThrow(
      GitMutationArgvError,
    );
    expect(() => buildBranchCreateArgv({ branchName: "ok", startPointRefHash: "--force" })).toThrow(
      GitMutationArgvError,
    );
    expect(() =>
      buildRecoveryArgv({ recoveryStrategyHint: "soft-reset", targetRefHash: "-x", pathspecs: [] }),
    ).toThrow(GitMutationArgvError);
  });

  it("rejects empty or NUL-bearing operands", () => {
    expect(() => buildBranchCreateArgv({ branchName: "", startPointRefHash: "abc" })).toThrow(
      GitMutationArgvError,
    );
    expect(() =>
      buildBranchCreateArgv({ branchName: `a${NUL}b`, startPointRefHash: "abc" }),
    ).toThrow(GitMutationArgvError);
    expect(() => buildCommitArgv({ message: "", allowEmpty: false })).toThrow(GitMutationArgvError);
    expect(() => buildStageArgv({ pathspecs: [] })).toThrow(GitMutationArgvError);
    expect(() => buildStageArgv({ pathspecs: ["ok", NUL] })).toThrow(GitMutationArgvError);
  });

  it("allows a commit message that begins with `-` (it is a flag value, not a flag)", () => {
    expect(buildCommitArgv({ message: "-not-a-flag", allowEmpty: false })).toEqual([
      ["commit", "--message", "-not-a-flag"],
    ]);
  });
});

describe("no-generic-fallback property (AC3)", () => {
  it("every producible plan begins with an allowed governed subcommand", () => {
    const plans = [
      buildBranchCreateArgv({ branchName: "b", startPointRefHash: "h" }),
      buildStageArgv({ pathspecs: ["a"] }),
      buildUnstageArgv({ pathspecs: ["a"] }),
      buildCommitArgv({ message: "m", allowEmpty: false }),
      buildAbortArgv({ operationToAbort: "merge" }),
      buildRecoveryArgv({
        recoveryStrategyHint: "stash-and-reset",
        targetRefHash: "h",
        pathspecs: [],
      }),
    ];
    for (const plan of plans) {
      expect(gitMutationPlanIsGoverned(plan)).toBe(true);
    }
  });

  it("rejects a hand-crafted plan whose subcommand is outside the allowlist", () => {
    expect(gitMutationPlanIsGoverned([["push", "origin", "main"]])).toBe(false);
    expect(gitMutationPlanIsGoverned([[]])).toBe(false);
  });

  it("the dedicated command rules permit only the governed mutation subcommands", () => {
    for (const sub of GIT_MUTATION_ALLOWED_SUBCOMMANDS) {
      expect(isCommandAllowed(GIT_MUTATION_COMMAND_RULES, "git", [sub]).allowed).toBe(true);
    }
    for (const denied of ["push", "fetch", "pull", "clone", "config", "status", "remote"]) {
      expect(isCommandAllowed(GIT_MUTATION_COMMAND_RULES, "git", [denied]).allowed).toBe(false);
    }
  });

  it("the dedicated command rules deny global config / cwd-shifting flags", () => {
    expect(
      isCommandAllowed(GIT_MUTATION_COMMAND_RULES, "git", ["-c", "core.x=1", "commit"]).allowed,
    ).toBe(false);
    expect(
      isCommandAllowed(GIT_MUTATION_COMMAND_RULES, "git", ["--exec-path=/x", "add"]).allowed,
    ).toBe(false);
  });
});

describe("boundary complementarity with the read-only terminal policy", () => {
  it("the read-only terminal policy denies every real governed mutation invocation", () => {
    // The governed write surface and the terminal inspection surface are complementary: every actual
    // argv the adapter can produce is refused by the read-only terminal policy. (A bare `git branch`
    // listing stays allowed there; the adapter never emits a bare branch — it always carries the new
    // branch operand, which the terminal policy denies.)
    const plans = [
      ...buildBranchCreateArgv({ branchName: "feature/x", startPointRefHash: "abc123" }),
      ...buildBranchSwitchArgv({ branchName: "feature/x" }),
      ...buildStageArgv({ pathspecs: ["a.ts"] }),
      ...buildUnstageArgv({ pathspecs: ["a.ts"] }),
      ...buildCommitArgv({ message: "m", allowEmpty: false }),
      ...buildAbortArgv({ operationToAbort: "merge" }),
      ...buildAbortArgv({ operationToAbort: "rebase" }),
      ...buildRecoveryArgv({
        recoveryStrategyHint: "soft-reset",
        targetRefHash: "abc",
        pathspecs: [],
      }),
      ...buildRecoveryArgv({
        recoveryStrategyHint: "stash-and-reset",
        targetRefHash: "abc",
        pathspecs: [],
      }),
      ...buildRecoveryArgv({
        recoveryStrategyHint: "restore-index",
        targetRefHash: "abc",
        pathspecs: ["a.ts"],
      }),
    ];
    for (const argv of plans) {
      expect(isTerminalCommandAllowed("git", argv).allowed).toBe(false);
    }
  });
});
