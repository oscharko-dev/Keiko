import { jiraPropertyUserText, jiraPropertyPathKey, jiraTemplateViolationGuidance } from "@oscharko-dev/keiko-connectors";
import {
  ATLASSIAN_CONNECTOR_WRITE_FAILURE_REASONS,
  JIRA_TEMPLATE_RULE_IDS,
  JIRA_TEMPLATE_VIOLATIONS_MAX,
  isSafeAtlassianIdentifier,
  sanitizeJiraMutationFailureDetail,
  sanitizeJiraMutationLinkAccount,
  type AtlassianConnectorWriteFailureReason,
  type JiraMutationFailureDetail,
  type JiraMutationAttempt,
  type JiraMutationLinkAccount,
  type JiraMutationOperation,
  type JiraMutationOutcome,
  type JiraMutationReceipt,
  type JiraEntityPropertyMutation,
  type JiraMutationResultState,
  type JiraTemplateViolation,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { ManagedMcpToolResult } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import {
  JIRA_SAVED_CONFIGURATION_RECEIPTS,
  isJiraSavedConfigurationOperation,
  validJiraSavedConfigurationReceipt,
  canConfirmJiraSavedConfiguration,
} from "./jiraSavedConfigurationReceipts.js";

/**
 * The shared projection of a Jira mutation attempt onto the managed tool result. Ordinary Chat and
 * Coding runs both end a mutation here, so a receipt or a reason can never mean two things.
 */
const REASONS: ReadonlySet<string> = new Set(ATLASSIAN_CONNECTOR_WRITE_FAILURE_REASONS);
const RULE_IDS: ReadonlySet<string> = new Set(JIRA_TEMPLATE_RULE_IDS);
const RECEIPT_KEYS: ReadonlySet<string> = new Set([
  "issueKey",
  "issueId",
  "commentId",
  "transitionId",
  "attachmentId",
]);
const PROPERTY_RECEIPTS = {
  "jira.set-board-property": ["propertyKey", "propertyPresent", "boardId"],
  "jira.delete-board-property": ["propertyKey", "propertyPresent", "boardId"],
  "jira.set-sprint-property": ["propertyKey", "propertyPresent", "sprintId"],
  "jira.delete-sprint-property": ["propertyKey", "propertyPresent", "sprintId"],
  "jira.set-comment-property": ["propertyKey", "propertyPresent", "issueId", "issueKey", "commentId"],
  "jira.delete-comment-property": ["propertyKey", "propertyPresent", "issueId", "issueKey", "commentId"],
  "jira.set-dashboard-item-property": ["propertyKey", "propertyPresent", "dashboardId", "selectedItemId"],
  "jira.delete-dashboard-item-property": ["propertyKey", "propertyPresent", "dashboardId", "selectedItemId"],
  "jira.set-issue-property": ["propertyKey", "propertyPresent", "issueId", "issueKey"],
  "jira.delete-issue-property": ["propertyKey", "propertyPresent", "issueId", "issueKey"],
  "jira.set-issue-type-property": ["propertyKey", "propertyPresent", "issueTypeId"],
  "jira.delete-issue-type-property": ["propertyKey", "propertyPresent", "issueTypeId"],
  "jira.set-project-property": ["propertyKey", "propertyPresent", "projectId", "projectKey"],
  "jira.delete-project-property": ["propertyKey", "propertyPresent", "projectId", "projectKey"],
  "jira.set-user-property": ["propertyKey", "propertyPresent", "userKey", "username"],
  "jira.delete-user-property": ["propertyKey", "propertyPresent", "userKey", "username"],
} as const satisfies Readonly<Record<JiraEntityPropertyMutation, readonly (keyof JiraMutationReceipt)[]>>;
const MONITORING_RECEIPTS = {
  "jira.set-app-monitoring": ["monitoringEnabled"],
  "jira.set-ipd-monitoring": ["monitoringEnabled"],
  "jira.start-jmx-metrics": ["jmxMetricsExposed"],
  "jira.stop-jmx-metrics": ["jmxMetricsExposed"],
} as const;
type MonitoringOperation = keyof typeof MONITORING_RECEIPTS;
const SCREEN_TAB_RECEIPTS = {
  "jira.create-screen-tab": ["screenId", "tabId"],
  "jira.rename-screen-tab": ["screenId", "tabId"],
  "jira.delete-screen-tab": ["screenId", "tabId"],
} as const;
type ScreenTabOperation = keyof typeof SCREEN_TAB_RECEIPTS;
const AGILE_RECEIPTS = {
  "jira.board-create": ["boardId"],
  "jira.sprint-create": ["sprintId"],
  "jira.sprint-update": ["sprintId"],
  "jira.sprint-move-issues": ["sprintId", "issueKeys"],
  "jira.backlog-move-issues": ["issueKeys"],
  "jira.epic-update": ["epicKey"],
  "jira.epic-move-issues": ["epicKey", "issueKeys"],
} as const;
type AgileOperation = keyof typeof AGILE_RECEIPTS;
const STRUCTURE_RECEIPTS = {
  "jira.create-component": ["componentId"],
  "jira.update-component": ["componentId"],
  "jira.create-version": ["versionId"],
  "jira.update-version": ["versionId"],
} as const;
type StructureOperation = keyof typeof STRUCTURE_RECEIPTS;
const COLLABORATION_RECEIPTS = {
  "jira.create-worklog": ["issueKey", "issueId", "worklogId"],
  "jira.update-worklog": ["issueKey", "issueId", "worklogId"],
  "jira.delete-worklog": ["issueKey", "issueId", "worklogId"],
  "jira.delete-comment": ["issueKey", "issueId", "commentId"],
  "jira.delete-attachment": ["issueKey", "issueId", "attachmentId"],
  "jira.watch": ["issueKey", "issueId", "isWatching"],
  "jira.unwatch": ["issueKey", "issueId", "isWatching"],
  "jira.vote": ["issueKey", "issueId", "hasVoted"],
  "jira.unvote": ["issueKey", "issueId", "hasVoted"],
} as const;
type CollaborationOperation = keyof typeof COLLABORATION_RECEIPTS;
const REQUIRED_RECEIPTS: Readonly<
  Record<JiraMutationOperation, readonly (keyof JiraMutationReceipt)[]>
> = {
  ...JIRA_SAVED_CONFIGURATION_RECEIPTS,
  ...PROPERTY_RECEIPTS,
  ...MONITORING_RECEIPTS,
  ...SCREEN_TAB_RECEIPTS,
  ...AGILE_RECEIPTS,
  ...STRUCTURE_RECEIPTS,
  ...COLLABORATION_RECEIPTS,
  "jira.create-project": ["projectId", "projectKey"],
  "jira.update-project": ["projectId", "projectKey"],
  "jira.create": ["issueKey", "issueId"],
  "jira.edit": ["issueKey"],
  "jira.assign": ["issueKey"],
  "jira.comment": ["issueKey", "commentId"],
  "jira.update-comment": ["issueKey", "commentId"],
  "jira.transition": ["issueKey", "transitionId"],
  "jira.attach": ["issueKey", "attachmentId"],
  // A draft is never one attempt: each item is a journaled jira.create with its own receipt.
  "jira.draft": ["issueKey", "issueId"],
};

function confirmed(value: unknown): boolean {
  return value === true;
}
function propertyOperation(operation: JiraMutationOperation): operation is JiraEntityPropertyMutation {
  return Object.hasOwn(PROPERTY_RECEIPTS, operation);
}
function propertyContextValue(key: keyof JiraMutationReceipt, value: unknown): boolean {
  if (key === "propertyKey") return jiraPropertyPathKey(value);
  if (key === "propertyPresent") return typeof value === "boolean";
  if (key === "issueKey" || key === "projectKey") return isSafeAtlassianIdentifier(value);
  if (key === "userKey" || key === "username")
    return jiraPropertyUserText(value);
  return int64Identity(value);
}
function validPropertyReceipt(receipt: JiraMutationReceipt, operation: JiraEntityPropertyMutation): boolean {
  const keys = PROPERTY_RECEIPTS[operation];
  return Reflect.ownKeys(receipt).length === keys.length &&
    keys.every((key) => {
      const field = Object.getOwnPropertyDescriptor(receipt, key);
      return field !== undefined && "value" in field && propertyContextValue(key, field.value) &&
        (key !== "propertyPresent" || field.value === operation.startsWith("jira.set-"));
    });
}
function monitoringOperation(operation: JiraMutationOperation): operation is MonitoringOperation {
  return Object.hasOwn(MONITORING_RECEIPTS, operation);
}
function validMonitoringReceipt(receipt: JiraMutationReceipt, operation: MonitoringOperation): boolean {
  const [key] = MONITORING_RECEIPTS[operation];
  if (Object.keys(receipt).length !== 1 || typeof receipt[key] !== "boolean") return false;
  if (operation === "jira.start-jmx-metrics") return receipt.jmxMetricsExposed === true;
  if (operation === "jira.stop-jmx-metrics") return receipt.jmxMetricsExposed === false;
  return true;
}
function screenTabOperation(operation: JiraMutationOperation): operation is ScreenTabOperation {
  return Object.hasOwn(SCREEN_TAB_RECEIPTS, operation);
}
function validScreenTabReceipt(receipt: JiraMutationReceipt): boolean {
  return (
    int64Identity(receipt.screenId) &&
    Object.entries(receipt).every(
      ([key, value]) => (key === "screenId" || key === "tabId") && int64Identity(value),
    )
  );
}

const PROJECT_RECEIPT_KEYS = new Set(["projectId", "projectKey", "projectName", "browseUrl"]);
function projectOperation(operation: JiraMutationOperation): boolean {
  return operation === "jira.create-project" || operation === "jira.update-project";
}
function agileOperation(operation: JiraMutationOperation): operation is AgileOperation {
  return Object.hasOwn(AGILE_RECEIPTS, operation);
}
function structureOperation(operation: JiraMutationOperation): operation is StructureOperation {
  return Object.hasOwn(STRUCTURE_RECEIPTS, operation);
}
function collaborationOperation(
  operation: JiraMutationOperation,
): operation is CollaborationOperation {
  return Object.hasOwn(COLLABORATION_RECEIPTS, operation);
}
function int64Identity(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[1-9][0-9]{0,18}$/u.test(value) &&
    BigInt(value) <= 9223372036854775807n
  );
}
function validStructureReceipt(
  receipt: JiraMutationReceipt,
  operation: StructureOperation,
): boolean {
  const keys: ReadonlySet<string> = new Set([
    ...STRUCTURE_RECEIPTS[operation],
    "projectId",
    "projectKey",
  ]);
  const entries = Object.entries(receipt);
  return (
    entries.length > 0 &&
    entries.every(
      ([key, value]) =>
        keys.has(key) &&
        (key === "projectKey" ? isSafeAtlassianIdentifier(value) : int64Identity(value)),
    )
  );
}
function issueKey(value: unknown): value is string {
  return typeof value === "string" && /^[A-Z][A-Z0-9_]{0,31}-[1-9][0-9]{0,15}$/u.test(value);
}
function validCollaborationReceipt(
  receipt: JiraMutationReceipt,
  operation: CollaborationOperation,
): boolean {
  const keys: ReadonlySet<string> = new Set([...COLLABORATION_RECEIPTS[operation], "issueId"]);
  return (
    isSafeAtlassianIdentifier(receipt.issueKey) &&
    Object.entries(receipt).every(([key, value]) => {
      if (!keys.has(key)) return false;
      if (key === "issueKey") return isSafeAtlassianIdentifier(value);
      if (key === "isWatching") return value === (operation === "jira.watch");
      if (key === "hasVoted") return value === (operation === "jira.vote");
      return int64Identity(value);
    })
  );
}
function agileReceiptValue(key: string, value: unknown): boolean {
  if (key === "issueKeys")
    return (
      Array.isArray(value) &&
      value.length > 0 &&
      value.length <= 50 &&
      Array.from(value).every(issueKey) &&
      new Set(value).size === value.length
    );
  if (key === "epicKey") return issueKey(value);
  return (
    typeof value === "string" &&
    /^[1-9][0-9]{0,15}$/u.test(value) &&
    Number.isSafeInteger(Number(value))
  );
}
function agileResultUrl(value: unknown): URL | undefined {
  if (typeof value !== "string" || value.length > 4096 || !URL.canParse(value)) return undefined;
  const url = new URL(value);
  return url.protocol === "https:" && url.username === "" && url.password === "" && url.hash === ""
    ? url
    : undefined;
}
function agileBoardLink(value: unknown, boardId: unknown): boolean {
  const url = agileResultUrl(value);
  return (
    agileReceiptValue("boardId", boardId) &&
    url !== undefined &&
    url.pathname.endsWith("/secure/RapidBoard.jspa") &&
    [...url.searchParams].length === 1 &&
    url.searchParams.get("rapidView") === boardId
  );
}
function optionalAgileReceiptKeys(operation: AgileOperation): readonly string[] {
  if (operation.startsWith("jira.sprint-")) return ["originBoardId", "boardBrowseUrl"];
  return operation === "jira.backlog-move-issues" ? [] : ["browseUrl"];
}
function agileReceiptMember(receipt: JiraMutationReceipt, key: string, value: unknown): boolean {
  if (key === "boardBrowseUrl") return agileBoardLink(value, receipt.originBoardId);
  if (key !== "browseUrl") return agileReceiptValue(key, value);
  if (receipt.boardId !== undefined) return agileBoardLink(value, receipt.boardId);
  const url = agileResultUrl(value);
  return (
    issueKey(receipt.epicKey) &&
    url?.search === "" &&
    url.pathname.endsWith(`/browse/${receipt.epicKey}`)
  );
}
function validAgileReceipt(receipt: JiraMutationReceipt, operation: AgileOperation): boolean {
  const required = AGILE_RECEIPTS[operation];
  const keys: ReadonlySet<string> = new Set([...required, ...optionalAgileReceiptKeys(operation)]);
  return (
    required.every((key) => Object.hasOwn(receipt, key)) &&
    Object.entries(receipt).every(
      ([key, value]) => keys.has(key) && agileReceiptMember(receipt, key, value),
    )
  );
}
function projectLink(value: unknown, key: string | undefined): boolean {
  if (typeof value !== "string" || value.length > 4096 || key === undefined) return false;
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return (
    url.protocol === "https:" &&
    url.username === "" &&
    url.password === "" &&
    url.search === "" &&
    url.hash === "" &&
    url.pathname.endsWith(`/projects/${encodeURIComponent(key)}/summary`)
  );
}
function validProjectReceipt(receipt: JiraMutationReceipt): boolean {
  if (
    !isSafeAtlassianIdentifier(receipt.projectKey) ||
    typeof receipt.projectId !== "string" ||
    !/^[0-9]{1,32}$/u.test(receipt.projectId)
  )
    return false;
  return Object.entries(receipt).every(([key, value]) => {
    if (!PROJECT_RECEIPT_KEYS.has(key)) return false;
    if (key === "projectName")
      return (
        typeof value === "string" &&
        value.length > 0 &&
        value.length <= 255 &&
        !/\p{Cc}/u.test(value)
      );
    if (key === "browseUrl") return projectLink(value, receipt.projectKey);
    return isSafeAtlassianIdentifier(value);
  });
}
function validIdentities(receipt: JiraMutationReceipt, operation: JiraMutationOperation): boolean {
  if (isJiraSavedConfigurationOperation(operation)) return validJiraSavedConfigurationReceipt(receipt, operation);
  if (propertyOperation(operation)) return validPropertyReceipt(receipt, operation);
  if (monitoringOperation(operation)) return validMonitoringReceipt(receipt, operation);
  if (screenTabOperation(operation)) return validScreenTabReceipt(receipt);
  if (projectOperation(operation)) return validProjectReceipt(receipt);
  if (agileOperation(operation)) return validAgileReceipt(receipt, operation);
  if (structureOperation(operation)) return validStructureReceipt(receipt, operation);
  if (collaborationOperation(operation)) return validCollaborationReceipt(receipt, operation);
  return Object.entries(receipt).every(
    ([key, id]) => RECEIPT_KEYS.has(key) && isSafeAtlassianIdentifier(id),
  );
}

