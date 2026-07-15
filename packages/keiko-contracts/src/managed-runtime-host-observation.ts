import {
  MANAGED_RUNTIME_CAPABILITY_STATES,
  MANAGED_RUNTIME_HOST_SCHEMA_VERSION,
  MANAGED_RUNTIME_ISOLATION_PROFILE_DIGEST,
  MANAGED_RUNTIME_LIFECYCLE_KINDS,
  MANAGED_RUNTIME_LIFECYCLE_REASONS,
  MANAGED_RUNTIME_PLATFORM_TARGETS,
  MANAGED_RUNTIME_REMEDIATIONS,
  MANAGED_RUNTIME_UNAVAILABLE_REASONS,
  asManagedRuntimeRecord,
  hasOnlyManagedRuntimeKeys,
  isManagedRuntimeMember,
  isManagedRuntimeSafeInteger,
  managedRuntimeFailure,
  type ManagedRuntimeParse,
  type ManagedRuntimeLifecycleKind,
  type ManagedRuntimeLifecycleReason,
  type ManagedRuntimePlatformTarget,
  type ManagedRuntimeRemediation,
  type ManagedRuntimeUnavailableReason,
  type ManagedRuntimeUnknownRecord,
} from "./managed-runtime-host-profile.js";
import {
  parseManagedRuntimeLaunchRequest,
  type ManagedRuntimeLaunchRequest,
} from "./managed-runtime-host-launch.js";

interface ManagedRuntimeCapabilityBase {
  readonly schemaVersion: typeof MANAGED_RUNTIME_HOST_SCHEMA_VERSION;
  readonly platformTarget: ManagedRuntimePlatformTarget;
  readonly observedAtMs: number;
}

export interface ManagedRuntimeAvailableObservation extends ManagedRuntimeCapabilityBase {
  readonly state: "available";
  readonly reason: "ready";
  readonly remediation: "none";
  readonly controllerBundleDigest: string;
  readonly guestBundleDigest: string;
  readonly profileDigest: typeof MANAGED_RUNTIME_ISOLATION_PROFILE_DIGEST;
  readonly policyVersion: string;
  readonly revocationEpoch: number;
}

export interface ManagedRuntimeUnavailableObservation extends ManagedRuntimeCapabilityBase {
  readonly state: "unavailable";
  readonly reason: ManagedRuntimeUnavailableReason;
  readonly remediation: Exclude<ManagedRuntimeRemediation, "none">;
}

export type ManagedRuntimeCapabilityObservation =
  ManagedRuntimeAvailableObservation | ManagedRuntimeUnavailableObservation;

export interface ManagedRuntimeLifecycleObservation extends Omit<
  ManagedRuntimeLaunchRequest,
  "nonce"
> {
  readonly kind: ManagedRuntimeLifecycleKind;
  readonly reason: ManagedRuntimeLifecycleReason;
  readonly vmIdentityDigest: string;
  readonly bootIdentityDigest: string;
  readonly nonceDigest: string;
  readonly observedAtMs: number;
  readonly recoveredVmCount: number;
}

const AVAILABLE_KEYS = Object.freeze(
  "schemaVersion platformTarget state reason remediation observedAtMs controllerBundleDigest guestBundleDigest profileDigest policyVersion revocationEpoch".split(
    " ",
  ),
);
const UNAVAILABLE_KEYS = Object.freeze(
  "schemaVersion platformTarget state reason remediation observedAtMs".split(" "),
);
const LIFECYCLE_KEYS = Object.freeze(
  "schemaVersion runId taskId workspaceId sourceSha treeSha platformTarget controllerKind controllerBundleDigest guestBundleDigest profileDigest ipcAudience sequence issuedAtMs expiresAtMs revocationEpoch policyVersion kind reason vmIdentityDigest bootIdentityDigest nonceDigest observedAtMs recoveredVmCount".split(
    " ",
  ),
);
const CONTENT_FREE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const LIFECYCLE_REASON_BY_KIND: Readonly<
  Record<ManagedRuntimeLifecycleKind, readonly ManagedRuntimeLifecycleReason[]>
> = Object.freeze({
  "launch-observed": Object.freeze(["launch-accepted"] as const),
  "running-observed": Object.freeze(["broker-authenticated"] as const),
  "stop-observed": Object.freeze([
    "requested",
    "deadline-expired",
    "lease-expired",
    "lease-revoked",
    "bff-disconnected",
    "policy-revoked",
  ] as const),
  "termination-observed": Object.freeze([
    "requested",
    "deadline-expired",
    "lease-expired",
    "lease-revoked",
    "bff-disconnected",
    "controller-crashed",
    "machine-restarted",
    "stale-vm-terminated",
    "guest-failed",
    "policy-revoked",
  ] as const),
  "revocation-observed": Object.freeze(["lease-revoked", "policy-revoked"] as const),
  "recovery-observed": Object.freeze([
    "controller-crashed",
    "machine-restarted",
    "stale-vm-terminated",
    "bff-disconnected",
  ] as const),
  "failure-observed": Object.freeze(["controller-crashed", "guest-failed"] as const),
});

