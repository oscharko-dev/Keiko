import { isSafeAtlassianIdentifier } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { TOOL_CATALOG_LIMITS, type CatalogJsonObject, type CatalogJsonValue } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { asArray, asRecord } from "./atlassian-sync-classify.js";
import { jiraBrowseUrl } from "./jira-browse-url.js";
import { jiraCommentSelfMatches, type JiraCommentBinding } from "./jira-comment-binding.js";
import { jiraProjectionTextFits } from "./jira-managed-field-reads.js";
import { jiraCommentProjection, jiraIssueSummary } from "./jira-managed-issue-reads.js";
import { projectJiraCollection, projectJiraOptionalFields } from "./jira-managed-metadata.js";
import { jiraNativeId, jiraNativeNumericId, jiraNativeText } from "./jira-native-values.js";
import { jiraResourceSelfMatches } from "./jira-resource-self.js";

export interface JiraIssueContextBinding extends JiraCommentBinding {
  readonly issueKey: string;
}
/** Supplied membership evidence is compared only; no response URL becomes a destination. */
export function jiraPinnedCommentMembership(value: unknown, binding: JiraIssueContextBinding): boolean {
  const comment = asRecord(asRecord(value)?.comment);
  if (comment?.self === undefined || comment.self === null) return true;
  return jiraNativeId(comment.id) && jiraCommentSelfMatches(comment.self, comment.id, binding);
}
export function jiraRemoteLinkMembership(value: unknown, binding: JiraIssueContextBinding): boolean {
  const raw = asRecord(value);
  if (raw?.self === undefined || raw.self === null) return true;
  const id = jiraNativeNumericId(raw.id);
  return id !== undefined && jiraResourceSelfMatches(raw.self, `issue/${binding.issueId}/remotelink/${id}`);
}
type SubtaskParentBinding = Pick<JiraIssueContextBinding, "issueId" | "issueKey">;
function parentIdMatches(value: unknown, binding: SubtaskParentBinding): boolean {
  return value === undefined || (jiraNativeId(value) && value === binding.issueId);
}
function parentKeyMatches(value: unknown, binding: SubtaskParentBinding): boolean {
  return value === undefined || (isSafeAtlassianIdentifier(value) && value.toUpperCase() === binding.issueKey.toUpperCase());
}
export function jiraSubtaskMembership(value: unknown, binding: SubtaskParentBinding): boolean {
  const parentValue = asRecord(asRecord(value)?.fields)?.parent;
  if (parentValue === undefined || parentValue === null) return true;
  const parent = asRecord(parentValue);
  if (parent === undefined) return false;
  return (parent.id !== undefined || parent.key !== undefined) &&
    parentIdMatches(parent.id, binding) && parentKeyMatches(parent.key, binding);
}

