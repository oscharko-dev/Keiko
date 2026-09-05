import { isGitHubOwnerAndRepo } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime";
import type { GitPullRequestIdentity } from "@oscharko-dev/keiko-contracts/runtime/git-pull-request";
import { parseGitPrIdentity, GIT_PR_IDENTITY_JQ } from "./git-pr-identity.js";
import type { GitPrExecResult, GitPrInspectionResult, GitPrReadRequest } from "./git-pr-gateway.js";

export const GIT_PR_BODY_MAX_BYTES = 65_536;
export interface GitPrBody {
  readonly identity: GitPullRequestIdentity;
  /** Transient exact markdown. Never evidence, activity metadata, or a durable store field. */
  readonly body: string;
  readonly updatedAt: string;
}
export interface GitPrBodyUpdateRequest extends GitPrReadRequest {
  readonly body: string;
}
export interface GitPullRequestBodyAdapter {
  readPullRequestBody(request: GitPrReadRequest): Promise<GitPrInspectionResult<GitPrBody>>;
  updatePullRequestBody(request: GitPrBodyUpdateRequest): Promise<GitPrExecResult>;
}
// TAB/LF/CR are legitimate Markdown bytes; other controls are refused, never normalized.
// eslint-disable-next-line no-control-regex -- intentionally rejects unsafe control bytes.
const BODY_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function keys(value: object, expected: readonly string[]): boolean {
  return (
    Reflect.ownKeys(value).length === expected.length &&
    expected.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor !== undefined && Object.hasOwn(descriptor, "value");
    })
  );
}
function endpoint(request: GitPrReadRequest, expectedKeys: readonly string[]): string {
  if (
    !keys(request, expectedKeys) ||
    !isGitHubOwnerAndRepo(request.ownerAndRepo) ||
    !/^[1-9]\d{0,9}$/u.test(request.prExternalId)
  )
    throw new TypeError("Invalid PR body request");
  return `/repos/${request.ownerAndRepo}/pulls/${request.prExternalId}`;
}
export function buildPrBodyReadArgv(request: GitPrReadRequest): readonly string[] {
  return [
    "api",
    "--hostname",
    "github.com",
    "--method",
    "GET",
    endpoint(request, ["ownerAndRepo", "prExternalId"]),
    "--jq",
    `{identity:${GIT_PR_IDENTITY_JQ},body,updatedAt:.updated_at}`,
  ];
}
export function validGitPrBodyText(body: unknown): body is string {
  return (
    typeof body === "string" &&
    Buffer.byteLength(body, "utf8") <= GIT_PR_BODY_MAX_BYTES &&
    !BODY_CONTROL.test(body) &&
    !body.includes("\ufffd") &&
    Buffer.from(body, "utf8").toString("utf8") === body
  );
}
export function buildPrBodyUpdateArgv(request: GitPrBodyUpdateRequest): readonly string[] {
  const target = endpoint(request, ["ownerAndRepo", "prExternalId", "body"]);
  if (!validGitPrBodyText(request.body)) throw new TypeError("Invalid PR body content");
  return [
    "api",
    "--hostname",
    "github.com",
    "--method",
    "PATCH",
    target,
    "-f",
    `body=${request.body}`,
    "--jq",
    ".number",
  ];
}
export function parseGitPrBody(value: unknown, request: GitPrReadRequest): GitPrBody | undefined {
  if (!record(value) || !keys(value, ["identity", "body", "updatedAt"])) return undefined;
  const identity = parseGitPrIdentity(value.identity, request.ownerAndRepo);
  const body = value.body === null ? "" : value.body;
  if (
    identity === undefined ||
    String(identity.number) !== request.prExternalId ||
    !validGitPrBodyText(body) ||
    typeof value.updatedAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value.updatedAt)
  )
    return undefined;
  const timestamp = Date.parse(value.updatedAt);
  if (!Number.isFinite(timestamp)) return undefined;
  return { identity, body, updatedAt: new Date(timestamp).toISOString() };
}
