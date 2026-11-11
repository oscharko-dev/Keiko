import {
  TOOL_CATALOG_LIMITS,
  type CatalogJsonObject,
  type CatalogJsonValue,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ManagedMcpToolResult } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { JIRA_READ_TOOL_FAMILIES } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { asArray, asRecord } from "./atlassian-sync-classify.js";
import {
  jiraMaintenanceReindex,
  type JiraMaintenanceProjection,
} from "./jira-maintenance-values.js";
import { boundJiraReadResult } from "./jira-managed-issue-reads.js";
import { jiraReadFailure, projectJiraOptionalFields } from "./jira-managed-metadata.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import { executeJiraSelectedRead, type JiraReadResponse } from "./jira-managed-read-request.js";
import { jiraNativeId, jiraNativeText } from "./jira-native-values.js";
import { deepFreeze } from "@oscharko-dev/keiko-contracts/runtime/deep-freeze";

// These three GETs validate or observe; the native POST scheduling and DELETE unlock are distinct.
// https://docs.atlassian.com/software/jira/docs/api/11.3.3/com/atlassian/jira/rest/v2/user/anonymization/UserAnonymizationResource.html
export const JIRA_ANONYMIZATION_READS = JIRA_READ_TOOL_FAMILIES.anonymization;
type AnonymizationRead = (typeof JIRA_ANONYMIZATION_READS)[number];
interface Selection {
  readonly path: string;
  readonly mode: "validation" | "rerun-validation" | "progress";
  readonly userKey?: string;
  readonly taskId?: string;
}
const MALFORMED = { ok: false, reason: "malformed-payload" } as const;
const BOUNDS = { ok: false, reason: "bounds-exceeded" } as const;
const MAX = TOOL_CATALOG_LIMITS.maxArrayItems;
const VALIDATE_ARGS = new Set(["userKey"]);
const RERUN_ARGS = new Set(["userKey", "oldUserKey", "oldUserName"]);
function nativeText(value: unknown, max: number, empty = false): value is string {
  return jiraNativeText(value, max, empty) && !/\p{Surrogate}/u.test(value);
}
function validationSelection(
  name: AnonymizationRead,
  args: CatalogJsonObject,
): Selection | undefined {
  const rerun = name === "jira.anonymization-rerun-validation";
  const allowed = rerun ? RERUN_ARGS : VALIDATE_ARGS;
  if (Object.keys(args).some((key) => !allowed.has(key)) || !nativeText(args.userKey, 255))
    return undefined;
  const query = new URLSearchParams({ userKey: args.userKey });
  for (const field of ["oldUserKey", "oldUserName"] as const) {
    if (args[field] === undefined) continue;
    if (!nativeText(args[field], 255)) return undefined;
    query.set(field, args[field]);
  }
  return {
    path: `user/anonymization${rerun ? "/rerun" : ""}?${query.toString()}`,
    mode: rerun ? "rerun-validation" : "validation",
    userKey: args.userKey,
  };
}
function selection(name: AnonymizationRead, args: CatalogJsonObject): Selection | undefined {
  if (name !== "jira.anonymization-progress") return validationSelection(name, args);
  if (Object.keys(args).some((key) => key !== "taskId")) return undefined;
  if (args.taskId === undefined) return { path: "user/anonymization/progress", mode: "progress" };
  return jiraNativeId(args.taskId)
    ? {
        path: `user/anonymization/progress?${new URLSearchParams({ taskId: args.taskId }).toString()}`,
        mode: "progress",
        taskId: args.taskId,
      }
    : undefined;
}
function oversizedText(value: unknown, max: number): boolean {
  return typeof value === "string" && value.length > max;
}
function stringList(value: unknown, maxLength: number): readonly string[] | undefined {
  const values = asArray(value);
  return values !== undefined &&
    values.length <= MAX &&
    values.every((entry): entry is string => nativeText(entry, maxLength, true))
    ? values
    : undefined;
}
function listBounds(value: unknown, maxLength: number): boolean {
  const values = asArray(value);
  return (
    values !== undefined &&
    (values.length > MAX || values.some((entry) => oversizedText(entry, maxLength)))
  );
}
function fieldMessages(value: unknown): JiraMaintenanceProjection {
  const raw = asRecord(value);
  if (raw === undefined) return MALFORMED;
  const entries = Object.entries(raw);
  if (entries.length > MAX) return BOUNDS;
  const fields: CatalogJsonObject[] = [];
  for (const [field, message] of entries) {
    if (field.length > 255 || oversizedText(message, 4096)) return BOUNDS;
    if (!nativeText(field, 255) || !nativeText(message, 4096, true)) return MALFORMED;
    fields.push({ field, message });
  }
  return { ok: true, value: { fields } };
}
function optionalFieldMessages(errors: unknown): JiraMaintenanceProjection {
  return errors === undefined || errors === null ? { ok: true, value: {} } : fieldMessages(errors);
}
function diagnosticGroup(operation: string, value: unknown): JiraMaintenanceProjection {
  const raw = asRecord(value);
  if (operation.length > 255 || listBounds(raw?.errorMessages, 4096)) return BOUNDS;
  if (raw === undefined || !nativeText(operation, 255)) return MALFORMED;
  const messages = projectJiraOptionalFields(raw, ["errorMessages"], (entry) =>
    stringList(entry, 4096),
  );
  if (messages === undefined) return MALFORMED;
  const fields = optionalFieldMessages(raw.errors);
  if (!fields.ok) return fields;
  return {
    ok: true,
    value: {
      operation,
      ...fields.value,
      ...(messages.errorMessages === undefined ? {} : { messages: messages.errorMessages }),
    },
  };
}
function diagnosticGroups(value: unknown): JiraMaintenanceProjection {
  const raw = asRecord(value);
  if (raw === undefined) return MALFORMED;
  const entries = Object.entries(raw);
  if (entries.length > MAX) return BOUNDS;
  const groups: CatalogJsonObject[] = [];
  for (const [operation, entry] of entries) {
    const group = diagnosticGroup(operation, entry);
    if (!group.ok) return group;
    groups.push(group.value);
  }
  return { ok: true, value: { groups } };
}
function commonFields(raw: Record<string, unknown>): JiraMaintenanceProjection {
  if (listBounds(raw.operations, 128)) return BOUNDS;
  const operations = projectJiraOptionalFields(raw, ["operations"], (entry) => {
    const values = stringList(entry, 128);
    return values !== undefined &&
      values.every((value) => nativeText(value, 128)) &&
      new Set(values).size === values.length
      ? values
      : undefined;
  });
  if (operations === undefined) return MALFORMED;
  const result: Record<string, CatalogJsonValue> = { ...operations };
  for (const field of ["errors", "warnings"] as const) {
    if (raw[field] === undefined || raw[field] === null) continue;
    const groups = diagnosticGroups(raw[field]);
    if (!groups.ok) return groups;
    const entries = groups.value.groups;
    if (entries === undefined) return MALFORMED;
    result[field] = entries;
  }
  return { ok: true, value: result };
}
export function projectJiraAnonymizationValidation(
  raw: Record<string, unknown>,
  userKey: string,
): JiraMaintenanceProjection {
  if (raw.userKey !== userKey) return MALFORMED;
  if ([raw.userName, raw.displayName].some((value) => oversizedText(value, 255))) return BOUNDS;
  const names = projectJiraOptionalFields(raw, ["userName", "displayName"], (value) =>
    nativeText(value, 255, true) ? value : undefined,
  );
  const flags = projectJiraOptionalFields(
    raw,
    ["deleted", "success", "businessLogicValidationFailed"],
    (value) => (typeof value === "boolean" ? value : undefined),
  );
  if (names === undefined || flags === undefined) return MALFORMED;
  const common = commonFields(raw);
  return common.ok ? { ok: true, value: { ...names, ...flags, ...common.value } } : common;
}
function progress(raw: Record<string, unknown>): JiraMaintenanceProjection {
  if ([raw.userKey, raw.userName, raw.fullName].some((value) => oversizedText(value, 255)))
    return BOUNDS;
  if (oversizedText(raw.status, 128)) return BOUNDS;
  if (!nativeText(raw.userKey, 255)) return MALFORMED;
  const names = projectJiraOptionalFields(raw, ["userName", "fullName"], (value) =>
    nativeText(value, 255, true) ? value : undefined,
  );
  const status = projectJiraOptionalFields(raw, ["status"], (value) =>
    nativeText(value, 128) ? value : undefined,
  );
  const rerun = projectJiraOptionalFields(raw, ["isRerun"], (value) =>
    typeof value === "boolean" ? value : undefined,
  );
  if (names === undefined || status === undefined || rerun === undefined) return MALFORMED;
  const observed = jiraMaintenanceReindex({
    currentProgress: raw.currentProgress,
    currentSubTask: raw.currentSubTask,
    submittedTime: raw.submittedTime,
    startTime: raw.startTime,
    finishTime: raw.finishTime,
  });
  if (!observed.ok) return observed;
  const common = commonFields(raw);
  return common.ok
    ? {
        ok: true,
        value: {
          userKey: raw.userKey,
          ...names,
          ...status,
          ...rerun,
          ...observed.value,
          ...common.value,
        },
      }
    : common;
}
/** Exact documented task facts for human review. The node is an observed owner name, not a
 * process-liveness proof; progressUrl is neither followed nor treated as an independent task ID. */
