import {
  TOOL_CATALOG_LIMITS,
  type CatalogJsonObject,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ManagedMcpToolResult } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { JIRA_READ_TOOL_FAMILIES } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { asArray, asRecord } from "./atlassian-sync-classify.js";
import { boundJiraReadResult } from "./jira-managed-issue-reads.js";
import {
  jiraReadFailure,
  localJiraPage,
  projectJiraCollection,
  projectJiraOptionalFields,
} from "./jira-managed-metadata.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import {
  executeJiraSelectedRead,
  selectJiraReadPage,
  type JiraReadPageSelection,
  type JiraReadResponse,
} from "./jira-managed-read-request.js";
import { jiraNativeNumericId, jiraNativeText } from "./jira-native-values.js";

export const JIRA_ACCOUNT_DIAGNOSTIC_READS = JIRA_READ_TOOL_FAMILIES.accountDiagnostics;
type DiagnosticRead = (typeof JIRA_ACCOUNT_DIAGNOSTIC_READS)[number];
const READS: ReadonlySet<string> = new Set(JIRA_ACCOUNT_DIAGNOSTIC_READS);
const PAGE = new Set(["startAt", "maxResults"]);
const POLICY = new Set(["hasOldPassword", ...PAGE]);
const OBSERVATION_SCOPE = "cached-duplicate-accounts";
interface Selection extends JiraReadPageSelection {
  readonly path: string;
  readonly name: DiagnosticRead;
  readonly hasOldPassword?: boolean;
}

function select(name: DiagnosticRead, args: CatalogJsonObject): Selection | undefined {
  if (name === "jira.search-error")
    return Object.keys(args).length === 0
      ? { name, path: "search/error/lookup", startAt: 0, maxResults: 1 }
      : undefined;
  if (name === "jira.duplicate-user-count")
    return Object.keys(args).length === 0
      ? { name, path: "user/duplicated/count?flush=false", startAt: 0, maxResults: 1 }
      : undefined;
  const page = selectJiraReadPage(args, name === "jira.password-policy" ? POLICY : PAGE);
  if (page === undefined) return undefined;
  if (name === "jira.duplicate-users")
    return { ...page, name, path: "user/duplicated/list?flush=false" };
  const hasOldPassword = args.hasOldPassword === undefined ? false : args.hasOldPassword;
  if (typeof hasOldPassword !== "boolean") return undefined;
  return {
    ...page,
    name,
    hasOldPassword,
    path: `password/policy?hasOldPassword=${String(hasOldPassword)}`,
  };
}
function directory(value: unknown): CatalogJsonObject | undefined {
  const raw = asRecord(value);
  if (raw === undefined) return undefined;
  const directoryId = jiraNativeNumericId(raw.directoryId);
  if (directoryId === undefined) return undefined;
  const optional = projectJiraOptionalFields(
    raw,
    ["directoryName", "userActive"],
    (value, field) => {
      if (field === "directoryName") return jiraNativeText(value, 255) ? value : undefined;
      return typeof value === "boolean" ? value : undefined;
    },
  );
  return optional === undefined ? undefined : { directoryId, ...optional };
}
function directoryBounds(value: unknown): boolean {
  const raw = asRecord(value);
  const id = raw?.directoryId;
  const name = raw?.directoryName;
  return (
    (typeof id === "number" && Number.isInteger(id) && !Number.isSafeInteger(id)) ||
    (typeof name === "string" && name.length > 255)
  );
}
function userDirectories(
  username: string,
  value: unknown,
):
  | { readonly ok: true; readonly item: CatalogJsonObject }
  | { readonly ok: false; readonly reason: "bounds-exceeded" | "malformed-payload" } {
  if (!jiraNativeText(username, 255) || /\p{Surrogate}/u.test(username))
    return { ok: false, reason: "malformed-payload" };
  const values = asArray(value);
  if (values === undefined) return { ok: false, reason: "malformed-payload" };
  if (values.length > TOOL_CATALOG_LIMITS.maxArrayItems)
    return { ok: false, reason: "bounds-exceeded" };
  if (values.some(directoryBounds)) return { ok: false, reason: "bounds-exceeded" };
  const directories = projectJiraCollection(
    values,
    TOOL_CATALOG_LIMITS.maxArrayItems,
    directory,
    "directoryId",
  );
  return directories === undefined
    ? { ok: false, reason: "malformed-payload" }
    : { ok: true, item: { username, directories } };
}
/** Official DTO: username -> directory bean arrays; the published AvatarBean reference is unrelated.
 * https://docs.atlassian.com/software/jira/docs/api/11.3.3/com/atlassian/jira/rest/v2/issue/users/DuplicatedUsersMapBeanFactory.html
 */
