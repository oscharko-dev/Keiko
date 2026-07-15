import {
  MANAGED_RUNTIME_CONTROLLER_KINDS,
  MANAGED_RUNTIME_HOST_DEADLINE_MS,
  MANAGED_RUNTIME_HOST_SCHEMA_VERSION,
  MANAGED_RUNTIME_ISOLATION_PROFILE_DIGEST,
  MANAGED_RUNTIME_PLATFORM_TARGETS,
  MANAGED_RUNTIME_RUNTIME_ENV_NAMES,
  asManagedRuntimeRecord,
  hasOnlyManagedRuntimeKeys,
  isManagedRuntimeMember,
  isManagedRuntimeSafeInteger,
  managedRuntimeFailure,
  type ManagedRuntimeControllerKind,
  type ManagedRuntimeParse,
  type ManagedRuntimePlatformTarget,
  type ManagedRuntimeUnknownRecord,
} from "./managed-runtime-host-profile.js";

export interface ManagedRuntimeBundleDescriptor {
  readonly schemaVersion: typeof MANAGED_RUNTIME_HOST_SCHEMA_VERSION;
  readonly platformTarget: ManagedRuntimePlatformTarget;
  readonly controllerKind: ManagedRuntimeControllerKind;
  readonly controllerBundleDigest: string;
  readonly guestBundleDigest: string;
  readonly profileDigest: typeof MANAGED_RUNTIME_ISOLATION_PROFILE_DIGEST;
  readonly environmentNames: typeof MANAGED_RUNTIME_RUNTIME_ENV_NAMES;
}

export interface ManagedRuntimeLaunchRequest {
  readonly schemaVersion: typeof MANAGED_RUNTIME_HOST_SCHEMA_VERSION;
  readonly runId: string;
  readonly taskId: string;
  readonly workspaceId: string;
  readonly sourceSha: string;
  readonly treeSha: string;
  readonly platformTarget: ManagedRuntimePlatformTarget;
  readonly controllerKind: ManagedRuntimeControllerKind;
  readonly controllerBundleDigest: string;
  readonly controllerInstanceDigest: string;
  readonly guestBundleDigest: string;
  readonly profileDigest: typeof MANAGED_RUNTIME_ISOLATION_PROFILE_DIGEST;
  readonly ipcAudience: "keiko-managed-runtime-broker-v1";
  readonly nonce: string;
  readonly sequence: number;
  readonly issuedAtUnixMs: number;
  readonly expiresAtUnixMs: number;
  readonly revocationEpoch: number;
  readonly policyVersion: string;
}

const LAUNCH_KEYS = Object.freeze(
  "schemaVersion runId taskId workspaceId sourceSha treeSha platformTarget controllerKind controllerBundleDigest controllerInstanceDigest guestBundleDigest profileDigest ipcAudience nonce sequence issuedAtUnixMs expiresAtUnixMs revocationEpoch policyVersion".split(
    " ",
  ),
);
const BUNDLE_KEYS = Object.freeze(
  "schemaVersion platformTarget controllerKind controllerBundleDigest guestBundleDigest profileDigest environmentNames".split(
    " ",
  ),
);
const CONTENT_FREE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const GIT_SHA = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;

function hasLaunchIdentity(value: ManagedRuntimeUnknownRecord): boolean {
  return (
    value.schemaVersion === MANAGED_RUNTIME_HOST_SCHEMA_VERSION &&
    [value.runId, value.taskId, value.workspaceId, value.policyVersion].every(
      (item) => typeof item === "string" && CONTENT_FREE_ID.test(item),
    )
  );
}

function hasBundleDigests(value: ManagedRuntimeUnknownRecord): boolean {
  return (
    [value.controllerBundleDigest, value.guestBundleDigest].every(
      (digest) => typeof digest === "string" && SHA256.test(digest),
    ) && value.profileDigest === MANAGED_RUNTIME_ISOLATION_PROFILE_DIGEST
  );
}

function hasLaunchDigests(value: ManagedRuntimeUnknownRecord): boolean {
  return (
    [value.sourceSha, value.treeSha].every(
      (digest) => typeof digest === "string" && GIT_SHA.test(digest),
    ) && hasBundleDigests(value)
  );
}

function hasLaunchBinding(value: ManagedRuntimeUnknownRecord): boolean {
  return (
    isManagedRuntimeMember(value.platformTarget, MANAGED_RUNTIME_PLATFORM_TARGETS) &&
    controllerMatchesPlatform(value) &&
    typeof value.controllerInstanceDigest === "string" &&
    SHA256.test(value.controllerInstanceDigest) &&
    value.ipcAudience === "keiko-managed-runtime-broker-v1" &&
    typeof value.nonce === "string" &&
    SHA256.test(value.nonce) &&
    isManagedRuntimeSafeInteger(value.sequence, 1) &&
    hasLaunchTiming(value)
  );
}

