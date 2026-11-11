import { TOOL_CATALOG_LIMITS } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { asArray } from "./atlassian-sync-classify.js";
import { agileBoard, agileDate } from "./jira-agile-projection.js";
import type { JiraAgileRequestPhase } from "./jira-agile-request.js";
import { jiraMetadataPageLast } from "./jira-managed-metadata.js";
import {
  gateJiraBulkReferenceChange,
  type JiraIssueTemplateSource,
  type JiraTemplateGateResult,
} from "./jira-managed-template-gate.js";
import { dispatchFailure } from "./jira-mutation-failure.js";
import { readSavedActor } from "./jira-saved-configuration-values.js";
import {
  jiraSprintLifecycleSnapshot,
  sameSprintValue,
  sprintRefusal,
  SPRINT_MALFORMED,
  type SprintLifecycleInput,
  type SprintObservation,
  type SprintSnapshot,
  type SprintFailure,
  type SprintReplacement,
} from "./jira-sprint-lifecycle-values.js";

export async function readLifecycleSprint(
  requests: JiraAgileRequestPhase,
  id: string,
): Promise<SprintObservation<SprintSnapshot>> {
  const response = await requests.agile(`sprint/${id}`);
  if (!response.ok) return dispatchFailure(response);
  const value =
    response.status === 200 ? jiraSprintLifecycleSnapshot(response.body, true) : undefined;
  return value?.id === id ? { ok: true, value } : SPRINT_MALFORMED;
}
export async function bindLifecycleBoard(
  requests: JiraAgileRequestPhase,
  boardId: string,
): Promise<JiraTemplateGateResult> {
  const response = await requests.agile(`board/${boardId}`);
  if (!response.ok) return dispatchFailure(response);
  const board = response.status === 200 ? agileBoard(response.body) : undefined;
  return board?.id === boardId && board.type === "scrum"
    ? { ok: true }
    : sprintRefusal(
        "The reviewed origin board must still be the same accessible Scrum board.",
        "conflict",
      );
}
export async function bindLifecycleSelection(
  requests: JiraAgileRequestPhase,
  input: SprintLifecycleInput,
): Promise<JiraTemplateGateResult> {
  const actor = await readSavedActor(requests.issue, input.expectedActorKey);
  if (!actor.ok) return actor;
  const boards = new Set<string>();
  const selected = [
    ...input.sprints,
    ...(input.destination === undefined ? [] : [input.destination]),
  ];
  for (const expected of selected) {
    const observed = await readLifecycleSprint(requests, expected.id);
    if (!observed.ok) return observed;
    if (!sameSprintValue(observed.value, expected))
      return sprintRefusal(
        "Sprint metadata no longer matches the complete reviewed snapshot. Review it again.",
        "conflict",
      );
    if (boards.has(expected.originBoardId)) continue;
    const bound = await bindLifecycleBoard(requests, expected.originBoardId);
    if (!bound.ok) return bound;
    boards.add(expected.originBoardId);
  }
  return { ok: true };
}

/** Complete only for this actor's visible board list; it proves no hidden-issue population. */
function appendSprintIds(values: readonly unknown[], ids: string[], seen: Set<string>): boolean {
  for (const raw of values) {
    const sprint = jiraSprintLifecycleSnapshot(raw, true);
    if (sprint === undefined || seen.has(sprint.id)) return false;
    seen.add(sprint.id);
    ids.push(sprint.id);
  }
  return true;
}
async function visibleSprintPage(
  requests: JiraAgileRequestPhase,
  boardId: string,
  startAt: number,
): Promise<
  SprintObservation<{
    readonly values: readonly unknown[];
    readonly last: boolean;
    readonly total?: number;
  }>
