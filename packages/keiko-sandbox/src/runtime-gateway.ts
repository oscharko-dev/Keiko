import { createHash } from "node:crypto";
import { buildGatewaySeatbeltCommand, type WrappedCommand } from "./backends.js";
import type {
  NetworkGatewayPolicy,
  RuntimeGatewayEgress,
  RuntimeGatewayFilesystem,
  RuntimeGatewayProfile,
} from "./types.js";
import { copyRuntimeGatewayFilesystem } from "./seatbelt-execution-root.js";

/** Transient server-owned destination and identity; never persist the URL or wrapper profile. */
export interface RuntimeGatewayConfinementInput {
  readonly gatewayUrl: string;
  readonly runId: string;
  readonly treeBindingId: string;
  readonly envelopeDigest: string;
  readonly runtimeArtifactDigest: string;
  readonly modelProfileDigest: string;
  readonly filesystem?: RuntimeGatewayFilesystem | undefined;
  /** Absent selects the loopback-gateway-only profile. */
  readonly profile?: RuntimeGatewayProfile | undefined;
  /**
   * Native profile only: `inherited` at Full access, `loopback-only` below it. Absent fails closed
   * to `loopback-only`; the gateway profile is always loopback-gateway-only and refuses a value.
   */
  readonly egress?: RuntimeGatewayEgress | undefined;
}

export interface RuntimeGatewayConfinement {
  readonly schemaVersion: 1;
  readonly profile: RuntimeGatewayProfile;
  readonly addressFamily: "ipv4" | "ipv6";
  readonly port: number;
  readonly runId: string;
  readonly treeBindingId: string;
  readonly envelopeDigest: string;
  readonly runtimeArtifactDigest: string;
  readonly modelProfileDigest: string;
  readonly policyDigest: string;
  readonly filesystem?: RuntimeGatewayFilesystem | undefined;
  /** Present exactly when `profile` is `keiko-native`. */
  readonly egress?: RuntimeGatewayEgress | undefined;
}

const OPTIONAL_POLICY_KEYS: ReadonlySet<string> = new Set(["filesystem", "egress"]);
const EGRESS_DISPOSITIONS: ReadonlySet<unknown> = new Set<RuntimeGatewayEgress>([
  "inherited",
  "loopback-only",
]);
const DIGEST = /^[a-f0-9]{64}$/u;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const POLICY_KEYS = new Set([
  "schemaVersion",
  "profile",
  "addressFamily",
  "port",
  "runId",
  "treeBindingId",
  "envelopeDigest",
  "runtimeArtifactDigest",
  "modelProfileDigest",
  "policyDigest",
]);

function invalidPolicy(): never {
  throw new TypeError("runtime-gateway-policy-invalid");
}

function gatewayAddress(url: string): Pick<RuntimeGatewayConfinement, "addressFamily" | "port"> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return invalidPolicy();
  }
  if (!isGatewayUrl(parsed)) invalidPolicy();
  if (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "[::1]") invalidPolicy();
  const port = parsed.port === "" ? 80 : Number(parsed.port);
  return { addressFamily: parsed.hostname === "127.0.0.1" ? "ipv4" : "ipv6", port };
}

function isGatewayUrl(parsed: URL): boolean {
  return (
    parsed.protocol === "http:" &&
    parsed.username === "" &&
    parsed.password === "" &&
    parsed.search === "" &&
    parsed.hash === ""
  );
}

/** The filesystem plan's fixed-position digest fields; a plan without one adds none. */
function filesystemDigestFields(
  filesystem: RuntimeGatewayFilesystem | undefined,
): readonly string[] {
  if (filesystem === undefined) return [];
  return [
    "native-filesystem-root-union-v1",
    filesystem.workspaceRoot,
    filesystem.workspaceAccess,
    filesystem.privateStateRoot,
    filesystem.runtimeReadRoot,
    ...(filesystem.deniedReadRoots ?? []),
    ...(filesystem.toolchainReadRoots === undefined
      ? []
      : ["native-toolchain-read-roots-v1", ...filesystem.toolchainReadRoots]),
    ...(filesystem.gitMetadataReadRoots === undefined
      ? []
      : ["native-git-metadata-read-roots-v1", ...filesystem.gitMetadataReadRoots]),
    ...(filesystem.externalReadRoots === undefined
      ? []
      : ["native-external-read-roots-v1", ...filesystem.externalReadRoots]),
    ...(filesystem.protectedWriteRoots === undefined
      ? []
      : ["native-protected-write-roots-v1", ...filesystem.protectedWriteRoots]),
    ...(filesystem.linkFreeWriteRoots === undefined
      ? []
      : ["native-link-free-write-roots-v1", ...filesystem.linkFreeWriteRoots]),
    ...(filesystem.linkedFiles === undefined
      ? []
      : ["native-linked-files-v1", ...filesystem.linkedFiles]),
  ];
}

