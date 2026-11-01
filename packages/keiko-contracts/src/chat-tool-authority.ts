import {
  JIRA_MUTATION_OPERATIONS,
  isJiraAttachmentPreview,
  isJiraDraftRef,
  type JiraAttachmentPreview,
  type JiraMutationOperation,
} from "./jira-tool-execution.js";
import { isChatJiraPodId } from "./bff-wire.js";
import { exactKeys, isRecord } from "./contract-validation-primitives.js";
import {
  invalid,
  result,
  validateSafeId,
  validateStrictUtcInstant,
} from "./coding-workbench-runtime-api-validation.js";
import {
  isCodingWorkbenchMode,
  resolveEffectiveCodingWorkbenchMode,
  type CodingWorkbenchBudget,
  type CodingWorkbenchMode,
  type CodingWorkbenchValidationResult,
} from "./coding-workbench.js";

/** Private server facts. A model or browser cannot choose the actor or either generation. */
export interface JiraChatToolAuthoritySubject {
  readonly kind?: never;
  readonly configurationDigest?: never;
  readonly actorDigest: string;
  readonly chatId: string;
  readonly podId: string;
  readonly bindingGeneration: number;
  readonly authenticationGeneration: number;
}

export interface McpChatToolAuthoritySubject {
  readonly kind: "configured-mcp";
  readonly actorDigest: string;
  readonly chatId: string;
  readonly configurationDigest: string;
  readonly podId?: never;
  readonly bindingGeneration?: never;
  readonly authenticationGeneration?: never;
}
export type ChatToolAuthoritySubject = JiraChatToolAuthoritySubject | McpChatToolAuthoritySubject;

/** Ordinary Chat authority has no repository, branch, Editor session or Coding runtime. */
export interface ChatToolAuthorityEnvelope {
  readonly schemaVersion: "1";
  readonly kind: "chat-tool-authority";
  readonly runId: string;
  readonly subject: ChatToolAuthoritySubject;
  readonly requestedMode: CodingWorkbenchMode;
  readonly deploymentCeiling: CodingWorkbenchMode;
  readonly effectiveMode: CodingWorkbenchMode;
  readonly actionClasses: readonly ["connector-access", "network-egress"];
  readonly connectorScopes: readonly ("issue-tracker.read" | "issue-tracker.write" | "mcp.tools")[];
  readonly budget: CodingWorkbenchBudget & { readonly maxPatchBytes: 0 };
  readonly expiresAt: string;
  /** Digest of server-validated human acceptance; never a model-supplied approval. */
  readonly approvalProofDigest: string;
}

const MCP_SUBJECT_KEYS = ["kind", "actorDigest", "chatId", "configurationDigest"] as const;
const SUBJECT_KEYS = [
  "actorDigest",
  "chatId",
  "podId",
  "bindingGeneration",
  "authenticationGeneration",
] as const;
const ENVELOPE_KEYS = [
  "schemaVersion",
  "kind",
  "runId",
  "subject",
  "requestedMode",
  "deploymentCeiling",
  "effectiveMode",
  "actionClasses",
  "connectorScopes",
  "budget",
  "expiresAt",
  "approvalProofDigest",
] as const;
const BUDGET_KEYS = ["maxRuntimeMs", "maxToolCalls", "maxPromptTokens", "maxPatchBytes"] as const;
const CONNECTOR_SCOPES = new Set(["issue-tracker.read", "issue-tracker.write"]);

function validateKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  errors: string[],
  path = "chatAuthority",
): void {
  // The shared key checker names unknown keys. This boundary returns only closed diagnostics.
  if (exactKeys(value, keys, path).length > 0) errors.push(`${path} has unknown fields`);
  if (keys.some((key) => !Object.hasOwn(value, key))) errors.push(`${path} has missing own fields`);
}

function validateDigest(value: unknown, path: string, errors: string[]): void {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))
    errors.push(`${path} must be a SHA-256 digest`);
}

function positiveCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function validateChatToolAuthoritySubject(
  value: unknown,
): CodingWorkbenchValidationResult<ChatToolAuthoritySubject> {
  if (!isRecord(value)) return invalid("chatAuthority.subject must be an object");
  const errors: string[] = [];
  validateKeys(value, value.kind === "configured-mcp" ? MCP_SUBJECT_KEYS : SUBJECT_KEYS, errors);
  validateDigest(value.actorDigest, "chatAuthority.subject.actorDigest", errors);
  validateSafeId(value.chatId, "chatAuthority.subject.chatId", errors, 128);
  if (value.kind === "configured-mcp") {
    validateDigest(value.configurationDigest, "chatAuthority.subject.configurationDigest", errors);
    return result(value, errors);
  }
  if (!isChatJiraPodId(value.podId)) errors.push("chatAuthority.subject.podId is invalid");
  for (const key of ["bindingGeneration", "authenticationGeneration"]) {
    if (!positiveCount(value[key]))
      errors.push(`chatAuthority.subject.${key} must be a positive safe integer`);
  }
  return result(value, errors);
}

function validateModes(value: Record<string, unknown>, errors: string[]): void {
  for (const key of ["requestedMode", "deploymentCeiling", "effectiveMode"]) {
    if (!isCodingWorkbenchMode(value[key])) errors.push(`chatAuthority.${key} is invalid`);
  }
  if (
    value.effectiveMode !==
    resolveEffectiveCodingWorkbenchMode(value.requestedMode, value.deploymentCeiling)
  ) {
    errors.push("chatAuthority.effectiveMode must match the shared mode ceiling");
  }
}

function scopesFor(subject: unknown): ReadonlySet<string> {
  return isRecord(subject) && subject.kind === "configured-mcp"
    ? new Set(["mcp.tools"])
    : CONNECTOR_SCOPES;
}
function validateCapabilities(value: Record<string, unknown>, errors: string[]): void {
  if (
    !Array.isArray(value.actionClasses) ||
    value.actionClasses.length !== 2 ||
    value.actionClasses[0] !== "connector-access" ||
    value.actionClasses[1] !== "network-egress"
  ) {
    errors.push("chatAuthority.actionClasses must contain only connector and network access");
  }
  const scopes: unknown = value.connectorScopes;
  const allowed = scopesFor(value.subject);
  if (
    !Array.isArray(scopes) ||
    scopes.length < 1 ||
    scopes.length > 2 ||
    !scopes.every((scope: unknown) => typeof scope === "string" && allowed.has(scope)) ||
    new Set(scopes).size !== scopes.length
  ) {
    errors.push("chatAuthority.connectorScopes must contain distinct scopes for its subject");
  }
}

function validateBudget(value: unknown, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push("chatAuthority.budget must be an object");
    return;
  }
  validateKeys(value, BUDGET_KEYS, errors);
  for (const key of ["maxRuntimeMs", "maxToolCalls", "maxPromptTokens"]) {
    if (!positiveCount(value[key]))
      errors.push(`chatAuthority.budget.${key} must be a positive safe integer`);
  }
  if (value.maxPatchBytes !== 0) errors.push("chatAuthority.budget.maxPatchBytes must be zero");
}

export function validateChatToolAuthorityEnvelope(
  value: unknown,
): CodingWorkbenchValidationResult<ChatToolAuthorityEnvelope> {
  if (!isRecord(value)) return invalid("chatAuthority must be an object");
  const errors: string[] = [];
  validateKeys(value, ENVELOPE_KEYS, errors);
  if (value.schemaVersion !== "1" || value.kind !== "chat-tool-authority") {
    errors.push("chatAuthority kind or schemaVersion is invalid");
  }
  validateSafeId(value.runId, "chatAuthority.runId", errors, 128);
  const subject = validateChatToolAuthoritySubject(value.subject);
  if (!subject.ok) errors.push(...subject.errors);
  validateModes(value, errors);
  validateCapabilities(value, errors);
  validateBudget(value.budget, errors);
  validateStrictUtcInstant(value.expiresAt, "chatAuthority.expiresAt", errors);
  validateDigest(value.approvalProofDigest, "chatAuthority.approvalProofDigest", errors);
  return result(value, errors);
}

export const CHAT_TOOL_READ_GRANT_STATES = [
  "pending",
  "granted",
  "rejected",
  "expired",
  "revoked",
] as const;
export type ChatToolReadGrantState = (typeof CHAT_TOOL_READ_GRANT_STATES)[number];
export const CHAT_TOOL_READ_DISCLOSURE_VERSION = "jira-chat-read-v1";
export const MCP_CHAT_READ_DISCLOSURE_VERSION = "mcp-chat-read-v1";
type ReadDisclosureVersion =
  typeof CHAT_TOOL_READ_DISCLOSURE_VERSION | typeof MCP_CHAT_READ_DISCLOSURE_VERSION;

