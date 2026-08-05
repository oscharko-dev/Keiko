import { createHash } from "node:crypto";
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import {
  USEARCH_RUNTIME_MANIFEST,
  usearchRuntimeTargetKey,
} from "../packages/keiko-local-knowledge/src/retrieval/usearch-runtime-manifest.ts";

export const PORTABLE_MANIFEST_SCHEMA_VERSION = 1;
export const WINDOWS_PORTABLE_SETUP_ASSET_NAME = "keiko-windows-x64-setup.exe";

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

const SECRET_PATTERNS = Object.freeze([
  /sk-[\w-]{8,}/iu,
  /ghp_\w{8,}/iu,
  /github_pat_\w{82}/iu,
  /npm_[^\W_]{36}/iu,
  /BEGIN [A-Z ]*PRIVATE KEY/iu,
  /password=/iu,
  /token=/iu,
]);
const CREDENTIAL_VALUE_PATTERNS = Object.freeze([
  /(?<!\w)(?:proxy[-_ ]authorization|authorization)\s*:\s*(?:bearer|basic)\s+\S+/iu,
  /(?<!\w)(?:proxy[-_ ]authorization|authorization|auth)\s*=\s*(?:bearer|basic)\s+\S+/iu,
]);
// Structural (non-regex) equivalent of /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/u.
// The original was an unanchored regex whose scheme-continuation class ([A-Za-z0-9+.-]*)
// overlaps with the mandatory leading letter, letting the engine retry the scheme match at
// every letter position of a long run before falling through to an unbounded userinfo scan —
// O(n^2) worst case. Scanning for each "://" occurrence directly and validating its scheme and
// userinfo segments with single-character class checks (no backtracking, no ambiguous split)
// preserves identical match semantics in O(n).
const CREDENTIAL_URL_SCHEME_HEAD_CHAR = /[A-Za-z]/u;
const CREDENTIAL_URL_SCHEME_TAIL_CHAR = /[A-Za-z0-9+.-]/u;
const CREDENTIAL_URL_USER_CHAR = /[^/\s:@]/u;
const CREDENTIAL_URL_PASSWORD_CHAR = /[^/\s@]/u;

function hasCredentialUrlScheme(value, separatorIndex) {
  let schemeStart = separatorIndex - 1;
  let sawSchemeLetter = false;
  while (schemeStart >= 0 && CREDENTIAL_URL_SCHEME_TAIL_CHAR.test(value[schemeStart])) {
    if (CREDENTIAL_URL_SCHEME_HEAD_CHAR.test(value[schemeStart])) sawSchemeLetter = true;
    schemeStart -= 1;
  }
  return sawSchemeLetter;
}

// Consumes one-or-more `charPattern` characters starting at `start` and returns the index right
// after the run, or -1 if no character matched (mirrors a `+` quantifier's all-or-nothing need).
function consumeCredentialUrlRun(value, start, charPattern) {
  let cursor = start;
  while (cursor < value.length && charPattern.test(value[cursor])) cursor += 1;
  return cursor === start ? -1 : cursor;
}

function credentialUrlAtSeparator(value, separatorIndex) {
  if (!hasCredentialUrlScheme(value, separatorIndex)) return false;

  const afterUser = consumeCredentialUrlRun(value, separatorIndex + 3, CREDENTIAL_URL_USER_CHAR);
  if (afterUser === -1 || value[afterUser] !== ":") return false;

  const afterPassword = consumeCredentialUrlRun(value, afterUser + 1, CREDENTIAL_URL_PASSWORD_CHAR);
  return afterPassword !== -1 && value[afterPassword] === "@";
}

function containsCredentialUrl(value) {
  let separatorIndex = value.indexOf("://");
  while (separatorIndex !== -1) {
    if (credentialUrlAtSeparator(value, separatorIndex)) return true;
    separatorIndex = value.indexOf("://", separatorIndex + 1);
  }
  return false;
}

function matchesAnyPattern(value, patterns) {
  return patterns.some((pattern) => pattern.test(value));
}

