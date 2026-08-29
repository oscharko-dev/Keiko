import { describe, expect, it, vi } from "vitest";
import type { CommandTerminationEvidence } from "@oscharko-dev/keiko-tools";
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
  readTrustedGitDeliveryBranchProtection,
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
});

describe("signatureRequirementOf", () => {
  it("does not collapse provider unavailability into not-required", () => {
    expect(signatureRequirementOf({ outcome: "unavailable" })).toBe("unavailable");
    expect(signatureRequirementOf({ outcome: "unprotected" })).toBe("not-required");
  });
});

function testWorkspace(root: string): WorkspaceInfo {
  return {
    root,
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

  it("readTrustedGitDeliveryBranchProtection is the zero-arg convenience default (same behavior, no callback)", async () => {
    readGitRemoteUrlCalls.length = 0;
    readNodeGitBranchProtectionCalls.length = 0;
    const result = await readTrustedGitDeliveryBranchProtection(
      testWorkspace("/nonexistent/keiko-gd-branch-protection"),
      "origin",
      "dev",
    );
    expect(result).toEqual({ outcome: "unprotected" });
    expect(readGitRemoteUrlCalls[0]?.onTerminated).toBeUndefined();
    expect(readNodeGitBranchProtectionCalls[0]?.onTerminated).toBeUndefined();
  });
});
