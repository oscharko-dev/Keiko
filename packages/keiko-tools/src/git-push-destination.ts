import { isGitHubOwnerAndRepo } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime";

const GITHUB_PUSH_PREFIXES = [
  "https://github.com/",
  "git@github.com:",
  "ssh://git@github.com/",
] as const;

/** Canonical transport operand for an already approved GitHub repository, never authority. */
export function canonicalGitHubPushUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 256) return undefined;
  const prefix = GITHUB_PUSH_PREFIXES.find((candidate) => value.startsWith(candidate));
  if (prefix === undefined) return undefined;
  const path = value.slice(prefix.length);
  const repository = path.endsWith(".git") ? path.slice(0, -4) : path;
  if (!isGitHubOwnerAndRepo(repository)) return undefined;
  return `${prefix}${repository}.git`;
}
