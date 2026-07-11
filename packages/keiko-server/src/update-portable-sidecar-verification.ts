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
  readonly executableTreeSha256: string;
  readonly licenseEvidencePath: string;
  readonly licenseEvidenceSha256: string;
  readonly sbomEvidencePath: string;
  readonly sbomEvidenceSha256: string;
  /**
   * Server-owned provenance facts. This projection is intentionally content-free and is the
   * only portable-runtime evidence a launch path may consume.
   */
  readonly availability: PortableSidecarAvailabilityEvidence;
}

export type PortableSidecarAvailabilityReason =
  | "platform-unsupported"
  | "redistribution-unapproved"
  | "payload-missing"
  | "archive-digest-mismatch"
  | "executable-tree-digest-mismatch"
  | "runtime-version-mismatch"
  | "protocol-schema-mismatch"
  | "signature-unverified"
  | "qualification-missing";

export interface PortableSidecarAvailabilityEvidence {
  readonly redistributionApproved: boolean;
  readonly payloadPresent: boolean;
  readonly archiveDigestVerified: boolean;
  readonly executableTreeDigestVerified: boolean;
  readonly runtimeVersionVerified: boolean;
  readonly protocolSchemaVerified: boolean;
  readonly signatureVerified: boolean;
  readonly qualificationVerified: boolean;
}

export interface PortableSidecarAvailabilityInput {
  readonly target: UpdatePortableTarget;
  readonly redistributionApproved?: boolean | undefined;
  readonly payloadPresent?: boolean | undefined;
  readonly archiveDigestVerified?: boolean | undefined;
  readonly executableTreeDigestVerified?: boolean | undefined;
  readonly runtimeVersionVerified?: boolean | undefined;
  readonly protocolSchemaVerified?: boolean | undefined;
  readonly signatureVerified?: boolean | undefined;
  readonly qualificationVerified?: boolean | undefined;
}

export type PortableSidecarAvailability =
  | { readonly available: true }
  | { readonly available: false; readonly reason: PortableSidecarAvailabilityReason };

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
const OPENCODE_VERSION = "1.17.17";
const OPENCODE_COMMIT = "474abdd7ee60f4b67476cfcef7e5311beff4a824";
const OPENCODE_SCHEMA_SHA256 = "7db5cc3bb494b4757655110f2f285b1e70fa586fb5ae2327ffb31d4f0254c7de";
const SIGNING_KEYS = [
  "notarizationRequired",
  "notarizationVerified",
  "shippedExecutableSha256",
  "shippedExecutableTreeAlgorithm",
  "shippedExecutableTreeSha256",
  "signatureKind",
  "signatureVerified",
  "verificationChecks",
  "verificationPolicy",
  "verificationReasonCodes",
  "verificationStatus",
] as const;

/**
 * Evaluates the closed pre-spawn order from #2253. Missing evidence is always false: callers
 * cannot convert an absent portable proof into a global-install fallback.
 */
export function evaluatePortableSidecarAvailability(
  sidecar: PortableSidecarRuntimeVerification,
  input: PortableSidecarAvailabilityInput,
): PortableSidecarAvailability {
  const evidence = sidecar.availability;
  if (sidecar.summary.platformTarget !== input.target) return unavailable("platform-unsupported");
  const failed = availabilityChecks(evidence, input).find((check) => !check.verified);
  return failed === undefined ? { available: true } : unavailable(failed.reason);
}

function availabilityChecks(
  evidence: PortableSidecarAvailabilityEvidence,
  input: PortableSidecarAvailabilityInput,
): readonly {
  readonly reason: Exclude<PortableSidecarAvailabilityReason, "platform-unsupported">;
  readonly verified: boolean;
}[] {
  return [
    {
      reason: "redistribution-unapproved",
      verified: remainsVerified(evidence.redistributionApproved, input.redistributionApproved),
    },
    {
      reason: "payload-missing",
      verified: remainsVerified(evidence.payloadPresent, input.payloadPresent),
    },
    {
      reason: "archive-digest-mismatch",
      verified: remainsVerified(evidence.archiveDigestVerified, input.archiveDigestVerified),
    },
    {
      reason: "executable-tree-digest-mismatch",
      verified: remainsVerified(
        evidence.executableTreeDigestVerified,
        input.executableTreeDigestVerified,
      ),
    },
    {
      reason: "runtime-version-mismatch",
      verified: remainsVerified(evidence.runtimeVersionVerified, input.runtimeVersionVerified),
    },
    {
      reason: "protocol-schema-mismatch",
      verified: remainsVerified(evidence.protocolSchemaVerified, input.protocolSchemaVerified),
    },
    {
      reason: "signature-unverified",
      verified: remainsVerified(evidence.signatureVerified, input.signatureVerified),
    },
    {
      reason: "qualification-missing",
      verified: remainsVerified(evidence.qualificationVerified, input.qualificationVerified),
    },
  ];
}

function remainsVerified(stored: boolean, requested: boolean | undefined): boolean {
  return stored && requested !== false;
}

function unavailable(reason: PortableSidecarAvailabilityReason): PortableSidecarAvailability {
  return { available: false, reason };
}

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
  if (signing === undefined) return false;
  if (!signingKeysExact(signing)) return false;
  const checks = recordAt(signing, "verificationChecks");
  const macos = target !== "windows-x64";
  return (
    fieldEquals(signing, "verificationPolicy", "production") &&
    fieldEquals(signing, "verificationStatus", "verified-production") &&
    fieldEquals(signing, "signatureKind", signatureKind(target)) &&
    fieldEquals(signing, "signatureVerified", true) &&
    fieldEquals(signing, "notarizationRequired", macos) &&
    fieldEquals(signing, "notarizationVerified", macos) &&
    shippedExecutableEvidenceVerified(signing) &&
    targetChecksVerified(target, checks)
  );
}

