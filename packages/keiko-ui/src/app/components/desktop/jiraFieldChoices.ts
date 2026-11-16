import type { ChatToolExchange, ChatToolTranscript } from "@oscharko-dev/keiko-contracts/bff-wire";
import type { JiraDraftValue } from "./jiraDraftTree";

type Raw = Readonly<Record<string, unknown>>;
interface Choice {
  readonly identities: readonly string[];
  readonly label: string | undefined;
}
export interface JiraChoices {
  readonly projects: ReadonlyMap<string, string>;
  readonly fields: ReadonlyMap<string, readonly Choice[]>;
}
export interface JiraFieldTarget {
  readonly projectId?: unknown;
  readonly issueTypeId?: unknown;
  readonly issueKey?: unknown;
  readonly transitionId?: unknown;
}
export const NO_JIRA_CHOICES: JiraChoices = { projects: new Map(), fields: new Map() };
const CHOICE_KINDS = new Set(["option", "options", "user", "users"]);
function record(value: unknown): Raw {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Raw) : {};
}
function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
/** Display metadata is bound to the same installation and credential generation as the approval. */
export function jiraNamesBinding(value: unknown): string | undefined {
  const raw = record(value);
  return text(raw.chatId) &&
    text(raw.podId) &&
    Number.isSafeInteger(raw.bindingGeneration) &&
    Number.isSafeInteger(raw.authenticationGeneration)
    ? JSON.stringify([raw.chatId, raw.podId, raw.bindingGeneration, raw.authenticationGeneration])
    : undefined;
}
function transcriptBinding(transcript: ChatToolTranscript): string | undefined {
  const grant = transcript.readGrants?.find((entry) => entry.kind === "jira-chat-read");
  return jiraNamesBinding(grant ?? transcript.readGrant);
}
interface BoundRead {
  readonly exchange: ChatToolExchange;
  readonly binding: string;
}
/** Later turns may retain the existing Jira grant without repeating its disclosure. */
export function jiraBoundReads(
  transcripts: readonly (ChatToolTranscript | undefined)[],
): readonly BoundRead[] {
  const reads: BoundRead[] = [];
  let binding: string | undefined;
  for (const transcript of transcripts) {
    if (transcript === undefined) continue;
    binding = transcriptBinding(transcript) ?? binding;
    if (binding === undefined) continue;
    for (const exchange of transcript.exchanges) reads.push({ exchange, binding });
  }
  return reads;
}
function fieldChoices(value: unknown): readonly Choice[] {
  const field = record(value);
  if (!CHOICE_KINDS.has(String(field.kind)) || !Array.isArray(field.allowedValues)) return [];
  return field.allowedValues.map((entry: unknown) => {
    const raw = record(entry);
    const label = raw.label ?? raw.name;
    return {
      identities: [raw.id, raw.name, raw.accountId, raw.label].filter(text),
      label: text(label) ? label : undefined,
    };
  });
}
function scopeOf(target: JiraFieldTarget): readonly string[] | undefined {
  if (text(target.issueKey))
    return text(target.transitionId)
      ? ["transition", target.issueKey, target.transitionId]
      : ["edit", target.issueKey];
  return text(target.projectId) && text(target.issueTypeId)
    ? ["create", target.projectId, target.issueTypeId]
    : undefined;
}
function metadataFields(
  tool: string,
  args: Raw,
  items: readonly unknown[],
): readonly { readonly scope: readonly string[]; readonly field: unknown }[] {
  if (tool === "jira_transitions" && text(args.issueKey))
    return items.flatMap((item) => {
      const transition = record(item);
      return text(transition.id) && Array.isArray(transition.fields)
        ? transition.fields.map((field: unknown) => ({
            scope: ["transition", args.issueKey as string, transition.id as string],
            field,
          }))
        : [];
    });
  let scope: readonly string[] | undefined;
  if (tool === "jira_create_fields")
    scope = scopeOf({ projectId: args.projectKey, issueTypeId: args.issueTypeId });
  else if (tool === "jira_edit_fields") scope = scopeOf({ issueKey: args.issueKey });
  return scope === undefined ? [] : items.map((field) => ({ scope, field }));
}
function collectProjects(
  items: readonly unknown[],
  binding: string,
  projects: Map<string, string>,
): void {
  for (const item of items) {
    const project = record(item);
    if (text(project.id) && text(project.key))
      projects.set(JSON.stringify([binding, project.id]), project.key);
  }
}
function collectRead(
  { call, result }: ChatToolExchange,
  binding: string,
  projects: Map<string, string>,
  fields: Map<string, readonly Choice[]>,
): void {
  if (result?.status !== "completed") return;
  const data = record(result.data);
  const items: readonly unknown[] = Array.isArray(data.items) ? data.items : [];
  if (call.name === "jira_projects") collectProjects(items, binding, projects);
  for (const { scope, field } of metadataFields(call.name, record(call.arguments), items)) {
    const id = record(field).id;
    if (text(id)) fields.set(JSON.stringify([binding, ...scope, id]), fieldChoices(field));
  }
}
/** Reuses completed metadata reads already retained in the Chat; it never contacts Jira. */
export function jiraChoicesOf(
  transcripts: readonly (ChatToolTranscript | undefined)[],
): JiraChoices {
  const projects = new Map<string, string>();
  const fields = new Map<string, readonly Choice[]>();
  for (const { exchange, binding } of jiraBoundReads(transcripts))
    collectRead(exchange, binding, projects, fields);
  return { projects, fields };
}
function namedValue(value: JiraDraftValue, choices: readonly Choice[]): JiraDraftValue {
  if (value.kind === "list")
    return {
      ...value,
      items: value.items.map((entry) => ({ ...entry, value: namedValue(entry.value, choices) })),
    };
  if (value.kind !== "text") return value;
  const matches = choices.filter((choice) => choice.identities.includes(value.text));
  const label = matches.length === 1 ? matches[0]?.label : undefined;
  // Missing or ambiguous metadata never invents a name or hides which identity was requested.
  return label === undefined || choices.filter((choice) => choice.label === label).length !== 1
    ? value
    : { kind: "text", text: label };
}
export function jiraChoiceValue(
  fieldId: string,
  value: JiraDraftValue,
  target: JiraFieldTarget,
  choices: JiraChoices,
  binding: string | undefined,
): JiraDraftValue {
  if (binding === undefined) return value;
  const project = choices.projects.get(JSON.stringify([binding, target.projectId]));
  const scope = scopeOf({ ...target, projectId: project ?? target.projectId });
  const options =
    scope === undefined
      ? undefined
      : choices.fields.get(JSON.stringify([binding, ...scope, fieldId]));
  return options === undefined ? value : namedValue(value, options);
}