function policyDigest(policy: Omit<RuntimeGatewayConfinement, "policyDigest">): string {
  // Fixed-position JSON framing is unambiguous; labels and enforcement version bind the ruler.
  return createHash("sha256")
    .update(
      JSON.stringify([
        "keiko-runtime-gateway-seatbelt-v1",
        policy.schemaVersion,
        policy.profile,
        policy.addressFamily,
        policy.port,
        policy.runId,
        policy.treeBindingId,
        policy.envelopeDigest,
        policy.runtimeArtifactDigest,
        policy.modelProfileDigest,
        policy.profile === "keiko-native"
          ? "native-exec-inherited-own-sandbox-process-targets-no-appleevents-no-lsopen"
          : "fork-allowed-exec-runtime-and-apple-git-only-own-sandbox-process-targets-no-mach-lookup-no-appleevents-no-lsopen",
        ...(policy.egress === undefined ? [] : [`native-egress-${policy.egress}-v1`]),
        ...filesystemDigestFields(policy.filesystem),
      ]),
    )
    .digest("hex");
}

export function createRuntimeGatewayConfinement(
  input: RuntimeGatewayConfinementInput,
): RuntimeGatewayConfinement {
  const filesystem = closedFilesystem(input.filesystem);
  const profile = input.profile ?? "keiko-gateway";
  // A filesystem block, where the platform has one, must agree with the profile: the native
  // profile writes the workspace; the gateway profile never does.
  if (
    filesystem !== undefined &&
    (profile === "keiko-native") !== (filesystem.workspaceAccess === "read-write")
  )
    invalidPolicy();
  const egress = resolvedEgress(profile, input.egress);
  const policy = {
    schemaVersion: 1,
    profile,
    ...gatewayAddress(input.gatewayUrl),
    runId: input.runId,
    treeBindingId: input.treeBindingId,
    envelopeDigest: input.envelopeDigest,
    runtimeArtifactDigest: input.runtimeArtifactDigest,
    modelProfileDigest: input.modelProfileDigest,
    ...(filesystem === undefined ? {} : { filesystem }),
    ...(egress === undefined ? {} : { egress }),
  } as const;
  const result = Object.freeze({ ...policy, policyDigest: policyDigest(policy) });
  if (!isRuntimeGatewayConfinement(result)) invalidPolicy();
  return result;
}

/** The native profile always records its disposition; the gateway profile never has one. */
function resolvedEgress(
  profile: RuntimeGatewayProfile,
  egress: RuntimeGatewayEgress | undefined,
): RuntimeGatewayEgress | undefined {
  if (profile !== "keiko-native") return egress === undefined ? undefined : invalidPolicy();
  if (egress === undefined) return "loopback-only";
  return EGRESS_DISPOSITIONS.has(egress) ? egress : invalidPolicy();
}

function closedFilesystem(value: unknown): RuntimeGatewayFilesystem | undefined {
  if (value === undefined) return undefined;
  return copyRuntimeGatewayFilesystem(value) ?? invalidPolicy();
}

export function isRuntimeGatewayConfinement(value: unknown): value is RuntimeGatewayConfinement {
  return copyRuntimeGatewayConfinement(value) !== undefined;
}

/** Close data descriptors once; validation must never execute a caller's property accessor. */
export function copyRuntimeGatewayConfinement(
  value: unknown,
): RuntimeGatewayConfinement | undefined {
  const record = policyData(value);
  if (record === undefined || !validPolicy(record)) return undefined;
  return Object.freeze(record as unknown as RuntimeGatewayConfinement);
}

