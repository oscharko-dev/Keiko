import type { WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import type { GitDeliveryBranchProtection } from "@oscharko-dev/keiko-contracts";
import type { CommandTerminationEvidence } from "@oscharko-dev/keiko-tools";
import {
  readGitRemoteUrl,
  readNodeGitBranchProtection,
} from "@oscharko-dev/keiko-tools/internal/git-mutation";

export type GitDeliverySignatureRequirement = "required" | "not-required" | "unavailable";

export type GitDeliveryBranchProtectionPreflight =
  | { readonly outcome: "protected"; readonly protection: GitDeliveryBranchProtection }
  | { readonly outcome: "unprotected" }
  | { readonly outcome: "unavailable" };

export type GitDeliveryBranchProtectionReader = (
  workspace: WorkspaceInfo,
  remoteAlias: string,
  branchName: string,
) => Promise<GitDeliveryBranchProtectionPreflight>;

function validRepositorySegment(value: string): boolean {
  return value !== "." && value !== ".." && /^[A-Za-z0-9_.-]+$/u.test(value);
}

function stripBoundarySlashes(path: string): string {
  let start = 0;
  let end = path.length;
  while (start < end && path.codePointAt(start) === 47) start += 1;
  while (end > start && path.codePointAt(end - 1) === 47) end -= 1;
  return path.slice(start, end);
}

function ownerAndRepoFromPath(path: string): string | undefined {
  const trimmed = stripBoundarySlashes(path);
  const parts = trimmed.split("/");
  if (parts.length !== 2) return undefined;
  const owner = parts[0];
  const rawRepo = parts[1];
  if (owner === undefined || rawRepo === undefined) return undefined;
  const repo = rawRepo.endsWith(".git") ? rawRepo.slice(0, -4) : rawRepo;
  return validRepositorySegment(owner) && validRepositorySegment(repo)
    ? `${owner}/${repo}`
    : undefined;
}

export function githubOwnerAndRepoFromRemoteUrl(remoteUrl: string): string | undefined {
  const scpPrefix = "git@github.com:";
  if (remoteUrl.startsWith(scpPrefix)) {
    return ownerAndRepoFromPath(remoteUrl.slice(scpPrefix.length));
  }
  let parsed: URL;
  try {
    parsed = new URL(remoteUrl);
  } catch {
    return undefined;
  }
  if (parsed.hostname.toLowerCase() !== "github.com") return undefined;
  if (!new Set(["https:", "ssh:", "git:"]).has(parsed.protocol)) return undefined;
  if (parsed.search.length > 0 || parsed.hash.length > 0) return undefined;
  return ownerAndRepoFromPath(parsed.pathname);
}

// Builds the branch-protection reader with the caller's own runCommand termination-evidence
// callback wired into BOTH git subprocesses it may run (`git remote get-url` via readGitRemoteUrl,
// then `gh api` via readNodeGitBranchProtection) — the same evidence port every other default git
// reader/adapter across gitDelivery composes through (see execution.ts's
// gitDeliveryTerminationHandler). Without an onTerminated, a timed-out or output-capped read here
// is a git/gh subprocess whose termination never reaches the activity log at all: this was the
// ONLY default reader in the area that dropped the callback entirely rather than merely
// downgrading its correlationId. `readTrustedGitDeliveryBranchProtection` below is the zero-arg
// convenience default for callers with no evidence port to inject (kept for backward
// compatibility with existing seam/test usage); a request-scoped caller should prefer
// `createTrustedGitDeliveryBranchProtectionReader(gitDeliveryTerminationHandler(seams,
// correlationId))` instead.
export function createTrustedGitDeliveryBranchProtectionReader(
  onTerminated?: (evidence: CommandTerminationEvidence) => void,
): GitDeliveryBranchProtectionReader {
  const terminationDeps = onTerminated !== undefined ? { onTerminated } : {};
  return async (workspace, remoteAlias, branchName) => {
    try {
      const remoteUrl = await readGitRemoteUrl(
        { workspace, processEnv: process.env, ...terminationDeps },
        remoteAlias,
      );
      const ownerAndRepo = githubOwnerAndRepoFromRemoteUrl(remoteUrl);
      if (ownerAndRepo === undefined) return { outcome: "unavailable" };
      return await readNodeGitBranchProtection(
        { workspace, processEnv: process.env, ...terminationDeps },
        { ownerAndRepo, baseBranchName: branchName },
      );
    } catch {
      return { outcome: "unavailable" };
    }
  };
}

export const readTrustedGitDeliveryBranchProtection: GitDeliveryBranchProtectionReader =
  createTrustedGitDeliveryBranchProtectionReader();

export function signatureRequirementOf(
  preflight: GitDeliveryBranchProtectionPreflight,
): GitDeliverySignatureRequirement {
  if (preflight.outcome === "unavailable") return "unavailable";
  if (preflight.outcome === "unprotected") return "not-required";
  return preflight.protection.signaturesRequired ? "required" : "not-required";
}