function partialReceipt(
  receipt: JiraMutationReceipt | undefined,
  operation: JiraMutationOperation,
): JiraMutationReceipt | undefined {
  return receipt !== undefined &&
    partialIdentity(receipt, operation) &&
    validIdentities(receipt, operation)
    ? snapshotReceipt(receipt)
    : undefined;
}
function partialIdentity(receipt: JiraMutationReceipt, operation: JiraMutationOperation): boolean {
  return (
    isJiraSavedConfigurationOperation(operation) ||
    propertyOperation(operation) ||
    monitoringOperation(operation) ||
    screenTabOperation(operation) ||
    projectOperation(operation) ||
    agileOperation(operation) ||
    structureOperation(operation) ||
    isSafeAtlassianIdentifier(receipt.issueKey)
  );
}
function snapshotReceipt(receipt: JiraMutationReceipt): JiraMutationReceipt {
  const ownIssueKeys = Object.getOwnPropertyDescriptor(receipt, "issueKeys");
  const issueKeys = ownIssueKeys !== undefined && "value" in ownIssueKeys
    ? receipt.issueKeys : undefined;
  return Object.freeze({
    ...receipt,
    ...(issueKeys === undefined
      ? {}
      : { issueKeys: Object.freeze([...issueKeys]) }),
  });
}

