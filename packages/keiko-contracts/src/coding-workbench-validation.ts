import {
  appendValidationIssues,
  isRecord,
  isOneOf,
  validateAllowedKeys,
  validatePhysicalArrayEntries,
} from "./contract-validation-primitives.js";
import { isCodeTaskChildRunId, isCodeTaskSkillId } from "./code-task-auxiliary.js";
import { isCodingWorkbenchEvidenceSafeText } from "./coding-workbench-evidence.js";
import {
  isCodingWorkbenchVerificationSummary,
  validateStrictUtcInstant,
  validateWithAdmission,
} from "./coding-workbench-runtime-api-validation.js";
import { isVerificationKind } from "./editor-verification.js";
import { MODEL_REASONING_EFFORTS } from "./gateway.js";
import {
  CODING_WORKBENCH_ACTION_CLASSES,
  CODING_WORKBENCH_APPROVAL_RISKS,
  CODING_WORKBENCH_AUXILIARY_STATUSES,
  CODING_WORKBENCH_COMMAND_POLICY_MODES,
  CODING_WORKBENCH_CONNECTOR_SCOPES,
  CODING_WORKBENCH_CONTENT_TRUST_VALUES,
  CODING_WORKBENCH_GATES,
  CODING_WORKBENCH_MODEL_SOURCES,
  CODING_WORKBENCH_OPERATOR_DECISIONS,
  CODING_WORKBENCH_MODES,
  CODING_WORKBENCH_MODE_POLICIES,
  CODING_WORKBENCH_NETWORK_MODES,
  CODING_WORKBENCH_OBSERVATION_CHANNELS,
  CODING_WORKBENCH_PERMISSION_REQUEST_KINDS,
  CODING_WORKBENCH_RUNTIME_EVENT_KINDS,
  CODING_WORKBENCH_RUNTIME_HEALTH_STATES,
  CODING_WORKBENCH_RUNTIME_SOURCES,
  CODING_WORKBENCH_SCHEMA_VERSION,
  CODING_WORKBENCH_SUPERVISED_ACTION_KINDS,
  CODING_WORKBENCH_SUPERVISED_POLICY_REASONS,
  permissionKindForSupervisedCodingAction,
  resolveEffectiveCodingWorkbenchMode,
  type CodingWorkbenchAuthorityEnvelope,
  type CodingWorkbenchMode,
  type CodingWorkbenchPermissionRequest,
  type CodingWorkbenchRuntimeEventKind,
  type CodingWorkbenchRuntimeEvent,
  type CodingWorkbenchValidationResult,
  isCodingWorkbenchModeWidening,
  isCodingWorkbenchNativeRetry,
} from "./coding-workbench.js";

const HEX_64_PATTERN = /^[a-f0-9]{64}$/u;
const CODING_WORKBENCH_PERMISSION_REQUEST_KIND_TO_ACTION_CLASS: Readonly<
  Record<
    (typeof CODING_WORKBENCH_PERMISSION_REQUEST_KINDS)[number],
    (typeof CODING_WORKBENCH_ACTION_CLASSES)[number]
  >
