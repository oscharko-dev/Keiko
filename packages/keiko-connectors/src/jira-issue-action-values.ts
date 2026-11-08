import {
  type JiraIssueActionMutation,
  isSafeAtlassianIdentifier,
  type JiraMutationAttempt,
  type JiraMutationReceipt,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import {
  TOOL_CATALOG_LIMITS,
  type CatalogJsonObject,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { asRecord } from "./atlassian-sync-classify.js";
import { jiraCommentVisibility, type JiraCommentVisibility } from "./jira-comment-visibility.js";
import { jiraNativeId } from "./jira-native-values.js";
import { savedExactKeys, savedText } from "./jira-saved-configuration-values.js";

export {
  JIRA_ISSUE_ACTION_MUTATIONS,
  type JiraIssueActionMutation,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
export interface JiraIssueActionReceipt extends JiraMutationReceipt {
  readonly commentPinned?: true;
  readonly notificationDigest?: string;
  readonly recipientUserKeys?: readonly string[];
}
export type IssueActionFailure = Omit<Extract<JiraMutationAttempt, { ok: false }>, "receipt"> & {
  readonly receipt?: JiraIssueActionReceipt;
};
export type IssueActionAttempt =
  IssueActionFailure | { readonly ok: true; readonly receipt: JiraIssueActionReceipt };
export type IssueActionObservation<T> =
  IssueActionFailure | { readonly ok: true; readonly value: T };
interface Common {
  readonly actor: string;
  readonly issueId: string;
  readonly issueKey: string;
}
export interface PinCommentInput extends Common {
  readonly kind: "pin";
  readonly commentId: string;
  readonly expectedBody: string;
  readonly expectedVisibility: JiraCommentVisibility | null;
}
export interface NotifyIssueInput extends Common {
  readonly kind: "notify";
  readonly subject: string;
  readonly text: string;
  readonly users: readonly { readonly key: string; readonly name: string }[];
}
export type IssueActionInput = PinCommentInput | NotifyIssueInput;
const FIELDS: Readonly<Record<JiraIssueActionMutation, ReadonlySet<string>>> = {
  "jira.pin-comment": new Set([
    "expectedActorKey",
    "issueId",
    "issueKey",
    "commentId",
    "expectedBody",
    "expectedVisibility",
  ]),
  "jira.notify-issue": new Set([
    "expectedActorKey",
    "issueId",
    "issueKey",
    "subject",
    "textBody",
    "users",
    "confirmEmailSend",
  ]),
};
const USER_KEYS = new Set(["key", "name"]);
export const ISSUE_ACTION_MALFORMED: IssueActionFailure = {
  ok: false,
  reason: "malformed-payload",
};
export function isJiraIssueActionMutation(name: string): name is JiraIssueActionMutation {
  return Object.hasOwn(FIELDS, name);
}
export function issueActionRefusal(
  message: string,
  reason: "field-validation" | "conflict" | "unavailable" = "field-validation",
  receipt?: JiraIssueActionReceipt,
): IssueActionFailure {
  return {
    ok: false,
    reason,
    detail: { messages: [message] },
    ...(receipt === undefined ? {} : { receipt }),
  };
}
function recipient(value: unknown): NotifyIssueInput["users"][number] | undefined {
  const raw = asRecord(value);
  return raw !== undefined &&
    savedExactKeys(raw, USER_KEYS) &&
    savedText(raw.key, 255) &&
    savedText(raw.name, 255)
    ? Object.freeze({ key: raw.key, name: raw.name })
    : undefined;
}
function users(value: unknown): NotifyIssueInput["users"] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 50) return undefined;
  const result: { key: string; name: string }[] = [];
  const keys = new Set<string>();
  const names = new Set<string>();
  for (const entry of value) {
    const user = recipient(entry);
    if (user === undefined || keys.has(user.key) || names.has(user.name.toLowerCase()))
      return undefined;
    keys.add(user.key);
    names.add(user.name.toLowerCase());
    result.push(user);
  }
  return Object.freeze(result);
}
function pin(args: CatalogJsonObject, common: Common): PinCommentInput | undefined {
  const expectedVisibility = jiraCommentVisibility(args.expectedVisibility);
  if (
    jiraNativeId(args.commentId) &&
    savedText(args.expectedBody, 32768, true) &&
    args.expectedVisibility !== null &&
    expectedVisibility !== undefined
  ) {
    return {
      ...common,
      kind: "pin",
      commentId: args.commentId,
      expectedBody: args.expectedBody,
      expectedVisibility:
        expectedVisibility === null ? null : Object.freeze({ ...expectedVisibility }),
    };
  }
  return undefined;
}
function notify(args: CatalogJsonObject, common: Common): NotifyIssueInput | undefined {
  const selected = users(args.users);
  return args.confirmEmailSend === true &&
    savedText(args.subject, 255) &&
    !/\p{Cc}/u.test(args.subject) &&
    savedText(args.textBody, 32768) &&
    selected !== undefined
    ? { ...common, kind: "notify", subject: args.subject, text: args.textBody, users: selected }
    : undefined;
}
export function parseIssueActionInput(
  operation: JiraIssueActionMutation,
  args: CatalogJsonObject,
): IssueActionInput | undefined {
  if (
    !savedExactKeys(args, FIELDS[operation]) ||
    !savedText(args.expectedActorKey, 255) ||
    !jiraNativeId(args.issueId) ||
    !isSafeAtlassianIdentifier(args.issueKey) ||
    new TextEncoder().encode(JSON.stringify(args)).byteLength > TOOL_CATALOG_LIMITS.maxArgumentBytes
  )
    return undefined;
  const common = { actor: args.expectedActorKey, issueId: args.issueId, issueKey: args.issueKey };
  return operation === "jira.pin-comment" ? pin(args, common) : notify(args, common);
}
