import { createHash } from "node:crypto";
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path";

export const PORTABLE_MANIFEST_SCHEMA_VERSION = 1;

// Shared bounds for the platform-specific bounded payload-tree walkers (Windows PE and macOS
// Mach-O inventory). Kept in one place so the two walkers cannot drift to different limits.
export const PORTABLE_PAYLOAD_MAX_FILES = 50_000;
export const PORTABLE_PAYLOAD_MAX_DEPTH = 32;

export function portablePayloadRelativePath(root, path) {
  return relative(root, path).replaceAll("\\", "/");
}

export const PORTABLE_TARGETS = Object.freeze([
  Object.freeze({
    assetName: "keiko-windows-x64.zip",
    nodeArchiveExtension: "zip",
    nodeArchiveTarget: "win-x64",
    nodeArchitecture: "x64",
    nodePlatform: "win32",
    platformTarget: "windows-x64",
    primaryLauncher: "Keiko.exe",
    runtimeTarget: "win32-x64",
    signatureKind: "authenticode",
  }),
  Object.freeze({
    assetName: "keiko-macos-arm64.zip",
    nodeArchiveExtension: "tar.gz",
    nodeArchiveTarget: "darwin-arm64",
    nodeArchitecture: "arm64",
    nodePlatform: "darwin",
    platformTarget: "macos-arm64",
    primaryLauncher: "Keiko.app",
    runtimeTarget: "darwin-arm64",
    signatureKind: "developer-id-notarized",
  }),
  Object.freeze({
    assetName: "keiko-macos-x64.zip",
    nodeArchiveExtension: "tar.gz",
    nodeArchiveTarget: "darwin-x64",
    nodeArchitecture: "x64",
    nodePlatform: "darwin",
    platformTarget: "macos-x64",
    primaryLauncher: "Keiko.app",
    runtimeTarget: "darwin-x64",
    signatureKind: "developer-id-notarized",
  }),
]);

export const PORTABLE_TARGET_NAMES = Object.freeze(
  PORTABLE_TARGETS.map((target) => target.platformTarget),
);
export const PORTABLE_VERIFICATION_POLICIES = Object.freeze([
  "staging",
  "development",
  "pull-request",
  "production",
]);
export const PORTABLE_VERIFICATION_STATUSES = Object.freeze([
  "unverified-staging",
  "unsigned-non-production",
  "verified-non-production",
  "verified-production",
  "verification-failed",
]);
export const PORTABLE_MANIFEST_VALIDATION_CONTEXTS = Object.freeze([
  "staging",
  "non-production",
  "candidate",
  "published",
  "published-contract",
]);
export const PORTABLE_VERIFICATION_REASON_CODES = Object.freeze([
  "credential-unavailable",
  "macos-assessment-unverified",
  "macos-developer-id-unverified",
  "macos-notarization-unverified",
  "macos-staple-unverified",
  "non-production-artifact",
  "non-production-unsigned-allowed",
  "staging-unverified",
  "verification-input-missing",
  "verification-tool-unavailable",
  "windows-publisher-chain-unverified",
  "windows-timestamp-unverified",
]);

const SECRET_PATTERN =
  /(?:sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{82}|npm_[A-Za-z0-9]{36}|BEGIN [A-Z ]*PRIVATE KEY|password=|token=)/iu;
const CREDENTIAL_VALUE_PATTERN =
  /(?:(?<![A-Za-z0-9_])(?:proxy[-_ ]authorization|authorization)\s*:\s*|(?<![A-Za-z0-9_])(?:proxy[-_ ]authorization|authorization|auth)\s*=\s*)(?:bearer|basic)\s+\S+/iu;
