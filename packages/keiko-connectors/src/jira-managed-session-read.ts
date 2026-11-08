import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type {
  ManagedMcpInvocationContext,
  ManagedMcpToolResult,
} from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { asRecord, atlassianApiEndpointsFor, atlassianApiUrl } from "./atlassian-sync-classify.js";
import {
  ATLASSIAN_WRITE_ACTION_TOTAL_TIMEOUT_MS,
  type AtlassianWriteHttpOutcome,
} from "./atlassian-write-http.js";
import { executeAdmittedJiraRequest } from "./jira-request-admission.js";
import { jiraDirectoryUser } from "./jira-directory-values.js";
import type { JiraManagedConnection } from "./jira-managed-connection.js";
import { boundJiraReadResult } from "./jira-managed-issue-reads.js";
import { jiraReadFailure, projectJiraOptionalFields } from "./jira-managed-metadata.js";
import type { JiraReadResponse } from "./jira-managed-read-request.js";
import type { JiraMaintenanceProjection } from "./jira-maintenance-values.js";
import { jiraNativeText } from "./jira-native-values.js";

const COUNTERS = ["failedLoginCount", "loginCount"] as const;
const TIMES = ["lastFailedLoginTime", "previousLoginTime"] as const;
function loginInfo(value: unknown): JiraMaintenanceProjection {
  if (value === undefined || value === null) return { ok: true, value: {} };
  const raw = asRecord(value);
  if (raw === undefined) return { ok: false, reason: "malformed-payload" };
  if (
    COUNTERS.some(
      (field) =>
        typeof raw[field] === "number" &&
        Number.isInteger(raw[field]) &&
        !Number.isSafeInteger(raw[field]),
    )
  )
    return { ok: false, reason: "bounds-exceeded" };
  if (TIMES.some((field) => typeof raw[field] === "string" && raw[field].length > 128))
    return { ok: false, reason: "bounds-exceeded" };
  const counts = projectJiraOptionalFields(raw, COUNTERS, (entry) =>
    typeof entry === "number" && Number.isSafeInteger(entry) && entry >= 0 ? entry : undefined,
  );
  const times = projectJiraOptionalFields(raw, TIMES, (entry) =>
    jiraNativeText(entry, 128) && !/\p{Surrogate}/u.test(entry) ? entry : undefined,
  );
  return counts === undefined || times === undefined
    ? { ok: false, reason: "malformed-payload" }
    : { ok: true, value: { loginInfo: { ...counts, ...times } } };
}
function observedSession(
  body: Record<string, unknown> | undefined,
  actor: CatalogJsonObject,
): ManagedMcpToolResult {
  if (body === undefined || body.name !== actor.name) return jiraReadFailure("malformed-payload");
  if (typeof actor.key !== "string" || typeof actor.name !== "string")
    return jiraReadFailure("malformed-payload");
  const info = loginInfo(body.loginInfo);
  return info.ok
    ? boundJiraReadResult({
        data: {
          outcome: "succeeded",
          observationScope: "bound-current-user-session",
          userKey: actor.key,
          username: actor.name,
          ...info.value,
        },
      })
    : jiraReadFailure(info.reason);
}
function boundActor(response: JiraReadResponse): CatalogJsonObject | undefined {
  const actor = response.status === 200 ? jiraDirectoryUser(response.body) : undefined;
  if (actor === undefined || typeof actor.key !== "string" || typeof actor.name !== "string")
    return undefined;
  return /\p{Surrogate}/u.test(`${actor.key}${actor.name}`) ? undefined : actor;
}
function fixedGet(
  connection: JiraManagedConnection,
  context: ManagedMcpInvocationContext,
  signal: AbortSignal,
  resource: "myself" | "session",
): Promise<AtlassianWriteHttpOutcome> {
  const root = resource === "myself" ? "/rest/api/2/" : "/rest/auth/1/";
  const url = atlassianApiUrl(atlassianApiEndpointsFor(connection.baseUrl, root), resource);
  return executeAdmittedJiraRequest(connection, context, signal, {
    method: "GET",
    url,
    expect: "json",
  });
}
export function isJiraSessionRead(name: string): name is "jira.current-session" {
  return name === "jira.current-session";
}
/** Login.currentUser is GET; no login/logout/session-cookie operation is exposed.
 * https://docs.atlassian.com/software/jira/docs/api/11.3.3/com/atlassian/jira/rest/auth/Login.html
 * CurrentUser is opaque in the retained11.3 OpenAPI. Its exact name/loginInfo fields are documented at
 * https://docs.atlassian.com/software/jira/docs/api/REST/9.12.2/#auth/1/session-currentUser
 */
export async function executeJiraSessionRead(
  args: CatalogJsonObject,
  context: ManagedMcpInvocationContext,
  connection: JiraManagedConnection,
): Promise<ManagedMcpToolResult> {
  if (Object.keys(args).length !== 0) return jiraReadFailure("invalid-input");
  if (connection.deployment !== "data-center") return jiraReadFailure("unavailable");
  const signal = AbortSignal.any([
    context.signal,
    AbortSignal.timeout(ATLASSIAN_WRITE_ACTION_TOTAL_TIMEOUT_MS),
  ]);
  return readSession(connection, context, signal);
}
async function readSession(
  connection: JiraManagedConnection,
  context: ManagedMcpInvocationContext,
  signal: AbortSignal,
): Promise<ManagedMcpToolResult> {
  const identity = await fixedGet(connection, context, signal, "myself");
  if (!identity.ok) return jiraReadFailure(identity.reason, identity.remote);
  const actor = boundActor(identity);
  if (actor === undefined) return jiraReadFailure("malformed-payload");
  const response = await fixedGet(connection, context, signal, "session");
  if (!response.ok) return jiraReadFailure(response.reason, response.remote);
  return response.status === 200
    ? observedSession(response.body, actor)
    : jiraReadFailure("malformed-payload");
}
