import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ManagedMcpToolDeclaration } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { object, text } from "./jiraManagedSchemas.js";
import {
  jiraNativeDeclaration,
  jiraNativePagingSchema,
  jiraNativeReadResult,
  type JiraNativeDefinition,
} from "./jiraProjectStructureDescriptors.js";

const KEY = { ...text(255), minLength: 1, description: "Exact bounded native key; well-formed Unicode and at most 255 UTF-8 bytes. Controls and line breaks are refused." };
const PERMISSION = { type: "string", enum: ["ADMIN", "SYSADMIN"] };
const KIND = { type: "string", enum: ["string", "boolean", "integer"] };
const STATE = { type: "string", enum: ["observed", "unknown", "withheld"] };
const INTEGER = { type: "integer", minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER };
const VALUE_FIELDS = {
  key: KEY,
  valueState: STATE,
  valueType: KIND,
  stringValue: text(4096),
  booleanValue: { type: "boolean" },
  integerValue: INTEGER,
};
const VALUE_VARIANTS = [
  object({ key: KEY, valueState: { type: "string", enum: ["withheld"] } }, ["key", "valueState"]),
  object({ key: KEY, valueState: { type: "string", enum: ["unknown"] }, valueType: KIND }, ["key", "valueState", "valueType"]),
  ...([
    ["string", "stringValue", text(4096)],
    ["boolean", "booleanValue", { type: "boolean" }],
    ["integer", "integerValue", INTEGER],
  ] as const).map(([kind, field, schema]) => object({
    key: KEY,
    valueState: { type: "string", enum: ["observed"] },
    valueType: { type: "string", enum: [kind] },
    [field]: schema,
  }, ["key", "valueState", "valueType", field])),
];
const ROW = { anyOf: VALUE_VARIANTS };
function result(scope: string, list: boolean): CatalogJsonObject {
  return jiraNativeReadResult({
    settingsScope: { type: "string", enum: [scope] },
    ...VALUE_FIELDS,
    ...(list ? {
      permissionLevel: PERMISSION,
      items: { type: "array", maxItems: 100, items: ROW },
      startAt: { type: "integer", minimum: 0, maximum: 1_000_000 },
      total: { type: "integer", minimum: 0, maximum: 1000 },
      nextStartAt: { type: "integer", minimum: 0, maximum: 1_000_000 },
    } : {}),
  });
}
const VALUE_GUIDANCE = "Only exact documented nonsecret keys may expose a typed value. Unknown keys return metadata with valueState withheld; never return raw values, examples, defaults or allowedValues. Preserve false, zero and empty text; missing/null known values remain unknown. A malformed known type fails instead of coercing truthiness. Observations do not grant authority or change Jira or Keiko settings.";
function read(description: string, input: CatalogJsonObject, output: CatalogJsonObject, maxResultCount: number): JiraNativeDefinition {
  return { description, input, result: output, risk: "read", maxResultCount };
}
export const JIRA_APPLICATION_SETTINGS_READ_DEFINITIONS = {
  "jira.application-properties": read(
    `Read a native application property by exact key, or one local page from the native ADMIN/SYSADMIN-filtered property list. Supply key alone OR permissionLevel with optional local paging. permissionLevel is only a native filter, not proof of effective permission or editability. No regex keyFilter. Known values: jira.clone.prefix (text), jira.option.voting, jira.option.watching and jira.option.timetracking (canonical true/false strings projected as booleans). ${VALUE_GUIDANCE}`,
    { anyOf: [object({ key: KEY }, ["key"]), object({ permissionLevel: PERMISSION, ...jiraNativePagingSchema }, ["permissionLevel"])] },
    result("application-properties", true),
    100,
  ),
  "jira.advanced-settings": read(
    `Read one local page of the native General Configuration advanced-settings list. Validate the complete bounded native list before paging; no native offset or regex is invented. The list does not establish edit permission. ${VALUE_GUIDANCE}`,
    object(jiraNativePagingSchema),
    result("advanced-settings", true),
    100,
  ),
  "jira.my-preference": read(
    `Read one exact preference of the connected Jira user. Known keys: jira.user.locale, jira.user.timezone, user.notifications.mimetype (text), user.issues.per.page (exact safe signed decimal integer), user.keyboard.shortcuts.disabled and user.notify.own.changes (canonical true/false strings projected as booleans). The native response is a JSON string, never parsed again as JSON. A 404 stays a native failure, not an invented empty value/default. ${VALUE_GUIDANCE}`,
    object({ key: KEY }, ["key"]),
    result("current-user-preference", false),
    1,
  ),
} as const satisfies Readonly<Record<string, JiraNativeDefinition>>;

export function jiraApplicationSettingsDeclarationForTool(name: string): ManagedMcpToolDeclaration | undefined {
  const definitions: Readonly<Record<string, JiraNativeDefinition>> = JIRA_APPLICATION_SETTINGS_READ_DEFINITIONS;
  const definition = Object.hasOwn(definitions, name) ? definitions[name] : undefined;
  return definition === undefined ? undefined : jiraNativeDeclaration(name, definition);
}
