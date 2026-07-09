import type {
  UpdatePortableSidecarFailureCode,
  UpdatePortableSidecarSummary,
  UpdatePortableTarget,
  UpdateSessionFailureReason,
} from "@oscharko-dev/keiko-contracts";
import {
  digestField,
  fieldEquals,
  recordAt,
  signatureKind,
} from "./update-portable-staging-shared.js";

export interface PortableSidecarRuntimeVerification {
  readonly summary: UpdatePortableSidecarSummary;
  readonly payloadRootPath: string;
  readonly executablePath: string;
  readonly licenseEvidencePath: string;
  readonly licenseEvidenceSha256: string;
  readonly sbomEvidencePath: string;
  readonly sbomEvidenceSha256: string;
}

export interface PortableSidecarManifestVerification {
  readonly sidecars: readonly PortableSidecarRuntimeVerification[];
  readonly summaries: readonly UpdatePortableSidecarSummary[];
}

interface ParsedSidecarPayload {
  readonly payloadRootPath: string;
  readonly payloadSha256: string;
  readonly sizeBytes: number;
  readonly executablePath: string;
}

export class PortableSidecarVerificationError extends Error {
  public readonly reason: UpdateSessionFailureReason = "portable-sidecar-verification-failed";

  public constructor(
    public readonly failureCode: UpdatePortableSidecarFailureCode,
    message: string,
    public readonly sidecarSummary?: UpdatePortableSidecarSummary | undefined,
  ) {
    super(message);
    this.name = "PortableSidecarVerificationError";
  }
}

const SIDECAR_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/u;
const HEX_SHA256 = /^[a-f0-9]{64}$/u;

function fail(
  code: UpdatePortableSidecarFailureCode,
  message: string,
  sidecar?: PortableSidecarRuntimeVerification,
): never {
  throw new PortableSidecarVerificationError(
    code,
    message,
    sidecar === undefined ? undefined : failedSummary(sidecar.summary, code),
  );
}

