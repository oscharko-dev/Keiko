import type { OptionalWidgetTranslate, WidgetMessageKey } from "@/lib/optional-widget-i18n";
import { jiraDraftValueOf, type JiraDraftField, type JiraDraftValue } from "./jiraDraftTree";
import { jiraPresentationRecord as record } from "./jira-presentation-values";
import { JIRA_RELEASE_LIFECYCLE_TOOLS, jiraReleaseReferenceEffectsUnconfirmed } from "./jira-release-lifecycle-presentation";
import { JIRA_LINK_MUTATION_TOOLS, JIRA_REMOTE_SNAPSHOT_LABELS } from "./jira-link-mutation-presentation";
import { jiraProjectMetadataArgumentLabel } from "./jira-project-metadata-presentation";
import { jiraPropertyValueDetails } from "./jira-property-presentation";

const LABELS: Readonly<Record<string, WidgetMessageKey>> = {
  expectedActorKey: "chat.jira.savedConfiguration.reviewedActor", expectedProjectId: "chat.jira.structural.reviewedProject",
  componentId: "chat.jira.fact.componentId", versionId: "chat.jira.fact.versionId", linkId: "chat.jira.fact.linkId",
  expectedComponentSnapshot: "chat.jira.structural.reviewedComponent", expectedVersionSnapshot: "chat.jira.structural.reviewedVersion",
  expectedReplacementSnapshot: "chat.jira.structural.reviewedReplacementComponent", expectedTargetSnapshot: "chat.jira.structural.reviewedTargetVersion",
  expectedVersionIds: "chat.jira.structural.reviewedVersionOrder", expectedReplacementVersions: "chat.jira.structural.reviewedReplacementVersions",
  moveIssuesTo: "chat.jira.structural.replacementTarget", position: "chat.jira.structural.requestedPosition", afterVersionId: "chat.jira.structural.afterVersion",
  moveFixIssuesTo: "chat.jira.structural.fixVersionTarget", moveAffectedIssuesTo: "chat.jira.structural.affectedVersionTarget",
  customFieldReplacementList: "chat.jira.structural.customReplacements", issueIdOrKey: "chat.jira.fact.issue",
  inwardIssueIdOrKey: "chat.jira.structural.inwardIssue", outwardIssueIdOrKey: "chat.jira.structural.outwardIssue",
  linkType: "chat.jira.structural.reviewedLinkType", globalId: "chat.jira.issueContext.globalId",
  expected: "chat.jira.structural.reviewedRemoteLink", value: "chat.jira.structural.newRemoteLink", expectAbsent: "chat.jira.structural.reviewedLinkAbsent",
};
const SNAPSHOTS = new Set(["expectedComponentSnapshot", "expectedVersionSnapshot", "expectedReplacementSnapshot", "expectedTargetSnapshot"]);
const CLEAR_TARGETS = new Set(["moveIssuesTo", "moveFixIssuesTo", "moveAffectedIssuesTo", "moveTo"]);
const GROUP_LABELS: Readonly<Record<string, WidgetMessageKey>> = {
  id: "chat.jira.fact.linkTypeId", name: "chat.jira.structural.nativeName", description: "chat.jira.structural.nativeDescription",
  inward: "chat.jira.fact.linkInward", outward: "chat.jira.fact.linkOutward", deleted: "chat.jira.structural.deleted",
  versionId: "chat.jira.fact.versionId", customFieldId: "chat.jira.structural.customFieldId", moveTo: "chat.jira.structural.replacementTarget",
};
const POSITIONS: Readonly<Record<string, WidgetMessageKey>> = {
  First: "chat.jira.structural.first", Last: "chat.jira.structural.last", Earlier: "chat.jira.structural.earlier", Later: "chat.jira.structural.later",
};
const literal = (text: string): JiraDraftValue => ({ kind: "text", text });
function selected(operation: string | undefined): string | undefined {
  const tool = operation?.replace(/[.-]/gu, "_");
  return tool !== undefined && (JIRA_RELEASE_LIFECYCLE_TOOLS.has(tool) || JIRA_LINK_MUTATION_TOOLS.has(tool)) ? tool : undefined;
}
function scalar(value: unknown, t: OptionalWidgetTranslate, clear = false): JiraDraftValue {
  if (value === null) return literal(t(clear ? "chat.jira.structural.clearReference" : "chat.jira.structural.nativeNotProvided"));
  if (typeof value === "boolean") return literal(t(value ? "chat.jira.propertyMutation.true" : "chat.jira.propertyMutation.false"));
  if (value === "") return literal(t("chat.jira.propertyMutation.emptyText"));
  if (typeof value === "string" && value.trim() === "") {
    const details = jiraPropertyValueDetails({ kind: "string", textValue: value, path: "" });
    return literal(`${t("chat.jira.structural.whitespaceText")}: ${details.body ?? value}`);
  }
  return jiraDraftValueOf(value);
}
function group(value: unknown, t: OptionalWidgetTranslate, remote: boolean, component: boolean, replacement = false): JiraDraftValue {
  const source = record(value);
  if (source === undefined) return jiraDraftValueOf(value);
  const labels: Readonly<Record<string, WidgetMessageKey>> = remote ? JIRA_REMOTE_SNAPSHOT_LABELS : GROUP_LABELS;
  return { kind: "group", members: Object.entries(source).map(([field, entry]) => {
    const label = labels[field] ?? jiraProjectMetadataArgumentLabel(component ? "jira.update-component" : "jira.update-version", field);
    const presented = replacement && entry === null ? literal(t("chat.jira.linkMutation.requestedNull")) : scalar(entry, t, CLEAR_TARGETS.has(field));
    return { name: label === undefined ? field : t(label), value: presented };
  }) };
}
function replacements(value: unknown, t: OptionalWidgetTranslate): JiraDraftValue {
  if (!Array.isArray(value)) return jiraDraftValueOf(value);
  if (value.length === 0) return literal(t("chat.jira.structural.noReplacementVersions"));
  return { kind: "list", items: value.map((entry: unknown, index) => {
    const source = record(entry);
    const members = Object.entries(source ?? {}).map(([field, item]) => {
      const label = field === "expectedVersionSnapshot" ? "chat.jira.structural.reviewedTargetVersion" : LABELS[field] ?? GROUP_LABELS[field];
      return { name: label === undefined ? field : t(label),
        value: field === "expectedVersionSnapshot" ? group(item, t, false, false) : scalar(item, t) };
    });
    return { position: index + 1, value: source === undefined ? jiraDraftValueOf(entry) : { kind: "group", members } satisfies JiraDraftValue };
  }) };
}
function customReplacements(value: unknown, t: OptionalWidgetTranslate): JiraDraftValue {
  if (!Array.isArray(value)) return jiraDraftValueOf(value);
  if (value.length === 0) return literal(t("chat.jira.structural.clearAllCustomReferences"));
  return { kind: "list", items: value.map((entry: unknown, index) => ({ position: index + 1, value: group(entry, t, false, false) })) };
}
function position(value: unknown, t: OptionalWidgetTranslate): JiraDraftValue {
  const label = typeof value === "string" && Object.hasOwn(POSITIONS, value) ? POSITIONS[value] : undefined;
  return label === undefined ? jiraDraftValueOf(value) : literal(t(label));
}
function reviewedValue(key: string, value: unknown, tool: string, t: OptionalWidgetTranslate): JiraDraftValue {
  if (SNAPSHOTS.has(key)) return group(value, t, false, tool === "jira_delete_component");
  if (key === "expected" || key === "value") return group(value, t, true, false, key === "value");
  if (key === "linkType") return group(value, t, false, false);
  if (key === "expectedReplacementVersions") return replacements(value, t);
  if (key === "customFieldReplacementList") return customReplacements(value, t);
  if (key === "position") return position(value, t);
  return scalar(value, t, CLEAR_TARGETS.has(key));
}
export function jiraStructuralMutationFacts(operation: string | undefined, key: string, value: unknown, t: OptionalWidgetTranslate): readonly JiraDraftField[] | undefined {
  const tool = selected(operation);
  const label = LABELS[key];
  return tool === undefined || label === undefined ? undefined : [{ id: t(label), value: reviewedValue(key, value, tool, t) }];
}
export function jiraStructuralMutationContextFacts(operation: string | undefined, t: OptionalWidgetTranslate): readonly JiraDraftField[] {
  const tool = selected(operation);
  if (tool === undefined) return [];
  const labels: WidgetMessageKey[] = ["chat.jira.structural.noAtomicSnapshot"];
  if (jiraReleaseReferenceEffectsUnconfirmed(tool)) labels.push("chat.jira.releaseLifecycle.referencesUnconfirmed");
  if (tool === "jira_move_version") labels.push("chat.jira.releaseLifecycle.orderOnly");
  if (tool === "jira_upsert_remote_link") labels.push("chat.jira.linkMutation.upsertHelp");
  if (tool.includes("remote_link")) labels.push("chat.jira.linkMutation.urlsMetadata");
  if (tool === "jira_upsert_remote_link" || tool === "jira_update_remote_link") labels.push("chat.jira.linkMutation.fullReplacement");
  if (tool === "jira_create_issue_link" || tool === "jira_delete_issue_link") labels.push("chat.jira.linkMutation.directionHelp");
  return labels.map((label) => ({ id: t("chat.jira.savedConfiguration.nativeLimitation"), value: literal(t(label)) }));
}
