import { isCodingWorkbenchEvidenceSafeText } from "./coding-workbench-evidence.js";
import {
  CODING_WORKBENCH_ACTION_CLASSES,
  CODING_WORKBENCH_COMMAND_POLICY_MODES,
  CODING_WORKBENCH_CONNECTOR_SCOPES,
  CODING_WORKBENCH_GATES,
  CODING_WORKBENCH_MODEL_SOURCES,
  CODING_WORKBENCH_MODES,
  CODING_WORKBENCH_MODE_POLICIES,
  CODING_WORKBENCH_NETWORK_MODES,
  CODING_WORKBENCH_OBSERVATION_CHANNELS,
  CODING_WORKBENCH_PERMISSION_REQUEST_KINDS,
  CODING_WORKBENCH_RUNTIME_EVENT_KINDS,
  CODING_WORKBENCH_RUNTIME_HEALTH_STATES,
  CODING_WORKBENCH_RUNTIME_SOURCES,
  CODING_WORKBENCH_SCHEMA_VERSION,
  resolveEffectiveCodingWorkbenchMode,
  type CodingWorkbenchAuthorityEnvelope,
  type CodingWorkbenchMode,
  type CodingWorkbenchPermissionRequest,
  type CodingWorkbenchRuntimeEventKind,
  type CodingWorkbenchRuntimeEvent,
  type CodingWorkbenchValidationResult,
} from "./coding-workbench.js";

const HEX_64_PATTERN = /^[a-f0-9]{64}$/u;
const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isSafeIntegerOrZero(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isIsoInstant(value: unknown): value is string {
  return (
    typeof value === "string" && ISO_INSTANT_PATTERN.test(value) && !Number.isNaN(Date.parse(value))
  );
}

function validateAllowedKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  errors: string[],
): void {
  Object.keys(record)
    .filter((key) => !allowed.includes(key))
    .forEach((key) => errors.push(`${path}.${key} is not allowed`));
}

function validateStringArray(
  value: unknown,
  allowed: readonly string[] | undefined,
  path: string,
  errors: string[],
  requireNonEmpty: boolean,
): void {
  if (!Array.isArray(value)) {
    errors.push(`${path} must be an array`);
    return;
  }
  if (requireNonEmpty && value.length === 0) {
    errors.push(`${path} must not be empty`);
  }
  value.forEach((entry, index) => {
    if (typeof entry !== "string" || entry.length === 0) {
      errors.push(`${path}[${String(index)}] must be a non-empty string`);
      return;
    }
    if (allowed !== undefined && !allowed.includes(entry)) {
      errors.push(`${path}[${String(index)}] is invalid`);
    }
  });
}

function validateSafeEvidenceTextArray(
  value: unknown,
  path: string,
  errors: string[],
  requireNonEmpty: boolean,
): void {
  if (!Array.isArray(value)) {
    errors.push(`${path} must be an array`);
    return;
  }
  if (requireNonEmpty && value.length === 0) {
    errors.push(`${path} must not be empty`);
  }
  value.forEach((entry, index) => {
    if (!isCodingWorkbenchEvidenceSafeText(entry)) {
      errors.push(`${path}[${String(index)}] must be content-free evidence-safe text`);
    }
  });
}

function validateSafeEvidenceText(value: unknown, path: string, errors: string[]): void {
  if (!isCodingWorkbenchEvidenceSafeText(value)) {
    errors.push(`${path} must be content-free evidence-safe text`);
  }
}

function validateRequiredSafeEvidenceTextField(
  record: Record<string, unknown>,
  key: string,
  path: string,
  errors: string[],
): void {
  if (record[key] === undefined) {
    errors.push(`${path}.${key} is required`);
    return;
  }
  validateSafeEvidenceText(record[key], `${path}.${key}`, errors);
}

function validateRequiredEnumField(
  record: Record<string, unknown>,
  key: string,
  allowed: readonly string[],
  path: string,
  errors: string[],
): void {
  if (record[key] === undefined) {
    errors.push(`${path}.${key} is required`);
    return;
  }
  if (!isOneOf(record[key], allowed)) {
    errors.push(`${path}.${key} is invalid`);
  }
}

function validateRequiredSafeIntegerField(
  record: Record<string, unknown>,
  key: string,
  path: string,
  errors: string[],
): void {
  if (record[key] === undefined) {
    errors.push(`${path}.${key} is required`);
    return;
  }
  if (!isSafeIntegerOrZero(record[key])) {
    errors.push(`${path}.${key} must be a non-negative safe integer`);
  }
}

function validateRequiredBooleanField(
  record: Record<string, unknown>,
  key: string,
  path: string,
  errors: string[],
): void {
  if (record[key] === undefined) {
    errors.push(`${path}.${key} is required`);
    return;
  }
  if (typeof record[key] !== "boolean") {
    errors.push(`${path}.${key} must be a boolean`);
  }
}