interface ChatToolReadGrantFacts {
  readonly schemaVersion: "1";
  readonly kind: "jira-chat-read-grant" | "mcp-chat-read-grant";
  readonly grantId: string;
  readonly subject: ChatToolAuthoritySubject;
  /** Consent covers model transmission and retention in this conversation, not writes or import. */
  readonly disclosureVersion: ReadDisclosureVersion;
  readonly requestedAt: number;
  readonly expiresAt: number;
}

/** Private server record. Browser projections must omit actor facts and acceptance evidence. */
export type ChatToolReadGrant = ChatToolReadGrantFacts &
  (
    | { readonly state: "pending" | "rejected"; readonly consentProofDigest: null }
    | { readonly state: "granted"; readonly consentProofDigest: string }
    | { readonly state: "expired" | "revoked"; readonly consentProofDigest: string | null }
  );

/** Public consent card; private actor, authority and acceptance evidence remain server-owned. */
export interface JiraChatToolReadGrantView {
  readonly kind: "jira-chat-read";
  readonly configurationDigest?: never;
  readonly grantId: string;
  readonly chatId: string;
  readonly podId: string;
  readonly bindingGeneration: number;
  readonly authenticationGeneration: number;
  readonly state: ChatToolReadGrantState;
  readonly disclosureVersion: ReadDisclosureVersion;
  readonly requestedAt: number;
  readonly expiresAt: number;
}

export interface McpChatToolReadGrantView {
  readonly kind: "mcp-chat-read";
  readonly grantId: string;
  readonly chatId: string;
  readonly configurationDigest: string;
  readonly podId?: never;
  readonly bindingGeneration?: never;
  readonly authenticationGeneration?: never;
  readonly state: ChatToolReadGrantState;
  readonly disclosureVersion: typeof MCP_CHAT_READ_DISCLOSURE_VERSION;
  readonly requestedAt: number;
  readonly expiresAt: number;
}
export type ChatToolReadGrantView = JiraChatToolReadGrantView | McpChatToolReadGrantView;

export interface ChatToolReadConsentDecision {
  readonly decision: "approve" | "reject";
  readonly disclosureVersion: ReadDisclosureVersion;
}

export function validateChatToolReadConsentDecision(
  value: unknown,
): CodingWorkbenchValidationResult<ChatToolReadConsentDecision> {
  if (!isRecord(value)) return invalid("chatReadConsent must be an object");
  const errors: string[] = [];
  validateKeys(value, ["decision", "disclosureVersion"], errors, "chatReadConsent");
  if (value.decision !== "approve" && value.decision !== "reject")
    errors.push("chatReadConsent.decision is invalid");
  if (
    value.disclosureVersion !== CHAT_TOOL_READ_DISCLOSURE_VERSION &&
    value.disclosureVersion !== MCP_CHAT_READ_DISCLOSURE_VERSION
  )
    errors.push("chatReadConsent.disclosureVersion is invalid");
  return result(value, errors);
}

const READ_GRANT_KEYS = [
  "schemaVersion",
  "kind",
  "grantId",
  "subject",
  "disclosureVersion",
  "requestedAt",
  "expiresAt",
  "state",
  "consentProofDigest",
] as const;
const READ_GRANT_STATES: ReadonlySet<unknown> = new Set(CHAT_TOOL_READ_GRANT_STATES);

function validateReadGrantState(value: Record<string, unknown>, errors: string[]): void {
  if (!READ_GRANT_STATES.has(value.state)) errors.push("chatReadGrant.state is invalid");
  if (value.state === "granted" || value.consentProofDigest !== null)
    validateDigest(value.consentProofDigest, "chatReadGrant.consentProofDigest", errors);
  if (
    (value.state === "pending" || value.state === "rejected") &&
    value.consentProofDigest !== null
  )
    errors.push("chatReadGrant has unexpected acceptance evidence");
}

