import {
  isSafeAtlassianIdentifier,
  isSafeAtlassianConnectorBaseUrl,
  type JiraMutationAttempt,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ManagedMcpToolResult } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { asRecord } from "./atlassian-sync-classify.js";
import type { AtlassianWriteHttpOutcome } from "./atlassian-write-http.js";
import { jiraCommentVisibility, type JiraCommentVisibility } from "./jira-comment-visibility.js";
import { boundJiraReadResult } from "./jira-managed-issue-reads.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import { jiraReadFailure } from "./jira-managed-metadata.js";
import { confirmJiraComment, readJiraMutationIssue } from "./jira-mutation-confirmation.js";
import {
  jiraCommentSelfMatches,
  normalizeJiraCommentBody,
  type JiraCommentBinding,
} from "./jira-comment-binding.js";
import { dispatchFailure } from "./jira-mutation-failure.js";
import { jiraNativeId, jiraNativeText } from "./jira-native-values.js";

type Failure = Extract<JiraMutationAttempt, { readonly ok: false }>;
interface CommentTarget {
  readonly issueKey: string;
  readonly commentId: string;
}
interface CommentView {
  readonly body: string;
  readonly visibility: JiraCommentVisibility | null;
  readonly item: CatalogJsonObject;
}
const MALFORMED: Failure = { ok: false, reason: "malformed-payload" };
const CONFLICT: Failure = { ok: false, reason: "conflict" };

export function isJiraCommentRead(name: string): name is "jira.get-comment" {
  return name === "jira.get-comment";
}
export function isJiraCommentMutation(name: string): name is "jira.update-comment" {
  return name === "jira.update-comment";
}
function target(args: CatalogJsonObject, write: boolean): CommentTarget | undefined {
  return isSafeAtlassianIdentifier(args.issueKey) &&
    jiraNativeId(args.commentId) &&
    Object.keys(args).every(
      (key) => key === "issueKey" || key === "commentId" || (write && key === "body"),
    ) &&
    (!write || jiraNativeText(args.body, 32768))
    ? { issueKey: args.issueKey, commentId: args.commentId }
    : undefined;
}
function path(input: CommentTarget, binding: JiraCommentBinding): string {
  return `issue/${binding.issueId}/comment/${input.commentId}`;
}
export async function bindJiraCommentIssue(
  request: JiraMutationRequest,
  input: CommentTarget,
  baseUrl: string | undefined,
): Promise<
  Failure | {
    readonly ok: true;
    readonly issueKey: string;
    readonly binding: JiraCommentBinding;
  }
> {
  if (baseUrl === undefined || !isSafeAtlassianConnectorBaseUrl(baseUrl)) return MALFORMED;
  const current = await readJiraMutationIssue(request, input.issueKey, ["summary"]);
  if (!current.ok) return current;
  return jiraNativeId(current.id) && isSafeAtlassianIdentifier(current.key)
    ? { ok: true, issueKey: current.key, binding: { issueId: current.id, baseUrl } }
    : MALFORMED;
}
function optionalMetadata(raw: Record<string, unknown>): CatalogJsonObject {
  const fields: Record<string, string> = {};
  for (const key of ["created", "updated"]) {
    if (jiraNativeText(raw[key], 64)) fields[key] = raw[key];
  }
  const author = asRecord(raw.author);
  if (jiraNativeText(author?.name, 255)) fields.authorName = author.name;
  if (jiraNativeText(author?.displayName, 255)) fields.authorDisplayName = author.displayName;
  return fields;
}
export async function readJiraBoundComment(
  request: JiraMutationRequest,
  input: CommentTarget,
  binding: JiraCommentBinding,
): Promise<Failure | { readonly ok: true; readonly comment: CommentView }> {
  const response = await request(path(input, binding));
  if (!response.ok) return dispatchFailure(response);
  const raw = response.body;
  if (response.status !== 200 || !jiraNativeId(raw?.id) || !jiraNativeText(raw.body, 32768, true))
    return MALFORMED;
  if (raw.id !== input.commentId || !jiraCommentSelfMatches(raw.self, input.commentId, binding))
    return CONFLICT;
  const visibility = jiraCommentVisibility(raw.visibility);
  if (visibility === undefined) return MALFORMED;
  return {
    ok: true,
    comment: {
      body: raw.body,
      visibility,
      item: {
        id: raw.id,
        issueKey: input.issueKey,
        body: raw.body,
        ...optionalMetadata(raw),
        ...(visibility === null ? {} : { visibility: { ...visibility } }),
      },
    },
  };
}
export async function executeJiraCommentRead(
  _operation: "jira.get-comment",
  args: CatalogJsonObject,
  request: JiraMutationRequest,
  baseUrl: string,
): Promise<ManagedMcpToolResult> {
  const input = target(args, false);
  if (input === undefined) return jiraReadFailure("invalid-input");
  const bound = await bindJiraCommentIssue(request, input, baseUrl);
  if (!bound.ok) return jiraReadFailure(bound.reason, bound.detail);
  const current = await readJiraBoundComment(request, input, bound.binding);
  return current.ok
    ? boundJiraReadResult({ data: { outcome: "succeeded", items: [current.comment.item] } })
    : jiraReadFailure(current.reason, current.detail);
}
function acknowledgementFailure(
  response: AtlassianWriteHttpOutcome,
  commentId: string,
): Failure | undefined {
  if (!response.ok) return dispatchFailure(response);
  if (response.status !== 200 || response.body === undefined) return MALFORMED;
  return response.body.id === commentId ? undefined : CONFLICT;
}
/** One native PUT; the caller owns custody, approval, body-free activity and durable no-replay. */
export async function executeJiraCommentMutation(
  _operation: "jira.update-comment",
  args: CatalogJsonObject,
  request: JiraMutationRequest,
  check = false,
  baseUrl?: string,
): Promise<JiraMutationAttempt> {
  const input = target(args, true);
  if (input === undefined || typeof args.body !== "string")
    return { ok: false, reason: "field-validation", detail: { validation: "invalid-field" } };
  const bound = await bindJiraCommentIssue(request, input, baseUrl);
  if (!bound.ok) return bound;
  const prior = await readJiraBoundComment(request, input, bound.binding);
  if (!prior.ok) return prior;
  if (normalizeJiraCommentBody(prior.comment.body) === normalizeJiraCommentBody(args.body))
    return {
      ...CONFLICT,
      receipt: input,
      detail: {
        unchanged: true,
        messages: ["The comment already holds the requested text. Nothing was written."],
      },
    };
  if (check) return { ok: true, receipt: {} };
  const visibility = prior.comment.visibility;
  const response = await request(path(input, bound.binding), "PUT", {
    body: args.body,
    ...(visibility === null ? {} : { visibility: { ...visibility } }),
  });
  const failure = acknowledgementFailure(response, input.commentId);
  const confirmed = await confirmJiraComment(
    request,
    input.issueKey,
    input.commentId,
    args.body,
    visibility,
    bound.binding,
  );
  return { ...(failure ?? confirmed), receipt: input };
}
