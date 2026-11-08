import { isSafeAtlassianIdentifier } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { TOOL_CATALOG_LIMITS, type CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { asRecord } from "./atlassian-sync-classify.js";
import { jiraScreenFieldProjection, jiraScreenTabProjection } from "./jira-managed-screen-reads.js";
import { jiraNativeId, jiraNativeText } from "./jira-native-values.js";
import type { JiraScreenTabSelection } from "./jira-screen-tab-admission.js";

export const JIRA_SCREEN_CONFIGURATION_MUTATIONS = [
  "jira.add-default-screen-field", "jira.add-screen-tab-field", "jira.remove-screen-tab-field",
  "jira.move-screen-tab-field", "jira.set-screen-field-show-when-empty", "jira.move-screen-tab",
] as const;
export type JiraScreenConfigurationMutation = (typeof JIRA_SCREEN_CONFIGURATION_MUTATIONS)[number];
export interface ScreenTabSnapshot { readonly id: string; readonly name: string }
export interface ScreenFieldSnapshot extends ScreenTabSnapshot {
  readonly type: string | null;
  readonly showWhenEmpty: boolean | null;
}
interface SelectedTab extends JiraScreenTabSelection {
  readonly tabId: string;
  readonly expectedTabs: readonly ScreenTabSnapshot[];
}
interface SelectedField extends SelectedTab {
  readonly fieldId: string;
  readonly expectedFields: readonly ScreenFieldSnapshot[];
}
interface DefaultScreenFieldInput {
  readonly kind: "default";
  readonly fieldId: string;
  readonly expectedFieldName: string;
}
interface AddScreenFieldInput extends SelectedField {
  readonly kind: "add";
  readonly expectedFieldName: string;
}
interface RemoveScreenFieldInput extends SelectedField { readonly kind: "remove" }
interface MoveScreenFieldInput extends SelectedField {
  readonly kind: "field-move";
  readonly desiredFieldIds: readonly string[];
  readonly body: CatalogJsonObject;
}
interface ShowScreenFieldInput extends SelectedField {
  readonly kind: "show";
  readonly showWhenEmpty: boolean;
}
interface MoveScreenTabInput extends SelectedTab {
  readonly kind: "tab-move";
  readonly position: number;
  readonly desiredTabIds: readonly string[];
}
export type ScopedScreenConfigurationInput = AddScreenFieldInput | RemoveScreenFieldInput | MoveScreenFieldInput | ShowScreenFieldInput | MoveScreenTabInput;
export type ScreenConfigurationInput = DefaultScreenFieldInput | ScopedScreenConfigurationInput;

const COMMON = ["screenId", "expectedScreenName", "tabId", "expectedTabs"];
const FIELD = [...COMMON, "fieldId", "expectedFields"];
const ALLOWED: Readonly<Record<JiraScreenConfigurationMutation, ReadonlySet<string>>> = {
  "jira.add-default-screen-field": new Set(["fieldId", "expectedFieldName", "acceptUnverifiedDefault"]),
  "jira.add-screen-tab-field": new Set([...FIELD, "expectedFieldName"]),
  "jira.remove-screen-tab-field": new Set(FIELD),
  "jira.move-screen-tab-field": new Set([...FIELD, "position"]),
  "jira.set-screen-field-show-when-empty": new Set([...FIELD, "showWhenEmpty"]),
  "jira.move-screen-tab": new Set([...COMMON, "position"]),
};
const POSITIONS = new Set(["First", "Last", "Earlier", "Later"]);
function exactOwnFields(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
function tabSnapshot(value: unknown): ScreenTabSnapshot | undefined {
  const raw = asRecord(value);
  if (raw === undefined || !exactOwnFields(raw, ["id", "name"]) || !jiraNativeId(raw.id)) return undefined;
  const projected = jiraScreenTabProjection(raw);
  return projected === undefined || typeof projected.name !== "string" ? undefined : { id: raw.id, name: projected.name };
}
export function screenFieldSnapshot(value: unknown): ScreenFieldSnapshot | undefined {
  const projected = jiraScreenFieldProjection(value);
  if (projected === undefined || typeof projected.id !== "string" || typeof projected.name !== "string") return undefined;
  return { id: projected.id, name: projected.name,
    type: typeof projected.type === "string" ? projected.type : null,
    showWhenEmpty: typeof projected.showWhenEmpty === "boolean" ? projected.showWhenEmpty : null };
}
function reviewedField(value: unknown): ScreenFieldSnapshot | undefined {
  const raw = asRecord(value);
  return raw === undefined || !exactOwnFields(raw, ["id", "name", "type", "showWhenEmpty"])
    ? undefined : screenFieldSnapshot(raw);
}
function snapshotRows<T extends { readonly id: string }>(value: unknown, project: (raw: unknown) => T | undefined): readonly T[] | undefined {
  if (!Array.isArray(value) || value.length > TOOL_CATALOG_LIMITS.maxArrayItems) return undefined;
  const rows = Array.from(value, project);
  return rows.every((row): row is T => row !== undefined) && new Set(rows.map((row) => row.id)).size === rows.length
    ? rows : undefined;
}
function selectedTab(args: CatalogJsonObject): SelectedTab | undefined {
  if (!jiraNativeId(args.screenId) || !jiraNativeId(args.tabId) || !jiraNativeText(args.expectedScreenName, 255)) return undefined;
  const expectedTabs = snapshotRows(args.expectedTabs, tabSnapshot);
  return expectedTabs === undefined || !expectedTabs.some((tab) => tab.id === args.tabId) ? undefined
    : { screenId: args.screenId, expectedScreenName: args.expectedScreenName, tabId: args.tabId, expectedTabs };
}
function selectedField(args: CatalogJsonObject, tab: SelectedTab): SelectedField | undefined {
  if (!isSafeAtlassianIdentifier(args.fieldId)) return undefined;
  const expectedFields = snapshotRows(args.expectedFields, reviewedField);
  return expectedFields === undefined ? undefined : { ...tab, fieldId: args.fieldId, expectedFields };
}
function movedIds(ids: readonly string[], id: string, position: number): readonly string[] {
  const moved = ids.filter((entry) => entry !== id);
  moved.splice(position, 0, id);
  return moved;
}
function moveTab(args: CatalogJsonObject, tab: SelectedTab): MoveScreenTabInput | undefined {
  const position = args.position;
  if (typeof position !== "number" || !Number.isInteger(position) || position < 0 || position >= tab.expectedTabs.length) return undefined;
  return { ...tab, kind: "tab-move", position,
    desiredTabIds: movedIds(tab.expectedTabs.map((row) => row.id), tab.tabId, position) };
}
function relativePosition(position: string, index: number, length: number): number {
  switch (position) {
    case "First": return 0;
    case "Last": return length - 1;
    case "Earlier": return Math.max(0, index - 1);
    default: return Math.min(length - 1, index + 1);
  }
}
function movedField(args: CatalogJsonObject, field: SelectedField): MoveScreenFieldInput | undefined {
  const ids = field.expectedFields.map((row) => row.id);
  if (typeof args.position !== "string" || !POSITIONS.has(args.position)) return undefined;
  const index = relativePosition(args.position, ids.indexOf(field.fieldId), ids.length);
  return { ...field, kind: "field-move", body: { position: args.position }, desiredFieldIds: movedIds(ids, field.fieldId, index) };
}
function fieldInput(name: JiraScreenConfigurationMutation, args: CatalogJsonObject, field: SelectedField): ScopedScreenConfigurationInput | undefined {
  const present = field.expectedFields.some((row) => row.id === field.fieldId);
  if (name === "jira.add-screen-tab-field") return !present && jiraNativeText(args.expectedFieldName, 255)
    ? { ...field, kind: "add", expectedFieldName: args.expectedFieldName } : undefined;
  if (!present) return undefined;
  if (name === "jira.remove-screen-tab-field") return { ...field, kind: "remove" };
  if (name === "jira.set-screen-field-show-when-empty") return typeof args.showWhenEmpty === "boolean"
    ? { ...field, kind: "show", showWhenEmpty: args.showWhenEmpty } : undefined;
  return movedField(args, field);
}
/** Reviewed values remain distinct from unknown metadata; no number conversion of native IDs. */
export function screenConfigurationInput(name: JiraScreenConfigurationMutation, args: CatalogJsonObject): ScreenConfigurationInput | undefined {
  if (Object.keys(args).some((key) => !ALLOWED[name].has(key))) return undefined;
  if (name === "jira.add-default-screen-field") return isSafeAtlassianIdentifier(args.fieldId) &&
    jiraNativeText(args.expectedFieldName, 255) && args.acceptUnverifiedDefault === true
    ? { kind: "default", fieldId: args.fieldId, expectedFieldName: args.expectedFieldName } : undefined;
  const tab = selectedTab(args);
  if (tab === undefined) return undefined;
  if (name === "jira.move-screen-tab") return moveTab(args, tab);
  const field = selectedField(args, tab);
  return field === undefined ? undefined : fieldInput(name, args, field);
}
