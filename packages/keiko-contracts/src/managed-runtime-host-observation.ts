import {
  MANAGED_RUNTIME_CAPABILITY_STATES,
  MANAGED_RUNTIME_CONTROLLER_KINDS,
  MANAGED_RUNTIME_EMPTY_INVENTORY_DIGEST,
  MANAGED_RUNTIME_HOST_DEADLINE_MS,
  MANAGED_RUNTIME_HOST_SCHEMA_VERSION,
  MANAGED_RUNTIME_ISOLATION_PROFILE_DIGEST,
  MANAGED_RUNTIME_LIFECYCLE_KINDS,
  MANAGED_RUNTIME_LIFECYCLE_REASONS,
  MANAGED_RUNTIME_PLATFORM_TARGETS,
  MANAGED_RUNTIME_RECOVERY_STATES,
  MANAGED_RUNTIME_RECOVERY_TRIGGERS,
  MANAGED_RUNTIME_REMEDIATIONS,
  MANAGED_RUNTIME_UNAVAILABLE_REASONS,
  asManagedRuntimeRecord,
  hasOnlyManagedRuntimeKeys,
  isManagedRuntimeMember,
  isManagedRuntimeSafeInteger,
  managedRuntimeFailure,
  type ManagedRuntimeParse,
  type ManagedRuntimeControllerKind,
  type ManagedRuntimeLifecycleKind,
  type ManagedRuntimeLifecycleReason,
  type ManagedRuntimePlatformTarget,
  type ManagedRuntimeRemediation,
  type ManagedRuntimeRecoveryState,
  type ManagedRuntimeRecoveryTrigger,
  type ManagedRuntimeUnavailableReason,
  type ManagedRuntimeUnknownRecord,
} from "./managed-runtime-host-profile.js";

interface ManagedRuntimeCapabilityBase {
  readonly schemaVersion: typeof MANAGED_RUNTIME_HOST_SCHEMA_VERSION;
  readonly platformTarget: ManagedRuntimePlatformTarget;
  readonly observedAtUnixMs: number;
}

export interface ManagedRuntimeAvailableObservation extends ManagedRuntimeCapabilityBase {
  readonly state: "available";
  readonly reason: "ready";
  readonly remediation: "none";
  readonly controllerBundleDigest: string;
  readonly guestBundleDigest: string;
  readonly profileDigest: typeof MANAGED_RUNTIME_ISOLATION_PROFILE_DIGEST;
  readonly policyVersionDigest: string;
  readonly revocationEpoch: number;
}

export interface ManagedRuntimeUnavailableObservation extends ManagedRuntimeCapabilityBase {
  readonly state: "unavailable";
  readonly reason: ManagedRuntimeUnavailableReason;
  readonly remediation: Exclude<ManagedRuntimeRemediation, "none">;
}

export type ManagedRuntimeCapabilityObservation =
  ManagedRuntimeAvailableObservation | ManagedRuntimeUnavailableObservation;

export interface ManagedRuntimeLifecycleObservation {
  readonly schemaVersion: typeof MANAGED_RUNTIME_HOST_SCHEMA_VERSION;
  readonly runIdDigest: string;
  readonly taskIdDigest: string;
  readonly workspaceIdDigest: string;
  readonly sourceSha: string;
  readonly treeSha: string;
  readonly platformTarget: ManagedRuntimePlatformTarget;
  readonly controllerKind: ManagedRuntimeControllerKind;
  readonly controllerBundleDigest: string;
  readonly controllerInstanceDigest: string;
  readonly guestBundleDigest: string;
  readonly profileDigest: typeof MANAGED_RUNTIME_ISOLATION_PROFILE_DIGEST;
  readonly sequence: number;
  readonly issuedAtUnixMs: number;
  readonly expiresAtUnixMs: number;
  readonly revocationEpoch: number;
  readonly policyVersionDigest: string;
  readonly kind: ManagedRuntimeLifecycleKind;
  readonly reason: ManagedRuntimeLifecycleReason;
  readonly vmIdentityDigest: string;
  readonly bootIdentityDigest: string;
  readonly nonceDigest: string;
  readonly observedAtUnixMs: number;
}

