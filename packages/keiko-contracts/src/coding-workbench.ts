export const CODING_WORKBENCH_SCHEMA_VERSION = "1" as const;

export type CodingWorkbenchMode = "governed-assist" | "supervised-coding" | "autonomous-delivery";

export const CODING_WORKBENCH_MODES: readonly CodingWorkbenchMode[] = Object.freeze([
  "governed-assist",
  "supervised-coding",
  "autonomous-delivery",
] as const satisfies readonly CodingWorkbenchMode[]);

export type CodingWorkbenchRuntimeSource =
  "keiko-sidecar" | "codex-cli-adapter" | "delivery-runner";

export const CODING_WORKBENCH_RUNTIME_SOURCES: readonly CodingWorkbenchRuntimeSource[] =
  Object.freeze([
    "keiko-sidecar",
    "codex-cli-adapter",
    "delivery-runner",
  ] as const satisfies readonly CodingWorkbenchRuntimeSource[]);

export type CodingWorkbenchModelSource =
  "keiko-model-gateway" | "openai-api-key-through-gateway" | "chatgpt-codex-subscription-profile";

export const CODING_WORKBENCH_MODEL_SOURCES: readonly CodingWorkbenchModelSource[] = Object.freeze([
  "keiko-model-gateway",
  "openai-api-key-through-gateway",
  "chatgpt-codex-subscription-profile",
] as const satisfies readonly CodingWorkbenchModelSource[]);

export type CodingWorkbenchActionClass =
  | "workspace-read"
  | "workspace-write"
  | "command-execution"
  | "verification"
  | "connector-access"
  | "network-egress"
  | "delivery-substrate";

export const CODING_WORKBENCH_ACTION_CLASSES: readonly CodingWorkbenchActionClass[] = Object.freeze(
  [
    "workspace-read",
    "workspace-write",
    "command-execution",
    "verification",
    "connector-access",
    "network-egress",
    "delivery-substrate",
  ] as const satisfies readonly CodingWorkbenchActionClass[],
);

export type CodingWorkbenchConnectorScope =
  "source-control.read" | "source-control.write" | "issue-tracker.read" | "issue-tracker.write";

export const CODING_WORKBENCH_CONNECTOR_SCOPES: readonly CodingWorkbenchConnectorScope[] =
  Object.freeze([
    "source-control.read",
    "source-control.write",
    "issue-tracker.read",
    "issue-tracker.write",
  ] as const satisfies readonly CodingWorkbenchConnectorScope[]);

export type CodingWorkbenchNetworkMode = "deny-all" | "governed-egress" | "connector-scoped-egress";

export const CODING_WORKBENCH_NETWORK_MODES: readonly CodingWorkbenchNetworkMode[] = Object.freeze([
  "deny-all",
  "governed-egress",
  "connector-scoped-egress",
] as const satisfies readonly CodingWorkbenchNetworkMode[]);

export type CodingWorkbenchGate =
  | "human-approval"
  | "branch-allowlist"
  | "verification-green"
  | "policy-review"
  | "artifact-review";

export const CODING_WORKBENCH_GATES: readonly CodingWorkbenchGate[] = Object.freeze([
  "human-approval",
  "branch-allowlist",
  "verification-green",
  "policy-review",
  "artifact-review",
] as const satisfies readonly CodingWorkbenchGate[]);

export type CodingWorkbenchCommandPolicyMode = "deny" | "allowlisted" | "governed";

export const CODING_WORKBENCH_COMMAND_POLICY_MODES: readonly CodingWorkbenchCommandPolicyMode[] =
  Object.freeze([
    "deny",
    "allowlisted",
    "governed",
  ] as const satisfies readonly CodingWorkbenchCommandPolicyMode[]);

export type CodingWorkbenchRuntimeHealth = "ready" | "busy" | "degraded" | "stopped";

export const CODING_WORKBENCH_RUNTIME_HEALTH_STATES: readonly CodingWorkbenchRuntimeHealth[] =
  Object.freeze([
    "ready",
    "busy",
    "degraded",
    "stopped",
  ] as const satisfies readonly CodingWorkbenchRuntimeHealth[]);

export type CodingWorkbenchObservationChannel = "status" | "tool" | "verification" | "permission";

