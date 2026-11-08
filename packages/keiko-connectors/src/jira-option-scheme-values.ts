import { schemeDefault, schemeIds, type SchemeKind, type SchemeSnapshot } from "./jira-option-scheme-review.js";
export type { SchemeKind, SchemeSnapshot } from "./jira-option-scheme-review.js";
import { JIRA_OPTION_SCHEME_MUTATIONS, isSafeAtlassianIdentifier, type JiraOptionSchemeMutation, type JiraMutationAttempt, type JiraMutationReceipt } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { asRecord } from "./atlassian-sync-classify.js";
import { jiraNativeId } from "./jira-native-values.js";
import { savedExactKeys, savedName, savedText } from "./jira-saved-configuration-values.js";

export { JIRA_OPTION_SCHEME_MUTATIONS };
export type { JiraOptionSchemeMutation };
export const JIRA_SCHEME_PROJECTS_MAX = 50;
export type SchemeProject = { readonly id: string; readonly key: string; readonly name: string };
export type SchemeTarget = { readonly name: string; readonly description: string; readonly ids: readonly string[]; readonly defaultId: string };
export interface SchemeReceipt extends JiraMutationReceipt {
  readonly schemeId?: string;
  readonly schemePresent?: boolean;
  readonly projectIds?: readonly string[];
  readonly projectKeys?: readonly string[];
  readonly associationChange?: "add" | "replace" | "clear" | "remove";
}
export type SchemeFailure = Omit<Extract<JiraMutationAttempt, { ok: false }>, "receipt"> & { readonly receipt?: SchemeReceipt };
export type SchemeAttempt = SchemeFailure | { readonly ok: true; readonly receipt: SchemeReceipt };
export type SchemeObservation<T> = SchemeFailure | { readonly ok: true; readonly value: T };
export interface SchemeSelection {
  readonly operation: JiraOptionSchemeMutation;
  readonly kind: SchemeKind;
  readonly actor: string;
  readonly expected?: SchemeSnapshot;
  readonly target?: SchemeTarget;
  readonly expectedProjects?: readonly SchemeProject[];
  readonly projects?: readonly SchemeProject[];
  readonly change?: "add" | "replace" | "clear" | "remove";
}
export const SCHEME_MALFORMED: SchemeFailure = { ok: false, reason: "malformed-payload" };
export function schemeRefusal(message: string, reason: "field-validation" | "conflict" | "unavailable" = "field-validation", receipt?: SchemeReceipt): SchemeFailure {
  return { ok: false, reason, detail: { messages: [message] }, ...(receipt === undefined ? {} : { receipt }) };
}
export function sameSchemeIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => right[index] === id);
}
function keys(kind: SchemeKind): { readonly ids: string; readonly defaultId: string } {
  return kind === "issue-type" ? { ids: "issueTypeIds", defaultId: "defaultIssueTypeId" }
    : { ids: "optionIds", defaultId: "defaultOptionId" };
}
function target(raw: CatalogJsonObject, kind: SchemeKind): SchemeTarget | undefined {
  const fields = keys(kind); const ids = schemeIds(raw[fields.ids]); const defaultId = raw[fields.defaultId];
  return !savedName(raw.name) || !savedText(raw.description, 32768, true) || ids === undefined || !jiraNativeId(defaultId) || !ids.includes(defaultId)
    ? undefined : { name: raw.name, description: raw.description, ids, defaultId };
}
function snapshotMetadata(raw: Record<string, unknown>): Pick<SchemeSnapshot, "id" | "name" | "description"> | undefined {
  if (!jiraNativeId(raw.id) || !savedName(raw.name)) return undefined;
  return raw.description === null || savedText(raw.description, 32768, true)
    ? { id: raw.id, name: raw.name, description: raw.description } : undefined;
}
function snapshot(value: unknown, kind: SchemeKind): SchemeSnapshot | undefined {
  const raw = asRecord(value); const fields = keys(kind);
  const allowed = new Set(["id", "name", "description", fields.ids, fields.defaultId, ...(kind === "priority" ? ["defaultScheme"] : [])]);
  if (raw === undefined || !savedExactKeys(raw, allowed)) return undefined;
  const metadata = snapshotMetadata(raw); const ids = schemeIds(raw[fields.ids]); const defaultId = raw[fields.defaultId];
  if (metadata === undefined || ids === undefined || !schemeDefault(defaultId, ids)) return undefined;
  if (kind === "priority" && typeof raw.defaultScheme !== "boolean") return undefined;
  return { ...metadata, ids, defaultId, ...(typeof raw.defaultScheme === "boolean" ? { defaultScheme: raw.defaultScheme } : {}) };
}
const PROJECT_FIELDS = new Set(["id", "key", "name"]);
function schemeProject(value: unknown): SchemeProject | undefined {
  const raw = asRecord(value);
  return raw === undefined || !savedExactKeys(raw, PROJECT_FIELDS) || !jiraNativeId(raw.id) || !isSafeAtlassianIdentifier(raw.key) || !savedName(raw.name)
    ? undefined : { id: raw.id, key: raw.key, name: raw.name };
}
export function schemeProjects(value: unknown): readonly SchemeProject[] | undefined {
  if (!Array.isArray(value) || value.length > JIRA_SCHEME_PROJECTS_MAX) return undefined;
  const result: SchemeProject[] = []; const ids = new Set<string>(); const names = new Set<string>();
  for (const item of value) {
    const project = schemeProject(item);
    if (project === undefined || ids.has(project.id) || names.has(project.key.toUpperCase())) return undefined;
    ids.add(project.id); names.add(project.key.toUpperCase()); result.push(project);
  }
  return result;
}
function associationChange(operation: JiraOptionSchemeMutation): SchemeSelection["change"] {
  switch (operation) {
    case "jira.add-issue-type-scheme-projects": return "add";
    case "jira.set-issue-type-scheme-projects": return "replace";
    case "jira.clear-issue-type-scheme-projects": return "clear";
    case "jira.remove-issue-type-scheme-project": return "remove";
    default: return undefined;
  }
}
function allowedKeys(operation: JiraOptionSchemeMutation, kind: SchemeKind): ReadonlySet<string> {
  const fields = keys(kind);
  if (operation.startsWith("jira.create-")) return new Set(["expectedActorKey", "name", "description", fields.ids, fields.defaultId]);
  const common = ["expectedActorKey", "expectedScheme"];
  if (operation.startsWith("jira.update-")) return new Set([...common, "name", "description", fields.ids, fields.defaultId]);
  if (operation.startsWith("jira.delete-")) return new Set([...common, "confirmUnverifiedConsequences"]);
  return new Set([...common, "expectedProjects", "projects", "confirmUnverifiedConsequences"]);
}
function association(raw: CatalogJsonObject, base: SchemeSelection): SchemeSelection | undefined {
  const expectedProjects = schemeProjects(raw.expectedProjects);
  const projects = schemeProjects(raw.projects);
  if (expectedProjects === undefined || projects === undefined || raw.confirmUnverifiedConsequences !== true) return undefined;
  if (base.change === "add" && projects.length === 0) return undefined;
  if (base.change === "add" && new Set([...expectedProjects, ...projects].map((project) => project.id)).size > JIRA_SCHEME_PROJECTS_MAX) return undefined;
  if (base.change === "clear" && projects.length !== 0) return undefined;
  if (base.change === "remove" && projects.length !== 1) return undefined;
  return { ...base, expectedProjects, projects };
}
export function isJiraOptionSchemeMutation(value: string): value is JiraOptionSchemeMutation {
  return JIRA_OPTION_SCHEME_MUTATIONS.some((operation) => operation === value);
}
function withTarget(args: CatalogJsonObject, base: SchemeSelection): SchemeSelection | undefined {
  const desired = target(args, base.kind);
  return desired === undefined ? undefined : { ...base, target: desired };
}
function existingSelection(args: CatalogJsonObject, common: SchemeSelection): SchemeSelection | undefined {
  const expected = snapshot(args.expectedScheme, common.kind);
  if (expected === undefined) return undefined;
  const base = { ...common, expected };
  if (common.operation.startsWith("jira.update-")) return withTarget(args, base);
  if (common.operation.startsWith("jira.delete-")) return args.confirmUnverifiedConsequences === true ? base : undefined;
  const change = associationChange(common.operation);
  return change === undefined ? undefined : association(args, { ...base, change });
}
export function parseSchemeMutation(operation: string, args: CatalogJsonObject): SchemeSelection | undefined {
  if (!isJiraOptionSchemeMutation(operation)) return undefined;
  const kind = operation.includes("priority") ? "priority" : "issue-type";
  if (!savedExactKeys(args, allowedKeys(operation, kind)) || !savedText(args.expectedActorKey, 255)) return undefined;
  const common = { operation, kind, actor: args.expectedActorKey } as const;
  return operation.startsWith("jira.create-") ? withTarget(args, common) : existingSelection(args, common);
}
export function sameScheme(left: SchemeSnapshot, right: SchemeSnapshot): boolean {
  return left.id === right.id && left.name === right.name && left.description === right.description &&
    left.defaultId === right.defaultId && left.defaultScheme === right.defaultScheme && sameSchemeIds(left.ids, right.ids);
}
export function sameSchemeProjects(left: readonly SchemeProject[], right: readonly SchemeProject[]): boolean {
  return left.length === right.length && left.every((project) => right.some((other) =>
    project.id === other.id && project.key === other.key && project.name === other.name));
}
export function schemePath(kind: SchemeKind): "issuetypescheme" | "priorityschemes" {
  return kind === "issue-type" ? "issuetypescheme" : "priorityschemes";
}
