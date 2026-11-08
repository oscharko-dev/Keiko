import {
  isSafeAtlassianIdentifier,
  type JiraFieldMetadata,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { asArray, asRecord } from "./atlassian-sync-classify.js";
import type { JiraAgileRequestPhase } from "./jira-agile-request.js";
import { readJiraMutationIssue } from "./jira-mutation-confirmation.js";
import { dispatchFailure } from "./jira-mutation-failure.js";
import { jiraNativeId, jiraNativeNumericId } from "./jira-native-values.js";
import { savedText } from "./jira-saved-configuration-values.js";
import { isJiraFieldId } from "./jira-field-metadata.js";
import {
  estimationValue,
  planningRefusal,
  PLANNING_MALFORMED,
  type EpicIdentity,
  type EstimationValue,
  type PlanningObservation,
  type PlanningInput,
  type PlanningBoard,
  type PlanningFailure,
} from "./jira-agile-planning-values.js";

export interface PlanningIssue {
  readonly id: string;
  readonly key: string;
  readonly fields: Readonly<Record<string, unknown>>;
}
export interface PlanningField {
  readonly metadata: JiraFieldMetadata;
  readonly schema: Readonly<Record<string, unknown>>;
}
const EPIC_FIELD = "com.pyxis.greenhopper.jira:gh-epic-link";
const RANK_FIELD = "com.pyxis.greenhopper.jira:gh-lexo-rank";

export async function readPlanningIssue(
  requests: JiraAgileRequestPhase,
  selected: string,
  fields: readonly string[],
): Promise<PlanningObservation<PlanningIssue>> {
  const read = await readJiraMutationIssue(requests.issue, selected, ["summary", ...fields]);
  if (!read.ok) return read;
  return jiraNativeId(read.id) && isSafeAtlassianIdentifier(read.key)
    ? { ok: true, value: { id: read.id, key: read.key, fields: read.fields } }
    : PLANNING_MALFORMED;
}
export async function readPlanningBoard(
  requests: JiraAgileRequestPhase,
  input: PlanningBoard,
): Promise<PlanningObservation<Readonly<Record<string, unknown>>>> {
  const response = await requests.agile(`board/${input.boardId}/configuration`);
  if (!response.ok) return dispatchFailure(response);
  const raw = response.body;
  if (response.status !== 200 || raw === undefined) return PLANNING_MALFORMED;
  return jiraNativeNumericId(raw.id) === input.boardId && raw.name === input.expectedBoardName
    ? { ok: true, value: raw }
    : planningRefusal(
        "The current board identity/name differs from the reviewed board.",
        "conflict",
      );
}
function fieldMatches(raw: Record<string, unknown>, input: PlanningInput): boolean {
  const schema = asRecord(raw.schema);
  if (input.operation === "jira.epic-remove-issues") return schema?.custom === EPIC_FIELD;
  if (raw.id !== input.fieldId) return false;
  if (input.operation !== "jira.set-issue-estimation") return schema?.custom === RANK_FIELD;
  return input.fieldId === "timeoriginalestimate"
    ? schema?.system === "timeoriginalestimate"
    : schema?.type === "number";
}
function fieldProjection(raw: Record<string, unknown>): PlanningField | undefined {
  const schema = asRecord(raw.schema);
  if (schema === undefined || !isJiraFieldId(raw.id) || !savedText(raw.name, 255)) return undefined;
  return {
    metadata: {
      id: raw.id,
      name: raw.name,
      kind: "unsupported",
      required: false,
      hasDefaultValue: false,
      richText: false,
      operations: [],
    },
    schema,
  };
}
export async function readPlanningField(
  requests: JiraAgileRequestPhase,
  input: PlanningInput,
): Promise<PlanningObservation<PlanningField>> {
  const response = await requests.issue("field", "GET", undefined, "json-array");
  if (!response.ok) return dispatchFailure(response);
  if (response.status !== 200 || response.items === undefined) return PLANNING_MALFORMED;
  if (response.items.length > 5000) return { ok: false, reason: "bounds-exceeded" };
  const matches = response.items
    .map(asRecord)
    .filter((raw) => raw !== undefined && fieldMatches(raw, input));
  const field =
    matches.length === 1 && matches[0] !== undefined ? fieldProjection(matches[0]) : undefined;
  return field === undefined
    ? planningRefusal(
        "The exact native Agile field is unavailable or ambiguous; localized names cannot identify it.",
        "unavailable",
      )
    : { ok: true, value: field };
}
export function boardFieldMatches(
  input: Exclude<PlanningInput, { operation: "jira.epic-remove-issues" }>,
  board: Readonly<Record<string, unknown>>,
): boolean {
  if (input.operation !== "jira.set-issue-estimation")
    return (
      jiraNativeNumericId(asRecord(board.ranking)?.rankCustomFieldId) === input.rankCustomFieldId
    );
  const estimation = asRecord(board.estimation);
  return estimation?.type === "field" && asRecord(estimation.field)?.fieldId === input.fieldId;
}
export async function readPlanningEpic(
  requests: JiraAgileRequestPhase,
  issue: Pick<PlanningIssue, "id" | "key">,
): Promise<PlanningFailure | undefined> {
  const response = await requests.agile(`epic/${issue.id}`);
  if (!response.ok) return dispatchFailure(response);
  return response.status === 200 &&
    jiraNativeNumericId(response.body?.id) === issue.id &&
    response.body?.key === issue.key
    ? undefined
    : planningRefusal(
        "The reviewed issue is not independently bound as the same native epic.",
        "conflict",
      );
}
export function sameEpic(actual: EpicIdentity | null, expected: EpicIdentity | null): boolean {
  return actual === null || expected === null
    ? actual === expected
    : actual.id === expected.id && actual.key === expected.key;
}
function nativeEpic(value: unknown): EpicIdentity | null | undefined {
  if (value === null) return null;
  const epic = asRecord(value);
  const id = jiraNativeNumericId(epic?.id);
  return id !== undefined && isSafeAtlassianIdentifier(epic?.key)
    ? { id, key: epic.key }
    : undefined;
}
function sameNativeIssue(
  raw: Readonly<Record<string, unknown>> | undefined,
  issue: PlanningIssue,
): boolean {
  return raw !== undefined && jiraNativeNumericId(raw.id) === issue.id && raw.key === issue.key;
}
export async function readPlanningEpicMembership(
  requests: JiraAgileRequestPhase,
  issue: PlanningIssue,
): Promise<PlanningObservation<EpicIdentity | null>> {
  const response = await requests.agile(`issue/${issue.id}?fields=epic&updateHistory=false`);
  if (!response.ok) return dispatchFailure(response);
  const raw = response.body;
  const fields = asRecord(raw?.fields);
  if (
    response.status !== 200 ||
    !sameNativeIssue(raw, issue) ||
    fields === undefined ||
    !Object.hasOwn(fields, "epic")
  )
    return PLANNING_MALFORMED;
  const epic = nativeEpic(fields.epic);
  return epic === undefined ? PLANNING_MALFORMED : { ok: true, value: epic };
}
function completeSubset(
  body: Readonly<Record<string, unknown>> | undefined,
  rows: readonly unknown[] | undefined,
  expectedCount: number,
): rows is readonly unknown[] {
  return (
    rows !== undefined &&
    body?.startAt === 0 &&
    body.total === expectedCount &&
    rows.length === expectedCount
  );
}
function subsetRowsMatch(rows: readonly unknown[], issues: readonly PlanningIssue[]): boolean {
  const expected = new Map(issues.map((issue) => [issue.id, issue.key]));
  for (const row of rows) {
    const raw = asRecord(row);
    const id = jiraNativeNumericId(raw?.id);
    if (id === undefined || expected.get(id) !== raw?.key) return false;
    expected.delete(id);
  }
  return expected.size === 0;
}
/** Only the explicitly selected IDs are queried; this is not a complete board population. */
export async function readPlanningBoardSubset(
  requests: JiraAgileRequestPhase,
  boardId: string,
  issues: readonly PlanningIssue[],
): Promise<PlanningFailure | undefined> {
  const query = new URLSearchParams({
    jql: `id in (${issues.map(({ id }) => id).join(",")})`,
    fields: "summary",
    validateQuery: "true",
    startAt: "0",
    maxResults: "100",
  });
  const response = await requests.agile(`board/${boardId}/issue?${query.toString()}`);
  if (!response.ok) return dispatchFailure(response);
  const rows = asArray(response.body?.issues);
  if (response.status !== 200 || !completeSubset(response.body, rows, issues.length))
    return planningRefusal(
      "Every selected issue and anchor must be visible in the bound board subset; missing or partial results are unavailable.",
      "unavailable",
    );
  return subsetRowsMatch(rows, issues) ? undefined : PLANNING_MALFORMED;
}
export async function readPlanningEstimation(
  requests: JiraAgileRequestPhase,
  issueId: string,
  boardId: string,
  fieldId: string,
): Promise<PlanningObservation<EstimationValue>> {
  const response = await requests.agile(`issue/${issueId}/estimation?boardId=${boardId}`);
  if (!response.ok) return dispatchFailure(response);
  const raw = response.body;
  return response.status === 200 &&
    raw?.fieldId === fieldId &&
    Object.hasOwn(raw, "value") &&
    estimationValue(raw.value)
    ? { ok: true, value: raw.value }
    : planningRefusal(
        "The configured estimation field or its current value is unavailable. Missing values are not an observed null or zero.",
        "unavailable",
      );
}