export const CODING_WORKBENCH_OBSERVATION_CHANNELS: readonly CodingWorkbenchObservationChannel[] =
  Object.freeze([
    "status",
    "tool",
    "verification",
    "permission",
  ] as const satisfies readonly CodingWorkbenchObservationChannel[]);

export type CodingWorkbenchPermissionRequestKind =
  | "workspace-write"
  | "command-execution"
  | "network-egress"
  | "connector-access"
  | "delivery-substrate";

export const CODING_WORKBENCH_PERMISSION_REQUEST_KINDS: readonly CodingWorkbenchPermissionRequestKind[] =
  Object.freeze([
    "workspace-write",
    "command-execution",
    "network-egress",
    "connector-access",
    "delivery-substrate",
  ] as const satisfies readonly CodingWorkbenchPermissionRequestKind[]);

export type CodingWorkbenchSupervisedActionKind =
  | "file-edit"
  | "verification-command"
  | "commit"
  | "push"
  | "pull-request"
  | "merge"
  | "connector-write"
  | "external-write"
  | "system-mutation";

export const CODING_WORKBENCH_SUPERVISED_ACTION_KINDS: readonly CodingWorkbenchSupervisedActionKind[] =
  Object.freeze([
    "file-edit",
    "verification-command",
    "commit",
    "push",
    "pull-request",
    "merge",
    "connector-write",
    "external-write",
    "system-mutation",
  ] as const satisfies readonly CodingWorkbenchSupervisedActionKind[]);

export type CodingWorkbenchApprovalRisk = "low" | "medium" | "high" | "critical";

export const CODING_WORKBENCH_APPROVAL_RISKS: readonly CodingWorkbenchApprovalRisk[] =
  Object.freeze(["low", "medium", "high", "critical"] as const);

export type CodingWorkbenchSupervisedPolicyReason =
  | "scoped-file-edit"
  | "out-of-scope-file-edit"
  | "allowlisted-verification-command"
  | "unknown-command-denied"
  | "mutating-command-denied"
  | "approval-required"
  | "approval-proof-missing"
  | "approval-proof-stale"
  | "approval-proof-accepted"
  | "operator-denied"
  | "operator-stopped"
  | "redacted-failure";

export const CODING_WORKBENCH_SUPERVISED_POLICY_REASONS: readonly CodingWorkbenchSupervisedPolicyReason[] =
  Object.freeze([
    "scoped-file-edit",
    "out-of-scope-file-edit",
    "allowlisted-verification-command",
    "unknown-command-denied",
    "mutating-command-denied",
    "approval-required",
    "approval-proof-missing",
    "approval-proof-stale",
    "approval-proof-accepted",
    "operator-denied",
    "operator-stopped",
    "redacted-failure",
  ] as const satisfies readonly CodingWorkbenchSupervisedPolicyReason[]);

export type CodingWorkbenchRuntimeEventKind =
  | "runtime-started"
  | "runtime-stopped"
  | "runtime-health"
  | "task-submitted"
  | "observation-streamed"
  | "permission-requested"
  | "diff-summarized"
  | "verification-summarized"
  | "artifact-produced"
  | "failure-redacted";

export const CODING_WORKBENCH_RUNTIME_EVENT_KINDS: readonly CodingWorkbenchRuntimeEventKind[] =
  Object.freeze([
    "runtime-started",
    "runtime-stopped",
    "runtime-health",
    "task-submitted",
    "observation-streamed",
    "permission-requested",
    "diff-summarized",
    "verification-summarized",
    "artifact-produced",
    "failure-redacted",
  ] as const satisfies readonly CodingWorkbenchRuntimeEventKind[]);

export interface CodingWorkbenchModePolicy {
  readonly allowedActionClasses: readonly CodingWorkbenchActionClass[];
  readonly allowsWorkspaceWrites: boolean;
  readonly allowsCommandExecution: boolean;
  readonly allowsDeliverySubstrate: boolean;
}

export type CodingWorkbenchPolicyDenialReason =
  | "workspace-read-denied"
  | "workspace-write-denied"
  | "command-execution-denied"
  | "verification-denied"
  | "connector-access-denied"
  | "connector-write-denied"
  | "network-denied"
  | "delivery-denied";