function hasLaunchTiming(value: ManagedRuntimeUnknownRecord): boolean {
  return (
    isManagedRuntimeSafeInteger(value.issuedAtUnixMs) &&
    isManagedRuntimeSafeInteger(value.expiresAtUnixMs) &&
    isManagedRuntimeSafeInteger(value.revocationEpoch) &&
    value.expiresAtUnixMs > value.issuedAtUnixMs &&
    value.expiresAtUnixMs - value.issuedAtUnixMs <= MANAGED_RUNTIME_HOST_DEADLINE_MS
  );
}

function controllerMatchesPlatform(value: ManagedRuntimeUnknownRecord): boolean {
  if (!isManagedRuntimeMember(value.controllerKind, MANAGED_RUNTIME_CONTROLLER_KINDS)) return false;
  return value.platformTarget === "windows-x64"
    ? value.controllerKind === "windows-hcs-hyper-v-service"
    : (value.platformTarget === "macos-arm64" || value.platformTarget === "macos-x64") &&
        value.controllerKind === "apple-virtualization";
}

function readOwnArrayData(value: readonly unknown[], key: string): unknown {
  const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !("value" in descriptor)) return undefined;
  return Reflect.get(value, key, value) === descriptor.value ? descriptor.value : undefined;
}

function hasExactEnvironment(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  try {
    if (Object.getPrototypeOf(value) !== Array.prototype) return false;
    if (Reflect.ownKeys(value).length !== MANAGED_RUNTIME_RUNTIME_ENV_NAMES.length + 1)
      return false;
    if (readOwnArrayData(value, "length") !== MANAGED_RUNTIME_RUNTIME_ENV_NAMES.length)
      return false;
    return MANAGED_RUNTIME_RUNTIME_ENV_NAMES.every(
      (expected, index) => readOwnArrayData(value, String(index)) === expected,
    );
  } catch {
    return false;
  }
}

export function parseManagedRuntimeLaunchRequest(
  value: unknown,
): ManagedRuntimeParse<ManagedRuntimeLaunchRequest> {
  const record = asManagedRuntimeRecord(value);
  if (
    record === undefined ||
    !hasOnlyManagedRuntimeKeys(record, LAUNCH_KEYS) ||
    !hasLaunchIdentity(record) ||
    !hasLaunchDigests(record) ||
    !hasLaunchBinding(record)
  ) {
    return managedRuntimeFailure("invalid managed runtime launch");
  }
  const request: ManagedRuntimeLaunchRequest = {
    schemaVersion: MANAGED_RUNTIME_HOST_SCHEMA_VERSION,
    runId: record.runId as string,
    taskId: record.taskId as string,
    workspaceId: record.workspaceId as string,
    sourceSha: record.sourceSha as string,
    treeSha: record.treeSha as string,
    platformTarget: record.platformTarget as ManagedRuntimePlatformTarget,
    controllerKind: record.controllerKind as ManagedRuntimeControllerKind,
    controllerBundleDigest: record.controllerBundleDigest as string,
    controllerInstanceDigest: record.controllerInstanceDigest as string,
    guestBundleDigest: record.guestBundleDigest as string,
    profileDigest: MANAGED_RUNTIME_ISOLATION_PROFILE_DIGEST,
    ipcAudience: "keiko-managed-runtime-broker-v1",
    nonce: record.nonce as string,
    sequence: record.sequence as number,
    issuedAtUnixMs: record.issuedAtUnixMs as number,
    expiresAtUnixMs: record.expiresAtUnixMs as number,
    revocationEpoch: record.revocationEpoch as number,
    policyVersion: record.policyVersion as string,
  };
  return Object.freeze({
    ok: true,
    value: Object.freeze(request),
  });
}

export function parseManagedRuntimeBundleDescriptor(
  value: unknown,
): ManagedRuntimeParse<ManagedRuntimeBundleDescriptor> {
  const record = asManagedRuntimeRecord(value);
  if (
    record === undefined ||
    !hasOnlyManagedRuntimeKeys(record, BUNDLE_KEYS) ||
    record.schemaVersion !== MANAGED_RUNTIME_HOST_SCHEMA_VERSION ||
    !controllerMatchesPlatform(record) ||
    !hasBundleDigests(record) ||
    !hasExactEnvironment(record.environmentNames)
  ) {
    return managedRuntimeFailure("invalid runtime bundle");
  }
  const descriptor = {
    ...record,
    environmentNames: MANAGED_RUNTIME_RUNTIME_ENV_NAMES,
  } as unknown as ManagedRuntimeBundleDescriptor;
  return Object.freeze({ ok: true, value: Object.freeze(descriptor) });
}
