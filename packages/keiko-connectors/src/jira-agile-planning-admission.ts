import type { JiraFieldMetadata } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { JiraAgileRequestPhase } from "./jira-agile-request.js";
import {
  gateJiraMutationByTemplates,
  type JiraIssueTemplateSource,
} from "./jira-managed-template-gate.js";
import { readSavedActor } from "./jira-saved-configuration-values.js";
import {
  boardFieldMatches,
  readPlanningBoard,
  readPlanningBoardSubset,
  readPlanningEpic,
  readPlanningEpicMembership,
  readPlanningEstimation,
  readPlanningField,
  readPlanningIssue,
  sameEpic,
  type PlanningIssue,
  type PlanningField,
} from "./jira-agile-planning-observations.js";
import {
  planningRefusal,
  PLANNING_MALFORMED,
  type PlanningInput,
  type PlanningObservation,
  type EpicRemovalInput,
  type RankInput,
  type EstimationInput,
  type PlanningFailure,
} from "./jira-agile-planning-values.js";

export interface PlanningAdmission {
  readonly input: PlanningInput;
  readonly field: PlanningField;
  readonly issues: readonly PlanningIssue[];
  readonly anchor?: PlanningIssue;
  readonly unchanged: boolean;
}
async function selectedEpic(
  requests: JiraAgileRequestPhase,
  issue: PlanningIssue,
  input: EpicRemovalInput["issues"][number],
): Promise<PlanningFailure | undefined> {
  const membership = await readPlanningEpicMembership(requests, issue);
  if (!membership.ok) return membership;
  if (!sameEpic(membership.value, input.expectedEpic))
    return planningRefusal(
      "The selected issue's native epic changed. Review its current relationship before removing it.",
      "conflict",
    );
  return membership.value === null ? undefined : readPlanningEpic(requests, membership.value);
}
async function removeSelection(
  requests: JiraAgileRequestPhase,
  input: EpicRemovalInput,
  field: PlanningField,
): Promise<PlanningObservation<PlanningAdmission>> {
  const issues: PlanningIssue[] = [];
  for (const selected of input.issues) {
    const issue = await readPlanningIssue(requests, selected.issueIdOrKey, [field.metadata.id]);
    if (!issue.ok) return issue;
    if (issues.some(({ id }) => id === issue.value.id))
      return planningRefusal("Issue aliases must resolve to distinct native issue identities.");
    const refused = await selectedEpic(requests, issue.value, selected);
    if (refused !== undefined) return refused;
    const observedLink = issue.value.fields[field.metadata.id];
    const expectedLink = selected.expectedEpic?.key ?? null;
    if (!Object.hasOwn(issue.value.fields, field.metadata.id) || observedLink !== expectedLink)
      return planningRefusal(
        "The native Epic Link field does not independently match the reviewed relationship.",
        "conflict",
      );
    issues.push(issue.value);
  }
  return {
    ok: true,
    value: {
      input,
      field,
      issues,
      unchanged: input.issues.every(({ expectedEpic }) => expectedEpic === null),
    },
  };
}
async function rankedIssue(
  requests: JiraAgileRequestPhase,
  input: RankInput,
  selected: RankInput["anchor"],
): Promise<PlanningObservation<PlanningIssue>> {
  const issue = await readPlanningIssue(requests, selected.issueIdOrKey, [input.fieldId]);
  if (!issue.ok) return issue;
  if (
    !Object.hasOwn(issue.value.fields, input.fieldId) ||
    issue.value.fields[input.fieldId] !== selected.expectedRank
  )
    return planningRefusal(
      "The opaque native rank no longer matches its reviewed value. Missing rank is not an observed null.",
      "conflict",
    );
  if (input.operation === "jira.rank-epic") {
    const epic = await readPlanningEpic(requests, issue.value);
    if (epic !== undefined) return epic;
  }
  return issue;
}
async function rankSelection(
  requests: JiraAgileRequestPhase,
  input: RankInput,
  field: PlanningField,
): Promise<PlanningObservation<PlanningAdmission>> {
  const anchor = await rankedIssue(requests, input, input.anchor);
  if (!anchor.ok) return anchor;
  const issues: PlanningIssue[] = [];
  const ids = new Set([anchor.value.id]);
  for (const selected of input.issues) {
    const issue = await rankedIssue(requests, input, selected);
    if (!issue.ok) return issue;
    if (ids.has(issue.value.id))
      return planningRefusal(
        "The moved issues and anchor must have distinct native IDs, including aliases.",
      );
    ids.add(issue.value.id);
    issues.push(issue.value);
  }
  // Jira keeps epics out of the board issue list, so an epic's identity is bound by its own
  // `epic/{id}` read instead. Jira's epic rank is not board-scoped: the reviewed board supplies
  // only the rank field, so no board membership is claimed for the ranked epic or its anchor.
  const scope =
    input.operation === "jira.rank-epic"
      ? undefined
      : await readPlanningBoardSubset(requests, input.boardId, [...issues, anchor.value]);
  return (
    scope ?? { ok: true, value: { input, field, issues, anchor: anchor.value, unchanged: false } }
  );
}
async function estimateSelection(
  requests: JiraAgileRequestPhase,
  input: EstimationInput,
  field: PlanningField,
): Promise<PlanningObservation<PlanningAdmission>> {
  const issue = await readPlanningIssue(requests, input.issueIdOrKey, [input.fieldId]);
  if (!issue.ok) return issue;
  const current = await readPlanningEstimation(
    requests,
    issue.value.id,
    input.boardId,
    input.fieldId,
  );
  if (!current.ok) return current;
  if (
    current.value !== input.expectedValue ||
    !Object.hasOwn(issue.value.fields, input.fieldId) ||
    issue.value.fields[input.fieldId] !== current.value
  )
    return planningRefusal(
      "The current estimation value differs from the explicitly reviewed native value or the direct issue field.",
      "conflict",
    );
  return {
    ok: true,
    value: {
      input,
      field,
      issues: [issue.value],
      unchanged: current.value === input.expectedNativeValue,
    },
  };
}
function metadata(id: string): JiraFieldMetadata {
  return {
    id,
    name: id,
    kind: "unsupported",
    required: false,
    hasDefaultValue: false,
    richText: false,
    operations: [],
  };
}
function plannedFields(admission: PlanningAdmission): Readonly<Record<string, unknown>> {
  const input = admission.input;
  if (input.operation === "jira.epic-remove-issues") return { [admission.field.metadata.id]: null };
  if (input.operation !== "jira.set-issue-estimation") return { [input.fieldId]: undefined };
  return input.unit === "minutes"
    ? // The native original-estimate endpoint does not prove remaining-estimate post-state.
      {
        [input.fieldId]: input.expectedNativeValue,
        timeestimate: undefined,
        timetracking: undefined,
      }
    : { [input.fieldId]: input.expectedNativeValue };
}
async function formalGate(
  requests: JiraAgileRequestPhase,
  admission: PlanningAdmission,
  source: JiraIssueTemplateSource | undefined,
): Promise<PlanningFailure | undefined> {
  const fields = plannedFields(admission);
  const fieldMetadata = [
    admission.field.metadata,
    ...Object.keys(fields)
      .filter((id) => id !== admission.field.metadata.id)
      .map(metadata),
  ];
  // RankService may insert an unranked anchor into its global index, so gate it too.
  const affected = [
    ...admission.issues,
    ...(admission.anchor === undefined ? [] : [admission.anchor]),
  ];
  for (const issue of affected) {
    const gate = await gateJiraMutationByTemplates({
      request: requests.issue,
      source,
      operation: "edit",
      metadata: fieldMetadata,
      validated: { fields, update: {} },
      target: { issueKey: issue.id },
    });
    if (!gate.ok) return gate;
  }
  return undefined;
}
async function boardAdmission(
  requests: JiraAgileRequestPhase,
  input: PlanningInput,
): Promise<PlanningFailure | undefined> {
  if (input.operation === "jira.epic-remove-issues") return undefined;
  const board = await readPlanningBoard(requests, input);
  if (!board.ok) return board;
  return boardFieldMatches(input, board.value)
    ? undefined
    : planningRefusal(
        "The reviewed board rank/estimation field changed or is not a supported field-backed configuration.",
        "conflict",
      );
}
async function selection(
  requests: JiraAgileRequestPhase,
  input: PlanningInput,
  field: PlanningField,
): Promise<PlanningObservation<PlanningAdmission>> {
  switch (input.operation) {
    case "jira.epic-remove-issues":
      return removeSelection(requests, input, field);
    case "jira.rank-epic":
    case "jira.rank-issues":
      return rankSelection(requests, input, field);
    case "jira.set-issue-estimation":
      return estimateSelection(requests, input, field);
  }
}
export async function admitAgilePlanning(
  requests: JiraAgileRequestPhase,
  input: PlanningInput,
  source: JiraIssueTemplateSource | undefined,
): Promise<PlanningObservation<PlanningAdmission>> {
  const actor = await readSavedActor(requests.issue, input.expectedActorKey, {
    beforeEffect: true,
  });
  if (!actor.ok) return actor;
  const board = await boardAdmission(requests, input);
  if (board !== undefined) return board;
  const field = await readPlanningField(requests, input);
  if (!field.ok) return field;
  const selected = await selection(requests, input, field.value);
  if (!selected.ok) return selected;
  if (selected.value.issues.length === 0) return PLANNING_MALFORMED;
  const refused = await formalGate(requests, selected.value, source);
  return refused ?? selected;
}