> = Object.freeze({
  "workspace-write": "workspace-write",
  "command-execution": "command-execution",
  "network-egress": "network-egress",
  "connector-access": "connector-access",
  "delivery-substrate": "delivery-substrate",
} as const);

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isSafeIntegerOrZero(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isIsoInstant(value: unknown): value is string {
  const errors: string[] = [];
  validateStrictUtcInstant(value, "instant", errors);
  return typeof value === "string" && errors.length === 0;
}

function validateStringArray(
  value: unknown,
  allowed: readonly string[] | undefined,
  path: string,
  errors: string[],
  requireNonEmpty: boolean,
): boolean {
  return validatePhysicalArrayEntries(
    value,
    path,
    errors,
    requireNonEmpty,
    "must be a non-empty string",
    (entry, memberPath, memberErrors): boolean => {
      if (typeof entry !== "string" || entry.length === 0) {
        return appendValidationIssues(memberErrors, `${memberPath} must be a non-empty string`);
      }
      if (allowed !== undefined && !allowed.includes(entry)) {
        return appendValidationIssues(memberErrors, `${memberPath} is invalid`);
      }
      return true;
    },
  );
}

function validateSafeEvidenceTextArray(
  value: unknown,
  path: string,
  errors: string[],
  requireNonEmpty: boolean,
): boolean {
  return validatePhysicalArrayEntries(
    value,
    path,
    errors,
    requireNonEmpty,
    "must be content-free evidence-safe text",
    (entry, memberPath, memberErrors): boolean =>
      validateSafeEvidenceText(entry, memberPath, memberErrors),
  );
}

function validateSafeEvidenceText(value: unknown, path: string, errors: string[]): boolean {
  let valid = true;
  if (!isCodingWorkbenchEvidenceSafeText(value)) {
    valid = [
      appendValidationIssues(errors, `${path} must be content-free evidence-safe text`),
      valid,
    ].every(Boolean);
  }

  return valid;
}

function validateRequiredField(
  record: Record<string, unknown>,
  key: string,
  path: string,
  errors: string[],
  validatePresent: (value: unknown, path: string, errors: string[]) => boolean,
): boolean {
  if (record[key] === undefined) {
    return appendValidationIssues(errors, `${path}.${key} is required`);
  }
  return validatePresent(record[key], `${path}.${key}`, errors);
}

function validateRequiredSafeEvidenceTextField(
  record: Record<string, unknown>,
  key: string,
  path: string,
  errors: string[],
): boolean {
  return validateRequiredField(record, key, path, errors, validateSafeEvidenceText);
}

function validateRequiredEnumField(
  record: Record<string, unknown>,
  key: string,
  allowed: readonly string[],
  path: string,
  errors: string[],
): boolean {
  let valid = true;
  if (record[key] === undefined) {
    valid = [appendValidationIssues(errors, `${path}.${key} is required`), valid].every(Boolean);
    return valid;
  }
  if (!isOneOf(record[key], allowed)) {
    valid = [appendValidationIssues(errors, `${path}.${key} is invalid`), valid].every(Boolean);
  }

  return valid;
}

function validateRequiredSafeIntegerField(
  record: Record<string, unknown>,
  key: string,
  path: string,
  errors: string[],
): boolean {
  let valid = true;
  if (record[key] === undefined) {
    valid = [appendValidationIssues(errors, `${path}.${key} is required`), valid].every(Boolean);
    return valid;
  }
  if (!isSafeIntegerOrZero(record[key])) {
    valid = [
      appendValidationIssues(errors, `${path}.${key} must be a non-negative safe integer`),
      valid,
    ].every(Boolean);
  }

  return valid;
}

function validateRequiredBooleanField(
  record: Record<string, unknown>,
  key: string,
  path: string,
  errors: string[],
): boolean {
  let valid = true;
  if (record[key] === undefined) {
    valid = [appendValidationIssues(errors, `${path}.${key} is required`), valid].every(Boolean);
    return valid;
  }
  if (typeof record[key] !== "boolean") {
    valid = [appendValidationIssues(errors, `${path}.${key} must be a boolean`), valid].every(
      Boolean,
    );
  }

  return valid;
}

function validateRequiredDigestField(
  record: Record<string, unknown>,
  key: string,
  path: string,
  errors: string[],
): boolean {
  return validateRequiredField(record, key, path, errors, validateDigest);
}

function validateDigest(value: unknown, path: string, errors: string[]): boolean {
  let valid = true;
  if (typeof value !== "string" || !HEX_64_PATTERN.test(value)) {
    valid = [
      appendValidationIssues(errors, `${path} must be a 64-character lowercase hex digest`),
      valid,
    ].every(Boolean);
  }

  return valid;
}

function validateWorkspaceIdentity(value: unknown, path: string, errors: string[]): boolean {
  let valid = true;
  if (!isRecord(value)) {
    valid = [appendValidationIssues(errors, `${path} must be an object`), valid].every(Boolean);
    return valid;
  }
  valid = [
    validateAllowedKeys(value, ["workspaceId", "rootLabel", "rootDigest"], path, errors),
    valid,
  ].every(Boolean);
  valid = [validateRequiredSafeEvidenceTextField(value, "workspaceId", path, errors), valid].every(
    Boolean,
  );
  valid = [validateSafeEvidenceText(value.rootLabel, `${path}.rootLabel`, errors), valid].every(
    Boolean,
  );
  valid = [validateDigest(value.rootDigest, `${path}.rootDigest`, errors), valid].every(Boolean);

  return valid;
}

function validateBranchConstraints(value: unknown, path: string, errors: string[]): boolean {
  let valid = true;
  if (!isRecord(value)) {
    valid = [appendValidationIssues(errors, `${path} must be an object`), valid].every(Boolean);
    return valid;
  }
  valid = [
    validateAllowedKeys(
      value,
      ["baseRef", "headRef", "allowDetachedHead", "allowedPrefixes"],
      path,
      errors,
    ),
    valid,
  ].every(Boolean);
  valid = [validateSafeEvidenceText(value.baseRef, `${path}.baseRef`, errors), valid].every(
    Boolean,
  );
  valid = [validateSafeEvidenceText(value.headRef, `${path}.headRef`, errors), valid].every(
    Boolean,
  );
  if (typeof value.allowDetachedHead !== "boolean") {
    valid = [
      appendValidationIssues(errors, `${path}.allowDetachedHead must be a boolean`),
      valid,
    ].every(Boolean);
  }
  valid = [
    validateSafeEvidenceTextArray(value.allowedPrefixes, `${path}.allowedPrefixes`, errors, true),
    valid,
  ].every(Boolean);

  return valid;
}

function validateModelProfile(value: unknown, path: string, errors: string[]): boolean {
  let valid = true;
  if (!isRecord(value)) {
    valid = [appendValidationIssues(errors, `${path} must be an object`), valid].every(Boolean);
    return valid;
  }
  valid = [
    validateAllowedKeys(
      value,
      ["profileId", "source", "supportsStreaming", "supportsToolCalling", "reasoningEffort"],
      path,
      errors,
    ),
    valid,
  ].every(Boolean);
  valid = [validateSafeEvidenceText(value.profileId, `${path}.profileId`, errors), valid].every(
    Boolean,
  );
  if (!isOneOf(value.source, CODING_WORKBENCH_MODEL_SOURCES)) {
    valid = [appendValidationIssues(errors, `${path}.source is invalid`), valid].every(Boolean);
  }
  if (typeof value.supportsStreaming !== "boolean") {
    valid = [
      appendValidationIssues(errors, `${path}.supportsStreaming must be a boolean`),
      valid,
    ].every(Boolean);
  }
  if (typeof value.supportsToolCalling !== "boolean") {
    valid = [
      appendValidationIssues(errors, `${path}.supportsToolCalling must be a boolean`),
      valid,
    ].every(Boolean);
  }
  if (
    value.reasoningEffort !== undefined &&
    !isOneOf(value.reasoningEffort, MODEL_REASONING_EFFORTS)
  ) {
    valid = [appendValidationIssues(errors, `${path}.reasoningEffort is invalid`), valid].every(
      Boolean,
    );
  }

  return valid;
}

function validateCommandPolicy(value: unknown, path: string, errors: string[]): boolean {
  let valid = true;
  if (!isRecord(value)) {
    valid = [appendValidationIssues(errors, `${path} must be an object`), valid].every(Boolean);
    return valid;
  }
  valid = [
    validateAllowedKeys(
      value,
      ["mode", "allow", "deny", "maxCommandTimeoutMs", "requirePerCommandApproval"],
      path,
      errors,
    ),
    valid,
  ].every(Boolean);
  if (!isOneOf(value.mode, CODING_WORKBENCH_COMMAND_POLICY_MODES)) {
    valid = [appendValidationIssues(errors, `${path}.mode is invalid`), valid].every(Boolean);
  }
  valid = [validateSafeEvidenceTextArray(value.allow, `${path}.allow`, errors, false), valid].every(
    Boolean,
  );
  if (value.mode === "deny" && Array.isArray(value.allow) && value.allow.length > 0) {
    valid = [
      appendValidationIssues(errors, `${path}.allow must be empty when mode is deny`),
      valid,
    ].every(Boolean);
  }
  valid = [validateSafeEvidenceTextArray(value.deny, `${path}.deny`, errors, false), valid].every(
    Boolean,
  );
  if (!isPositiveSafeInteger(value.maxCommandTimeoutMs)) {
    valid = [
      appendValidationIssues(errors, `${path}.maxCommandTimeoutMs must be a positive safe integer`),
      valid,
    ].every(Boolean);
  }
  if (typeof value.requirePerCommandApproval !== "boolean") {
    valid = [
      appendValidationIssues(errors, `${path}.requirePerCommandApproval must be a boolean`),
      valid,
    ].every(Boolean);
  }

  return valid;
}

function validateNetworkPolicy(value: unknown, path: string, errors: string[]): boolean {
  let valid = true;
  if (!isRecord(value)) {
    valid = [appendValidationIssues(errors, `${path} must be an object`), valid].every(Boolean);
    return valid;
  }
  valid = [
    validateAllowedKeys(value, ["mode", "allowLoopback", "connectorScopes"], path, errors),
    valid,
  ].every(Boolean);
  if (!isOneOf(value.mode, CODING_WORKBENCH_NETWORK_MODES)) {
    valid = [appendValidationIssues(errors, `${path}.mode is invalid`), valid].every(Boolean);
  }
  if (typeof value.allowLoopback !== "boolean") {
    valid = [
      appendValidationIssues(errors, `${path}.allowLoopback must be a boolean`),
      valid,
    ].every(Boolean);
  }
  if (value.mode === "deny-all" && value.allowLoopback === true) {
    valid = [
      appendValidationIssues(errors, `${path}.allowLoopback must be false when mode is deny-all`),
      valid,
    ].every(Boolean);
  }
  valid = [
    validateStringArray(
      value.connectorScopes,
      CODING_WORKBENCH_CONNECTOR_SCOPES,
      `${path}.connectorScopes`,
      errors,
      false,
    ),
    valid,
  ].every(Boolean);

  return valid;
}

function validateBudget(value: unknown, path: string, errors: string[]): boolean {
  let valid = true;
  if (!isRecord(value)) {
    valid = [appendValidationIssues(errors, `${path} must be an object`), valid].every(Boolean);
    return valid;
  }
  valid = [
    validateAllowedKeys(
      value,
      ["maxRuntimeMs", "maxToolCalls", "maxPromptTokens", "maxPatchBytes"],
      path,
      errors,
    ),
    valid,
  ].every(Boolean);
  ["maxRuntimeMs", "maxToolCalls", "maxPromptTokens", "maxPatchBytes"].forEach((key) => {
    if (!isPositiveSafeInteger(value[key])) {
      valid = [
        appendValidationIssues(errors, `${path}.${key} must be a positive safe integer`),
        valid,
      ].every(Boolean);
    }
  });

  return valid;
}

function validateModePolicyConsistency(
  effectiveMode: CodingWorkbenchMode | undefined,
  actionClasses: unknown,
  path: string,
  errors: string[],
): boolean {
  let valid = true;
  if (effectiveMode === undefined || !Array.isArray(actionClasses)) return valid;
  const allowed: readonly string[] =
    CODING_WORKBENCH_MODE_POLICIES[effectiveMode].allowedActionClasses;
  actionClasses.forEach((entry, index) => {
    if (typeof entry === "string" && !allowed.includes(entry)) {
      valid = [
        appendValidationIssues(errors, `${path}[${String(index)}] exceeds the effective mode`),
        valid,
      ].every(Boolean);
    }
  });

  return valid;
}

function validateNetworkPolicyActionClassConsistency(
  value: Record<string, unknown>,
  errors: string[],
): boolean {
  let valid = true;
  if (!Array.isArray(value.actionClasses) || !isRecord(value.networkPolicy)) return valid;
  const hasNetworkEgress = value.actionClasses.includes("network-egress");
  const networkPolicyMode = value.networkPolicy.mode;
  if (networkPolicyMode !== "deny-all" && !hasNetworkEgress) {
    valid = [
      appendValidationIssues(
        errors,
        "authorityEnvelope.actionClasses must include network-egress when authorityEnvelope.networkPolicy.mode is not deny-all",
      ),
      valid,
    ].every(Boolean);
  }
  if (hasNetworkEgress) return valid;
  if (networkPolicyMode !== "deny-all") {
    valid = [
      appendValidationIssues(
        errors,
        "authorityEnvelope.networkPolicy.mode must be deny-all when authorityEnvelope.actionClasses omits network-egress",
      ),
      valid,
    ].every(Boolean);
  }
  if (value.networkPolicy.allowLoopback !== false) {
    valid = [
      appendValidationIssues(
        errors,
        "authorityEnvelope.networkPolicy.allowLoopback must be false when authorityEnvelope.actionClasses omits network-egress",
      ),
      valid,
    ].every(Boolean);
  }
  if (
    Array.isArray(value.networkPolicy.connectorScopes) &&
    value.networkPolicy.connectorScopes.length > 0
  ) {
    valid = [
      appendValidationIssues(
        errors,
        "authorityEnvelope.networkPolicy.connectorScopes must be empty when authorityEnvelope.actionClasses omits network-egress",
      ),
      valid,
    ].every(Boolean);
  }

  return valid;
}

function validateConnectorScopeActionClassConsistency(
  value: Record<string, unknown>,
  errors: string[],
): boolean {
  let valid = true;
  if (
    !Array.isArray(value.connectorScopes) ||
    value.connectorScopes.length === 0 ||
    !Array.isArray(value.actionClasses)
  ) {
    return valid;
  }
  if (!value.actionClasses.includes("connector-access")) {
    valid = [
      appendValidationIssues(
        errors,
        "authorityEnvelope.connectorScopes must be empty when authorityEnvelope.actionClasses omits connector-access",
      ),
      valid,
    ].every(Boolean);
  }

  return valid;
}

function hasWriteCapableConnectorScope(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.some((scope) => typeof scope === "string" && scope.endsWith(".write"))
  );
}