function policyData(value: unknown): Record<string, unknown> | undefined {
  try {
    return ownPolicyData(value);
  } catch {
    return undefined;
  }
}

function ownPolicyData(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length < POLICY_KEYS.size || keys.length > POLICY_KEYS.size + OPTIONAL_POLICY_KEYS.size)
    return undefined;
  const entries = Object.entries(descriptors);
  if (
    !entries.every(
      ([key, descriptor]) =>
        (POLICY_KEYS.has(key) || OPTIONAL_POLICY_KEYS.has(key)) &&
        Object.hasOwn(descriptor, "value"),
    )
  )
    return undefined;
  const record = Object.fromEntries(
    entries.map(([key, descriptor]) => [key, descriptor.value as unknown]),
  );
  if (Object.hasOwn(record, "filesystem")) record.filesystem = closedFilesystem(record.filesystem);
  return record;
}

const PROFILES: ReadonlySet<unknown> = new Set<RuntimeGatewayProfile>([
  "keiko-gateway",
  "keiko-native",
]);
const ADDRESS_FAMILIES: ReadonlySet<unknown> = new Set(["ipv4", "ipv6"]);

function validPolicy(value: unknown): value is RuntimeGatewayConfinement {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (!hasPolicyKeys(record)) return false;
  if (
    record.schemaVersion !== 1 ||
    !PROFILES.has(record.profile) ||
    !ADDRESS_FAMILIES.has(record.addressFamily)
  )
    return false;
  return (
    validPolicyIdentity(record) &&
    policyDigest(record as unknown as RuntimeGatewayConfinement) === record.policyDigest
  );
}

function hasPolicyKeys(record: Record<string, unknown>): boolean {
  return (
    [...POLICY_KEYS].every((key) => Object.hasOwn(record, key)) &&
    Object.keys(record).every((key) => POLICY_KEYS.has(key) || OPTIONAL_POLICY_KEYS.has(key)) &&
    (!Object.hasOwn(record, "filesystem") ||
      copyRuntimeGatewayFilesystem(record.filesystem) !== undefined) &&
    // The egress disposition exists exactly for the native profile and is one of the closed values.
    Object.hasOwn(record, "egress") === (record.profile === "keiko-native") &&
    (!Object.hasOwn(record, "egress") || EGRESS_DISPOSITIONS.has(record.egress))
  );
}

function validPolicyIdentity(record: Record<string, unknown>): boolean {
  return (
    typeof record.runId === "string" &&
    RUN_ID.test(record.runId) &&
    Number.isSafeInteger(record.port) &&
    Number(record.port) > 0 &&
    Number(record.port) <= 65_535 &&
    [
      record.treeBindingId,
      record.envelopeDigest,
      record.runtimeArtifactDigest,
      record.modelProfileDigest,
      record.policyDigest,
    ].every((digest) => typeof digest === "string" && DIGEST.test(digest))
  );
}

/**
 * Thin consumer of the shared gateway Seatbelt builder (`backends.ts`, ADR-0043 D11/D14): this
 * function stays the stable public entry point for existing callers, but no longer carries its own
 * copy of the profile-string formula. `copyRuntimeGatewayConfinement` still owns the tamper-evident
 * validation this policy's richer attestation binding (runId/treeBindingId/digests) needs, which is
 * out of scope for the narrower `NetworkGatewayPolicy` contract shape.
 */
export function buildRuntimeGatewaySeatbeltCommand(
  policy: RuntimeGatewayConfinement,
  command: string,
  args: readonly string[],
  gitExecutable: string,
): WrappedCommand {
  const closed = copyRuntimeGatewayConfinement(policy);
  if (closed === undefined) invalidPolicy();
  const gateway: NetworkGatewayPolicy = {
    mode: "gateway",
    host: closed.addressFamily === "ipv4" ? "127.0.0.1" : "::1",
    port: closed.port,
  };
  // The attested profile selects the formula: forgetting it here would confine a native run
  // under the gateway allowlist, which the real-Seatbelt proof in the test suite pins.
  return buildGatewaySeatbeltCommand(
    gateway,
    command,
    args,
    gitExecutable,
    closed.filesystem,
    closed.profile,
    closed.egress,
  );
}
