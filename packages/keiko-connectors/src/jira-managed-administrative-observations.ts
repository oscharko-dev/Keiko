import {
  TOOL_CATALOG_LIMITS,
  type CatalogJsonObject,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ManagedMcpToolResult } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { JIRA_READ_TOOL_FAMILIES } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { asArray, asRecord } from "./atlassian-sync-classify.js";
import { jiraPropertyPathKey } from "./jira-entity-property-values.js";
import { executeJiraAccessSchemeRead } from "./jira-managed-access-schemes.js";
import { boundJiraReadResult } from "./jira-managed-issue-reads.js";
import {
  jiraReadFailure,
  localJiraPage,
  projectJiraOptionalFields,
} from "./jira-managed-metadata.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import { selectJiraReadPage } from "./jira-managed-read-request.js";
import {
  jiraNativePermissionSchemeId,
  jiraNativeNumericId,
  jiraNativeText,
} from "./jira-native-values.js";

export const JIRA_ADMINISTRATIVE_OBSERVATION_READS =
  JIRA_READ_TOOL_FAMILIES.administrativeObservations;
type Observation = (typeof JIRA_ADMINISTRATIVE_OBSERVATION_READS)[number];
interface AttributeSelection {
  readonly schemeId: string;
  readonly attributeKey: string;
}
function attributeSelection(args: CatalogJsonObject): AttributeSelection | undefined {
  if (Object.keys(args).some((key) => key !== "schemeId" && key !== "attributeKey"))
    return undefined;
  return jiraNativePermissionSchemeId(args.schemeId) && jiraPropertyPathKey(args.attributeKey)
    ? { schemeId: args.schemeId, attributeKey: args.attributeKey }
    : undefined;
}
function attributeValue(value: unknown): CatalogJsonObject | undefined {
  if (value === undefined || value === null) return { valueState: "unknown" };
  return jiraNativeText(value, 4096, true) && !/\p{Surrogate}/u.test(value)
    ? { valueState: "observed", textValue: value }
    : undefined;
}
export { attributeValue as jiraPermissionAttributeValueProjection };
async function attribute(
  args: CatalogJsonObject,
  request: JiraMutationRequest,
): Promise<ManagedMcpToolResult> {
  const selected = attributeSelection(args);
  if (selected === undefined) return jiraReadFailure("invalid-input");
  const parent = await executeJiraAccessSchemeRead(
    "jira.permission-scheme",
    { schemeId: selected.schemeId },
    request,
  );
  if (parent.data.outcome !== "succeeded") return parent;
  const response = await request(
    `permissionscheme/${selected.schemeId}/attribute/${encodeURIComponent(selected.attributeKey)}`,
    "GET",
    undefined,
    "json",
  );
  if (!response.ok) return jiraReadFailure(response.reason, response.remote);
  const body = response.body;
  if (body?.key !== selected.attributeKey) return jiraReadFailure("malformed-payload");
  if (typeof body.value === "string" && body.value.length > 4096)
    return jiraReadFailure("bounds-exceeded");
  const value = attributeValue(body.value);
  return value === undefined
    ? jiraReadFailure("malformed-payload")
    : boundJiraReadResult({
        data: {
          outcome: "succeeded",
          schemeId: selected.schemeId,
          attributeKey: selected.attributeKey,
          attributeScope: "permission-scheme-configuration",
          ...value,
        },
      });
}
function emailType(value: unknown): CatalogJsonObject | undefined {
  const raw = asRecord(value);
  const id = jiraNativeNumericId(raw?.id);
  if (raw === undefined || id === undefined) return undefined;
  const fields = projectJiraOptionalFields(
    raw,
    ["eventName", "templateName", "active", "batchedNotification", "html", "text"],
    (field, name) => {
      const max = name === "eventName" ? 255 : 1024;
      const text = jiraNativeText(field, max, true) ? field : undefined;
      const flag = typeof field === "boolean" ? field : undefined;
      return name === "eventName" || name === "templateName" ? text : flag;
    },
  );
  return fields === undefined ? undefined : { id, ...fields };
}
function emailTypeBounds(value: unknown): boolean {
  const raw = asRecord(value);
  return (
    (typeof raw?.id === "number" && Number.isInteger(raw.id) && !Number.isSafeInteger(raw.id)) ||
    (typeof raw?.eventName === "string" && raw.eventName.length > 255) ||
    (typeof raw?.templateName === "string" && raw.templateName.length > 1024)
  );
}
/** EmailTypes owns the native wrapper. Repeated event IDs can describe different email formats.
 * https://docs.atlassian.com/software/jira/docs/api/11.3.3/com/atlassian/jira/mail/EmailTypes.html
 * https://docs.atlassian.com/software/jira/docs/api/11.3.3/com/atlassian/jira/mail/EmailType.html
 */
async function emailTypes(
  args: CatalogJsonObject,
  request: JiraMutationRequest,
): Promise<ManagedMcpToolResult> {
  const page = selectJiraReadPage(args, new Set(["startAt", "maxResults"]));
  if (page === undefined) return jiraReadFailure("invalid-input");
  const response = await request("email-templates/types", "GET", undefined, "json");
  if (!response.ok) return jiraReadFailure(response.reason, response.remote);
  const values = asArray(response.body?.emailTypes);
  if (values === undefined) return jiraReadFailure("malformed-payload");
  if (values.length > TOOL_CATALOG_LIMITS.maxArrayItems || values.some(emailTypeBounds))
    return jiraReadFailure("bounds-exceeded");
  const items: CatalogJsonObject[] = [];
  for (const value of values) {
    const item = emailType(value);
    if (item === undefined) return jiraReadFailure("malformed-payload");
    items.push(item);
  }
  const result = localJiraPage(items, page.startAt, page.maxResults);
  return boundJiraReadResult({
    data: { ...result.data, templateScope: "notification-type-metadata" },
  });
}
export function isJiraAdministrativeObservationRead(name: string): name is Observation {
  return (JIRA_ADMINISTRATIVE_OBSERVATION_READS as readonly string[]).includes(name);
}
/** Native administrator permission remains Jira-owned; no mail is sent and no template is exported. */
export function executeJiraAdministrativeObservationRead(
  name: Observation,
  args: CatalogJsonObject,
  request: JiraMutationRequest,
): Promise<ManagedMcpToolResult> {
  return name === "jira.permission-scheme-attribute"
    ? attribute(args, request)
    : emailTypes(args, request);
}