function completeTaskFacts(raw: Record<string, unknown>): boolean {
  return (
    nativeText(raw.executingNode, 255) &&
    nativeText(raw.submittedTime, 128) &&
    nativeText(raw.status, 128) &&
    typeof raw.isRerun === "boolean" &&
    typeof raw.currentProgress === "number" &&
    Number.isSafeInteger(raw.currentProgress) &&
    Array.isArray(raw.operations)
  );
}
export function projectJiraAnonymizationTaskSnapshot(
  value: unknown,
): CatalogJsonObject | undefined {
  const raw = asRecord(value);
  if (raw === undefined || !completeTaskFacts(raw) || !nativeText(raw.executingNode, 255))
    return undefined;
  const projected = progress(raw);
  if (!projected.ok) return undefined;
  const snapshot: Record<string, CatalogJsonValue> = {
    ...projected.value,
    executingNode: raw.executingNode,
  };
  // A review must not silently turn a supplied null into an absent field. Ordinary read summaries
  // retain their original omission behaviour; this additional snapshot alone is lossless here.
  for (const key of [
    "userName",
    "fullName",
    "currentSubTask",
    "startTime",
    "finishTime",
    "errors",
    "warnings",
  ] as const)
    if (Object.hasOwn(raw, key) && raw[key] === null) snapshot[key] = null;
  return deepFreeze(snapshot);
}
function projectResponse(response: JiraReadResponse, selected: Selection): ManagedMcpToolResult {
  const raw = response.body;
  if (raw === undefined) return jiraReadFailure("malformed-payload");
  let projected: JiraMaintenanceProjection;
  if (selected.mode === "progress") {
    projected = progress(raw);
  } else if (selected.userKey === undefined) {
    projected = MALFORMED;
  } else {
    projected = projectJiraAnonymizationValidation(raw, selected.userKey);
  }

  if (!projected.ok) return jiraReadFailure(projected.reason);
  if (selected.mode !== "progress") {
    if (selected.userKey === undefined) return jiraReadFailure("malformed-payload");
    return boundJiraReadResult({
      data: {
        outcome: "succeeded",
        observationScope: selected.mode,
        userKey: selected.userKey,
        validation: projected.value,
      },
    });
  }
  const reviewSnapshot = projectJiraAnonymizationTaskSnapshot(raw);
  return boundJiraReadResult({
    data: {
      outcome: "succeeded",
      observationScope: "anonymization-progress",
      taskSelection: selected.taskId === undefined ? "active-or-latest" : "selected-task",
      ...(selected.taskId === undefined ? {} : { selectedTaskId: selected.taskId }),
      progress: projected.value,
      ...(reviewSnapshot === undefined ? {} : { reviewSnapshot }),
    },
  });
}
export function isJiraAnonymizationRead(name: string): name is AnonymizationRead {
  return (JIRA_ANONYMIZATION_READS as readonly string[]).includes(name);
}
/** The composing authority owner must require explicit administration before admitting these reads. */
export function executeJiraAnonymizationRead(
  name: AnonymizationRead,
  args: CatalogJsonObject,
  request: JiraMutationRequest,
): Promise<ManagedMcpToolResult> {
  return executeJiraSelectedRead(selection(name, args), request, "json", projectResponse);
}
