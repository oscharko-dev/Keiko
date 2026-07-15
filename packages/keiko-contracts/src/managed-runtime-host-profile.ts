export const MANAGED_RUNTIME_HOST_SCHEMA_VERSION = "1" as const;
export const MANAGED_RUNTIME_HOST_DEADLINE_MS = 900_000 as const;
export const MANAGED_RUNTIME_RUNTIME_ENV_NAMES = Object.freeze([
  "KEIKO_RUNTIME_ENDPOINT",
  "KEIKO_MODEL_ALIAS",
  "KEIKO_RUN_CAPABILITY",
] as const);
export const MANAGED_RUNTIME_ISOLATION_PROFILE = Object.freeze({
  schemaVersion: MANAGED_RUNTIME_HOST_SCHEMA_VERSION,
  profileId: "isolated-worker-v1",
  topology: "per-run-linux-micro-vm",
  network: "no-vnic",
  ipc: "authenticated-vm-bound-broker",
  hostWorkspace: "not-mounted",
  workspaceInput: "filtered-sha-bound-snapshot",
  workspaceStorage: "disposable-encrypted",
  hostEffects: "keiko-revalidated",
  vmMemoryBytes: 2_147_483_648,
  memoryBallooning: false,
  guestSwap: false,
  cgroup: Object.freeze({
    memoryMaxBytes: 2_147_483_648,
    memorySwapMaxBytes: 0,
    memoryOomGroup: 1,
    pidsMax: 32,
  } as const),
  deadline: Object.freeze({ clock: "host-monotonic", durationMs: 900_000 } as const),
  runtimeUser: "unprivileged",
  shimUser: "root-owned",
  devices: Object.freeze({
    directorySharing: false,
    clipboard: false,
    usb: false,
    gpu: false,
  } as const),
  arbitraryProxy: false,
  warmPool: false,
  measuredAttestation: false,
  environmentNames: MANAGED_RUNTIME_RUNTIME_ENV_NAMES,
} as const);
export const MANAGED_RUNTIME_ISOLATION_PROFILE_CANONICAL_JSON =
  '{"schemaVersion":"1","profileId":"isolated-worker-v1","topology":"per-run-linux-micro-vm","network":"no-vnic","ipc":"authenticated-vm-bound-broker","hostWorkspace":"not-mounted","workspaceInput":"filtered-sha-bound-snapshot","workspaceStorage":"disposable-encrypted","hostEffects":"keiko-revalidated","vmMemoryBytes":2147483648,"memoryBallooning":false,"guestSwap":false,"cgroup":{"memoryMaxBytes":2147483648,"memorySwapMaxBytes":0,"memoryOomGroup":1,"pidsMax":32},"deadline":{"clock":"host-monotonic","durationMs":900000},"runtimeUser":"unprivileged","shimUser":"root-owned","devices":{"directorySharing":false,"clipboard":false,"usb":false,"gpu":false},"arbitraryProxy":false,"warmPool":false,"measuredAttestation":false,"environmentNames":["KEIKO_RUNTIME_ENDPOINT","KEIKO_MODEL_ALIAS","KEIKO_RUN_CAPABILITY"]}' as const;
export const MANAGED_RUNTIME_ISOLATION_PROFILE_DIGEST =
  "1ce04f7f16eb18c3523ab8aab08e8df52d447f9278a1ed683898cd4d82ef2bad" as const;
export const MANAGED_RUNTIME_PLATFORM_TARGETS = Object.freeze([
  "macos-arm64",
  "macos-x64",
  "windows-x64",
] as const);
export const MANAGED_RUNTIME_CONTROLLER_KINDS = Object.freeze([
  "apple-virtualization",
  "windows-hcs-hyper-v-service",
] as const);
export const MANAGED_RUNTIME_CAPABILITY_STATES = Object.freeze([
  "available",
  "unavailable",
] as const);
export const MANAGED_RUNTIME_UNAVAILABLE_REASONS = Object.freeze([
  "host-not-installed",
  "host-signature-invalid",
  "host-version-unsupported",
  "virtualization-disabled",
  "virtualization-unavailable",
  "unsupported-platform",
  "unsupported-architecture",
  "unsupported-os-version",
  "unsupported-windows-edition",
  "entitlement-missing",
  "stale-vm-recovery-pending",
  "policy-revoked",
] as const);
export const MANAGED_RUNTIME_REMEDIATIONS = Object.freeze([
  "none",
  "install-machine-managed-host",
  "repair-machine-managed-host",
  "enable-virtualization",
  "upgrade-operating-system",
  "upgrade-windows-edition",
  "contact-enterprise-administrator",
  "wait-for-stale-vm-recovery",
  "update-keiko",
] as const);
export const MANAGED_RUNTIME_RECOVERY_STATES = Object.freeze([
  "pending",
  "completed",
  "failed",
] as const);
export const MANAGED_RUNTIME_RECOVERY_TRIGGERS = Object.freeze(["startup", "restart"] as const);
export const MANAGED_RUNTIME_EMPTY_INVENTORY_DIGEST =
  "09afa09dee23dfb20231fc07a957346d65300283bb0bdf22dfdd69ce7ed054ca" as const;
