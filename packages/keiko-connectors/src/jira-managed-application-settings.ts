import {
  TOOL_CATALOG_LIMITS,
  type CatalogJsonObject,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ManagedMcpToolResult } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { JIRA_READ_TOOL_FAMILIES } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { asRecord } from "./atlassian-sync-classify.js";
import { jiraPropertyKey } from "./jira-entity-property-values.js";
import { boundJiraReadResult } from "./jira-managed-issue-reads.js";
import { jiraReadFailure, localJiraPage } from "./jira-managed-metadata.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import {
  executeJiraSelectedRead,
  selectJiraReadPage,
  type JiraReadPageSelection,
  type JiraReadResponse,
} from "./jira-managed-read-request.js";

export const JIRA_APPLICATION_SETTINGS_READS = JIRA_READ_TOOL_FAMILIES.applicationSettings;
type SettingsRead = (typeof JIRA_APPLICATION_SETTINGS_READS)[number];
type ValueKind = "string" | "boolean" | "integer";
type Projection =
  | { readonly item: CatalogJsonObject }
  | { readonly reason: "malformed-payload" | "bounds-exceeded" };
interface Selection {
  readonly path: string;
  readonly scope: "application-properties" | "advanced-settings" | "current-user-preference";
  readonly mode: "one" | "list" | "preference";
  readonly key?: string;
  readonly permissionLevel?: "ADMIN" | "SYSADMIN";
  readonly page?: JiraReadPageSelection;
}
const PAGE_ARGS = new Set(["startAt", "maxResults"]);
const APPLICATION_ARGS = new Set(["permissionLevel", "startAt", "maxResults"]);
// Exact APKeys / PreferenceKeys constants, not a caller-supplied whitelist or native type hint.
// https://docs.atlassian.com/software/jira/docs/api/11.3.0/constant-values.html
export const JIRA_NONSECRET_APPLICATION_KINDS = Object.freeze({
  "jira.clone.prefix": "string",
  "jira.option.voting": "boolean",
  "jira.option.watching": "boolean",
  "jira.option.timetracking": "boolean",
} as const satisfies Readonly<Record<string, ValueKind>>);
export const JIRA_NONSECRET_PREFERENCE_KINDS = Object.freeze({
  "jira.user.locale": "string",
  "jira.user.timezone": "string",
  "user.notifications.mimetype": "string",
  "user.issues.per.page": "integer",
  "user.keyboard.shortcuts.disabled": "boolean",
  "user.notify.own.changes": "boolean",
} as const satisfies Readonly<Record<string, ValueKind>>);
const VALUE_MAX_CHARS = 4096;
function oneKey(args: CatalogJsonObject): string | undefined {
  return Object.keys(args).length === 1 && jiraPropertyKey(args.key) ? args.key : undefined;
}
function applicationSelection(args: CatalogJsonObject): Selection | undefined {
  if (Object.hasOwn(args, "key")) {
    const key = oneKey(args);
    return key === undefined
      ? undefined
      : {
          path: `application-properties?${new URLSearchParams({ key }).toString()}`,
          scope: "application-properties",
          mode: "one",
          key,
        };
  }
  const page = selectJiraReadPage(args, APPLICATION_ARGS);
  const permissionLevel = args.permissionLevel;
  if (page === undefined || (permissionLevel !== "ADMIN" && permissionLevel !== "SYSADMIN"))
    return undefined;
  return {
    path: `application-properties?${new URLSearchParams({ permissionLevel }).toString()}`,
    scope: "application-properties",
    mode: "list",
    permissionLevel,
    page,
  };
}
function selection(name: SettingsRead, args: CatalogJsonObject): Selection | undefined {
  if (name === "jira.application-properties") return applicationSelection(args);
  if (name === "jira.advanced-settings") {
    const page = selectJiraReadPage(args, PAGE_ARGS);
    return page === undefined
      ? undefined
      : {
          path: "application-properties/advanced-settings",
          scope: "advanced-settings",
          mode: "list",
          page,
        };
  }
  const key = oneKey(args);
  return key === undefined
    ? undefined
    : {
        path: `mypreferences?${new URLSearchParams({ key }).toString()}`,
        scope: "current-user-preference",
        mode: "preference",
        key,
      };
}
function valueKind(key: string, preference: boolean): ValueKind | undefined {
  const kinds: Readonly<Record<string, ValueKind>> = preference
    ? JIRA_NONSECRET_PREFERENCE_KINDS
    : JIRA_NONSECRET_APPLICATION_KINDS;
  return Object.hasOwn(kinds, key) ? kinds[key] : undefined;
}
function integerValue(key: string, value: string): Projection {
  if (!/^(?:0|[1-9]\d*|-[1-9]\d*)$/u.test(value)) return { reason: "malformed-payload" };
  const integer = Number(value);
  if (!Number.isSafeInteger(integer)) return { reason: "bounds-exceeded" };
  return { item: { key, valueState: "observed", valueType: "integer", integerValue: integer } };
}
function observedValue(key: string, value: string, kind: ValueKind): Projection {
  if (kind === "string")
    return { item: { key, valueState: "observed", valueType: kind, stringValue: value } };
  if (kind === "integer") return integerValue(key, value);
  if (value !== "true" && value !== "false") return { reason: "malformed-payload" };
  return { item: { key, valueState: "observed", valueType: kind, booleanValue: value === "true" } };
}
function projectValue(key: string, raw: unknown, kind: ValueKind): Projection {
  if (raw === undefined || raw === null)
    return { item: { key, valueState: "unknown", valueType: kind } };
  if (typeof raw !== "string" || /\p{Surrogate}/u.test(raw)) return { reason: "malformed-payload" };
  if (raw.length > VALUE_MAX_CHARS) return { reason: "bounds-exceeded" };
  return observedValue(key, raw, kind);
}
/** Shared by read and write admission; the key map is fixed and no native value is re-parsed as JSON. */
export function projectJiraPreferenceValue(key: string, raw: unknown): Projection {
  const kind = valueKind(key, true);
  return kind === undefined
    ? { item: { key, valueState: "withheld" } }
    : projectValue(key, raw, kind);
}
/** Exact nonsecret application keys share the existing native-string value semantics. */
export function projectJiraApplicationValue(key: string, raw: unknown): Projection {
  const kind = valueKind(key, false);
  return kind === undefined
    ? { item: { key, valueState: "withheld" } }
    : projectValue(key, raw, kind);
}
function property(value: unknown): Projection {
  const raw = asRecord(value);
  if (raw === undefined || !jiraPropertyKey(raw.key)) return { reason: "malformed-payload" };
  const kind = valueKind(raw.key, false);
  // Unknown values, examples, defaults and allowedValues are deliberately never inspected/copied.
  if (kind === undefined) return { item: { key: raw.key, valueState: "withheld" } };
  return projectValue(raw.key, raw.value, kind);
}
function scopeFields(selected: Selection): CatalogJsonObject {
  return {
    settingsScope: selected.scope,
    ...(selected.permissionLevel === undefined
      ? {}
      : { permissionLevel: selected.permissionLevel }),
  };
}
function singleProperty(response: JiraReadResponse, selected: Selection): ManagedMcpToolResult {
  // The published schema is Property, while its example is an array. A selected key stays singular.
  if (response.items !== undefined && response.items.length !== 1)
    return jiraReadFailure("malformed-payload");
  const projected = property(response.items === undefined ? response.body : response.items[0]);
  if ("reason" in projected) return jiraReadFailure(projected.reason);
  if (projected.item.key !== selected.key) return jiraReadFailure("malformed-payload");
  return boundJiraReadResult({
    data: { outcome: "succeeded", ...scopeFields(selected), ...projected.item },
  });
}
function propertyList(response: JiraReadResponse, selected: Selection): ManagedMcpToolResult {
  const values = response.items;
  if (values === undefined || selected.page === undefined)
    return jiraReadFailure("malformed-payload");
  if (values.length > TOOL_CATALOG_LIMITS.maxArrayItems) return jiraReadFailure("bounds-exceeded");
  const items: CatalogJsonObject[] = [];
  const keys = new Set<string>();
  for (const raw of values) {
    const projected = property(raw);
    if ("reason" in projected) return jiraReadFailure(projected.reason);
    const key = projected.item.key;
    if (typeof key !== "string" || keys.has(key)) return jiraReadFailure("malformed-payload");
    keys.add(key);
    items.push(projected.item);
  }
  const page = localJiraPage(items, selected.page.startAt, selected.page.maxResults);
  return boundJiraReadResult({ ...page, data: { ...page.data, ...scopeFields(selected) } });
}
function preference(response: JiraReadResponse, selected: Selection): ManagedMcpToolResult {
  const key = selected.key;
  if (key === undefined) return jiraReadFailure("malformed-payload");
  const projected = projectJiraPreferenceValue(key, response.scalar);
  if ("reason" in projected) return jiraReadFailure(projected.reason);
  return boundJiraReadResult({
    data: { outcome: "succeeded", ...scopeFields(selected), ...projected.item },
  });
}
function projectResponse(response: JiraReadResponse, selected: Selection): ManagedMcpToolResult {
  if (selected.mode === "one") return singleProperty(response, selected);
  if (selected.mode === "preference") return preference(response, selected);
  return propertyList(response, selected);
}
export function isJiraApplicationSettingsRead(name: string): name is SettingsRead {
  return (JIRA_APPLICATION_SETTINGS_READS as readonly string[]).includes(name);
}
/** Read only; remote permission levels are filter metadata, never authority or proof of editability. */
export function executeJiraApplicationSettingsRead(
  name: SettingsRead,
  args: CatalogJsonObject,
  request: JiraMutationRequest,
): Promise<ManagedMcpToolResult> {
  const selected = selection(name, args);
  let expect: "json-scalar" | "json-object-or-array" | "json-array";
  if (selected?.mode === "preference") {
    expect = "json-scalar";
  } else if (selected?.mode === "one") {
    expect = "json-object-or-array";
  } else {
    expect = "json-array";
  }

  return executeJiraSelectedRead(selected, request, expect, projectResponse);
}