function validateRequiredDigestField(
  record: Record<string, unknown>,
  key: string,
  path: string,
  errors: string[],
): void {
  if (record[key] === undefined) {
    errors.push(`${path}.${key} is required`);
    return;
  }
  validateDigest(record[key], `${path}.${key}`, errors);
}

function validateDigest(value: unknown, path: string, errors: string[]): void {
  if (typeof value !== "string" || !HEX_64_PATTERN.test(value)) {
    errors.push(`${path} must be a 64-character lowercase hex digest`);
  }
}

function validateWorkspaceIdentity(value: unknown, path: string, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return;
  }
  validateAllowedKeys(value, ["workspaceId", "rootLabel", "rootDigest"], path, errors);
  validateRequiredSafeEvidenceTextField(value, "workspaceId", path, errors);
  validateSafeEvidenceText(value.rootLabel, `${path}.rootLabel`, errors);
  validateDigest(value.rootDigest, `${path}.rootDigest`, errors);
}

function validateBranchConstraints(value: unknown, path: string, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return;
  }
  validateAllowedKeys(
    value,
    ["baseRef", "headRef", "allowDetachedHead", "allowedPrefixes"],
    path,
    errors,
  );
  validateSafeEvidenceText(value.baseRef, `${path}.baseRef`, errors);
  validateSafeEvidenceText(value.headRef, `${path}.headRef`, errors);
  if (typeof value.allowDetachedHead !== "boolean") {
    errors.push(`${path}.allowDetachedHead must be a boolean`);
  }
  validateSafeEvidenceTextArray(value.allowedPrefixes, `${path}.allowedPrefixes`, errors, true);
}

function validateModelProfile(value: unknown, path: string, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return;
  }
  validateAllowedKeys(
    value,
    ["profileId", "source", "supportsStreaming", "supportsToolCalling"],
    path,
    errors,
  );
  validateSafeEvidenceText(value.profileId, `${path}.profileId`, errors);
  if (!isOneOf(value.source, CODING_WORKBENCH_MODEL_SOURCES)) {
    errors.push(`${path}.source is invalid`);
  }
  if (typeof value.supportsStreaming !== "boolean") {
    errors.push(`${path}.supportsStreaming must be a boolean`);
  }
  if (typeof value.supportsToolCalling !== "boolean") {
    errors.push(`${path}.supportsToolCalling must be a boolean`);
  }
}

function validateCommandPolicy(value: unknown, path: string, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return;
  }
  validateAllowedKeys(
    value,
    ["mode", "allow", "deny", "maxCommandTimeoutMs", "requirePerCommandApproval"],
    path,
    errors,
  );
  if (!isOneOf(value.mode, CODING_WORKBENCH_COMMAND_POLICY_MODES)) {
    errors.push(`${path}.mode is invalid`);
  }
  validateSafeEvidenceTextArray(value.allow, `${path}.allow`, errors, false);
  if (value.mode === "deny" && Array.isArray(value.allow) && value.allow.length > 0) {
    errors.push(`${path}.allow must be empty when mode is deny`);
  }
  validateSafeEvidenceTextArray(value.deny, `${path}.deny`, errors, false);
  if (!isPositiveSafeInteger(value.maxCommandTimeoutMs)) {
    errors.push(`${path}.maxCommandTimeoutMs must be a positive safe integer`);
  }
  if (typeof value.requirePerCommandApproval !== "boolean") {
    errors.push(`${path}.requirePerCommandApproval must be a boolean`);
  }
}

function validateNetworkPolicy(value: unknown, path: string, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return;
  }
  validateAllowedKeys(value, ["mode", "allowLoopback", "connectorScopes"], path, errors);
  if (!isOneOf(value.mode, CODING_WORKBENCH_NETWORK_MODES)) {
    errors.push(`${path}.mode is invalid`);
  }
  if (typeof value.allowLoopback !== "boolean") {
    errors.push(`${path}.allowLoopback must be a boolean`);
  }
  if (value.mode === "deny-all" && value.allowLoopback === true) {
    errors.push(`${path}.allowLoopback must be false when mode is deny-all`);
  }
  validateStringArray(
    value.connectorScopes,
    CODING_WORKBENCH_CONNECTOR_SCOPES,
    `${path}.connectorScopes`,
    errors,
    false,
  );
}

function validateBudget(value: unknown, path: string, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return;
  }
  validateAllowedKeys(
    value,
    ["maxRuntimeMs", "maxToolCalls", "maxPromptTokens", "maxPatchBytes"],
    path,
    errors,
  );
  ["maxRuntimeMs", "maxToolCalls", "maxPromptTokens", "maxPatchBytes"].forEach((key) => {
    if (!isPositiveSafeInteger(value[key])) {
      errors.push(`${path}.${key} must be a positive safe integer`);
    }
  });
}