const PRIVATE_PATH_PATTERN =
  /(?:^|[\s"'`])(?:\/Users\/|\/home\/|\/private\/|\/var\/folders\/|[A-Za-z]:\\Users\\|\\\\[^\\]+\\[^\\]+)/u;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const PLACEHOLDER_DIGEST_PATTERN = /^64-hex-[a-z0-9-]+$/u;
const COMMIT_PATTERN = /^[a-f0-9]{40}$|^40-hex-[a-z0-9-]+$/u;
const STRICT_COMMIT_PATTERN = /^[a-f0-9]{40}$/u;
const SIDECAR_RUNTIME_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/u;
const NATIVE_HELPER_KEYS = Object.freeze([
  "name",
  "kind",
  "platformTarget",
  "architecture",
  "executablePath",
  "protocol",
  "source",
  "unsignedSha256",
  "shippedSha256",
  "sizeBytes",
  "sbomBomRef",
  "signing",
]);
const NATIVE_ADDON_KEYS = Object.freeze([
  "name",
  "kind",
  "version",
  "platformTarget",
  "architecture",
  "executablePath",
  "licensePath",
  "source",
  "unsignedSha256",
  "shippedSha256",
  "sizeBytes",
  "sbomBomRef",
  "signing",
]);
const REQUIRED_NATIVE_HELPER_NAMES = Object.freeze([
  "keiko-secure-workspace-read",
  "keiko-runtime-supervisor",
]);
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

function validateRuntimeActivation(manifest, failures, options) {
  const activation = manifest.runtimeActivation;
  if (activation === undefined) {
    if (options.requireNativeHelpers === true) {
      push(failures, "runtimeActivation", "is required for newly produced artifacts");
    }
    return;
  }
  const value = recordAt(manifest, "runtimeActivation", "manifest", failures);
  exactKeysAt(
    value,
    ["schemaVersion", "path", "sha256", "trustAnchor"],
    "runtimeActivation",
    failures,
  );
  literalAt(value, "schemaVersion", 1, "runtimeActivation", failures);
  literalAt(value, "path", ".portable/runtime-activation.json", "runtimeActivation", failures);
  digestAt(value, "sha256", "runtimeActivation", failures, options);
  const trustAnchor = stringAt(value, "trustAnchor", "runtimeActivation", failures);
  const target = portableTargetByName(manifest.artifact?.platformTarget);
  const expected =
    target?.nodePlatform === "win32" ? "authenticode-attestor" : "developer-id-app-resource-seal";
  if (options.context === "staging" && trustAnchor !== "unverified-staging") {
    push(failures, "runtimeActivation.trustAnchor", "must remain unverified during staging");
  }
  if (requiresProductionVerification(options) && trustAnchor !== expected) {
    push(failures, "runtimeActivation.trustAnchor", `must be ${expected}`);
  }
}

function validateRuntimeAttestation(manifest, failures, options) {
  const target = portableTargetByName(manifest.artifact?.platformTarget);
  const attestation = manifest.runtimeAttestation;
  if (attestation === undefined) {
    if (requiresProductionVerification(options) && target?.nodePlatform === "win32") {
      push(failures, "runtimeAttestation", "is required for Windows production artifacts");
    }
    return;
  }
  if (target?.nodePlatform !== "win32") {
    push(failures, "runtimeAttestation", "is supported only for Windows x64");
    return;
  }
  const value = recordAt(manifest, "runtimeAttestation", "manifest", failures);
  exactKeysAt(
    value,
    ["schemaVersion", "carrierKind", "executablePath", "shippedSha256", "sizeBytes", "signing"],
    "runtimeAttestation",
    failures,
  );
  literalAt(value, "schemaVersion", 1, "runtimeAttestation", failures);
  literalAt(value, "carrierKind", "authenticode-executable", "runtimeAttestation", failures);
  literalAt(
    value,
    "executablePath",
    "runtime/native/keiko-runtime-attestation.exe",
    "runtimeAttestation",
    failures,
  );
  digestAt(value, "shippedSha256", "runtimeAttestation", failures, options);
  positiveNumberAt(value, "sizeBytes", "runtimeAttestation", failures);
  validateNativeHelperSigning(value, target, "runtimeAttestation", failures, options);
}

function validateRuntimeQualification(manifest, failures, options) {
  const target = portableTargetByName(manifest.artifact?.platformTarget);
  const qualification = manifest.runtimeQualification;
  if (qualification === undefined) {
    if (requiresProductionVerification(options) && target?.nodePlatform === "darwin") {
      push(failures, "runtimeQualification", "is required for macOS production artifacts");
    }
    return;
  }
  if (target?.nodePlatform !== "darwin") {
    push(failures, "runtimeQualification", "is supported only for macOS");
    return;
  }
  const value = recordAt(manifest, "runtimeQualification", "manifest", failures);
  exactKeysAt(
    value,
    ["schemaVersion", "path", "sha256", "backend"],
    "runtimeQualification",
    failures,
  );
  literalAt(value, "schemaVersion", 1, "runtimeQualification", failures);
  literalAt(
    value,
    "path",
    ".portable/runtime-qualification.json",
    "runtimeQualification",
    failures,
  );
  digestAt(value, "sha256", "runtimeQualification", failures, options);
  literalAt(value, "backend", "macos-endpoint-security", "runtimeQualification", failures);
}

function validateSidecarRuntimes(manifest, failures, options) {
  const sidecars = manifest.sidecarRuntimes;
  if (sidecars === undefined) {
    if (options.requireNativeHelpers === true) {
      push(
        failures,
        "sidecarRuntimes",
        "must contain exactly one approved OpenCode runtime for newly produced artifacts",
      );
    }
    return;
  }
  if (!Array.isArray(sidecars)) {
    push(failures, "sidecarRuntimes", "must be an array when present");
    return;
  }
  const names = new Set();
  sidecars.forEach((runtime, index) =>
    validateSidecarRuntime(manifest, runtime, index, names, failures, options),
  );
  if (
    options.requireNativeHelpers === true &&
    (sidecars.length !== 1 ||
      sidecars[0]?.name !== "opencode-compatible" ||
      sidecars[0]?.kind !== "coding-runtime")
  ) {
    push(
      failures,
      "sidecarRuntimes",
      "must contain exactly one approved OpenCode runtime for newly produced artifacts",
    );
  }
}

// One closed schema validator intentionally enumerates every field and lifecycle invariant,
// split into per-section helpers that run in declaration order.
function validateNativeHelpers(manifest, failures, options) {
  const helpers = manifest.nativeHelpers;
  // Schema v1 predates #2333. Absence remains parseable so an installed legacy artifact can be
  // recognized and the secure-read capability can fail closed instead of breaking manifest reads.
  if (helpers === undefined) {
    if (options.requireNativeHelpers === true) {
      push(
        failures,
        "nativeHelpers",
        "must contain secure-read and runtime-supervisor helpers for newly produced artifacts",
      );
    }
    return;
  }
  if (!Array.isArray(helpers) || helpers.length === 0 || helpers.length > 2) {
    push(failures, "nativeHelpers", "must contain one or two supported helpers when present");
    return;
  }
  const names = new Set();
  helpers.forEach((helper, index) =>
    validateNativeHelper(manifest, helper, index, names, failures, options),
  );
  if (
    options.requireNativeHelpers === true &&
    !REQUIRED_NATIVE_HELPER_NAMES.every((name) => names.has(name))
  ) {
    push(
      failures,
      "nativeHelpers",
      "must contain secure-read and runtime-supervisor helpers for newly produced artifacts",
    );
  }
}

function validateNativeHelper(manifest, helper, index, names, failures, options) {
  const path = `nativeHelpers[${String(index)}]`;
  if (!isRecord(helper)) {
    push(failures, path, "must be an object");
    return;
  }
  const identity = validateNativeHelperIdentity(manifest, helper, path, names, failures);
  validateNativeHelperProtocol(helper, identity.contract, path, failures);
  validateNativeHelperSource(helper, identity.contract, path, failures, options);
  validateNativeHelperBinding(
    helper,
    identity.contract,
    identity.targetName,
    path,
    failures,
    options,
  );
  const { target } = identity;
  validateNativeHelperSigning(helper, target, path, failures, options);
}

function validateNativeAddons(manifest, failures, options) {
  const addons = manifest.nativeAddons;
  if (addons === undefined) return;
  if (!Array.isArray(addons) || addons.length !== 1) {
    push(failures, "nativeAddons", "must contain exactly one addon when present");
    return;
  }
  const addon = addons[0];
  const path = "nativeAddons[0]";
  if (!isRecord(addon)) {
    push(failures, path, "must be an object");
    return;
  }
  const target = portableTargetByName(manifest.artifact?.platformTarget);
  exactKeysAt(addon, NATIVE_ADDON_KEYS, path, failures);
  literalAt(addon, "name", "usearch", path, failures);
  literalAt(addon, "kind", "node-native-addon", path, failures);
  literalAt(addon, "version", USEARCH_RUNTIME_MANIFEST.version, path, failures);
  literalAt(addon, "platformTarget", target?.platformTarget, path, failures);
  literalAt(addon, "architecture", target?.nodeArchitecture, path, failures);
  literalAt(addon, "executablePath", "runtime/native/usearch.node", path, failures);
  literalAt(addon, "licensePath", "runtime/licenses/usearch/LICENSE", path, failures);
  validateNativeAddonSource(addon, target, path, failures, options);
  digestAt(addon, "unsignedSha256", path, failures, options);
  digestAt(addon, "shippedSha256", path, failures, options);
  positiveNumberAt(addon, "sizeBytes", path, failures);
  literalAt(
    addon,
    "sbomBomRef",
    `pkg:npm/usearch@${USEARCH_RUNTIME_MANIFEST.version}?platform=${target?.platformTarget ?? ""}`,
    path,
    failures,
  );
  validateNativeHelperSigning(addon, target, path, failures, options);
}

function validateNativeAddonSource(addon, target, path, failures, options) {
  const source = recordAt(addon, "source", path, failures);
  exactKeysAt(
    source,
    ["commitSha", "tarballUrl", "tarballSha256", "binarySha256", "licenseSha256"],
    `${path}.source`,
    failures,
  );
  literalAt(source, "commitSha", USEARCH_RUNTIME_MANIFEST.sourceCommit, `${path}.source`, failures);
  literalAt(source, "tarballUrl", USEARCH_RUNTIME_MANIFEST.tarballUrl, `${path}.source`, failures);
  literalAt(
    source,
    "tarballSha256",
    USEARCH_RUNTIME_MANIFEST.tarballSha256,
    `${path}.source`,
    failures,
  );
  literalAt(
    source,
    "licenseSha256",
    USEARCH_RUNTIME_MANIFEST.licenseSha256,
    `${path}.source`,
    failures,
  );
  const targetKey =
    target === undefined
      ? undefined
      : usearchRuntimeTargetKey(target.nodePlatform, target.nodeArchitecture);
  const approved =
    targetKey === undefined ? undefined : USEARCH_RUNTIME_MANIFEST.targets[targetKey];
  literalAt(source, "binarySha256", approved?.binarySha256, `${path}.source`, failures);
  digestAt(source, "binarySha256", `${path}.source`, failures, options);
}

function validateNativeHelperIdentity(manifest, helper, path, names, failures) {
  exactKeysAt(helper, NATIVE_HELPER_KEYS, path, failures);
  const name = stringAt(helper, "name", path, failures);
  if (names.has(name)) push(failures, `${path}.name`, "must be unique");
  names.add(name);
  const targetName = stringAt(helper, "platformTarget", path, failures);
  const target = portableTargetByName(targetName);
  const contract = nativeHelperContract(name, target);
  if (contract === undefined) {
    push(failures, `${path}.name`, "is unsupported");
  } else {
    literalAt(helper, "kind", contract.kind, path, failures);
  }
  if (targetName !== manifest.artifact?.platformTarget) {
    push(failures, `${path}.platformTarget`, "must match artifact");
  }
  if (
    target !== undefined &&
    stringAt(helper, "architecture", path, failures) !== target.nodeArchitecture
  ) {
    push(failures, `${path}.architecture`, `must be ${target.nodeArchitecture}`);
  }
  if (
    contract !== undefined &&
    stringAt(helper, "executablePath", path, failures) !== contract.executablePath
  ) {
    push(failures, `${path}.executablePath`, `must be ${contract.executablePath}`);
  }
  return { contract, target, targetName };
}

function nativeHelperContract(name, target) {
  if (target === undefined) return undefined;
  const suffix = target.nodePlatform === "win32" ? ".exe" : "";
  if (name === "keiko-secure-workspace-read") {
    return {
      bomName: name,
      executablePath: `runtime/native/${name}${suffix}`,
      kind: "secure-workspace-text-read",
      protocol: { requestMagic: "KSR1", responseMagic: "KSS1" },
      sourcePath: "native/secure-workspace-read",
    };
  }
  if (name === "keiko-runtime-supervisor") {
    return {
      bomName: name,
      executablePath: `runtime/native/${name}${suffix}`,
      kind: "runtime-process-supervisor",
      protocol: { requestMagic: "KRP1", responseMagic: "KRS1" },
      sourcePath: `native/runtime-supervisor/${target.nodePlatform === "win32" ? "windows" : "macos"}`,
    };
  }
  return undefined;
}

function validateNativeHelperProtocol(helper, contract, path, failures) {
  const protocol = recordAt(helper, "protocol", path, failures);
  exactKeysAt(
    protocol,
    ["schemaVersion", "requestMagic", "responseMagic"],
    `${path}.protocol`,
    failures,
  );
  literalAt(protocol, "schemaVersion", 1, `${path}.protocol`, failures);
  if (contract !== undefined) {
    literalAt(
      protocol,
      "requestMagic",
      contract.protocol.requestMagic,
      `${path}.protocol`,
      failures,
    );
    literalAt(
      protocol,
      "responseMagic",
      contract.protocol.responseMagic,
      `${path}.protocol`,
      failures,
    );
  }
}

function validateNativeHelperSource(helper, contract, path, failures, options) {
  const source = recordAt(helper, "source", path, failures);
  exactKeysAt(source, ["commitSha", "path", "treeSha256"], `${path}.source`, failures);
  const commitSha = stringAt(source, "commitSha", `${path}.source`, failures);
  const acceptedCommitPattern = options.allowPlaceholders ? COMMIT_PATTERN : STRICT_COMMIT_PATTERN;
  if (!acceptedCommitPattern.test(commitSha))
    push(failures, `${path}.source.commitSha`, "must be a commit SHA");
  if (contract !== undefined) {
    literalAt(source, "path", contract.sourcePath, `${path}.source`, failures);
  }
  digestAt(source, "treeSha256", `${path}.source`, failures, options);
}

function validateNativeHelperBinding(helper, contract, targetName, path, failures, options) {
  digestAt(helper, "unsignedSha256", path, failures, options);
  digestAt(helper, "shippedSha256", path, failures, options);
  positiveNumberAt(helper, "sizeBytes", path, failures);
  const bomRef = stringAt(helper, "sbomBomRef", path, failures);
  if (
    contract !== undefined &&
    (!bomRef.startsWith(`pkg:generic/${contract.bomName}@`) ||
      !bomRef.endsWith(`?platform=${targetName}`))
  ) {
    push(failures, `${path}.sbomBomRef`, "must bind the helper and platform target");
  }
}

function validateNativeHelperSigning(helper, target, path, failures, options) {
  const signing = recordAt(helper, "signing", path, failures);
  exactKeysAt(
    signing,
    [
      "signatureKind",
      "verificationStatus",
      "signatureVerified",
      "notarizationRequired",
      "notarizationVerified",
    ],
    `${path}.signing`,
    failures,
  );
  if (
    target !== undefined &&
    stringAt(signing, "signatureKind", `${path}.signing`, failures) !== target.signatureKind
  ) {
    push(failures, `${path}.signing.signatureKind`, `must be ${target.signatureKind}`);
  }
  const status = stringAt(signing, "verificationStatus", `${path}.signing`, failures);
  if (!PORTABLE_VERIFICATION_STATUSES.includes(status))
    push(failures, `${path}.signing.verificationStatus`, "is unsupported");
  const state = {
    status,
    signatureVerified: booleanAt(signing, "signatureVerified", `${path}.signing`, failures),
    notarizationRequired: booleanAt(signing, "notarizationRequired", `${path}.signing`, failures),
    notarizationVerified: booleanAt(signing, "notarizationVerified", `${path}.signing`, failures),
  };
  validateNativeHelperSigningLifecycle(target, path, failures, options, state);
}

function validateNativeHelperSigningLifecycle(target, path, failures, options, state) {
  if (target !== undefined && state.notarizationRequired !== (target.nodePlatform === "darwin"))
    push(failures, `${path}.signing.notarizationRequired`, "must match target");
  if (target?.nodePlatform !== "darwin" && state.notarizationVerified)
    push(failures, `${path}.signing.notarizationVerified`, "must be false for non-macOS targets");
  if (options.context === "staging" && violatesStagingSigning(state)) {
    push(failures, `${path}.signing`, "must remain explicitly unverified during staging");
  }
  if (requiresProductionVerification(options) && violatesProductionSigning(target, state)) {
    push(failures, `${path}.signing`, "must be verified for production");
  }
}

function violatesStagingSigning(state) {
  return (
    state.status !== "unverified-staging" || state.signatureVerified || state.notarizationVerified
  );
}

function violatesProductionSigning(target, state) {
  return (
    state.status !== "verified-production" ||
    !state.signatureVerified ||
    (target?.nodePlatform === "darwin" && !state.notarizationVerified)
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
  if (containsCredentialUrl(value) || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value)) return false;
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
  validateSidecarSigningKeys(signing, signingPath, failures);
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
  validateShippedExecutableEvidence(signing, policy, signingPath, failures, options);
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

function validateSidecarSigningKeys(signing, signingPath, failures) {
  exactKeysAt(
    signing,
    [
      "verificationPolicy",
      "verificationStatus",
      "verificationReasonCodes",
      "signatureKind",
      "signatureVerified",
      "notarizationRequired",
      "notarizationVerified",
      "verificationChecks",
      "shippedExecutableSha256",
      "shippedExecutableTreeAlgorithm",
      "shippedExecutableTreeSha256",
    ],
    signingPath,
    failures,
  );
}

function validateShippedExecutableEvidence(signing, policy, path, failures, options) {
  if (policy !== "production") return;
  digestAt(signing, "shippedExecutableSha256", path, failures, options);
  literalAt(signing, "shippedExecutableTreeAlgorithm", EXECUTABLE_TREE_ALGORITHM, path, failures);
  digestAt(signing, "shippedExecutableTreeSha256", path, failures, options);
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

function validateReleaseImpact(manifest, failures, options) {
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
    options,
  );
}

function validateReviewedBinding(manifest, binding, failures, options) {
  for (const [key, expected] of reviewedBindingChecks(manifest)) {
    if (!bindingValuesMatch(binding[key], expected))
      push(failures, `releaseImpact.reviewedBinding.${key}`, "does not match manifest");
  }
  validatePublishedSetupAssetBinding(manifest, binding, failures, options);
}

function validatePublishedSetupAssetBinding(manifest, binding, failures, options) {
  if (options.context !== "published") return;
  const path = "releaseImpact.reviewedBinding.setupAsset";
  if (manifest.artifact?.platformTarget !== "windows-x64") {
    if (binding.setupAsset !== undefined) push(failures, path, "is supported only for Windows x64");
    if (options.apiIdentity?.setupAsset !== undefined) {
      push(failures, "validation.apiIdentity.setupAsset", "is supported only for Windows x64");
    }
    return;
  }
  const setupAsset = recordAt(binding, "setupAsset", "releaseImpact.reviewedBinding", failures);
  exactKeysAt(setupAsset, ["assetId", "assetName", "sha256", "sizeBytes"], path, failures);
  positiveNumberAt(setupAsset, "assetId", path, failures);
  literalAt(setupAsset, "assetName", WINDOWS_PORTABLE_SETUP_ASSET_NAME, path, failures);
  digestAt(setupAsset, "sha256", path, failures, options);
  positiveNumberAt(setupAsset, "sizeBytes", path, failures);
  const apiSetupAsset = options.apiIdentity?.setupAsset;
  if (!isRecord(apiSetupAsset)) {
    push(
      failures,
      "validation.apiIdentity.setupAsset",
      "must be a verified GitHub setup asset snapshot",
    );
  } else if (!bindingValuesMatch(setupAsset, apiSetupAsset)) {
    push(failures, path, "does not match the verified GitHub setup asset snapshot");
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
    ...nativeHelperBindingChecks(manifest),
    ...nativeAddonBindingChecks(manifest),
    ...runtimeAttestationBindingChecks(manifest),
    ...runtimeQualificationBindingChecks(manifest),
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

function nativeHelperBindingChecks(manifest) {
  return Array.isArray(manifest.nativeHelpers) ? [["nativeHelpers", manifest.nativeHelpers]] : [];
}

function nativeAddonBindingChecks(manifest) {
  return Array.isArray(manifest.nativeAddons) ? [["nativeAddons", manifest.nativeAddons]] : [];
}

function runtimeAttestationBindingChecks(manifest) {
  return manifest.runtimeAttestation === undefined
    ? []
    : [["runtimeAttestation", manifest.runtimeAttestation]];
}

function runtimeQualificationBindingChecks(manifest) {
  return manifest.runtimeQualification === undefined
    ? []
    : [["runtimeQualification", manifest.runtimeQualification]];
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

// The acronym/word boundary insertion used a capturing ([A-Z]+)([A-Z][a-z]) pair whose two
// quantified groups both match uppercase letters, so an unanchored, non-matching uppercase run
// gets retried at every position within it — O(n^2) worst case. A zero-width lookbehind/lookahead
// pinpoints the same boundary (an uppercase letter preceded by another uppercase letter and
// followed by a lowercase letter) without any quantified, overlapping groups to backtrack over.
function credentialMetadataWords(key) {
  return key
    .replaceAll(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .replaceAll(/(?<=[A-Z])(?=[A-Z][a-z])/gu, " ")
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
    matchesAnyPattern(value, SECRET_PATTERNS) ||
    matchesAnyPattern(value, CREDENTIAL_VALUE_PATTERNS) ||
    PRIVATE_PATH_PATTERN.test(value) ||
    containsCredentialUrl(value)
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
  validateRuntimeActivation(manifest, failures, normalized);
  validateRuntimeAttestation(manifest, failures, normalized);
  validateRuntimeQualification(manifest, failures, normalized);
  validateSidecarRuntimes(manifest, failures, normalized);
  validateNativeHelpers(manifest, failures, normalized);
  validateNativeAddons(manifest, failures, normalized);
  validatePackageSurface(manifest, failures);
  validateEntrypoints(manifest, failures);
  validateInstallLayout(manifest, failures);
  validateStateExclusion(manifest, failures);
  validateSecurity(manifest, failures, normalized);
  validateEvidence(manifest, failures);
  validateReleaseImpact(manifest, failures, normalized);
  validateUpdateEligibility(manifest, failures, normalized);
  scanForbidden(manifest, "manifest", failures);
  return failures;
}

export function validatePortableStagingManifest(manifest, options = {}) {
  return validatePortableManifest(manifest, {
    ...options,
    context: "staging",
    requireNativeHelpers: true,
  });
}

export function validatePortableCandidateManifest(manifest, options = {}) {
  return validatePortableManifest(manifest, {
    ...options,
    context: "candidate",
    requireNativeHelpers: true,
  });
}

export function validatePortablePublishedManifest(manifest, apiIdentity, options = {}) {
  return validatePortableManifest(manifest, {
    ...options,
    apiIdentity,
    context: "published",
    requireNativeHelpers: true,
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
    nativeHelpers: nativeHelperVerificationSummaries(manifest),
    nativeAddons: nativeAddonVerificationSummaries(manifest),
    sidecarRuntimes: sidecarVerificationSummaries(manifest),
    verificationChecks: security.verificationChecks ?? {},
  };
}

function nativeAddonVerificationSummaries(manifest) {
  if (!Array.isArray(manifest.nativeAddons)) return [];
  return manifest.nativeAddons.map((addon) => ({
    name: addon.name,
    version: addon.version,
    platformTarget: addon.platformTarget,
    architecture: addon.architecture,
    executablePath: addon.executablePath,
    shippedSha256: addon.shippedSha256,
    signingStatus: addon.signing?.verificationStatus,
    signatureKind: addon.signing?.signatureKind,
    signatureVerified: addon.signing?.signatureVerified,
    notarizationRequired: addon.signing?.notarizationRequired,
    notarizationVerified: addon.signing?.notarizationVerified,
  }));
}

function nativeHelperVerificationSummaries(manifest) {
  if (!Array.isArray(manifest.nativeHelpers)) return [];
  return manifest.nativeHelpers.map((helper) => ({
    name: helper.name,
    platformTarget: helper.platformTarget,
    architecture: helper.architecture,
    executablePath: helper.executablePath,
    shippedSha256: helper.shippedSha256,
    signingStatus: helper.signing?.verificationStatus,
    signatureKind: helper.signing?.signatureKind,
    signatureVerified: helper.signing?.signatureVerified,
    notarizationRequired: helper.signing?.notarizationRequired,
    notarizationVerified: helper.signing?.notarizationVerified,
  }));
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
  return out.sort((left, right) => left.localeCompare(right));
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
