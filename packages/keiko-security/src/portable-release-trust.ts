import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";
import { canonicalise } from "./hashing.js";

const KEY_ID = /^[a-f0-9]{64}$/u;
const BASE64 = /^[A-Za-z0-9+/]{86}==$/u;
const ROLE = "keiko-portable-release";
const ALGORITHM = "ed25519";
export const PORTABLE_RELEASE_TRUST_MAX_LIFETIME_MS = 366 * 24 * 60 * 60 * 1000;
const PRODUCTION_KEY_ID = "63b20c885c396471b6e0141a7b971c78b37b907066485d8107c3b572e22ef814";
const PRODUCTION_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAIS2FY9YmfR7N/X6xxbt1HnPOGwPdHfF9arOxcVeD0os=
-----END PUBLIC KEY-----
`;
const TRUST_KEYS = [
  "algorithm",
  "expiresAt",
  "keyId",
  "metadataVersion",
  "role",
  "schemaVersion",
  "signature",
  "signedAt",
] as const;

export interface PortableReleaseTrustedKey {
  readonly keyId: string;
  readonly publicKeyPem: string;
}

/**
 * Trust roots shipped with Keiko. Add a successor key in a normal reviewed release before using
 * it to publish updates; retain an old key until every supported source version trusts its
 * successor. Private signing material never belongs in this repository or in a portable bundle.
 */
export const KEIKO_PORTABLE_RELEASE_TRUSTED_KEYS: readonly PortableReleaseTrustedKey[] =
  Object.freeze([Object.freeze({ keyId: PRODUCTION_KEY_ID, publicKeyPem: PRODUCTION_PUBLIC_KEY })]);

export interface CreatePortableReleaseTrustOptions {
  readonly expiresAt: string;
  readonly metadataVersion: number;
  readonly privateKeyPem: string;
  readonly signedAt: string;
}

export interface VerifyPortableReleaseTrustOptions {
  readonly minimumMetadataVersion?: number | undefined;
  readonly now: Date;
  readonly trustedKeys: readonly PortableReleaseTrustedKey[];
}

export type PortableReleaseTrustFailureReason =
  | "key-untrusted"
  | "metadata-expired"
  | "metadata-malformed"
  | "metadata-rollback"
  | "signature-invalid";

export type PortableReleaseTrustVerification =
  | { readonly ok: true; readonly keyId: string; readonly metadataVersion: number }
  | { readonly ok: false; readonly reason: PortableReleaseTrustFailureReason };

interface PortableReleaseTrustMetadata {
  readonly algorithm: typeof ALGORITHM;
  readonly expiresAt: string;
  readonly keyId: string;
  readonly metadataVersion: number;
  readonly role: typeof ROLE;
  readonly schemaVersion: 1;
  readonly signature: string;
  readonly signedAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactTrustKeys(value: Record<string, unknown>): boolean {
  const actual = Object.keys(value).sort((left, right) => left.localeCompare(right, "en-US"));
  const expected = [...TRUST_KEYS].sort((left, right) => left.localeCompare(right, "en-US"));
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function validIsoInstant(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const instant = new Date(value);
  return Number.isFinite(instant.valueOf()) && instant.toISOString() === value;
}

function canonicalBase64Signature(value: unknown): value is string {
  if (typeof value !== "string" || !BASE64.test(value)) return false;
  return Buffer.from(value, "base64").toString("base64") === value;
}

function releaseId(manifest: Record<string, unknown>): number | undefined {
  const release = manifest.release;
  if (!isRecord(release)) return undefined;
  const value = release.releaseId;
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function validTrustIdentity(value: Record<string, unknown>): boolean {
  return (
    value.schemaVersion === 1 &&
    value.role === ROLE &&
    value.algorithm === ALGORITHM &&
    typeof value.keyId === "string" &&
    KEY_ID.test(value.keyId)
  );
}

function validTrustVersion(value: Record<string, unknown>): boolean {
  return (
    typeof value.metadataVersion === "number" &&
    Number.isSafeInteger(value.metadataVersion) &&
    value.metadataVersion > 0
  );
}

function validTrustWindow(value: Record<string, unknown>): boolean {
  const signedAt = validIsoInstant(value.signedAt) ? new Date(value.signedAt) : undefined;
  const expiresAt = validIsoInstant(value.expiresAt) ? new Date(value.expiresAt) : undefined;
  const lifetime =
    expiresAt !== undefined && signedAt !== undefined
      ? expiresAt.valueOf() - signedAt.valueOf()
      : 0;
  return lifetime > 0 && lifetime <= PORTABLE_RELEASE_TRUST_MAX_LIFETIME_MS;
}

function trustMetadata(
  manifest: Record<string, unknown>,
): PortableReleaseTrustMetadata | undefined {
  const value = manifest.releaseTrust;
  if (!isRecord(value) || !exactTrustKeys(value)) return undefined;
  if (
    !validTrustIdentity(value) ||
    !validTrustVersion(value) ||
    !validTrustWindow(value) ||
    !canonicalBase64Signature(value.signature)
  ) {
    return undefined;
  }
  return value as unknown as PortableReleaseTrustMetadata;
}

function signingPayload(
  manifest: Record<string, unknown>,
  trust: Omit<PortableReleaseTrustMetadata, "signature">,
): Buffer {
  return Buffer.from(canonicalise({ ...manifest, releaseTrust: trust }), "utf8");
}

function releaseTrustWithoutSignature(
  trust: PortableReleaseTrustMetadata,
): Omit<PortableReleaseTrustMetadata, "signature"> {
  const { signature: _signature, ...metadata } = trust;
  return metadata;
}

function publicKeyFromPrivate(privateKey: KeyObject): KeyObject {
  if (privateKey.type !== "private" || privateKey.asymmetricKeyType !== ALGORITHM) {
    throw new TypeError("portable release signing key must be an Ed25519 private key");
  }
  return createPublicKey(privateKey);
}

export function portableReleaseTrustKeyId(publicKeyPem: string): string {
  const publicKey = createPublicKey(publicKeyPem);
  if (publicKey.asymmetricKeyType !== ALGORITHM) {
    throw new TypeError("portable release trust key must be an Ed25519 public key");
  }
  const bytes = publicKey.export({ format: "der", type: "spki" });
  return createHash("sha256").update(bytes).digest("hex");
}

export function createPortableReleaseTrust(
  manifest: Record<string, unknown>,
  options: CreatePortableReleaseTrustOptions,
): Record<string, unknown> {
  if (releaseId(manifest) !== options.metadataVersion) {
    throw new TypeError("portable release metadata version must match the GitHub release id");
  }
  if (!validIsoInstant(options.signedAt) || !validIsoInstant(options.expiresAt)) {
    throw new TypeError("portable release trust timestamps must be canonical ISO instants");
  }
  const lifetime = new Date(options.expiresAt).valueOf() - new Date(options.signedAt).valueOf();
  if (lifetime <= 0) {
    throw new TypeError("portable release trust expiry must follow its signing time");
  }
  if (lifetime > PORTABLE_RELEASE_TRUST_MAX_LIFETIME_MS) {
    throw new TypeError("portable release trust lifetime exceeds the maximum");
  }
  const privateKey = createPrivateKey(options.privateKeyPem);
  const publicKey = publicKeyFromPrivate(privateKey);
  const metadata: Omit<PortableReleaseTrustMetadata, "signature"> = {
    algorithm: ALGORITHM,
    expiresAt: options.expiresAt,
    keyId: portableReleaseTrustKeyId(publicKey.export({ format: "pem", type: "spki" })),
    metadataVersion: options.metadataVersion,
    role: ROLE,
    schemaVersion: 1 as const,
    signedAt: options.signedAt,
  };
  const unsigned = structuredClone(manifest);
  delete unsigned.releaseTrust;
  const signature = sign(null, signingPayload(unsigned, metadata), privateKey).toString("base64");
  return { ...unsigned, releaseTrust: { ...metadata, signature } };
}

function trustedPublicKey(
  trust: PortableReleaseTrustMetadata,
  trustedKeys: readonly PortableReleaseTrustedKey[],
): KeyObject | undefined {
  const candidate = trustedKeys.find((key) => key.keyId === trust.keyId);
  if (candidate === undefined) {
    return undefined;
  }
  try {
    if (portableReleaseTrustKeyId(candidate.publicKeyPem) !== trust.keyId) return undefined;
    return createPublicKey(candidate.publicKeyPem);
  } catch {
    return undefined;
  }
}

export function verifyPortableReleaseTrust(
  manifest: Record<string, unknown>,
  options: VerifyPortableReleaseTrustOptions,
): PortableReleaseTrustVerification {
  const trust = trustMetadata(manifest);
  if (trust === undefined || releaseId(manifest) !== trust.metadataVersion) {
    return { ok: false, reason: "metadata-malformed" };
  }
  if (
    options.minimumMetadataVersion !== undefined &&
    trust.metadataVersion < options.minimumMetadataVersion
  ) {
    return { ok: false, reason: "metadata-rollback" };
  }
  if (new Date(trust.expiresAt) <= options.now) {
    return { ok: false, reason: "metadata-expired" };
  }
  const publicKey = trustedPublicKey(trust, options.trustedKeys);
  if (publicKey === undefined) return { ok: false, reason: "key-untrusted" };
  const unsigned = structuredClone(manifest);
  delete unsigned.releaseTrust;
  const valid = verify(
    null,
    signingPayload(unsigned, releaseTrustWithoutSignature(trust)),
    publicKey,
    Buffer.from(trust.signature, "base64"),
  );
  return valid
    ? { keyId: trust.keyId, metadataVersion: trust.metadataVersion, ok: true }
    : { ok: false, reason: "signature-invalid" };
}
