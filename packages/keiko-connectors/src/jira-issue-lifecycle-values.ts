import { isSafeAtlassianIdentifier, type JiraIssueLifecycleMutation, type JiraMutationAttempt, type JiraMutationReceipt } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { TOOL_CATALOG_LIMITS, type CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { asRecord } from "./atlassian-sync-classify.js";
import { jiraNativeId } from "./jira-native-values.js";
import { savedDistinctList, savedExactKeys, savedText } from "./jira-saved-configuration-values.js";

export { JIRA_ISSUE_LIFECYCLE_MUTATIONS, type JiraIssueLifecycleMutation } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
export interface IssueLifecycleReceipt extends JiraMutationReceipt {
  readonly userKey: string;
  readonly issueArchivedRequested?: boolean;
  readonly issuePresent?: false;
  readonly subtaskIds?: readonly string[];
  readonly originalPosition?: number;
  readonly currentPosition?: number;
}
export type IssueLifecycleFailure = Omit<Extract<JiraMutationAttempt, { ok: false }>, "receipt"> & { readonly receipt?: IssueLifecycleReceipt };
export type IssueLifecycleAttempt = IssueLifecycleFailure | { readonly ok: true; readonly receipt: IssueLifecycleReceipt | Record<string, never> };
export type IssueLifecycleObservation<T> = IssueLifecycleFailure | { readonly ok: true; readonly value: T };
export interface IssueLifecycleReview {
  readonly id: string;
  readonly key: string;
  readonly summary: string;
  readonly projectId: string;
  readonly issueTypeId: string;
}
export interface IssueLifecycleSubtask { readonly id: string; readonly key: string }
type Common = { readonly actor: string };
export type IssueLifecycleInput = Common & (
  | { readonly kind: "archive-many"; readonly issues: readonly IssueLifecycleReview[] }
  | { readonly kind: "archive"; readonly issue: IssueLifecycleReview }
  | { readonly kind: "restore"; readonly issue: IssueLifecycleReview }
  | { readonly kind: "delete"; readonly issue: IssueLifecycleReview }
  | { readonly kind: "reorder"; readonly issue: IssueLifecycleReview; readonly subtasks: readonly IssueLifecycleSubtask[]; readonly original: number; readonly current: number }
);
export const ISSUE_LIFECYCLE_MALFORMED: IssueLifecycleFailure = { ok: false, reason: "malformed-payload" };
export function issueLifecycleFailure(value: Extract<JiraMutationAttempt, { ok: false }>): IssueLifecycleFailure {
  return { ok: false, reason: value.reason,
    ...(value.detail === undefined ? {} : { detail: value.detail }),
    ...(value.violations === undefined ? {} : { violations: value.violations }) };
}
export function issueLifecycleRefusal(message: string, reason: "field-validation" | "conflict" | "unavailable" = "field-validation", receipt?: IssueLifecycleReceipt): IssueLifecycleFailure {
  return { ok: false, reason, detail: { messages: [message] }, ...(receipt === undefined ? {} : { receipt }) };
}
const ISSUE_KEYS = new Set(["id", "key", "summary", "projectId", "issueTypeId"]);
export function issueLifecycleReview(value: unknown): IssueLifecycleReview | undefined {
  const raw = asRecord(value);
  return raw !== undefined && savedExactKeys(raw, ISSUE_KEYS) && jiraNativeId(raw.id) && isSafeAtlassianIdentifier(raw.key) &&
    savedText(raw.summary, 32768, true) && jiraNativeId(raw.projectId) && jiraNativeId(raw.issueTypeId)
    ? { id: raw.id, key: raw.key, summary: raw.summary, projectId: raw.projectId, issueTypeId: raw.issueTypeId } : undefined;
}
export function issueLifecycleSubtask(value: unknown): IssueLifecycleSubtask | undefined {
  const raw = asRecord(value);
  return raw !== undefined && savedExactKeys(raw, new Set(["id", "key"])) && jiraNativeId(raw.id) && isSafeAtlassianIdentifier(raw.key)
    ? { id: raw.id, key: raw.key } : undefined;
}
function selectedList<T extends IssueLifecycleSubtask>(value: unknown, project: (raw: unknown) => T | undefined, maximum: number, minimum: number): readonly T[] | undefined {
  const output = savedDistinctList(value, project, (item) => [item.id, item.key.toUpperCase()], { minimum, maximum });
  return output === undefined ? undefined : Object.freeze(output);
}
const COMMON = ["expectedActorKey", "confirmUnverifiedEffect"];
const INPUT_KEYS: Readonly<Record<JiraIssueLifecycleMutation, ReadonlySet<string>>> = {
  "jira.archive-issues": new Set([...COMMON, "expectedIssues"]),
  "jira.archive-issue": new Set([...COMMON, "expectedIssue"]),
  "jira.restore-issue": new Set([...COMMON, "expectedIssue"]),
  "jira.delete-issue": new Set([...COMMON, "expectedIssue", "expectedSubtasks"]),
  "jira.move-subtask": new Set([...COMMON, "expectedIssue", "expectedSubtasks", "originalPosition", "currentPosition"]),
};
function nativePosition(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
}
function singleInput(operation: Exclude<JiraIssueLifecycleMutation, "jira.archive-issues">, args: CatalogJsonObject, actor: string): IssueLifecycleInput | undefined {
  const issue = issueLifecycleReview(args.expectedIssue);
  if (issue === undefined) return undefined;
  if (operation === "jira.delete-issue") return Array.isArray(args.expectedSubtasks) && args.expectedSubtasks.length === 0
    ? { kind: "delete", actor, issue } : undefined;
  if (operation !== "jira.move-subtask") return { kind: operation === "jira.archive-issue" ? "archive" : "restore", actor, issue };
  const subtasks = selectedList(args.expectedSubtasks, issueLifecycleSubtask, TOOL_CATALOG_LIMITS.maxArrayItems, 2);
  return subtasks === undefined || !nativePosition(args.originalPosition) || !nativePosition(args.currentPosition) || args.originalPosition === args.currentPosition
    ? undefined : { kind: "reorder", actor, issue, subtasks, original: args.originalPosition, current: args.currentPosition };
}
export function isJiraIssueLifecycleMutation(name: string): name is JiraIssueLifecycleMutation { return Object.hasOwn(INPUT_KEYS, name); }
export function parseIssueLifecycleInput(operation: JiraIssueLifecycleMutation, args: CatalogJsonObject): IssueLifecycleInput | undefined {
  if (!savedExactKeys(args, INPUT_KEYS[operation]) || !savedText(args.expectedActorKey, 255) || args.confirmUnverifiedEffect !== true ||
      new TextEncoder().encode(JSON.stringify(args)).byteLength > TOOL_CATALOG_LIMITS.maxArgumentBytes) return undefined;
  if (operation !== "jira.archive-issues") return singleInput(operation, args, args.expectedActorKey);
  const issues = selectedList(args.expectedIssues, issueLifecycleReview, 50, 1);
  return issues === undefined ? undefined : { kind: "archive-many", actor: args.expectedActorKey, issues };
}
export function issueLifecycleReceipt(input: IssueLifecycleInput): IssueLifecycleReceipt {
  if (input.kind === "archive-many") return Object.freeze({ userKey: input.actor, issueArchivedRequested: true,
    issueIds: Object.freeze(input.issues.map((issue) => issue.id)), issueKeys: Object.freeze(input.issues.map((issue) => issue.key)) });
  const base = { userKey: input.actor, issueId: input.issue.id, issueKey: input.issue.key };
  if (input.kind === "delete") return Object.freeze({ ...base, issuePresent: false });
  if (input.kind === "reorder") return Object.freeze({ ...base, subtaskIds: Object.freeze(input.subtasks.map((issue) => issue.id)), originalPosition: input.original, currentPosition: input.current });
  return Object.freeze({ ...base, issueArchivedRequested: input.kind === "archive" });
}