export interface ManagedRuntimeRecoveryObservation {
  readonly schemaVersion: typeof MANAGED_RUNTIME_HOST_SCHEMA_VERSION;
  readonly state: ManagedRuntimeRecoveryState;
  readonly trigger: ManagedRuntimeRecoveryTrigger;
  readonly platformTarget: ManagedRuntimePlatformTarget;
  readonly controllerKind: ManagedRuntimeControllerKind;
  readonly controllerBundleDigest: string;
  readonly profileDigest: typeof MANAGED_RUNTIME_ISOLATION_PROFILE_DIGEST;
  readonly policyVersionDigest: string;
  readonly observedAtUnixMs: number;
  readonly enumeratedVmCount: number;
  readonly staleVmCount: number;
  readonly unrecognizedVmCount: number;
  readonly terminatedVmCount: number;
  readonly failureCount: number;
  readonly inventoryDigest: string;
}

const AVAILABLE_KEYS = Object.freeze(
  "schemaVersion platformTarget state reason remediation observedAtUnixMs controllerBundleDigest guestBundleDigest profileDigest policyVersionDigest revocationEpoch".split(
    " ",
  ),
);
const UNAVAILABLE_KEYS = Object.freeze(
  "schemaVersion platformTarget state reason remediation observedAtUnixMs".split(" "),
);
const LIFECYCLE_KEYS = Object.freeze(
  "schemaVersion runIdDigest taskIdDigest workspaceIdDigest sourceSha treeSha platformTarget controllerKind controllerBundleDigest controllerInstanceDigest guestBundleDigest profileDigest sequence issuedAtUnixMs expiresAtUnixMs revocationEpoch policyVersionDigest kind reason vmIdentityDigest bootIdentityDigest nonceDigest observedAtUnixMs".split(
    " ",
  ),
);
const RECOVERY_KEYS = Object.freeze(
  "schemaVersion state trigger platformTarget controllerKind controllerBundleDigest profileDigest policyVersionDigest observedAtUnixMs enumeratedVmCount staleVmCount unrecognizedVmCount terminatedVmCount failureCount inventoryDigest".split(
    " ",
  ),
);
const GIT_SHA = /^[a-f0-9]{40}$/;
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
    "guest-failed",
    "policy-revoked",
  ] as const),
  "revocation-observed": Object.freeze(["lease-revoked", "policy-revoked"] as const),
  "failure-observed": Object.freeze(["controller-crashed", "guest-failed"] as const),
});

