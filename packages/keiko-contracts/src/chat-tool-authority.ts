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
export interface ChatToolAuthoritySubject {
  readonly actorDigest: string;
  readonly chatId: string;
  readonly podId: string;
  readonly bindingGeneration: number;
  readonly authenticationGeneration: number;
}

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
  readonly connectorScopes: readonly ("issue-tracker.read" | "issue-tracker.write")[];
  readonly budget: CodingWorkbenchBudget & { readonly maxPatchBytes: 0 };
  readonly expiresAt: string;
  /** Digest of server-validated human acceptance; never a model-supplied approval. */
  readonly approvalProofDigest: string;
}

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
): void {
  // The shared key checker names unknown keys. This boundary returns only closed diagnostics.
  if (exactKeys(value, keys, "chatAuthority").length > 0)
    errors.push("chatAuthority has unknown fields");
  if (keys.some((key) => !Object.hasOwn(value, key)))
    errors.push("chatAuthority has missing own fields");
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
  validateKeys(value, SUBJECT_KEYS, errors);
  validateDigest(value.actorDigest, "chatAuthority.subject.actorDigest", errors);
  validateSafeId(value.chatId, "chatAuthority.subject.chatId", errors, 128);
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
  if (
    !Array.isArray(scopes) ||
    scopes.length < 1 ||
    scopes.length > 2 ||
    !scopes.every((scope: unknown) => typeof scope === "string" && CONNECTOR_SCOPES.has(scope)) ||
    new Set(scopes).size !== scopes.length
  ) {
    errors.push("chatAuthority.connectorScopes must contain distinct Jira scopes");
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
