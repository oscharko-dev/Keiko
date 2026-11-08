import {
  isSafeAtlassianIdentifier,
  JIRA_AGILE_PLANNING_MUTATIONS,
  type JiraAgilePlanningMutation,
  type JiraMutationAttempt,
  type JiraMutationReceipt,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { asRecord } from "./atlassian-sync-classify.js";
import { agileInputId } from "./jira-agile-inputs.js";
import { jiraNativeId } from "./jira-native-values.js";
import { isJiraFieldId } from "./jira-field-metadata.js";
import { savedExactKeys, savedText } from "./jira-saved-configuration-values.js";

export { JIRA_AGILE_PLANNING_MUTATIONS, type JiraAgilePlanningMutation };
export function isJiraAgilePlanningMutation(name: string): name is JiraAgilePlanningMutation {
  return (JIRA_AGILE_PLANNING_MUTATIONS as readonly string[]).includes(name);
}
export interface JiraAgilePlanningReceipt extends JiraMutationReceipt {
  readonly issueIds?: readonly string[];
  readonly epicPresent?: false;
  readonly anchorIssueId?: string;
  readonly anchorIssueKey?: string;
  readonly rankDirection?: "before" | "after";
  readonly estimationValue?: number;
  readonly estimationUnit?: "seconds" | "board-number";
}
export type PlanningFailure = Omit<Extract<JiraMutationAttempt, { ok: false }>, "receipt"> & {
  readonly receipt?: JiraAgilePlanningReceipt;
};
export type PlanningAttempt =
  PlanningFailure | { readonly ok: true; readonly receipt: JiraAgilePlanningReceipt };
export type PlanningObservation<T> = PlanningFailure | { readonly ok: true; readonly value: T };
export interface EpicIdentity {
  readonly id: string;
  readonly key: string;
}
export interface EpicRemovalSelection {
  readonly issueIdOrKey: string;
  readonly expectedEpic: EpicIdentity | null;
}
export interface RankSelection {
  readonly issueIdOrKey: string;
  readonly expectedRank: string | null;
}
interface Actor {
  readonly expectedActorKey: string;
}
export interface EpicRemovalInput extends Actor {
  readonly operation: "jira.epic-remove-issues";
  readonly issues: readonly EpicRemovalSelection[];
}
export interface PlanningBoard {
  readonly boardId: string;
  readonly expectedBoardName: string;
}
export interface RankInput extends Actor, PlanningBoard {
  readonly operation: "jira.rank-epic" | "jira.rank-issues";
  readonly rankCustomFieldId: string;
  readonly fieldId: string;
  readonly issues: readonly RankSelection[];
  readonly anchor: RankSelection;
  readonly direction: "before" | "after";
}
export type EstimationValue = string | number | null;
export interface EstimationInput extends Actor, PlanningBoard {
  readonly operation: "jira.set-issue-estimation";
  readonly issueIdOrKey: string;
  readonly fieldId: string;
  readonly expectedValue: EstimationValue;
  readonly unit: "minutes" | "board-number";
  readonly value: string;
  readonly expectedNativeValue: number;
}
export type PlanningInput = EpicRemovalInput | RankInput | EstimationInput;
export const PLANNING_MALFORMED: PlanningFailure = { ok: false, reason: "malformed-payload" };
export function planningRefusal(
  message: string,
  reason: "field-validation" | "conflict" | "unavailable" = "field-validation",
  receipt?: JiraAgilePlanningReceipt,
): PlanningFailure {
  return {
    ok: false,
    reason,
    detail: { messages: [message] },
    ...(receipt === undefined ? {} : { receipt }),
  };
}
export function estimationValue(value: unknown): value is EstimationValue {
  return (
    value === null ||
    savedText(value, 2048, true) ||
    (typeof value === "number" &&
      Number.isFinite(value) &&
      Math.abs(value) <= Number.MAX_SAFE_INTEGER)
  );
}
export function epicIdentity(value: unknown): EpicIdentity | null | undefined {
  if (value === null) return null;
  const raw = asRecord(value);
  return raw !== undefined && jiraNativeId(raw.id) && isSafeAtlassianIdentifier(raw.key)
    ? { id: raw.id, key: raw.key }
    : undefined;
}
function list<T>(
  value: unknown,
  project: (raw: Record<string, unknown>) => T | undefined,
): readonly T[] | undefined {
  if (!Array.isArray(value) || value.length < 1 || value.length > 50) return undefined;
  const result: T[] = [];
  for (const item of value) {
    const raw = asRecord(item);
    const selected = raw === undefined ? undefined : project(raw);
    if (selected === undefined) return undefined;
    result.push(selected);
  }
  return result;
}
function epicSelection(raw: Record<string, unknown>): EpicRemovalSelection | undefined {
  if (
    !Object.keys(raw).every((key) => key === "issueIdOrKey" || key === "expectedEpic") ||
    !isSafeAtlassianIdentifier(raw.issueIdOrKey)
  )
    return undefined;
  const epic = epicIdentity(raw.expectedEpic);
  if (epic === undefined) return undefined;
  const native = asRecord(raw.expectedEpic);
  if (native !== undefined && Object.keys(native).some((key) => key !== "id" && key !== "key"))
    return undefined;
  return { issueIdOrKey: raw.issueIdOrKey, expectedEpic: epic };
}
function rankValue(value: unknown): value is string | null {
  return value === null || savedText(value, 2048);
}
function rankSelection(raw: Record<string, unknown>): RankSelection | undefined {
  return Object.keys(raw).every((key) => key === "issueIdOrKey" || key === "expectedRank") &&
    isSafeAtlassianIdentifier(raw.issueIdOrKey) &&
    rankValue(raw.expectedRank)
    ? { issueIdOrKey: raw.issueIdOrKey, expectedRank: raw.expectedRank }
    : undefined;
}
function board(args: CatalogJsonObject): PlanningBoard | undefined {
  const boardId = agileInputId(args.boardId);
  return boardId !== undefined && savedText(args.expectedBoardName, 255)
    ? { boardId, expectedBoardName: args.expectedBoardName }
    : undefined;
}
function rankInput(
  operation: RankInput["operation"],
  args: CatalogJsonObject,
  expectedActorKey: string,
): RankInput | undefined {
  const context = board(args);
  const rankCustomFieldId = agileInputId(args.rankCustomFieldId);
  if (
    context === undefined ||
    rankCustomFieldId === undefined ||
    (args.direction !== "before" && args.direction !== "after")
  )
    return undefined;
  const anchorKey =
    operation === "jira.rank-epic" ? args.anchorEpicIdOrKey : args.anchorIssueIdOrKey;
  if (!isSafeAtlassianIdentifier(anchorKey) || !rankValue(args.expectedAnchorRank))
    return undefined;
  const issues =
    operation === "jira.rank-epic"
      ? list([{ issueIdOrKey: args.epicIdOrKey, expectedRank: args.expectedRank }], rankSelection)
      : list(args.issues, rankSelection);
  return issues === undefined
    ? undefined
    : {
        operation,
        expectedActorKey,
        ...context,
        rankCustomFieldId,
        fieldId: `customfield_${rankCustomFieldId}`,
        issues,
        anchor: { issueIdOrKey: anchorKey, expectedRank: args.expectedAnchorRank },
        direction: args.direction,
      };
}
function decimal(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d{0,14})(?:\.\d{1,6})?$/u.test(value))
    return undefined;
  const coefficient = value.replace(".", "");
  if (BigInt(coefficient) > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
  return Number(value);
}
function estimateInput(
  args: CatalogJsonObject,
  expectedActorKey: string,
): EstimationInput | undefined {
  const context = board(args);
  const numeric = decimal(args.value);
  if (context === undefined || numeric === undefined || typeof args.value !== "string")
    return undefined;
  if (
    !isSafeAtlassianIdentifier(args.issueIdOrKey) ||
    !isJiraFieldId(args.fieldId) ||
    !estimationValue(args.expectedValue)
  )
    return undefined;
  if (args.unit !== "minutes" && args.unit !== "board-number") return undefined;
  const expectedNativeValue = nativeEstimate(numeric, args.fieldId, args.unit);
  if (expectedNativeValue === undefined) return undefined;
  return {
    operation: "jira.set-issue-estimation",
    expectedActorKey,
    ...context,
    issueIdOrKey: args.issueIdOrKey,
    fieldId: args.fieldId,
    expectedValue: args.expectedValue,
    unit: args.unit,
    value: args.value,
    expectedNativeValue,
  };
}
function nativeEstimate(
  numeric: number,
  fieldId: string,
  unit: EstimationInput["unit"],
): number | undefined {
  if ((fieldId === "timeoriginalestimate") !== (unit === "minutes")) return undefined;
  const value = unit === "minutes" ? numeric * 60 : numeric;
  if (!Number.isFinite(value) || value > Number.MAX_SAFE_INTEGER) return undefined;
  return unit === "minutes" && !Number.isSafeInteger(value) ? undefined : value;
}
const COMMON = ["expectedActorKey", "boardId", "expectedBoardName"];
const RANK = [...COMMON, "rankCustomFieldId", "direction", "expectedAnchorRank"];
const KEYS: Readonly<Record<JiraAgilePlanningMutation, ReadonlySet<string>>> = {
  "jira.epic-remove-issues": new Set(["expectedActorKey", "issues"]),
  "jira.rank-epic": new Set([...RANK, "epicIdOrKey", "expectedRank", "anchorEpicIdOrKey"]),
  "jira.rank-issues": new Set([...RANK, "issues", "anchorIssueIdOrKey"]),
  "jira.set-issue-estimation": new Set([
    ...COMMON,
    "issueIdOrKey",
    "fieldId",
    "expectedValue",
    "unit",
    "value",
  ]),
};
export function parseAgilePlanningInput(
  operation: string,
  args: CatalogJsonObject,
): PlanningInput | undefined {
  if (
    !isJiraAgilePlanningMutation(operation) ||
    !savedExactKeys(args, KEYS[operation]) ||
    !savedText(args.expectedActorKey, 255)
  )
    return undefined;
  if (operation === "jira.epic-remove-issues") {
    const issues = list(args.issues, epicSelection);
    return issues === undefined
      ? undefined
      : { operation, expectedActorKey: args.expectedActorKey, issues };
  }
  return operation === "jira.set-issue-estimation"
    ? estimateInput(args, args.expectedActorKey)
    : rankInput(operation, args, args.expectedActorKey);
}