/**
 * A failed attempt names the issue only when the issue exists although the attempt did not finish
 * (#4176): the partial effect, with the link account saying what is missing. Both are revalidated
 * here, and an identity that does not validate is dropped, never forwarded.
 */
function failedAttempt(
  value: Extract<JiraMutationAttempt, { ok: false }>,
  operation: JiraMutationOperation,
): Extract<JiraMutationAttempt, { ok: false }> {
  if (!REASONS.has(value.reason)) return { ok: false, reason: "malformed-payload" };
  const detail = sanitizeJiraMutationFailureDetail(value.detail);
  const links = sanitizeJiraMutationLinkAccount(value.links);
  // Only an issue-template refusal carries violations; no other reason may smuggle them in.
  const violations =
    value.reason === "field-validation" ? boundedViolations(value.violations) : undefined;
  const receipt = partialReceipt(value.receipt, operation);
  return {
    ok: false,
    reason: value.reason,
    ...(detail === undefined ? {} : { detail }),
    ...(receipt === undefined ? {} : { receipt }),
    ...(links === undefined ? {} : { links }),
    ...(violations === undefined ? {} : { violations }),
    ...descriptionFormattingFacts(value),
  };
}

/** Internal serializer evidence has a hard count bound and never enters a receipt or model data. */
function descriptionFormattingFacts(
  value: JiraMutationAttempt,
): Pick<JiraMutationAttempt, "descriptionConvertedHeadingCount" | "descriptionProjection"> {
  const count = value.descriptionConvertedHeadingCount;
  const headingCount =
    typeof count === "number" && Number.isInteger(count) && count > 0 && count <= 32768
      ? { descriptionConvertedHeadingCount: count }
      : {};
  return {
    ...headingCount,
    ...(value.descriptionProjection === "supported-markdown"
      ? { descriptionProjection: "supported-markdown" }
      : {}),
  };
}