function text(value: unknown, field: string): string | undefined {
  const max = field === "summary" ? 32768 : 255;
  return jiraNativeText(value, max, field === "summary") ? value : undefined;
}
function remoteObject(value: unknown): CatalogJsonObject | undefined {
  if (value === undefined || value === null) return {};
  const raw = asRecord(value);
  if (raw === undefined) return undefined;
  const fields = projectJiraOptionalFields(raw, ["title", "summary"], text);
  if (fields === undefined) return undefined;
  if (raw.status === undefined || raw.status === null) return fields;
  const status = asRecord(raw.status);
  if (status === undefined) return undefined;
  const resolved = projectJiraOptionalFields(status, ["resolved"], (value) => typeof value === "boolean" ? value : undefined);
  return resolved === undefined ? undefined : { ...fields, ...resolved };
}
function remoteField(value: unknown, field: "globalId" | "application" | "relationship"): CatalogJsonValue | undefined {
  if (field !== "application") return jiraNativeText(value, field === "globalId" ? 2048 : 255) ? value : undefined;
  const raw = asRecord(value);
  return raw === undefined ? undefined : projectJiraOptionalFields(raw, ["type", "name"], text);
}
export function jiraRemoteIssueLinkProjection(value: unknown): CatalogJsonObject | undefined {
  const raw = asRecord(value);
  const id = jiraNativeNumericId(raw?.id);
  if (raw === undefined || id === undefined) return undefined;
  const fields = projectJiraOptionalFields(raw, ["globalId", "application", "relationship"], remoteField);
  const object = remoteObject(raw.object);
  return fields === undefined || object === undefined ? undefined : { id, ...fields, ...object };
}
export function jiraPinnedCommentProjection(value: unknown): CatalogJsonObject | undefined {
  const raw = asRecord(value);
  if (raw === undefined || !jiraNativeId(asRecord(raw.comment)?.id)) return undefined;
  const comment = jiraCommentProjection(raw.comment);
  const pin = projectJiraOptionalFields(raw, ["pinnedBy", "pinnedDate"],
    (value, field) => jiraNativeText(value, field === "pinnedDate" ? 64 : 255) ? value : undefined);
  return comment === undefined || pin === undefined ? undefined : { ...comment, ...pin };
}
export function jiraSubtaskProjection(value: unknown, baseUrl: string): CatalogJsonObject | undefined {
  return jiraNativeId(asRecord(value)?.id) ? jiraIssueSummary(value, baseUrl) : undefined;
}
function suggestion(value: unknown, baseUrl: string): CatalogJsonObject | undefined {
  const raw = asRecord(value);
  if (raw === undefined || !isSafeAtlassianIdentifier(raw.key)) return undefined;
  const browseUrl = jiraBrowseUrl(baseUrl, raw.key);
  if (browseUrl === undefined) return undefined;
  const summary = projectJiraOptionalFields(raw, ["summaryText"],
    (value) => jiraNativeText(value, 255, true) ? value : undefined);
  return summary === undefined ? undefined : {
    key: raw.key, browseUrl,
    ...(summary.summaryText === undefined ? {} : { summary: summary.summaryText }),
  };
}
function section(value: unknown, baseUrl: string): CatalogJsonObject | undefined {
  const raw = asRecord(value);
  if (raw === undefined) return undefined;
  const fields = projectJiraOptionalFields(raw, ["id", "label"],
    (value) => jiraNativeText(value, 255) ? value : undefined);
  if (fields === undefined) return undefined;
  if (raw.issues === undefined || raw.issues === null) return fields;
  const values = asArray(raw.issues);
  const issues = values === undefined ? undefined : projectJiraCollection(values, TOOL_CATALOG_LIMITS.maxArrayItems,
    (value) => suggestion(value, baseUrl), "key");
  return issues === undefined ? undefined : { ...fields, issues };
}
export function jiraIssuePickerProjection(value: unknown, baseUrl: string): readonly CatalogJsonObject[] | undefined {
  const sections = asArray(value);
  if (sections === undefined || sections.length > TOOL_CATALOG_LIMITS.maxArrayItems) return undefined;
  const output: CatalogJsonObject[] = [];
  const observedIds = new Set<string>();
  for (const value of sections) {
    const item = section(value, baseUrl);
    if (item === undefined) return undefined;
    if (typeof item.id === "string") {
      if (observedIds.has(item.id)) return undefined;
      observedIds.add(item.id);
    }
    output.push(item);
  }
  return output;
}
function overlongContent(value: unknown, max: number): boolean {
  return typeof value === "string" && (value.length > max || !jiraProjectionTextFits(value));
}
function unsafeNumericId(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && !Number.isSafeInteger(value);
}
export function jiraIssueContextBoundsExceeded(value: unknown): boolean {
  const raw = asRecord(value);
  if (raw === undefined) return false;
  return overlongContent(asRecord(raw.comment)?.body, TOOL_CATALOG_LIMITS.maxStringBytes) ||
    overlongContent(asRecord(raw.object)?.summary, 32768) || unsafeNumericId(raw.id);
}
export function jiraIssuePickerBoundsExceeded(value: unknown): boolean {
  const sections = asArray(value);
  if (sections === undefined) return false;
  return sections.length > TOOL_CATALOG_LIMITS.maxArrayItems || sections.some((value) => {
    const issues = asArray(asRecord(value)?.issues);
    return issues !== undefined && issues.length > TOOL_CATALOG_LIMITS.maxArrayItems;
  });
}
