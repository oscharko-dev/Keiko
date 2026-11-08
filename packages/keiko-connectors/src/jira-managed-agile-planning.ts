import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { JiraAgileRequests, JiraAgileRequestPhase } from "./jira-agile-request.js";
import type { JiraIssueTemplateSource } from "./jira-managed-template-gate.js";
import { dispatchFailure, JiraAcknowledgedMutationError } from "./jira-mutation-failure.js";
import { readSavedActor, savedText } from "./jira-saved-configuration-values.js";
import { admitAgilePlanning, type PlanningAdmission } from "./jira-agile-planning-admission.js";
import {
  boardFieldMatches,
  readPlanningBoard,
  readPlanningEpic,
  readPlanningEpicMembership,
  readPlanningEstimation,
  readPlanningField,
  readPlanningIssue,
  type PlanningIssue,
} from "./jira-agile-planning-observations.js";
import {
  parseAgilePlanningInput,
  planningRefusal,
  PLANNING_MALFORMED,
  type PlanningAttempt,
  type PlanningFailure,
  type JiraAgilePlanningReceipt,
} from "./jira-agile-planning-values.js";
export {
  JIRA_AGILE_PLANNING_MUTATIONS,
  isJiraAgilePlanningMutation,
  type JiraAgilePlanningMutation,
} from "./jira-agile-planning-values.js";

