import { isSafeAtlassianIdentifier } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ManagedMcpToolResult } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { asArray, asRecord } from "./atlassian-sync-classify.js";
import {
  editMetadataItems,
  jiraReadFailure,
  localJiraPage,
  projectJiraCollection,
} from "./jira-managed-metadata.js";

function text(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}
function transition(value: unknown): CatalogJsonObject | undefined {
  const raw = asRecord(value);
  if (raw === undefined || !isSafeAtlassianIdentifier(raw.id) || !text(raw.name, 255))
    return undefined;
  const fields = transitionFields(raw.fields);
  return fields === undefined
    ? undefined
    : { id: raw.id, name: raw.name, ...fields, ...transitionTarget(raw.to) };
}
function transitionFields(value: unknown): CatalogJsonObject | undefined {
  if (value === undefined || value === null) return { metadataAvailable: false };
  const fields = editMetadataItems(value);
  return fields === undefined ? undefined : { metadataAvailable: true, fields };
}
function transitionTarget(value: unknown): CatalogJsonObject {
  const to = asRecord(value);
  return to !== undefined && isSafeAtlassianIdentifier(to.id) && text(to.name, 255)
    ? { to: { id: to.id, name: to.name } }
    : {};
}

export function jiraTransitionsResult(
  body: Record<string, unknown>,
  startAt: number,
  maxResults: number,
): ManagedMcpToolResult {
  const values = asArray(body.transitions);
  const valid =
    values === undefined ? undefined : projectJiraCollection(values, 1000, transition, "id");
  return valid === undefined
    ? jiraReadFailure("malformed-payload")
    : localJiraPage(valid, startAt, maxResults);
}
function user(value: unknown): CatalogJsonObject | undefined {
  const raw = asRecord(value);
  if (
    raw === undefined ||
    !text(raw.name, 256) ||
    !text(raw.displayName, 256) ||
    typeof raw.active !== "boolean"
  )
    return undefined;
  return { name: raw.name, displayName: raw.displayName, active: raw.active };
}
export function jiraAssignableUsersResult(
  values: readonly unknown[],
  startAt: number,
  maxResults: number,
): ManagedMcpToolResult {
  const valid = projectJiraCollection(values, maxResults, user, "name");
  if (valid === undefined) return jiraReadFailure("malformed-payload");
  return {
    data: {
      outcome: "succeeded",
      items: valid,
      startAt,
      ...(valid.length === 0 ? {} : { nextStartAt: startAt + valid.length }),
    },
  };
}
export function jiraAssignableUsersPath(
  args: CatalogJsonObject,
  allowed: Set<string>,
  paging: string,
): string | undefined {
  const scope = assignableScope(args);
  if (scope === undefined) return undefined;
  allowed.add(scope.argument);
  allowed.add("query");
  const query = args.query ?? "";
  if (typeof query !== "string" || query.length > 256) return undefined;
  const params = new URLSearchParams({ [scope.parameter]: scope.value });
  if (query.length > 0) params.set("username", query);
  for (const [key, value] of new URLSearchParams(paging)) params.set(key, value);
  return `user/assignable/search?${params.toString()}`;
}

interface AssignableScope {
  readonly argument: string;
  readonly parameter: string;
  readonly value: string;
}
function assignableScope(args: CatalogJsonObject): AssignableScope | undefined {
  const issue = args.issueKey;
  const project = args.projectKey;
  if ((issue === undefined) === (project === undefined)) return undefined;
  const value = issue ?? project;
  if (!isSafeAtlassianIdentifier(value)) return undefined;
  return issue === undefined
    ? { argument: "projectKey", parameter: "project", value }
    : { argument: "issueKey", parameter: "issueKey", value };
}