export type CodingWorkbenchActionPolicyDecision =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly reasonCode: CodingWorkbenchPolicyDenialReason;
    };

export const CODING_WORKBENCH_MODE_POLICIES: Readonly<
  Record<CodingWorkbenchMode, CodingWorkbenchModePolicy>
> = Object.freeze({
  "governed-assist": {
    allowedActionClasses: ["workspace-read", "verification", "connector-access"],
    allowsWorkspaceWrites: false,
    allowsCommandExecution: false,
    allowsDeliverySubstrate: false,
  },
  "supervised-coding": {
    allowedActionClasses: [
      "workspace-read",
      "workspace-write",
      "command-execution",
      "verification",
      "connector-access",
    ],
    allowsWorkspaceWrites: true,
    allowsCommandExecution: true,
    allowsDeliverySubstrate: false,
  },
  "autonomous-delivery": {
    allowedActionClasses: CODING_WORKBENCH_ACTION_CLASSES,
    allowsWorkspaceWrites: true,
    allowsCommandExecution: true,
    allowsDeliverySubstrate: true,
  },
} as const satisfies Readonly<Record<CodingWorkbenchMode, CodingWorkbenchModePolicy>>);

const CODING_WORKBENCH_MODE_ORDER: Readonly<Record<CodingWorkbenchMode, number>> = Object.freeze({
  "governed-assist": 0,
  "supervised-coding": 1,
  "autonomous-delivery": 2,
} as const satisfies Readonly<Record<CodingWorkbenchMode, number>>);

const CODING_WORKBENCH_ACTION_DENIAL_REASONS: Readonly<
  Record<CodingWorkbenchActionClass, CodingWorkbenchPolicyDenialReason>
> = Object.freeze({
  "workspace-read": "workspace-read-denied",
  "workspace-write": "workspace-write-denied",
  "command-execution": "command-execution-denied",
  verification: "verification-denied",
  "connector-access": "connector-access-denied",
  "network-egress": "network-denied",
  "delivery-substrate": "delivery-denied",
} as const satisfies Readonly<
  Record<CodingWorkbenchActionClass, CodingWorkbenchPolicyDenialReason>
>);

const CODING_WORKBENCH_WRITE_CAPABLE_CONNECTOR_SCOPES = new Set<CodingWorkbenchConnectorScope>([
  "source-control.write",
  "issue-tracker.write",
]);

export interface CodingWorkbenchWorkspaceIdentity {
  readonly workspaceId: string;
  readonly rootLabel: string;
  readonly rootDigest: string;
}

export interface CodingWorkbenchBranchConstraints {
  readonly baseRef: string;
  readonly headRef: string;
  readonly allowDetachedHead: boolean;
  readonly allowedPrefixes: readonly string[];
}

export interface CodingWorkbenchModelProfile {
  readonly profileId: string;
  readonly source: CodingWorkbenchModelSource;
  readonly supportsStreaming: boolean;
  readonly supportsToolCalling: boolean;
}

export type CodingWorkbenchSidecarGatewayStatus = "available" | "unavailable";

export type CodingWorkbenchSidecarGatewayUnavailableReason =
  | "missing-config"
  | "missing-provider"
  | "missing-credentials"
  | "non-chat"
  | "no-tool-calling"
  | "non-workflow-eligible"
  | "non-coding-capable"
  | "deployment-policy-disabled"
  | "subscription-source";

export interface CodingWorkbenchSidecarGatewayRunMetadata {
  readonly maxPromptTokens: number;
  readonly maxOutputTokens: number;
  readonly maxInputMessages: number;
  readonly maxRequestBytes: number;
}

export interface CodingWorkbenchSidecarGatewayProjection {
  readonly status: "available";
  readonly profileId: string;
  readonly modelAlias: string;
  readonly localEndpointPath: string;
  readonly supportsStreaming: boolean;
  readonly supportsToolCalling: boolean;
  readonly runMetadata: CodingWorkbenchSidecarGatewayRunMetadata;
}

export interface CodingWorkbenchSidecarGatewayUnavailable {
  readonly status: "unavailable";
  readonly reason: CodingWorkbenchSidecarGatewayUnavailableReason;
}

