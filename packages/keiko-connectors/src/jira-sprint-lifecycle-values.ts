import {
  JIRA_SPRINT_LIFECYCLE_MUTATIONS,
  type JiraSprintLifecycleMutation,
  type JiraMutationAttempt,
  type JiraMutationReceipt,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type {
  CatalogJsonObject,
  CatalogJsonValue,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { canonicalise } from "@oscharko-dev/keiko-security/hashing";
import { asRecord } from "./atlassian-sync-classify.js";
import { agileDate, agileId, agileSprint } from "./jira-agile-projection.js";
import { agileInputId } from "./jira-agile-inputs.js";
import { savedName, savedText } from "./jira-saved-configuration-values.js";

export { JIRA_SPRINT_LIFECYCLE_MUTATIONS, type JiraSprintLifecycleMutation };
export function isJiraSprintLifecycleMutation(name: string): name is JiraSprintLifecycleMutation {
  return (JIRA_SPRINT_LIFECYCLE_MUTATIONS as readonly string[]).includes(name);
}
export interface JiraSprintLifecycleReceipt extends JiraMutationReceipt {
  readonly sprintIds?: readonly string[];
  readonly swapSprintId?: string;
  readonly sprintSynced?: boolean;
  readonly sprintPresent?: boolean;
  readonly allSprints?: true;
}
export type SprintFailure = Omit<Extract<JiraMutationAttempt, { ok: false }>, "receipt"> & {
  readonly receipt?: JiraSprintLifecycleReceipt;
};
export type JiraSprintLifecycleAttempt =
  SprintFailure | { readonly ok: true; readonly receipt: JiraSprintLifecycleReceipt };
export type SprintObservation<T> = SprintFailure | { readonly ok: true; readonly value: T };
export type SprintSnapshot = CatalogJsonObject & {
  readonly id: string;
  readonly originBoardId: string;
  readonly name: string;
  readonly state: "future" | "active" | "closed";
};
export type SprintReplacement = CatalogJsonObject & {
  readonly name: string;
  readonly state: "future" | "active" | "closed";
  readonly startDate: string | null;
  readonly endDate: string | null;
  readonly goal: string | null;
  readonly autoStartStop: boolean;
  readonly incompleteIssuesDestinationId: string | null;
};
export interface SprintLifecycleInput {
  readonly operation: JiraSprintLifecycleMutation;
  readonly expectedActorKey: string;
  readonly sprints: readonly SprintSnapshot[];
  readonly replacement?: SprintReplacement;
  readonly destination?: SprintSnapshot;
  readonly expectedVisibleSprintIds?: readonly string[];
}
export const SPRINT_MALFORMED: SprintFailure = { ok: false, reason: "malformed-payload" };
export function sprintRefusal(
  message: string,
  reason: "field-validation" | "conflict" | "unavailable" = "field-validation",
  receipt?: JiraSprintLifecycleReceipt,
): SprintFailure {
  return {
    ok: false,
    reason,
    detail: { messages: [message] },
    ...(receipt === undefined ? {} : { receipt }),
  };
}
export function sameSprintValue(left: unknown, right: unknown): boolean {
  if (left === undefined || right === undefined) return left === right;
  return canonicalise(left) === canonicalise(right);
}
const SNAPSHOT_KEYS = new Set([
  "id",
  "originBoardId",
  "name",
  "state",
  "startDate",
  "endDate",
  "goal",
  "autoStartStop",
  "synced",
  "incompleteIssuesDestinationId",
  "activatedDate",
  "completeDate",
]);
const REPLACEMENT_KEYS = new Set([
  "name",
  "state",
  "startDate",
  "endDate",
  "goal",
  "autoStartStop",
  "incompleteIssuesDestinationId",
]);
function closed(value: Record<string, unknown>, keys: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => keys.has(key));
}
function snapshotOptional(key: string, value: unknown): boolean {
  if (value === null) return key !== "autoStartStop" && key !== "synced";
  if (key === "autoStartStop" || key === "synced") return typeof value === "boolean";
  if (key === "goal") return savedText(value, 2048, true);
  if (key === "incompleteIssuesDestinationId") return agileId(value) !== undefined;
  return agileDate(value);
}
function sprintState(value: unknown): value is SprintSnapshot["state"] {
  return value === "future" || value === "active" || value === "closed";
}
function snapshotCore(
  value: unknown,
  native: boolean,
):
  | {
      readonly raw: Record<string, unknown>;
      readonly id: string;
      readonly board: string;
      readonly name: string;
      readonly state: SprintSnapshot["state"];
    }
  | undefined {
  const raw = asRecord(value);
  if (
    raw === undefined ||
    agileSprint(value) === undefined ||
    !savedName(raw.name) ||
    !sprintState(raw.state)
  )
    return undefined;
  const id = native ? agileId(raw.id) : agileInputId(raw.id);
  const board = native ? agileId(raw.originBoardId) : agileInputId(raw.originBoardId);
  return id === undefined || board === undefined
    ? undefined
    : { raw, id, board, name: raw.name, state: raw.state };
}
function snapshotItem(key: string, item: unknown, native: boolean): CatalogJsonValue | undefined {
  let projected = item as CatalogJsonValue | undefined;
  if (key === "incompleteIssuesDestinationId" && item !== null)
    projected = native ? agileId(item) : agileInputId(item);
  return projected;
}
/** Preserve missing native facts as missing. No absent synced flag becomes false, and no
 * omitted date/destination becomes a reviewed null. Identity is numeric-wire-safe by design. */
export function jiraSprintLifecycleSnapshot(
  value: unknown,
  native = false,
): SprintSnapshot | undefined {
  const core = snapshotCore(value, native);
  if (core === undefined) return undefined;
  const { raw, id, board, name, state } = core;
  const allowed = native ? new Set([...SNAPSHOT_KEYS, "self"]) : SNAPSHOT_KEYS;
  if (!closed(raw, allowed)) return undefined;
  const result: Record<string, CatalogJsonValue> = { id, originBoardId: board, name, state };
  for (const key of SNAPSHOT_KEYS) {
    if (key in result || !Object.hasOwn(raw, key)) continue;
    const item = raw[key];
    if (!snapshotOptional(key, item)) return undefined;
    const projected = snapshotItem(key, item, native);
    if (projected === undefined) return undefined;
    result[key] = projected;
  }
  return { ...result, id, originBoardId: board, name, state };
}
function replacement(value: unknown): SprintReplacement | undefined {
  const raw = asRecord(value);
  if (
    raw === undefined ||
    !closed(raw, REPLACEMENT_KEYS) ||
    Object.keys(raw).length !== REPLACEMENT_KEYS.size
  )
    return undefined;
  if (!savedName(raw.name) || !sprintState(raw.state) || typeof raw.autoStartStop !== "boolean")
    return undefined;
  for (const key of ["startDate", "endDate", "goal", "incompleteIssuesDestinationId"])
    if (!snapshotOptional(key, raw[key])) return undefined;
  if (
    raw.incompleteIssuesDestinationId !== null &&
    agileInputId(raw.incompleteIssuesDestinationId) === undefined
  )
    return undefined;
  return raw as SprintReplacement;
}
function snapshots(value: unknown): readonly SprintSnapshot[] | undefined {
  if (!Array.isArray(value) || value.length < 1 || value.length > 50) return undefined;
  const items = value.map((item) => jiraSprintLifecycleSnapshot(item));
  if (items.includes(undefined)) return undefined;
  const valid = items.filter((item): item is SprintSnapshot => item !== undefined);
  return new Set(valid.map((item) => item.id)).size === valid.length ? valid : undefined;
}
function selectedIds(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length < 2 || value.length > 1000) return undefined;
  const ids = value.map(agileInputId);
  if (ids.includes(undefined)) return undefined;
  const valid = ids.filter((id): id is string => id !== undefined);
  return new Set(valid).size === valid.length ? valid : undefined;
}
function swapInput(
  base: SprintLifecycleInput,
  first: SprintSnapshot,
  args: CatalogJsonObject,
): SprintLifecycleInput | undefined {
  const second = jiraSprintLifecycleSnapshot(args.expectedSwapSprint);
  const ids = selectedIds(args.expectedVisibleSprintIds);
  if (second === undefined || ids === undefined) return undefined;
  if (second.id !== agileInputId(args.swapSprintId) || second.id === first.id) return undefined;
  if (!ids.includes(first.id) || !ids.includes(second.id)) return undefined;
  return { ...base, sprints: [first, second], expectedVisibleSprintIds: ids };
}
function replacementInput(
  base: SprintLifecycleInput,
  first: SprintSnapshot,
  args: CatalogJsonObject,
): SprintLifecycleInput | undefined {
  const desired = replacement(args.replacement);
  if (desired === undefined) return undefined;
  const destination =
    args.expectedDestination === undefined
      ? undefined
      : jiraSprintLifecycleSnapshot(args.expectedDestination);
  if (
    desired.incompleteIssuesDestinationId !== null &&
    (destination?.id !== desired.incompleteIssuesDestinationId || destination.id === first.id)
  )
    return undefined;
  if (desired.incompleteIssuesDestinationId === null && args.expectedDestination !== undefined)
    return undefined;
  return { ...base, replacement: desired, ...(destination === undefined ? {} : { destination }) };
}
function selectedInput(
  operation: JiraSprintLifecycleMutation,
  args: CatalogJsonObject,
): SprintLifecycleInput | undefined {
  if (!savedText(args.expectedActorKey, 255)) return undefined;
  const first = jiraSprintLifecycleSnapshot(args.expectedSprint);
  if (first === undefined || agileInputId(args.sprintId) !== first.id) return undefined;
  const base = { operation, expectedActorKey: args.expectedActorKey, sprints: [first] };
  if (operation === "jira.delete-sprint") return base;
  return operation === "jira.swap-sprints"
    ? swapInput(base, first, args)
    : replacementInput(base, first, args);
}
const INPUT_KEYS: Readonly<Record<JiraSprintLifecycleMutation, ReadonlySet<string>>> = {
  "jira.replace-sprint": new Set([
    "expectedActorKey",
    "sprintId",
    "expectedSprint",
    "replacement",
    "expectedDestination",
  ]),
  "jira.delete-sprint": new Set(["expectedActorKey", "sprintId", "expectedSprint"]),
  "jira.swap-sprints": new Set([
    "expectedActorKey",
    "sprintId",
    "expectedSprint",
    "swapSprintId",
    "expectedSwapSprint",
    "expectedVisibleSprintIds",
  ]),
  "jira.unmap-sprints": new Set(["expectedActorKey", "expectedSprints"]),
  "jira.unmap-all-sprints": new Set(["expectedActorKey", "expectedSprints", "confirmInstanceWide"]),
};
export function parseSprintLifecycleInput(
  operation: string,
  args: CatalogJsonObject,
): SprintLifecycleInput | undefined {
  if (
    !isJiraSprintLifecycleMutation(operation) ||
    !closed(args, INPUT_KEYS[operation]) ||
    !savedText(args.expectedActorKey, 255)
  )
    return undefined;
  if (operation === "jira.unmap-sprints" || operation === "jira.unmap-all-sprints") {
    if (operation === "jira.unmap-all-sprints" && args.confirmInstanceWide !== true)
      return undefined;
    const items = snapshots(args.expectedSprints);
    return items === undefined
      ? undefined
      : { operation, expectedActorKey: args.expectedActorKey, sprints: items };
  }
  return selectedInput(operation, args);
}