const CREDENTIAL_URL_PATTERN = /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/u;
const PRIVATE_PATH_PATTERN =
  /(?:^|[\s"'`])(?:\/Users\/|\/home\/|\/private\/|\/var\/folders\/|[A-Za-z]:\\Users\\|\\\\[^\\]+\\[^\\]+)/u;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const PLACEHOLDER_DIGEST_PATTERN = /^64-hex-[a-z0-9-]+$/u;
const COMMIT_PATTERN = /^[a-f0-9]{40}$|^40-hex-[a-z0-9-]+$/u;
const STRICT_COMMIT_PATTERN = /^[a-f0-9]{40}$/u;
const SIDECAR_RUNTIME_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/u;
const EXECUTABLE_TREE_ALGORITHM = "keiko-directory-tree-sha256-v1";
const GITHUB_REVIEW_REFERENCE_PATTERN =
  /^https:\/\/github\.com\/oscharko-dev\/Keiko\/(?:issues|pull)\/\d+$/u;
const SIDECAR_RUNTIME_KEYS = Object.freeze([
  "approvalSchemaVersion",
  "name",
  "kind",
  "upstream",
  "adapterCompatibility",
  "protocolSchema",
  "releaseApproval",
  "license",
  "archive",
  "executableTreeAlgorithm",
  "executableTreeSha256",
  "executableSha256",
  "platformTarget",
  "payloadRootPath",
  "executablePath",
  "payloadSha256",
  "sizeBytes",
  "licenseEvidence",
  "sbomEvidence",
  "signing",
]);
const FORBIDDEN_KEY_PARTS = [
  "absolutePath",
  "credentialValue",
  "evidenceBody",
  "modelOutput",
  "packageManagerOutput",
  "privatePath",
  "promptBody",
  "rawLog",
  "rawLogs",
  "rawOutput",
  "rawStderr",
  "rawStdout",
  "responseBody",
  "secretValue",
  "tokenValue",
];
const CREDENTIAL_METADATA_KEYS = new Set([
  "password",
  "passwd",
  "secret",
  "token",
  "accesstoken",
  "apikey",
  "authorization",
  "auth",
  "credential",
  "privatekey",
  "clientsecret",
]);
const CREDENTIAL_METADATA_WORDS = new Set([
  "password",
  "passwd",
  "secret",
  "token",
  "authorization",
  "credential",
]);
const NORMALIZED_COMPOUND_CREDENTIAL_KEY_PATTERN =
  /^(?:api|auth|refresh|access|client|proxy|private)(?:token|password|passwd|secret|authorization|credential|key)$/u;
const FORBIDDEN_PATH_PARTS = [
  ".env",
  ".keiko",
  "capsules.db",
  "keiko-ui.db",
  "keiko.config.json",
  "local-knowledge",
  "memory.db",
  "provider-credentials.vault",
];

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function usesZeroReleaseIdentity(options) {
  return new Set(["staging", "non-production", "candidate"]).has(options.context);
}

function requiresProductionVerification(options) {
  return !new Set(["staging", "non-production"]).has(options.context);
}

function push(failures, path, message) {
  failures.push(`${path}: ${message}`);
}

function at(record, key, path, failures) {
  const value = record?.[key];
  if (value === undefined) push(failures, `${path}.${key}`, "is required");
  return value;
}

function recordAt(record, key, path, failures) {
  const value = at(record, key, path, failures);
  if (!isRecord(value)) push(failures, `${path}.${key}`, "must be an object");
  return isRecord(value) ? value : {};
}

function stringAt(record, key, path, failures) {
  const value = at(record, key, path, failures);
  if (typeof value !== "string" || value.length === 0) {
    push(failures, `${path}.${key}`, "must be a non-empty string");
  }
  return typeof value === "string" ? value : "";
}

function numberAt(record, key, path, failures) {
  const value = at(record, key, path, failures);
  if (!Number.isSafeInteger(value) || value < 0) {
    push(failures, `${path}.${key}`, "must be a non-negative safe integer");
  }
  return Number.isSafeInteger(value) ? value : 0;
}

function positiveNumberAt(record, key, path, failures) {
  const value = numberAt(record, key, path, failures);
  if (value === 0) push(failures, `${path}.${key}`, "must be greater than 0");
  return value;
}

function booleanAt(record, key, path, failures) {
  const value = at(record, key, path, failures);
  if (typeof value !== "boolean") push(failures, `${path}.${key}`, "must be a boolean");
  return value === true;
}

function digestAt(record, key, path, failures, options) {
  const value = stringAt(record, key, path, failures);
  if (
    !DIGEST_PATTERN.test(value) &&
    !(options.allowPlaceholders && PLACEHOLDER_DIGEST_PATTERN.test(value))
  ) {
    push(failures, `${path}.${key}`, "must be a SHA-256 digest");
  }
  return value;
}

function stringArrayAt(record, key, path, failures) {
  const value = at(record, key, path, failures);
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string" || entry.length === 0)
  ) {
    push(failures, `${path}.${key}`, "must be a string array");
    return [];
  }
  return value;
}

function exactKeysAt(record, allowedKeys, path, failures) {
  for (const key of Object.keys(record)) {
    if (!allowedKeys.includes(key)) push(failures, `${path}.${key}`, "is not allowed");
  }
}

function literalAt(record, key, expected, path, failures) {
  const value = at(record, key, path, failures);
  if (value !== expected) push(failures, `${path}.${key}`, `must be ${String(expected)}`);
  return value;
}

export function portableTargetByName(platformTarget) {
  return PORTABLE_TARGETS.find((target) => target.platformTarget === platformTarget);
}

function verificationCheckTemplate(target, verified) {
  if (target.nodePlatform === "win32") {
    return {
      publisherChainVerified: verified,
      timestampVerified: verified,
    };
  }
  return {
    developerIdVerified: verified,
    notarizationVerified: verified,
    stapleVerified: verified,
    assessmentVerified: verified,
  };
}

export function createPortableVerificationChecks(platformTarget, verified = false) {
  const target = portableTargetByName(platformTarget);
  if (target === undefined) throw new Error(`unsupported portable target: ${platformTarget}`);
  return verificationCheckTemplate(target, verified);
}

function verificationCheckKeys(target) {
  return target?.nodePlatform === "win32"
    ? ["publisherChainVerified", "timestampVerified"]
    : ["developerIdVerified", "notarizationVerified", "stapleVerified", "assessmentVerified"];
}

function forbiddenVerificationCheckKeys(target) {
  return target?.nodePlatform === "win32"
    ? ["developerIdVerified", "notarizationVerified", "stapleVerified", "assessmentVerified"]
    : ["publisherChainVerified", "timestampVerified"];
}

function validateProduct(manifest, failures) {
  const product = recordAt(manifest, "product", "manifest", failures);
  if (stringAt(product, "packageName", "product", failures) !== "@oscharko-dev/keiko") {
    push(failures, "product.packageName", "must be @oscharko-dev/keiko");
  }
  stringAt(product, "name", "product", failures);
  stringAt(product, "packageVersion", "product", failures);
}

function validateRelease(manifest, failures, options) {
  const release = recordAt(manifest, "release", "manifest", failures);
  const releaseId = numberAt(release, "releaseId", "release", failures);
  validateReleaseIdentity(releaseId, failures, options);
  stringAt(release, "releaseTag", "release", failures);
  if (!booleanAt(release, "stable", "release", failures)) {
    push(failures, "release.stable", "must be true for portable v1");
  }
  const commitSha = stringAt(release, "commitSha", "release", failures);
  if (!COMMIT_PATTERN.test(commitSha)) push(failures, "release.commitSha", "must be a commit SHA");
}

function validateReleaseIdentity(releaseId, failures, options) {
  if (usesZeroReleaseIdentity(options)) {
    if (releaseId !== 0)
      push(failures, "release.releaseId", "must be 0 before GitHub Release upload");
    return;
  }
  if (releaseId === 0) push(failures, "release.releaseId", "must be greater than 0");
  if (options.apiIdentity !== undefined && releaseId !== options.apiIdentity.releaseId) {
    push(failures, "release.releaseId", "does not match the GitHub API snapshot");
  }
}

function validateArtifact(manifest, failures, options) {
  const artifact = recordAt(manifest, "artifact", "manifest", failures);
  const targetName = stringAt(artifact, "platformTarget", "artifact", failures);
  const target = portableTargetByName(targetName);
  if (target === undefined) push(failures, "artifact.platformTarget", "is unsupported");
  const assetId = numberAt(artifact, "assetId", "artifact", failures);
  validateAssetIdentity(assetId, failures, options);
  if (numberAt(artifact, "sizeBytes", "artifact", failures) === 0) {
    push(failures, "artifact.sizeBytes", "must be greater than 0");
  }
  digestAt(artifact, "sha256", "artifact", failures, options);
  if (stringAt(artifact, "archiveFormat", "artifact", failures) !== "zip") {
    push(failures, "artifact.archiveFormat", "must be zip");
  }
  if (
    target !== undefined &&
    stringAt(artifact, "assetName", "artifact", failures) !== target.assetName
  ) {
    push(failures, "artifact.assetName", `must be ${target.assetName}`);
  }
}

function validateAssetIdentity(assetId, failures, options) {
  if (usesZeroReleaseIdentity(options)) {
    if (assetId !== 0) push(failures, "artifact.assetId", "must be 0 before GitHub Release upload");
    return;
  }
  if (assetId === 0) push(failures, "artifact.assetId", "must be greater than 0");
  if (options.apiIdentity !== undefined && assetId !== options.apiIdentity.assetId) {
    push(failures, "artifact.assetId", "does not match the GitHub API snapshot");
  }
}

function validateProvenance(manifest, failures, options) {
  const provenance = recordAt(manifest, "provenance", "manifest", failures);
  const commitSha = stringAt(provenance, "sourceCommitSha", "provenance", failures);
  if (!COMMIT_PATTERN.test(commitSha))
    push(failures, "provenance.sourceCommitSha", "must be a commit SHA");
  stringAt(provenance, "rootPackageVersion", "provenance", failures);
  digestAt(provenance, "rootPackageTarballSha256", "provenance", failures, options);
  digestAt(provenance, "packagedAppTreeSha256", "provenance", failures, options);
  const runId = numberAt(provenance, "buildWorkflowRunId", "provenance", failures);
  const runAttempt = numberAt(provenance, "buildWorkflowAttempt", "provenance", failures);
  if (requiresProductionVerification(options) && runId === 0) {
    push(failures, "provenance.buildWorkflowRunId", "must be greater than 0");
  }
  if (requiresProductionVerification(options) && runAttempt === 0) {
    push(failures, "provenance.buildWorkflowAttempt", "must be greater than 0");
  }
  relativePathAt(provenance, "provenanceStatementPath", "provenance", failures);
  digestAt(provenance, "provenanceStatementSha256", "provenance", failures, options);
}

function validateRuntime(manifest, failures, options) {
  const runtime = recordAt(manifest, "runtime", "manifest", failures);
  const target = portableTargetByName(manifest.artifact?.platformTarget);
  stringAt(runtime, "nodeVersion", "runtime", failures);
  stringAt(runtime, "nodeDistribution", "runtime", failures);
  digestAt(runtime, "nodeArchiveSha256", "runtime", failures, options);
  if (
    target !== undefined &&
    stringAt(runtime, "nodePlatform", "runtime", failures) !== target.nodePlatform
  ) {
    push(failures, "runtime.nodePlatform", `must be ${target.nodePlatform}`);
  }
  if (
    target !== undefined &&
    stringAt(runtime, "nodeArchitecture", "runtime", failures) !== target.nodeArchitecture
  ) {
    push(failures, "runtime.nodeArchitecture", `must be ${target.nodeArchitecture}`);
  }
}

function validateSidecarRuntimes(manifest, failures, options) {
  const sidecars = manifest.sidecarRuntimes;
  if (sidecars === undefined) return;
  if (!Array.isArray(sidecars)) {
    push(failures, "sidecarRuntimes", "must be an array when present");
    return;
  }
  const names = new Set();
  sidecars.forEach((runtime, index) =>
    validateSidecarRuntime(manifest, runtime, index, names, failures, options),
  );
}

function validateSidecarRuntime(manifest, runtime, index, names, failures, options) {
  const path = `sidecarRuntimes[${String(index)}]`;
  if (!isRecord(runtime)) {
    push(failures, path, "must be an object");
    return;
  }
  const name = validateSidecarProvenance(runtime, path, names, failures, options);
  const target = validateSidecarPayload(manifest, runtime, name, path, failures, options);
  validateSidecarSigning(runtime, target, path, failures, options);
}

function validateSidecarProvenance(runtime, path, names, failures, options) {
  exactKeysAt(runtime, SIDECAR_RUNTIME_KEYS, path, failures);
  literalAt(runtime, "approvalSchemaVersion", 2, path, failures);
  const name = validateSidecarName(runtime, path, names, failures);
  if (stringAt(runtime, "kind", path, failures) !== "coding-runtime") {
    push(failures, `${path}.kind`, "must be coding-runtime");
  }
  validateSidecarUpstream(runtime, path, failures);
  validateSidecarAdapter(runtime, path, failures);
  validateSidecarProtocolSchema(runtime, path, failures, options);
  validateSidecarReleaseApproval(runtime, path, failures);
  validateSidecarLicense(runtime, path, failures, options);
  validateSidecarArchive(runtime, path, failures, options);
  validateSidecarExecutableProvenance(runtime, path, failures, options);
  return name;
}

function validateSidecarExecutableProvenance(runtime, path, failures, options) {
  if (stringAt(runtime, "executableTreeAlgorithm", path, failures) !== EXECUTABLE_TREE_ALGORITHM) {
    push(failures, `${path}.executableTreeAlgorithm`, `must be ${EXECUTABLE_TREE_ALGORITHM}`);
  }
  digestAt(runtime, "executableTreeSha256", path, failures, options);
  digestAt(runtime, "executableSha256", path, failures, options);
}

function validateSidecarPayload(manifest, runtime, name, path, failures, options) {
  const target = validateSidecarTarget(manifest, runtime, path, failures);
  const payloadRootPath = validateSidecarPayloadRoot(runtime, name, path, failures);
  validateSidecarPath(runtime, "executablePath", payloadRootPath, path, failures);
  digestAt(runtime, "payloadSha256", path, failures, options);
  positiveNumberAt(runtime, "sizeBytes", path, failures);
  const licenseEvidence = validateSidecarEvidence(
    runtime,
    "licenseEvidence",
    payloadRootPath,
    path,
    failures,
    options,
  );
  if (licenseEvidence.sha256 !== runtime.license?.sha256) {
    push(failures, `${path}.licenseEvidence.sha256`, "must match approved license digest");
  }
  validateSidecarEvidence(runtime, "sbomEvidence", payloadRootPath, path, failures, options);
  return target;
}

function validateSidecarName(runtime, path, names, failures) {
  const name = stringAt(runtime, "name", path, failures);
  if (!SIDECAR_RUNTIME_NAME_PATTERN.test(name)) {
    push(failures, `${path}.name`, "must be a stable kebab-case runtime name");
  }
  if (names.has(name)) push(failures, `${path}.name`, "must be unique");
  names.add(name);
  return name;
}

function validateSidecarUpstream(runtime, path, failures) {
  const upstream = recordAt(runtime, "upstream", path, failures);
  exactKeysAt(
    upstream,
    ["owner", "repository", "name", "version", "tag", "commit"],
    `${path}.upstream`,
    failures,
  );
  stringAt(upstream, "owner", `${path}.upstream`, failures);
  stringAt(upstream, "repository", `${path}.upstream`, failures);
  stringAt(upstream, "name", `${path}.upstream`, failures);
  stringAt(upstream, "version", `${path}.upstream`, failures);
  stringAt(upstream, "tag", `${path}.upstream`, failures);
  const commit = stringAt(upstream, "commit", `${path}.upstream`, failures);
  if (!STRICT_COMMIT_PATTERN.test(commit)) {
    push(failures, `${path}.upstream.commit`, "must be a 40-hex commit SHA");
  }
}

function validateSidecarAdapter(runtime, path, failures) {
  const adapter = recordAt(runtime, "adapterCompatibility", path, failures);
  exactKeysAt(
    adapter,
    ["adapterName", "adapterVersion", "transport"],
    `${path}.adapterCompatibility`,
    failures,
  );
  literalAt(
    adapter,
    "adapterName",
    "keiko-coding-sidecar",
    `${path}.adapterCompatibility`,
    failures,
  );
  literalAt(adapter, "adapterVersion", "1", `${path}.adapterCompatibility`, failures);
  literalAt(adapter, "transport", "http-sse", `${path}.adapterCompatibility`, failures);
}

function validateSidecarProtocolSchema(runtime, path, failures, options) {
  const schemaPath = `${path}.protocolSchema`;
  const schema = recordAt(runtime, "protocolSchema", path, failures);
  exactKeysAt(
    schema,
    ["path", "url", "sha256", "hashAlgorithm", "hashEncoding", "digestInput", "transport"],
    schemaPath,
    failures,
  );
  const upstream = runtime.upstream ?? {};
  const rawPath = relativePathAt(schema, "path", schemaPath, failures);
  const expectedUrl = `https://raw.githubusercontent.com/${upstream.owner}/${upstream.repository}/${upstream.commit}/${rawPath}`;
  if (stringAt(schema, "url", schemaPath, failures) !== expectedUrl) {
    push(failures, `${schemaPath}.url`, "must bind the upstream commit and raw schema path");
  }
  digestAt(schema, "sha256", schemaPath, failures, options);
  literalAt(schema, "hashAlgorithm", "sha256", schemaPath, failures);
  literalAt(schema, "hashEncoding", "lowercase-hex", schemaPath, failures);
  literalAt(schema, "digestInput", "upstream-raw-bytes", schemaPath, failures);
  literalAt(schema, "transport", "http-sse", schemaPath, failures);
  if (schema.transport !== runtime.adapterCompatibility?.transport) {
    push(failures, `${schemaPath}.transport`, "must match adapterCompatibility.transport");
  }
}

function validateSidecarReleaseApproval(runtime, path, failures) {
  const approvalPath = `${path}.releaseApproval`;
  const approval = recordAt(runtime, "releaseApproval", path, failures);
  exactKeysAt(approval, ["redistribution", "subscriptionAuth"], approvalPath, failures);
  validateSidecarApprovalGate(approval, "redistribution", "approved", approvalPath, failures);
  validateSidecarApprovalGate(
    approval,
    "subscriptionAuth",
    "not-applicable",
    approvalPath,
    failures,
  );
}

function validateSidecarApprovalGate(approval, key, expectedStatus, path, failures) {
  const gatePath = `${path}.${key}`;
  const gate = recordAt(approval, key, path, failures);
  exactKeysAt(gate, ["status", "reviewReference"], gatePath, failures);
  literalAt(gate, "status", expectedStatus, gatePath, failures);
  const reference = stringAt(gate, "reviewReference", gatePath, failures);
  if (!GITHUB_REVIEW_REFERENCE_PATTERN.test(reference)) {
    push(failures, `${gatePath}.reviewReference`, "must reference a Keiko issue or pull request");
  }
}

function validateSidecarLicense(runtime, path, failures, options) {
  const licensePath = `${path}.license`;
  const license = recordAt(runtime, "license", path, failures);
  exactKeysAt(license, ["spdxId", "url", "sha256"], licensePath, failures);
  stringAt(license, "spdxId", licensePath, failures);
  const url = stringAt(license, "url", licensePath, failures);
  const upstream = runtime.upstream ?? {};
  const expectedPrefix = `https://raw.githubusercontent.com/${upstream.owner}/${upstream.repository}/${upstream.commit}/`;
  if (!url.startsWith(expectedPrefix)) {
    push(failures, `${licensePath}.url`, "must bind the upstream commit");
  }
  digestAt(license, "sha256", licensePath, failures, options);
}

function validateSidecarArchive(runtime, path, failures, options) {
  const archivePath = `${path}.archive`;
  const archive = recordAt(runtime, "archive", path, failures);
  exactKeysAt(archive, ["platformTarget", "url", "sizeBytes", "sha256"], archivePath, failures);
  if (stringAt(archive, "platformTarget", archivePath, failures) !== runtime.platformTarget) {
    push(failures, `${archivePath}.platformTarget`, "must match sidecar platformTarget");
  }
  const url = stringAt(archive, "url", archivePath, failures);
  const upstream = runtime.upstream ?? {};
  const expectedPrefix = `https://github.com/${upstream.owner}/${upstream.repository}/releases/download/${upstream.tag}/`;
  if (!url.startsWith(expectedPrefix)) {
    push(failures, `${archivePath}.url`, "must bind the upstream repository and tag");
  }
  positiveNumberAt(archive, "sizeBytes", archivePath, failures);
  digestAt(archive, "sha256", archivePath, failures, options);
}

function validateSidecarTarget(manifest, runtime, path, failures) {
  const targetName = stringAt(runtime, "platformTarget", path, failures);
  const target = portableTargetByName(targetName);
  if (target === undefined) push(failures, `${path}.platformTarget`, "is unsupported");
  if (targetName !== manifest.artifact?.platformTarget) {
    push(failures, `${path}.platformTarget`, "must match artifact.platformTarget");
  }
  return target;
}

function validateSidecarPayloadRoot(runtime, name, path, failures) {
  const payloadRootPath = relativePathAt(runtime, "payloadRootPath", path, failures);
  const expected = `runtime/sidecars/${name}`;
  if (payloadRootPath !== expected)
    push(failures, `${path}.payloadRootPath`, `must be ${expected}`);
  return payloadRootPath;
}

function validateSidecarPath(runtime, key, payloadRootPath, path, failures) {
  const value = relativePathAt(runtime, key, path, failures);
  if (!portablePathInside(payloadRootPath, value) || value === payloadRootPath) {
    push(failures, `${path}.${key}`, "must stay inside payloadRootPath");
  }
  return value;
}

function validateSidecarEvidence(runtime, key, payloadRootPath, path, failures, options) {
  const evidence = recordAt(runtime, key, path, failures);
  const evidencePath = relativePathAt(evidence, "path", `${path}.${key}`, failures);
  if (!portablePathInside(payloadRootPath, evidencePath)) {
    push(failures, `${path}.${key}.path`, "must stay inside payloadRootPath");
  }
  digestAt(evidence, "sha256", `${path}.${key}`, failures, options);
  return evidence;
}

function portablePathInside(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}/`);
}

function validatePackageSurface(manifest, failures) {
  const surface = recordAt(manifest, "packageSurface", "manifest", failures);
  if (stringAt(surface, "source", "packageSurface", failures) !== "root-npm-package-surface") {
    push(failures, "packageSurface.source", "must be root-npm-package-surface");
  }
  for (const key of ["packageSurfaceGate", "publishManifestGate", "workspaceSupplyChainGate"]) {
    stringAt(surface, key, "packageSurface", failures);
  }
}

function relativePathAt(record, key, path, failures) {
  const value = stringAt(record, key, path, failures);
  if (!isSafePortableRelativePath(value)) {
    push(failures, `${path}.${key}`, "must be a relative contained path");
  }
  return value;
}

export function isSafePortableRelativePath(value) {
  if (value.length === 0) return false;
  if (CREDENTIAL_URL_PATTERN.test(value) || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value)) return false;
  if (value.startsWith("/") || value.startsWith("\\\\") || value.startsWith("//")) return false;
  if (/^[A-Za-z]:/u.test(value)) return false;
  const parts = value.replaceAll("\\", "/").split("/");
  return parts.every((part) => part !== "" && part !== "." && part !== "..");
}

function validateEntrypoints(manifest, failures) {
  const entrypoints = recordAt(manifest, "entrypoints", "manifest", failures);
  const target = portableTargetByName(manifest.artifact?.platformTarget);
  const launcher = stringAt(entrypoints, "primaryLauncher", "entrypoints", failures);
  if (target !== undefined && launcher !== target.primaryLauncher) {
    push(failures, "entrypoints.primaryLauncher", `must be ${target.primaryLauncher}`);
  }
  const support = entrypoints.supportLaunchers;
  if (
    support !== undefined &&
    (!Array.isArray(support) || support.some((item) => typeof item !== "string"))
  ) {
    push(failures, "entrypoints.supportLaunchers", "must be a string array when present");
  }
}

function validateInstallLayout(manifest, failures) {
  const layout = recordAt(manifest, "installLayout", "manifest", failures);
  if (stringAt(layout, "installMode", "installLayout", failures) !== "portable-managed") {
    push(failures, "installLayout.installMode", "must be portable-managed");
  }
  if (booleanAt(layout, "bootstrapUpdateEligible", "installLayout", failures)) {
    push(failures, "installLayout.bootstrapUpdateEligible", "must be false");
  }
  stringAt(layout, "managedRootKind", "installLayout", failures);
  booleanAt(layout, "sameVolumeStagingRequired", "installLayout", failures);
  stringAt(layout, "stateRootPolicy", "installLayout", failures);
}

function validateStateExclusion(manifest, failures) {
  const state = recordAt(manifest, "stateExclusion", "manifest", failures);
  for (const key of [
    "excludesDotKeiko",
    "excludesCustomerData",
    "excludesSecrets",
    "excludesRawLogs",
    "excludesRepositories",
  ]) {
    if (!booleanAt(state, key, "stateExclusion", failures))
      push(failures, `stateExclusion.${key}`, "must be true");
  }
}

function validateSecurity(manifest, failures, options) {
  const security = recordAt(manifest, "security", "manifest", failures);
  const target = portableTargetByName(manifest.artifact?.platformTarget);
  const policy = stringAt(security, "verificationPolicy", "security", failures);
  const status = stringAt(security, "verificationStatus", "security", failures);
  const reasonCodes = stringArrayAt(security, "verificationReasonCodes", "security", failures);
  const signatureKind = stringAt(security, "signatureKind", "security", failures);
  const signatureVerified = booleanAt(security, "signatureVerified", "security", failures);
  const notarizationRequired = booleanAt(security, "notarizationRequired", "security", failures);
  const notarizationVerified = booleanAt(security, "notarizationVerified", "security", failures);
  const verificationChecks = validateVerificationChecks(security, target, failures);
  if (target !== undefined && signatureKind !== target.signatureKind) {
    push(failures, "security.signatureKind", `must be ${target.signatureKind}`);
  }
  if (requiresProductionVerification(options) && !signatureVerified) {
    push(failures, "security.signatureVerified", "must be true");
  }
  validateVerificationPolicy(policy, status, reasonCodes, failures);
  validateLifecycleVerificationContext(policy, status, "security", options, failures);
  validateVerificationCheckConsistency(
    target,
    signatureVerified,
    notarizationVerified,
    verificationChecks,
    failures,
  );
  validateVerificationState(manifest, policy, status, reasonCodes, failures);
  validateTargetNotarization(target, notarizationRequired, notarizationVerified, failures, options);
  relativePathAt(security, "verificationSummaryPath", "security", failures);
}

function validateVerificationChecks(security, target, failures) {
  const checks = recordAt(security, "verificationChecks", "security", failures);
  return validateTargetVerificationChecks(checks, target, failures, "security.verificationChecks");
}

function validateTargetVerificationChecks(checks, target, failures, path) {
  if (target === undefined) return checks;
  for (const key of verificationCheckKeys(target)) {
    booleanAt(checks, key, path, failures);
  }
  for (const key of forbiddenVerificationCheckKeys(target)) {
    if (key in checks) push(failures, `${path}.${key}`, "is not allowed");
  }
  return checks;
}

function validateVerificationPolicy(policy, status, reasonCodes, failures, path = "security") {
  if (!PORTABLE_VERIFICATION_POLICIES.includes(policy)) {
    push(failures, `${path}.verificationPolicy`, "is unsupported");
  }
  if (!PORTABLE_VERIFICATION_STATUSES.includes(status)) {
    push(failures, `${path}.verificationStatus`, "is unsupported");
  }
  if (new Set(reasonCodes).size !== reasonCodes.length) {
    push(failures, `${path}.verificationReasonCodes`, "must not contain duplicates");
  }
  for (const code of reasonCodes) {
    if (!PORTABLE_VERIFICATION_REASON_CODES.includes(code)) {
      push(failures, `${path}.verificationReasonCodes`, `contains unsupported code ${code}`);
    }
  }
}

function validateVerificationCheckConsistency(
  target,
  signatureVerified,
  notarizationVerified,
  verificationChecks,
  failures,
  path = "security",
) {
  if (target === undefined) return;
  if (target.nodePlatform === "win32") {
    const windowsVerified =
      verificationChecks.publisherChainVerified === true &&
      verificationChecks.timestampVerified === true;
    if (signatureVerified !== windowsVerified) {
      push(
        failures,
        `${path}.signatureVerified`,
        "must match Windows publisher-chain and timestamp verification",
      );
    }
    return;
  }
  if (signatureVerified !== (verificationChecks.developerIdVerified === true)) {
    push(failures, `${path}.signatureVerified`, "must match macOS Developer ID verification");
  }
  if (notarizationVerified !== (verificationChecks.notarizationVerified === true)) {
    push(failures, `${path}.notarizationVerified`, "must match macOS notarization verification");
  }
}

function validateSidecarSigning(runtime, target, path, failures, options) {
  const signing = recordAt(runtime, "signing", path, failures);
  const signingPath = `${path}.signing`;
  const policy = stringAt(signing, "verificationPolicy", signingPath, failures);
  const status = stringAt(signing, "verificationStatus", signingPath, failures);
  const reasonCodes = stringArrayAt(signing, "verificationReasonCodes", signingPath, failures);
  const signatureKind = stringAt(signing, "signatureKind", signingPath, failures);
  const signatureVerified = booleanAt(signing, "signatureVerified", signingPath, failures);
  const notarizationRequired = booleanAt(signing, "notarizationRequired", signingPath, failures);
  const notarizationVerified = booleanAt(signing, "notarizationVerified", signingPath, failures);
  const checks = validateSidecarVerificationChecks(signing, target, signingPath, failures);
  const verified = securityVerifiedForTarget(target, signing);
  if (target !== undefined && signatureKind !== target.signatureKind) {
    push(failures, `${signingPath}.signatureKind`, `must be ${target.signatureKind}`);
  }
  if (requiresProductionVerification(options) && !verified) {
    push(failures, `${signingPath}.signatureVerified`, "must be true");
  }
  validateVerificationPolicy(policy, status, reasonCodes, failures, signingPath);
  validateLifecycleVerificationContext(policy, status, signingPath, options, failures);
  validateVerificationCheckConsistency(
    target,
    signatureVerified,
    notarizationVerified,
    checks,
    failures,
    signingPath,
  );
  validateSidecarVerificationState(policy, status, reasonCodes, verified, signingPath, failures);
  validateSidecarNotarization(
    target,
    notarizationRequired,
    notarizationVerified,
    failures,
    options,
    path,
  );
}

function validateLifecycleVerificationContext(policy, status, path, options, failures) {
  if (options.context === "non-production") {
    if (!new Set(["development", "pull-request"]).has(policy)) {
      push(
        failures,
        `${path}.verificationPolicy`,
        "must be development or pull-request in non-production lifecycle context",
      );
    }
    return;
  }
  const expected =
    options.context === "staging"
      ? { policy: "staging", status: "unverified-staging" }
      : { policy: "production", status: "verified-production" };
  if (policy !== expected.policy || status !== expected.status) {
    push(
      failures,
      `${path}.verificationStatus`,
      `verification must match ${options.context} lifecycle context (${expected.policy}/${expected.status})`,
    );
  }
}

function validateSidecarVerificationChecks(signing, target, path, failures) {
  const checks = recordAt(signing, "verificationChecks", path, failures);
  return validateTargetVerificationChecks(checks, target, failures, `${path}.verificationChecks`);
}

function validateSidecarVerificationState(policy, status, reasonCodes, verified, path, failures) {
  if (!PORTABLE_VERIFICATION_POLICIES.includes(policy)) return;
  if (policy === "staging") {
    requireStatusForPath(status, "unverified-staging", path, failures);
    requireReasonForPath(reasonCodes, "staging-unverified", path, failures);
    if (verified) push(failures, `${path}.verificationStatus`, "must stay unverified for staging");
    return;
  }
  validateSignedSidecarVerificationState(policy, status, reasonCodes, verified, path, failures);
}

function validateSignedSidecarVerificationState(
  policy,
  status,
  reasonCodes,
  verified,
  path,
  failures,
) {
  if (policy === "production") {
    validateProductionVerificationState(status, reasonCodes, verified, path, failures);
    return;
  }
  requireReasonForPath(reasonCodes, "non-production-artifact", path, failures);
  requireStatusForPath(
    status,
    verified ? "verified-non-production" : "unsigned-non-production",
    path,
    failures,
  );
  if (!verified)
    requireReasonForPath(reasonCodes, "non-production-unsigned-allowed", path, failures);
}

function validateProductionVerificationState(status, reasonCodes, verified, path, failures) {
  if (verified) {
    requireStatusForPath(status, "verified-production", path, failures);
    if (reasonCodes.length > 0) {
      push(failures, `${path}.verificationReasonCodes`, "must be empty for verified production");
    }
    return;
  }
  requireStatusForPath(status, "verification-failed", path, failures);
  if (reasonCodes.length === 0) {
    push(
      failures,
      `${path}.verificationReasonCodes`,
      "must describe failed production verification",
    );
  }
}

function validateSidecarNotarization(target, required, verified, failures, options, path) {
  if (target === undefined) return;
  const macosTarget = target.nodePlatform === "darwin";
  if (required !== macosTarget) {
    push(failures, `${path}.signing.notarizationRequired`, `must be ${String(macosTarget)}`);
  }
  if (macosTarget && requiresProductionVerification(options) && !verified) {
    push(failures, `${path}.signing.notarizationVerified`, "must be true for macOS targets");
  }
  if (!macosTarget && verified) {
    push(failures, `${path}.signing.notarizationVerified`, "must be false for non-macOS targets");
  }
}

function requireStatusForPath(actual, expected, path, failures) {
  if (actual !== expected) push(failures, `${path}.verificationStatus`, `must be ${expected}`);
}

function requireReasonForPath(reasonCodes, expected, path, failures) {
  if (!reasonCodes.includes(expected)) {
    push(failures, `${path}.verificationReasonCodes`, `must include ${expected}`);
  }
}

function validateVerificationState(manifest, policy, status, reasonCodes, failures) {
  if (!PORTABLE_VERIFICATION_POLICIES.includes(policy)) return;
  const verified = platformSignatureVerified(manifest);
  if (policy === "staging") {
    requireVerificationStatus(status, "unverified-staging", failures);
    requireReasonCode(reasonCodes, "staging-unverified", failures);
    if (verified) push(failures, "security.verificationStatus", "must stay unverified for staging");
    return;
  }
  if (policy === "production") {
    if (verified) {
      requireVerificationStatus(status, "verified-production", failures);
      if (reasonCodes.length > 0) {
        push(failures, "security.verificationReasonCodes", "must be empty for verified production");
      }
      return;
    }
    requireVerificationStatus(status, "verification-failed", failures);
    if (reasonCodes.length === 0) {
      push(
        failures,
        "security.verificationReasonCodes",
        "must describe failed production verification",
      );
    }
    return;
  }
  requireReasonCode(reasonCodes, "non-production-artifact", failures);
  if (verified) {
    requireVerificationStatus(status, "verified-non-production", failures);
    return;
  }
  requireVerificationStatus(status, "unsigned-non-production", failures);
  requireReasonCode(reasonCodes, "non-production-unsigned-allowed", failures);
}

function requireVerificationStatus(actual, expected, failures) {
  if (actual !== expected) {
    push(failures, "security.verificationStatus", `must be ${expected}`);
  }
}

function requireReasonCode(reasonCodes, expected, failures) {
  if (!reasonCodes.includes(expected)) {
    push(failures, "security.verificationReasonCodes", `must include ${expected}`);
  }
}

function validateTargetNotarization(target, required, verified, failures, options) {
  if (target === undefined) return;
  const macosTarget = target.nodePlatform === "darwin";
  if (required !== macosTarget) {
    push(failures, "security.notarizationRequired", `must be ${String(macosTarget)}`);
  }
  if (macosTarget && requiresProductionVerification(options) && !verified) {
    push(failures, "security.notarizationVerified", "must be true for macOS targets");
  }
  if (!macosTarget && verified) {
    push(failures, "security.notarizationVerified", "must be false for non-macOS targets");
  }
}

function validateEvidence(manifest, failures) {
  const evidence = recordAt(manifest, "evidence", "manifest", failures);
  for (const key of ["checksumsPath", "sbomPath", "licenseNoticePath"]) {
    relativePathAt(evidence, key, "evidence", failures);
  }
}

function validateReleaseImpact(manifest, failures) {
  const releaseImpact = recordAt(manifest, "releaseImpact", "manifest", failures);
  relativePathAt(releaseImpact, "catalogPath", "releaseImpact", failures);
  stringAt(releaseImpact, "entryId", "releaseImpact", failures);
  if (
    stringAt(releaseImpact, "entryPackageVersion", "releaseImpact", failures) !==
    manifest.product?.packageVersion
  ) {
    push(failures, "releaseImpact.entryPackageVersion", "does not match product version");
  }
  if (
    stringAt(releaseImpact, "entryReleaseTag", "releaseImpact", failures) !==
    manifest.release?.releaseTag
  ) {
    push(failures, "releaseImpact.entryReleaseTag", "does not match release tag");
  }
  validateReviewedBinding(
    manifest,
    recordAt(releaseImpact, "reviewedBinding", "releaseImpact", failures),
    failures,
  );
}

function validateReviewedBinding(manifest, binding, failures) {
  for (const [key, expected] of reviewedBindingChecks(manifest)) {
    if (!bindingValuesMatch(binding[key], expected))
      push(failures, `releaseImpact.reviewedBinding.${key}`, "does not match manifest");
  }
}

function bindingValuesMatch(actual, expected) {
  if (Array.isArray(actual) || Array.isArray(expected)) {
    if (!Array.isArray(actual) || !Array.isArray(expected) || actual.length !== expected.length) {
      return false;
    }
    return actual.every((entry, index) => bindingValuesMatch(entry, expected[index]));
  }
  if (isRecord(actual) || isRecord(expected)) {
    if (!isRecord(actual) || !isRecord(expected)) return false;
    const keys = [...new Set([...Object.keys(actual), ...Object.keys(expected)])];
    return keys.every((key) => bindingValuesMatch(actual[key], expected[key]));
  }
  return actual === expected;
}

function reviewedBindingChecks(manifest) {
  const target = portableTargetByName(manifest.artifact?.platformTarget);
  return [
    ...releaseBindingChecks(manifest),
    ...artifactBindingChecks(manifest),
    ["packageVersion", manifest.product?.packageVersion],
    ["nodeRuntimeIdentity", nodeRuntimeIdentity(manifest, target)],
    ["provenanceStatementSha256", manifest.provenance?.provenanceStatementSha256],
    ...evidenceBindingChecks(manifest),
    ...securityBindingChecks(manifest),
    ...sidecarBindingChecks(manifest),
  ];
}

function releaseBindingChecks(manifest) {
  return [
    ["releaseId", manifest.release?.releaseId],
    ["releaseTag", manifest.release?.releaseTag],
  ];
}

function artifactBindingChecks(manifest) {
  return [
    ["assetId", manifest.artifact?.assetId],
    ["assetName", manifest.artifact?.assetName],
    ["assetSizeBytes", manifest.artifact?.sizeBytes],
    ["platformTarget", manifest.artifact?.platformTarget],
    ["archiveSha256", manifest.artifact?.sha256],
  ];
}

function evidenceBindingChecks(manifest) {
  return [
    ["sbomPath", manifest.evidence?.sbomPath],
    ["licenseNoticePath", manifest.evidence?.licenseNoticePath],
    ["checksumsPath", manifest.evidence?.checksumsPath],
  ];
}

function securityBindingChecks(manifest) {
  return [
    ["verificationPolicy", manifest.security?.verificationPolicy],
    ["verificationStatus", manifest.security?.verificationStatus],
    ["verificationReasonCodes", manifest.security?.verificationReasonCodes],
    ["platformSignatureLocallyVerified", platformSignatureVerified(manifest)],
    ["signatureKind", manifest.security?.signatureKind],
    ["signatureVerified", manifest.security?.signatureVerified],
    ["notarizationRequired", manifest.security?.notarizationRequired],
    ["notarizationVerified", manifest.security?.notarizationVerified],
    ["verificationChecks", manifest.security?.verificationChecks],
  ];
}

function sidecarBindingChecks(manifest) {
  const sidecars = Array.isArray(manifest.sidecarRuntimes) ? manifest.sidecarRuntimes : [];
  return sidecars.length > 0 ? [["sidecarRuntimes", sidecars]] : [];
}

function nodeRuntimeIdentity(manifest, target) {
  if (target === undefined || typeof manifest.runtime?.nodeVersion !== "string") return undefined;
  return `node-v${manifest.runtime.nodeVersion}-${target.runtimeTarget}`;
}

function validateUpdateEligibility(manifest, failures, options) {
  const update = recordAt(manifest, "updateEligibility", "manifest", failures);
  if (!booleanAt(update, "stableOnly", "updateEligibility", failures))
    push(failures, "updateEligibility.stableOnly", "must be true");
  if (booleanAt(update, "rollbackSupported", "updateEligibility", failures))
    push(failures, "updateEligibility.rollbackSupported", "must be false");
  if (!booleanAt(update, "eligibleAfterSetupOnly", "updateEligibility", failures))
    push(failures, "updateEligibility.eligibleAfterSetupOnly", "must be true");
  validateUpdatePredicates(manifest, update, failures, options);
  validateManualOnlyWhen(update, failures);
}

function validateUpdatePredicates(manifest, update, failures, options) {
  const predicates = recordAt(update, "requiredPredicates", "updateEligibility", failures);
  const verified = platformSignatureVerified(manifest);
  for (const key of [
    "managedRootAttested",
    "artifactShaVerified",
    "platformSignatureLocallyVerified",
    "manifestReleaseImpactBound",
    "sameVolumeCrashSafePromotionAvailable",
    "relaunchVersionVerificationAvailable",
  ]) {
    const value = booleanAt(predicates, key, "updateEligibility.requiredPredicates", failures);
    if (!expectedUpdatePredicate(key, value, verified)) {
      push(
        failures,
        `updateEligibility.requiredPredicates.${key}`,
        expectedUpdatePredicateMessage(key, verified),
      );
    }
  }
  if (requiresProductionVerification(options) && !verified) {
    push(
      failures,
      "updateEligibility.requiredPredicates.platformSignatureLocallyVerified",
      "must be backed by verified platform signature evidence",
    );
  }
}

function validateManualOnlyWhen(update, failures) {
  if (!Array.isArray(update.manualOnlyWhen) || update.manualOnlyWhen.length === 0) {
    push(failures, "updateEligibility.manualOnlyWhen", "must list manual-only blockers");
  } else if (
    update.manualOnlyWhen.some((entry) => typeof entry !== "string" || entry.length === 0)
  ) {
    push(failures, "updateEligibility.manualOnlyWhen", "must contain non-empty strings");
  } else if (!update.manualOnlyWhen.includes("signature-or-notarization-cannot-be-verified")) {
    push(failures, "updateEligibility.manualOnlyWhen", "must include signature blocker");
  }
}

function expectedUpdatePredicate(key, value, verified) {
  if (key === "platformSignatureLocallyVerified") return value === verified;
  return value;
}

function expectedUpdatePredicateMessage(key, verified) {
  if (key === "platformSignatureLocallyVerified") {
    return verified
      ? "must be backed by verified platform signature evidence"
      : "must stay false until platform signature evidence is verified";
  }
  return "must be true";
}

function platformSignatureVerified(manifest) {
  const target = portableTargetByName(manifest.artifact?.platformTarget);
  return securityVerifiedForTarget(target, manifest.security);
}

function securityVerifiedForTarget(target, security) {
  if (!verificationTargetMatches(security, target)) return false;
  const checks = security?.verificationChecks;
  if (!isRecord(checks)) return false;
  if (security?.signatureVerified !== true) return false;
  return target.nodePlatform === "win32"
    ? windowsSignatureVerified(checks)
    : macosSignatureVerified(security, checks);
}

function verificationTargetMatches(security, target) {
  return target !== undefined && security?.signatureKind === target.signatureKind;
}

function windowsSignatureVerified(checks) {
  return checks.publisherChainVerified === true && checks.timestampVerified === true;
}

function macosSignatureVerified(security, checks) {
  return (
    security.notarizationVerified === true &&
    checks.developerIdVerified === true &&
    checks.notarizationVerified === true &&
    checks.stapleVerified === true &&
    checks.assessmentVerified === true
  );
}

function scanForbidden(value, path, failures) {
  if (typeof value === "string") {
    scanForbiddenString(value, path, failures);
    return;
  }
  if (Array.isArray(value))
    value.forEach((entry, index) => scanForbidden(entry, `${path}[${String(index)}]`, failures));
  if (isRecord(value)) {
    scanSemanticCredentialProperty(value, path, failures);
    for (const [key, entry] of Object.entries(value)) {
      if (isForbiddenManifestKey(key, path)) {
        push(failures, `${path}.${key}`, "uses a forbidden manifest key");
      }
      scanForbidden(entry, `${path}.${key}`, failures);
    }
  }
}

function isForbiddenManifestKey(key, path) {
  if (path === "manifest.stateExclusion" && key.startsWith("excludes")) return false;
  const normalizedKey = key.toLowerCase();
  return (
    CREDENTIAL_METADATA_KEYS.has(normalizeCredentialMetadataKey(key)) ||
    isCompoundCredentialMetadataKey(key) ||
    FORBIDDEN_KEY_PARTS.some((part) => normalizedKey.includes(part.toLowerCase()))
  );
}

function normalizeCredentialMetadataKey(key) {
  return key.toLowerCase().replaceAll(/[^a-z0-9]/gu, "");
}

function credentialMetadataWords(key) {
  return key
    .replaceAll(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .replaceAll(/([A-Z]+)([A-Z][a-z])/gu, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((word) => word.length > 0);
}

function isCompoundCredentialMetadataKey(key) {
  const words = credentialMetadataWords(key);
  const terminalWord = words.at(-1);
  if (terminalWord === undefined) return false;
  if (CREDENTIAL_METADATA_WORDS.has(terminalWord)) return true;
  if (terminalWord === "key" && (words.at(-2) === "api" || words.at(-2) === "private")) {
    return true;
  }
  return NORMALIZED_COMPOUND_CREDENTIAL_KEY_PATTERN.test(normalizeCredentialMetadataKey(key));
}

function scanSemanticCredentialProperty(value, path, failures) {
  for (const semanticKey of ["name", "key"]) {
    if (
      typeof value[semanticKey] === "string" &&
      Object.hasOwn(value, "value") &&
      isForbiddenManifestKey(value[semanticKey], path)
    ) {
      push(failures, `${path}.${semanticKey}`, "names a forbidden credential property");
    }
  }
}

function scanForbiddenString(value, path, failures) {
  if (
    SECRET_PATTERN.test(value) ||
    CREDENTIAL_VALUE_PATTERN.test(value) ||
    PRIVATE_PATH_PATTERN.test(value) ||
    CREDENTIAL_URL_PATTERN.test(value)
  ) {
    push(failures, path, "contains secret-like or private-path text");
  }
  for (const part of FORBIDDEN_PATH_PARTS) {
    if (value.includes(part)) push(failures, path, `contains forbidden payload reference ${part}`);
  }
}

function normalizedValidationOptions(options) {
  const context = options.context ?? "published-contract";
  return { ...options, context };
}

function validateApiIdentity(options, failures) {
  if (options.context !== "published") return;
  if (
    !isRecord(options.apiIdentity) ||
    !Number.isSafeInteger(options.apiIdentity.releaseId) ||
    options.apiIdentity.releaseId <= 0 ||
    !Number.isSafeInteger(options.apiIdentity.assetId) ||
    options.apiIdentity.assetId <= 0
  ) {
    push(failures, "validation.apiIdentity", "must be a positive GitHub API snapshot");
  }
}

export function validatePortableManifest(manifest, options = {}) {
  const normalized = normalizedValidationOptions(options);
  const failures = [];
  if (!isRecord(manifest)) return ["manifest: must be an object"];
  if (!PORTABLE_MANIFEST_VALIDATION_CONTEXTS.includes(normalized.context)) {
    return ["validation.context: is unsupported"];
  }
  validateApiIdentity(normalized, failures);
  if (manifest.schemaVersion !== PORTABLE_MANIFEST_SCHEMA_VERSION)
    push(failures, "schemaVersion", "must be 1");
  validateProduct(manifest, failures);
  validateRelease(manifest, failures, normalized);
  validateArtifact(manifest, failures, normalized);
  validateProvenance(manifest, failures, normalized);
  validateRuntime(manifest, failures, normalized);
  validateSidecarRuntimes(manifest, failures, normalized);
  validatePackageSurface(manifest, failures);
  validateEntrypoints(manifest, failures);
  validateInstallLayout(manifest, failures);
  validateStateExclusion(manifest, failures);
  validateSecurity(manifest, failures, normalized);
  validateEvidence(manifest, failures);
  validateReleaseImpact(manifest, failures);
  validateUpdateEligibility(manifest, failures, normalized);
  scanForbidden(manifest, "manifest", failures);
  return failures;
}

export function validatePortableStagingManifest(manifest, options = {}) {
  return validatePortableManifest(manifest, { ...options, context: "staging" });
}

export function validatePortableCandidateManifest(manifest, options = {}) {
  return validatePortableManifest(manifest, { ...options, context: "candidate" });
}

export function validatePortablePublishedManifest(manifest, apiIdentity, options = {}) {
  return validatePortableManifest(manifest, {
    ...options,
    apiIdentity,
    context: "published",
  });
}

export function findPortableMetadataRedactionFailures(value, path = "metadata") {
  const failures = [];
  scanForbidden(value, path, failures);
  if (typeof value === "string") {
    try {
      scanForbidden(JSON.parse(value), path, failures);
    } catch {
      // Non-JSON evidence is scanned as text above.
    }
  }
  return failures;
}

export function portableVerificationSummaryForManifest(manifest) {
  const security = manifest.security ?? {};
  return {
    policy: security.verificationPolicy,
    status: security.verificationStatus,
    target: manifest.artifact?.platformTarget,
    signatureKind: security.signatureKind,
    signatureVerified: security.signatureVerified,
    notarizationRequired: security.notarizationRequired,
    notarizationVerified: security.notarizationVerified,
    platformSignatureLocallyVerified: platformSignatureVerified(manifest),
    reasonCodes: security.verificationReasonCodes ?? [],
    sidecarRuntimes: sidecarVerificationSummaries(manifest),
    verificationChecks: security.verificationChecks ?? {},
  };
}

function sidecarVerificationSummaries(manifest) {
  if (!Array.isArray(manifest.sidecarRuntimes)) return [];
  return manifest.sidecarRuntimes.map((runtime) => {
    const target = portableTargetByName(runtime.platformTarget);
    return {
      name: runtime.name,
      kind: runtime.kind,
      platformTarget: runtime.platformTarget,
      payloadRootPath: runtime.payloadRootPath,
      payloadSha256: runtime.payloadSha256,
      signingStatus: runtime.signing?.verificationStatus,
      signatureKind: runtime.signing?.signatureKind,
      signatureVerified: runtime.signing?.signatureVerified,
      notarizationRequired: runtime.signing?.notarizationRequired,
      notarizationVerified: runtime.signing?.notarizationVerified,
      platformSignatureLocallyVerified: securityVerifiedForTarget(target, runtime.signing),
    };
  });
}

export function findForbiddenPortablePaths(paths) {
  return paths.filter((path) => FORBIDDEN_PATH_PARTS.some((part) => path.includes(part)));
}

export function safeArchiveEntryPath(entryPath) {
  const normalized = normalize(entryPath).replaceAll("\\", "/");
  if (hasUnsafeArchiveRoot(entryPath, normalized)) return undefined;
  if (hasUnsafeArchiveSegments(normalized)) return undefined;
  if (!hasKeikoArchiveRoot(normalized)) return undefined;
  return normalized;
}

function hasUnsafeArchiveRoot(entryPath, normalized) {
  return (
    entryPath.length === 0 ||
    entryPath.startsWith("\\\\") ||
    entryPath.startsWith("//") ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:/u.test(entryPath)
  );
}

function hasUnsafeArchiveSegments(normalized) {
  return (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("/../") ||
    normalized.includes("/./")
  );
}

function hasKeikoArchiveRoot(normalized) {
  return normalized === "Keiko" || normalized.startsWith("Keiko/");
}

export async function sha256File(path) {
  const hash = createHash("sha256");
  await new Promise((resolvePromise, reject) => {
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", resolvePromise);
  });
  return hash.digest("hex");
}

export async function verifySha256File(path, expectedSha256) {
  const actual = await sha256File(path);
  if (actual !== expectedSha256) {
    throw new Error(`SHA-256 mismatch for ${path}: expected ${expectedSha256}, got ${actual}`);
  }
  return actual;
}

export function hashDirectoryTree(root) {
  const hash = createHash("sha256");
  for (const file of listFiles(root)) {
    const rel = relative(root, file).split(sep).join("/");
    hash.update(`${rel}\0${sha256Buffer(readFileSync(file))}\0`);
  }
  return hash.digest("hex");
}

function sha256Buffer(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function listFiles(root) {
  const out = [];
  if (!existsSync(root)) return out;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full));
    else if (entry.isFile()) out.push(resolve(full));
  }
  return out.sort();
}

export function readPortableManifest(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function assertContainedPath(root, candidate) {
  const rootAbsolute = resolve(root);
  const candidateAbsolute = resolve(candidate);
  const rel = relative(rootAbsolute, candidateAbsolute);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return candidateAbsolute;
  throw new Error(`path escapes root: ${candidate}`);
}

export function assertRegularFile(path) {
  if (!statSync(path).isFile()) throw new Error(`expected a regular file: ${path}`);
}
