import {
  isSafeAtlassianIdentifier,
  type JiraIssueTemplate,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { asRecord } from "./atlassian-sync-classify.js";
import {
  resolveJiraTemplateFieldIds,
  type JiraFieldCatalogEntry,
  type JiraTemplateSubject,
} from "./jira-issue-template-check.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import { readJiraMutationIssue } from "./jira-mutation-confirmation.js";
import { jiraNativeId, jiraNativeText } from "./jira-native-values.js";

interface ParentSelection {
  readonly selector: string;
  readonly id?: string;
  readonly key?: string;
}

/** The same native type facts feed parent admission and the template validation picker. */
export function jiraTemplateNativeIssueType(value: unknown): { id: string; name: string } | undefined {
  const type = asRecord(value);
  if (type === undefined) return undefined;
  return jiraNativeId(type.id) && jiraNativeText(type.name, 255)
    ? { id: type.id, name: type.name } : undefined;
}

function selectedParent(value: unknown): ParentSelection | undefined {
  if (isSafeAtlassianIdentifier(value)) return { selector: value };
  const record = asRecord(value);
  if (record === undefined) return undefined;
  const { id, key } = record;
  if (id !== undefined && !jiraNativeId(id)) return undefined;
  if (key !== undefined && !isSafeAtlassianIdentifier(key)) return undefined;
  if (jiraNativeId(id)) return { selector: id, id, ...(typeof key === "string" ? { key } : {}) };
  return isSafeAtlassianIdentifier(key) ? { selector: key, key } : undefined;
}

async function readParentType(request: JiraMutationRequest, value: unknown) {
  const selected = selectedParent(value);
  if (selected === undefined) return undefined;
  const read = await readJiraMutationIssue(request, selected.selector, ["issuetype"]);
  if (!read.ok || !jiraNativeId(read.id)) return undefined;
  if (selected.id !== undefined && read.id !== selected.id) return undefined;
  if (selected.key !== undefined && read.key?.toUpperCase() !== selected.key.toUpperCase()) return undefined;
  return jiraTemplateNativeIssueType(read.fields.issuetype);
}

/** Fresh parent reads use only the post-write field's bound identity, never embedded type hints. */
export async function bindJiraTemplateParentTypes(
  request: JiraMutationRequest,
  subject: JiraTemplateSubject,
  templates: readonly JiraIssueTemplate[],
  catalog: readonly JiraFieldCatalogEntry[],
): Promise<JiraTemplateSubject> {
  const fieldIds = new Set(templates.flatMap((template) => {
    const { field, issueTypes } = template.parent;
    if (field === undefined || issueTypes === undefined) return [];
    const ids = resolveJiraTemplateFieldIds(field, catalog);
    return ids.length === 1 ? ids : [];
  }));
  const parentIssueTypes = new Map<string, { id: string; name: string }>();
  for (const fieldId of fieldIds) {
    const type = await readParentType(request, subject.fields[fieldId]);
    if (type !== undefined) parentIssueTypes.set(fieldId, type);
  }
  return { ...subject, parentIssueTypes: Object.fromEntries(parentIssueTypes) };
}
