// Presentation model of the facts a Jira (or MCP) write approval asks the human to approve (#4178).
// The exact arguments of the call are read into named facts - issue, project, issue type, field
// values, labels, links, comment text, transition - and never shown as JSON. A name the page has
// no wording for stays its own (a Jira field id or an MCP argument name); a value it cannot lay out
// is named as not shown by the renderer. The server verifies the action digest, not this model.
import type { OptionalWidgetTranslate, WidgetMessageKey } from "@/lib/optional-widget-i18n";
import { jiraDraftValueOf, type JiraDraftField, type JiraDraftValue } from "./jiraDraftTree";

type Raw = Readonly<Record<string, unknown>>;
type Fact = JiraDraftField;

// Top-level arguments of the managed Jira writes that read better under a plain name.
const ARGUMENT_LABELS: Readonly<Record<string, WidgetMessageKey>> = {
  issueKey: "chat.jira.fact.issue",
  projectId: "chat.jira.fact.project",
  issueTypeId: "chat.jira.fact.issueType",
  transitionId: "chat.jira.fact.transition",
  body: "chat.jira.fact.comment",
  assigneeName: "chat.jira.fact.assignee",
  name: "chat.jira.fact.fileName",
  requirementIds: "chat.jira.fact.requirements",
};

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

/** One argument of a managed Jira write as one or more facts, in request order. */
function jiraFacts(key: string, value: unknown, t: OptionalWidgetTranslate): readonly Fact[] {
  const fieldMap = record(value);
  switch (key) {
    case "fields":
      return fieldMap === undefined
        ? [{ id: key, value: jiraDraftValueOf(value) }]
        : Object.entries(fieldMap).map(([id, field]) => ({ id, value: jiraDraftValueOf(field) }));
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

/**
 * The facts of a write approval. `managed` is a Jira write whose argument names the page knows;
 * any other write (an MCP tool) shows its argument names as the model sent them.
 */
export function jiraActionFacts(
  args: unknown,
  managed: boolean,
  t: OptionalWidgetTranslate,
): readonly Fact[] {
  const raw = record(args);
  if (raw === undefined)
    return [{ id: t("chat.jira.writeApproval.preview"), value: jiraDraftValueOf(args) }];
  return Object.entries(raw).flatMap(([key, value]) =>
    managed ? jiraFacts(key, value, t) : [{ id: key, value: jiraDraftValueOf(value) }],
  );
}
