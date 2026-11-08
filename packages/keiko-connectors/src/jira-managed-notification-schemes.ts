import {
  JIRA_READ_TOOL_FAMILIES,
  isSafeAtlassianIdentifier,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ManagedMcpToolResult } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import { boundJiraReadResult } from "./jira-managed-issue-reads.js";
import {
  jiraMetadataPageLast,
  jiraReadFailure,
  projectJiraCollection,
} from "./jira-managed-metadata.js";
import { readJiraBoundProject } from "./jira-managed-projects.js";
import { jiraNativeId } from "./jira-native-values.js";
import { jiraNotificationScheme } from "./jira-notification-scheme-values.js";

export const JIRA_NOTIFICATION_SCHEME_READS = JIRA_READ_TOOL_FAMILIES.notificationSchemes;
type Operation = (typeof JIRA_NOTIFICATION_SCHEME_READS)[number];
interface Selection {
  readonly startAt: number;
  readonly maxResults: number;
  readonly includeEvents: boolean;
}
const EXPANSION = "notificationSchemeEvents,user,group,projectRole,field";
const INPUT_FIELDS: Readonly<Record<Operation, readonly string[]>> = {
  "jira.notification-schemes": ["includeEvents", "startAt", "maxResults"],
  "jira.notification-scheme": ["includeEvents", "schemeId"],
  "jira.project-notification-scheme": ["includeEvents", "projectIdOrKey"],
};

export function isJiraNotificationSchemeRead(name: string): name is Operation {
  return (JIRA_NOTIFICATION_SCHEME_READS as readonly string[]).includes(name);
}
function integer(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}
function targetValid(operation: Operation, args: CatalogJsonObject): boolean {
  if (operation === "jira.notification-schemes") return true;
  return operation === "jira.notification-scheme"
    ? jiraNativeId(args.schemeId)
    : isSafeAtlassianIdentifier(args.projectIdOrKey);
}
function selected(operation: Operation, args: CatalogJsonObject): Selection | undefined {
  const allowed = new Set(INPUT_FIELDS[operation]);
  if (Object.keys(args).some((key) => !allowed.has(key)) || !targetValid(operation, args))
    return undefined;
  if (args.includeEvents !== undefined && typeof args.includeEvents !== "boolean") return undefined;
  const startAt = args.startAt === undefined ? 0 : args.startAt;
  const maxResults = args.maxResults === undefined ? 25 : args.maxResults;
  if (!integer(startAt, 0, 1_000_000) || !integer(maxResults, 1, 50)) return undefined;
  return { startAt, maxResults, includeEvents: args.includeEvents === true };
}
function query(selection: Selection, list: boolean): string {
  const params = new URLSearchParams();
  if (list) {
    params.set("startAt", String(selection.startAt));
    params.set("maxResults", String(selection.maxResults));
  }
  if (selection.includeEvents) params.set("expand", EXPANSION);
  return params.size === 0 ? "" : `?${params.toString()}`;
}
async function single(
  path: string,
  selection: Selection,
  request: JiraMutationRequest,
  expectedId?: string,
  context: CatalogJsonObject = {},
): Promise<ManagedMcpToolResult> {
  const response = await request(path + query(selection, false));
  if (!response.ok) return jiraReadFailure(response.reason, response.remote);
  const scheme =
    response.status === 200
      ? jiraNotificationScheme(response.body, selection.includeEvents)
      : undefined;
  if (scheme === undefined) return jiraReadFailure("malformed-payload");
  if (expectedId !== undefined && scheme.id !== expectedId) return jiraReadFailure("conflict");
  return boundJiraReadResult({
    data: {
      outcome: "succeeded",
      ...context,
      eventsRequested: selection.includeEvents,
      items: [scheme],
    },
  });
}
async function list(
  selection: Selection,
  request: JiraMutationRequest,
): Promise<ManagedMcpToolResult> {
  const response = await request("notificationscheme" + query(selection, true));
  if (!response.ok) return jiraReadFailure(response.reason, response.remote);
  const body = response.body;
  if (response.status !== 200 || body === undefined || !Array.isArray(body.values))
    return jiraReadFailure("malformed-payload");
  if (body.values.length > selection.maxResults) return jiraReadFailure("bounds-exceeded");
  const items = projectJiraCollection(
    body.values,
    50,
    (value) => jiraNotificationScheme(value, selection.includeEvents),
    "id",
  );
  if (items === undefined) return jiraReadFailure("malformed-payload");
  const envelope = body.total === null ? { ...body, total: undefined } : body;
  const last = jiraMetadataPageLast(
    envelope,
    items.length,
    selection.startAt,
    selection.maxResults,
  );
  if (last === undefined) return jiraReadFailure("malformed-payload");
  return boundJiraReadResult({
    data: {
      outcome: "succeeded",
      items,
      startAt: selection.startAt,
      isLast: last,
      eventsRequested: selection.includeEvents,
      ...(typeof body.total === "number" ? { total: body.total } : {}),
      ...(last ? {} : { nextStartAt: selection.startAt + items.length }),
    },
  });
}
/** Scheme visibility follows Jira actor permissions; no notification or subscription is changed. */
export async function executeJiraNotificationSchemeRead(
  operation: Operation,
  args: CatalogJsonObject,
  request: JiraMutationRequest,
): Promise<ManagedMcpToolResult> {
  const selection = selected(operation, args);
  if (selection === undefined) return jiraReadFailure("invalid-input");
  if (operation === "jira.notification-schemes") return list(selection, request);
  if (operation === "jira.notification-scheme")
    return single(
      `notificationscheme/${String(args.schemeId)}`,
      selection,
      request,
      String(args.schemeId),
    );
  const project = await readJiraBoundProject(request, String(args.projectIdOrKey));
  if (!project.ok) return jiraReadFailure(project.reason, project.detail);
  if (!jiraNativeId(project.project.projectId)) return jiraReadFailure("malformed-payload");
  return single(
    `project/${project.project.projectId}/notificationscheme`,
    selection,
    request,
    undefined,
    { projectId: project.project.projectId, projectKey: project.project.projectKey },
  );
}
