import type { ReleaseImpactRemediation, ReleaseImpactStateImpact } from "./release-impact.js";
import { RELEASE_IMPACT_REMEDIATIONS } from "./release-impact.js";
import type {
  UpdateReleaseImpactInput,
  UpdateRemediationStatus,
  UpdateStateStore,
} from "./update-local-state.js";
import { UPDATE_STATE_STORES } from "./update-local-state.js";

export const UPDATE_REMEDIATION_SCHEMA_VERSION = 1 as const;

export const UPDATE_REMEDIATION_ACTION_KINDS = [
  "restart",
  "local-state-repair",
  "local-knowledge-reindex",
  "manual-review",
] as const;

export type UpdateRemediationActionKind = (typeof UPDATE_REMEDIATION_ACTION_KINDS)[number];

export const UPDATE_REMEDIATION_ACTION_STATUSES = [
  "not-needed",
  "pending",
  "running",
  "completed",
  "failed",
  "deferred",
  "manual-review-required",
] as const;

export type UpdateRemediationActionStatus = (typeof UPDATE_REMEDIATION_ACTION_STATUSES)[number];

export const UPDATE_REMEDIATION_OVERALL_STATUSES = [
  "not-required",
  "pending",
  "running",
  "completed",
  "failed",
  "manual-review-required",
] as const;

export type UpdateRemediationOverallStatus = (typeof UPDATE_REMEDIATION_OVERALL_STATUSES)[number];

export const UPDATE_REMEDIATION_FEATURE_STATES = [
  "ready",
  "degraded",
  "unavailable",
  "manual-review-required",
] as const;

export type UpdateRemediationFeatureState = (typeof UPDATE_REMEDIATION_FEATURE_STATES)[number];

export const UPDATE_REMEDIATION_DECISIONS = ["run", "defer"] as const;

export type UpdateRemediationDecision = (typeof UPDATE_REMEDIATION_DECISIONS)[number];

export interface UpdateRemediationScopeCounts {
  readonly stores: number;
  readonly artifacts: number;
  readonly retainedEntries: number;
  readonly capsules?: number | undefined;
  readonly sources?: number | undefined;
  readonly documents?: number | undefined;
  readonly chunks?: number | undefined;
  readonly vectors?: number | undefined;
}

export interface UpdateRemediationAffectedFeature {
  readonly featureId: string;
  readonly label: string;
  readonly state: UpdateRemediationFeatureState;
  readonly reason: string;
  readonly actionIds: readonly string[];
}

export interface UpdateRemediationAction {
  readonly actionId: string;
  readonly kind: UpdateRemediationActionKind;
  readonly store: UpdateStateStore;
  readonly remediation: ReleaseImpactRemediation;
  readonly status: UpdateRemediationActionStatus;
  readonly required: boolean;
  readonly canRun: boolean;
  readonly canDefer: boolean;
  readonly userApprovalRequired: boolean;
  readonly featureIds: readonly string[];
  readonly scopeCounts: UpdateRemediationScopeCounts;
  readonly message: string;
  readonly instructions?: string | undefined;
  readonly cliFallback?: string | undefined;
  readonly updatedAt?: string | undefined;
  readonly failure?: string | undefined;
}

export interface UpdateRemediationStatusReport {
  readonly schemaVersion: typeof UPDATE_REMEDIATION_SCHEMA_VERSION;
  readonly checkedAt: string;
  readonly targetVersion?: string | undefined;
  readonly overallStatus: UpdateRemediationOverallStatus;
  readonly updateCanComplete: boolean;
  readonly actions: readonly UpdateRemediationAction[];
  readonly affectedFeatures: readonly UpdateRemediationAffectedFeature[];
  readonly warnings: readonly string[];
}

export interface UpdateRemediationStatusRequest {
  readonly targetVersion?: string | undefined;
  readonly impact?: UpdateReleaseImpactInput | undefined;
  readonly persist?: boolean | undefined;
}

export interface UpdateRemediationActionRequest {
  readonly actionId: string;
  readonly targetVersion?: string | undefined;
  readonly impact?: UpdateReleaseImpactInput | undefined;
  readonly decision?: UpdateRemediationDecision | undefined;
}

export interface UpdateRemediationStatusRequestParseOk {
  readonly ok: true;
  readonly value: UpdateRemediationStatusRequest;
}

export interface UpdateRemediationStatusRequestParseFail {
  readonly ok: false;
  readonly errors: readonly string[];
}

export type UpdateRemediationStatusRequestParse =
  UpdateRemediationStatusRequestParseOk | UpdateRemediationStatusRequestParseFail;

export interface UpdateRemediationActionRequestParseOk {
  readonly ok: true;
  readonly value: UpdateRemediationActionRequest;
}

export interface UpdateRemediationActionRequestParseFail {
  readonly ok: false;
  readonly errors: readonly string[];
}

export type UpdateRemediationActionRequestParse =
  UpdateRemediationActionRequestParseOk | UpdateRemediationActionRequestParseFail;

const TARGET_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const MAX_TARGET_VERSION_LENGTH = 64;
const MAX_ACTION_ID_LENGTH = 160;
const ACTION_ID_PATTERN = /^[A-Za-z0-9._:-]+$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isReleaseImpactRemediation(value: unknown): value is ReleaseImpactRemediation {
  return (
    typeof value === "string" && (RELEASE_IMPACT_REMEDIATIONS as readonly string[]).includes(value)
  );
}