function hasHumanApprovalRequiredActionClass(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  const actionClasses: readonly unknown[] = value;
  return (
    actionClasses.includes("workspace-write") ||
    actionClasses.includes("command-execution") ||
    actionClasses.includes("network-egress") ||
    actionClasses.includes("delivery-substrate")
  );
}

function hasHumanApprovalRequiredConnectorScope(value: Record<string, unknown>): boolean {
  return (
    hasWriteCapableConnectorScope(value.connectorScopes) ||
    hasWriteCapableConnectorScope(
      isRecord(value.networkPolicy) ? value.networkPolicy.connectorScopes : undefined,
    )
  );
}

function validateHumanApprovalGateBinding(
  value: Record<string, unknown>,
  errors: string[],
): boolean {
  let valid = true;
  if (!Array.isArray(value.gates) || !Array.isArray(value.actionClasses)) return valid;
  const requiresHumanApproval =
    hasHumanApprovalRequiredActionClass(value.actionClasses) ||
    hasHumanApprovalRequiredConnectorScope(value);
  if (requiresHumanApproval && !value.gates.includes("human-approval")) {
    valid = [
      appendValidationIssues(
        errors,
        "authorityEnvelope.gates must include human-approval when authorityEnvelope.actionClasses or connector scopes grant elevated authority",
      ),
      valid,
    ].every(Boolean);
  }

  return valid;
}

function validateCommandPolicyActionClassConsistency(
  value: Record<string, unknown>,
  errors: string[],
): boolean {
  let valid = true;
  if (!Array.isArray(value.actionClasses) || !isRecord(value.commandPolicy)) return valid;
  if (value.actionClasses.includes("command-execution")) return valid;
  if (value.commandPolicy.mode !== "deny") {
    valid = [
      appendValidationIssues(
        errors,
        "authorityEnvelope.commandPolicy.mode must be deny when authorityEnvelope.actionClasses omits command-execution",
      ),
      valid,
    ].every(Boolean);
  }
  if (Array.isArray(value.commandPolicy.allow) && value.commandPolicy.allow.length > 0) {
    valid = [
      appendValidationIssues(
        errors,
        "authorityEnvelope.commandPolicy.allow must be empty when authorityEnvelope.actionClasses omits command-execution",
      ),
      valid,
    ].every(Boolean);
  }

  return valid;
}

function validatePermissionRequestKindActionClassConsistency(
  value: Record<string, unknown>,
  path: string,
  errors: string[],
): boolean {
  let valid = true;
  if (
    isOneOf(value.kind, CODING_WORKBENCH_PERMISSION_REQUEST_KINDS) &&
    isOneOf(value.actionClass, CODING_WORKBENCH_ACTION_CLASSES) &&
    CODING_WORKBENCH_PERMISSION_REQUEST_KIND_TO_ACTION_CLASS[value.kind] !== value.actionClass
  ) {
    valid = [
      appendValidationIssues(
        errors,
        `${path}.kind must match ${path}.actionClass for the shared action classes`,
      ),
      valid,
    ].every(Boolean);
  }

  return valid;
}

function validatePermissionRequestSupervisedConsistency(
  value: Record<string, unknown>,
  path: string,
  errors: string[],
): boolean {
  let valid = true;
  if (!isOneOf(value.actionKind, CODING_WORKBENCH_SUPERVISED_ACTION_KINDS)) return valid;
  const expected = permissionKindForSupervisedCodingAction(value.actionKind);
  if (value.kind !== expected || value.actionClass !== expected) {
    valid = [
      appendValidationIssues(
        errors,
        `${path}.actionKind must match ${path}.kind and ${path}.actionClass`,
      ),
      valid,
    ].every(Boolean);
  }
  valid = [validatePermissionRequestSupervisedConnectorScopes(value, path, errors), valid].every(
    Boolean,
  );

  return valid;
}

function validatePermissionRequestSupervisedConnectorScopes(
  value: Record<string, unknown>,
  path: string,
  errors: string[],
): boolean {
  let valid = true;
  const connectorAction =
    value.actionKind === "connector-write" || value.actionKind === "external-write";
  if (!connectorAction) return valid;
  if (!Array.isArray(value.connectorScopes) || value.connectorScopes.length === 0) {
    valid = [
      appendValidationIssues(
        errors,
        `${path}.connectorScopes is required for ${String(value.actionKind)}`,
      ),
      valid,
    ].every(Boolean);
    return valid;
  }
  value.connectorScopes.forEach((scope, index) => {
    if (typeof scope === "string" && !scope.endsWith(".write")) {
      valid = [
        appendValidationIssues(
          errors,
          `${path}.connectorScopes[${String(index)}] must be write-capable for ${String(value.actionKind)}`,
        ),
        valid,
      ].every(Boolean);
    }
  });

  return valid;
}

function validatePermissionRequestConnectorScopes(
  value: Record<string, unknown>,
  path: string,
  errors: string[],
): boolean {
  let valid = true;
  if (
    isOneOf(value.kind, CODING_WORKBENCH_PERMISSION_REQUEST_KINDS) &&
    value.kind === "connector-access"
  ) {
    if (value.connectorScopes === undefined) {
      valid = [appendValidationIssues(errors, `${path}.connectorScopes is required`), valid].every(
        Boolean,
      );
      return valid;
    }
    valid = [
      validateStringArray(
        value.connectorScopes,
        CODING_WORKBENCH_CONNECTOR_SCOPES,
        `${path}.connectorScopes`,
        errors,
        true,
      ),
      valid,
    ].every(Boolean);
    return valid;
  }
  if (value.connectorScopes !== undefined) {
    valid = [
      appendValidationIssues(
        errors,
        `${path}.connectorScopes is only allowed for connector-access requests`,
      ),
      valid,
    ].every(Boolean);
  }

  return valid;
}

function validatePermissionRequestOptionalFields(
  value: Record<string, unknown>,
  path: string,
  errors: string[],
): boolean {
  let valid = true;
  valid = [validateSafeEvidenceText(value.reasonCode, `${path}.reasonCode`, errors), valid].every(
    Boolean,
  );
  valid = [validatePermissionRequestSupervisedFields(value, path, errors), valid].every(Boolean);
  valid = [validatePermissionRequestConnectorScopes(value, path, errors), valid].every(Boolean);
  const exactVerifier =
    value.actionKind === "verification-command" && isVerificationKind(value.commandLabel);
  if (value.commandLabel !== undefined && !exactVerifier) {
    valid = [
      validateSafeEvidenceText(value.commandLabel, `${path}.commandLabel`, errors),
      valid,
    ].every(Boolean);
  }
  valid = [validateNativePermission(value, path, errors), valid].every(Boolean);
  if (!isIsoInstant(value.expiresAt)) {
    valid = [
      appendValidationIssues(errors, `${path}.expiresAt must be an ISO-8601 UTC instant`),
      valid,
    ].every(Boolean);
  }

  return valid;
}