function validateModePolicyConsistency(
  effectiveMode: CodingWorkbenchMode | undefined,
  actionClasses: unknown,
  path: string,
  errors: string[],
): void {
  if (effectiveMode === undefined || !Array.isArray(actionClasses)) return;
  const allowed = CODING_WORKBENCH_MODE_POLICIES[effectiveMode].allowedActionClasses;
  actionClasses.forEach((entry, index) => {
    if (
      typeof entry === "string" &&
      !allowed.includes(entry as unknown as (typeof allowed)[number])
    ) {
      errors.push(`${path}[${String(index)}] exceeds the effective mode`);
    }
  });
}

function validateNetworkPolicyActionClassConsistency(
  value: Record<string, unknown>,
  errors: string[],
): void {
  if (!Array.isArray(value.actionClasses) || !isRecord(value.networkPolicy)) return;
  const hasNetworkEgress = value.actionClasses.includes("network-egress");
  const networkPolicyMode = value.networkPolicy.mode;
  if (networkPolicyMode !== "deny-all" && !hasNetworkEgress) {
    errors.push(
      "authorityEnvelope.actionClasses must include network-egress when authorityEnvelope.networkPolicy.mode is not deny-all",
    );
  }
  if (hasNetworkEgress) return;
  if (networkPolicyMode !== "deny-all") {
    errors.push(
      "authorityEnvelope.networkPolicy.mode must be deny-all when authorityEnvelope.actionClasses omits network-egress",
    );
  }
  if (value.networkPolicy.allowLoopback !== false) {
    errors.push(
      "authorityEnvelope.networkPolicy.allowLoopback must be false when authorityEnvelope.actionClasses omits network-egress",
    );
  }
  if (
    Array.isArray(value.networkPolicy.connectorScopes) &&
    value.networkPolicy.connectorScopes.length > 0
  ) {
    errors.push(
      "authorityEnvelope.networkPolicy.connectorScopes must be empty when authorityEnvelope.actionClasses omits network-egress",
    );
  }
}

function validateConnectorScopeActionClassConsistency(
  value: Record<string, unknown>,
  errors: string[],
): void {
  if (
    !Array.isArray(value.connectorScopes) ||
    value.connectorScopes.length === 0 ||
    !Array.isArray(value.actionClasses)
  ) {
    return;
  }
  if (!value.actionClasses.includes("connector-access")) {
    errors.push(
      "authorityEnvelope.connectorScopes must be empty when authorityEnvelope.actionClasses omits connector-access",
    );
  }
}

function hasWriteCapableConnectorScope(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.some((scope) => typeof scope === "string" && scope.endsWith(".write"))
  );
}

