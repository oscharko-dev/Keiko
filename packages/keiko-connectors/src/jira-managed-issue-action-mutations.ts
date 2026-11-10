import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { sha256Hex } from "@oscharko-dev/keiko-security";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import { dispatchFailure, JiraAcknowledgedMutationError } from "./jira-mutation-failure.js";
import { readSavedActor } from "./jira-saved-configuration-values.js";
import { admitIssueAction, issueActionPinnedState } from "./jira-issue-action-observations.js";
import {
  ISSUE_ACTION_MALFORMED,
  issueActionRefusal,
  parseIssueActionInput,
  type IssueActionAttempt,
  type IssueActionInput,
  type JiraIssueActionMutation,
  type JiraIssueActionReceipt,
  type NotifyIssueInput,
  type PinCommentInput,
} from "./jira-issue-action-values.js";
export {
  JIRA_ISSUE_ACTION_MUTATIONS,
  isJiraIssueActionMutation,
  type JiraIssueActionMutation,
} from "./jira-issue-action-values.js";

function receipt(input: IssueActionInput): JiraIssueActionReceipt {
  const parent = { userKey: input.actor, issueId: input.issueId, issueKey: input.issueKey };
  return Object.freeze(
    input.kind === "pin"
      ? { ...parent, commentId: input.commentId, commentPinned: true as const }
      : {
          ...parent,
          notificationDigest: sha256Hex(JSON.stringify(notification(input))),
          recipientUserKeys: Object.freeze(input.users.map((user) => user.key)),
        },
  );
}
function notification(input: NotifyIssueInput): CatalogJsonObject {
  return {
    subject: input.subject,
    textBody: input.text,
    to: { users: input.users.map((user) => ({ name: user.name })) },
  };
}
async function confirmPin(
  request: JiraMutationRequest,
  input: PinCommentInput,
  known: JiraIssueActionReceipt,
  baseUrl: string,
): Promise<IssueActionAttempt> {
  const admitted = await admitIssueAction(request, input, baseUrl);
  if (admitted !== undefined) return { ...admitted, receipt: known };
  const state = await issueActionPinnedState(request, input, baseUrl);
  if (!state.ok) return { ...state, receipt: known };
  return state.value
    ? { ok: true, receipt: known }
    : issueActionRefusal(
        "Jira acknowledged pinning, but the exact same reviewed comment was not observed in its native pinned list. Keep the known context and do not replay.",
        "unavailable",
        known,
      );
}
async function dispatch(
  request: JiraMutationRequest,
  input: IssueActionInput,
  known: JiraIssueActionReceipt,
  baseUrl?: string,
): Promise<IssueActionAttempt> {
  const actor = await readSavedActor(request, input.actor);
  if (!actor.ok) return actor;
  const response =
    input.kind === "pin"
      ? await request(`issue/${input.issueId}/comment/${input.commentId}/pin`, "PUT", true, "none")
      : await request(`issue/${input.issueId}/notify`, "POST", notification(input), "none");
  if (!response.ok) return { ...dispatchFailure(response), receipt: known };
  if (response.status < 200 || response.status >= 300)
    return { ...ISSUE_ACTION_MALFORMED, receipt: known };
  if (input.kind === "notify")
    return issueActionRefusal(
      "Jira acknowledged the notification request. Its mail queue has no independent delivery readback here; recipient delivery, effective filtering and any email receipt remain unconfirmed. Do not send it again after an uncertain outcome.",
      "unavailable",
      known,
    );
  if (baseUrl === undefined) return { ...ISSUE_ACTION_MALFORMED, receipt: known };
  try {
    return await confirmPin(request, input, known, baseUrl);
  } catch (error) {
    throw new JiraAcknowledgedMutationError(error, known);
  }
}
/** One fixed pin or explicit notification request; no HTML, dynamic groups or raw email recipients. */
export async function executeJiraIssueActionMutation(
  operation: JiraIssueActionMutation,
  args: CatalogJsonObject,
  request: JiraMutationRequest,
  check = false,
  baseUrl?: string,
): Promise<IssueActionAttempt> {
  const input = parseIssueActionInput(operation, args);
  if (input === undefined)
    return issueActionRefusal(
      "Select the exact actor and canonical issue ID/key. Pinning requires the comment ID and reviewed body/visibility; omit visibility only for unrestricted comments. Notification requires confirmEmailSend:true, a one-line subject, plain textBody and 1–50 exact users with independently bound key/name. Raw addresses, HTML, dynamic groups, watchers and arbitrary transport controls are unsupported.",
    );
  const known = receipt(input);
  if (new TextEncoder().encode(JSON.stringify(known)).byteLength > 16384)
    return issueActionRefusal(
      "The complete known recipient/comment receipt exceeds the existing 16 KiB bound. Select fewer recipients before any request.",
    );
  const refused = await admitIssueAction(request, input, baseUrl);
  if (refused !== undefined) return refused;
  if (input.kind === "pin" && baseUrl !== undefined) {
    const state = await issueActionPinnedState(request, input, baseUrl);
    if (!state.ok) return state;
    if (state.value)
      return {
        ...issueActionRefusal(
          "The exact reviewed comment is already pinned. No native request was sent.",
          "conflict",
          known,
        ),
        detail: {
          unchanged: true,
          messages: ["The exact reviewed comment is already pinned. No native write was sent."],
        },
      };
  }
  return check ? { ok: true, receipt: {} } : dispatch(request, input, known, baseUrl);
}
