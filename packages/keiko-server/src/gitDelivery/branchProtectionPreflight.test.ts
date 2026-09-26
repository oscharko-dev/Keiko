import { describe, expect, it, vi } from "vitest";
import type { CommandTerminationEvidence } from "@oscharko-dev/keiko-contracts";
import type {
  NodeGitMergeAdapterDeps,
  NodeGitWorktreeReaderDeps,
} from "@oscharko-dev/keiko-tools/internal/git-mutation";
import type { WorkspaceInfo } from "@oscharko-dev/keiko-workspace";

// Spies on the TWO git subprocess reads createTrustedGitDeliveryBranchProtectionReader may run
// (readGitRemoteUrl -> `git remote get-url`, then readNodeGitBranchProtection -> `gh api`) — the
// F1 audit finding: this was the ONE default git reader across gitDelivery that dropped the
// runCommand termination-evidence callback entirely, rather than merely downgrading its
// correlationId. Neither the real workspace nor a real `gh` binary is needed here: both reads are
// replaced outright (not delegated) because the fact under test is purely which `onTerminated`
// value each one is CALLED with, not their real network/process behavior.
const readGitRemoteUrlCalls: NodeGitWorktreeReaderDeps[] = [];
const readNodeGitBranchProtectionCalls: NodeGitMergeAdapterDeps[] = [];
vi.mock("@oscharko-dev/keiko-tools/internal/git-mutation", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@oscharko-dev/keiko-tools/internal/git-mutation")>();
  return {
    ...actual,
    readGitRemoteUrl: (deps: NodeGitWorktreeReaderDeps, remoteAlias: string): Promise<string> => {
      readGitRemoteUrlCalls.push(deps);
      return Promise.resolve(`https://github.com/oscharko-dev/${remoteAlias}.git`);
    },
    readNodeGitBranchProtection: (
      deps: NodeGitMergeAdapterDeps,
    ): Promise<{ readonly outcome: "unprotected" }> => {
      readNodeGitBranchProtectionCalls.push(deps);
      return Promise.resolve({ outcome: "unprotected" });
    },
  };
});

import {
  createTrustedGitDeliveryBranchProtectionReader,
  githubOwnerAndRepoFromRemoteUrl,
  signatureRequirementOf,
} from "./branchProtectionPreflight.js";

describe("githubOwnerAndRepoFromRemoteUrl", () => {
  it.each([
    ["https://github.com/oscharko-dev/Keiko.git", "oscharko-dev/Keiko"],
    ["ssh://git@github.com/oscharko-dev/Keiko.git", "oscharko-dev/Keiko"],
    ["git@github.com:oscharko-dev/Keiko.git", "oscharko-dev/Keiko"],
  ])("derives a bounded repository operand from %s", (remoteUrl, expected) => {
    expect(githubOwnerAndRepoFromRemoteUrl(remoteUrl)).toBe(expected);
  });

  it.each([
    "https://example.com/oscharko-dev/Keiko.git",
    "https://github.com/oscharko-dev/../Keiko.git",
    "https://token@github.com/oscharko-dev/Keiko.git?credential=secret",
    "--hostname=evil",
  ])("rejects unsupported or ambiguous remote URL %s", (remoteUrl) => {
    expect(githubOwnerAndRepoFromRemoteUrl(remoteUrl)).toBeUndefined();
  });

  // `runCommand` replaces the value of every non-allowlisted env var with `[REDACTED]` before output
  // leaves the spawn boundary. Parsing such a string would silently address a DIFFERENT repository
  // than the checkout's own — and, on the coding-context path, would decide an authorization
  // comparison against a name that is not the real one.
  //
  // These pass because `validRepositorySegment` rejects the marker's brackets, not because of a
  // dedicated marker check: an explicit one was written here and then removed, because removing it
  // changed no case and AGENTS.md §6 prefers deletion to redundant code. They are kept as the pin on
  // that behaviour, so loosening the segment rule cannot quietly re-admit a redacted operand.
  it.each([
    "https://github.com/[REDACTED]-dev/Keiko.git",
    "https://github.com/oscharko-dev/[REDACTED].git",
    "git@github.com:[REDACTED]/Keiko.git",
  ])("refuses a remote URL the spawn boundary redacted: %s", (remoteUrl) => {
    expect(githubOwnerAndRepoFromRemoteUrl(remoteUrl)).toBeUndefined();
  });
});

