import {
  TOOL_CATALOG_LIMITS,
  type CatalogJsonObject,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { asArray, asRecord } from "./atlassian-sync-classify.js";
import { jiraNativeId, jiraNativeNumericId, jiraNativeText } from "./jira-native-values.js";
import { savedExactKeys, savedName, savedText } from "./jira-saved-configuration-values.js";

export type WorkflowSchemeMapping = { readonly issueTypeId: string; readonly workflow: string };
export type WorkflowSchemeSnapshot = {
  readonly id: string;
  readonly draft: boolean;
  readonly name: string;
  readonly description: string | null;
  readonly defaultWorkflow: string | null;
  readonly mappings: readonly WorkflowSchemeMapping[];
  readonly originalDefaultWorkflow?: string | null;
  readonly originalMappings?: readonly WorkflowSchemeMapping[];
};
/** Existing read projection: null/absence is handled by its caller, not invented here. */
export function jiraWorkflowSchemeMappings(
  value: unknown,
): ReadonlyMap<string, string> | undefined {
  const raw = asRecord(value);
  if (raw === undefined || Object.keys(raw).length > TOOL_CATALOG_LIMITS.maxArrayItems)
    return undefined;
  const result = new Map<string, string>();
  for (const [id, workflow] of Object.entries(raw)) {
    if (!jiraNativeId(id) || !jiraNativeText(workflow, 255)) return undefined;
    result.set(id, workflow);
  }
  return result;
}
function mappingRows(value: unknown): readonly WorkflowSchemeMapping[] | undefined {
  const mapping = jiraWorkflowSchemeMappings(value);
  if (mapping === undefined) return undefined;
  const rows = [...mapping].map(([issueTypeId, workflow]) => ({ issueTypeId, workflow }));
  return rows.every(({ workflow }) => savedText(workflow, 255)) ? freezeMappings(rows) : undefined;
}
function freezeMappings(rows: readonly WorkflowSchemeMapping[]): readonly WorkflowSchemeMapping[] {
  return Object.freeze(
    rows
      .map((row) => Object.freeze({ ...row }))
      .sort((a, b) => a.issueTypeId.localeCompare(b.issueTypeId)),
  );
}
export function workflowSchemeInputMappings(
  value: unknown,
): readonly WorkflowSchemeMapping[] | undefined {
  const rows = asArray(value);
  if (rows === undefined || rows.length > TOOL_CATALOG_LIMITS.maxArrayItems) return undefined;
  const result: WorkflowSchemeMapping[] = [];
  const fields = new Set(["issueTypeId", "workflow"]);
  for (const row of rows) {
    const raw = asRecord(row);
    if (
      raw === undefined ||
      !savedExactKeys(raw, fields) ||
      !jiraNativeId(raw.issueTypeId) ||
      !savedText(raw.workflow, 255)
    )
      return undefined;
    result.push({ issueTypeId: raw.issueTypeId, workflow: raw.workflow });
  }
  return new Set(result.map(({ issueTypeId }) => issueTypeId)).size === result.length
    ? freezeMappings(result)
    : undefined;
}
function nullableText(
  raw: Record<string, unknown>,
  key: string,
  max: number,
  empty: boolean,
): string | null | undefined {
  if (!Object.hasOwn(raw, key)) return undefined;
  const value = raw[key];
  return value === null || savedText(value, max, empty) ? value : undefined;
}
function originals(
  raw: Record<string, unknown>,
): Pick<WorkflowSchemeSnapshot, "originalDefaultWorkflow" | "originalMappings"> | undefined {
  if (raw.draft !== true) return {};
  const originalDefaultWorkflow = nullableText(raw, "originalDefaultWorkflow", 255, false);
  const originalMappings = mappingRows(raw.originalIssueTypeMappings);
  return originalDefaultWorkflow === undefined || originalMappings === undefined
    ? undefined
    : { originalDefaultWorkflow, originalMappings };
}
/** A complete mutation-review fact, separate from permissive ordinary read facts.
 * Configured default:null does NOT describe Jira's non-null effective fallback workflow.
 * Draft IDs come only from the native draft representation; no parent-ID arithmetic.
 */
export function jiraWorkflowSchemeReviewSnapshot(
  value: unknown,
): WorkflowSchemeSnapshot | undefined {
  const raw = asRecord(value);
  if (raw === undefined) return undefined;
  const id = jiraNativeNumericId(raw.id);
  const description = nullableText(raw, "description", 32768, true);
  const defaultWorkflow = nullableText(raw, "defaultWorkflow", 255, false);
  const mappings = mappingRows(raw.issueTypeMappings);
  const prior = originals(raw);
  if (
    id === undefined ||
    !savedName(raw.name) ||
    typeof raw.draft !== "boolean" ||
    description === undefined ||
    defaultWorkflow === undefined ||
    mappings === undefined ||
    prior === undefined
  )
    return undefined;
  return Object.freeze({
    id,
    draft: raw.draft,
    name: raw.name,
    description,
    defaultWorkflow,
    mappings,
    ...prior,
  });
}
const SNAPSHOT_FIELDS = new Set([
  "id",
  "draft",
  "name",
  "description",
  "defaultWorkflow",
  "mappings",
  "originalDefaultWorkflow",
  "originalMappings",
]);
export function workflowSchemeInputSnapshot(
  value: unknown,
  draft: boolean,
): WorkflowSchemeSnapshot | undefined {
  const raw = asRecord(value);
  if (
    raw === undefined ||
    !savedExactKeys(raw, SNAPSHOT_FIELDS) ||
    !jiraNativeId(raw.id) ||
    raw.draft !== draft
  )
    return undefined;
  const mappings = workflowSchemeInputMappings(raw.mappings);
  if (mappings === undefined) return undefined;
  const originalMappings = draft ? workflowSchemeInputMappings(raw.originalMappings) : undefined;
  if (draft && originalMappings === undefined) return undefined;
  if (
    !draft &&
    (Object.hasOwn(raw, "originalMappings") || Object.hasOwn(raw, "originalDefaultWorkflow"))
  )
    return undefined;
  return jiraWorkflowSchemeReviewSnapshot({
    ...raw,
    issueTypeMappings: workflowSchemeNativeMappings(mappings),
    ...(originalMappings === undefined
      ? {}
      : { originalIssueTypeMappings: workflowSchemeNativeMappings(originalMappings) }),
  });
}
export function workflowSchemeNativeMappings(
  mappings: readonly WorkflowSchemeMapping[],
): CatalogJsonObject {
  const result: Record<string, string> = {};
  for (const { issueTypeId, workflow } of mappings) result[issueTypeId] = workflow;
  return result;
}
export function sameWorkflowMappings(
  left: readonly WorkflowSchemeMapping[],
  right: readonly WorkflowSchemeMapping[],
): boolean {
  return (
    left.length === right.length &&
    left.every((row) =>
      right.some(
        (other) => other.issueTypeId === row.issueTypeId && other.workflow === row.workflow,
      ),
    )
  );
}
export function sameWorkflowScheme(
  left: WorkflowSchemeSnapshot,
  right: WorkflowSchemeSnapshot,
): boolean {
  return (
    left.id === right.id &&
    left.draft === right.draft &&
    left.name === right.name &&
    left.description === right.description &&
    left.defaultWorkflow === right.defaultWorkflow &&
    sameWorkflowMappings(left.mappings, right.mappings) &&
    sameOriginals(left, right)
  );
}
function sameOriginals(left: WorkflowSchemeSnapshot, right: WorkflowSchemeSnapshot): boolean {
  if (left.originalDefaultWorkflow !== right.originalDefaultWorkflow) return false;
  if (left.originalMappings === undefined || right.originalMappings === undefined)
    return left.originalMappings === right.originalMappings;
  return sameWorkflowMappings(left.originalMappings, right.originalMappings);
}
