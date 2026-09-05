import { createHash } from "node:crypto";
import { buildGatewaySeatbeltCommand, type WrappedCommand } from "./backends.js";
import type { NetworkGatewayPolicy } from "./types.js";

/** Transient server-owned destination and identity; never persist the URL or wrapper profile. */
export interface RuntimeGatewayConfinementInput {
  readonly gatewayUrl: string;
  readonly runId: string;
  readonly treeBindingId: string;
  readonly envelopeDigest: string;
  readonly runtimeArtifactDigest: string;
  readonly modelProfileDigest: string;
}

export interface RuntimeGatewayConfinement {
  readonly schemaVersion: 1;
  readonly profile: "keiko-gateway";
  readonly addressFamily: "ipv4" | "ipv6";
  readonly port: number;
  readonly runId: string;
  readonly treeBindingId: string;
  readonly envelopeDigest: string;
  readonly runtimeArtifactDigest: string;
  readonly modelProfileDigest: string;
  readonly policyDigest: string;
}

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
        "fork-allowed-exec-runtime-and-apple-git-only-no-mach-lookup-no-appleevents-no-lsopen",
      ]),
    )
    .digest("hex");
}

export function createRuntimeGatewayConfinement(
  input: RuntimeGatewayConfinementInput,
): RuntimeGatewayConfinement {
  const policy = {
    schemaVersion: 1,
    profile: "keiko-gateway",
    ...gatewayAddress(input.gatewayUrl),
    runId: input.runId,
    treeBindingId: input.treeBindingId,
    envelopeDigest: input.envelopeDigest,
    runtimeArtifactDigest: input.runtimeArtifactDigest,
    modelProfileDigest: input.modelProfileDigest,
  } as const;
  const result = Object.freeze({ ...policy, policyDigest: policyDigest(policy) });
  if (!isRuntimeGatewayConfinement(result)) invalidPolicy();
  return result;
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
  if (Reflect.ownKeys(descriptors).length !== POLICY_KEYS.size) return undefined;
  const entries = Object.entries(descriptors);
  if (
    !entries.every(
      ([key, descriptor]) => POLICY_KEYS.has(key) && Object.hasOwn(descriptor, "value"),
    )
  )
    return undefined;
  return Object.fromEntries(entries.map(([key, descriptor]) => [key, descriptor.value as unknown]));
}

function validPolicy(value: unknown): value is RuntimeGatewayConfinement {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (!hasPolicyKeys(record)) return false;
  if (
    record.schemaVersion !== 1 ||
    record.profile !== "keiko-gateway" ||
    (record.addressFamily !== "ipv4" && record.addressFamily !== "ipv6")
  )
    return false;
  return (
    validPolicyIdentity(record) &&
    policyDigest(record as unknown as RuntimeGatewayConfinement) === record.policyDigest
  );
}

function hasPolicyKeys(record: Record<string, unknown>): boolean {
  return (
    Object.keys(record).length === POLICY_KEYS.size &&
    Object.keys(record).every((key) => POLICY_KEYS.has(key))
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
): WrappedCommand {
  const closed = copyRuntimeGatewayConfinement(policy);
  if (closed === undefined) invalidPolicy();
  const gateway: NetworkGatewayPolicy = {
    mode: "gateway",
    host: closed.addressFamily === "ipv4" ? "127.0.0.1" : "::1",
    port: closed.port,
  };
  return buildGatewaySeatbeltCommand(gateway, command, args);
}