> {
  const response = await requests.agile(
    `board/${boardId}/sprint?startAt=${String(startAt)}&maxResults=100`,
  );
  if (!response.ok) return dispatchFailure(response);
  const values = asArray(response.body?.values);
  if (response.status !== 200 || response.body === undefined || values === undefined)
    return SPRINT_MALFORMED;
  const last = jiraMetadataPageLast(response.body, values.length, startAt, 100);
  return last === undefined
    ? SPRINT_MALFORMED
    : {
        ok: true,
        value: {
          values,
          last,
          ...(typeof response.body.total === "number" ? { total: response.body.total } : {}),
        },
      };
}
export async function readVisibleSprintOrder(
  requests: JiraAgileRequestPhase,
  boardId: string,
): Promise<SprintObservation<readonly string[]>> {
  const ids: string[] = [];
  const seen = new Set<string>();
  let total: number | undefined;
  for (let pageIndex = 0; pageIndex < 10; pageIndex++) {
    const page = await visibleSprintPage(requests, boardId, ids.length);
    if (!page.ok) return page;
    if (ids.length + page.value.values.length > TOOL_CATALOG_LIMITS.maxArrayItems)
      return { ok: false, reason: "bounds-exceeded" };
    if (pageIndex > 0 && page.value.total !== total)
      return sprintRefusal("The visible sprint list changed during pagination.", "conflict");
    total = page.value.total;
    if (!appendSprintIds(page.value.values, ids, seen)) return SPRINT_MALFORMED;
    if (page.value.last) return { ok: true, value: ids };
  }
  return { ok: false, reason: "bounds-exceeded" };
}
function replacementTransition(
  current: SprintSnapshot,
  desired: SprintReplacement,
): SprintFailure | undefined {
  if (current.state === "closed") return { ok: false, reason: "invalid-transition" };
  if (
    desired.state !== current.state &&
    !(current.state === "future" && desired.state === "active") &&
    !(current.state === "active" && desired.state === "closed")
  )
    return { ok: false, reason: "invalid-transition" };
  return undefined;
}
function scheduledDatesRefusal(desired: SprintReplacement): SprintFailure | undefined {
  if (
    (desired.state === "active" || desired.autoStartStop) &&
    (!agileDate(desired.startDate) || !agileDate(desired.endDate))
  )
    return sprintRefusal(
      "An active or automatically scheduled sprint requires explicit valid start and end dates.",
    );
  if (
    desired.startDate !== null &&
    desired.endDate !== null &&
    Date.parse(desired.startDate) >= Date.parse(desired.endDate)
  )
    return sprintRefusal("The sprint end date must follow its start date.");
  return undefined;
}
function replacementDates(
  current: SprintSnapshot,
  desired: SprintReplacement,
): SprintFailure | undefined {
  const scheduled = scheduledDatesRefusal(desired);
  if (scheduled !== undefined) return scheduled;
  if (
    current.synced &&
    (current.startDate !== desired.startDate || current.endDate !== desired.endDate)
  )
    return sprintRefusal(
      "Date changes on a synced sprint require Jira administrator permissions. Review and explicitly unmap it first; this ordinary operation does not grant administrator authority.",
    );
  return undefined;
}
function replaceState(
  input: SprintLifecycleInput,
  current: SprintSnapshot,
): SprintFailure | undefined {
  const desired = input.replacement;
  if (desired === undefined || typeof current.synced !== "boolean")
    return sprintRefusal(
      "Full replacement requires an observed native synced flag and every replacement field. Missing values are not false or null.",
    );
  const invalid = replacementTransition(current, desired) ?? replacementDates(current, desired);
  if (invalid !== undefined) return invalid;
  // Jira 10.3 stores a reviewed destination on a future or active sprint and returns it on the
  // next read, while it omits a null one. An open destination is therefore the only way a full
  // replacement can prove every field; only a closed destination is refused.
  if (input.destination?.state === "closed")
    return sprintRefusal(
      "An incomplete-issue destination must be an open sprint, not a closed one.",
    );
  return undefined;
}
export function lifecycleConstraints(input: SprintLifecycleInput): SprintFailure | undefined {
  const first = input.sprints[0];
  if (first === undefined) return SPRINT_MALFORMED;
  switch (input.operation) {
    case "jira.replace-sprint":
      return replaceState(input, first);
    case "jira.delete-sprint":
      return deletionConstraint(first);
    case "jira.swap-sprints":
      return input.sprints.some((sprint) => sprint.originBoardId !== first.originBoardId)
        ? sprintRefusal(
            "Review two sprints from the same origin board for an observable board-order swap.",
          )
        : undefined;
    case "jira.unmap-sprints":
    case "jira.unmap-all-sprints":
      return input.sprints.some((sprint) => typeof sprint.synced !== "boolean")
        ? sprintRefusal(
            "Every reviewed sprint must expose its native synced boolean; unknown is not false.",
          )
        : undefined;
  }
}
function deletionConstraint(sprint: SprintSnapshot): SprintFailure | undefined {
  return sprint.state !== "future" || sprint.synced !== false
    ? sprintRefusal(
        "Only a future, explicitly unsynced native sprint can be deleted. Missing synchronization evidence cannot authorize deletion.",
      )
    : undefined;
}
export function lifecycleMembershipGate(
  requests: JiraAgileRequestPhase,
  input: SprintLifecycleInput,
  source: JiraIssueTemplateSource | undefined,
): Promise<JiraTemplateGateResult> {
  const affectsIssues =
    input.operation === "jira.delete-sprint" ||
    (input.operation === "jira.replace-sprint" &&
      (input.replacement?.state === "closed" || input.replacement?.autoStartStop === true));
  return affectsIssues
    ? gateJiraBulkReferenceChange({ request: requests.issue, source, kind: "sprint" })
    : Promise.resolve({ ok: true });
}
