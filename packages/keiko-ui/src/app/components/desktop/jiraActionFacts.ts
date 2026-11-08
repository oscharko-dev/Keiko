// Presentation model of the facts a Jira (or MCP) write approval asks the human to approve (#4178).
// The exact arguments of the call are read into named facts - issue, project, issue type, field
// values, labels, links, comment text, transition - and never shown as JSON. A name the page has
// no wording for stays its own (a Jira field id or an MCP argument name); a value it cannot lay out
// is flattened into dotted-path rows by the renderer, so no leaf goes unseen. The server verifies
// the action digest, not this model.
import type { OptionalWidgetTranslate, WidgetMessageKey } from "@/lib/optional-widget-i18n";
import {
  jiraDraftValueOf,
  jiraDraftFieldValueOf,
  type JiraDraftField,
  type JiraDraftValue,
} from "./jiraDraftTree";
import { jiraNamed, jiraNameOf, NO_JIRA_NAMES, restatesTarget, type JiraNames } from "./jiraNames";
import { jiraAgileArgumentLabel } from "./jira-agile-presentation";
import { jiraProjectMetadataArgumentLabel } from "./jira-project-metadata-presentation";
import { jiraScreenTabArgumentLabel } from "./jira-administration-presentation";
import { jiraMonitoringArgumentLabel, jiraMonitoringFixedTarget } from "./jira-monitoring-presentation";
import { jiraPropertyMutationFacts } from "./jira-property-mutation-presentation";
import { jiraSavedConfigurationFacts, jiraSavedConfigurationContextFacts } from "./jira-saved-configuration-approval";
import { jiraStructuralMutationFacts, jiraStructuralMutationContextFacts } from "./jira-structural-mutation-approval";

type Raw = Readonly<Record<string, unknown>>;
type Fact = JiraDraftField;

// Top-level arguments of the managed Jira writes that read better under a plain name.
const ARGUMENT_LABELS: Readonly<Record<string, WidgetMessageKey>> = {
  issueKey: "chat.jira.fact.issue",
  projectId: "chat.jira.fact.project",
  issueTypeId: "chat.jira.fact.issueType",
  transitionId: "chat.jira.fact.transition",
  body: "chat.jira.fact.comment",
  commentId: "chat.jira.fact.commentId",
  assigneeName: "chat.jira.fact.assignee",
  name: "chat.jira.fact.fileName",
  requirementIds: "chat.jira.fact.requirements",
};
const PROJECT_ARGUMENT_LABELS: Readonly<Record<string, WidgetMessageKey>> = {
  key: "chat.jira.fact.projectKey",
  projectIdOrKey: "chat.jira.fact.projectIdOrKey",
  name: "chat.jira.fact.projectName",
  lead: "chat.jira.fact.projectLead",
  projectTypeKey: "chat.jira.fact.projectType",
  projectTemplateKey: "chat.jira.fact.projectTemplate",
  description: "chat.jira.fact.projectDescription",
  url: "chat.jira.fact.projectWebsite",
  assigneeType: "chat.jira.fact.projectAssignee",
};

