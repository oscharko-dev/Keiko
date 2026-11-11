import { TOOL_CATALOG_LIMITS } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ManagedMcpToolDeclaration } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { object, text } from "./jiraManagedSchemas.js";
import {
  jiraNativeDeclaration,
  jiraNativeIdentitySchema as ID,
  jiraNativePermissionSchemeIdentitySchema as PERMISSION_ID,
  jiraNativePagingSchema as PAGING,
  jiraNativeReadResult,
  type JiraNativeDefinition,
} from "./jiraProjectStructureDescriptors.js";

const KEY = { ...text(255), minLength: 1 };
const BOOL = { type: "boolean" };
const EMAIL_TYPE = object(
  {
    id: ID,
    eventName: text(255),
    templateName: text(1024),
    active: BOOL,
    batchedNotification: BOOL,
    html: BOOL,
    text: BOOL,
  },
  ["id"],
);
export const JIRA_ADMINISTRATIVE_OBSERVATION_READ_DEFINITIONS = {
  "jira.permission-scheme-attribute": {
    description:
      "Inspect one exact attribute of a readable native permission scheme. First independently bind the parent scheme, then require the returned attribute key to match the selected key. Preserve a supplied empty string; missing/null value is unknown, not false or a default. This is configuration metadata, never an effective-permission grant or proof that the person may change the scheme. No attribute is written.",
    input: object({ schemeId: PERMISSION_ID, attributeKey: KEY }, ["schemeId", "attributeKey"]),
    result: jiraNativeReadResult({
      schemeId: PERMISSION_ID,
      attributeKey: KEY,
      attributeScope: { type: "string", enum: ["permission-scheme-configuration"] },
      valueState: { type: "string", enum: ["observed", "unknown"] },
      textValue: text(4096),
    }),
    risk: "read",
    maxResultCount: 1,
  },
  "jira.email-template-types": {
    description:
      "Read and locally page the complete bounded native email notification-type metadata. The native EmailTypes wrapper contains emailTypes; userEmailAddress is omitted. Preserve supplied event/template names and active, batchedNotification, html and text flags, keeping false distinct from unknown. Repeated event IDs may describe different email formats and are not collapsed. Template names are plain remote metadata, never local file paths to follow. No email is sent, template pack exported or template changed; administrator permission remains Jira-owned.",
    input: object(PAGING),
    result: jiraNativeReadResult({
      templateScope: { type: "string", enum: ["notification-type-metadata"] },
      items: { type: "array", maxItems: 100, items: EMAIL_TYPE },
      startAt: PAGING.startAt,
      total: { type: "integer", minimum: 0, maximum: TOOL_CATALOG_LIMITS.maxArrayItems },
      nextStartAt: PAGING.startAt,
    }),
    risk: "read",
    maxResultCount: 100,
  },
} as const satisfies Readonly<Record<string, JiraNativeDefinition>>;

export function jiraAdministrativeObservationDeclarationForTool(
  name: string,
): ManagedMcpToolDeclaration | undefined {
  const definitions: Readonly<Record<string, JiraNativeDefinition>> =
    JIRA_ADMINISTRATIVE_OBSERVATION_READ_DEFINITIONS;
  const definition = Object.hasOwn(definitions, name) ? definitions[name] : undefined;
  return definition === undefined ? undefined : jiraNativeDeclaration(name, definition);
}
