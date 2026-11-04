import { createContext, useMemo, type ReactNode } from "react";
import type { ChatToolTranscript } from "@oscharko-dev/keiko-contracts/bff-wire";
import type { JiraDraftField } from "./jiraDraftTree";
import {
  jiraBoundReads,
  jiraChoiceValue,
  jiraChoicesOf,
  NO_JIRA_CHOICES,
  type JiraChoices,
  type JiraFieldTarget,
} from "./jiraFieldChoices";

/** What Jira itself called the ids a proposed action uses, from this Chat's completed reads. */
export interface JiraNames {
  readonly projects: ReadonlyMap<string, string>;
  readonly issueTypes: ReadonlyMap<string, string>;
  readonly fields: ReadonlyMap<string, string>;
  readonly choices: JiraChoices;
  readonly binding?: string | undefined;
}
export const NO_JIRA_NAMES: JiraNames = {
  projects: new Map(),
  issueTypes: new Map(),
  fields: new Map(),
  choices: NO_JIRA_CHOICES,
};
export const JiraNamesContext = createContext<JiraNames>(NO_JIRA_NAMES);

type Transcripts = readonly (ChatToolTranscript | undefined)[];
function itemsOf(data: unknown): readonly unknown[] {
  const items = typeof data === "object" && data !== null && "items" in data ? data.items : [];
  return Array.isArray(items) ? (items as readonly unknown[]) : [];
}
function namedEntries(item: unknown, binding: string): readonly (readonly [string, string])[] {
  const { id, name } = (item ?? {}) as { readonly id?: unknown; readonly name?: unknown };
  return typeof id === "string" && typeof name === "string"
    ? [[JSON.stringify([binding, id]), name]]
    : [];
}
function namesOf(
  reads: ReturnType<typeof jiraBoundReads>,
  tool: string,
): ReadonlyMap<string, string> {
  const completed = reads.filter(
    ({ exchange }) => exchange.call.name === tool && exchange.result?.status === "completed",
  );
  return new Map(
    completed.flatMap(({ exchange, binding }) =>
      itemsOf(exchange.result?.data).flatMap((item) => namedEntries(item, binding)),
    ),
  );
}

/** The later read of an id within the same binding wins, including renamed projects. */
export function jiraNamesOf(transcripts: Transcripts): JiraNames {
  const reads = jiraBoundReads(transcripts);
  return {
    projects: namesOf(reads, "jira_projects"),
    issueTypes: namesOf(reads, "jira_issue_types"),
    fields: namesOf(reads, "jira_create_fields"),
    choices: jiraChoicesOf(transcripts),
  };
}

export function jiraNameOf(
  names: JiraNames,
  kind: "projects" | "issueTypes" | "fields",
  id: string,
): string | undefined {
  return names.binding === undefined
    ? undefined
    : names[kind].get(JSON.stringify([names.binding, id]));
}

/** Every card of a Chat reads the names of the whole Chat, because a later turn may not read them. */
export function ChatJiraNames({
  messages,
  children,
}: {
  readonly messages: readonly { readonly toolTranscript?: ChatToolTranscript | undefined }[];
  readonly children: ReactNode;
}): ReactNode {
  const names = useMemo(
    () => jiraNamesOf(messages.map((message) => message.toolTranscript)),
    [messages],
  );
  return <JiraNamesContext.Provider value={names}>{children}</JiraNamesContext.Provider>;
}

export function jiraNamed(
  field: JiraDraftField,
  names: JiraNames,
  target: JiraFieldTarget = {},
): JiraDraftField {
  const label = jiraNameOf(names, "fields", field.id);
  return {
    ...field,
    ...(label === undefined ? {} : { label }),
    value: jiraChoiceValue(field.id, field.value, target, names.choices, names.binding),
  };
}

/**
 * The target is already named on the item. Only a field that says the same is left out: one that
 * names another project or issue type stays visible, so the human sees the contradiction.
 */
export function restatesTarget(
  field: JiraDraftField,
  projectId: string,
  issueTypeId: string,
): boolean {
  if (field.value.kind !== "text") return false;
  return (
    (field.id === "project" && field.value.text === projectId) ||
    (field.id === "issuetype" && field.value.text === issueTypeId)
  );
}
