import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { TOOL_CATALOG_LIMITS } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type {
  JiraMutationAttempt,
  JiraMutationReceipt,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { canonicalise } from "@oscharko-dev/keiko-security";
import { asRecord } from "./atlassian-sync-classify.js";
import { projectJiraAnonymizationTaskSnapshot } from "./jira-managed-anonymization-reads.js";
import { savedExactKeys, savedName, savedText } from "./jira-saved-configuration-values.js";

export const JIRA_ANONYMIZATION_UNLOCK = "jira.unlock-user-anonymization";
export interface JiraAnonymizationUnlockReceipt extends JiraMutationReceipt {
  readonly actorUserKey: string;
  readonly userKey: string;
  readonly executingNode: string;
  readonly anonymizationSubmittedTime: string;
}
export type UnlockFailure = Omit<Extract<JiraMutationAttempt, { ok: false }>, "receipt"> & {
  readonly receipt?: JiraAnonymizationUnlockReceipt;
};
export type UnlockAttempt =
  UnlockFailure | { readonly ok: true; readonly receipt: JiraAnonymizationUnlockReceipt };
export interface UnlockInput {
  readonly actor: string;
  readonly expectedTask: CatalogJsonObject;
}
const MAX = TOOL_CATALOG_LIMITS.maxArrayItems;
const KEYS = new Set([
  "executingNode",
  "userKey",
  "submittedTime",
  "status",
  "operations",
  "isRerun",
  "currentProgress",
  "userName",
  "fullName",
  "currentSubTask",
  "startTime",
  "finishTime",
  "errors",
  "warnings",
]);
function messages(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX &&
    value.every((message) => savedText(message, 4096, true))
  );
}
function diagnosticFields(value: unknown): Record<string, string> | undefined {
  if (!Array.isArray(value) || value.length > MAX) return undefined;
  const entries: [string, string][] = [];
  for (const item of value) {
    const raw = asRecord(item);
    if (
      raw === undefined ||
      !savedExactKeys(raw, new Set(["field", "message"])) ||
      !savedText(raw.field, 255) ||
      !savedText(raw.message, 4096, true)
    )
      return undefined;
    entries.push([raw.field, raw.message]);
  }
  return new Set(entries.map(([key]) => key)).size === entries.length
    ? Object.fromEntries(entries)
    : undefined;
}
function diagnosticGroup(
  value: unknown,
): { operation: string; native: Record<string, unknown> } | undefined {
  const raw = asRecord(value);
  if (
    raw === undefined ||
    !savedExactKeys(raw, new Set(["operation", "messages", "fields"])) ||
    !savedText(raw.operation, 255)
  )
    return undefined;
  const native: Record<string, unknown> = {};
  if (Object.hasOwn(raw, "messages")) {
    if (!messages(raw.messages)) return undefined;
    native.errorMessages = raw.messages;
  }
  if (Object.hasOwn(raw, "fields")) {
    const fields = diagnosticFields(raw.fields);
    if (fields === undefined) return undefined;
    native.errors = fields;
  }
  return { operation: raw.operation, native };
}
/** Converts only the already projected diagnostics back to the documented native map so the
 * existing pure projector remains the sole string/diagnostic semantics owner. No JSON evaluation. */
function nativeDiagnostics(value: unknown): Record<string, unknown> | null | undefined {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length > MAX) return undefined;
  const entries: [string, Record<string, unknown>][] = [];
  for (const item of value) {
    const group = diagnosticGroup(item);
    if (group === undefined) return undefined;
    entries.push([group.operation, group.native]);
  }
  return new Set(entries.map(([key]) => key)).size === entries.length
    ? Object.fromEntries(entries)
    : undefined;
}
export function jiraAnonymizationTaskInput(value: unknown): CatalogJsonObject | undefined {
  const raw = asRecord(value);
  if (raw === undefined || !savedExactKeys(raw, KEYS)) return undefined;
  const native: Record<string, unknown> = { ...raw };
  for (const key of ["errors", "warnings"] as const) {
    if (!Object.hasOwn(raw, key)) continue;
    // The input is catalog JSON, but this pure boundary also refuses direct non-JSON callers.
    const groups = raw[key];
    if (groups !== null && !Array.isArray(groups)) return undefined;
    const decoded = nativeDiagnostics(groups);
    if (decoded === undefined) return undefined;
    native[key] = decoded;
  }
  const snapshot = projectJiraAnonymizationTaskSnapshot(native);
  return snapshot !== undefined && canonicalise(snapshot) === canonicalise(raw)
    ? snapshot
    : undefined;
}
export function anonymizationUnlockInput(args: CatalogJsonObject): UnlockInput | undefined {
  if (
    !savedExactKeys(args, new Set(["expectedActorKey", "expectedTask"])) ||
    !savedName(args.expectedActorKey)
  )
    return undefined;
  const expectedTask = jiraAnonymizationTaskInput(args.expectedTask);
  return expectedTask === undefined ? undefined : { actor: args.expectedActorKey, expectedTask };
}
export function isJiraAnonymizationUnlock(name: string): name is typeof JIRA_ANONYMIZATION_UNLOCK {
  return name === JIRA_ANONYMIZATION_UNLOCK;
}