export type CodingWorkbenchSidecarGatewayResult =
  CodingWorkbenchSidecarGatewayProjection | CodingWorkbenchSidecarGatewayUnavailable;

export interface CodingWorkbenchCommandPolicy {
  readonly mode: CodingWorkbenchCommandPolicyMode;
  readonly allow: readonly string[];
  readonly deny: readonly string[];
  readonly maxCommandTimeoutMs: number;
  readonly requirePerCommandApproval: boolean;
}

export interface CodingWorkbenchNetworkPolicy {
  readonly mode: CodingWorkbenchNetworkMode;
  readonly allowLoopback: boolean;
  readonly connectorScopes: readonly CodingWorkbenchConnectorScope[];
}

export interface CodingWorkbenchBudget {
  readonly maxRuntimeMs: number;
  readonly maxToolCalls: number;
  readonly maxPromptTokens: number;
  readonly maxPatchBytes: number;
}

export interface CodingWorkbenchAuthorityEnvelope {
  readonly schemaVersion: typeof CODING_WORKBENCH_SCHEMA_VERSION;
  readonly runId: string;
  readonly localUser: string;
  readonly taskRefs: readonly string[];
  readonly workspace: CodingWorkbenchWorkspaceIdentity;
  readonly branch: CodingWorkbenchBranchConstraints;
  readonly requestedMode: CodingWorkbenchMode;
  readonly deploymentCeiling: CodingWorkbenchMode;
  readonly effectiveMode: CodingWorkbenchMode;
  readonly runtimeSource: CodingWorkbenchRuntimeSource;
  readonly actionClasses: readonly CodingWorkbenchActionClass[];
  readonly connectorScopes: readonly CodingWorkbenchConnectorScope[];
  readonly modelProfile: CodingWorkbenchModelProfile;
  readonly commandPolicy: CodingWorkbenchCommandPolicy;
  readonly networkPolicy: CodingWorkbenchNetworkPolicy;
  readonly gates: readonly CodingWorkbenchGate[];
  readonly budget: CodingWorkbenchBudget;
  readonly expiresAt: string;
  readonly approvalProofDigest: string;
}

export interface CodingWorkbenchPermissionRequest {
  readonly requestId: string;
  readonly kind: CodingWorkbenchPermissionRequestKind;
  readonly actionClass: CodingWorkbenchActionClass;
  readonly reasonCode: string;
  readonly actionKind?: CodingWorkbenchSupervisedActionKind | undefined;
  readonly scopeLabel?: string | undefined;
  readonly risk?: CodingWorkbenchApprovalRisk | undefined;
  readonly policyReason?: CodingWorkbenchSupervisedPolicyReason | undefined;
  readonly connectorScopes?: readonly CodingWorkbenchConnectorScope[] | undefined;
  readonly commandLabel?: string | undefined;
  readonly expiresAt: string;
}

export interface CodingWorkbenchRuntimeEvent {
  readonly schemaVersion: typeof CODING_WORKBENCH_SCHEMA_VERSION;
  readonly eventId: string;
  readonly runId: string;
  readonly occurredAt: string;
  readonly kind: CodingWorkbenchRuntimeEventKind;
  readonly runtimeSource?: CodingWorkbenchRuntimeSource | undefined;
  readonly modelSource?: CodingWorkbenchModelSource | undefined;
  readonly requestedMode?: CodingWorkbenchMode | undefined;
  readonly effectiveMode?: CodingWorkbenchMode | undefined;
  readonly health?: CodingWorkbenchRuntimeHealth | undefined;
  readonly taskRef?: string | undefined;
  readonly channel?: CodingWorkbenchObservationChannel | undefined;
  readonly sequence?: number | undefined;
  readonly byteCount?: number | undefined;
  readonly truncated?: boolean | undefined;
  readonly permissionRequest?: CodingWorkbenchPermissionRequest | undefined;
  readonly fileCount?: number | undefined;
  readonly addedLines?: number | undefined;
  readonly deletedLines?: number | undefined;
  readonly verificationKind?: string | undefined;
  readonly verificationStatus?: "passed" | "failed" | "partial" | undefined;
  readonly passedCount?: number | undefined;
  readonly failedCount?: number | undefined;
  readonly skippedCount?: number | undefined;
  readonly artifactKind?: string | undefined;
  readonly artifactLabel?: string | undefined;
  readonly artifactDigest?: string | undefined;
  readonly artifactBytes?: number | undefined;
  readonly failureCode?: string | undefined;
  readonly failureSummary?: string | undefined;
  readonly retryable?: boolean | undefined;
}