function hasCapabilityBase(value: ManagedRuntimeUnknownRecord): boolean {
  return (
    value.schemaVersion === MANAGED_RUNTIME_HOST_SCHEMA_VERSION &&
    isManagedRuntimeMember(value.platformTarget, MANAGED_RUNTIME_PLATFORM_TARGETS) &&
    isManagedRuntimeMember(value.state, MANAGED_RUNTIME_CAPABILITY_STATES) &&
    isManagedRuntimeSafeInteger(value.observedAtMs)
  );
}

function parseAvailable(
  value: ManagedRuntimeUnknownRecord,
): ManagedRuntimeAvailableObservation | undefined {
  const valid =
    hasOnlyManagedRuntimeKeys(value, AVAILABLE_KEYS) &&
    value.reason === "ready" &&
    value.remediation === "none" &&
    [value.controllerBundleDigest, value.guestBundleDigest].every(
      (digest) => typeof digest === "string" && SHA256.test(digest),
    ) &&
    value.profileDigest === MANAGED_RUNTIME_ISOLATION_PROFILE_DIGEST &&
    typeof value.policyVersion === "string" &&
    CONTENT_FREE_ID.test(value.policyVersion) &&
    isManagedRuntimeSafeInteger(value.revocationEpoch);
  return valid
    ? (Object.freeze({ ...value }) as unknown as ManagedRuntimeAvailableObservation)
    : undefined;
}

function parseUnavailable(
  value: ManagedRuntimeUnknownRecord,
): ManagedRuntimeUnavailableObservation | undefined {
  const valid =
    hasOnlyManagedRuntimeKeys(value, UNAVAILABLE_KEYS) &&
    isManagedRuntimeMember(value.reason, MANAGED_RUNTIME_UNAVAILABLE_REASONS) &&
    isManagedRuntimeMember(value.remediation, MANAGED_RUNTIME_REMEDIATIONS) &&
    value.remediation !== "none";
  return valid
    ? (Object.freeze({ ...value }) as unknown as ManagedRuntimeUnavailableObservation)
    : undefined;
}

export function parseManagedRuntimeCapabilityObservation(
  value: unknown,
): ManagedRuntimeParse<ManagedRuntimeCapabilityObservation> {
  const record = asManagedRuntimeRecord(value);
  if (record === undefined || !hasCapabilityBase(record)) {
    return managedRuntimeFailure("invalid runtime capability");
  }
  const parsed = record.state === "available" ? parseAvailable(record) : parseUnavailable(record);
  return parsed === undefined
    ? managedRuntimeFailure("invalid runtime capability")
    : Object.freeze({ ok: true, value: parsed });
}

function lifecycleLaunchCandidate(value: ManagedRuntimeUnknownRecord): unknown {
  return {
    schemaVersion: value.schemaVersion,
    runId: value.runId,
    taskId: value.taskId,
    workspaceId: value.workspaceId,
    sourceSha: value.sourceSha,
    treeSha: value.treeSha,
    platformTarget: value.platformTarget,
    controllerKind: value.controllerKind,
    controllerBundleDigest: value.controllerBundleDigest,
    guestBundleDigest: value.guestBundleDigest,
    profileDigest: value.profileDigest,
    ipcAudience: value.ipcAudience,
    nonce: value.nonceDigest,
    sequence: value.sequence,
    issuedAtMs: value.issuedAtMs,
    expiresAtMs: value.expiresAtMs,
    revocationEpoch: value.revocationEpoch,
    policyVersion: value.policyVersion,
  };
}

export function parseManagedRuntimeLifecycleObservation(
  value: unknown,
): ManagedRuntimeParse<ManagedRuntimeLifecycleObservation> {
  const record = asManagedRuntimeRecord(value);
  if (record === undefined || !hasOnlyManagedRuntimeKeys(record, LIFECYCLE_KEYS)) {
    return managedRuntimeFailure("invalid runtime lifecycle observation");
  }
  const launch = parseManagedRuntimeLaunchRequest(lifecycleLaunchCandidate(record));
  const valid =
    launch.ok &&
    hasLifecyclePair(record) &&
    hasLifecycleFields(record, launch.value.issuedAtMs) &&
    hasRecoveryCount(record);
  return valid
    ? Object.freeze({
        ok: true,
        value: record as unknown as ManagedRuntimeLifecycleObservation,
      })
    : managedRuntimeFailure("invalid runtime lifecycle observation");
}

function hasLifecyclePair(value: ManagedRuntimeUnknownRecord): boolean {
  return (
    isManagedRuntimeMember(value.kind, MANAGED_RUNTIME_LIFECYCLE_KINDS) &&
    isManagedRuntimeMember(value.reason, MANAGED_RUNTIME_LIFECYCLE_REASONS) &&
    LIFECYCLE_REASON_BY_KIND[value.kind].includes(value.reason)
  );
}

function hasLifecycleFields(value: ManagedRuntimeUnknownRecord, issuedAtMs: number): boolean {
  return (
    [value.vmIdentityDigest, value.bootIdentityDigest, value.nonceDigest].every(
      (digest) => typeof digest === "string" && SHA256.test(digest),
    ) && isManagedRuntimeSafeInteger(value.observedAtMs, issuedAtMs)
  );
}

function hasRecoveryCount(value: ManagedRuntimeUnknownRecord): boolean {
  if (!isManagedRuntimeSafeInteger(value.recoveredVmCount)) return false;
  return value.kind === "recovery-observed"
    ? value.recoveredVmCount > 0
    : value.recoveredVmCount === 0;
}
