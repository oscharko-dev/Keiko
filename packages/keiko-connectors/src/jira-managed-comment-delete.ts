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

interface CommentPage {
  readonly ok: true;
  readonly total: number;
  readonly comments: readonly unknown[];
  readonly last: boolean;
}
function pageMetadata(raw: Record<string, unknown> | undefined, start: number): raw is Record<string, unknown> & { readonly total: number; readonly maxResults: number } {
  return raw?.startAt === start && typeof raw.total === "number" && Number.isSafeInteger(raw.total) && raw.total >= start &&
    typeof raw.maxResults === "number" && Number.isSafeInteger(raw.maxResults) && raw.maxResults >= 1;
}
function commentPage(response: Extract<AtlassianWriteHttpOutcome, { readonly ok: true }>, start: number,
  total: number | undefined): Failure | CommentPage {
  const raw = response.body;
  const comments = asArray(raw?.comments);
  if (response.status !== 200 || !pageMetadata(raw, start) || comments === undefined) return MALFORMED;
  if (total !== undefined && raw.total !== total) return CONFLICT;
  if (comments.length > Math.min(raw.maxResults, TOOL_CATALOG_LIMITS.maxArrayItems) || start + comments.length > raw.total) return MALFORMED;
  const last = start + comments.length === raw.total;
  if (!last && comments.length === 0) return MALFORMED;
  return { ok: true, comments, total: raw.total, last };
}
function collectCommentIds(comments: readonly unknown[], ids: Set<string>, binding: JiraCommentBinding): Failure | undefined {
  for (const comment of comments) {
    const item = asRecord(comment);
    if (!jiraNativeId(item?.id) || ids.has(item.id)) return MALFORMED;
    if (!jiraCommentSelfMatches(item.self, item.id, binding)) return CONFLICT;
    ids.add(item.id);
  }
  return undefined;
}
/** Complete native pages share the caller's admitted request/deadline budget. The catalog's
 * per-array bound limits each response, not the number of comments allowed on an issue.
 * A changed total, repeated identity, missing page or budget refusal never establishes absence.
 */
async function commentIds(request: JiraMutationRequest, binding: JiraCommentBinding): Promise<Failure | { readonly ok: true; readonly ids: ReadonlySet<string> }> {
  const ids = new Set<string>();
  let total: number | undefined;
  for (;;) {
    const response = await request(`issue/${binding.issueId}/comment?startAt=${String(ids.size)}&maxResults=${String(TOOL_CATALOG_LIMITS.maxArrayItems)}`);
    if (!response.ok) return dispatchFailure(response);
    const page = commentPage(response, ids.size, total);
    if (!page.ok) return page;
    total = page.total;
    const refused = collectCommentIds(page.comments, ids, binding);
    if (refused !== undefined) return refused;
    if (page.last) return { ok: true, ids };
  }
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