function signingKeysExact(signing: Record<string, unknown> | undefined): boolean {
  return (
    signing !== undefined &&
    JSON.stringify(Object.keys(signing).sort()) === JSON.stringify(SIGNING_KEYS)
  );
}

function shippedExecutableEvidenceVerified(signing: Record<string, unknown>): boolean {
  return (
    digestFieldRequired(signing, "shippedExecutableSha256") !== undefined &&
    fieldEquals(signing, "shippedExecutableTreeAlgorithm", "keiko-directory-tree-sha256-v1") &&
    digestFieldRequired(signing, "shippedExecutableTreeSha256") !== undefined
  );
}

function portableProvenanceVerified(
  runtime: Record<string, unknown>,
  target: UpdatePortableTarget,
): boolean {
  const upstream = recordAt(runtime, "upstream");
  const adapter = recordAt(runtime, "adapterCompatibility");
  const schema = recordAt(runtime, "protocolSchema");
  const approval = recordAt(recordAt(runtime, "releaseApproval"), "redistribution");
  const archive = recordAt(runtime, "archive");
  return [
    runtime.approvalSchemaVersion === 2,
    runtime.kind === "coding-runtime",
    fieldEquals(upstream, "owner", "anomalyco"),
    fieldEquals(upstream, "repository", "opencode"),
    fieldEquals(upstream, "name", "opencode"),
    fieldEquals(upstream, "version", OPENCODE_VERSION),
    fieldEquals(upstream, "tag", `v${OPENCODE_VERSION}`),
    fieldEquals(upstream, "commit", OPENCODE_COMMIT),
    fieldEquals(adapter, "adapterName", "keiko-coding-sidecar"),
    fieldEquals(adapter, "adapterVersion", "1"),
    fieldEquals(adapter, "transport", "http-sse"),
    fieldEquals(schema, "path", "packages/sdk/openapi.json"),
    fieldEquals(schema, "sha256", OPENCODE_SCHEMA_SHA256),
    fieldEquals(schema, "hashAlgorithm", "sha256"),
    fieldEquals(schema, "hashEncoding", "lowercase-hex"),
    fieldEquals(schema, "digestInput", "upstream-raw-bytes"),
    fieldEquals(schema, "transport", "http-sse"),
    fieldEquals(approval, "status", "approved"),
    fieldEquals(runtime, "executableTreeAlgorithm", "keiko-directory-tree-sha256-v1"),
    digestField(runtime, "executableTreeSha256") !== undefined,
    fieldEquals(archive, "platformTarget", target),
    digestField(archive, "sha256") !== undefined,
  ].every(Boolean);
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
  const protocolVersion = stringField(adapter, "transport");
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
  if (!portableProvenanceVerified(runtime, target)) {
    fail("sidecar-metadata-malformed", "sidecar portable provenance is incomplete");
  }
  const executableTreeSha256 = digestField(runtime, "executableTreeSha256");
  if (executableTreeSha256 === undefined) {
    fail("sidecar-metadata-malformed", "sidecar executable tree digest is invalid");
  }
  const evidence = requiredRuntimeEvidence(runtime, payload.payloadRootPath);
  const signing = recordAt(runtime, "signing");
  if (signing === undefined) {
    fail("sidecar-signing-unverified", "sidecar signing evidence is not verified");
  }
  if (!signingVerified(signing, target)) {
    fail("sidecar-signing-unverified", "sidecar signing evidence is not verified");
  }
  const shippedExecutableTreeSha256 = digestFieldRequired(signing, "shippedExecutableTreeSha256");
  if (shippedExecutableTreeSha256 === undefined) {
    fail("sidecar-metadata-malformed", "sidecar shipped executable tree digest is invalid");
  }
  const summary = baseSummary(runtime, target, payload.payloadSha256, payload.sizeBytes);
  if (summary === undefined) fail("sidecar-metadata-malformed", "sidecar metadata is incomplete");
  return {
    summary,
    payloadRootPath: payload.payloadRootPath,
    executablePath: payload.executablePath,
    executableTreeSha256: shippedExecutableTreeSha256,
    licenseEvidencePath: evidence.license.path,
    licenseEvidenceSha256: evidence.license.sha256,
    sbomEvidencePath: evidence.sbom.path,
    sbomEvidenceSha256: evidence.sbom.sha256,
    availability: {
      redistributionApproved: true,
      payloadPresent: true,
      archiveDigestVerified: true,
      executableTreeDigestVerified: true,
      runtimeVersionVerified: true,
      protocolSchemaVerified: true,
      signatureVerified: true,
      qualificationVerified: true,
    },
  };
}

function requiredRuntimeEvidence(
  runtime: Record<string, unknown>,
  payloadRootPath: string,
): {
  readonly license: { readonly path: string; readonly sha256: string };
  readonly sbom: { readonly path: string; readonly sha256: string };
} {
  return {
    license: requiredEvidence(
      runtime,
      "licenseEvidence",
      payloadRootPath,
      "sidecar-license-evidence-incomplete",
      "sidecar license evidence is incomplete",
    ),
    sbom: requiredEvidence(
      runtime,
      "sbomEvidence",
      payloadRootPath,
      "sidecar-sbom-evidence-incomplete",
      "sidecar SBOM is incomplete",
    ),
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
