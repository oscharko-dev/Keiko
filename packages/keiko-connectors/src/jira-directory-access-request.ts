import { isSafeAtlassianIdentifier } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { TOOL_CATALOG_LIMITS } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ManagedMcpInvocationContext } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { isAtlassianApplicationRoleVersion } from "./atlassian-http-port.js";
import { atlassianApiEndpointsFor, atlassianApiUrl } from "./atlassian-sync-classify.js";
import { ATLASSIAN_WRITE_ACTION_TOTAL_TIMEOUT_MS, type AtlassianWriteHttpOutcome } from "./atlassian-write-http.js";
import type { JiraManagedConnection } from "./jira-managed-connection.js";
import { executeAdmittedJiraRequest } from "./jira-request-admission.js";
import { savedText } from "./jira-saved-configuration-values.js";

export interface JiraApplicationRoleConfiguration {
  readonly key: string;
  readonly groups: readonly string[];
  readonly defaultGroups: readonly string[];
}
export interface JiraDirectoryAccessPorts {
  readonly roles: {
    readonly read: () => Promise<AtlassianWriteHttpOutcome>;
    readonly write: (version: string, values: readonly JiraApplicationRoleConfiguration[], bulk: boolean) => Promise<AtlassianWriteHttpOutcome>;
  };
  readonly application: (username: string, applicationKey: string, present: boolean) => Promise<AtlassianWriteHttpOutcome>;
  readonly columns: (username: string, columns: readonly string[]) => Promise<AtlassianWriteHttpOutcome>;
}
function strings(values: readonly string[], empty: boolean): boolean {
  return values.length <= TOOL_CATALOG_LIMITS.maxArrayItems && (empty || values.length > 0) && values.every((value) => savedText(value, 255));
}
function role(value: JiraApplicationRoleConfiguration): boolean {
  return isSafeAtlassianIdentifier(value.key) && strings(value.groups, true) && strings(value.defaultGroups, true) &&
    new Set(value.groups).size === value.groups.length && new Set(value.defaultGroups).size === value.defaultGroups.length &&
    value.defaultGroups.every((group) => value.groups.includes(group));
}
const INVALID: AtlassianWriteHttpOutcome = { ok: false, reason: "field-validation" };
/** Three fixed native ports; all selectors originate in bound/reviewed leaf inputs. */
export function jiraDirectoryAccessRequests(connection: JiraManagedConnection, context: ManagedMcpInvocationContext): JiraDirectoryAccessPorts {
  const endpoints = atlassianApiEndpointsFor(connection.baseUrl, "/rest/api/2/");
  const signal = AbortSignal.any([context.signal, AbortSignal.timeout(ATLASSIAN_WRITE_ACTION_TOTAL_TIMEOUT_MS)]);
  return {
    roles: {
      read: () => executeAdmittedJiraRequest(connection, context, signal, {
        method: "GET", url: atlassianApiUrl(endpoints, "applicationrole"), jiraApplicationRole: "version", expect: "json-array",
      }),
      write: async (version, values, bulk) => {
        const first = values[0];
        if (!isAtlassianApplicationRoleVersion(version) || !strings(values.map((value) => value.key), false) ||
            first === undefined || !values.every(role) || new Set(values.map((value) => value.key)).size !== values.length || (!bulk && values.length !== 1)) return INVALID;
        const body = values.map((value) => ({ key: value.key, groups: [...value.groups], defaultGroups: [...value.defaultGroups] }));
        const path = bulk ? "applicationrole" : `applicationrole/${encodeURIComponent(first.key)}`;
        const result = await executeAdmittedJiraRequest(connection, context, signal, {
          method: "PUT", url: atlassianApiUrl(endpoints, path), bodyJson: JSON.stringify(bulk ? body : body[0]),
          jiraApplicationRole: { ifMatch: version }, expect: "none",
        });
        return !result.ok && result.httpStatus === 412 ? { ...result, reason: "conflict" } : result;
      },
    },
    application: (username, applicationKey, present) => {
      if (!savedText(username, 255) || !isSafeAtlassianIdentifier(applicationKey) || typeof present !== "boolean") return Promise.resolve(INVALID);
      const query = new URLSearchParams({ username, applicationKey });
      return executeAdmittedJiraRequest(connection, context, signal, {
        method: present ? "POST" : "DELETE", url: atlassianApiUrl(endpoints, `user/application?${query.toString()}`),
        jiraUserApplication: true, expect: "none",
      });
    },
    columns: (username, columns) => {
      if (!savedText(username, 255) || !strings(columns, false)) return Promise.resolve(INVALID);
      const form = new URLSearchParams({ username });
      for (const column of columns) form.append("columns", column);
      return executeAdmittedJiraRequest(connection, context, signal, {
        method: "PUT", url: atlassianApiUrl(endpoints, "user/columns"), bodyJson: form.toString(),
        jiraUserColumns: true, expect: "none",
      });
    },
  };
}
