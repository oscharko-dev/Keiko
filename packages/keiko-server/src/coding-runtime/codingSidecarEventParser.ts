import {
  CODING_WORKBENCH_ACTION_CLASSES,
  CODING_WORKBENCH_APPROVAL_RISKS,
  CODING_WORKBENCH_CONNECTOR_SCOPES,
  CODING_WORKBENCH_PERMISSION_REQUEST_KINDS,
  CODING_WORKBENCH_RUNTIME_HEALTH_STATES,
  CODING_WORKBENCH_SUPERVISED_ACTION_KINDS,
  CODING_WORKBENCH_SUPERVISED_POLICY_REASONS,
  type CodingWorkbenchActionClass,
  type CodingWorkbenchApprovalRisk,
  type CodingWorkbenchConnectorScope,
  type CodingWorkbenchPermissionRequestKind,
  type CodingWorkbenchRuntimeHealth,
  type CodingWorkbenchSupervisedActionKind,
  type CodingWorkbenchSupervisedPolicyReason,
} from "@oscharko-dev/keiko-contracts";
import {
  parseSupervisedCodingApprovalClaim,
  type SupervisedCodingApprovalClaim,
} from "./supervisedCodingApprovalStore.js";

export interface SidecarPermissionEvent {
  readonly type: "permission-request";
  readonly requestId: string;
  readonly kind: CodingWorkbenchPermissionRequestKind;
  readonly actionClass: CodingWorkbenchActionClass;
  readonly reasonCode: string;
  readonly expiresAt: string;
  readonly actionKind?: CodingWorkbenchSupervisedActionKind | undefined;
  readonly scopeLabel?: string | undefined;
  readonly risk?: CodingWorkbenchApprovalRisk | undefined;
  readonly policyReason?: CodingWorkbenchSupervisedPolicyReason | undefined;
  readonly connectorScopes?: readonly CodingWorkbenchConnectorScope[] | undefined;
  readonly commandLabel?: string | undefined;
  readonly targetPath?: string | undefined;
  readonly allowedRelativePaths?: readonly string[] | undefined;
  readonly fileCount?: number | undefined;
  readonly addedLines?: number | undefined;
  readonly deletedLines?: number | undefined;
  readonly executable?: string | undefined;
  readonly args?: readonly string[] | undefined;
  readonly passedCount?: number | undefined;
  readonly failedCount?: number | undefined;
  readonly skippedCount?: number | undefined;
  readonly approvalToken?: SupervisedCodingApprovalClaim | undefined;
  readonly approvalTokenMalformed?: boolean | undefined;
  readonly operatorStopped?: boolean | undefined;
}

export interface SidecarHealthEvent {
  readonly type: "health";
  readonly health: CodingWorkbenchRuntimeHealth;
}

export type SidecarEventParseResult =
  | { readonly status: "empty" }
  | { readonly status: "invalid" }
  | { readonly status: "parsed"; readonly event: SidecarHealthEvent | SidecarPermissionEvent };

export function parseCodingSidecarEventLine(line: string): SidecarEventParseResult {
  if (line.length === 0) return { status: "empty" };
  const parsed = parseJson(line);
  if (!isRecord(parsed)) return { status: "invalid" };
  const event = typedSidecarEvent(parsed);
  return event === undefined ? { status: "invalid" } : { status: "parsed", event };
}

function typedSidecarEvent(
  record: Record<string, unknown>,
): SidecarHealthEvent | SidecarPermissionEvent | undefined {
  if (record.type === "health") return healthEvent(record);
  if (record.type === "permission-request") return permissionEvent(record);
  return undefined;
}

function healthEvent(record: Record<string, unknown>): SidecarHealthEvent | undefined {
  const health = record.health;
  return typeof health === "string" && isRuntimeHealth(health)
    ? { type: "health", health }
    : undefined;
}

