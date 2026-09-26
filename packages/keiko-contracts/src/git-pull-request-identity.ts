import { isGitHubOwnerAndRepo } from "./github-issue-reference.js";
import { isGitObjectId, isSafeGitRefName } from "./git-repository.js";

/** Bounded remote facts for exact-revision delivery and restart reconciliation (#3387). */
export interface GitPullRequestIdentity {
  readonly number: number;
  readonly externalId: string;
  readonly url: string;
  readonly repository: string;
  readonly headRepository: string;
  readonly headRef: string;
  readonly headSha: string;
  readonly baseRef: string;
  readonly baseSha: string;
  readonly state: "open" | "closed";
  readonly isDraft: boolean;
}

const IDENTITY_KEYS = new Set([
  "number",
  "externalId",
  "url",
  "repository",
  "headRepository",
  "headRef",
  "headSha",
  "baseRef",
  "baseSha",
  "state",
  "isDraft",
]);

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validPrNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value < 10 ** 10;
}

function validRepository(value: unknown): value is string {
  return typeof value === "string" && isGitHubOwnerAndRepo(value);
}

function validBranch(value: unknown): value is string {
  return typeof value === "string" && isSafeGitRefName(value) && !value.startsWith("refs/");
}

function validProviderIdentity(value: Record<string, unknown>): boolean {
  if (!validPrNumber(value.number) || !validRepository(value.repository)) return false;
  if (typeof value.externalId !== "string" || !/^[A-Za-z0-9_=-]{1,255}$/u.test(value.externalId))
    return false;
  return (
    typeof value.url === "string" &&
    value.url.toLowerCase() ===
      `https://github.com/${value.repository}/pull/${String(value.number)}`.toLowerCase()
  );
}

function validGitIdentity(value: Record<string, unknown>): boolean {
  return (
    validRepository(value.headRepository) &&
    validBranch(value.headRef) &&
    validBranch(value.baseRef) &&
    isGitObjectId(value.headSha) &&
    isGitObjectId(value.baseSha) &&
    (value.state === "open" || value.state === "closed") &&
    typeof value.isDraft === "boolean"
  );
}

export function isGitPullRequestIdentity(value: unknown): value is GitPullRequestIdentity {
  return (
    record(value) &&
    Object.keys(value).length === IDENTITY_KEYS.size &&
    Object.keys(value).every((key) => IDENTITY_KEYS.has(key)) &&
    validProviderIdentity(value) &&
    validGitIdentity(value)
  );
}