function duplicateUsers(response: JiraReadResponse, selected: Selection): ManagedMcpToolResult {
  const body = response.body;
  if (body === undefined) return jiraReadFailure("malformed-payload");
  const keys = Object.keys(body);
  if (keys.length > TOOL_CATALOG_LIMITS.maxArrayItems) return jiraReadFailure("bounds-exceeded");
  const items: CatalogJsonObject[] = [];
  for (const username of keys) {
    const projected = userDirectories(username, body[username]);
    if (!projected.ok) return jiraReadFailure(projected.reason);
    items.push(projected.item);
  }
  const page = localJiraPage(items, selected.startAt, selected.maxResults);
  return boundJiraReadResult({ data: { ...page.data, observationScope: OBSERVATION_SCOPE } });
}
function duplicateCount(response: JiraReadResponse): ManagedMcpToolResult {
  const count = response.body?.count;
  if (typeof count !== "number" || !Number.isFinite(count) || !Number.isInteger(count) || count < 0)
    return jiraReadFailure("malformed-payload");
  if (!Number.isSafeInteger(count)) return jiraReadFailure("bounds-exceeded");
  return { data: { outcome: "succeeded", count, observationScope: OBSERVATION_SCOPE } };
}
/** PasswordResource documents an array, despite the published scalar schema; no password is tested.
 * https://docs.atlassian.com/software/jira/docs/api/11.3.3/com/atlassian/jira/rest/v2/password/PasswordResource.html
 */
function passwordPolicy(response: JiraReadResponse, selected: Selection): ManagedMcpToolResult {
  const values = response.items;
  if (values === undefined) return jiraReadFailure("malformed-payload");
  if (values.length > TOOL_CATALOG_LIMITS.maxArrayItems) return jiraReadFailure("bounds-exceeded");
  const items: CatalogJsonObject[] = [];
  for (const value of values) {
    if (typeof value === "string" && value.length > 1024) return jiraReadFailure("bounds-exceeded");
    if (!jiraNativeText(value, 1024)) return jiraReadFailure("malformed-payload");
    items.push({ requirement: value });
  }
  const page = localJiraPage(items, selected.startAt, selected.maxResults);
  return boundJiraReadResult({
    data: {
      ...page.data,
      policyScope: "requirements-only",
      hasOldPassword: selected.hasOldPassword === true,
    },
  });
}
function project(response: JiraReadResponse, selected: Selection): ManagedMcpToolResult {
  if (selected.name === "jira.duplicate-user-count") return duplicateCount(response);
  return selected.name === "jira.duplicate-users"
    ? duplicateUsers(response, selected)
    : passwordPolicy(response, selected);
}
function storedSearchError(response: JiraReadResponse): ManagedMcpToolResult {
  const scope = "current-user-http-context";
  if (response.status !== 200) return jiraReadFailure("malformed-payload");
  const message = response.body?.errorStringI18n;
  if (message === undefined || message === null || message === "")
    return jiraReadFailure("unavailable");
  if (typeof message === "string" && message.length > 4096)
    return jiraReadFailure("bounds-exceeded");
  return jiraNativeText(message, 4096)
    ? boundJiraReadResult({ data: { outcome: "succeeded", scope, errorPresent: true, message } })
    : jiraReadFailure("malformed-payload");
}
async function searchError(request: JiraMutationRequest): Promise<ManagedMcpToolResult> {
  const response = await request("search/error/lookup", "GET", undefined, "json");
  // This one published resource defines 204 as no stored error. The shared strict JSON decoder
  // still refuses empty JSON on other routes; no response-mode or transport boundary is widened.
  const status = response.ok ? response.status : response.httpStatus;
  if (status === 204)
    return {
      data: {
        outcome: "succeeded",
        scope: "current-user-http-context",
        errorPresent: false,
      },
    };
  return response.ok
    ? storedSearchError(response)
    : jiraReadFailure(response.reason, response.remote);
}
export function isJiraAccountDiagnosticRead(name: string): name is DiagnosticRead {
  return READS.has(name);
}
/** Observations only: cache flush is fixed false and native policy requirements never grant authority. */
export function executeJiraAccountDiagnosticRead(
  name: DiagnosticRead,
  args: CatalogJsonObject,
  request: JiraMutationRequest,
): Promise<ManagedMcpToolResult> {
  const selected = select(name, args);
  if (selected === undefined) return Promise.resolve(jiraReadFailure("invalid-input"));
  if (name === "jira.search-error") return searchError(request);
  return executeJiraSelectedRead(
    selected,
    request,
    name === "jira.password-policy" ? "json-array" : "json",
    project,
  );
}
