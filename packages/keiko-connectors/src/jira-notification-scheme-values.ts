import {
  isSafeAtlassianIdentifier,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import {
  TOOL_CATALOG_LIMITS,
  type CatalogJsonObject,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { asRecord } from "./atlassian-sync-classify.js";
import { projectJiraCollection } from "./jira-managed-metadata.js";
import { jiraNativeNumericId, jiraNativeText } from "./jira-native-values.js";

// The retained 11.3 NotificationType enum and notification REST DTOs own these wire names.
const RECIPIENT_TYPES: ReadonlySet<string> = new Set([
  "CurrentAssignee", "Reporter", "CurrentUser", "ProjectLead", "ComponentLead",
  "AllWatchers", "User", "Group", "EmailAddress", "UserCustomField",
  "GroupCustomField", "ProjectRole",
]);
const MAX = TOOL_CATALOG_LIMITS.maxArrayItems;

function optionalText(
  raw: Record<string, unknown>,
  fields: Readonly<Record<string, number>>,
): CatalogJsonObject | undefined {
  const result: Record<string, string> = {};
  for (const [key, max] of Object.entries(fields)) {
    const value = raw[key];
    if (value === undefined || value === null) continue;
    if (!jiraNativeText(value, max, true)) return undefined;
    result[key] = value;
  }
  return result;
}

type IdentityKind = "user" | "group" | "projectRole" | "field";
const EXPANDED_FIELDS: Readonly<Record<string, IdentityKind>> = {
  User: "user",
  Group: "group",
  ProjectRole: "projectRole",
  UserCustomField: "field",
  GroupCustomField: "field",
};
function identity(raw: Record<string, unknown>, kind: IdentityKind): CatalogJsonObject | undefined {
  switch (kind) {
    case "user":
      return jiraNativeText(raw.key, 255) || jiraNativeText(raw.name, 255) ? {} : undefined;
    case "group":
      return jiraNativeText(raw.name, 255) ? {} : undefined;
    case "projectRole": {
      const id = jiraNativeNumericId(raw.id);
      return id === undefined ? undefined : { id };
    }
    case "field":
      return isSafeAtlassianIdentifier(raw.id) ? { id: raw.id } : undefined;
  }
}
function userActive(raw: Record<string, unknown>): CatalogJsonObject | undefined {
  if (raw.active === undefined || raw.active === null) return {};
  return typeof raw.active === "boolean" ? { active: raw.active } : undefined;
}
function identityDetails(value: unknown, kind: IdentityKind): CatalogJsonObject | undefined {
  const raw = asRecord(value);
  if (raw === undefined) return undefined;
  const text = optionalText(raw, { name: 255, description: 32768, displayName: 255, key: 255 });
  const id = identity(raw, kind);
  const flags = kind === "user" ? userActive(raw) : {};
  return text === undefined || id === undefined || flags === undefined
    ? undefined : { ...text, ...id, ...flags };
}

function expandedRecipient(
  raw: Record<string, unknown>,
  kind: string,
): CatalogJsonObject | undefined {
  const field = Object.hasOwn(EXPANDED_FIELDS, kind) ? EXPANDED_FIELDS[kind] : undefined;
  if (field === undefined || raw[field] === undefined || raw[field] === null) return {};
  const details = identityDetails(raw[field], field);
  return details === undefined ? undefined : { [field]: details };
}

function notification(value: unknown): CatalogJsonObject | undefined {
  const raw = asRecord(value);
  const id = jiraNativeNumericId(raw?.id);
  if (raw === undefined || id === undefined || typeof raw.notificationType !== "string" ||
    !RECIPIENT_TYPES.has(raw.notificationType)) return undefined;
  const fields: Record<string, number> = { parameter: 1024 };
  if (raw.notificationType === "EmailAddress") fields.emailAddress = 320;
  const text = optionalText(raw, fields);
  const expanded = expandedRecipient(raw, raw.notificationType);
  if (text === undefined || expanded === undefined) return undefined;
  return { id, notificationType: raw.notificationType, ...text, ...expanded };
}

interface EventValue {
  readonly raw: Record<string, unknown>;
  readonly data: CatalogJsonObject;
}
function eventValue(value: unknown): EventValue | undefined {
  const raw = asRecord(value);
  const id = jiraNativeNumericId(raw?.id);
  if (raw === undefined || id === undefined) return undefined;
  const text = optionalText(raw, { name: 255, description: 32768 });
  return text === undefined ? undefined : { raw, data: { id, ...text } };
}
function event(value: unknown): CatalogJsonObject | undefined {
  const first = eventValue(value);
  if (first === undefined) return undefined;
  const templateEvents: CatalogJsonObject[] = [];
  let next = first.raw.templateEvent;
  for (let depth = 1; next !== undefined && next !== null; depth += 1) {
    if (depth >= 8) return undefined;
    const template = eventValue(next);
    if (template === undefined) return undefined;
    templateEvents.push(template.data);
    next = template.raw.templateEvent;
  }
  return {
    ...first.data,
    ...(templateEvents.length === 0 ? {} : { templateEvents }),
  };
}

function schemeEvent(value: unknown): CatalogJsonObject | undefined {
  const raw = asRecord(value);
  const observed = event(raw?.event);
  if (raw === undefined || observed === undefined) return undefined;
  if (raw.notifications === undefined || raw.notifications === null) return { ...observed };
  if (!Array.isArray(raw.notifications)) return undefined;
  const notifications = projectJiraCollection(raw.notifications, MAX, notification, "id");
  return notifications === undefined ? undefined : { ...observed, notifications };
}

/** Project the documented DTOs, never their self/avatar/HTML fields or arbitrary nested objects. */
export function jiraNotificationScheme(value: unknown, includeEvents: boolean): CatalogJsonObject | undefined {
  const raw = asRecord(value);
  const id = jiraNativeNumericId(raw?.id);
  if (raw === undefined || id === undefined || !jiraNativeText(raw.name, 255)) return undefined;
  const text = optionalText(raw, { description: 32768 });
  if (text === undefined) return undefined;
  const metadata = { id, name: raw.name, ...text };
  if (!includeEvents) return metadata;
  if (raw.notificationSchemeEvents === undefined || raw.notificationSchemeEvents === null)
    return { ...metadata, eventsAvailable: false };
  if (!Array.isArray(raw.notificationSchemeEvents)) return undefined;
  const events = projectJiraCollection(raw.notificationSchemeEvents, MAX, schemeEvent, "id");
  return events === undefined ? undefined : { ...metadata, eventsAvailable: true, events };
}
