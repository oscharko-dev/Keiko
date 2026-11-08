import { jiraPropertyUserText } from "@oscharko-dev/keiko-connectors";
import { JIRA_ATTACHMENT_MAX_BYTES, isSafeAtlassianIdentifier, type JiraMutationOperation, type JiraMutationReceipt,
  type JiraOptionSchemeMutation, type JiraWorkflowSchemeMutation, type JiraInstanceSettingMutation,
  type JiraEmailTemplateMutation } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { TOOL_CATALOG_LIMITS } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";

const SCHEME = ["schemeId", "userKey", "schemePresent"] as const;
const ASSOCIATION = [...SCHEME, "associationChange", "projectIds", "projectKeys"] as const;
const WORKFLOW = [...SCHEME, "workflowSchemeScope"] as const;
const DRAFT = [...WORKFLOW, "draftSchemeId"] as const;
const DEFAULT = [...WORKFLOW, "mappingPresent"] as const;
const DRAFT_DEFAULT = [...DRAFT, "mappingPresent"] as const;
export const JIRA_SCHEME_INSTANCE_RECEIPTS = {
  "jira.create-issue-type-scheme": SCHEME,
  "jira.update-issue-type-scheme": SCHEME,
  "jira.delete-issue-type-scheme": SCHEME,
  "jira.add-issue-type-scheme-projects": ASSOCIATION,
  "jira.set-issue-type-scheme-projects": ASSOCIATION,
  "jira.clear-issue-type-scheme-projects": ASSOCIATION,
  "jira.remove-issue-type-scheme-project": ASSOCIATION,
  "jira.create-priority-scheme": SCHEME,
  "jira.update-priority-scheme": SCHEME,
  "jira.delete-priority-scheme": SCHEME,
  "jira.create-workflow-scheme": WORKFLOW,
  "jira.update-workflow-scheme": WORKFLOW,
  "jira.delete-workflow-scheme": WORKFLOW,
  "jira.create-workflow-scheme-draft": DRAFT,
  "jira.update-workflow-scheme-draft": DRAFT,
  "jira.delete-workflow-scheme-draft": DRAFT,
  "jira.set-workflow-scheme-default": [...DEFAULT, "workflowName"],
  "jira.delete-workflow-scheme-default": DEFAULT,
  "jira.set-workflow-scheme-draft-default": [...DRAFT_DEFAULT, "workflowName"],
  "jira.delete-workflow-scheme-draft-default": DRAFT_DEFAULT,
  "jira.set-workflow-scheme-issue-type": [...DEFAULT, "issueTypeId", "workflowName"],
  "jira.delete-workflow-scheme-issue-type": [...DEFAULT, "issueTypeId"],
  "jira.set-workflow-scheme-draft-issue-type": [...DRAFT_DEFAULT, "issueTypeId", "workflowName"],
  "jira.delete-workflow-scheme-draft-issue-type": [...DRAFT_DEFAULT, "issueTypeId"],
  "jira.set-workflow-scheme-workflow": [...DEFAULT, "workflowName"],
  "jira.delete-workflow-scheme-workflow": [...DEFAULT, "workflowName"],
  "jira.set-workflow-scheme-draft-workflow": [...DRAFT_DEFAULT, "workflowName"],
  "jira.delete-workflow-scheme-draft-workflow": [...DRAFT_DEFAULT, "workflowName"],
  "jira.set-application-property": ["userKey", "propertyKey", "valueDigest"],
  "jira.set-system-columns": ["userKey", "columnIds"],
  "jira.set-instance-base-url": ["userKey", "baseUrlDigest"],
  "jira.set-read-only-mode": ["userKey", "readOnlyEnabled"],
  "jira.upload-email-template-pack": ["userKey", "emailTemplateAction", "uploadSha256", "uploadBytes"],
  "jira.apply-email-template-pack": ["userKey", "emailTemplateAction", "priorManifestSha256"],
  "jira.revert-email-template-pack": ["userKey", "emailTemplateAction", "priorManifestSha256"],
} as const satisfies Readonly<Record<JiraOptionSchemeMutation | JiraWorkflowSchemeMutation | JiraInstanceSettingMutation | JiraEmailTemplateMutation, readonly (keyof JiraMutationReceipt)[]>>;
export type JiraSchemeInstanceOperation = keyof typeof JIRA_SCHEME_INSTANCE_RECEIPTS;
export function isJiraSchemeInstanceOperation(operation: JiraMutationOperation): operation is JiraSchemeInstanceOperation {
  return Object.hasOwn(JIRA_SCHEME_INSTANCE_RECEIPTS, operation);
}
function own(value: object, key: PropertyKey): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && descriptor.enumerable && "value" in descriptor ? descriptor.value : undefined;
}
function id(value: unknown): value is string {
  return typeof value === "string" && /^[1-9][0-9]{0,18}$/u.test(value) && BigInt(value) <= 9223372036854775807n;
}
function digest(value: unknown): boolean { return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value); }
function arrayShape(value: unknown, max: number): value is readonly unknown[] {
  return Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype && value.length <= max &&
    Reflect.ownKeys(value).length === value.length + 1;
}
function strings(value: unknown, kind: "projectIds" | "projectKeys" | "columnIds"): boolean {
  if (!arrayShape(value, kind === "columnIds" ? TOOL_CATALOG_LIMITS.maxArrayItems : 50)) return false;
  if (kind === "columnIds" && value.length === 0) return false;
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index++) {
    const item = own(value, String(index));
    if (!stringItem(item, kind)) return false;
    if (!uniqueItem(item, kind, seen)) return false;
  }
  return true;
}
function stringItem(value: unknown, kind: "projectIds" | "projectKeys" | "columnIds"): value is string {
  if (kind === "projectIds") return id(value);
  return kind === "projectKeys" ? isSafeAtlassianIdentifier(value) : jiraPropertyUserText(value);
}
function uniqueItem(value: string, kind: "projectIds" | "projectKeys" | "columnIds", seen: Set<string>): boolean {
  if (kind === "columnIds") return true;
  const key = kind === "projectKeys" ? value.toLowerCase() : value;
  if (seen.has(key)) return false;
  seen.add(key); return true;
}
const ASSOCIATIONS = {
  "jira.add-issue-type-scheme-projects": "add", "jira.set-issue-type-scheme-projects": "replace",
  "jira.clear-issue-type-scheme-projects": "clear", "jira.remove-issue-type-scheme-project": "remove",
} as const;
function associationOperation(operation: JiraSchemeInstanceOperation): operation is keyof typeof ASSOCIATIONS {
  return Object.hasOwn(ASSOCIATIONS, operation);
}
const ABSENT_SCHEMES: ReadonlySet<JiraSchemeInstanceOperation> = new Set([
  "jira.delete-issue-type-scheme", "jira.delete-priority-scheme", "jira.delete-workflow-scheme", "jira.delete-workflow-scheme-draft",
]);
const EMAIL_ACTIONS = {
  "jira.upload-email-template-pack": "upload", "jira.apply-email-template-pack": "apply", "jira.revert-email-template-pack": "revert",
} as const;
function emailOperation(operation: JiraSchemeInstanceOperation): operation is keyof typeof EMAIL_ACTIONS {
  return Object.hasOwn(EMAIL_ACTIONS, operation);
}
const PROPERTY_KEYS = new Set(["jira.clone.prefix", "jira.option.voting", "jira.option.watching", "jira.option.timetracking"]);
function workflowValue(key: PropertyKey, value: unknown, operation: JiraSchemeInstanceOperation): boolean | undefined {
  if (key === "workflowSchemeScope") return value === (operation.includes("-draft") ? "draft" : "scheme");
  if (key === "mappingPresent") {
    if (operation === "jira.set-workflow-scheme-workflow" || operation === "jira.set-workflow-scheme-draft-workflow") return typeof value === "boolean";
    return value === operation.startsWith("jira.set-");
  }
  if (key === "workflowName") return jiraPropertyUserText(value);
  return undefined;
}
function instanceValue(key: PropertyKey, value: unknown): boolean | undefined {
  if (key === "propertyKey") return typeof value === "string" && PROPERTY_KEYS.has(value);
  if (key === "valueDigest" || key === "baseUrlDigest") return digest(value);
  if (key === "readOnlyEnabled") return typeof value === "boolean";
  return undefined;
}
function emailValue(key: PropertyKey, value: unknown, operation: JiraSchemeInstanceOperation): boolean | undefined {
  if (key === "emailTemplateAction") return emailOperation(operation) && value === EMAIL_ACTIONS[operation];
  if (key === "uploadBytes") return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= JIRA_ATTACHMENT_MAX_BYTES;
  if (key === "uploadSha256" || key === "priorManifestSha256" || key === "observedManifestSha256") return digest(value);
  return undefined;
}
function receiptValue(key: PropertyKey, value: unknown, operation: JiraSchemeInstanceOperation): boolean {
  const specialized = workflowValue(key, value, operation) ?? instanceValue(key, value) ?? emailValue(key, value, operation);
  return specialized ?? commonReceiptValue(key, value, operation);
}
function commonReceiptValue(key: PropertyKey, value: unknown, operation: JiraSchemeInstanceOperation): boolean {
  if (key === "userKey") return jiraPropertyUserText(value);
  if (key === "schemePresent") return value === !ABSENT_SCHEMES.has(operation);
  if (key === "associationChange") return associationOperation(operation) && value === ASSOCIATIONS[operation];
  if (key === "projectIds" || key === "projectKeys" || key === "columnIds") return strings(value, key);
  return id(value);
}
function optionalAcknowledgement(key: PropertyKey, operation: JiraSchemeInstanceOperation): boolean {
  if (operation === "jira.create-workflow-scheme-draft") return key === "draftSchemeId";
  const creates: ReadonlySet<JiraSchemeInstanceOperation> = new Set(["jira.create-issue-type-scheme", "jira.create-priority-scheme", "jira.create-workflow-scheme"]);
  return key === "schemeId" && creates.has(operation);
}
function optionalObservation(key: PropertyKey, operation: JiraSchemeInstanceOperation): boolean {
  return key === "observedManifestSha256" && (operation === "jira.apply-email-template-pack" || operation === "jira.revert-email-template-pack");
}
function allowedKeys(receipt: JiraMutationReceipt, operation: JiraSchemeInstanceOperation): boolean {
  const allowed: readonly PropertyKey[] = JIRA_SCHEME_INSTANCE_RECEIPTS[operation];
  return Reflect.ownKeys(receipt).every((key) =>
    (allowed.includes(key) || optionalObservation(key, operation)) && receiptValue(key, own(receipt, key), operation));
}
function requiredContext(receipt: JiraMutationReceipt, operation: JiraSchemeInstanceOperation): boolean {
  return JIRA_SCHEME_INSTANCE_RECEIPTS[operation].every((key) =>
    own(receipt, key) !== undefined || (!Object.hasOwn(receipt, key) && optionalAcknowledgement(key, operation)));
}
function projectContext(receipt: JiraMutationReceipt, operation: JiraSchemeInstanceOperation): boolean {
  if (!associationOperation(operation)) return true;
  const ids = own(receipt, "projectIds"); const keys = own(receipt, "projectKeys");
  if (!Array.isArray(ids) || !Array.isArray(keys) || ids.length !== keys.length) return false;
  if (ASSOCIATIONS[operation] === "remove") return ids.length === 1;
  return ASSOCIATIONS[operation] !== "add" || ids.length > 0;
}
/** Validate original own data before any spread, including partial ACK and array evidence. */
export function validJiraSchemeInstanceReceipt(receipt: JiraMutationReceipt, operation: JiraSchemeInstanceOperation): boolean {
  const prototype: unknown = Object.getPrototypeOf(receipt);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return allowedKeys(receipt, operation) && requiredContext(receipt, operation) && projectContext(receipt, operation) &&
    Buffer.byteLength(JSON.stringify(receipt), "utf8") <= 16384;
}
const ALWAYS_UNCONFIRMED: ReadonlySet<JiraSchemeInstanceOperation> = new Set([
  "jira.delete-issue-type-scheme", "jira.delete-priority-scheme", ...Object.keys(ASSOCIATIONS).filter(associationName),
  "jira.delete-workflow-scheme", "jira.set-workflow-scheme-default", "jira.delete-workflow-scheme-default",
  "jira.set-workflow-scheme-issue-type", "jira.delete-workflow-scheme-issue-type", "jira.set-workflow-scheme-workflow", "jira.delete-workflow-scheme-workflow",
  "jira.set-instance-base-url", "jira.upload-email-template-pack", "jira.apply-email-template-pack", "jira.revert-email-template-pack",
]);
function associationName(value: string): value is keyof typeof ASSOCIATIONS { return Object.hasOwn(ASSOCIATIONS, value); }
/** Base workflow updates that change defaults/mappings additionally remain unconfirmed in the
 * executor, which owns the reviewed arguments; this receipt never invents deployment evidence. */
export function canConfirmJiraSchemeInstance(operation: JiraMutationOperation): boolean {
  return !isJiraSchemeInstanceOperation(operation) || !ALWAYS_UNCONFIRMED.has(operation);
}
