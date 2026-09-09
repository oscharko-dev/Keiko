import type { CodingWorkbenchIssueBinding } from "./coding-workbench-runtime.js";
import type { CodingWorkbenchValidationResult } from "./coding-workbench.js";
import { CODING_WORKBENCH_RUNTIME_CONTRACT_VERSION } from "./coding-workbench-runtime-constants.js";
import { GITHUB_ISSUE_NUMBER_MAX } from "./github-issue-reference.js";
import { isSafeGitRefName } from "./git-repository.js";
import {
  exactKeys,
  isRecord,
  result,
  validateSafeId,
} from "./coding-workbench-runtime-api-validation.js";

export const CODING_WORKBENCH_ISSUE_NUMBER_MAX = GITHUB_ISSUE_NUMBER_MAX;
const DIGEST_FIELDS = [
  "remoteDigest",
  "issueIdDigest",
  "contentRevisionDigest",
  "bindingDigest",
] as const;
const KEYS = ["schemaVersion", "repositoryId", "issueNumber", "defaultBaseRef", ...DIGEST_FIELDS];

/** One content-free issue contract for runtime authority, snapshots, and the durable ledger. */
export function validateCodingWorkbenchIssueBinding(
  value: unknown,
): CodingWorkbenchValidationResult<CodingWorkbenchIssueBinding> {
  if (!isRecord(value)) return { ok: false, errors: ["issueBinding must be an object"] };
  const errors = exactKeys(value, KEYS, "issueBinding");
  if (value.schemaVersion !== CODING_WORKBENCH_RUNTIME_CONTRACT_VERSION)
    errors.push("issueBinding.schemaVersion is invalid");
  validateSafeId(value.repositoryId, "issueBinding.repositoryId", errors, 128);
  for (const field of DIGEST_FIELDS) {
    if (typeof value[field] !== "string" || !/^[a-f0-9]{64}$/u.test(value[field]))
      errors.push(`issueBinding.${field} must be a sha256 digest`);
  }
  if (!validIssueNumber(value.issueNumber))
    errors.push("issueBinding.issueNumber must be a bounded positive integer");
  if (typeof value.defaultBaseRef !== "string" || !isSafeGitRefName(value.defaultBaseRef))
    errors.push("issueBinding.defaultBaseRef must be a bounded safe git ref");
  return result(value, errors);
}

function validIssueNumber(value: unknown): boolean {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= CODING_WORKBENCH_ISSUE_NUMBER_MAX
  );
}