function hasHumanApprovalRequiredActionClass(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  const actionClasses = value as readonly string[];
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

function validateHumanApprovalGateBinding(value: Record<string, unknown>, errors: string[]): void {
  if (!Array.isArray(value.gates) || !Array.isArray(value.actionClasses)) return;
  const requiresHumanApproval =
    hasHumanApprovalRequiredActionClass(value.actionClasses) ||
    hasHumanApprovalRequiredConnectorScope(value);
  if (requiresHumanApproval && !value.gates.includes("human-approval")) {
    errors.push(
      "authorityEnvelope.gates must include human-approval when authorityEnvelope.actionClasses or connector scopes grant elevated authority",
    );
  }
}

function validateCommandPolicyActionClassConsistency(
  value: Record<string, unknown>,
  errors: string[],
): void {
  if (!Array.isArray(value.actionClasses) || !isRecord(value.commandPolicy)) return;
  if (value.actionClasses.includes("command-execution")) return;
  if (value.commandPolicy.mode !== "deny") {
    errors.push(
      "authorityEnvelope.commandPolicy.mode must be deny when authorityEnvelope.actionClasses omits command-execution",
    );
  }
  if (Array.isArray(value.commandPolicy.allow) && value.commandPolicy.allow.length > 0) {
    errors.push(
      "authorityEnvelope.commandPolicy.allow must be empty when authorityEnvelope.actionClasses omits command-execution",
    );
  }
}

function validatePermissionRequestKindActionClassConsistency(
  value: Record<string, unknown>,
  path: string,
  errors: string[],
): void {
  if (
    isOneOf(value.kind, CODING_WORKBENCH_PERMISSION_REQUEST_KINDS) &&
    isOneOf(value.actionClass, CODING_WORKBENCH_ACTION_CLASSES) &&
    CODING_WORKBENCH_PERMISSION_REQUEST_KIND_TO_ACTION_CLASS[value.kind] !== value.actionClass
  ) {
    errors.push(`${path}.kind must match ${path}.actionClass for the shared action classes`);
  }
}

function validatePermissionRequestConnectorScopes(
  value: Record<string, unknown>,
  path: string,
  errors: string[],
): void {
  if (
    isOneOf(value.kind, CODING_WORKBENCH_PERMISSION_REQUEST_KINDS) &&
    value.kind === "connector-access"
  ) {
    if (value.connectorScopes === undefined) {
      errors.push(`${path}.connectorScopes is required`);
      return;
    }
    validateStringArray(
      value.connectorScopes,
      CODING_WORKBENCH_CONNECTOR_SCOPES,
      `${path}.connectorScopes`,
      errors,
      true,
    );
    return;
  }
  if (value.connectorScopes !== undefined) {
    errors.push(`${path}.connectorScopes is only allowed for connector-access requests`);
  }
}

function validatePermissionRequestOptionalFields(
  value: Record<string, unknown>,
  path: string,
  errors: string[],
): void {
  validateSafeEvidenceText(value.reasonCode, `${path}.reasonCode`, errors);
  validatePermissionRequestConnectorScopes(value, path, errors);
  if (value.commandLabel !== undefined) {
    validateSafeEvidenceText(value.commandLabel, `${path}.commandLabel`, errors);
  }
  if (!isIsoInstant(value.expiresAt)) {
    errors.push(`${path}.expiresAt must be an ISO-8601 UTC instant`);
  }
}

function validatePermissionRequestInternal(value: unknown, path: string, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return;
  }
  validateAllowedKeys(
    value,
    [
      "requestId",
      "kind",
      "actionClass",
      "reasonCode",
      "connectorScopes",
      "commandLabel",
      "expiresAt",
    ],
    path,
    errors,
  );
  validateRequiredSafeEvidenceTextField(value, "requestId", path, errors);
  if (!isOneOf(value.kind, CODING_WORKBENCH_PERMISSION_REQUEST_KINDS)) {
    errors.push(`${path}.kind is invalid`);
  }
  if (!isOneOf(value.actionClass, CODING_WORKBENCH_ACTION_CLASSES)) {
    errors.push(`${path}.actionClass is invalid`);
  }
  validatePermissionRequestOptionalFields(value, path, errors);
  if (value.kind === "command-execution" && value.commandLabel === undefined) {
    errors.push(`${path}.commandLabel is required`);
  }
  validatePermissionRequestKindActionClassConsistency(value, path, errors);
}

function validateEventCommon(record: Record<string, unknown>, errors: string[]): void {
  if (record.schemaVersion !== CODING_WORKBENCH_SCHEMA_VERSION) {
    errors.push("schemaVersion is invalid");
  }
  validateRequiredSafeEvidenceTextField(record, "eventId", "event", errors);
  validateRequiredSafeEvidenceTextField(record, "runId", "event", errors);
  if (!isIsoInstant(record.occurredAt)) {
    errors.push("event.occurredAt must be an ISO-8601 UTC instant");
  }
  if (!isOneOf(record.kind, CODING_WORKBENCH_RUNTIME_EVENT_KINDS)) {
    errors.push("event.kind is invalid");
  }
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
  "permission-requested": runtimeEventAllowedKeys("permissionRequest"),
  "diff-summarized": runtimeEventAllowedKeys("fileCount", "addedLines", "deletedLines"),
  "verification-summarized": runtimeEventAllowedKeys(
    "verificationKind",
    "verificationStatus",
    "passedCount",
    "failedCount",
    "skippedCount",
  ),
  "artifact-produced": runtimeEventAllowedKeys(
    "artifactKind",
    "artifactLabel",
    "artifactDigest",
    "artifactBytes",
  ),
  "failure-redacted": runtimeEventAllowedKeys("failureCode", "failureSummary", "retryable"),
} as const satisfies Readonly<Record<CodingWorkbenchRuntimeEventKind, readonly string[]>>);

function validateAuthorityKnownFields(value: Record<string, unknown>, errors: string[]): void {
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
  );
  if (value.schemaVersion !== CODING_WORKBENCH_SCHEMA_VERSION) {
    errors.push("schemaVersion is invalid");
  }
  validateRequiredSafeEvidenceTextField(value, "runId", "authorityEnvelope", errors);
  validateSafeEvidenceText(value.localUser, "authorityEnvelope.localUser", errors);
  validateSafeEvidenceTextArray(value.taskRefs, "authorityEnvelope.taskRefs", errors, true);
}

