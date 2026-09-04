import type {
  CodingWorkbenchConnectorScope,
  CodingWorkbenchMode,
} from "@oscharko-dev/keiko-contracts";
import { CODING_WORKBENCH_SCHEMA_VERSION } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench";
import { redactCodingWorkbenchEvidenceText } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-evidence";
// The ONE owner/repo and issue-number rule (#3385). This module used to carry its own copy of both
// regexes, one of three across the coding-context surface; the parser leaf now owns the boundary.
import {
  isGitHubOwnerAndRepo,
  parseGitHubIssueNumber,
} from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime";
import { sha256Hex } from "@oscharko-dev/keiko-security";

import {
  isJiraConnectorAuthorized,
  type QiConnectorConfig,
} from "../qualityIntelligence/connectorAuthorization.js";

export type CodeContextSource = "github" | "jira";
export type CodeContextObjectKind = "issue" | "pull-request";
export type CodeContextReadStatus = "ready" | "blocked" | "degraded";
export type CodeContextBlockReason = "missing-scope" | "missing-credentials" | "mode-ceiling";

export interface GitHubCodeContextRef {
  readonly source: "github";
  readonly objectKind: CodeContextObjectKind;
  readonly ownerAndRepo: string;
  readonly objectId: string;
}

export interface JiraCodeContextRef {
  readonly source: "jira";
  readonly objectKind: "issue";
  readonly projectKey: string;
  readonly objectId: string;
}

export type CodeContextRef = GitHubCodeContextRef | JiraCodeContextRef;

export interface CodeContextReadRequest {
  readonly runId: string;
  readonly effectiveMode: CodingWorkbenchMode;
  readonly connectorScopes: readonly CodingWorkbenchConnectorScope[];
  readonly refs: readonly CodeContextRef[];
  readonly maxBodyBytes: number;
}

export interface CodeContextRawComment {
  readonly id: string;
  readonly body: string;
}

/** The bound issue's lifecycle as the provider reports it. */
export type CodeContextObjectState = "open" | "closed";

export interface CodeContextRawObject {
  readonly source: CodeContextSource;
  readonly objectKind: CodeContextObjectKind;
  readonly objectId: string;
  readonly title: string;
  readonly body: string;
  readonly comments: readonly CodeContextRawComment[];
  readonly url?: string | undefined;
  /**
   * Content-free provider identity (#3385), present when the read projected it. `providerId` is
   * the immutable numeric id a transferred or renumbered issue does NOT keep, which is what an
   * issue binding digests; `state` and `isPullRequest` are what let a resolver refuse a closed
   * issue or a pull request served from the issues endpoint; `commentCount` is the provider's own
   * total, which the bounded `comments` page may undercount.
   */
  readonly providerId?: string | undefined;
  readonly providerNodeId?: string | undefined;
  readonly state?: CodeContextObjectState | undefined;
  readonly isPullRequest?: boolean | undefined;
  readonly commentCount?: number | undefined;
}

export interface CodeContextConnector {
  read(ref: CodeContextRef): Promise<CodeContextRawObject>;
}

export interface CodeContextConnectorConfig extends QiConnectorConfig {
  readonly github_connector_authorized?: unknown;
  /**
   * The one GitHub repository a granted checkout may be read for, as `owner/repo`.
   *
   * The grant is stored against a local checkout while the request names the remote repository
   * freely, so authorization alone said "may read GitHub" rather than "may read THIS repository":
   * a grant for one checkout admitted any repository the credentials could reach (CWE-863).
   * Undefined denies every GitHub ref, which is the fail-closed direction — a checkout with no
   * readable GitHub remote authorizes nothing.
   */
  readonly github_allowed_owner_and_repo?: string | undefined;
  readonly coding_context_allowed_modes?: readonly CodingWorkbenchMode[] | undefined;
}

export interface CodeContextConnectorDeps {
  readonly connectors: Readonly<Record<CodeContextSource, CodeContextConnector>>;
  readonly connectorConfig?: CodeContextConnectorConfig | undefined;
  readonly nowIso: () => string;
}

export interface CodeContextPackComment {
  readonly id: string;
  readonly body: string;
  readonly bodyTruncated: boolean;
}