const WORKLOG_ARGUMENT_LABELS: Readonly<Record<string, WidgetMessageKey>> = {
  worklogId: "chat.jira.fact.worklogId",
  timeSpentSeconds: "chat.jira.fact.timeSpentSeconds",
  started: "chat.jira.fact.workStarted",
  comment: "chat.jira.fact.worklogComment",
};
const DELETE_OPERATIONS = new Set([
  "jira.delete-comment",
  "jira.delete-attachment",
  "jira.delete-worklog",
]);
const DELETE_ARGUMENT_LABELS: Readonly<Record<string, WidgetMessageKey>> = {
  expectedBody: "chat.jira.fact.reviewedComment",
  attachmentId: "chat.jira.fact.attachmentId",
  filename: "chat.jira.fact.fileName",
  size: "chat.jira.fact.sizeBytes",
};
function deletionFacts(
  operation: string | undefined,
  key: string,
  value: unknown,
  t: OptionalWidgetTranslate,
): readonly Fact[] | undefined {
  if (operation === undefined || !DELETE_OPERATIONS.has(operation)) return undefined;
  if (key === "expectedVisibility" || key === "visibility")
    return operation === "jira.delete-worklog" && value === null
      ? unrestrictedVisibility(t)
      : worklogVisibility(value, t);
  const label = DELETE_ARGUMENT_LABELS[key] ?? WORKLOG_ARGUMENT_LABELS[key];
  if (label === undefined) return undefined;
  return [
    {
      id: t(label),
      value:
        value === "" ? textValue(t("chat.jira.fact.reviewedEmptyText")) : jiraDraftValueOf(value),
    },
  ];
}
function unrestrictedVisibility(t: OptionalWidgetTranslate): readonly Fact[] {
  return [
    {
      id: t("chat.jira.fact.visibility"),
      value: textValue(t("chat.jira.fact.unrestrictedVisibility")),
    },
  ];
}
function deletionContextFacts(
  raw: Raw,
  operation: string | undefined,
  t: OptionalWidgetTranslate,
): readonly Fact[] {
  if (operation === "jira.delete-comment" && !Object.hasOwn(raw, "expectedVisibility"))
    return unrestrictedVisibility(t);
  return operation === "jira.delete-worklog"
    ? [
        {
          id: t("chat.jira.fact.remainingEstimate"),
          value: textValue(t("chat.jira.fact.preserveRemainingEstimate")),
        },
      ]
    : [];
}
function worklogFacts(
  key: string,
  value: unknown,
  t: OptionalWidgetTranslate,
  clearComment: boolean,
): readonly Fact[] | undefined {
  if (clearComment && key === "comment" && value === "")
    return [
      {
        id: t("chat.jira.fact.worklogComment"),
        value: textValue(t("chat.jira.fact.clearWorklogComment")),
      },
    ];
  const label = WORKLOG_ARGUMENT_LABELS[key];
  if (label !== undefined) return [{ id: t(label), value: jiraDraftValueOf(value) }];
  return key === "visibility" ? worklogVisibility(value, t) : undefined;
}
function worklogVisibility(
  value: unknown,
  t: OptionalWidgetTranslate,
): readonly Fact[] | undefined {
  const visibility = record(value);
  if (
    visibility === undefined ||
    typeof visibility.value !== "string" ||
    (visibility.type !== "group" && visibility.type !== "role") ||
    Object.keys(visibility).length !== 2
  )
    return undefined;
  return [
    {
      id: t(
        visibility.type === "group"
          ? "chat.jira.fact.visibleToGroup"
          : "chat.jira.fact.visibleToRole",
      ),
      value: textValue(visibility.value),
    },
  ];
}
function record(value: unknown): Raw | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Raw)
    : undefined;
}
function textValue(text: string): JiraDraftValue {
  return { kind: "text", text };
}
function listOf(values: readonly JiraDraftValue[]): JiraDraftValue {
  return {
    kind: "list",
    items: values.map((value, index) => ({ position: index + 1, value })),
  };
}
function sentence(
  t: OptionalWidgetTranslate,
  key: WidgetMessageKey,
  values: Readonly<Record<string, string>>,
): JiraDraftValue {
  return textValue(t(key, values));
}

function linkValue(link: unknown, t: OptionalWidgetTranslate): JiraDraftValue {
  const raw = record(link);
  const type = raw?.type;
  const target = raw?.issueKey;
  if (typeof type !== "string" || typeof target !== "string" || raw === undefined)
    return jiraDraftValueOf(link);
  return sentence(
    t,
    raw.direction === "inward" ? "chat.jira.draft.linkInward" : "chat.jira.draft.linkOutward",
    { type, target },
  );
}
function updateValue(update: unknown, t: OptionalWidgetTranslate): JiraDraftValue {
  const raw = record(update);
  const fieldId = raw?.fieldId;
  const value = raw?.value;
  const operation = raw?.operation;
  if (typeof fieldId !== "string" || typeof value !== "string") return jiraDraftValueOf(update);
  return sentence(
    t,
    operation === "remove" ? "chat.jira.fact.updateRemove" : "chat.jira.fact.updateAdd",
    { fieldId, value },
  );
}
function listFact(
  label: WidgetMessageKey,
  entries: unknown,
  describe: (entry: unknown) => JiraDraftValue,
  t: OptionalWidgetTranslate,
): Fact {
  return Array.isArray(entries) && entries.length > 0
    ? { id: t(label), value: listOf(entries.map(describe)) }
    : { id: t(label), value: jiraDraftValueOf(entries) };
}

function sourceValue(source: unknown): JiraDraftValue {
  const path = record(source)?.path;
  return typeof path === "string" ? textValue(path) : jiraDraftValueOf(source);
}
function screenTabFacts(operation: string | undefined, key: string, value: unknown, t: OptionalWidgetTranslate): readonly Fact[] | undefined {
  const label = jiraScreenTabArgumentLabel(operation, key);
  if (label === undefined) return undefined;
  if (key !== "expectedFieldIds") return [{ id: t(label), value: jiraDraftValueOf(value) }];
  return [{ id: t(label), value: Array.isArray(value) && value.length === 0
    ? textValue(t("chat.jira.screenTabs.reviewedEmptyFields")) : Array.isArray(value)
      ? listOf(value.map((entry: unknown) => jiraDraftValueOf(entry))) : jiraDraftValueOf(value) }];
}
function monitoringFacts(operation: string | undefined, key: string, value: unknown, t: OptionalWidgetTranslate): readonly Fact[] | undefined {
  const label = jiraMonitoringArgumentLabel(operation, key);
  if (label === undefined) return undefined;
  return [{ id: t(label), value: typeof value === "boolean"
    ? textValue(t(value ? "chat.jira.monitoring.enabled" : "chat.jira.monitoring.disabled")) : jiraDraftValueOf(value) }];
}
function monitoringContextFacts(operation: string | undefined, t: OptionalWidgetTranslate): readonly Fact[] {
  if (jiraMonitoringArgumentLabel(operation, "expectedEnabled") === undefined) return [];
  const target = jiraMonitoringFixedTarget(operation);
  const targetFacts: readonly Fact[] = target === undefined ? [] : [{ id: t("chat.jira.monitoring.requestedState"),
    value: textValue(t(target ? "chat.jira.monitoring.enabled" : "chat.jira.monitoring.disabled")) }];
  return [...targetFacts, { id: t("chat.jira.monitoring.scope"), value: textValue(t("chat.jira.monitoring.instanceScope")) }];
}