function permissionEvent(record: Record<string, unknown>): SidecarPermissionEvent | undefined {
  const requestId = stringField(record, "requestId");
  const kind = permissionKind(record.kind);
  const actionClass = actionClassValue(record.actionClass);
  const reasonCode = stringField(record, "reasonCode");
  const expiresAt = stringField(record, "expiresAt");
  const connectorScopes = optionalConnectorScopes(record);
  if (requestId === undefined || kind === undefined || actionClass === undefined) return undefined;
  if (reasonCode === undefined || expiresAt === undefined) return undefined;
  if (connectorScopes === undefined) return undefined;
  return {
    type: "permission-request",
    requestId,
    kind,
    actionClass,
    reasonCode,
    expiresAt,
    ...optionalSupervisedPromptMetadata(record),
    ...connectorScopes,
    ...optionalCommandLabel(record),
    ...optionalFileEditMetadata(record),
    ...optionalVerificationMetadata(record),
    ...optionalMutationMetadata(record),
  };
}

function optionalSupervisedPromptMetadata(
  record: Record<string, unknown>,
): Partial<SidecarPermissionEvent> {
  return {
    ...optionalActionKind(record),
    ...optionalScopeLabel(record),
    ...optionalRisk(record),
    ...optionalPolicyReason(record),
  };
}

function optionalConnectorScopes(record: Record<string, unknown>):
  | {
      readonly connectorScopes?: readonly CodingWorkbenchConnectorScope[];
    }
  | undefined {
  if (!Object.prototype.hasOwnProperty.call(record, "connectorScopes")) return {};
  const connectorScopes = connectorScopeArray(record.connectorScopes);
  return connectorScopes === undefined ? undefined : { connectorScopes };
}

function optionalCommandLabel(record: Record<string, unknown>): { readonly commandLabel?: string } {
  const commandLabel = stringField(record, "commandLabel");
  return commandLabel === undefined ? {} : { commandLabel };
}

function optionalFileEditMetadata(
  record: Record<string, unknown>,
): Partial<SidecarPermissionEvent> {
  return {
    ...optionalStringField(record, "targetPath"),
    ...optionalStringArrayField(record, "allowedRelativePaths"),
    ...optionalIntegerField(record, "fileCount"),
    ...optionalIntegerField(record, "addedLines"),
    ...optionalIntegerField(record, "deletedLines"),
  };
}

function optionalVerificationMetadata(
  record: Record<string, unknown>,
): Partial<SidecarPermissionEvent> {
  return {
    ...optionalStringField(record, "executable"),
    ...optionalStringArrayField(record, "args"),
    ...optionalIntegerField(record, "passedCount"),
    ...optionalIntegerField(record, "failedCount"),
    ...optionalIntegerField(record, "skippedCount"),
  };
}

function optionalMutationMetadata(
  record: Record<string, unknown>,
): Partial<SidecarPermissionEvent> {
  return {
    ...optionalApprovalToken(record),
    ...optionalBooleanField(record, "operatorStopped"),
  };
}

function optionalActionKind(record: Record<string, unknown>): {
  readonly actionKind?: CodingWorkbenchSupervisedActionKind;
} {
  const actionKind = supervisedActionKind(record.actionKind);
  return actionKind === undefined ? {} : { actionKind };
}

function optionalScopeLabel(record: Record<string, unknown>): { readonly scopeLabel?: string } {
  const scopeLabel = stringField(record, "scopeLabel");
  return scopeLabel === undefined ? {} : { scopeLabel };
}

function optionalRisk(record: Record<string, unknown>): {
  readonly risk?: CodingWorkbenchApprovalRisk;
} {
  const risk = approvalRisk(record.risk);
  return risk === undefined ? {} : { risk };
}

function optionalPolicyReason(record: Record<string, unknown>): {
  readonly policyReason?: CodingWorkbenchSupervisedPolicyReason;
} {
  const policyReason = supervisedPolicyReason(record.policyReason);
  return policyReason === undefined ? {} : { policyReason };
}