export interface CodeContextPackItem {
  readonly source: CodeContextSource;
  readonly objectKind: CodeContextObjectKind;
  readonly objectId: string;
  readonly label: string;
  readonly untrusted: true;
  readonly title: string;
  readonly body: string;
  readonly bodyTruncated: boolean;
  readonly comments: readonly CodeContextPackComment[];
  readonly contentDigest: string;
}

export interface CodeContextBlockedRef {
  readonly source: CodeContextSource;
  readonly objectKind: CodeContextObjectKind;
  readonly objectId: string;
  readonly reason: CodeContextBlockReason;
  readonly requiredScope: CodingWorkbenchConnectorScope;
}

export interface CodeContextEvidenceSummary {
  readonly schemaVersion: typeof CODING_WORKBENCH_SCHEMA_VERSION;
  readonly runId: string;
  readonly occurredAt: string;
  readonly status: CodeContextReadStatus;
  readonly safeSummary: string;
  readonly sourceCounts: Readonly<Record<CodeContextSource, number>>;
  readonly objectCount: number;
  readonly blockedCount: number;
  readonly commentCount: number;
  readonly byteCount: number;
  readonly contentDigest: string;
}

export interface CodeContextPackResult {
  readonly status: CodeContextReadStatus;
  readonly items: readonly CodeContextPackItem[];
  readonly blocked: readonly CodeContextBlockedRef[];
  readonly evidence: CodeContextEvidenceSummary;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

// The projection is content-bearing (title, body) AND identity-bearing (#3385): the immutable id
// as a string so a 64-bit provider id cannot lose precision in transit, the node id, the lifecycle
// state, and whether the object is really a pull request served from the issues endpoint. `.comments`
// on the object is the provider's total count, not the page of comments the second read fetches.
export const GITHUB_CODE_CONTEXT_OBJECT_JQ =
  "{id:(.id|tostring),nodeId:.node_id,state:.state,isPullRequest:(.pull_request!=null)," +
  "title:.title,body:.body,comments:.comments,url:.html_url}";

export function buildGitHubCodeContextArgv(ref: GitHubCodeContextRef): readonly string[] {
  const repo = assertOwnerAndRepo(ref.ownerAndRepo);
  const objectId = assertNumericObjectId(ref.objectId);
  const path = ref.objectKind === "pull-request" ? "pulls" : "issues";
  return ["api", `/repos/${repo}/${path}/${objectId}`, "--jq", GITHUB_CODE_CONTEXT_OBJECT_JQ];
}

/**
 * Map the two `gh api` answers (`buildGitHubCodeContextArgv` and `buildGitHubCodeContextCommentsArgv`)
 * onto one raw object. Lives beside the projection it reads so the two cannot drift: a field added
 * to the jq above is mapped here, in the same file, or it is not read at all. Content fields
 * default to an empty string; identity fields are absent rather than defaulted, because a resolver
 * that cannot see an id, a state or a pull-request marker must refuse, never assume `open`.
 */
export function gitHubCodeContextRawObjectFrom(
  ref: GitHubCodeContextRef,
  objectJson: unknown,
  commentsJson: unknown,
): CodeContextRawObject {
  const object = asRecord(objectJson, "GitHub object");
  return {
    source: "github",
    objectKind: ref.objectKind,
    objectId: ref.objectId,
    title: optionalString(object.title),
    body: optionalString(object.body),
    comments: commentsFromGitHub(commentsJson),
    url: optionalString(object.url),
    ...identityFromGitHub(object),
  };
}

function identityFromGitHub(
  object: Record<string, unknown>,
): Pick<
  CodeContextRawObject,
  "providerId" | "providerNodeId" | "state" | "isPullRequest" | "commentCount"
> {
  const providerId = typeof object.id === "string" && /^[0-9]{1,20}$/u.test(object.id)
    ? object.id
    : undefined;
  const state = object.state === "open" || object.state === "closed" ? object.state : undefined;
  return {
    ...(providerId === undefined ? {} : { providerId }),
    ...(typeof object.nodeId === "string" && object.nodeId.length > 0
      ? { providerNodeId: object.nodeId }
      : {}),
    ...(state === undefined ? {} : { state }),
    ...(typeof object.isPullRequest === "boolean" ? { isPullRequest: object.isPullRequest } : {}),
    ...(Number.isSafeInteger(object.comments) && Number(object.comments) >= 0
      ? { commentCount: Number(object.comments) }
      : {}),
  };
}

function commentsFromGitHub(value: unknown): readonly CodeContextRawComment[] {
  if (!Array.isArray(value)) throw new Error("GitHub comments response must be an array");
  return value.map((entry) => {
    const comment = asRecord(entry, "GitHub comment");
    return { id: optionalString(comment.id), body: optionalString(comment.body) };
  });
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} response must be an object`);
  }
  return value as Record<string, unknown>;
}

function optionalString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function buildGitHubCodeContextCommentsArgv(ref: GitHubCodeContextRef): readonly string[] {
  const repo = assertOwnerAndRepo(ref.ownerAndRepo);
  const objectId = assertNumericObjectId(ref.objectId);
  return [
    "api",
    `/repos/${repo}/issues/${objectId}/comments?per_page=50`,
    "--jq",
    "[.[]|{id:(.id|tostring),body:.body}]",
  ];
}

export async function buildCodeContextPack(
  request: CodeContextReadRequest,
  deps: CodeContextConnectorDeps,
): Promise<CodeContextPackResult> {
  const blocked: CodeContextBlockedRef[] = [];
  const items: CodeContextPackItem[] = [];
  for (const ref of request.refs) {
    const decision = authorizeCodeContextRead(ref, request, deps.connectorConfig);
    if (!decision.allowed) {
      blocked.push(blockedRef(ref, decision.reason, decision.requiredScope));
      continue;
    }
    const raw = await deps.connectors[ref.source].read(ref);
    items.push(packItem(raw, request.maxBodyBytes));
  }
  const status = statusFor(items, blocked);
  return {
    status,
    items,
    blocked,
    evidence: evidenceSummary(request.runId, deps.nowIso(), status, items, blocked),
  };
}

interface AuthorizationDecision {
  readonly allowed: boolean;
  readonly reason?: CodeContextBlockReason | undefined;
  readonly requiredScope: CodingWorkbenchConnectorScope;
}

function authorizeCodeContextRead(
  ref: CodeContextRef,
  request: CodeContextReadRequest,
  config: CodeContextConnectorConfig | undefined,
): AuthorizationDecision {
  const requiredScope = requiredScopeFor(ref.source);
  if (!modeAllowsConnectorContext(request.effectiveMode, config)) {
    return { allowed: false, reason: "mode-ceiling", requiredScope };
  }
  if (!request.connectorScopes.includes(requiredScope)) {
    return { allowed: false, reason: "missing-scope", requiredScope };
  }
  if (!connectorAuthorized(ref, config)) {
    return { allowed: false, reason: "missing-credentials", requiredScope };
  }
  return { allowed: true, requiredScope };
}

function connectorAuthorized(
  ref: CodeContextRef,
  config: CodeContextConnectorConfig | undefined,
): boolean {
  if (ref.source === "jira") return isJiraConnectorAuthorized(config);
  if (config?.github_connector_authorized !== true) return false;
  // The grant names a repository, and this ref must be that repository. Comparing case-insensitively
  // because GitHub treats owner and name that way, so `Owner/Repo` and `owner/repo` are one resource
  // and must not be two different authorization answers.
  const allowed = config.github_allowed_owner_and_repo;
  return (
    typeof allowed === "string" &&
    allowed.length > 0 &&
    ref.ownerAndRepo.toLowerCase() === allowed.toLowerCase()
  );
}

function requiredScopeFor(source: CodeContextSource): CodingWorkbenchConnectorScope {
  return source === "github" ? "source-control.read" : "issue-tracker.read";
}

function modeAllowsConnectorContext(
  mode: CodingWorkbenchMode,
  config: CodeContextConnectorConfig | undefined,
): boolean {
  const allowedModes = config?.coding_context_allowed_modes;
  return allowedModes === undefined || allowedModes.includes(mode);
}

function blockedRef(
  ref: CodeContextRef,
  reason: CodeContextBlockReason | undefined,
  requiredScope: CodingWorkbenchConnectorScope,
): CodeContextBlockedRef {
  return {
    source: ref.source,
    objectKind: ref.objectKind,
    objectId: ref.objectId,
    reason: reason ?? "missing-credentials",
    requiredScope,
  };
}

function packItem(raw: CodeContextRawObject, maxBodyBytes: number): CodeContextPackItem {
  const body = bounded(raw.body, maxBodyBytes);
  return {
    source: raw.source,
    objectKind: raw.objectKind,
    objectId: raw.objectId,
    label: contextLabel(raw.source, raw.objectKind, raw.objectId),
    untrusted: true,
    title: raw.title,
    body: body.value,
    bodyTruncated: body.truncated,
    comments: raw.comments.map((comment) => packComment(comment, maxBodyBytes)),
    contentDigest: codeContextContentDigest(raw),
  };
}

function packComment(comment: CodeContextRawComment, maxBodyBytes: number): CodeContextPackComment {
  const body = bounded(comment.body, maxBodyBytes);
  return { id: comment.id, body: body.value, bodyTruncated: body.truncated };
}

function contextLabel(
  source: CodeContextSource,
  objectKind: CodeContextObjectKind,
  objectId: string,
): string {
  const sourceLabel = source === "github" ? "source-control" : "issue-tracker";
  return `untrusted-${sourceLabel}-${objectKind}-${objectId}`;
}

/**
 * sha256 over the content actually read — title, body and the bounded comment page — keyed by the
 * object's source identity. Exported (#3385) because the issue binding's `contentRevisionDigest`
 * is this same value: one formula, so a binding made at preview time and a pack attached at run
 * time agree on whether the issue text changed in between.
 */
export function codeContextContentDigest(raw: CodeContextRawObject): string {
  return sha256Hex(
    JSON.stringify({
      source: raw.source,
      objectKind: raw.objectKind,
      objectId: raw.objectId,
      title: raw.title,
      body: raw.body,
      comments: raw.comments,
    }),
  );
}

function evidenceSummary(
  runId: string,
  occurredAt: string,
  status: CodeContextReadStatus,
  items: readonly CodeContextPackItem[],
  blocked: readonly CodeContextBlockedRef[],
): CodeContextEvidenceSummary {
  return {
    schemaVersion: CODING_WORKBENCH_SCHEMA_VERSION,
    runId,
    occurredAt,
    status,
    safeSummary: redactCodingWorkbenchEvidenceText("connector-read"),
    sourceCounts: {
      github: items.filter((item) => item.source === "github").length,
      jira: items.filter((item) => item.source === "jira").length,
    },
    objectCount: items.length,
    blockedCount: blocked.length,
    commentCount: items.reduce((sum, item) => sum + item.comments.length, 0),
    byteCount: items.reduce((sum, item) => sum + byteCount(item), 0),
    contentDigest: sha256Hex(items.map((item) => item.contentDigest).join("\n")),
  };
}

function byteCount(item: CodeContextPackItem): number {
  return byteLength(item.title) + byteLength(item.body) + commentsByteCount(item.comments);
}

function commentsByteCount(comments: readonly CodeContextPackComment[]): number {
  return comments.reduce((sum, comment) => sum + byteLength(comment.body), 0);
}

function statusFor(
  items: readonly CodeContextPackItem[],
  blocked: readonly CodeContextBlockedRef[],
): CodeContextReadStatus {
  if (blocked.length === 0) return "ready";
  return items.length === 0 ? "blocked" : "degraded";
}

function bounded(
  value: string,
  maxBytes: number,
): { readonly value: string; readonly truncated: boolean } {
  const bytes = textEncoder.encode(value);
  if (bytes.byteLength <= maxBytes) return { value, truncated: false };
  return { value: textDecoder.decode(bytes.slice(0, Math.max(0, maxBytes))), truncated: true };
}

function byteLength(value: string): number {
  return textEncoder.encode(value).byteLength;
}

function assertOwnerAndRepo(value: string): string {
  if (!isGitHubOwnerAndRepo(value)) throw new Error("ownerAndRepo must match owner/repo");
  return value;
}

function assertNumericObjectId(value: string): string {
  if (parseGitHubIssueNumber(value) === undefined) {
    throw new Error("objectId must be a positive number");
  }
  return value;
}
