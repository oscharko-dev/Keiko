import type { ReleaseImpactRemediation, ReleaseImpactStateImpact } from "./release-impact.js";

export const UPDATE_LOCAL_STATE_SCHEMA_VERSION = 1 as const;

export const UPDATE_HEALTH_STATES = [
  "ready",
  "needs-action",
  "unavailable-until-fixed",
  "manual-review-required",
  "not-affected",
] as const;

export type UpdateHealthState = (typeof UPDATE_HEALTH_STATES)[number];

export const UPDATE_HEALTH_LABELS = {
  ready: "Ready",
  "needs-action": "Needs action",
  "unavailable-until-fixed": "Unavailable until fixed",
  "manual-review-required": "Manual review required",
  "not-affected": "Not affected",
} as const satisfies Readonly<Record<UpdateHealthState, string>>;

export const UPDATE_STATE_STORES = [
  "ui-layout",
  "server-runtime",
  "durable-config",
  "evidence",
  "memory-vault",
  "local-knowledge",
  "workspace-references",
  "package-install",
] as const;

export type UpdateStateStore = (typeof UPDATE_STATE_STORES)[number];

export const UPDATE_RUNTIME_EVENT_TYPES = [
  "update-offered",
  "user-confirmed",
  "preflight-result",
  "snapshot-created",
  "package-update-result",
  "remediation-completed",
  "remediation-failed",
  "remediation-deferred",
] as const;

export type UpdateRuntimeEventType = (typeof UPDATE_RUNTIME_EVENT_TYPES)[number];

export const UPDATE_RUNTIME_WARNING_CODES = [
  "audit-persistence-failed",
  "state-snapshot-unavailable",
  "manual-review-required",
] as const;

export type UpdateRuntimeWarningCode = (typeof UPDATE_RUNTIME_WARNING_CODES)[number];

export const UPDATE_REMEDIATION_STATUSES = [
  "pending",
  "running",
  "completed",
  "failed",
  "deferred",
] as const;

export type UpdateRemediationStatus = (typeof UPDATE_REMEDIATION_STATUSES)[number];

export interface UpdateStoreHealth {
  readonly store: UpdateStateStore;
  readonly label: string;
  readonly health: UpdateHealthState;
  readonly healthLabel: (typeof UPDATE_HEALTH_LABELS)[UpdateHealthState];
  readonly affected: boolean;
  readonly remediation: ReleaseImpactRemediation;
  readonly userActionRequired: boolean;
  readonly snapshotEligible: boolean;
  readonly ownedArtifactCount: number;
  readonly retainedEntryCount: number;
  readonly message: string;
}

export interface UpdateCompatibilityScan {
  readonly schemaVersion: typeof UPDATE_LOCAL_STATE_SCHEMA_VERSION;
  readonly scannedAt: string;
  readonly stateDirStatus: "absent" | "directory" | "symlink" | "not-directory";
  readonly stores: readonly UpdateStoreHealth[];
  readonly overallHealth: UpdateHealthState;
  readonly warnings: readonly string[];
}

export interface UpdateRecoverySnapshotEntry {
  readonly store: UpdateStateStore;
  readonly health: UpdateHealthState;
  readonly affected: boolean;
  readonly remediation: ReleaseImpactRemediation;
  readonly userActionRequired: boolean;
  readonly snapshotEligible: boolean;
  readonly ownedArtifactCount: number;
  readonly retainedEntryCount: number;
}

export interface UpdateRecoverySnapshot {
  readonly schemaVersion: typeof UPDATE_LOCAL_STATE_SCHEMA_VERSION;
  readonly snapshotId: string;
  readonly createdAt: string;
  readonly fromVersion: string;
  readonly toVersion: string;
  readonly status: "created" | "failed";
  readonly stateDirStatus: UpdateCompatibilityScan["stateDirStatus"];
  readonly overallHealth: UpdateHealthState;
  readonly entries: readonly UpdateRecoverySnapshotEntry[];
  readonly warnings: readonly string[];
}

export interface UpdateRemediationActionState {
  readonly remediation: ReleaseImpactRemediation;
  readonly store: UpdateStateStore;
  readonly status: UpdateRemediationStatus;
  readonly updatedAt: string;
  readonly warningCode?: UpdateRuntimeWarningCode | undefined;
}

export interface UpdateRuntimeState {
  readonly schemaVersion: typeof UPDATE_LOCAL_STATE_SCHEMA_VERSION;
  readonly updatedAt: string;
  readonly targetVersion?: string | undefined;
  readonly snapshotId?: string | undefined;
  readonly remediations: readonly UpdateRemediationActionState[];
  readonly warnings: readonly UpdateRuntimeWarningCode[];
}

export interface UpdateRuntimeAuditEvent {
  readonly schemaVersion: typeof UPDATE_LOCAL_STATE_SCHEMA_VERSION;
  readonly eventId: string;
  readonly type: UpdateRuntimeEventType;
  readonly occurredAt: string;
  readonly targetVersion?: string | undefined;
  readonly snapshotId?: string | undefined;
  readonly store?: UpdateStateStore | undefined;
  readonly remediation?: ReleaseImpactRemediation | undefined;
  readonly status?: UpdateRemediationStatus | "succeeded" | "failed" | "blocked" | undefined;
  readonly warningCode?: UpdateRuntimeWarningCode | undefined;
}

export interface UpdateReleaseImpactInput {
  readonly affectedStateStores?: readonly string[] | undefined;
  readonly stateImpact?: readonly ReleaseImpactStateImpact[] | undefined;
  readonly remediation?: ReleaseImpactRemediation | undefined;
  readonly userActionRequired?: boolean | undefined;
}
