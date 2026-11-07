import {
  isSafeAtlassianIdentifier,
  type JiraMutationAttempt,
  type JiraMutationReceipt,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import {
  TOOL_CATALOG_LIMITS,
  type CatalogJsonObject,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { asArray, asRecord } from "./atlassian-sync-classify.js";
import type { AtlassianWriteHttpOutcome } from "./atlassian-write-http.js";
import {
  jiraCommentSelfMatches,
  normalizeJiraCommentBody,
  type JiraCommentBinding,
} from "./jira-comment-binding.js";
import {
  jiraCommentVisibility,
  sameJiraCommentVisibility,
  type JiraCommentVisibility,
} from "./jira-comment-visibility.js";
import { bindJiraCommentIssue, readJiraBoundComment } from "./jira-managed-comments.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import { readJiraMutationIssue } from "./jira-mutation-confirmation.js";
import { dispatchFailure, JiraAcknowledgedMutationError } from "./jira-mutation-failure.js";
import { jiraNativeId, jiraNativeText } from "./jira-native-values.js";

type Failure = Extract<JiraMutationAttempt, { readonly ok: false }>;
interface Input {
  readonly issueKey: string;
  readonly commentId: string;
  readonly expectedBody: string;
  readonly expectedVisibility: JiraCommentVisibility | null;
}
const MALFORMED: Failure = { ok: false, reason: "malformed-payload" };
const CONFLICT: Failure = { ok: false, reason: "conflict" };
const ALLOWED = new Set(["issueKey", "commentId", "expectedBody", "expectedVisibility"]);

function input(args: CatalogJsonObject): Input | undefined {
  const expectedVisibility = jiraCommentVisibility(args.expectedVisibility);
  return isSafeAtlassianIdentifier(args.issueKey) &&
    jiraNativeId(args.commentId) &&
    jiraNativeText(args.expectedBody, 32768, true) &&
    args.expectedVisibility !== null &&
    expectedVisibility !== undefined &&
    Object.keys(args).every((key) => ALLOWED.has(key))
    ? {
        issueKey: args.issueKey,
        commentId: args.commentId,
        expectedBody: args.expectedBody,
        expectedVisibility,
      }
    : undefined;
}

function hasCommentPageMetadata(
  raw: Record<string, unknown> | undefined,
): raw is Record<string, unknown> & { readonly total: number; readonly maxResults: number } {
  return (
    raw?.startAt === 0 &&
    typeof raw.total === "number" &&
    Number.isSafeInteger(raw.total) &&
    raw.total >= 0 &&
    typeof raw.maxResults === "number" &&
    Number.isSafeInteger(raw.maxResults) &&
    raw.maxResults >= 1
  );
}
function completePage(
  response: Extract<AtlassianWriteHttpOutcome, { readonly ok: true }>,
): Failure | { readonly ok: true; readonly comments: readonly unknown[] } {
  const raw = response.body;
  const comments = asArray(raw?.comments);
  if (response.status !== 200 || !hasCommentPageMetadata(raw) || comments === undefined)
    return MALFORMED;
  if (raw.total > TOOL_CATALOG_LIMITS.maxArrayItems)
    return { ok: false, reason: "bounds-exceeded" };
  if (comments.length !== raw.total || comments.length > raw.maxResults) return MALFORMED;
  return { ok: true, comments };
}
/** Never infer absence from a truncated, permission-refused or partial native collection. */
async function commentIds(
  request: JiraMutationRequest,
  binding: JiraCommentBinding,
): Promise<Failure | { readonly ok: true; readonly ids: ReadonlySet<string> }> {
  const response = await request(
    `issue/${binding.issueId}/comment?startAt=0&maxResults=${String(TOOL_CATALOG_LIMITS.maxArrayItems)}`,
  );
  if (!response.ok) return dispatchFailure(response);
  const page = completePage(response);
  if (!page.ok) return page;
  const ids = new Set<string>();
  for (const comment of page.comments) {
    const item = asRecord(comment);
    if (!jiraNativeId(item?.id) || ids.has(item.id)) return MALFORMED;
    if (!jiraCommentSelfMatches(item.self, item.id, binding)) return CONFLICT;
    ids.add(item.id);
  }
  return { ok: true, ids };
}

async function inspect(
  request: JiraMutationRequest,
  selected: Input,
  baseUrl: string | undefined,
): Promise<
  Failure | {
    readonly ok: true;
    readonly issueKey: string;
    readonly binding: JiraCommentBinding;
  }
> {
  const bound = await bindJiraCommentIssue(request, selected, baseUrl);
  if (!bound.ok) return bound;
  const members = await commentIds(request, bound.binding);
  if (!members.ok) return members;
  if (!members.ids.has(selected.commentId)) return CONFLICT;
  const current = await readJiraBoundComment(request, selected, bound.binding);
  if (!current.ok) return current;
  if (
    normalizeJiraCommentBody(current.comment.body) !==
      normalizeJiraCommentBody(selected.expectedBody) ||
    !sameJiraCommentVisibility(current.comment.visibility, selected.expectedVisibility)
  )
    return {
      ...CONFLICT,
      detail: {
        messages: [
          "The comment text or visibility changed after review. Read and approve its current content before deleting it. Nothing was deleted.",
        ],
      },
    };
  return bound;
}

async function confirmRemoval(
  request: JiraMutationRequest,
  binding: JiraCommentBinding,
  receipt: JiraMutationReceipt,
): Promise<JiraMutationAttempt> {
  try {
    const parent = await readJiraMutationIssue(request, binding.issueId, ["summary"]);
    if (!parent.ok) return { ...parent, receipt };
    if (parent.id !== binding.issueId || parent.key !== receipt.issueKey)
      return { ...CONFLICT, receipt };
    const current = await commentIds(request, binding);
    if (!current.ok) return { ...current, receipt };
    return receipt.commentId !== undefined && !current.ids.has(receipt.commentId)
      ? { ok: true, receipt }
      : { ...CONFLICT, receipt };
  } catch (error) {
    throw new JiraAcknowledgedMutationError(error, receipt);
  }
}

export function isJiraCommentDelete(name: string): name is "jira.delete-comment" {
  return name === "jira.delete-comment";
}
/** One native DELETE. The caller owns exact approval, body-free activity and durable no-replay. */
export async function executeJiraCommentDelete(
  _operation: "jira.delete-comment",
  args: CatalogJsonObject,
  request: JiraMutationRequest,
  check = false,
  baseUrl?: string,
): Promise<JiraMutationAttempt> {
  const selected = input(args);
  if (selected === undefined)
    return {
      ok: false,
      reason: "field-validation",
      detail: {
        validation: "invalid-field",
        messages: [
          "Select an issue and exact comment ID, with its reviewed text (at most 32768 characters) and visibility. Omit expectedVisibility only for an unrestricted comment.",
        ],
      },
    };
  const inspected = await inspect(request, selected, baseUrl);
  if (!inspected.ok) return inspected;
  if (check) return { ok: true, receipt: {} };
  const { binding } = inspected;
  const receipt = {
    issueKey: inspected.issueKey,
    issueId: binding.issueId,
    commentId: selected.commentId,
  };
  const response = await request(
    `issue/${binding.issueId}/comment/${selected.commentId}`,
    "DELETE",
    undefined,
    "none",
  );
  if (!response.ok) return { ...dispatchFailure(response), receipt };
  if (response.status < 200 || response.status >= 300) return { ...MALFORMED, receipt };
  return confirmRemoval(request, binding, receipt);
}