/**
 * A native OpenCode ask's permission name (#3897): a short lowercase OpenCode identifier, never
 * combined with a supervised Keiko action kind.
 */
function validateNativePermission(
  value: Record<string, unknown>,
  path: string,
  errors: string[],
): boolean {
  if (value.nativePermission === undefined) return true;
  if (
    typeof value.nativePermission !== "string" ||
    !/^[a-z][a-z_]{0,31}$/u.test(value.nativePermission)
  ) {
    errors.push(`${path}.nativePermission is invalid`);
    return false;
  } else if (value.actionKind !== undefined) {
    errors.push(`${path}.nativePermission cannot accompany an actionKind`);
    return false;
  }
  return true;
}

function validatePermissionRequestSupervisedFields(
  value: Record<string, unknown>,
  path: string,
  errors: string[],
): boolean {
  let valid = true;
  if (
    value.actionKind !== undefined &&
    !isOneOf(value.actionKind, CODING_WORKBENCH_SUPERVISED_ACTION_KINDS)
  ) {
    valid = [appendValidationIssues(errors, `${path}.actionKind is invalid`), valid].every(Boolean);
  }
  if (value.scopeLabel !== undefined) {
    valid = [validateSafeEvidenceText(value.scopeLabel, `${path}.scopeLabel`, errors), valid].every(
      Boolean,
    );
  }
  if (value.risk !== undefined && !isOneOf(value.risk, CODING_WORKBENCH_APPROVAL_RISKS)) {
    valid = [appendValidationIssues(errors, `${path}.risk is invalid`), valid].every(Boolean);
  }
  if (
    value.policyReason !== undefined &&
    !isOneOf(value.policyReason, CODING_WORKBENCH_SUPERVISED_POLICY_REASONS)
  ) {
    valid = [appendValidationIssues(errors, `${path}.policyReason is invalid`), valid].every(
      Boolean,
    );
  }

  return valid;
}

const PERMISSION_REQUEST_KEYS = [
  "requestId",
  "kind",
  "actionClass",
  "reasonCode",
  "actionKind",
  "scopeLabel",
  "risk",
  "policyReason",
  "connectorScopes",
  "commandLabel",
  "nativePermission",
  "expiresAt",
];

function validatePermissionRequestInternal(
  value: unknown,
  path: string,
  errors: string[],
): boolean {
  let valid = true;
  if (!isRecord(value)) {
    valid = [appendValidationIssues(errors, `${path} must be an object`), valid].every(Boolean);
    return valid;
  }
  valid = [validateAllowedKeys(value, PERMISSION_REQUEST_KEYS, path, errors), valid].every(Boolean);
  valid = [validateRequiredSafeEvidenceTextField(value, "requestId", path, errors), valid].every(
    Boolean,
  );
  if (!isOneOf(value.kind, CODING_WORKBENCH_PERMISSION_REQUEST_KINDS)) {
    valid = [appendValidationIssues(errors, `${path}.kind is invalid`), valid].every(Boolean);
  }
  if (!isOneOf(value.actionClass, CODING_WORKBENCH_ACTION_CLASSES)) {
    valid = [appendValidationIssues(errors, `${path}.actionClass is invalid`), valid].every(
      Boolean,
    );
  }
  valid = [validatePermissionRequestOptionalFields(value, path, errors), valid].every(Boolean);
  if (value.kind === "command-execution" && value.commandLabel === undefined) {
    valid = [appendValidationIssues(errors, `${path}.commandLabel is required`), valid].every(
      Boolean,
    );
  }
  valid = [validatePermissionRequestKindActionClassConsistency(value, path, errors), valid].every(
    Boolean,
  );
  valid = [validatePermissionRequestSupervisedConsistency(value, path, errors), valid].every(
    Boolean,
  );

  return valid;
}

function validateEventCommon(record: Record<string, unknown>, errors: string[]): boolean {
  let valid = true;
  if (record.schemaVersion !== CODING_WORKBENCH_SCHEMA_VERSION) {
    valid = [appendValidationIssues(errors, "schemaVersion is invalid"), valid].every(Boolean);
  }
  valid = [validateRequiredSafeEvidenceTextField(record, "eventId", "event", errors), valid].every(
    Boolean,
  );
  valid = [validateRequiredSafeEvidenceTextField(record, "runId", "event", errors), valid].every(
    Boolean,
  );
  if (!isIsoInstant(record.occurredAt)) {
    valid = [
      appendValidationIssues(errors, "event.occurredAt must be an ISO-8601 UTC instant"),
      valid,
    ].every(Boolean);
  }
  if (!isOneOf(record.kind, CODING_WORKBENCH_RUNTIME_EVENT_KINDS)) {
    valid = [appendValidationIssues(errors, "event.kind is invalid"), valid].every(Boolean);
  }

  return valid;
}

const CODING_WORKBENCH_RUNTIME_EVENT_COMMON_KEYS: readonly string[] = Object.freeze([
  "schemaVersion",
  "eventId",
  "runId",
  "occurredAt",
  "kind",
] as const);

function runtimeEventAllowedKeys(...keys: readonly string[]): readonly string[] {
  return [...CODING_WORKBENCH_RUNTIME_EVENT_COMMON_KEYS, ...keys];
}

const CODING_WORKBENCH_RUNTIME_EVENT_ALLOWED_KEYS_BY_KIND: Readonly<
  Record<CodingWorkbenchRuntimeEventKind, readonly string[]>
> = Object.freeze({
  "runtime-started": runtimeEventAllowedKeys(
    "runtimeSource",
    "modelSource",
    "requestedMode",
    "effectiveMode",
  ),
  "runtime-stopped": runtimeEventAllowedKeys(
    "runtimeSource",
    "modelSource",
    "health",
    "effectiveMode",
  ),
  "runtime-health": runtimeEventAllowedKeys("runtimeSource", "modelSource", "health"),
  "task-submitted": runtimeEventAllowedKeys("taskRef", "requestedMode", "effectiveMode"),
  "observation-streamed": runtimeEventAllowedKeys("channel", "sequence", "byteCount", "truncated"),
  "native-retry-changed": runtimeEventAllowedKeys("nativeRetry"),
  "permission-requested": runtimeEventAllowedKeys("permissionRequest"),
  "diff-summarized": runtimeEventAllowedKeys("fileCount", "addedLines", "deletedLines"),
  "verification-summarized": runtimeEventAllowedKeys(
    "verificationKind",
    "verificationStatus",
    "passedCount",
    "failedCount",
    "skippedCount",
    "failureLocationCount",
    "failureLocationsTruncated",
    "verificationTargetDigest",
    "verificationEditRevision",
    "verificationSummary",
  ),
  "artifact-produced": runtimeEventAllowedKeys(
    "artifactKind",
    "artifactLabel",
    "artifactDigest",
    "artifactBytes",
  ),
  "research-performed": runtimeEventAllowedKeys(
    "auxiliaryOutcome",
    "byteCount",
    "contentTrust",
    "failureCode",
    "failureSummary",
    "retryable",
  ),
  "skill-invoked": runtimeEventAllowedKeys(
    "skillId",
    "skillInvocation",
    "auxiliaryOutcome",
    "failureCode",
    "failureSummary",
    "retryable",
  ),
  "child-run-started": runtimeEventAllowedKeys("childRunId", "auxiliaryOutcome"),
  "child-run-completed": runtimeEventAllowedKeys(
    "childRunId",
    "childResultCount",
    "auxiliaryOutcome",
    "failureCode",
    "failureSummary",
    "retryable",
  ),
  "operator-decision": runtimeEventAllowedKeys("operatorDecision", "auxiliaryOutcome"),
  "failure-redacted": runtimeEventAllowedKeys("failureCode", "failureSummary", "retryable"),
} as const satisfies Readonly<Record<CodingWorkbenchRuntimeEventKind, readonly string[]>>);