function hasCapabilityBase(value: ManagedRuntimeUnknownRecord): boolean {
  return (
    value.schemaVersion === MANAGED_RUNTIME_HOST_SCHEMA_VERSION &&
    isManagedRuntimeMember(value.platformTarget, MANAGED_RUNTIME_PLATFORM_TARGETS) &&
    isManagedRuntimeMember(value.state, MANAGED_RUNTIME_CAPABILITY_STATES) &&
    isManagedRuntimeSafeInteger(value.observedAtUnixMs)
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
    typeof value.policyVersionDigest === "string" &&
    SHA256.test(value.policyVersionDigest) &&
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

export function parseManagedRuntimeLifecycleObservation(
  value: unknown,
): ManagedRuntimeParse<ManagedRuntimeLifecycleObservation> {
  const record = asManagedRuntimeRecord(value);
  if (record === undefined || !hasOnlyManagedRuntimeKeys(record, LIFECYCLE_KEYS)) {
    return managedRuntimeFailure("invalid runtime lifecycle observation");
  }
  const valid =
    hasLifecycleBinding(record) && hasLifecyclePair(record) && hasLifecycleFields(record);
  return valid
    ? Object.freeze({
        ok: true,
        value: record as unknown as ManagedRuntimeLifecycleObservation,
      })
    : managedRuntimeFailure("invalid runtime lifecycle observation");
}

export function parseManagedRuntimeRecoveryObservation(
  value: unknown,
): ManagedRuntimeParse<ManagedRuntimeRecoveryObservation> {
  const record = asManagedRuntimeRecord(value);
  if (
    record === undefined ||
    !hasOnlyManagedRuntimeKeys(record, RECOVERY_KEYS) ||
    !hasRecoveryBinding(record) ||
    !hasRecoveryCounts(record)
  ) {
    return managedRuntimeFailure("invalid runtime recovery observation");
  }
  return Object.freeze({
    ok: true,
    value: record as unknown as ManagedRuntimeRecoveryObservation,
  });
}

function hasRecoveryBinding(value: ManagedRuntimeUnknownRecord): boolean {
  return (
    value.schemaVersion === MANAGED_RUNTIME_HOST_SCHEMA_VERSION &&
    isManagedRuntimeMember(value.state, MANAGED_RUNTIME_RECOVERY_STATES) &&
    isManagedRuntimeMember(value.trigger, MANAGED_RUNTIME_RECOVERY_TRIGGERS) &&
    controllerMatchesPlatform(value) &&
    [value.controllerBundleDigest, value.policyVersionDigest, value.inventoryDigest].every(
      (digest) => typeof digest === "string" && SHA256.test(digest),
    ) &&
    value.profileDigest === MANAGED_RUNTIME_ISOLATION_PROFILE_DIGEST &&
    isManagedRuntimeSafeInteger(value.observedAtUnixMs)
  );
}

function hasRecoveryCounts(value: ManagedRuntimeUnknownRecord): boolean {
  const counts = readRecoveryCounts(value);
  if (counts === undefined) return false;
  const [enumerated, stale, unrecognized, terminated, failures] = counts;
  const classified = stale + unrecognized;
  const settled = terminated + failures;
  if (enumerated !== classified || settled > enumerated) return false;
  if (enumerated === 0 && value.inventoryDigest !== MANAGED_RUNTIME_EMPTY_INVENTORY_DIGEST)
    return false;
  return recoveryStateMatches(value.state, enumerated, settled, failures);
}

function readRecoveryCounts(
  value: ManagedRuntimeUnknownRecord,
): readonly [number, number, number, number, number] | undefined {
  const counts = [
    value.enumeratedVmCount,
    value.staleVmCount,
    value.unrecognizedVmCount,
    value.terminatedVmCount,
    value.failureCount,
  ];
  if (!counts.every((count) => isManagedRuntimeSafeInteger(count))) return undefined;
  return counts as [number, number, number, number, number];
}

function recoveryStateMatches(
  state: unknown,
  enumerated: number,
  settled: number,
  failures: number,
): boolean {
  if (state === "pending") return settled < enumerated || enumerated === 0;
  if (state === "completed") return failures === 0 && settled === enumerated;
  return state === "failed" && failures !== 0 && settled === enumerated;
}

function hasLifecycleBinding(value: ManagedRuntimeUnknownRecord): boolean {
  const digests = [
    value.runIdDigest,
    value.taskIdDigest,
    value.workspaceIdDigest,
    value.controllerBundleDigest,
    value.controllerInstanceDigest,
    value.guestBundleDigest,
    value.policyVersionDigest,
  ];
  return (
    value.schemaVersion === MANAGED_RUNTIME_HOST_SCHEMA_VERSION &&
    digests.every((digest) => typeof digest === "string" && SHA256.test(digest)) &&
    value.profileDigest === MANAGED_RUNTIME_ISOLATION_PROFILE_DIGEST &&
    [value.sourceSha, value.treeSha].every(
      (digest) => typeof digest === "string" && GIT_SHA.test(digest),
    ) &&
    controllerMatchesPlatform(value) &&
    hasLifecycleTiming(value)
  );
}

function controllerMatchesPlatform(value: ManagedRuntimeUnknownRecord): boolean {
  if (!isManagedRuntimeMember(value.controllerKind, MANAGED_RUNTIME_CONTROLLER_KINDS)) return false;
  return value.platformTarget === "windows-x64"
    ? value.controllerKind === "windows-hcs-hyper-v-service"
    : (value.platformTarget === "macos-arm64" || value.platformTarget === "macos-x64") &&
        value.controllerKind === "apple-virtualization";
}

function hasLifecycleTiming(value: ManagedRuntimeUnknownRecord): boolean {
  return (
    isManagedRuntimeSafeInteger(value.sequence, 1) &&
    isManagedRuntimeSafeInteger(value.issuedAtUnixMs) &&
    isManagedRuntimeSafeInteger(value.expiresAtUnixMs) &&
    isManagedRuntimeSafeInteger(value.revocationEpoch) &&
    value.expiresAtUnixMs > value.issuedAtUnixMs &&
    value.expiresAtUnixMs - value.issuedAtUnixMs <= MANAGED_RUNTIME_HOST_DEADLINE_MS
  );
}

function hasLifecyclePair(value: ManagedRuntimeUnknownRecord): boolean {
  return (
    isManagedRuntimeMember(value.kind, MANAGED_RUNTIME_LIFECYCLE_KINDS) &&
    isManagedRuntimeMember(value.reason, MANAGED_RUNTIME_LIFECYCLE_REASONS) &&
    LIFECYCLE_REASON_BY_KIND[value.kind].includes(value.reason)
  );
}

function hasLifecycleFields(value: ManagedRuntimeUnknownRecord): boolean {
  return (
    [value.vmIdentityDigest, value.bootIdentityDigest, value.nonceDigest].every(
      (digest) => typeof digest === "string" && SHA256.test(digest),
    ) && isManagedRuntimeSafeInteger(value.observedAtUnixMs, value.issuedAtUnixMs as number)
  );
}