export interface JiraAgilePlanningPorts {
  readonly requests: JiraAgileRequests;
  readonly templates?: JiraIssueTemplateSource;
}
function receiptFor(admission: PlanningAdmission): JiraAgilePlanningReceipt {
  const input = admission.input;
  const userKey = input.expectedActorKey;
  if (input.operation === "jira.set-issue-estimation") {
    const issue = admission.issues[0];
    if (issue === undefined) throw new TypeError("Estimation admission must bind one issue");
    return Object.freeze({
      userKey,
      boardId: input.boardId,
      fieldId: input.fieldId,
      issueId: issue.id,
      issueKey: issue.key,
      estimationValue: input.expectedNativeValue,
      estimationUnit: input.unit === "minutes" ? "seconds" : "board-number",
    });
  }
  const selected = {
    userKey,
    issueIds: Object.freeze(admission.issues.map(({ id }) => id)),
    issueKeys: Object.freeze(admission.issues.map(({ key }) => key)),
  };
  if (input.operation === "jira.epic-remove-issues")
    return Object.freeze({ ...selected, epicPresent: false });
  if (admission.anchor === undefined) throw new TypeError("Rank admission must bind an anchor");
  return Object.freeze({
    ...selected,
    boardId: input.boardId,
    fieldId: input.fieldId,
    anchorIssueId: admission.anchor.id,
    anchorIssueKey: admission.anchor.key,
    rankDirection: input.direction,
  });
}
interface NativeEffect {
  readonly path: string;
  readonly method: "POST" | "PUT";
  readonly body: CatalogJsonObject;
}
function effectFor(admission: PlanningAdmission): NativeEffect {
  const input = admission.input;
  if (input.operation === "jira.epic-remove-issues")
    return {
      path: "epic/none/issue",
      method: "POST",
      body: { issues: admission.issues.map(({ id }) => id) },
    };
  const first = admission.issues[0];
  if (first === undefined) throw new TypeError("Planning effect requires a bound issue");
  if (input.operation === "jira.set-issue-estimation")
    return {
      path: `issue/${first.id}/estimation?boardId=${input.boardId}`,
      method: "PUT",
      body: { value: input.value },
    };
  if (admission.anchor === undefined) throw new TypeError("Rank effect requires a bound anchor");
  const epic = input.operation === "jira.rank-epic";
  let key: "rankBeforeEpic" | "rankAfterEpic" | "rankBeforeIssue" | "rankAfterIssue";
  if (epic) {
    if (input.direction === "before") {
      key = "rankBeforeEpic";
    } else {
      key = "rankAfterEpic";
    }
  } else if (input.direction === "before") {
    key = "rankBeforeIssue";
  } else {
    key = "rankAfterIssue";
  }

  return {
    path: epic ? `epic/${first.id}/rank` : "issue/rank",
    method: "PUT",
    body: {
      [key]: admission.anchor.id,
      rankCustomFieldId: Number(input.rankCustomFieldId),
      ...(epic ? {} : { issues: admission.issues.map(({ id }) => id) }),
    },
  };
}
async function freshIssue(
  requests: JiraAgileRequestPhase,
  selected: PlanningIssue,
  fieldId: string,
): Promise<Awaited<ReturnType<typeof readPlanningIssue>>> {
  const read = await readPlanningIssue(requests, selected.id, [fieldId]);
  return read.ok && read.value.key !== selected.key
    ? planningRefusal(
        "The independently read issue identity changed after acknowledgement.",
        "conflict",
      )
    : read;
}
async function confirmRemoval(
  requests: JiraAgileRequestPhase,
  admission: PlanningAdmission,
): Promise<PlanningFailure | undefined> {
  for (const selected of admission.issues) {
    const issue = await freshIssue(requests, selected, admission.field.metadata.id);
    if (!issue.ok) return issue;
    const epic = await readPlanningEpicMembership(requests, issue.value);
    if (!epic.ok) return epic;
    if (
      epic.value !== null ||
      !Object.hasOwn(issue.value.fields, admission.field.metadata.id) ||
      issue.value.fields[admission.field.metadata.id] !== null
    )
      return planningRefusal(
        "The selected issue's native epic and Epic Link field do not independently prove removal.",
        "conflict",
      );
  }
  return undefined;
}
async function confirmEstimate(
  requests: JiraAgileRequestPhase,
  admission: PlanningAdmission,
): Promise<PlanningFailure | undefined> {
  const input = admission.input;
  const selected = admission.issues[0];
  if (input.operation !== "jira.set-issue-estimation" || selected === undefined)
    return PLANNING_MALFORMED;
  const issue = await freshIssue(requests, selected, input.fieldId);
  if (!issue.ok) return issue;
  const current = await readPlanningEstimation(requests, selected.id, input.boardId, input.fieldId);
  if (!current.ok) return current;
  return current.value === input.expectedNativeValue &&
    Object.hasOwn(issue.value.fields, input.fieldId) &&
    issue.value.fields[input.fieldId] === input.expectedNativeValue
    ? undefined
    : planningRefusal(
        "The independently read estimation field does not equal the requested numeric value in its declared native unit. Null, missing and zero remain different.",
        "conflict",
      );
}
function rankFieldReadable(fields: Readonly<Record<string, unknown>>, fieldId: string): boolean {
  return (
    Object.hasOwn(fields, fieldId) && (fields[fieldId] === null || savedText(fields[fieldId], 2048))
  );
}
async function observeRanks(
  requests: JiraAgileRequestPhase,
  admission: PlanningAdmission,
): Promise<PlanningFailure | undefined> {
  const input = admission.input;
  if (input.operation !== "jira.rank-epic" && input.operation !== "jira.rank-issues")
    return PLANNING_MALFORMED;
  if (admission.anchor === undefined) return PLANNING_MALFORMED;
  for (const selected of [...admission.issues, admission.anchor]) {
    const read = await freshIssue(requests, selected, input.fieldId);
    if (!read.ok) return read;
    const fields = read.value.fields;
    if (!rankFieldReadable(fields, input.fieldId)) return PLANNING_MALFORMED;
    if (input.operation === "jira.rank-epic") {
      const epic = await readPlanningEpic(requests, read.value);
      if (epic !== undefined) return epic;
    }
  }
  return undefined;
}
async function confirmationContext(
  requests: JiraAgileRequestPhase,
  admission: PlanningAdmission,
): Promise<PlanningFailure | undefined> {
  const input = admission.input;
  const actor = await readSavedActor(requests.issue, input.expectedActorKey);
  if (!actor.ok) return actor;
  const field = await readPlanningField(requests, input);
  if (!field.ok) return field;
  if (field.value.metadata.id !== admission.field.metadata.id)
    return planningRefusal("The native field identity changed after acknowledgement.", "conflict");
  if (input.operation === "jira.epic-remove-issues") return undefined;
  const board = await readPlanningBoard(requests, input);
  if (!board.ok) return board;
  return boardFieldMatches(input, board.value)
    ? undefined
    : planningRefusal(
        "The board configuration changed after acknowledgement; the result remains unconfirmed.",
        "conflict",
      );
}
async function confirm(
  requests: JiraAgileRequestPhase,
  admission: PlanningAdmission,
  receipt: JiraAgilePlanningReceipt,
  status: number,
): Promise<PlanningAttempt> {
  const context = await confirmationContext(requests, admission);
  if (context !== undefined) return { ...context, receipt };
  const operation = admission.input.operation;
  let failure: PlanningFailure | undefined;
  if (operation === "jira.epic-remove-issues") {
    failure = await confirmRemoval(requests, admission);
  } else if (operation === "jira.set-issue-estimation") {
    failure = await confirmEstimate(requests, admission);
  } else {
    failure = await observeRanks(requests, admission);
  }

  if (failure !== undefined) return { ...failure, receipt };
  if (operation === "jira.rank-issues" || operation === "jira.rank-epic")
    return planningRefusal(
      status === 207
        ? "Jira acknowledged a potentially partial rank update (207). Fresh identities/rank fields are readable, but neither per-item success hints nor visible order prove the requested global rank changes. Do not replay."
        : "Jira acknowledged the rank update. Fresh selected identities and rank fields are readable, but scoped visible order cannot prove the requested global index positions. Do not replay.",
      "unavailable",
      receipt,
    );
  return { ok: true, receipt };
}
async function writeOnce(
  ports: JiraAgilePlanningPorts,
  admission: PlanningAdmission,
): Promise<PlanningAttempt> {
  const effect = effectFor(admission);
  const receipt = receiptFor(admission);
  const response = await ports.requests.agile(effect.path, effect.method, effect.body, "none");
  if (!response.ok) return { ...dispatchFailure(response), receipt };
  if (response.status < 200 || response.status >= 300) return { ...PLANNING_MALFORMED, receipt };
  const phase = ports.requests.readback();
  try {
    return await confirm(phase, admission, receipt, response.status);
  } catch (error) {
    if (phase.signal.aborted && error === phase.signal.reason)
      return { ok: false, reason: "timeout", receipt };
    throw new JiraAcknowledgedMutationError(error, receipt);
  }
}
/** Fixed native effects; before-effect template admission and independent bounded readback share custody. */
export async function executeJiraAgilePlanningMutation(
  operation: string,
  args: CatalogJsonObject,
  ports: JiraAgilePlanningPorts,
  check = false,
): Promise<PlanningAttempt> {
  const input = parseAgilePlanningInput(operation, args);
  if (input === undefined)
    return planningRefusal(
      "Use the closed Agile arguments with explicit native snapshots, exact IDs, a reviewed actor and board field. Estimation accepts nonnegative decimal text, never an invented null-clearing request.",
    );
  const admission = await admitAgilePlanning(ports.requests, input, ports.templates);
  if (!admission.ok) return admission;
  if (admission.value.unchanged)
    return {
      ...planningRefusal(
        "The independently read target already matches; no effect was sent.",
        "conflict",
        receiptFor(admission.value),
      ),
      detail: {
        unchanged: true,
        messages: ["The independently read target already matches; no effect was sent."],
      },
    };
  return check ? { ok: true, receipt: {} } : writeOnce(ports, admission.value);
}