function validateAuthorityKnownFields(value: Record<string, unknown>, errors: string[]): boolean {
  let valid = true;
  valid = [
    validateAllowedKeys(
      value,
      [
        "schemaVersion",
        "runId",
        "localUser",
        "taskRefs",
        "workspace",
        "branch",
        "requestedMode",
        "deploymentCeiling",
        "effectiveMode",
        "runtimeSource",
        "actionClasses",
        "connectorScopes",
        "modelProfile",
        "commandPolicy",
        "networkPolicy",
        "gates",
        "budget",
        "expiresAt",
        "approvalProofDigest",
      ],
      "authorityEnvelope",
      errors,
    ),
    valid,
  ].every(Boolean);
  if (value.schemaVersion !== CODING_WORKBENCH_SCHEMA_VERSION) {
    valid = [appendValidationIssues(errors, "schemaVersion is invalid"), valid].every(Boolean);
  }
  valid = [
    validateRequiredSafeEvidenceTextField(value, "runId", "authorityEnvelope", errors),
    valid,
  ].every(Boolean);
  valid = [
    validateSafeEvidenceText(value.localUser, "authorityEnvelope.localUser", errors),
    valid,
  ].every(Boolean);
  valid = [
    validateSafeEvidenceTextArray(value.taskRefs, "authorityEnvelope.taskRefs", errors, true),
    valid,
  ].every(Boolean);

  return valid;
}

function validateRuntimeEventAllowedKeys(
  value: Record<string, unknown>,
  errors: string[],
): boolean {
  let valid = true;
  const allowedKeys = isOneOf(value.kind, CODING_WORKBENCH_RUNTIME_EVENT_KINDS)
    ? CODING_WORKBENCH_RUNTIME_EVENT_ALLOWED_KEYS_BY_KIND[value.kind]
    : CODING_WORKBENCH_RUNTIME_EVENT_COMMON_KEYS;
  valid = [validateAllowedKeys(value, allowedKeys, "event", errors), valid].every(Boolean);

  return valid;
}

function validateRuntimeEventModeFields(value: Record<string, unknown>, errors: string[]): boolean {
  let valid = true;
  if (
    value.runtimeSource !== undefined &&
    !isOneOf(value.runtimeSource, CODING_WORKBENCH_RUNTIME_SOURCES)
  ) {
    valid = [appendValidationIssues(errors, "event.runtimeSource is invalid"), valid].every(
      Boolean,
    );
  }
  if (
    value.modelSource !== undefined &&
    !isOneOf(value.modelSource, CODING_WORKBENCH_MODEL_SOURCES)
  ) {
    valid = [appendValidationIssues(errors, "event.modelSource is invalid"), valid].every(Boolean);
  }
  if (value.requestedMode !== undefined && !isOneOf(value.requestedMode, CODING_WORKBENCH_MODES)) {
    valid = [appendValidationIssues(errors, "event.requestedMode is invalid"), valid].every(
      Boolean,
    );
  }
  if (value.effectiveMode !== undefined && !isOneOf(value.effectiveMode, CODING_WORKBENCH_MODES)) {
    valid = [appendValidationIssues(errors, "event.effectiveMode is invalid"), valid].every(
      Boolean,
    );
  }

  return valid;
}

function validateRuntimeEventStatusFields(
  value: Record<string, unknown>,
  errors: string[],
): boolean {
  let valid = true;
  if (
    value.health !== undefined &&
    !isOneOf(value.health, CODING_WORKBENCH_RUNTIME_HEALTH_STATES)
  ) {
    valid = [appendValidationIssues(errors, "event.health is invalid"), valid].every(Boolean);
  }
  if (
    value.channel !== undefined &&
    !isOneOf(value.channel, CODING_WORKBENCH_OBSERVATION_CHANNELS)
  ) {
    valid = [appendValidationIssues(errors, "event.channel is invalid"), valid].every(Boolean);
  }
  if (
    value.verificationStatus !== undefined &&
    !isOneOf(value.verificationStatus, ["passed", "failed", "partial"] as const)
  ) {
    valid = [appendValidationIssues(errors, "event.verificationStatus is invalid"), valid].every(
      Boolean,
    );
  }
  valid = [validateRuntimeEventAuxiliaryFields(value, errors), valid].every(Boolean);

  return valid;
}

function validateRuntimeEventAuxiliaryFields(
  value: Record<string, unknown>,
  errors: string[],
): boolean {
  let valid = true;
  if (
    value.auxiliaryOutcome !== undefined &&
    !isOneOf(value.auxiliaryOutcome, CODING_WORKBENCH_AUXILIARY_STATUSES)
  ) {
    valid = [appendValidationIssues(errors, "event.auxiliaryOutcome is invalid"), valid].every(
      Boolean,
    );
  }
  if (
    value.skillInvocation !== undefined &&
    !isOneOf(value.skillInvocation, ["explicit", "implicit"] as const)
  ) {
    valid = [appendValidationIssues(errors, "event.skillInvocation is invalid"), valid].every(
      Boolean,
    );
  }
  if (
    value.contentTrust !== undefined &&
    !isOneOf(value.contentTrust, CODING_WORKBENCH_CONTENT_TRUST_VALUES)
  ) {
    valid = [appendValidationIssues(errors, "event.contentTrust is invalid"), valid].every(Boolean);
  }

  return valid;
}

function validateRuntimeEventEvidenceFields(
  value: Record<string, unknown>,
  errors: string[],
): boolean {
  let valid = true;
  if (value.taskRef !== undefined) {
    valid = [validateSafeEvidenceText(value.taskRef, "event.taskRef", errors), valid].every(
      Boolean,
    );
  }
  if (value.permissionRequest !== undefined) {
    valid = [
      validatePermissionRequestInternal(value.permissionRequest, "event.permissionRequest", errors),
      valid,
    ].every(Boolean);
  }
  if (value.verificationKind !== undefined) {
    valid = [
      validateSafeEvidenceText(value.verificationKind, "event.verificationKind", errors),
      valid,
    ].every(Boolean);
  }
  if (value.artifactKind !== undefined) {
    valid = [
      validateSafeEvidenceText(value.artifactKind, "event.artifactKind", errors),
      valid,
    ].every(Boolean);
  }
  if (value.artifactLabel !== undefined) {
    valid = [
      validateSafeEvidenceText(value.artifactLabel, "event.artifactLabel", errors),
      valid,
    ].every(Boolean);
  }
  if (value.failureCode !== undefined) {
    valid = [validateSafeEvidenceText(value.failureCode, "event.failureCode", errors), valid].every(
      Boolean,
    );
  }
  valid = [validateRuntimeEventAuxiliaryIdFields(value, errors), valid].every(Boolean);

  return valid;
}

function validateRuntimeEventAuxiliaryIdFields(
  value: Record<string, unknown>,
  errors: string[],
): boolean {
  let valid = true;
  if (value.skillId !== undefined && !isCodeTaskSkillId(value.skillId)) {
    valid = [appendValidationIssues(errors, "event.skillId is invalid"), valid].every(Boolean);
  }
  if (value.childRunId !== undefined && !isCodeTaskChildRunId(value.childRunId)) {
    valid = [appendValidationIssues(errors, "event.childRunId is invalid"), valid].every(Boolean);
  }

  return valid;
}

function validateAuthorityPolicyConsistency(
  value: Record<string, unknown>,
  errors: string[],
): boolean {
  return [
    validateNetworkPolicyConnectorScopesConsistency(value, errors),
    validateNetworkPolicyActionClassConsistency(value, errors),
    validateConnectorScopeActionClassConsistency(value, errors),
    validateHumanApprovalGateBinding(value, errors),
  ].every(Boolean);
}

function validateAuthorityPolicyFields(value: Record<string, unknown>, errors: string[]): boolean {
  let valid = true;
  valid = [
    validateWorkspaceIdentity(value.workspace, "authorityEnvelope.workspace", errors),
    valid,
  ].every(Boolean);
  valid = [
    validateBranchConstraints(value.branch, "authorityEnvelope.branch", errors),
    valid,
  ].every(Boolean);
  valid = [
    validateModelProfile(value.modelProfile, "authorityEnvelope.modelProfile", errors),
    valid,
  ].every(Boolean);
  valid = [
    validateCommandPolicy(value.commandPolicy, "authorityEnvelope.commandPolicy", errors),
    valid,
  ].every(Boolean);
  valid = [
    validateNetworkPolicy(value.networkPolicy, "authorityEnvelope.networkPolicy", errors),
    valid,
  ].every(Boolean);
  valid = [validateBudget(value.budget, "authorityEnvelope.budget", errors), valid].every(Boolean);
  valid = [
    validateStringArray(
      value.gates,
      CODING_WORKBENCH_GATES,
      "authorityEnvelope.gates",
      errors,
      true,
    ),
    valid,
  ].every(Boolean);
  if (!isIsoInstant(value.expiresAt)) {
    valid = [
      appendValidationIssues(errors, "authorityEnvelope.expiresAt must be an ISO-8601 UTC instant"),
      valid,
    ].every(Boolean);
  }
  valid = [
    validateDigest(value.approvalProofDigest, "authorityEnvelope.approvalProofDigest", errors),
    valid,
  ].every(Boolean);
  return [validateAuthorityPolicyConsistency(value, errors), valid].every(Boolean);
}

