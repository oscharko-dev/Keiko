import {
  isSafeAtlassianIdentifier,
  sanitizeJiraMutationFailureDetail,
  type JiraMutationAttempt,
  type JiraMutationFailureDetail,
  type JiraMutationReceipt,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import {
  TOOL_CATALOG_LIMITS,
  type CatalogJsonObject,
  type CatalogJsonValue,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { canonicalise } from "@oscharko-dev/keiko-security";
import { asRecord } from "./atlassian-sync-classify.js";
import { parseRequirementIds } from "./jira-draft.js";
import { jiraNativeId } from "./jira-native-values.js";
import { jiraResourceSelfMatches } from "./jira-resource-self.js";
import { savedExactKeys, savedText } from "./jira-saved-configuration-values.js";

export interface JiraBulkCreateReceipt extends JiraMutationReceipt {
  readonly userKey: string;
  readonly requestedIssueCount: number;
  readonly bulkFailedElementNumbers?: readonly number[];
  readonly bulkFailureStatuses?: readonly number[];
}
export type JiraBulkCreateFailure = Omit<Extract<JiraMutationAttempt, { ok: false }>, "receipt"> & {
  readonly receipt?: JiraBulkCreateReceipt;
};
export type JiraBulkCreateAttempt =
  JiraBulkCreateFailure | { readonly ok: true; readonly receipt: Record<string, never> };
export interface JiraBulkCreateInput {
  readonly actor: string;
  readonly issues: readonly CatalogJsonObject[];
  readonly requirementIds?: readonly string[];
}
const INPUT_KEYS = new Set([
  "expectedActorKey",
  "issues",
  "requirementIds",
  "confirmUnverifiedEffect",
]);
const ITEM_KEYS = new Set(["projectId", "issueTypeId", "fields", "links"]);
function record(value: CatalogJsonValue): value is CatalogJsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function parseJiraBulkCreateInput(args: CatalogJsonObject): JiraBulkCreateInput | undefined {
  if (
    !savedExactKeys(args, INPUT_KEYS) ||
    !savedText(args.expectedActorKey, 255) ||
    args.confirmUnverifiedEffect !== true
  )
    return undefined;
  const issues = args.issues;
  const references = parseRequirementIds(args.requirementIds);
  if (!Array.isArray(issues) || issues.length < 1 || issues.length > 50 || references === undefined)
    return undefined;
  if (
    new TextEncoder().encode(JSON.stringify(args)).byteLength > TOOL_CATALOG_LIMITS.maxArgumentBytes
  )
    return undefined;
  const values: CatalogJsonObject[] = [];
  const seen = new Set<string>();
  for (const item of issues) {
    if (!record(item) || !savedExactKeys(item, ITEM_KEYS)) return undefined;
    const identity = canonicalise(item);
    if (seen.has(identity)) return undefined;
    seen.add(identity);
    values.push(structuredClone(item));
  }
  return {
    actor: args.expectedActorKey,
    issues: Object.freeze(values),
    ...(references === null ? {} : { requirementIds: Object.freeze([...references]) }),
  };
}
export function bulkCreateReceipt(input: JiraBulkCreateInput): JiraBulkCreateReceipt {
  return Object.freeze({ userKey: input.actor, requestedIssueCount: input.issues.length });
}
/** Reserve the largest possible bounded ACK receipt before the native effect. Both arrays are
 * budgeted at the full request count even though a valid ACK partitions successes and failures. */
export function bulkCreateReceiptFits(input: JiraBulkCreateInput): boolean {
  const count = input.issues.length;
  const maximum = {
    ...bulkCreateReceipt(input),
    issueIds: Array.from({ length: count }, () => "9223372036854775807"),
    issueKeys: Array.from({ length: count }, () => "K".repeat(128)),
    bulkFailedElementNumbers: Array.from({ length: count }, () => 2147483647),
    bulkFailureStatuses: Array.from({ length: count }, () => 599),
  };
  return new TextEncoder().encode(JSON.stringify(maximum)).byteLength <= 16_384;
}
export function bulkCreateRefusal(
  message: string,
  reason: "field-validation" | "conflict" | "unavailable" = "field-validation",
  receipt?: JiraBulkCreateReceipt,
): JiraBulkCreateFailure {
  return {
    ok: false,
    reason,
    detail: { messages: [message] },
    ...(receipt === undefined ? {} : { receipt }),
  };
}
interface CreatedIdentity {
  readonly id: string;
  readonly key: string;
}
function createdIdentity(value: unknown): CreatedIdentity | undefined {
  const raw = asRecord(value);
  if (raw === undefined || !jiraNativeId(raw.id) || !isSafeAtlassianIdentifier(raw.key))
    return undefined;
  if (
    raw.self !== undefined &&
    raw.self !== null &&
    !jiraResourceSelfMatches(raw.self, `issue/${raw.id}`) &&
    !jiraResourceSelfMatches(raw.self, `issue/${raw.key}`)
  )
    return undefined;
  return { id: raw.id, key: raw.key };
}
interface ObservedIssues {
  readonly issues: readonly CreatedIdentity[];
  readonly valid: boolean;
}
function observedIssues(value: unknown, requested: number): ObservedIssues {
  if (!Array.isArray(value) || value.length > requested) return { issues: [], valid: false };
  const issues: CreatedIdentity[] = [];
  const ids = new Set<string>();
  const keys = new Set<string>();
  let valid = true;
  for (const raw of value) {
    const issue = createdIdentity(raw);
    if (issue === undefined || ids.has(issue.id) || keys.has(issue.key.toUpperCase())) {
      valid = false;
      continue;
    }
    ids.add(issue.id);
    keys.add(issue.key.toUpperCase());
    issues.push(issue);
  }
  return { issues, valid };
}
interface BulkFailure {
  readonly element: number;
  readonly status: number;
  readonly detail?: JiraMutationFailureDetail;
}
function errorDetail(value: unknown): JiraMutationFailureDetail | undefined {
  const raw = asRecord(value);
  if (raw === undefined) return undefined;
  const errors = asRecord(raw.errors);
  return sanitizeJiraMutationFailureDetail({
    messages: raw.errorMessages,
    fieldErrors:
      errors === undefined
        ? []
        : Object.entries(errors).map(([fieldId, message]) => ({ fieldId, message })),
  });
}
function bulkFailure(value: unknown): BulkFailure | undefined {
  const raw = asRecord(value);
  if (raw === undefined) return undefined;
  const element = raw.failedElementNumber;
  const status = raw.status;
  if (
    typeof element !== "number" ||
    !Number.isInteger(element) ||
    element < 0 ||
    element > 2147483647
  )
    return undefined;
  if (typeof status !== "number" || !Number.isInteger(status) || status < 400 || status > 599)
    return undefined;
  const detail = errorDetail(raw.elementErrors);
  return { element, status, ...(detail === undefined ? {} : { detail }) };
}
function failures(value: unknown, requested: number): readonly BulkFailure[] | undefined {
  if (!Array.isArray(value) || value.length > requested) return undefined;
  const output: BulkFailure[] = [];
  const seen = new Set<number>();
  for (const raw of value) {
    const failed = bulkFailure(raw);
    if (failed === undefined || seen.has(failed.element)) return undefined;
    seen.add(failed.element);
    output.push(failed);
  }
  return output;
}
function failureDetail(values: readonly BulkFailure[]): JiraMutationFailureDetail | undefined {
  const messages = values.flatMap((entry) => {
    const prefix = `Native failedElementNumber ${String(entry.element)}, status ${String(entry.status)}: `;
    return [
      ...(entry.detail?.messages ?? []).map((message) => `${prefix}${message}`),
      ...(entry.detail?.fieldErrors ?? []).map(
        (error) => `${prefix}${error.fieldId}: ${error.message}`,
      ),
    ];
  });
  return sanitizeJiraMutationFailureDetail({ messages });
}
export interface JiraBulkCreateAcknowledgement {
  readonly receipt: JiraBulkCreateReceipt;
  readonly identities: readonly CreatedIdentity[];
  readonly valid: boolean;
  readonly detail?: JiraMutationFailureDetail;
}
/** Success-array order and native failedElementNumber base are deliberately not interpreted.
 * Bounded valid ACK identities survive a malformed sibling row as known partial context. */
export function jiraBulkCreateAcknowledgement(
  body: Readonly<Record<string, unknown>> | undefined,
  base: JiraBulkCreateReceipt,
): JiraBulkCreateAcknowledgement {
  const created = observedIssues(body?.issues, base.requestedIssueCount);
  const failed = failures(body?.errors, base.requestedIssueCount);
  const detail = failed === undefined ? undefined : failureDetail(failed);
  const receipt = Object.freeze({
    ...base,
    ...(created.issues.length === 0
      ? {}
      : {
          issueIds: Object.freeze(created.issues.map((issue) => issue.id)),
          issueKeys: Object.freeze(created.issues.map((issue) => issue.key)),
        }),
    ...(failed === undefined || failed.length === 0
      ? {}
      : {
          bulkFailedElementNumbers: Object.freeze(failed.map((entry) => entry.element)),
          bulkFailureStatuses: Object.freeze(failed.map((entry) => entry.status)),
        }),
  });
  return {
    receipt,
    identities: created.issues,
    valid:
      created.valid &&
      failed !== undefined &&
      created.issues.length + failed.length === base.requestedIssueCount,
    ...(detail === undefined ? {} : { detail }),
  };
}