function readGrantFamily(subject: unknown): { kind: string; disclosure: ReadDisclosureVersion } {
  return isRecord(subject) && subject.kind === "configured-mcp"
    ? { kind: "mcp-chat-read-grant", disclosure: MCP_CHAT_READ_DISCLOSURE_VERSION }
    : { kind: "jira-chat-read-grant", disclosure: CHAT_TOOL_READ_DISCLOSURE_VERSION };
}
/** Structural validation does not establish consent or extend its lifetime. */
export function validateChatToolReadGrant(
  value: unknown,
): CodingWorkbenchValidationResult<ChatToolReadGrant> {
  if (!isRecord(value)) return invalid("chatReadGrant must be an object");
  const errors: string[] = [];
  validateKeys(value, READ_GRANT_KEYS, errors, "chatReadGrant");
  const family = readGrantFamily(value.subject);
  if (value.schemaVersion !== "1" || value.kind !== family.kind)
    errors.push("chatReadGrant kind or schemaVersion is invalid");
  validateSafeId(value.grantId, "chatReadGrant.grantId", errors, 128);
  if (value.disclosureVersion !== family.disclosure)
    errors.push("chatReadGrant.disclosureVersion is invalid");
  const subject = validateChatToolAuthoritySubject(value.subject);
  if (!subject.ok) errors.push(...subject.errors);
  if (
    !positiveCount(value.requestedAt) ||
    !positiveCount(value.expiresAt) ||
    value.expiresAt <= value.requestedAt
  )
    errors.push("chatReadGrant lifetime is invalid");
  validateReadGrantState(value, errors);
  return result(value, errors);
}

export const CHAT_TOOL_WRITE_APPROVAL_STATES = [
  "pending",
  "approved",
  "claimed",
  "rejected",
  "expired",
  "revoked",
] as const;
export type ChatToolWriteApprovalState = (typeof CHAT_TOOL_WRITE_APPROVAL_STATES)[number];

/** The corresponding stored tool call owns the redacted action preview; private authority stays server-side. */
export interface JiraChatToolWriteApprovalView {
  readonly kind: "jira-chat-write";
  readonly configurationDigest?: never;
  readonly approvalId: string;
  readonly chatId: string;
  readonly podId: string;
  readonly bindingGeneration: number;
  readonly authenticationGeneration: number;
  readonly invocationId: string;
  readonly operation: JiraMutationOperation;
  readonly actionDigest: string;
  readonly requestedAt: number;
  readonly expiresAt: number;
  readonly state: ChatToolWriteApprovalState;
  /** Draft items the human deselected when approving a `jira.draft` (#4178). */
  readonly excludedItemRefs?: readonly string[];
  /**
   * The file a `jira.attach` approval covers, read by the server when the approval was requested:
   * name, size and digest, never content. The upload is refused if the file no longer matches (#4176).
   */
  readonly attachment?: JiraAttachmentPreview;
}
export interface McpChatToolWriteApprovalView {
  readonly kind: "mcp-chat-write";
  readonly approvalId: string;
  readonly chatId: string;
  readonly configurationDigest: string;
  readonly podId?: never;
  readonly bindingGeneration?: never;
  readonly authenticationGeneration?: never;
  readonly invocationId: string;
  readonly operation: string;
  readonly actionDigest: string;
  readonly requestedAt: number;
  readonly expiresAt: number;
  readonly state: ChatToolWriteApprovalState;
}
export type ChatToolWriteApprovalView =
  JiraChatToolWriteApprovalView | McpChatToolWriteApprovalView;

export interface ChatToolWriteApprovalDecision {
  readonly decision: "approve" | "reject";
  readonly actionDigest: string;
  /** Draft items to leave out of an approved `jira.draft`; their dependents follow (#4178). */
  readonly excludedItemRefs?: readonly string[];
}
function validateExcludedItemRefs(value: unknown, path: string, errors: string[]): void {
  if (!Array.isArray(value) || !value.every(isJiraDraftRef) || new Set(value).size !== value.length)
    errors.push(`${path} is invalid`);
}
const WRITE_APPROVAL_KEYS = [
  "kind",
  "approvalId",
  "chatId",
  "podId",
  "bindingGeneration",
  "authenticationGeneration",
  "invocationId",
  "operation",
  "actionDigest",
  "requestedAt",
  "expiresAt",
  "state",
] as const;
const JIRA_APPROVAL_SUBJECT_KEYS = new Set([
  "podId",
  "bindingGeneration",
  "authenticationGeneration",
]);
const MCP_WRITE_APPROVAL_KEYS = [
  ...WRITE_APPROVAL_KEYS.filter((key) => !JIRA_APPROVAL_SUBJECT_KEYS.has(key)),
  "configurationDigest",
];
const WRITE_APPROVAL_STATES: ReadonlySet<unknown> = new Set(CHAT_TOOL_WRITE_APPROVAL_STATES);
const WRITE_OPERATIONS: ReadonlySet<unknown> = new Set(JIRA_MUTATION_OPERATIONS);