function validateAuthorityModeFields(value: Record<string, unknown>, errors: string[]): boolean {
  let valid = true;
  if (!isOneOf(value.requestedMode, CODING_WORKBENCH_MODES)) {
    valid = [
      appendValidationIssues(errors, "authorityEnvelope.requestedMode is invalid"),
      valid,
    ].every(Boolean);
  }
  if (!isOneOf(value.deploymentCeiling, CODING_WORKBENCH_MODES)) {
    valid = [
      appendValidationIssues(errors, "authorityEnvelope.deploymentCeiling is invalid"),
      valid,
    ].every(Boolean);
  }
  if (!isOneOf(value.effectiveMode, CODING_WORKBENCH_MODES)) {
    valid = [
      appendValidationIssues(errors, "authorityEnvelope.effectiveMode is invalid"),
      valid,
    ].every(Boolean);
  }
  if (!isOneOf(value.runtimeSource, CODING_WORKBENCH_RUNTIME_SOURCES)) {
    valid = [
      appendValidationIssues(errors, "authorityEnvelope.runtimeSource is invalid"),
      valid,
    ].every(Boolean);
  }
  valid = [
    validateStringArray(
      value.actionClasses,
      CODING_WORKBENCH_ACTION_CLASSES,
      "authorityEnvelope.actionClasses",
      errors,
      true,
    ),
    valid,
  ].every(Boolean);
  valid = [
    validateStringArray(
      value.connectorScopes,
      CODING_WORKBENCH_CONNECTOR_SCOPES,
      "authorityEnvelope.connectorScopes",
      errors,
      false,
    ),
    valid,
  ].every(Boolean);

  return valid;
}

function validateAuthorityEffectiveMode(value: Record<string, unknown>, errors: string[]): boolean {
  let valid = true;
  valid = [
    validateModePolicyConsistency(
      isOneOf(value.effectiveMode, CODING_WORKBENCH_MODES) ? value.effectiveMode : undefined,
      value.actionClasses,
      "authorityEnvelope.actionClasses",
      errors,
    ),
    valid,
  ].every(Boolean);
  if (
    isOneOf(value.effectiveMode, CODING_WORKBENCH_MODES) &&
    value.effectiveMode !==
      resolveEffectiveCodingWorkbenchMode(value.requestedMode, value.deploymentCeiling)
  ) {
    valid = [
      appendValidationIssues(
        errors,
        "authorityEnvelope.effectiveMode must be the fail-closed minimum of requestedMode and deploymentCeiling",
      ),
      valid,
    ].every(Boolean);
  }
  valid = [validateCommandPolicyActionClassConsistency(value, errors), valid].every(Boolean);

  return valid;
}

function validateNetworkPolicyConnectorScopesConsistency(
  value: Record<string, unknown>,
  errors: string[],
): boolean {
  let valid = true;
  if (!isRecord(value.networkPolicy) || !Array.isArray(value.connectorScopes)) return valid;
  const networkConnectorScopes: readonly unknown[] | undefined = Array.isArray(
    value.networkPolicy.connectorScopes,
  )
    ? value.networkPolicy.connectorScopes
    : undefined;
  if (networkConnectorScopes === undefined) return valid;
  if (value.networkPolicy.mode === "deny-all" && networkConnectorScopes.length > 0) {
    valid = [
      appendValidationIssues(
        errors,
        "authorityEnvelope.networkPolicy.connectorScopes must be empty when mode is deny-all",
      ),
      valid,
    ].every(Boolean);
  }
  const allowedScopes = new Set<unknown>(
    value.connectorScopes.filter((entry): entry is string => typeof entry === "string"),
  );
  networkConnectorScopes.forEach((scope, index) => {
    if (!allowedScopes.has(scope)) {
      valid = [
        appendValidationIssues(
          errors,
          `authorityEnvelope.networkPolicy.connectorScopes[${String(index)}] must be listed in authorityEnvelope.connectorScopes`,
        ),
        valid,
      ].every(Boolean);
    }
  });

  return valid;
}

function validateRuntimeEventFields(value: Record<string, unknown>, errors: string[]): boolean {
  return [
    validateRuntimeEventAllowedKeys(value, errors),
    validateRuntimeEventModeFields(value, errors),
    validateRuntimeEventStatusFields(value, errors),
    validateRuntimeEventEvidenceFields(value, errors),
    validateRuntimeEventModeOrdering(value, errors),
    validateRuntimeEventRequiredFields(value, errors),
  ].every(Boolean);
}

function validateRuntimeEventCounts(value: Record<string, unknown>, errors: string[]): boolean {
  let valid = true;
  if (value.sequence !== undefined && !isSafeIntegerOrZero(value.sequence)) {
    valid = [
      appendValidationIssues(errors, "event.sequence must be a non-negative safe integer"),
      valid,
    ].every(Boolean);
  }
  if (value.byteCount !== undefined && !isSafeIntegerOrZero(value.byteCount)) {
    valid = [
      appendValidationIssues(errors, "event.byteCount must be a non-negative safe integer"),
      valid,
    ].every(Boolean);
  }
  [
    "fileCount",
    "addedLines",
    "deletedLines",
    "passedCount",
    "failedCount",
    "skippedCount",
    "verificationEditRevision",
    "artifactBytes",
    "childResultCount",
  ].forEach((key) => {
    if (value[key] !== undefined && !isSafeIntegerOrZero(value[key])) {
      valid = [
        appendValidationIssues(errors, `event.${key} must be a non-negative safe integer`),
        valid,
      ].every(Boolean);
    }
  });
  if (value.truncated !== undefined && typeof value.truncated !== "boolean") {
    valid = [appendValidationIssues(errors, "event.truncated must be a boolean"), valid].every(
      Boolean,
    );
  }
  if (value.retryable !== undefined && typeof value.retryable !== "boolean") {
    valid = [appendValidationIssues(errors, "event.retryable must be a boolean"), valid].every(
      Boolean,
    );
  }
  valid = [validateOptionalFailureLocationEvidence(value, errors), valid].every(Boolean);

  return valid;
}

function validateOptionalFailureLocationEvidence(
  value: Record<string, unknown>,
  errors: string[],
): boolean {
  let valid = true;
  if (
    value.failureLocationCount !== undefined &&
    !isSafeIntegerOrZero(value.failureLocationCount)
  ) {
    valid = [
      appendValidationIssues(
        errors,
        "event.failureLocationCount must be a non-negative safe integer",
      ),
      valid,
    ].every(Boolean);
  }
  if (
    value.failureLocationsTruncated !== undefined &&
    typeof value.failureLocationsTruncated !== "boolean"
  ) {
    valid = [
      appendValidationIssues(errors, "event.failureLocationsTruncated must be a boolean"),
      valid,
    ].every(Boolean);
  }
  if (value.verificationTargetDigest !== undefined) {
    valid = [
      validateDigest(value.verificationTargetDigest, "event.verificationTargetDigest", errors),
      valid,
    ].every(Boolean);
  }

  return valid;
}

function validateRuntimeEventSafeText(value: Record<string, unknown>, errors: string[]): boolean {
  let valid = true;
  if (value.artifactDigest !== undefined) {
    valid = [validateDigest(value.artifactDigest, "event.artifactDigest", errors), valid].every(
      Boolean,
    );
  }
  if (value.failureSummary !== undefined) {
    valid = [
      validateSafeEvidenceText(value.failureSummary, "event.failureSummary", errors),
      valid,
    ].every(Boolean);
  }

  return valid;
}