function boundedViolations(
  value: readonly JiraTemplateViolation[] | undefined,
): readonly JiraTemplateViolation[] | undefined {
  if (value === undefined) return undefined;
  const valid = value
    .filter(
      (item) =>
        RULE_IDS.has(item.ruleId) &&
        typeof item.subject === "string" &&
        typeof item.template === "string",
    )
    .slice(0, JIRA_TEMPLATE_VIOLATIONS_MAX)
    .map(({ ruleId, subject, template }) => ({
      ruleId,
      subject: subject.slice(0, 120),
      template: template.slice(0, 256),
    }));
  return valid.length === 0 ? undefined : valid;
}

/** An attempt is a success only with the validated identities its operation must return. */
export function validJiraMutationAttempt(
  value: JiraMutationAttempt,
  operation: JiraMutationOperation,
): JiraMutationAttempt {
  if (!value.ok) return failedAttempt(value, operation);
  if (isJiraSavedConfigurationOperation(operation) && !validJiraSavedConfigurationReceipt(value.receipt, operation))
    return { ok: false, reason: "malformed-payload" };
  if (!canConfirmJiraSavedConfiguration(operation))
    return failedAttempt({ ok: false, reason: "malformed-payload", receipt: value.receipt }, operation);
  const receipt = Object.freeze({ ...value.receipt });
  const valid =
    confirmed(value.ok) &&
    REQUIRED_RECEIPTS[operation].every((key) => receipt[key] !== undefined) &&
    validIdentities(receipt, operation);
  if (!valid) return { ok: false, reason: "malformed-payload" };
  const links = sanitizeJiraMutationLinkAccount(value.links);
  return {
    ok: true,
    receipt: snapshotReceipt(receipt),
    ...(links === undefined ? {} : { links }),
    ...descriptionFormattingFacts(value),
  };
}