/** One argument of a managed Jira write as one or more facts, in request order. */
function jiraFacts(key: string, value: unknown, t: OptionalWidgetTranslate): readonly Fact[] {
  const fieldMap = record(value);
  switch (key) {
    case "fields":
      return fieldMap === undefined
        ? [{ id: key, value: jiraDraftValueOf(value) }]
        : Object.entries(fieldMap).map(([id, field]) => ({
            id,
            value: jiraDraftFieldValueOf(id, field),
          }));
    case "links":
      return [listFact("chat.jira.fact.links", value, (entry) => linkValue(entry, t), t)];
    case "updates":
      return [listFact("chat.jira.fact.updates", value, (entry) => updateValue(entry, t), t)];
    case "source":
      return [{ id: t("chat.jira.fact.file"), value: sourceValue(value) }];
    case "clearAssignee":
      return [
        {
          id: t("chat.jira.fact.assignee"),
          value:
            value === true
              ? textValue(t("chat.jira.fact.assigneeCleared"))
              : jiraDraftValueOf(value),
        },
      ];
    default: {
      const label = ARGUMENT_LABELS[key];
      return [{ id: label === undefined ? key : t(label), value: jiraDraftValueOf(value) }];
    }
  }
}

function operationFacts(operation: string | undefined, key: string, value: unknown, t: OptionalWidgetTranslate): readonly Fact[] | undefined {
  return deletionFacts(operation, key, value, t) ??
    jiraPropertyMutationFacts(operation, key, value, t) ??
    jiraSavedConfigurationFacts(operation, key, value, t) ??
    jiraStructuralMutationFacts(operation, key, value, t) ??
    screenTabFacts(operation, key, value, t) ?? monitoringFacts(operation, key, value, t);
}
/**
 * The facts of a write approval. `managed` is a Jira write whose argument names the page knows;
 * any other write (an MCP tool) shows its argument names as the model sent them.
 */
export function jiraActionFacts(
  args: unknown,
  managed: boolean,
  t: OptionalWidgetTranslate,
  names: JiraNames = NO_JIRA_NAMES,
  operation?: string,
): readonly Fact[] {
  const raw = record(args);
  if (raw === undefined)
    return [{ id: t("chat.jira.writeApproval.preview"), value: jiraDraftValueOf(args) }];
  const project = operation === "jira.create-project" || operation === "jira.update-project";
  const worklog = operation === "jira.create-worklog" || operation === "jira.update-worklog";
  const facts = Object.entries(raw).flatMap(([key, value]) => {
    if (!managed) return [{ id: key, value: jiraDraftValueOf(value) }];
    const specificPreview = operationFacts(operation, key, value, t);
    if (specificPreview !== undefined) return specificPreview;
    const worklogPreview = worklog
      ? worklogFacts(key, value, t, operation === "jira.update-worklog")
      : undefined;
    if (worklogPreview !== undefined) return worklogPreview;
    const label = project
      ? PROJECT_ARGUMENT_LABELS[key]
      : (jiraAgileArgumentLabel(operation, key) ??
        jiraProjectMetadataArgumentLabel(operation, key));
    return label === undefined
      ? managedFacts(key, value, raw, t, names)
      : [{ id: t(label), value: jiraDraftValueOf(value) }];
  });
  return managed ? [...facts, ...deletionContextFacts(raw, operation, t), ...monitoringContextFacts(operation, t),
    ...jiraSavedConfigurationContextFacts(operation, raw, t), ...jiraStructuralMutationContextFacts(operation, t)] : facts;
}
/** Jira's own names where this turn read them; a field that repeats the target is said once. */
function managedFacts(
  key: string,
  value: unknown,
  raw: Raw,
  t: OptionalWidgetTranslate,
  names: JiraNames,
): readonly Fact[] {
  const family = key === "projectId" ? "projects" : "issueTypes";
  const known =
    (key === "projectId" || key === "issueTypeId") && typeof value === "string"
      ? jiraNameOf(names, family, value)
      : undefined;
  return jiraFacts(key, known ?? value, t)
    .filter(
      (fact) =>
        key !== "fields" ||
        !restatesTarget(fact, stringOf(raw.projectId), stringOf(raw.issueTypeId)),
    )
    .map((fact) => (key === "fields" ? jiraNamed(fact, names, raw) : fact));
}
function stringOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}