function validateRuntimeEventModeOrdering(
  value: Record<string, unknown>,
  errors: string[],
): boolean {
  let valid = true;
  if (
    !isOneOf(value.requestedMode, CODING_WORKBENCH_MODES) ||
    !isOneOf(value.effectiveMode, CODING_WORKBENCH_MODES)
  ) {
    return valid;
  }
  // Authority ordering is decided by the package's own comparator, not by array position. Reading
  // the order off CODING_WORKBENCH_MODES.indexOf forked the single source of truth the package
  // declares for mode authority: reordering that array — a change that looks purely cosmetic —
  // would silently invert this check while every other authority decision stayed correct.
  if (isCodingWorkbenchModeWidening(value.requestedMode, value.effectiveMode)) {
    valid = [
      appendValidationIssues(
        errors,
        "event.effectiveMode must be no higher than event.requestedMode",
      ),
      valid,
    ].every(Boolean);
  }

  return valid;
}

function validateRuntimeStartedEventFields(
  value: Record<string, unknown>,
  errors: string[],
): boolean {
  let valid = true;
  valid = [
    validateRequiredEnumField(
      value,
      "runtimeSource",
      CODING_WORKBENCH_RUNTIME_SOURCES,
      "event",
      errors,
    ),
    valid,
  ].every(Boolean);
  valid = [
    validateRequiredEnumField(
      value,
      "modelSource",
      CODING_WORKBENCH_MODEL_SOURCES,
      "event",
      errors,
    ),
    valid,
  ].every(Boolean);
  valid = [
    validateRequiredEnumField(value, "requestedMode", CODING_WORKBENCH_MODES, "event", errors),
    valid,
  ].every(Boolean);
  valid = [
    validateRequiredEnumField(value, "effectiveMode", CODING_WORKBENCH_MODES, "event", errors),
    valid,
  ].every(Boolean);

  return valid;
}

function validateRuntimeStoppedEventFields(
  value: Record<string, unknown>,
  errors: string[],
): boolean {
  let valid = validateRuntimeHealthEventFields(value, errors);
  valid = [
    validateRequiredEnumField(value, "effectiveMode", CODING_WORKBENCH_MODES, "event", errors),
    valid,
  ].every(Boolean);

  return valid;
}

function validateRuntimeHealthEventFields(
  value: Record<string, unknown>,
  errors: string[],
): boolean {
  let valid = true;
  valid = [
    validateRequiredEnumField(
      value,
      "runtimeSource",
      CODING_WORKBENCH_RUNTIME_SOURCES,
      "event",
      errors,
    ),
    valid,
  ].every(Boolean);
  valid = [
    validateRequiredEnumField(
      value,
      "modelSource",
      CODING_WORKBENCH_MODEL_SOURCES,
      "event",
      errors,
    ),
    valid,
  ].every(Boolean);
  valid = [
    validateRequiredEnumField(
      value,
      "health",
      CODING_WORKBENCH_RUNTIME_HEALTH_STATES,
      "event",
      errors,
    ),
    valid,
  ].every(Boolean);

  return valid;
}

function validateTaskSubmittedEventFields(
  value: Record<string, unknown>,
  errors: string[],
): boolean {
  let valid = true;
  valid = [validateRequiredSafeEvidenceTextField(value, "taskRef", "event", errors), valid].every(
    Boolean,
  );
  valid = [
    validateRequiredEnumField(value, "requestedMode", CODING_WORKBENCH_MODES, "event", errors),
    valid,
  ].every(Boolean);
  valid = [
    validateRequiredEnumField(value, "effectiveMode", CODING_WORKBENCH_MODES, "event", errors),
    valid,
  ].every(Boolean);

  return valid;
}

function validateObservationEventFields(value: Record<string, unknown>, errors: string[]): boolean {
  let valid = true;
  valid = [
    validateRequiredEnumField(
      value,
      "channel",
      CODING_WORKBENCH_OBSERVATION_CHANNELS,
      "event",
      errors,
    ),
    valid,
  ].every(Boolean);
  valid = [validateRequiredSafeIntegerField(value, "sequence", "event", errors), valid].every(
    Boolean,
  );
  valid = [validateRequiredSafeIntegerField(value, "byteCount", "event", errors), valid].every(
    Boolean,
  );

  return valid;
}

function validatePermissionRequestedEventFields(
  value: Record<string, unknown>,
  errors: string[],
): boolean {
  let valid = true;
  if (value.permissionRequest === undefined) {
    valid = [appendValidationIssues(errors, "event.permissionRequest is required"), valid].every(
      Boolean,
    );
    return valid;
  }
  valid = [
    validatePermissionRequestInternal(value.permissionRequest, "event.permissionRequest", errors),
    valid,
  ].every(Boolean);

  return valid;
}

function validateDiffSummarizedEventFields(
  value: Record<string, unknown>,
  errors: string[],
): boolean {
  let valid = true;
  valid = [validateRequiredSafeIntegerField(value, "fileCount", "event", errors), valid].every(
    Boolean,
  );
  valid = [validateRequiredSafeIntegerField(value, "addedLines", "event", errors), valid].every(
    Boolean,
  );
  valid = [validateRequiredSafeIntegerField(value, "deletedLines", "event", errors), valid].every(
    Boolean,
  );

  return valid;
}

function validateVerificationSummarizedEventFields(
  value: Record<string, unknown>,
  errors: string[],
): boolean {
  let valid = true;
  valid = [
    validateRequiredSafeEvidenceTextField(value, "verificationKind", "event", errors),
    valid,
  ].every(Boolean);
  valid = [
    validateRequiredEnumField(
      value,
      "verificationStatus",
      ["passed", "failed", "partial"],
      "event",
      errors,
    ),
    valid,
  ].every(Boolean);
  valid = [validateRequiredSafeIntegerField(value, "passedCount", "event", errors), valid].every(
    Boolean,
  );
  valid = [validateRequiredSafeIntegerField(value, "failedCount", "event", errors), valid].every(
    Boolean,
  );
  valid = [validateRequiredSafeIntegerField(value, "skippedCount", "event", errors), valid].every(
    Boolean,
  );
  valid = [validateVerificationSummaryAgreement(value, errors), valid].every(Boolean);

  return valid;
}

function validateVerificationSummaryAgreement(
  value: Record<string, unknown>,
  errors: string[],
): boolean {
  let valid = true;
  const summary = value.verificationSummary;
  if (summary === undefined) return valid;
  if (!isCodingWorkbenchVerificationSummary(summary)) {
    valid = [appendValidationIssues(errors, "event.verificationSummary is invalid"), valid].every(
      Boolean,
    );
    return valid;
  }
  if (
    summary.status !== value.verificationStatus ||
    summary.passedCount !== value.passedCount ||
    summary.failedCount !== value.failedCount ||
    summary.skippedCount !== value.skippedCount
  ) {
    valid = [
      appendValidationIssues(
        errors,
        "event.verificationSummary disagrees with the canonical check counts or status",
      ),
      valid,
    ].every(Boolean);
  }

  return valid;
}

function validateArtifactProducedEventFields(
  value: Record<string, unknown>,
  errors: string[],
): boolean {
  let valid = true;
  valid = [
    validateRequiredSafeEvidenceTextField(value, "artifactKind", "event", errors),
    valid,
  ].every(Boolean);
  valid = [
    validateRequiredSafeEvidenceTextField(value, "artifactLabel", "event", errors),
    valid,
  ].every(Boolean);
  valid = [validateRequiredDigestField(value, "artifactDigest", "event", errors), valid].every(
    Boolean,
  );
  valid = [validateRequiredSafeIntegerField(value, "artifactBytes", "event", errors), valid].every(
    Boolean,
  );

  return valid;
}

function validateFailureRedactedEventFields(
  value: Record<string, unknown>,
  errors: string[],
): boolean {
  let valid = true;
  valid = [
    validateRequiredSafeEvidenceTextField(value, "failureCode", "event", errors),
    valid,
  ].every(Boolean);
  valid = [
    validateRequiredSafeEvidenceTextField(value, "failureSummary", "event", errors),
    valid,
  ].every(Boolean);
  valid = [validateRequiredBooleanField(value, "retryable", "event", errors), valid].every(Boolean);

  return valid;
}

function requireAuxiliaryOutcome(value: Record<string, unknown>, errors: string[]): boolean {
  let valid = true;
  valid = [
    validateRequiredEnumField(
      value,
      "auxiliaryOutcome",
      CODING_WORKBENCH_AUXILIARY_STATUSES,
      "event",
      errors,
    ),
    valid,
  ].every(Boolean);

  return valid;
}