/** Counts only: how many links were requested, present afterwards and missing. */
export interface JiraLinkCounts {
  readonly requested: number;
  readonly created: number;
  readonly failed: number;
}
export function jiraLinkCounts(attempt: JiraMutationAttempt): JiraLinkCounts | undefined {
  const links = attempt.links;
  if (links === undefined) return undefined;
  return {
    requested: links.requested,
    created: links.created,
    failed: links.requested - links.created,
  };
}
/** The same counts, read back from a tool result's data (which already passed `linkData`). */
export function jiraLinkCountsOfResult(
  data: Readonly<Record<string, unknown>> | undefined,
): JiraLinkCounts | undefined {
  const requested = data?.linksRequested;
  const created = data?.linksCreated;
  if (typeof requested !== "number" || typeof created !== "number") return undefined;
  return { requested, created, failed: Math.max(0, requested - created) };
}

function linkData(links: JiraMutationLinkAccount | undefined): Record<string, unknown> {
  if (links === undefined) return {};
  return {
    linksRequested: links.requested,
    linksCreated: links.created,
    ...(links.missing.length === 0
      ? {}
      : { linksMissing: links.missing.map((link) => ({ ...link })) }),
    ...(links.unconfirmed ? { linksUnconfirmed: true } : {}),
  };
}