function validateRuntimeEventAllowedKeys(value: Record<string, unknown>, errors: string[]): void {
  const allowedKeys = isOneOf(value.kind, CODING_WORKBENCH_RUNTIME_EVENT_KINDS)
    ? CODING_WORKBENCH_RUNTIME_EVENT_ALLOWED_KEYS_BY_KIND[value.kind]
    : CODING_WORKBENCH_RUNTIME_EVENT_COMMON_KEYS;
  validateAllowedKeys(value, allowedKeys, "event", errors);
}

function validateRuntimeEventModeFields(value: Record<string, unknown>, errors: string[]): void {
  if (
    value.runtimeSource !== undefined &&
    !isOneOf(value.runtimeSource, CODING_WORKBENCH_RUNTIME_SOURCES)
  ) {
    errors.push("event.runtimeSource is invalid");
  }
  if (
    value.modelSource !== undefined &&
    !isOneOf(value.modelSource, CODING_WORKBENCH_MODEL_SOURCES)
  ) {
    errors.push("event.modelSource is invalid");
  }
  if (value.requestedMode !== undefined && !isOneOf(value.requestedMode, CODING_WORKBENCH_MODES)) {
    errors.push("event.requestedMode is invalid");
  }
  if (value.effectiveMode !== undefined && !isOneOf(value.effectiveMode, CODING_WORKBENCH_MODES)) {
    errors.push("event.effectiveMode is invalid");
  }
}

function validateRuntimeEventStatusFields(value: Record<string, unknown>, errors: string[]): void {
  if (
    value.health !== undefined &&
    !isOneOf(value.health, CODING_WORKBENCH_RUNTIME_HEALTH_STATES)
  ) {
    errors.push("event.health is invalid");
  }
  if (
    value.channel !== undefined &&
    !isOneOf(value.channel, CODING_WORKBENCH_OBSERVATION_CHANNELS)
  ) {
    errors.push("event.channel is invalid");
  }
  if (
    value.verificationStatus !== undefined &&
    !isOneOf(value.verificationStatus, ["passed", "failed", "partial"] as const)
  ) {
    errors.push("event.verificationStatus is invalid");
  }
}

function validateRuntimeEventEvidenceFields(
  value: Record<string, unknown>,
  errors: string[],
): void {
  if (value.taskRef !== undefined) {
    validateSafeEvidenceText(value.taskRef, "event.taskRef", errors);
  }
  if (value.permissionRequest !== undefined) {
    validatePermissionRequestInternal(value.permissionRequest, "event.permissionRequest", errors);
  }
  if (value.verificationKind !== undefined) {
    validateSafeEvidenceText(value.verificationKind, "event.verificationKind", errors);
  }
  if (value.artifactKind !== undefined) {
    validateSafeEvidenceText(value.artifactKind, "event.artifactKind", errors);
  }
  if (value.artifactLabel !== undefined) {
    validateSafeEvidenceText(value.artifactLabel, "event.artifactLabel", errors);
  }
  if (value.failureCode !== undefined) {
    validateSafeEvidenceText(value.failureCode, "event.failureCode", errors);
  }
}

function validateAuthorityPolicyFields(value: Record<string, unknown>, errors: string[]): void {
  validateWorkspaceIdentity(value.workspace, "authorityEnvelope.workspace", errors);
  validateBranchConstraints(value.branch, "authorityEnvelope.branch", errors);
  validateModelProfile(value.modelProfile, "authorityEnvelope.modelProfile", errors);
  validateCommandPolicy(value.commandPolicy, "authorityEnvelope.commandPolicy", errors);
  validateNetworkPolicy(value.networkPolicy, "authorityEnvelope.networkPolicy", errors);
  validateBudget(value.budget, "authorityEnvelope.budget", errors);
  validateStringArray(value.gates, CODING_WORKBENCH_GATES, "authorityEnvelope.gates", errors, true);
  if (!isIsoInstant(value.expiresAt)) {
    errors.push("authorityEnvelope.expiresAt must be an ISO-8601 UTC instant");
  }
  validateDigest(value.approvalProofDigest, "authorityEnvelope.approvalProofDigest", errors);
  validateNetworkPolicyConnectorScopesConsistency(value, errors);
  validateNetworkPolicyActionClassConsistency(value, errors);
  validateConnectorScopeActionClassConsistency(value, errors);
  validateHumanApprovalGateBinding(value, errors);
}