describe("signatureRequirementOf", () => {
  it("does not collapse provider unavailability into not-required", () => {
    expect(signatureRequirementOf({ outcome: "unavailable" })).toBe("unavailable");
    expect(signatureRequirementOf({ outcome: "unknown" })).toBe("unavailable");
    expect(signatureRequirementOf({ outcome: "unprotected" })).toBe("not-required");
  });
});

function testWorkspace(root: string): WorkspaceInfo {
  return {
    root,
    selectedRoot: root,
    name: undefined,
    version: undefined,
    testFramework: "unknown",
    sourceDirs: [],
    testDirs: [],
    languages: [],
    ignoreLines: [],
  };
}

describe("createTrustedGitDeliveryBranchProtectionReader — runCommand termination-evidence wiring (F1)", () => {
  it("passes the SAME onTerminated callback into both git subprocess reads it may run", async () => {
    readGitRemoteUrlCalls.length = 0;
    readNodeGitBranchProtectionCalls.length = 0;
    const events: CommandTerminationEvidence[] = [];
    const onTerminated = (evidence: CommandTerminationEvidence): void => {
      events.push(evidence);
    };
    const reader = createTrustedGitDeliveryBranchProtectionReader(onTerminated);
    const result = await reader(
      testWorkspace("/nonexistent/keiko-gd-branch-protection"),
      "origin",
      "dev",
    );
    expect(result).toEqual({ outcome: "unprotected" });
    expect(readGitRemoteUrlCalls).toHaveLength(1);
    expect(readGitRemoteUrlCalls[0]?.onTerminated).toBe(onTerminated);
    expect(readNodeGitBranchProtectionCalls).toHaveLength(1);
    expect(readNodeGitBranchProtectionCalls[0]?.onTerminated).toBe(onTerminated);
    // And the callback genuinely round-trips through to the caller's own sink.
    onTerminated({ reason: "timeout", childPid: 321, windowsTreeKill: "not-attempted" });
    expect(events).toHaveLength(1);
    expect(events[0]?.childPid).toBe(321);
  });

  it("omits onTerminated from both reads when the caller supplies none", async () => {
    readGitRemoteUrlCalls.length = 0;
    readNodeGitBranchProtectionCalls.length = 0;
    const reader = createTrustedGitDeliveryBranchProtectionReader();
    await reader(testWorkspace("/nonexistent/keiko-gd-branch-protection"), "origin", "dev");
    expect(readGitRemoteUrlCalls[0]?.onTerminated).toBeUndefined();
    expect(readNodeGitBranchProtectionCalls[0]?.onTerminated).toBeUndefined();
  });

  // Folded onto the factory (PR #3355 review, P3): the zero-arg `readTrustedGitDeliveryBranchProtection`
  // const this used to exercise was deleted, since the only "backward compatible" usage it had was
  // this test itself. Calling the factory with no argument proves the same thing — a reader built
  // without an evidence port passes no `onTerminated` down — without keeping an export alive for it.
  it("the factory called with no argument passes no onTerminated down", async () => {
    readGitRemoteUrlCalls.length = 0;
    readNodeGitBranchProtectionCalls.length = 0;
    const result = await createTrustedGitDeliveryBranchProtectionReader()(
      testWorkspace("/nonexistent/keiko-gd-branch-protection"),
      "origin",
      "dev",
    );
    expect(result).toEqual({ outcome: "unprotected" });
    expect(readGitRemoteUrlCalls[0]?.onTerminated).toBeUndefined();
    expect(readNodeGitBranchProtectionCalls[0]?.onTerminated).toBeUndefined();
  });
});