/**
 * Fixed instructions to the model, never derived from remote text. Keiko's users are knowledge
 * workers, not developers: a refused or uncertain change must end the turn with an answer they can
 * act on, never with a stall or a raw error.
 */
export const JIRA_REJECTED_GUIDANCE =
  "Jira refused this change and nothing was changed. Correct the fields named in fieldErrors (fieldId, fieldName, message) or messages, then send the corrected change once. If Jira refuses it again, tell the user in plain language which field is the problem and what Jira said.";
export const JIRA_EXISTING_GUIDANCE =
  "Nothing was written: the Jira resource identified by this result already exists or already holds these values, as messages say. Report that as the result. Do not send it again, and do not change its fields to create another one.";
/** The journal holds no arguments or results, so a replay cannot repeat the earlier reasons. */
export const JIRA_ALREADY_REFUSED_GUIDANCE =
  "This exact request was refused earlier in this Chat and nothing was changed, so sending it again cannot succeed. Do what the earlier result said instead.";
export const JIRA_UNCERTAIN_GUIDANCE =
  "Whether this change reached Jira is uncertain. Do not repeat it and make no further change in this turn. Tell the user in plain language that the change may or may not have been applied and ask them to check its outcome in Jira before deciding whether to try again.";

/** The instruction a result carries, or undefined when the outcome needs none. */
export function jiraResultGuidance(
  outcome: JiraMutationResultState,
  reason: AtlassianConnectorWriteFailureReason | undefined,
  detail: JiraMutationFailureDetail | undefined,
): string | undefined {
  if (uncertainOutcome(outcome, reason)) return JIRA_UNCERTAIN_GUIDANCE;
  // An adapter independently observed the requested state before attempting any effect.
  if (outcome === "rejected" && reason === "conflict" && detail?.unchanged === true)
    return JIRA_EXISTING_GUIDANCE;
  return outcome === "rejected" && jiraExplained(detail) ? JIRA_REJECTED_GUIDANCE : undefined;
}
function uncertainOutcome(
  outcome: JiraMutationResultState,
  reason: AtlassianConnectorWriteFailureReason | undefined,
): boolean {
  if (outcome === "unknown" || outcome === "succeeded-unconfirmed") return true;
  // A write blocked behind an uncertain one of the same turn is answered like it.
  return outcome === "not-dispatched" && reason === "conflict";
}
function jiraExplained(detail: JiraMutationFailureDetail | undefined): boolean {
  return (detail?.fieldErrors?.length ?? 0) > 0 || (detail?.messages?.length ?? 0) > 0;
}