function isStateImpact(value: unknown): value is ReleaseImpactStateImpact {
  return (
    isRecord(value) &&
    typeof value.store === "string" &&
    typeof value.description === "string" &&
    isReleaseImpactRemediation(value.remediation) &&
    typeof value.userActionRequired === "boolean"
  );
}

function parseAffectedStateStores(value: unknown, errors: string[]): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (isStringArray(value)) return value;
  errors.push("impact.affectedStateStores must be a string array");
  return undefined;
}

function parseStateImpact(
  value: unknown,
  errors: string[],
): readonly ReleaseImpactStateImpact[] | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value) && value.every(isStateImpact)) return value;
  errors.push("impact.stateImpact must contain release-impact state entries");
  return undefined;
}

function parseRemediation(value: unknown, errors: string[]): ReleaseImpactRemediation | undefined {
  if (value === undefined) return undefined;
  if (isReleaseImpactRemediation(value)) return value;
  errors.push("impact.remediation must be a known remediation");
  return undefined;
}

function parseUserActionRequired(value: unknown, errors: string[]): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "boolean") return value;
  errors.push("impact.userActionRequired must be a boolean");
  return undefined;
}

function parseImpact(input: unknown, errors: string[]): UpdateReleaseImpactInput | undefined {
  if (input === undefined) return undefined;
  if (!isRecord(input)) {
    errors.push("impact must be an object");
    return undefined;
  }
  const affectedStateStores = parseAffectedStateStores(input.affectedStateStores, errors);
  const stateImpact = parseStateImpact(input.stateImpact, errors);
  const remediation = parseRemediation(input.remediation, errors);
  const userActionRequired = parseUserActionRequired(input.userActionRequired, errors);
  return {
    ...(affectedStateStores === undefined ? {} : { affectedStateStores }),
    ...(stateImpact === undefined ? {} : { stateImpact }),
    ...(remediation === undefined ? {} : { remediation }),
    ...(userActionRequired === undefined ? {} : { userActionRequired }),
  };
}

function parseTargetVersion(input: unknown, errors: string[]): string | undefined {
  if (input === undefined) return undefined;
  if (
    typeof input === "string" &&
    input.length > 0 &&
    input.length <= MAX_TARGET_VERSION_LENGTH &&
    TARGET_VERSION_PATTERN.test(input)
  ) {
    return input;
  }
  errors.push("targetVersion must be a stable semver version");
  return undefined;
}

function parseActionId(input: unknown, errors: string[]): string | undefined {
  if (
    typeof input === "string" &&
    input.length > 0 &&
    input.length <= MAX_ACTION_ID_LENGTH &&
    ACTION_ID_PATTERN.test(input)
  ) {
    return input;
  }
  errors.push(`actionId must be a token of 1-${String(MAX_ACTION_ID_LENGTH)} characters`);
  return undefined;
}

function parseDecision(input: unknown, errors: string[]): UpdateRemediationDecision | undefined {
  if (input === undefined) return undefined;
  if (UPDATE_REMEDIATION_DECISIONS.includes(input as never)) {
    return input as UpdateRemediationDecision;
  }
  errors.push("decision must be run or defer");
  return undefined;
}

export function isUpdateStateStore(value: unknown): value is UpdateStateStore {
  return typeof value === "string" && (UPDATE_STATE_STORES as readonly string[]).includes(value);
}

export function isUpdateRemediationStatus(value: unknown): value is UpdateRemediationStatus {
  return (
    typeof value === "string" &&
    ["pending", "running", "completed", "failed", "deferred"].includes(value)
  );
}

export function parseUpdateRemediationStatusRequest(
  input: unknown,
): UpdateRemediationStatusRequestParse {
  if (!isRecord(input)) return { ok: false, errors: ["request must be an object"] };
  const errors: string[] = [];
  const targetVersion = parseTargetVersion(input.targetVersion, errors);
  const impact = parseImpact(input.impact, errors);
  if (input.persist !== undefined && typeof input.persist !== "boolean") {
    errors.push("persist must be a boolean");
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      ...(targetVersion === undefined ? {} : { targetVersion }),
      ...(impact === undefined ? {} : { impact }),
      ...(typeof input.persist === "boolean" ? { persist: input.persist } : {}),
    },
  };
}

export function parseUpdateRemediationActionRequest(
  input: unknown,
): UpdateRemediationActionRequestParse {
  if (!isRecord(input)) return { ok: false, errors: ["request must be an object"] };
  const errors: string[] = [];
  const actionId = parseActionId(input.actionId, errors);
  const targetVersion = parseTargetVersion(input.targetVersion, errors);
  const impact = parseImpact(input.impact, errors);
  const decision = parseDecision(input.decision, errors);
  if (errors.length > 0 || actionId === undefined) return { ok: false, errors };
  return {
    ok: true,
    value: {
      actionId,
      ...(targetVersion === undefined ? {} : { targetVersion }),
      ...(impact === undefined ? {} : { impact }),
      ...(decision === undefined ? {} : { decision }),
    },
  };
}