function optionalStringField(
  record: Record<string, unknown>,
  key: keyof SidecarPermissionEvent,
): Partial<SidecarPermissionEvent> {
  const value = stringField(record, key);
  return value === undefined ? {} : { [key]: value };
}

function optionalStringArrayField(
  record: Record<string, unknown>,
  key: keyof SidecarPermissionEvent,
): Partial<SidecarPermissionEvent> {
  const value = stringArray(record[key]);
  return value === undefined ? {} : { [key]: value };
}

function optionalIntegerField(
  record: Record<string, unknown>,
  key: keyof SidecarPermissionEvent,
): Partial<SidecarPermissionEvent> {
  const value = nonNegativeInteger(record[key]);
  return value === undefined ? {} : { [key]: value };
}

function optionalBooleanField(
  record: Record<string, unknown>,
  key: keyof SidecarPermissionEvent,
): Partial<SidecarPermissionEvent> {
  const value = record[key];
  return typeof value === "boolean" ? { [key]: value } : {};
}

function optionalApprovalToken(
  record: Record<string, unknown>,
): Pick<SidecarPermissionEvent, "approvalToken" | "approvalTokenMalformed"> {
  if (!Object.prototype.hasOwnProperty.call(record, "approvalToken")) return {};
  const token = approvalToken(record.approvalToken);
  return token === undefined
    ? { approvalTokenMalformed: true }
    : { approvalToken: token, approvalTokenMalformed: false };
}

function parseJson(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.every((entry) => typeof entry === "string") ? value : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function permissionKind(value: unknown): CodingWorkbenchPermissionRequestKind | undefined {
  return typeof value === "string" &&
    (CODING_WORKBENCH_PERMISSION_REQUEST_KINDS as readonly string[]).includes(value)
    ? (value as CodingWorkbenchPermissionRequestKind)
    : undefined;
}

function actionClassValue(value: unknown): CodingWorkbenchActionClass | undefined {
  return typeof value === "string" &&
    (CODING_WORKBENCH_ACTION_CLASSES as readonly string[]).includes(value)
    ? (value as CodingWorkbenchActionClass)
    : undefined;
}

function connectorScopeArray(value: unknown): readonly CodingWorkbenchConnectorScope[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const scopes = value.filter((entry): entry is CodingWorkbenchConnectorScope =>
    connectorScopeValue(entry),
  );
  return scopes.length === value.length ? scopes : undefined;
}

function connectorScopeValue(value: unknown): value is CodingWorkbenchConnectorScope {
  return (
    typeof value === "string" &&
    (CODING_WORKBENCH_CONNECTOR_SCOPES as readonly string[]).includes(value)
  );
}

function supervisedActionKind(value: unknown): CodingWorkbenchSupervisedActionKind | undefined {
  return typeof value === "string" &&
    (CODING_WORKBENCH_SUPERVISED_ACTION_KINDS as readonly string[]).includes(value)
    ? (value as CodingWorkbenchSupervisedActionKind)
    : undefined;
}

function approvalRisk(value: unknown): CodingWorkbenchApprovalRisk | undefined {
  return typeof value === "string" &&
    (CODING_WORKBENCH_APPROVAL_RISKS as readonly string[]).includes(value)
    ? (value as CodingWorkbenchApprovalRisk)
    : undefined;
}

function supervisedPolicyReason(value: unknown): CodingWorkbenchSupervisedPolicyReason | undefined {
  return typeof value === "string" &&
    (CODING_WORKBENCH_SUPERVISED_POLICY_REASONS as readonly string[]).includes(value)
    ? (value as CodingWorkbenchSupervisedPolicyReason)
    : undefined;
}

function approvalToken(value: unknown): SupervisedCodingApprovalClaim | undefined {
  return parseSupervisedCodingApprovalClaim(value);
}

function isRuntimeHealth(value: string): value is CodingWorkbenchRuntimeHealth {
  return (CODING_WORKBENCH_RUNTIME_HEALTH_STATES as readonly string[]).includes(value);
}