export const MANAGED_RUNTIME_DIGEST_DOMAINS = Object.freeze({
  runIdDigest: "keiko-managed-runtime-v1:run-id\0",
  taskIdDigest: "keiko-managed-runtime-v1:task-id\0",
  workspaceIdDigest: "keiko-managed-runtime-v1:workspace-id\0",
  policyVersionDigest: "keiko-managed-runtime-v1:policy-version\0",
  controllerInstanceDigest: "keiko-managed-runtime-v1:controller-instance\0",
  inventoryDigest: "keiko-managed-runtime-recovery-inventory-v1\0",
} as const);
export const MANAGED_RUNTIME_LIFECYCLE_KINDS = Object.freeze([
  "launch-observed",
  "running-observed",
  "stop-observed",
  "termination-observed",
  "revocation-observed",
  "failure-observed",
] as const);
export const MANAGED_RUNTIME_LIFECYCLE_REASONS = Object.freeze([
  "launch-accepted",
  "broker-authenticated",
  "requested",
  "deadline-expired",
  "lease-expired",
  "lease-revoked",
  "bff-disconnected",
  "controller-crashed",
  "guest-failed",
  "policy-revoked",
] as const);

export type ManagedRuntimePlatformTarget = (typeof MANAGED_RUNTIME_PLATFORM_TARGETS)[number];
export type ManagedRuntimeControllerKind = (typeof MANAGED_RUNTIME_CONTROLLER_KINDS)[number];
export type ManagedRuntimeUnavailableReason = (typeof MANAGED_RUNTIME_UNAVAILABLE_REASONS)[number];
export type ManagedRuntimeRemediation = (typeof MANAGED_RUNTIME_REMEDIATIONS)[number];
export type ManagedRuntimeRecoveryState = (typeof MANAGED_RUNTIME_RECOVERY_STATES)[number];
export type ManagedRuntimeRecoveryTrigger = (typeof MANAGED_RUNTIME_RECOVERY_TRIGGERS)[number];
export type ManagedRuntimeLifecycleKind = (typeof MANAGED_RUNTIME_LIFECYCLE_KINDS)[number];
export type ManagedRuntimeLifecycleReason = (typeof MANAGED_RUNTIME_LIFECYCLE_REASONS)[number];
export type ManagedRuntimeParse<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly errors: readonly string[] };

export type ManagedRuntimeUnknownRecord = Readonly<Record<string, unknown>>;

export function asManagedRuntimeRecord(value: unknown): ManagedRuntimeUnknownRecord | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype) return undefined;
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some((key) => typeof key !== "string")) return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (
      ownKeys.some((key) => {
        const descriptor = descriptors[key as string];
        if (descriptor?.enumerable !== true) return true;
        return !("value" in descriptor);
      })
    ) {
      return undefined;
    }
    const entries = ownKeys.map((key) => [key, descriptors[key as string]?.value] as const);
    return Object.freeze(Object.fromEntries(entries));
  } catch {
    return undefined;
  }
}

export function hasOnlyManagedRuntimeKeys(
  value: ManagedRuntimeUnknownRecord,
  allowed: readonly string[],
): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

export function isManagedRuntimeSafeInteger(value: unknown, minimum = 0): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}

export function isManagedRuntimeMember<T extends string>(
  value: unknown,
  allowed: readonly T[],
): value is T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value);
}

export function managedRuntimeFailure<T>(message: string): ManagedRuntimeParse<T> {
  return Object.freeze({ ok: false, errors: Object.freeze([message]) });
}