function validateAuthorityModeFields(value: Record<string, unknown>, errors: string[]): void {
  if (!isOneOf(value.requestedMode, CODING_WORKBENCH_MODES)) {
    errors.push("authorityEnvelope.requestedMode is invalid");
  }
  if (!isOneOf(value.deploymentCeiling, CODING_WORKBENCH_MODES)) {
    errors.push("authorityEnvelope.deploymentCeiling is invalid");
  }
  if (!isOneOf(value.effectiveMode, CODING_WORKBENCH_MODES)) {
    errors.push("authorityEnvelope.effectiveMode is invalid");
  }
  if (!isOneOf(value.runtimeSource, CODING_WORKBENCH_RUNTIME_SOURCES)) {
    errors.push("authorityEnvelope.runtimeSource is invalid");
  }
  validateStringArray(
    value.actionClasses,
    CODING_WORKBENCH_ACTION_CLASSES,
    "authorityEnvelope.actionClasses",
    errors,
    true,
  );
  validateStringArray(
    value.connectorScopes,
    CODING_WORKBENCH_CONNECTOR_SCOPES,
    "authorityEnvelope.connectorScopes",
    errors,
    false,
  );
}

function validateAuthorityEffectiveMode(value: Record<string, unknown>, errors: string[]): void {
  validateModePolicyConsistency(
    isOneOf(value.effectiveMode, CODING_WORKBENCH_MODES) ? value.effectiveMode : undefined,
    value.actionClasses,
    "authorityEnvelope.actionClasses",
    errors,
  );
  if (
    isOneOf(value.effectiveMode, CODING_WORKBENCH_MODES) &&
    value.effectiveMode !==
      resolveEffectiveCodingWorkbenchMode(value.requestedMode, value.deploymentCeiling)
  ) {
    errors.push(
      "authorityEnvelope.effectiveMode must be the fail-closed minimum of requestedMode and deploymentCeiling",
    );
  }
  const commandPolicy = isRecord(value.commandPolicy) ? value.commandPolicy : undefined;
  const networkPolicy = isRecord(value.networkPolicy) ? value.networkPolicy : undefined;
  validateCommandPolicyActionClassConsistency(value, errors);
  if (value.effectiveMode === "governed-assist") {
    validateGovernedAssistAuthorityConstraints(value, commandPolicy, networkPolicy, errors);
  }
}

function validateGovernedAssistAuthorityConstraints(
  value: Record<string, unknown>,
  commandPolicy: Record<string, unknown> | undefined,
  networkPolicy: Record<string, unknown> | undefined,
  errors: string[],
): void {
  if (commandPolicy?.mode !== "deny") {
    errors.push(
      "authorityEnvelope.commandPolicy.mode must be deny when effectiveMode is governed-assist",
    );
  }
  if (networkPolicy?.mode !== "deny-all") {
    errors.push(
      "authorityEnvelope.networkPolicy.mode must be deny-all when effectiveMode is governed-assist",
    );
  }
  if (hasWriteCapableConnectorScope(value.connectorScopes)) {
    errors.push(
      "authorityEnvelope.connectorScopes must not include write-capable scopes when effectiveMode is governed-assist",
    );
  }
  if (hasWriteCapableConnectorScope(networkPolicy?.connectorScopes)) {
    errors.push(
      "authorityEnvelope.networkPolicy.connectorScopes must not include write-capable scopes when effectiveMode is governed-assist",
    );
  }
}

function validateNetworkPolicyConnectorScopesConsistency(
  value: Record<string, unknown>,
  errors: string[],
): void {
  if (!isRecord(value.networkPolicy) || !Array.isArray(value.connectorScopes)) return;
  const networkConnectorScopes: readonly string[] | undefined = Array.isArray(
    value.networkPolicy.connectorScopes,
  )
    ? (value.networkPolicy.connectorScopes as readonly string[])
    : undefined;
  if (networkConnectorScopes === undefined) return;
  if (value.networkPolicy.mode === "deny-all" && networkConnectorScopes.length > 0) {
    errors.push(
      "authorityEnvelope.networkPolicy.connectorScopes must be empty when mode is deny-all",
    );
  }
  const allowedScopes = new Set(
    value.connectorScopes.filter((entry): entry is string => typeof entry === "string"),
  );
  networkConnectorScopes.forEach((scope, index) => {
    if (!allowedScopes.has(scope)) {
      errors.push(
        `authorityEnvelope.networkPolicy.connectorScopes[${String(index)}] must be listed in authorityEnvelope.connectorScopes`,
      );
    }
  });
}

function validateRuntimeEventFields(value: Record<string, unknown>, errors: string[]): void {
  validateRuntimeEventAllowedKeys(value, errors);
  validateRuntimeEventModeFields(value, errors);
  validateRuntimeEventStatusFields(value, errors);
  validateRuntimeEventEvidenceFields(value, errors);
  validateRuntimeEventModeOrdering(value, errors);
  validateRuntimeEventRequiredFields(value, errors);
}

