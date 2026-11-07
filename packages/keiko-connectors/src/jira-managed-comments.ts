import {
  isSafeAtlassianIdentifier,
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
import { confirmJiraComment } from "./jira-mutation-confirmation.js";
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
function path(input: CommentTarget): string {
  return `issue/${encodeURIComponent(input.issueKey)}/comment/${input.commentId}`;
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
async function readComment(
  request: JiraMutationRequest,
  input: CommentTarget,
): Promise<Failure | { readonly ok: true; readonly comment: CommentView }> {
  const response = await request(path(input));
  if (!response.ok) return dispatchFailure(response);
  const raw = response.body;
  if (response.status !== 200 || !jiraNativeId(raw?.id) || !jiraNativeText(raw.body, 32768, true))
    return MALFORMED;
  if (raw.id !== input.commentId) return CONFLICT;
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
): Promise<ManagedMcpToolResult> {
  const input = target(args, false);
  if (input === undefined) return jiraReadFailure("invalid-input");
  const current = await readComment(request, input);
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
): Promise<JiraMutationAttempt> {
  const input = target(args, true);
  if (input === undefined || typeof args.body !== "string")
    return { ok: false, reason: "field-validation", detail: { validation: "invalid-field" } };
  const prior = await readComment(request, input);
  if (!prior.ok) return prior;
  if (prior.comment.body === args.body) return { ...CONFLICT, receipt: input };
  if (check) return { ok: true, receipt: {} };
  const visibility = prior.comment.visibility;
  const response = await request(path(input), "PUT", {
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
  );
  return { ...(failure ?? confirmed), receipt: input };
}
