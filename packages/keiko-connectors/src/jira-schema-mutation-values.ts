import { isDeepStrictEqual } from "node:util";
import {
  JIRA_SCHEMA_MUTATIONS,
  type JiraSchemaMutation,
  type JiraMutationAttempt,
  type JiraMutationReceipt,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import {
  TOOL_CATALOG_LIMITS,
  type CatalogJsonObject,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";

import { jiraTerminologyProjection } from "./jira-configuration-values.js";
import { jiraFieldDirectoryProjection } from "./jira-managed-field-directory.js";
import { jiraIssueLinkTypeProjection } from "./jira-managed-issue-details.js";
import { jiraMessageRefusal } from "./jira-mutation-failure.js";
import { jiraNativeId } from "./jira-native-values.js";
import { savedExactKeys, savedName, savedText } from "./jira-saved-configuration-values.js";

export { JIRA_SCHEMA_MUTATIONS, type JiraSchemaMutation };
export function isJiraSchemaMutation(name: string): name is JiraSchemaMutation {
  return (JIRA_SCHEMA_MUTATIONS as readonly string[]).includes(name);
}
export type JiraSchemaMutationReceipt = JiraMutationReceipt;
export type SchemaFailure = Extract<JiraMutationAttempt, { readonly ok: false }>;
export type SchemaAttempt = JiraMutationAttempt;
export type SchemaObservation<T> = SchemaFailure | { readonly ok: true; readonly value: T };
export const SCHEMA_MALFORMED: SchemaFailure = { ok: false, reason: "malformed-payload" };
export function schemaRefusal(
  message: string,
  reason: "field-validation" | "conflict" | "unavailable" = "field-validation",
  receipt?: JiraSchemaMutationReceipt,
): SchemaFailure {
  return jiraMessageRefusal(message, reason, receipt);
}
export function schemaUnconfirmed(receipt: JiraSchemaMutationReceipt): SchemaFailure {
  return schemaRefusal(
    "The native request was acknowledged, but the complete configuration or issue-migration consequences cannot be independently established. Known IDs and flags describe the requested target only. Do not repeat the mutation.",
    "unavailable",
    receipt,
  );
}
export function schemaUnchanged(receipt: JiraSchemaMutationReceipt): SchemaFailure {
  return {
    ok: false,
    reason: "conflict",
    detail: {
      unchanged: true,
      messages: [
        "The independently observed configuration already matches the reviewed target; no write was sent.",
      ],
    },
    receipt,
  };
}
export function schemaArgs(
  args: CatalogJsonObject,
  keys: readonly string[],
): args is CatalogJsonObject & { readonly expectedActorKey: string } {
  return (
    savedExactKeys(args, new Set(["expectedActorKey", ...keys])) &&
    savedText(args.expectedActorKey, 255) &&
    new TextEncoder().encode(JSON.stringify(args)).byteLength <=
      TOOL_CATALOG_LIMITS.maxArgumentBytes
  );
}
export const sameSchemaValue = isDeepStrictEqual;
export type { IssueTypeSnapshot } from "./jira-issue-type-values.js";
export { jiraIssueTypeReviewSnapshot as schemaIssueTypeSnapshot } from "./jira-issue-type-values.js";
export interface LinkTypeSnapshot {
  readonly id: string;
  readonly name: string;
  readonly inward: string;
  readonly outward: string;
}
export function schemaLinkTypeSnapshot(value: unknown): LinkTypeSnapshot | undefined {
  const raw = jiraIssueLinkTypeProjection(value);
  if (
    raw === undefined ||
    !jiraNativeId(raw.id) ||
    !savedName(raw.name) ||
    !savedText(raw.inward, 255) ||
    !savedText(raw.outward, 255)
  )
    return undefined;
  return Object.freeze({ id: raw.id, name: raw.name, inward: raw.inward, outward: raw.outward });
}
export interface FieldSnapshot {
  readonly id: string;
  readonly name: string;
  readonly custom: true;
}
export function schemaFieldSnapshot(value: unknown): FieldSnapshot | undefined {
  const field = jiraFieldDirectoryProjection(value);
  if (
    field?.custom !== true ||
    typeof field.id !== "string" ||
    !field.id.startsWith("customfield_")
  )
    return undefined;
  if (!jiraNativeId(field.id.slice(12)) || !savedName(field.name)) return undefined;
  return Object.freeze({ id: field.id, name: field.name, custom: true });
}
export interface TerminologySnapshot {
  readonly originalName: string;
  readonly originalNamePlural: string;
  readonly newName: string;
  readonly newNamePlural: string;
  readonly isDefault: boolean;
}
export function schemaTerminologySnapshot(value: unknown): TerminologySnapshot | undefined {
  const raw = jiraTerminologyProjection(value);
  if (
    raw === undefined ||
    !savedText(raw.originalName, 255) ||
    !savedText(raw.originalNamePlural, 255)
  )
    return undefined;
  if (
    !savedText(raw.newName, 255) ||
    !savedText(raw.newNamePlural, 255) ||
    typeof raw.isDefault !== "boolean"
  )
    return undefined;
  return Object.freeze({
    originalName: raw.originalName,
    originalNamePlural: raw.originalNamePlural,
    newName: raw.newName,
    newNamePlural: raw.newNamePlural,
    isDefault: raw.isDefault,
  });
}
/** Reviewed snapshots accept exactly the same fields as the pure, server-owned projection. */
export function schemaReviewed<T extends object>(
  value: unknown,
  project: (value: unknown) => T | undefined,
): T | undefined {
  const projected = project(value);
  return projected !== undefined && sameSchemaValue(value, projected) ? projected : undefined;
}
export function schemaList<T extends object>(
  value: unknown,
  project: (value: unknown) => T | undefined,
  identity: (item: T) => string,
  max: number = TOOL_CATALOG_LIMITS.maxArrayItems,
): readonly T[] | undefined {
  if (!Array.isArray(value) || value.length > max) return undefined;
  const items: T[] = [];
  const ids = new Set<string>();
  for (const raw of value) {
    const item = project(raw);
    if (item === undefined || ids.has(identity(item))) return undefined;
    ids.add(identity(item));
    items.push(item);
  }
  return Object.freeze(items);
}
export function schemaIdList(value: unknown, max = 50): readonly string[] | undefined {
  return Array.isArray(value) &&
    value.length > 0 &&
    value.length <= max &&
    value.every(jiraNativeId) &&
    new Set(value).size === value.length
    ? Object.freeze([...value])
    : undefined;
}