export function jiraFailureDetailData(
  detail: JiraMutationFailureDetail | undefined,
): Record<string, unknown> {
  if (detail === undefined) return {};
  return {
    ...(detail.unchanged === true ? { unchanged: true } : {}),
    ...(detail.fieldId === undefined ? {} : { fieldId: detail.fieldId }),
    ...(detail.validation === undefined ? {} : { validation: detail.validation }),
    ...(detail.fieldErrors === undefined
      ? {}
      : { fieldErrors: detail.fieldErrors.map((error) => ({ ...error })) }),
    ...(detail.messages === undefined ? {} : { messages: [...detail.messages] }),
  };
}
function toolResultGuidance(
  outcome: JiraMutationResultState,
  reason: AtlassianConnectorWriteFailureReason | undefined,
  replayed: boolean,
  detail: JiraMutationFailureDetail | undefined,
  violations: readonly JiraTemplateViolation[] | undefined,
): string | undefined {
  const guidance = jiraResultGuidance(outcome, reason, detail);
  if (!replayed) return guidance ?? jiraTemplateViolationGuidance(violations ?? []);
  return outcome === "rejected" ? JIRA_ALREADY_REFUSED_GUIDANCE : guidance;
}
export function jiraMutationToolResult(
  outcome: JiraMutationResultState,
  reason?: AtlassianConnectorWriteFailureReason,
  receipt: JiraMutationReceipt = {},
  replayed = false,
  detail?: JiraMutationFailureDetail,
  links?: JiraMutationLinkAccount,
  violations?: readonly JiraTemplateViolation[],
): ManagedMcpToolResult {
  const guidance = toolResultGuidance(outcome, reason, replayed, detail, violations);
  return {
    data: {
      ...receipt,
      outcome,
      ...(guidance === undefined ? {} : { guidance }),
      ...(reason === undefined ? {} : { reason }),
      ...(replayed ? { replayed: true } : {}),
      ...jiraFailureDetailData(detail),
      ...linkData(links),
      ...(violations === undefined ? {} : { violations: violations.map((item) => ({ ...item })) }),
    },
    ...(outcome === "succeeded" ? {} : { isError: true }),
  };
}

/**
 * The receipt is returned on success, and on a failure only when the issue exists (a partial effect
 * of #4176): the model must learn the issue was created and which links are missing, so it repairs
 * the links instead of creating the issue again.
 */
function attemptReceipt(
  outcome: JiraMutationOutcome,
  attempt: JiraMutationAttempt,
): JiraMutationReceipt {
  if (attempt.ok) return outcome === "succeeded" ? attempt.receipt : {};
  return attempt.receipt ?? {};
}
export function jiraAttemptToolResult(
  outcome: JiraMutationOutcome,
  attempt: JiraMutationAttempt,
): ManagedMcpToolResult {
  return jiraMutationToolResult(
    outcome,
    attempt.ok ? undefined : attempt.reason,
    attemptReceipt(outcome, attempt),
    false,
    attempt.ok ? undefined : attempt.detail,
    attempt.links,
    attempt.ok ? undefined : attempt.violations,
  );
}
