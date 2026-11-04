import { createContext, useMemo, type ReactNode } from "react";
import type { ChatToolTranscript } from "@oscharko-dev/keiko-contracts/bff-wire";
import type { JiraDraftField } from "./jiraDraftTree";

/** What Jira itself called the ids a proposed action uses, from this Chat's completed reads. */
export interface JiraNames {
  readonly projects: ReadonlyMap<string, string>;
  readonly issueTypes: ReadonlyMap<string, string>;
  readonly fields: ReadonlyMap<string, string>;
}
export const NO_JIRA_NAMES: JiraNames = {
  projects: new Map(),
  issueTypes: new Map(),
  fields: new Map(),
};
export const JiraNamesContext = createContext<JiraNames>(NO_JIRA_NAMES);

type Transcripts = readonly (ChatToolTranscript | undefined)[];
function itemsOf(data: unknown): readonly unknown[] {
  const items = typeof data === "object" && data !== null && "items" in data ? data.items : [];
  return Array.isArray(items) ? (items as readonly unknown[]) : [];
}
function namedEntries(item: unknown): readonly (readonly [string, string])[] {
  const { id, name } = (item ?? {}) as { readonly id?: unknown; readonly name?: unknown };
  return typeof id === "string" && typeof name === "string" ? [[id, name]] : [];
}
function namesOf(transcripts: Transcripts, tool: string): ReadonlyMap<string, string> {
  const reads = transcripts
    .flatMap((entry) => entry?.exchanges ?? [])
    .filter(({ call, result }) => call.name === tool && result?.status === "completed");
  return new Map(
    reads.flatMap(({ result }) => itemsOf(result?.data).flatMap((item) => namedEntries(item))),
  );
}

/** The later read of an id wins, so a renamed project shows its newest name. */
export function jiraNamesOf(transcripts: Transcripts): JiraNames {
  return {
    projects: namesOf(transcripts, "jira_projects"),
    issueTypes: namesOf(transcripts, "jira_issue_types"),
    fields: namesOf(transcripts, "jira_create_fields"),
  };
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

export function jiraNamed(field: JiraDraftField, names: JiraNames): JiraDraftField {
  const label = names.fields.get(field.id);
  return label === undefined ? field : { ...field, label };
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