export interface CodingWorkbenchValidationOk<T> {
  readonly ok: true;
  readonly value: T;
}

export interface CodingWorkbenchValidationFail {
  readonly ok: false;
  readonly errors: readonly string[];
}

export type CodingWorkbenchValidationResult<T> =
  CodingWorkbenchValidationOk<T> | CodingWorkbenchValidationFail;

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value);
}

export function isCodingWorkbenchMode(value: unknown): value is CodingWorkbenchMode {
  return isOneOf(value, CODING_WORKBENCH_MODES);
}

export function isCodingWorkbenchRuntimeSource(
  value: unknown,
): value is CodingWorkbenchRuntimeSource {
  return isOneOf(value, CODING_WORKBENCH_RUNTIME_SOURCES);
}

export function isCodingWorkbenchModelSource(value: unknown): value is CodingWorkbenchModelSource {
  return isOneOf(value, CODING_WORKBENCH_MODEL_SOURCES);
}

export function resolveEffectiveCodingWorkbenchMode(
  requestedMode: unknown,
  deploymentCeiling: unknown,
): CodingWorkbenchMode {
  const requested = isCodingWorkbenchMode(requestedMode) ? requestedMode : "governed-assist";
  const ceiling = isCodingWorkbenchMode(deploymentCeiling) ? deploymentCeiling : "governed-assist";
  return CODING_WORKBENCH_MODE_ORDER[requested] <= CODING_WORKBENCH_MODE_ORDER[ceiling]
    ? requested
    : ceiling;
}

export function decideCodingWorkbenchActionForMode(
  mode: CodingWorkbenchMode,
  actionClass: CodingWorkbenchActionClass,
  connectorScopes: readonly CodingWorkbenchConnectorScope[] = [],
): CodingWorkbenchActionPolicyDecision {
  const policy = CODING_WORKBENCH_MODE_POLICIES[mode];
  if (!policy.allowedActionClasses.includes(actionClass)) {
    return denyCodingWorkbenchAction(actionClass);
  }
  if (
    mode === "governed-assist" &&
    actionClass === "connector-access" &&
    hasWriteCapableCodingWorkbenchConnectorScope(connectorScopes)
  ) {
    return { allowed: false, reasonCode: "connector-write-denied" };
  }
  return { allowed: true };
}

export function isCodingWorkbenchActionAllowedForMode(
  mode: CodingWorkbenchMode,
  actionClass: CodingWorkbenchActionClass,
  connectorScopes: readonly CodingWorkbenchConnectorScope[] = [],
): boolean {
  return decideCodingWorkbenchActionForMode(mode, actionClass, connectorScopes).allowed;
}

export function permissionKindForSupervisedCodingAction(
  actionKind: CodingWorkbenchSupervisedActionKind,
): CodingWorkbenchPermissionRequestKind {
  if (actionKind === "file-edit") return "workspace-write";
  if (actionKind === "verification-command") return "command-execution";
  if (actionKind === "connector-write" || actionKind === "external-write") {
    return "connector-access";
  }
  return "delivery-substrate";
}

export function supervisedCodingActionRequiresApproval(
  actionKind: CodingWorkbenchSupervisedActionKind,
): boolean {
  return actionKind !== "file-edit" && actionKind !== "verification-command";
}

function denyCodingWorkbenchAction(
  actionClass: CodingWorkbenchActionClass,
): CodingWorkbenchActionPolicyDecision {
  return { allowed: false, reasonCode: CODING_WORKBENCH_ACTION_DENIAL_REASONS[actionClass] };
}

function hasWriteCapableCodingWorkbenchConnectorScope(
  scopes: readonly CodingWorkbenchConnectorScope[],
): boolean {
  return scopes.some((scope) => CODING_WORKBENCH_WRITE_CAPABLE_CONNECTOR_SCOPES.has(scope));
}
