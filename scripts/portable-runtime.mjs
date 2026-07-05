import { createHash } from "node:crypto";
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path";

export const PORTABLE_MANIFEST_SCHEMA_VERSION = 1;

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

const SECRET_PATTERN =
  /(?:sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9_]{8,}|BEGIN [A-Z ]*PRIVATE KEY|password=|token=)/iu;
const CREDENTIAL_URL_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/u;
const PRIVATE_PATH_PATTERN =
  /(?:^|[\s"'`])(?:\/Users\/|\/home\/|\/private\/|\/var\/folders\/|[A-Za-z]:\\Users\\|\\\\[^\\]+\\[^\\]+)/u;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const PLACEHOLDER_DIGEST_PATTERN = /^64-hex-[a-z0-9-]+$/u;
const COMMIT_PATTERN = /^[a-f0-9]{40}$|^40-hex-[a-z0-9-]+$/u;
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

export function portableTargetByName(platformTarget) {
  return PORTABLE_TARGETS.find((target) => target.platformTarget === platformTarget);
}

function validateProduct(manifest, failures) {
  const product = recordAt(manifest, "product", "manifest", failures);
  if (stringAt(product, "packageName", "product", failures) !== "@oscharko-dev/keiko") {
    push(failures, "product.packageName", "must be @oscharko-dev/keiko");
  }
  stringAt(product, "name", "product", failures);
  stringAt(product, "packageVersion", "product", failures);
}

function validateRelease(manifest, failures) {
  const release = recordAt(manifest, "release", "manifest", failures);
  numberAt(release, "releaseId", "release", failures);
  stringAt(release, "releaseTag", "release", failures);
  if (!booleanAt(release, "stable", "release", failures)) {
    push(failures, "release.stable", "must be true for portable v1");
  }
  const commitSha = stringAt(release, "commitSha", "release", failures);
  if (!COMMIT_PATTERN.test(commitSha)) push(failures, "release.commitSha", "must be a commit SHA");
}

function validateArtifact(manifest, failures, options) {
  const artifact = recordAt(manifest, "artifact", "manifest", failures);
  const targetName = stringAt(artifact, "platformTarget", "artifact", failures);
  const target = portableTargetByName(targetName);
  if (target === undefined) push(failures, "artifact.platformTarget", "is unsupported");
  numberAt(artifact, "assetId", "artifact", failures);
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

function validateProvenance(manifest, failures, options) {
  const provenance = recordAt(manifest, "provenance", "manifest", failures);
  const commitSha = stringAt(provenance, "sourceCommitSha", "provenance", failures);
  if (!COMMIT_PATTERN.test(commitSha))
    push(failures, "provenance.sourceCommitSha", "must be a commit SHA");
  stringAt(provenance, "rootPackageVersion", "provenance", failures);
  digestAt(provenance, "rootPackageTarballSha256", "provenance", failures, options);
  digestAt(provenance, "packagedAppTreeSha256", "provenance", failures, options);
  numberAt(provenance, "buildWorkflowRunId", "provenance", failures);
  numberAt(provenance, "buildWorkflowAttempt", "provenance", failures);
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
  if (!isSafeRelativePath(value)) {
    push(failures, `${path}.${key}`, "must be a relative contained path");
  }
  return value;
}

function isSafeRelativePath(value) {
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

function validateSecurity(manifest, failures) {
  const security = recordAt(manifest, "security", "manifest", failures);
  const target = portableTargetByName(manifest.artifact?.platformTarget);
  const signatureKind = stringAt(security, "signatureKind", "security", failures);
  const signatureVerified = booleanAt(security, "signatureVerified", "security", failures);
  const notarizationRequired = booleanAt(security, "notarizationRequired", "security", failures);
  const notarizationVerified = booleanAt(security, "notarizationVerified", "security", failures);
  if (target !== undefined && signatureKind !== target.signatureKind) {
    push(failures, "security.signatureKind", `must be ${target.signatureKind}`);
  }
  if (!signatureVerified) push(failures, "security.signatureVerified", "must be true");
  validateTargetNotarization(target, notarizationRequired, notarizationVerified, failures);
  relativePathAt(security, "verificationSummaryPath", "security", failures);
}

function validateTargetNotarization(target, required, verified, failures) {
  if (target === undefined) return;
  const macosTarget = target.nodePlatform === "darwin";
  if (required !== macosTarget) {
    push(failures, "security.notarizationRequired", `must be ${String(macosTarget)}`);
  }
  if (macosTarget && !verified) {
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
    if (binding[key] !== expected)
      push(failures, `releaseImpact.reviewedBinding.${key}`, "does not match manifest");
  }
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
    ["signatureKind", manifest.security?.signatureKind],
    ["signatureVerified", manifest.security?.signatureVerified],
    ["notarizationRequired", manifest.security?.notarizationRequired],
    ["notarizationVerified", manifest.security?.notarizationVerified],
  ];
}

function nodeRuntimeIdentity(manifest, target) {
  if (target === undefined || typeof manifest.runtime?.nodeVersion !== "string") return undefined;
  return `node-v${manifest.runtime.nodeVersion}-${target.runtimeTarget}`;
}

function validateUpdateEligibility(manifest, failures) {
  const update = recordAt(manifest, "updateEligibility", "manifest", failures);
  if (!booleanAt(update, "stableOnly", "updateEligibility", failures))
    push(failures, "updateEligibility.stableOnly", "must be true");
  if (booleanAt(update, "rollbackSupported", "updateEligibility", failures))
    push(failures, "updateEligibility.rollbackSupported", "must be false");
  if (!booleanAt(update, "eligibleAfterSetupOnly", "updateEligibility", failures))
    push(failures, "updateEligibility.eligibleAfterSetupOnly", "must be true");
  const predicates = recordAt(update, "requiredPredicates", "updateEligibility", failures);
  for (const key of [
    "managedRootAttested",
    "artifactShaVerified",
    "platformSignatureLocallyVerified",
    "manifestReleaseImpactBound",
    "sameVolumeCrashSafePromotionAvailable",
    "relaunchVersionVerificationAvailable",
  ]) {
    if (!booleanAt(predicates, key, "updateEligibility.requiredPredicates", failures))
      push(failures, `updateEligibility.requiredPredicates.${key}`, "must be true");
  }
  if (!platformSignatureVerified(manifest)) {
    push(
      failures,
      "updateEligibility.requiredPredicates.platformSignatureLocallyVerified",
      "must be backed by verified platform signature evidence",
    );
  }
  if (!Array.isArray(update.manualOnlyWhen) || update.manualOnlyWhen.length === 0) {
    push(failures, "updateEligibility.manualOnlyWhen", "must list manual-only blockers");
  } else if (
    update.manualOnlyWhen.some((entry) => typeof entry !== "string" || entry.length === 0)
  ) {
    push(failures, "updateEligibility.manualOnlyWhen", "must contain non-empty strings");
  }
}

function platformSignatureVerified(manifest) {
  const target = portableTargetByName(manifest.artifact?.platformTarget);
  if (target === undefined || manifest.security?.signatureKind !== target.signatureKind)
    return false;
  if (manifest.security?.signatureVerified !== true) return false;
  return target.nodePlatform !== "darwin" || manifest.security.notarizationVerified === true;
}

function scanForbidden(value, path, failures) {
  if (typeof value === "string") {
    scanForbiddenString(value, path, failures);
    return;
  }
  if (Array.isArray(value))
    value.forEach((entry, index) => scanForbidden(entry, `${path}[${String(index)}]`, failures));
  if (isRecord(value)) {
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
  return FORBIDDEN_KEY_PARTS.some((part) => normalizedKey.includes(part.toLowerCase()));
}

function scanForbiddenString(value, path, failures) {
  if (
    SECRET_PATTERN.test(value) ||
    PRIVATE_PATH_PATTERN.test(value) ||
    CREDENTIAL_URL_PATTERN.test(value)
  ) {
    push(failures, path, "contains secret-like or private-path text");
  }
  for (const part of FORBIDDEN_PATH_PARTS) {
    if (value.includes(part)) push(failures, path, `contains forbidden payload reference ${part}`);
  }
}

export function validatePortableManifest(manifest, options = {}) {
  const failures = [];
  if (!isRecord(manifest)) return ["manifest: must be an object"];
  if (manifest.schemaVersion !== PORTABLE_MANIFEST_SCHEMA_VERSION)
    push(failures, "schemaVersion", "must be 1");
  validateProduct(manifest, failures);
  validateRelease(manifest, failures);
  validateArtifact(manifest, failures, options);
  validateProvenance(manifest, failures, options);
  validateRuntime(manifest, failures, options);
  validatePackageSurface(manifest, failures);
  validateEntrypoints(manifest, failures);
  validateInstallLayout(manifest, failures);
  validateStateExclusion(manifest, failures);
  validateSecurity(manifest, failures);
  validateEvidence(manifest, failures);
  validateReleaseImpact(manifest, failures);
  validateUpdateEligibility(manifest, failures);
  scanForbidden(manifest, "manifest", failures);
  return failures;
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
