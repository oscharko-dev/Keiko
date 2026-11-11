import type { OptionalWidgetTranslate, WidgetMessageKey } from "@/lib/optional-widget-i18n";
import { jiraDraftValueOf, type JiraDraftField, type JiraDraftValue } from "./jiraDraftTree";
import { jiraPresentationRecord as record } from "./jira-presentation-values";
import { jiraReviewedMutationScalar as scalar } from "./jira-structural-mutation-approval";
import { JIRA_SPRINT_SNAPSHOT_LABELS as SNAPSHOT_LABELS } from "./jira-sprint-lifecycle-presentation";

const LABELS: Readonly<Record<string, WidgetMessageKey>> = {
  expectedActorKey: "chat.jira.savedConfiguration.reviewedActor",
  sprintId: "chat.jira.fact.sprintId",
  expectedSprint: "chat.jira.sprintLifecycle.reviewedSprint",
  replacement: "chat.jira.sprintLifecycle.replacement",
  expectedDestination: "chat.jira.sprintLifecycle.reviewedDestination",
  swapSprintId: "chat.jira.sprintLifecycle.swapSprint",
  expectedSwapSprint: "chat.jira.sprintLifecycle.reviewedSwap",
  expectedVisibleSprintIds: "chat.jira.sprintLifecycle.visibleOrder",
  expectedSprints: "chat.jira.sprintLifecycle.reviewedSelection",
  confirmInstanceWide: "chat.jira.sprintLifecycle.confirmInstanceWide",
};
const STATES: Readonly<Record<string, WidgetMessageKey>> = {
  future: "chat.jira.agile.future",
  active: "chat.jira.agile.active",
  closed: "chat.jira.agile.closed",
};
function entryValue(
  key: string,
  value: unknown,
  replacement: boolean,
  t: OptionalWidgetTranslate,
): JiraDraftValue {
  if (value === undefined)
    return { kind: "text", text: t("chat.jira.sprintLifecycle.metadataOmitted") };
  if (value === null && replacement)
    return { kind: "text", text: t("chat.jira.sprintLifecycle.clearValue") };
  if (key === "state" && typeof value === "string" && Object.hasOwn(STATES, value)) {
    const label = STATES[value];
    if (label !== undefined) return { kind: "text", text: t(label) };
  }
  return scalar(value, t);
}
function snapshot(
  value: unknown,
  replacement: boolean,
  t: OptionalWidgetTranslate,
): JiraDraftValue {
  const source = record(value);
  if (source === undefined) return jiraDraftValueOf(value);
  const keys = replacement
    ? Object.keys(source)
    : [...new Set([...Object.keys(source), ...Object.keys(SNAPSHOT_LABELS)])];
  return {
    kind: "group",
    members: keys.map((key) => {
      const label = SNAPSHOT_LABELS[key];
      return {
        name: label === undefined ? key : t(label),
        value: entryValue(key, source[key], replacement, t),
      };
    }),
  };
}
function selectedSnapshots(value: unknown, t: OptionalWidgetTranslate): JiraDraftValue {
  if (!Array.isArray(value)) return jiraDraftValueOf(value);
  return {
    kind: "list",
    items: value.map((item: unknown, index) => ({
      position: index + 1,
      value: snapshot(item, false, t),
    })),
  };
}
function selectedValue(key: string, value: unknown, t: OptionalWidgetTranslate): JiraDraftValue {
  if (key === "expectedSprints") return selectedSnapshots(value, t);
  if (key === "replacement") return snapshot(value, true, t);
  if (key === "expectedSprint" || key === "expectedDestination" || key === "expectedSwapSprint")
    return snapshot(value, false, t);
  return scalar(value, t);
}
export function jiraSprintLifecycleFacts(
  tool: string,
  key: string,
  value: unknown,
  t: OptionalWidgetTranslate,
): readonly JiraDraftField[] | undefined {
  const label =
    key === "expectedSprints" && tool === "jira_unmap_all_sprints"
      ? "chat.jira.sprintLifecycle.reviewedSample"
      : LABELS[key];
  return label === undefined ? undefined : [{ id: t(label), value: selectedValue(key, value, t) }];
}
const LIMITS: Readonly<Record<string, WidgetMessageKey>> = {
  jira_replace_sprint: "chat.jira.sprintLifecycle.fullReplacement",
  jira_delete_sprint: "chat.jira.sprintLifecycle.deleteUnconfirmed",
  jira_swap_sprints: "chat.jira.sprintLifecycle.swapUnconfirmed",
  jira_unmap_sprints: "chat.jira.sprintLifecycle.selectedOnly",
  jira_unmap_all_sprints: "chat.jira.sprintLifecycle.instanceWide",
};
export function jiraSprintLifecycleContextFacts(
  tool: string,
  t: OptionalWidgetTranslate,
): readonly JiraDraftField[] {
  const labels: WidgetMessageKey[] = ["chat.jira.structural.noAtomicSnapshot"];
  const limit = LIMITS[tool];
  if (limit !== undefined) labels.push(limit);
  if (tool === "jira_unmap_all_sprints" || tool === "jira_unmap_sprints")
    labels.push("chat.jira.sprintLifecycle.experimental");
  return labels.map((label) => ({
    id: t("chat.jira.savedConfiguration.nativeLimitation"),
    value: { kind: "text", text: t(label) },
  }));
}