function validateRuntimeEventCounts(value: Record<string, unknown>, errors: string[]): void {
  if (value.sequence !== undefined && !isSafeIntegerOrZero(value.sequence)) {
    errors.push("event.sequence must be a non-negative safe integer");
  }
  if (value.byteCount !== undefined && !isSafeIntegerOrZero(value.byteCount)) {
    errors.push("event.byteCount must be a non-negative safe integer");
  }
  [
    "fileCount",
    "addedLines",
    "deletedLines",
    "passedCount",
    "failedCount",
    "skippedCount",
    "artifactBytes",
  ].forEach((key) => {
    if (value[key] !== undefined && !isSafeIntegerOrZero(value[key])) {
      errors.push(`event.${key} must be a non-negative safe integer`);
    }
  });
  if (value.truncated !== undefined && typeof value.truncated !== "boolean") {
    errors.push("event.truncated must be a boolean");
  }
  if (value.retryable !== undefined && typeof value.retryable !== "boolean") {
    errors.push("event.retryable must be a boolean");
  }
}

function validateRuntimeEventSafeText(value: Record<string, unknown>, errors: string[]): void {
  if (value.artifactDigest !== undefined) {
    validateDigest(value.artifactDigest, "event.artifactDigest", errors);
  }
  if (value.failureSummary !== undefined) {
    validateSafeEvidenceText(value.failureSummary, "event.failureSummary", errors);
  }
}

function validateRuntimeEventModeOrdering(value: Record<string, unknown>, errors: string[]): void {
  if (
    !isOneOf(value.requestedMode, CODING_WORKBENCH_MODES) ||
    !isOneOf(value.effectiveMode, CODING_WORKBENCH_MODES)
  ) {
    return;
  }
  if (
    CODING_WORKBENCH_MODES.indexOf(value.effectiveMode) >
    CODING_WORKBENCH_MODES.indexOf(value.requestedMode)
  ) {
    errors.push("event.effectiveMode must be no higher than event.requestedMode");
  }
}

function validateRuntimeStartedEventFields(value: Record<string, unknown>, errors: string[]): void {
  validateRequiredEnumField(
    value,
    "runtimeSource",
    CODING_WORKBENCH_RUNTIME_SOURCES,
    "event",
    errors,
  );
  validateRequiredEnumField(value, "modelSource", CODING_WORKBENCH_MODEL_SOURCES, "event", errors);
  validateRequiredEnumField(value, "requestedMode", CODING_WORKBENCH_MODES, "event", errors);
  validateRequiredEnumField(value, "effectiveMode", CODING_WORKBENCH_MODES, "event", errors);
}

function validateRuntimeStoppedEventFields(value: Record<string, unknown>, errors: string[]): void {
  validateRequiredEnumField(
    value,
    "runtimeSource",
    CODING_WORKBENCH_RUNTIME_SOURCES,
    "event",
    errors,
  );
  validateRequiredEnumField(value, "modelSource", CODING_WORKBENCH_MODEL_SOURCES, "event", errors);
  validateRequiredEnumField(
    value,
    "health",
    CODING_WORKBENCH_RUNTIME_HEALTH_STATES,
    "event",
    errors,
  );
  validateRequiredEnumField(value, "effectiveMode", CODING_WORKBENCH_MODES, "event", errors);
}

function validateRuntimeHealthEventFields(value: Record<string, unknown>, errors: string[]): void {
  validateRequiredEnumField(
    value,
    "runtimeSource",
    CODING_WORKBENCH_RUNTIME_SOURCES,
    "event",
    errors,
  );
  validateRequiredEnumField(value, "modelSource", CODING_WORKBENCH_MODEL_SOURCES, "event", errors);
  validateRequiredEnumField(
    value,
    "health",
    CODING_WORKBENCH_RUNTIME_HEALTH_STATES,
    "event",
    errors,
  );
}

function validateTaskSubmittedEventFields(value: Record<string, unknown>, errors: string[]): void {
  validateRequiredSafeEvidenceTextField(value, "taskRef", "event", errors);
  validateRequiredEnumField(value, "requestedMode", CODING_WORKBENCH_MODES, "event", errors);
  validateRequiredEnumField(value, "effectiveMode", CODING_WORKBENCH_MODES, "event", errors);
}

function validateObservationEventFields(value: Record<string, unknown>, errors: string[]): void {
  validateRequiredEnumField(
    value,
    "channel",
    CODING_WORKBENCH_OBSERVATION_CHANNELS,
    "event",
    errors,
  );
  validateRequiredSafeIntegerField(value, "sequence", "event", errors);
  validateRequiredSafeIntegerField(value, "byteCount", "event", errors);
}

function validatePermissionRequestedEventFields(
  value: Record<string, unknown>,
  errors: string[],
): void {
  if (value.permissionRequest === undefined) {
    errors.push("event.permissionRequest is required");
    return;
  }
  validatePermissionRequestInternal(value.permissionRequest, "event.permissionRequest", errors);
}