function validateWriteApprovalLifetime(value: Record<string, unknown>, errors: string[]): void {
  const keys =
    value.kind === "mcp-chat-write"
      ? ["requestedAt", "expiresAt"]
      : ["bindingGeneration", "authenticationGeneration", "requestedAt", "expiresAt"];
  for (const key of keys)
    if (!positiveCount(value[key])) errors.push(`chatWriteApproval.${key} is invalid`);
  if (
    typeof value.expiresAt === "number" &&
    typeof value.requestedAt === "number" &&
    value.expiresAt <= value.requestedAt
  )
    errors.push("chatWriteApproval lifetime is invalid");
}

function validateWriteApprovalSubject(value: Record<string, unknown>, errors: string[]): void {
  if (value.kind === "mcp-chat-write") {
    validateDigest(value.configurationDigest, "chatWriteApproval.configurationDigest", errors);
    validateSafeId(value.operation, "chatWriteApproval.operation", errors, 256);
  } else {
    if (!isChatJiraPodId(value.podId)) errors.push("chatWriteApproval.podId is invalid");
    if (!WRITE_OPERATIONS.has(value.operation))
      errors.push("chatWriteApproval.operation is invalid");
  }
}
function validateWriteApprovalKeys(
  value: Record<string, unknown>,
  mcp: boolean,
  errors: string[],
): void {
  if (mcp) {
    validateKeys(value, MCP_WRITE_APPROVAL_KEYS, errors, "chatWriteApproval");
    return;
  }
  const excluded = Object.hasOwn(value, "excludedItemRefs");
  const attached = Object.hasOwn(value, "attachment");
  validateKeys(
    value,
    [
      ...WRITE_APPROVAL_KEYS,
      ...(excluded ? ["excludedItemRefs"] : []),
      ...(attached ? ["attachment"] : []),
    ],
    errors,
    "chatWriteApproval",
  );
  if (excluded) {
    validateExcludedItemRefs(value.excludedItemRefs, "chatWriteApproval.excludedItemRefs", errors);
    if (value.operation !== "jira.draft") errors.push("chatWriteApproval.operation is invalid");
  }
  if (attached) {
    if (!isJiraAttachmentPreview(value.attachment))
      errors.push("chatWriteApproval.attachment is invalid");
    if (value.operation !== "jira.attach") errors.push("chatWriteApproval.operation is invalid");
  }
}
export function validateChatToolWriteApprovalView(
  value: unknown,
): CodingWorkbenchValidationResult<ChatToolWriteApprovalView> {
  if (!isRecord(value)) return invalid("chatWriteApproval must be an object");
  const errors: string[] = [];
  const mcp = value.kind === "mcp-chat-write";
  validateWriteApprovalKeys(value, mcp, errors);
  if (!mcp && value.kind !== "jira-chat-write") errors.push("chatWriteApproval.kind is invalid");
  for (const key of ["approvalId", "chatId", "invocationId"])
    validateSafeId(value[key], `chatWriteApproval.${key}`, errors, 128);
  validateWriteApprovalSubject(value, errors);
  validateWriteApprovalLifetime(value, errors);
  if (!WRITE_APPROVAL_STATES.has(value.state)) errors.push("chatWriteApproval.state is invalid");
  validateDigest(value.actionDigest, "chatWriteApproval.actionDigest", errors);
  return result(value, errors);
}
export function validateChatToolWriteApprovalDecision(
  value: unknown,
): CodingWorkbenchValidationResult<ChatToolWriteApprovalDecision> {
  if (!isRecord(value)) return invalid("chatWriteDecision must be an object");
  const errors: string[] = [];
  const excluded = Object.hasOwn(value, "excludedItemRefs");
  validateKeys(
    value,
    excluded ? ["decision", "actionDigest", "excludedItemRefs"] : ["decision", "actionDigest"],
    errors,
    "chatWriteDecision",
  );
  if (value.decision !== "approve" && value.decision !== "reject")
    errors.push("chatWriteDecision.decision is invalid");
  if (excluded) {
    validateExcludedItemRefs(value.excludedItemRefs, "chatWriteDecision.excludedItemRefs", errors);
    if (value.decision !== "approve") errors.push("chatWriteDecision.decision is invalid");
  }
  validateDigest(value.actionDigest, "chatWriteDecision.actionDigest", errors);
  return result(value, errors);
}
