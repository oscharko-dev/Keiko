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
import { jiraAttachmentRecord } from "./jira-attachments.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import { readJiraMutationIssue } from "./jira-mutation-confirmation.js";
import { dispatchFailure, JiraAcknowledgedMutationError } from "./jira-mutation-failure.js";
import { jiraNativeId } from "./jira-native-values.js";

type Failure = Extract<JiraMutationAttempt, { readonly ok: false }>;
interface Attachment {
  readonly attachmentId: string;
  readonly filename: string;
  readonly size: number;
}
interface Input extends Attachment {
  readonly issueKey: string;
}
interface Bound {
  readonly issueKey: string;
  readonly issueId: string;
  readonly attachments: ReadonlyMap<string, Attachment>;
}
const MALFORMED: Failure = { ok: false, reason: "malformed-payload" };
const BOUNDS: Failure = { ok: false, reason: "bounds-exceeded" };
const CONFLICT: Failure = { ok: false, reason: "conflict" };
const ALLOWED = new Set(["issueKey", "attachmentId", "filename", "size"]);
export function isJiraAttachmentMutation(name: string): name is "jira.delete-attachment" {
  return name === "jira.delete-attachment";
}
function input(args: CatalogJsonObject): Input | undefined {
  const record = jiraAttachmentRecord(args);
  return record !== undefined &&
    isSafeAtlassianIdentifier(args.issueKey) &&
    jiraNativeId(args.attachmentId) &&
    Object.keys(args).every((key) => ALLOWED.has(key))
    ? { issueKey: args.issueKey, attachmentId: args.attachmentId, ...record }
    : undefined;
}
function attachmentList(items: readonly unknown[]): ReadonlyMap<string, Attachment> | undefined {
  const result = new Map<string, Attachment>();
  for (const item of items) {
    const raw = asRecord(item);
    const record = jiraAttachmentRecord(raw);
    if (!jiraNativeId(raw?.id) || record === undefined || result.has(raw.id)) return undefined;
    result.set(raw.id, { attachmentId: raw.id, ...record });
  }
  return result;
}
async function readIssue(
  request: JiraMutationRequest,
  issueKey: string,
): Promise<Failure | { readonly ok: true; readonly bound: Bound }> {
  const issue = await readJiraMutationIssue(request, issueKey, ["attachment"]);
  if (!issue.ok) return issue;
  if (!jiraNativeId(issue.id) || !isSafeAtlassianIdentifier(issue.key)) return MALFORMED;
  const items = asArray(issue.fields.attachment);
  if (items === undefined) return MALFORMED;
  if (items.length > TOOL_CATALOG_LIMITS.maxArrayItems) return BOUNDS;
  const attachments = attachmentList(items);
  return attachments === undefined
    ? MALFORMED
    : { ok: true, bound: { issueKey: issue.key, issueId: issue.id, attachments } };
}
function sameMetadata(
  actual: ReturnType<typeof jiraAttachmentRecord>,
  expected: Attachment,
): boolean {
  return actual?.filename === expected.filename && actual.size === expected.size;
}
async function inspect(
  request: JiraMutationRequest,
  selected: Input,
): Promise<Failure | { readonly ok: true; readonly bound: Bound }> {
  const issue = await readIssue(request, selected.issueKey);
  if (!issue.ok) return issue;
  if (!sameMetadata(issue.bound.attachments.get(selected.attachmentId), selected))
    return {
      ...CONFLICT,
      detail: {
        messages: [
          "The attachment is absent from the readable issue or its filename/size changed. Inspect and approve its current metadata before deleting it.",
        ],
      },
    };
  const response = await request(`attachment/${selected.attachmentId}`);
  if (!response.ok) return dispatchFailure(response);
  if (response.status !== 200 || response.body === undefined) return MALFORMED;
  if (
    (response.body.id !== undefined && response.body.id !== selected.attachmentId) ||
    !sameMetadata(jiraAttachmentRecord(response.body), selected)
  )
    return CONFLICT;
  return issue;
}
async function confirmRemoval(
  request: JiraMutationRequest,
  bound: Bound,
  receipt: JiraMutationReceipt & { readonly attachmentId: string },
): Promise<JiraMutationAttempt> {
  try {
    const current = await readIssue(request, bound.issueId);
    if (!current.ok) return { ...current, receipt };
    if (
      current.bound.issueId !== bound.issueId ||
      current.bound.issueKey !== bound.issueKey ||
      current.bound.attachments.has(receipt.attachmentId)
    )
      return { ...CONFLICT, receipt };
    return { ok: true, receipt };
  } catch (error) {
    throw new JiraAcknowledgedMutationError(error, receipt);
  }
}
/** One native DELETE; only absence from the still-readable bound issue proves removal. */
export async function executeJiraAttachmentMutation(
  _operation: "jira.delete-attachment",
  args: CatalogJsonObject,
  request: JiraMutationRequest,
  check = false,
): Promise<JiraMutationAttempt> {
  const selected = input(args);
  if (selected === undefined)
    return {
      ok: false,
      reason: "field-validation",
      detail: {
        validation: "invalid-field",
        messages: [
          "Select an issue and exact attachment ID, with its reviewed filename (at most 1024 characters) and nonnegative whole-byte size.",
        ],
      },
    };
  const inspected = await inspect(request, selected);
  if (!inspected.ok) return inspected;
  if (check) return { ok: true, receipt: {} };
  const { bound } = inspected;
  const receipt = {
    issueKey: bound.issueKey,
    issueId: bound.issueId,
    attachmentId: selected.attachmentId,
  };
  const response = await request(
    `attachment/${selected.attachmentId}`,
    "DELETE",
    undefined,
    "none",
  );
  if (!response.ok) return { ...dispatchFailure(response), receipt };
  if (response.status < 200 || response.status >= 300) return { ...MALFORMED, receipt };
  return confirmRemoval(request, bound, receipt);
}
