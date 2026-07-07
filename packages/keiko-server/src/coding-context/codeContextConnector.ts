import type {
  CodingWorkbenchConnectorScope,
  CodingWorkbenchMode,
} from "@oscharko-dev/keiko-contracts";
import { CODING_WORKBENCH_SCHEMA_VERSION } from "@oscharko-dev/keiko-contracts";
import { redactCodingWorkbenchEvidenceText } from "@oscharko-dev/keiko-contracts";
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

export interface CodeContextRawObject {
  readonly source: CodeContextSource;
  readonly objectKind: CodeContextObjectKind;
  readonly objectId: string;
  readonly title: string;
  readonly body: string;
  readonly comments: readonly CodeContextRawComment[];
  readonly url?: string | undefined;
}

export interface CodeContextConnector {
  read(ref: CodeContextRef): Promise<CodeContextRawObject>;
}

export interface CodeContextConnectorConfig extends QiConnectorConfig {
  readonly github_connector_authorized?: unknown;
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

const OWNER_REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/u;
const NUMBER_RE = /^[1-9][0-9]{0,9}$/u;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function buildGitHubCodeContextArgv(ref: GitHubCodeContextRef): readonly string[] {
  const repo = assertOwnerAndRepo(ref.ownerAndRepo);
  const objectId = assertNumericObjectId(ref.objectId);
  const path = ref.objectKind === "pull-request" ? "pulls" : "issues";
  return [
    "api",
    `/repos/${repo}/${path}/${objectId}`,
    "--jq",
    "{title:.title,body:.body,comments:.comments,url:.html_url}",
  ];
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
  if (!connectorAuthorized(ref.source, config)) {
    return { allowed: false, reason: "missing-credentials", requiredScope };
  }
  return { allowed: true, requiredScope };
}

function connectorAuthorized(
  source: CodeContextSource,
  config: CodeContextConnectorConfig | undefined,
): boolean {
  if (source === "jira") return isJiraConnectorAuthorized(config);
  return config?.github_connector_authorized === true;
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
    contentDigest: contentDigest(raw),
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

function contentDigest(raw: CodeContextRawObject): string {
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
  if (!OWNER_REPO_RE.test(value)) throw new Error("ownerAndRepo must match owner/repo");
  return value;
}

function assertNumericObjectId(value: string): string {
  if (!NUMBER_RE.test(value)) throw new Error("objectId must be a positive number");
  return value;
}