function validateDiffSummarizedEventFields(value: Record<string, unknown>, errors: string[]): void {
  validateRequiredSafeIntegerField(value, "fileCount", "event", errors);
  validateRequiredSafeIntegerField(value, "addedLines", "event", errors);
  validateRequiredSafeIntegerField(value, "deletedLines", "event", errors);
}

function validateVerificationSummarizedEventFields(
  value: Record<string, unknown>,
  errors: string[],
): void {
  validateRequiredSafeEvidenceTextField(value, "verificationKind", "event", errors);
  validateRequiredEnumField(
    value,
    "verificationStatus",
    ["passed", "failed", "partial"],
    "event",
    errors,
  );
  validateRequiredSafeIntegerField(value, "passedCount", "event", errors);
  validateRequiredSafeIntegerField(value, "failedCount", "event", errors);
  validateRequiredSafeIntegerField(value, "skippedCount", "event", errors);
}

function validateArtifactProducedEventFields(
  value: Record<string, unknown>,
  errors: string[],
): void {
  validateRequiredSafeEvidenceTextField(value, "artifactKind", "event", errors);
  validateRequiredSafeEvidenceTextField(value, "artifactLabel", "event", errors);
  validateRequiredDigestField(value, "artifactDigest", "event", errors);
  validateRequiredSafeIntegerField(value, "artifactBytes", "event", errors);
}

function validateFailureRedactedEventFields(
  value: Record<string, unknown>,
  errors: string[],
): void {
  validateRequiredSafeEvidenceTextField(value, "failureCode", "event", errors);
  validateRequiredSafeEvidenceTextField(value, "failureSummary", "event", errors);
  validateRequiredBooleanField(value, "retryable", "event", errors);
}

const CODING_WORKBENCH_RUNTIME_EVENT_REQUIRED_FIELD_VALIDATORS: Readonly<
  Record<
    CodingWorkbenchRuntimeEventKind,
    (value: Record<string, unknown>, errors: string[]) => void
  >
> = Object.freeze({
  "runtime-started": validateRuntimeStartedEventFields,
  "runtime-stopped": validateRuntimeStoppedEventFields,
  "runtime-health": validateRuntimeHealthEventFields,
  "task-submitted": validateTaskSubmittedEventFields,
  "observation-streamed": validateObservationEventFields,
  "permission-requested": validatePermissionRequestedEventFields,
  "diff-summarized": validateDiffSummarizedEventFields,
  "verification-summarized": validateVerificationSummarizedEventFields,
  "artifact-produced": validateArtifactProducedEventFields,
  "failure-redacted": validateFailureRedactedEventFields,
} as const);

function validateRuntimeEventRequiredFields(
  value: Record<string, unknown>,
  errors: string[],
): void {
  if (!isOneOf(value.kind, CODING_WORKBENCH_RUNTIME_EVENT_KINDS)) return;
  CODING_WORKBENCH_RUNTIME_EVENT_REQUIRED_FIELD_VALIDATORS[value.kind](value, errors);
}

export function validateCodingWorkbenchAuthorityEnvelope(
  value: unknown,
): CodingWorkbenchValidationResult<CodingWorkbenchAuthorityEnvelope> {
  if (!isRecord(value)) {
    return { ok: false, errors: ["authority envelope must be an object"] };
  }
  const errors: string[] = [];
  validateAuthorityKnownFields(value, errors);
  validateAuthorityModeFields(value, errors);
  validateAuthorityPolicyFields(value, errors);
  validateAuthorityEffectiveMode(value, errors);
  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, value: value as unknown as CodingWorkbenchAuthorityEnvelope };
}

export function validateCodingWorkbenchPermissionRequest(
  value: unknown,
): CodingWorkbenchValidationResult<CodingWorkbenchPermissionRequest> {
  if (!isRecord(value)) {
    return { ok: false, errors: ["permission request must be an object"] };
  }
  const errors: string[] = [];
  validatePermissionRequestInternal(value, "permissionRequest", errors);
  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, value: value as unknown as CodingWorkbenchPermissionRequest };
}

export function validateCodingWorkbenchRuntimeEvent(
  value: unknown,
): CodingWorkbenchValidationResult<CodingWorkbenchRuntimeEvent> {
  if (!isRecord(value)) {
    return { ok: false, errors: ["runtime event must be an object"] };
  }
  const errors: string[] = [];
  validateEventCommon(value, errors);
  validateRuntimeEventFields(value, errors);
  validateRuntimeEventCounts(value, errors);
  validateRuntimeEventSafeText(value, errors);
  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, value: value as unknown as CodingWorkbenchRuntimeEvent };
}