function requireChildRunId(value: Record<string, unknown>, errors: string[]): boolean {
  let valid = true;
  if (value.childRunId === undefined) {
    valid = [appendValidationIssues(errors, "event.childRunId is required"), valid].every(Boolean);
  } else if (!isCodeTaskChildRunId(value.childRunId)) {
    valid = [appendValidationIssues(errors, "event.childRunId is invalid"), valid].every(Boolean);
  }

  return valid;
}

// #2637: an ACCEPTED research fetch handed page text to the model, so the event MUST declare that
// content untrusted. The requirement is conditional on the accepted outcome because a denial never
// produced a read at all — there is nothing to classify. Emitting an accepted research event
// without the marker is a contract violation, not a defaulted field: the timeline would otherwise
// show a research read whose trust the runtime never asserted.
function validateResearchPerformedEventFields(
  value: Record<string, unknown>,
  errors: string[],
): boolean {
  let valid = true;
  valid = [requireAuxiliaryOutcome(value, errors), valid].every(Boolean);
  if (value.auxiliaryOutcome === "accepted") {
    valid = [
      validateRequiredEnumField(
        value,
        "contentTrust",
        CODING_WORKBENCH_CONTENT_TRUST_VALUES,
        "event",
        errors,
      ),
      valid,
    ].every(Boolean);
    return valid;
  }
  if (value.contentTrust !== undefined) {
    valid = [
      appendValidationIssues(
        errors,
        "event.contentTrust is only admissible on an accepted research read",
      ),
      valid,
    ].every(Boolean);
  }

  return valid;
}

function validateSkillInvokedEventFields(
  value: Record<string, unknown>,
  errors: string[],
): boolean {
  let valid = true;
  if (value.skillId === undefined) {
    valid = [appendValidationIssues(errors, "event.skillId is required"), valid].every(Boolean);
  } else if (!isCodeTaskSkillId(value.skillId)) {
    valid = [appendValidationIssues(errors, "event.skillId is invalid"), valid].every(Boolean);
  }
  valid = [
    validateRequiredEnumField(value, "skillInvocation", ["explicit", "implicit"], "event", errors),
    valid,
  ].every(Boolean);
  valid = [requireAuxiliaryOutcome(value, errors), valid].every(Boolean);

  return valid;
}

// The decision being asked of the human is REQUIRED: an event that cannot name it would pause a run
// without saying what the operator has to decide, which is the failure this event exists to prevent.
// `auxiliaryOutcome` stays optional and carries the phase: absent means the decision is open and a
// governed tool is waiting on it, present means it settled.
function validateOperatorDecisionEventFields(
  value: Record<string, unknown>,
  errors: string[],
): boolean {
  let valid = true;
  valid = [
    validateRequiredEnumField(
      value,
      "operatorDecision",
      CODING_WORKBENCH_OPERATOR_DECISIONS,
      "event",
      errors,
    ),
    valid,
  ].every(Boolean);
  if (
    value.auxiliaryOutcome !== undefined &&
    !isOneOf(value.auxiliaryOutcome, CODING_WORKBENCH_AUXILIARY_STATUSES)
  ) {
    valid = [appendValidationIssues(errors, "event.auxiliaryOutcome is invalid"), valid].every(
      Boolean,
    );
  }

  return valid;
}

function validateChildRunStartedEventFields(
  value: Record<string, unknown>,
  errors: string[],
): boolean {
  let valid = true;
  valid = [requireChildRunId(value, errors), valid].every(Boolean);

  return valid;
}

function validateChildRunCompletedEventFields(
  value: Record<string, unknown>,
  errors: string[],
): boolean {
  let valid = true;
  valid = [requireChildRunId(value, errors), valid].every(Boolean);
  valid = [requireAuxiliaryOutcome(value, errors), valid].every(Boolean);
  valid = [
    validateRequiredSafeIntegerField(value, "childResultCount", "event", errors),
    valid,
  ].every(Boolean);

  return valid;
}

function validateNativeRetryEventFields(value: Record<string, unknown>, errors: string[]): boolean {
  let valid = true;
  if (value.nativeRetry !== null && !isCodingWorkbenchNativeRetry(value.nativeRetry)) {
    valid = [
      appendValidationIssues(
        errors,
        "event.nativeRetry must be canonical native retry facts or null",
      ),
      valid,
    ].every(Boolean);
  }

  return valid;
}

const CODING_WORKBENCH_RUNTIME_EVENT_REQUIRED_FIELD_VALIDATORS: Readonly<
  Record<
    CodingWorkbenchRuntimeEventKind,
    (value: Record<string, unknown>, errors: string[]) => boolean
  >
> = Object.freeze({
  "runtime-started": validateRuntimeStartedEventFields,
  "runtime-stopped": validateRuntimeStoppedEventFields,
  "runtime-health": validateRuntimeHealthEventFields,
  "task-submitted": validateTaskSubmittedEventFields,
  "observation-streamed": validateObservationEventFields,
  "native-retry-changed": validateNativeRetryEventFields,
  "permission-requested": validatePermissionRequestedEventFields,
  "diff-summarized": validateDiffSummarizedEventFields,
  "verification-summarized": validateVerificationSummarizedEventFields,
  "artifact-produced": validateArtifactProducedEventFields,
  "research-performed": validateResearchPerformedEventFields,
  "skill-invoked": validateSkillInvokedEventFields,
  "child-run-started": validateChildRunStartedEventFields,
  "child-run-completed": validateChildRunCompletedEventFields,
  "operator-decision": validateOperatorDecisionEventFields,
  "failure-redacted": validateFailureRedactedEventFields,
} as const);

function validateRuntimeEventRequiredFields(
  value: Record<string, unknown>,
  errors: string[],
): boolean {
  let valid = true;
  if (!isOneOf(value.kind, CODING_WORKBENCH_RUNTIME_EVENT_KINDS)) return valid;
  valid = [
    CODING_WORKBENCH_RUNTIME_EVENT_REQUIRED_FIELD_VALIDATORS[value.kind](value, errors),
    valid,
  ].every(Boolean);

  return valid;
}

function admitCodingWorkbenchAuthorityEnvelope(
  value: unknown,
  errors: string[],
): value is CodingWorkbenchAuthorityEnvelope {
  if (!isRecord(value)) {
    appendValidationIssues(errors, "authority envelope must be an object");
    return false;
  }
  return [
    validateAuthorityKnownFields(value, errors),
    validateAuthorityModeFields(value, errors),
    validateAuthorityPolicyFields(value, errors),
    validateAuthorityEffectiveMode(value, errors),
  ].every(Boolean);
}

export function validateCodingWorkbenchAuthorityEnvelope(
  value: unknown,
): CodingWorkbenchValidationResult<CodingWorkbenchAuthorityEnvelope> {
  return validateWithAdmission(value, admitCodingWorkbenchAuthorityEnvelope);
}

function admitCodingWorkbenchPermissionRequest(
  value: unknown,
  errors: string[],
): value is CodingWorkbenchPermissionRequest {
  let valid = true;
  if (!isRecord(value)) {
    appendValidationIssues(errors, "permission request must be an object");
    return false;
  }
  valid = [validatePermissionRequestInternal(value, "permissionRequest", errors), valid].every(
    Boolean,
  );
  return valid;
}

export function validateCodingWorkbenchPermissionRequest(
  value: unknown,
): CodingWorkbenchValidationResult<CodingWorkbenchPermissionRequest> {
  const errors: string[] = [];
  return admitCodingWorkbenchPermissionRequest(value, errors)
    ? { ok: true, value }
    : { ok: false, errors };
}

function admitCodingWorkbenchRuntimeEvent(
  value: unknown,
  errors: string[],
): value is CodingWorkbenchRuntimeEvent {
  if (!isRecord(value)) {
    appendValidationIssues(errors, "runtime event must be an object");
    return false;
  }
  return [
    validateEventCommon(value, errors),
    validateRuntimeEventFields(value, errors),
    validateRuntimeEventCounts(value, errors),
    validateRuntimeEventSafeText(value, errors),
  ].every(Boolean);
}

export function validateCodingWorkbenchRuntimeEvent(
  value: unknown,
): CodingWorkbenchValidationResult<CodingWorkbenchRuntimeEvent> {
  return validateWithAdmission(value, admitCodingWorkbenchRuntimeEvent);
}