function failedSummary(
  summary: UpdatePortableSidecarSummary,
  code: UpdatePortableSidecarFailureCode,
): UpdatePortableSidecarSummary {
  return { ...summary, status: "failed", failureCode: code };
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function positiveNumberField(
  record: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  const value = record?.[key];
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function isSafeRelativePath(value: string): boolean {
  if (value.length === 0 || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value)) return false;
  if (value.startsWith("/") || value.startsWith("\\\\") || value.startsWith("//")) return false;
  if (/^[A-Za-z]:/u.test(value)) return false;
  return value
    .replaceAll("\\", "/")
    .split("/")
    .every((part) => part !== "" && part !== "." && part !== "..");
}

function pathInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}/`);
}

function safeContainedPath(value: unknown, root: string): string | undefined {
  if (typeof value !== "string" || !isSafeRelativePath(value)) return undefined;
  const normalized = value.replaceAll("\\", "/");
  return pathInside(root, normalized) && normalized !== root ? normalized : undefined;
}

function digestFieldRequired(
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && HEX_SHA256.test(value) ? value : undefined;
}

function targetChecksVerified(
  target: UpdatePortableTarget,
  checks: Record<string, unknown> | undefined,
): boolean {
  const keys =
    target === "windows-x64"
      ? ["publisherChainVerified", "timestampVerified"]
      : ["developerIdVerified", "notarizationVerified", "stapleVerified", "assessmentVerified"];
  return keys.every((key) => checks?.[key] === true);
}

function signingVerified(
  signing: Record<string, unknown> | undefined,
  target: UpdatePortableTarget,
): boolean {
  const checks = recordAt(signing, "verificationChecks");
  const macos = target !== "windows-x64";
  return (
    fieldEquals(signing, "verificationPolicy", "production") &&
    fieldEquals(signing, "verificationStatus", "verified-production") &&
    fieldEquals(signing, "signatureKind", signatureKind(target)) &&
    fieldEquals(signing, "signatureVerified", true) &&
    fieldEquals(signing, "notarizationRequired", macos) &&
    fieldEquals(signing, "notarizationVerified", macos) &&
    targetChecksVerified(target, checks)
  );
}

function parseEvidence(
  runtime: Record<string, unknown>,
  key: "licenseEvidence" | "sbomEvidence",
  payloadRootPath: string,
): { readonly path: string; readonly sha256: string } | undefined {
  const evidence = recordAt(runtime, key);
  const path = safeContainedPath(evidence?.path, payloadRootPath);
  const sha256 = digestFieldRequired(evidence, "sha256");
  return path === undefined || sha256 === undefined ? undefined : { path, sha256 };
}

function baseSummary(
  runtime: Record<string, unknown>,
  target: UpdatePortableTarget,
  payloadSha256: string,
  sizeBytes: number,
): UpdatePortableSidecarSummary | undefined {
  const upstream = recordAt(runtime, "upstream");
  const adapter = recordAt(runtime, "adapterCompatibility");
  const name = stringField(runtime, "name");
  const kind = stringField(runtime, "kind");
  const upstreamName = stringField(upstream, "name");
  const upstreamVersion = stringField(upstream, "version");
  const adapterName = stringField(adapter, "adapterName");
  const adapterVersion = stringField(adapter, "adapterVersion");
  const protocolVersion = stringField(adapter, "protocolVersion");
  if (
    name === undefined ||
    kind === undefined ||
    upstreamName === undefined ||
    upstreamVersion === undefined ||
    adapterName === undefined ||
    adapterVersion === undefined ||
    protocolVersion === undefined
  ) {
    return undefined;
  }
  return {
    name,
    kind,
    upstreamName,
    upstreamVersion,
    adapterName,
    adapterVersion,
    protocolVersion,
    platformTarget: target,
    payloadSha256,
    payloadSha256Prefix: payloadSha256.slice(0, 12),
    sizeBytes,
    status: "verified",
  };
}

function parseRuntime(
  entry: unknown,
  target: UpdatePortableTarget,
  names: Set<string>,
): PortableSidecarRuntimeVerification {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    fail("sidecar-metadata-malformed", "sidecar metadata is malformed");
  }
  const runtime = entry as Record<string, unknown>;
  const name = stringField(runtime, "name");
  if (name === undefined || !SIDECAR_NAME_PATTERN.test(name) || names.has(name)) {
    fail("sidecar-metadata-malformed", "sidecar identity is malformed");
  }
  names.add(name);
  return parseNamedRuntime(runtime, target, name);
}

function parsePayload(runtime: Record<string, unknown>, name: string): ParsedSidecarPayload {
  const payloadRootPath = stringField(runtime, "payloadRootPath");
  const expectedRoot = `runtime/sidecars/${name}`;
  if (payloadRootPath !== expectedRoot || !isSafeRelativePath(payloadRootPath)) {
    fail("sidecar-payload-outside-root", "sidecar payload root is invalid");
  }
  const payloadSha256 = digestField(runtime, "payloadSha256");
  const sizeBytes = positiveNumberField(runtime, "sizeBytes");
  const executablePath = safeContainedPath(runtime.executablePath, payloadRootPath);
  if (payloadSha256 === undefined || sizeBytes === undefined || executablePath === undefined) {
    fail("sidecar-metadata-malformed", "sidecar payload metadata is malformed");
  }
  return { payloadRootPath, payloadSha256, sizeBytes, executablePath };
}

function requiredEvidence(
  runtime: Record<string, unknown>,
  key: "licenseEvidence" | "sbomEvidence",
  payloadRootPath: string,
  code: UpdatePortableSidecarFailureCode,
  message: string,
): { readonly path: string; readonly sha256: string } {
  const evidence = parseEvidence(runtime, key, payloadRootPath);
  if (evidence === undefined) fail(code, message);
  return evidence;
}

function parseNamedRuntime(
  runtime: Record<string, unknown>,
  target: UpdatePortableTarget,
  name: string,
): PortableSidecarRuntimeVerification {
  if (runtime.platformTarget !== target)
    fail("sidecar-platform-mismatch", "sidecar target mismatch");
  const payload = parsePayload(runtime, name);
  const license = requiredEvidence(
    runtime,
    "licenseEvidence",
    payload.payloadRootPath,
    "sidecar-license-evidence-incomplete",
    "sidecar license evidence is incomplete",
  );
  const sbom = requiredEvidence(
    runtime,
    "sbomEvidence",
    payload.payloadRootPath,
    "sidecar-sbom-evidence-incomplete",
    "sidecar SBOM is incomplete",
  );
  if (!signingVerified(recordAt(runtime, "signing"), target)) {
    fail("sidecar-signing-unverified", "sidecar signing evidence is not verified");
  }
  const summary = baseSummary(runtime, target, payload.payloadSha256, payload.sizeBytes);
  if (summary === undefined) fail("sidecar-metadata-malformed", "sidecar metadata is incomplete");
  return {
    summary,
    payloadRootPath: payload.payloadRootPath,
    executablePath: payload.executablePath,
    licenseEvidencePath: license.path,
    licenseEvidenceSha256: license.sha256,
    sbomEvidencePath: sbom.path,
    sbomEvidenceSha256: sbom.sha256,
  };
}

function bindingArraysMatch(actual: unknown, expected: unknown): boolean {
  return (
    Array.isArray(actual) &&
    Array.isArray(expected) &&
    actual.length === expected.length &&
    actual.every((entry, index) => bindingValuesMatch(entry, expected[index]))
  );
}

function bindingRecordsMatch(
  actual: Record<string, unknown>,
  expected: Record<string, unknown>,
): boolean {
  const keys = new Set([...Object.keys(actual), ...Object.keys(expected)]);
  return [...keys].every((key) => bindingValuesMatch(actual[key], expected[key]));
}

function bindingValuesMatch(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(actual) || Array.isArray(expected)) {
    return bindingArraysMatch(actual, expected);
  }
  if (typeof actual === "object" || typeof expected === "object") {
    if (!isPlainRecord(actual) || !isPlainRecord(expected)) return false;
    return bindingRecordsMatch(actual, expected);
  }
  return actual === expected;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function verifiedSidecars(
  rawSidecars: readonly unknown[],
  target: UpdatePortableTarget,
): readonly PortableSidecarRuntimeVerification[] {
  const names = new Set<string>();
  return rawSidecars.map((entry) => parseRuntime(entry, target, names));
}

export function verifyPortableManifestSidecars(
  manifest: Record<string, unknown>,
  target: UpdatePortableTarget,
): PortableSidecarManifestVerification {
  const rawSidecars = manifest.sidecarRuntimes;
  const binding = recordAt(recordAt(manifest, "releaseImpact"), "reviewedBinding");
  const boundSidecars = binding?.sidecarRuntimes;
  if (rawSidecars === undefined) {
    if (boundSidecars !== undefined) {
      fail("sidecar-missing-required", "release-impact requires a sidecar payload");
    }
    return { sidecars: [], summaries: [] };
  }
  if (!Array.isArray(rawSidecars)) {
    fail("sidecar-metadata-malformed", "sidecar metadata is malformed");
  }
  if (!Array.isArray(boundSidecars) || !bindingValuesMatch(boundSidecars, rawSidecars)) {
    fail("sidecar-release-impact-binding-mismatch", "sidecar release binding is invalid");
  }
  const sidecars = verifiedSidecars(rawSidecars, target);
  return { sidecars, summaries: sidecars.map((sidecar) => sidecar.summary) };
}
