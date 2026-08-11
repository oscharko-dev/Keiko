import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, posix, relative, resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";

import {
  createPortableVerificationChecks,
  findForbiddenPortablePaths,
  findPortableMetadataRedactionFailures,
  hashDirectoryTree,
  isSafePortableRelativePath,
  portableTargetByName,
  PORTABLE_TARGET_NAMES,
  portableVerificationSummaryForManifest,
  sha256File,
  validatePortableEvaluationManifest,
  validatePortableStagingManifest,
  verifySha256File,
} from "./portable-runtime.mjs";
import {
  extractZipArchiveEntries,
  readZipArchiveEntries,
  writeZipArchiveFromDirectory,
} from "./lib/zip-archive.mjs";
import {
  usearchRuntimeApproval,
  usearchRuntimeTargetKey,
} from "../packages/keiko-local-knowledge/src/retrieval/usearch-runtime-manifest.ts";
import { writeRuntimeActivationManifest } from "./runtime-activation-manifest.mjs";
import { sha256 } from "./lib/digest.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const rootPackage = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
const releaseImpactCatalog = JSON.parse(
  readFileSync(join(repoRoot, "release-impact.catalog.json"), "utf8"),
);
const ALLOWED_NODE_ARCHIVE_HOSTS = new Set(["nodejs.org", "dist.nodejs.org"]);
const APPLE_TEAM_ID_PATTERN = /^[A-Z0-9]{10}$/u;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/u;
const NODE_ARCHIVE_MAX_BYTES = 128 * 1024 * 1024;
const NODE_ARCHIVE_TIMEOUT_MS = 300_000;
const NODE_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const SIDECAR_RUNTIME_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/u;
const SIDECAR_APPROVAL_SCHEMA_VERSION = 2;
const EXECUTABLE_TREE_ALGORITHM = "keiko-directory-tree-sha256-v1";
const STAGING_ASSET_ID_UNAVAILABLE = 0;
const MAC_APP_ICON_FILE = "Keiko.icns";
const MAC_APP_ICON_SOURCE = join(repoRoot, "native", "portable-launcher", "keiko.icns");
const WINDOWS_LAUNCHER_ICON_SOURCE = join(repoRoot, "native", "portable-launcher", "keiko.ico");
const WINDOWS_LAUNCHER_RESOURCE_SOURCE = join(
  repoRoot,
  "native",
  "portable-launcher",
  "keiko-portable-launcher.rc",
);
const SECURE_READ_SOURCE_ROOT = join(repoRoot, "native", "secure-workspace-read");
const SECURE_READ_NAME = "keiko-secure-workspace-read";
const RUNTIME_SUPERVISOR_NAME = "keiko-runtime-supervisor";
const MACOS_SYSTEM_EXTENSION_ID = "com.oscharko.keiko.runtime-monitor.systemextension";
const MACOS_RELEASE_TEAM_IDENTIFIER_PLACEHOLDER = "__KEIKO_APPLE_TEAM_ID__";
const MACOS_RELEASE_TEAM_IDENTIFIER_MODULE = join(
  "node_modules",
  "@oscharko-dev",
  "keiko-server",
  "dist",
  "coding-runtime",
  "macosPortableCodeIdentity.js",
);
const REQUIRED_APP_SURFACE_FILES = Object.freeze([
  "package.json",
  "dist/index.js",
  "dist/cli/index.js",
  "release-impact.catalog.json",
  "LICENSE",
  "NOTICE",
]);
const TAR_LINK_POLICY_SKIP_SAFE = "skip-safe";
const PORTABLE_RELEASE_IMPACT_CONTRACT = Object.freeze({
  issue: 1948,
  parentEpic: 1942,
  programEpic: 1944,
  stagingOnly: true,
  targets: Object.freeze(["windows-x64", "macos-arm64", "macos-x64"]),
});

function fail(message) {
  console.error(`portable-stage failed: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const options = {
    appleTeamId: undefined,
    commitSha: process.env.GITHUB_SHA,
    dryRun: false,
    evaluation: false,
    launcherBinary: undefined,
    nodeArchive: undefined,
    nodeArchiveUrl: undefined,
    nodeCacheDir: join(repoRoot, ".portable-runtime", "cache", "node"),
    nodeSha256: undefined,
    nodeVersion: undefined,
    outDir: join(repoRoot, ".portable-runtime", "staging"),
    releaseId: 0,
    releaseTag: `v${rootPackage.version}`,
    sidecarRuntimeSpecs: [],
    target: undefined,
    workflowRunAttempt: Number(process.env.GITHUB_RUN_ATTEMPT ?? 0),
    workflowRunId: Number(process.env.GITHUB_RUN_ID ?? 0),
  };
  let index = 0;
  while (index < argv.length) {
    index = applyArg(argv, index, options) + 1;
  }
  if (options.target === undefined) fail(`pass --target ${PORTABLE_TARGET_NAMES.join("|")}`);
  const target = portableTargetByName(options.target);
  if (target === undefined) fail(`unsupported target ${options.target}`);
  validateNodeRuntimeOptions(options);
  validateReleaseOptions(options);
  validateAppleTeamIdentifierOption(options, target);
  if (options.nodeArchive !== undefined) {
    assertNodeArchiveIdentity(options.nodeArchive, target, options.nodeVersion);
  }
  return options;
}

function applyArg(argv, index, options) {
  const arg = argv[index];
  if (arg === "--dry-run") {
    options.dryRun = true;
    return index;
  }
  // Bare opt-in flag, deliberately outside the `fields` map below (every entry there consumes a
  // value). This is the ONLY way to produce the unsigned evaluation lane; there is no environment
  // variable and no default that can set it.
  if (arg === "--evaluation-build") {
    options.evaluation = true;
    return index;
  }
  if (arg === "--sidecar-runtime-spec") {
    options.sidecarRuntimeSpecs.push(parseSidecarRuntimeSpec(requiredArgValue(argv, index, arg)));
    return index + 1;
  }
  const fields = new Map([
    ["--apple-team-id", "appleTeamId"],
    ["--commit-sha", "commitSha"],
    ["--launcher-binary", "launcherBinary"],
    ["--node-archive", "nodeArchive"],
    ["--node-archive-url", "nodeArchiveUrl"],
    ["--node-cache-dir", "nodeCacheDir"],
    ["--node-sha256", "nodeSha256"],
    ["--node-version", "nodeVersion"],
    ["--out-dir", "outDir"],
    ["--release-id", "releaseId"],
    ["--release-tag", "releaseTag"],
    ["--target", "target"],
    ["--workflow-run-attempt", "workflowRunAttempt"],
    ["--workflow-run-id", "workflowRunId"],
  ]);
  const field = fields.get(arg);
  if (field === undefined) fail(`unsupported argument: ${arg}`);
  const value = requiredArgValue(argv, index, arg);
  options[field] = ["releaseId", "workflowRunAttempt", "workflowRunId"].includes(field)
    ? Number(value)
    : value;
  return index + 1;
}

function requiredArgValue(argv, index, arg) {
  const value = argv[index + 1];
  if (value === undefined || value.length === 0) fail(`${arg} requires a value`);
  return value;
}

function parseSidecarRuntimeSpec(value) {
  try {
    const text = value.trim().startsWith("{") ? value : readFileSync(resolve(value), "utf8");
    return JSON.parse(text);
  } catch {
    fail("--sidecar-runtime-spec must be JSON or a JSON file path");
  }
}

function validateNodeRuntimeOptions(options) {
  if (options.nodeArchive !== undefined && options.nodeArchiveUrl !== undefined) {
    fail("pass either --node-archive or --node-archive-url, not both");
  }
  if (options.nodeArchive === undefined && options.nodeArchiveUrl === undefined) {
    fail("pass --node-archive or --node-archive-url with --node-sha256");
  }
  if (options.nodeSha256 === undefined) fail("--node-sha256 is required");
  if (!SHA256_PATTERN.test(options.nodeSha256)) fail("--node-sha256 must be a SHA-256 digest");
  if (typeof options.nodeVersion !== "string" || !NODE_VERSION_PATTERN.test(options.nodeVersion)) {
    fail("--node-version is required and must identify the bundled Node.js runtime");
  }
  validateNodeDownloadEnvironment(options);
}

function validateNodeDownloadEnvironment(options) {
  if (options.nodeArchiveUrl !== undefined && process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
    fail("NODE_TLS_REJECT_UNAUTHORIZED=0 is not allowed for Node runtime acquisition");
  }
}

function validateReleaseOptions(options) {
  if (typeof options.commitSha !== "string" || !COMMIT_PATTERN.test(options.commitSha)) {
    fail("--commit-sha or GITHUB_SHA must be a 40-hex commit SHA");
  }
  if (!Number.isSafeInteger(options.releaseId) || options.releaseId < 0) {
    fail("--release-id must be a non-negative safe integer");
  }
  validateWorkflowIdentityOptions(options);
  if (typeof options.releaseTag !== "string" || options.releaseTag.length === 0) {
    fail("--release-tag must be a non-empty release tag");
  }
  if (rootPackage.version.includes("-") || options.releaseTag !== `v${rootPackage.version}`) {
    fail("--release-tag must match the stable package version for portable v1");
  }
}

function validateAppleTeamIdentifierOption(options, target) {
  if (options.appleTeamId === undefined) return;
  if (target.platformTarget === "windows-x64") {
    fail("--apple-team-id is accepted only for macOS targets");
  }
  if (!APPLE_TEAM_ID_PATTERN.test(options.appleTeamId)) {
    fail("--apple-team-id must be a 10-character Apple team identifier");
  }
}

function validateWorkflowIdentityOptions(options) {
  if (!Number.isSafeInteger(options.workflowRunId) || options.workflowRunId < 0) {
    fail("--workflow-run-id must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(options.workflowRunAttempt) || options.workflowRunAttempt < 0) {
    fail("--workflow-run-attempt must be a non-negative safe integer");
  }
}

function normalizeSidecarRuntimeSpecs(specs, target, evaluation) {
  const names = new Set();
  return specs.map((spec, index) =>
    normalizeSidecarRuntimeSpec(spec, target, names, index, evaluation),
  );
}

function normalizeSidecarRuntimeSpec(spec, target, names, index, evaluation) {
  if (!isRecord(spec)) fail(`sidecar spec ${String(index + 1)} must be an object`);
  requireExactSpecKeys(spec, [
    "approvalSchemaVersion",
    "name",
    "kind",
    "sourceRoot",
    "executablePath",
    "licenseEvidencePath",
    "sbomEvidencePath",
    "upstream",
    "adapterCompatibility",
    "protocolSchema",
    "releaseApproval",
    "license",
    "archive",
    "platformTarget",
    "executableTreeAlgorithm",
    "expectedExecutableTreeSha256",
    "expectedPayloadSha256",
  ]);
  if (spec.approvalSchemaVersion !== SIDECAR_APPROVAL_SCHEMA_VERSION) {
    fail("sidecar approvalSchemaVersion must be 2");
  }
  const name = normalizeSidecarName(spec, names);
  const sourceRoot = resolve(requiredSpecString(spec, "sourceRoot"));
  const files = sidecarTreeFiles(sourceRoot);
  const payloadSha256 = hashDirectoryTree(sourceRoot);
  validateExpectedSidecarDigest(spec, payloadSha256);
  const payloadRootPath = `runtime/sidecars/${name}`;
  const metadata = sidecarMetadataForSpec(
    spec,
    target,
    payloadRootPath,
    payloadSha256,
    files,
    sourceRoot,
    evaluation,
  );
  validateSidecarMetadata(metadata);
  return { ...metadata, sourceRoot };
}

function normalizeSidecarName(spec, names) {
  const name = requiredSpecString(spec, "name");
  if (!SIDECAR_RUNTIME_NAME_PATTERN.test(name)) {
    fail("sidecar runtime name must be a stable kebab-case value");
  }
  if (names.has(name)) fail("sidecar runtime names must be unique");
  names.add(name);
  return name;
}

function sidecarMetadataForSpec(
  spec,
  target,
  payloadRootPath,
  payloadSha256,
  files,
  sourceRoot,
  evaluation,
) {
  const paths = sidecarPathsForSpec(spec, payloadRootPath, files);
  const provenance = sidecarProvenanceForSpec(spec, target);
  const executable = sidecarExecutableForSpec(spec, sourceRoot, paths.executableSourcePath);
  const evidence = sidecarEvidenceForSpec(spec, sourceRoot, paths, provenance, executable);
  return {
    approvalSchemaVersion: SIDECAR_APPROVAL_SCHEMA_VERSION,
    name: requiredSpecString(spec, "name"),
    kind: requiredSpecLiteral(spec, "kind", "coding-runtime"),
    ...provenance,
    ...executable,
    platformTarget: provenance.archive.platformTarget,
    payloadRootPath,
    executablePath: paths.executablePath,
    payloadSha256,
    sizeBytes: sidecarTreeSize(files),
    ...evidence,
    signing: sidecarStagingSigning(target, executable, evaluation),
  };
}

function sidecarPathsForSpec(spec, payloadRootPath, files) {
  const executableSourcePath = sourcePathForSpec(spec, "executablePath");
  const licenseSourcePath = sourcePathForSpec(spec, "licenseEvidencePath");
  const sbomSourcePath = sourcePathForSpec(spec, "sbomEvidencePath");
  const executablePath = sidecarPayloadPath(
    payloadRootPath,
    executableSourcePath,
    files,
    "executablePath",
  );
  const licensePath = sidecarPayloadPath(
    payloadRootPath,
    licenseSourcePath,
    files,
    "licenseEvidencePath",
  );
  const sbomPath = sidecarPayloadPath(payloadRootPath, sbomSourcePath, files, "sbomEvidencePath");
  return {
    executableSourcePath,
    licenseSourcePath,
    sbomSourcePath,
    executablePath,
    licensePath,
    sbomPath,
  };
}

function sidecarProvenanceForSpec(spec, target) {
  const upstream = sidecarUpstream(spec);
  const adapterCompatibility = sidecarAdapterCompatibility(spec);
  const protocolSchema = sidecarProtocolSchema(spec, upstream, adapterCompatibility);
  const releaseApproval = sidecarReleaseApproval(spec);
  const license = sidecarLicense(spec);
  const platformTarget = sidecarPlatformTarget(spec, target);
  const archive = sidecarArchive(spec, upstream, platformTarget);
  return { upstream, adapterCompatibility, protocolSchema, releaseApproval, license, archive };
}

function sidecarExecutableForSpec(spec, sourceRoot, executableSourcePath) {
  const executableTreeAlgorithm = requiredSpecLiteral(
    spec,
    "executableTreeAlgorithm",
    EXECUTABLE_TREE_ALGORITHM,
  );
  const executableTreeSha256 = requiredSpecDigest(spec, "expectedExecutableTreeSha256");
  const actualExecutableTreeSha256 = hashExecutableTree(sourceRoot, executableSourcePath);
  if (actualExecutableTreeSha256 !== executableTreeSha256) {
    fail("sidecar executable tree digest does not match independent approval");
  }
  const executableSha256 = sha256(
    readFileSync(resolveSidecarSourcePath(sourceRoot, executableSourcePath)),
  );
  return { executableTreeAlgorithm, executableTreeSha256, executableSha256 };
}

function sidecarEvidenceForSpec(spec, sourceRoot, paths, provenance, executable) {
  const licenseEvidence = sidecarEvidence(sourceRoot, paths.licenseSourcePath, paths.licensePath);
  if (licenseEvidence.sha256 !== provenance.license.sha256) {
    fail("sidecar license evidence digest does not match approval");
  }
  validateSidecarSbom(
    sourceRoot,
    paths.sbomSourcePath,
    spec,
    provenance.upstream,
    provenance.license,
    provenance.archive,
    executable.executableSha256,
  );
  return {
    licenseEvidence,
    sbomEvidence: sidecarEvidence(sourceRoot, paths.sbomSourcePath, paths.sbomPath),
  };
}

function sidecarPayloadPath(payloadRootPath, sourcePath, files, key) {
  if (!files.some((file) => file.relativePath === sourcePath)) {
    fail(`sidecar ${key} is missing`);
  }
  return posix.join(payloadRootPath, sourcePath);
}

function sourcePathForSpec(spec, key) {
  const path = requiredSpecString(spec, key).replaceAll("\\", "/");
  if (!isSafePortableRelativePath(path)) fail(`sidecar ${key} must be a contained relative path`);
  return path;
}

function sidecarUpstream(spec) {
  const upstream = requiredSpecRecord(spec, "upstream");
  requireExactRecordKeys(
    upstream,
    ["owner", "repository", "name", "version", "tag", "commit"],
    "upstream",
  );
  return {
    owner: requiredSpecString(upstream, "owner"),
    repository: requiredSpecString(upstream, "repository"),
    name: requiredSpecString(upstream, "name"),
    version: requiredSpecString(upstream, "version"),
    tag: requiredSpecString(upstream, "tag"),
    commit: requiredSpecCommit(upstream, "commit"),
  };
}

function sidecarAdapterCompatibility(spec) {
  const adapter = requiredSpecRecord(spec, "adapterCompatibility");
  requireExactRecordKeys(
    adapter,
    ["adapterName", "adapterVersion", "transport"],
    "adapterCompatibility",
  );
  return {
    adapterName: requiredSpecLiteral(adapter, "adapterName", "keiko-coding-sidecar"),
    adapterVersion: requiredSpecLiteral(adapter, "adapterVersion", "1"),
    transport: requiredSpecLiteral(adapter, "transport", "http-sse"),
  };
}

function sidecarProtocolSchema(spec, upstream, adapter) {
  const schema = requiredSpecRecord(spec, "protocolSchema");
  requireExactRecordKeys(
    schema,
    ["path", "url", "sha256", "hashAlgorithm", "hashEncoding", "digestInput", "transport"],
    "protocolSchema",
  );
  const path = requiredSpecRelativePath(schema, "path");
  const expectedUrl = `https://raw.githubusercontent.com/${upstream.owner}/${upstream.repository}/${upstream.commit}/${path}`;
  const url = requiredSpecLiteral(schema, "url", expectedUrl);
  const transport = requiredSpecLiteral(schema, "transport", "http-sse");
  if (transport !== adapter.transport) fail("sidecar protocol schema transport must match adapter");
  return {
    path,
    url,
    sha256: requiredSpecDigest(schema, "sha256"),
    hashAlgorithm: requiredSpecLiteral(schema, "hashAlgorithm", "sha256"),
    hashEncoding: requiredSpecLiteral(schema, "hashEncoding", "lowercase-hex"),
    digestInput: requiredSpecLiteral(schema, "digestInput", "upstream-raw-bytes"),
    transport,
  };
}

function sidecarReleaseApproval(spec) {
  const approval = requiredSpecRecord(spec, "releaseApproval");
  requireExactRecordKeys(approval, ["redistribution", "subscriptionAuth"], "releaseApproval");
  return {
    redistribution: sidecarApprovalGate(approval, "redistribution", "approved"),
    subscriptionAuth: sidecarApprovalGate(approval, "subscriptionAuth", "not-applicable"),
  };
}

function sidecarApprovalGate(approval, key, expectedStatus) {
  const gate = requiredSpecRecord(approval, key);
  requireExactRecordKeys(gate, ["status", "reviewReference"], `releaseApproval.${key}`);
  const reviewReference = requiredSpecString(gate, "reviewReference");
  if (
    !/^https:\/\/github\.com\/oscharko-dev\/Keiko\/(?:issues|pull)\/\d+$/u.test(reviewReference)
  ) {
    fail(`sidecar releaseApproval.${key}.reviewReference must reference Keiko review`);
  }
  return {
    status: requiredSpecLiteral(gate, "status", expectedStatus),
    reviewReference,
  };
}

function sidecarLicense(spec) {
  const license = requiredSpecRecord(spec, "license");
  requireExactRecordKeys(license, ["spdxId", "url", "sha256"], "license");
  const url = requiredSpecHttpsUrl(license, "url");
  const upstream = requiredSpecRecord(spec, "upstream");
  const expectedPrefix = `https://raw.githubusercontent.com/${upstream.owner}/${upstream.repository}/${upstream.commit}/`;
  if (!url.startsWith(expectedPrefix)) {
    fail("sidecar license URL must bind the approved upstream commit");
  }
  return {
    spdxId: requiredSpecString(license, "spdxId"),
    url,
    sha256: requiredSpecDigest(license, "sha256"),
  };
}

function sidecarArchive(spec, upstream, platformTarget) {
  const archive = requiredSpecRecord(spec, "archive");
  requireExactRecordKeys(archive, ["platformTarget", "url", "sizeBytes", "sha256"], "archive");
  requiredSpecLiteral(archive, "platformTarget", platformTarget);
  const url = requiredSpecHttpsUrl(archive, "url");
  const parsed = new URL(url);
  const expectedPrefix = `/${upstream.owner}/${upstream.repository}/releases/download/${upstream.tag}/`;
  if (parsed.hostname !== "github.com" || !parsed.pathname.startsWith(expectedPrefix)) {
    fail("sidecar archive URL must bind the approved upstream repository and tag");
  }
  return {
    platformTarget,
    url,
    sizeBytes: requiredSpecPositiveInteger(archive, "sizeBytes"),
    sha256: requiredSpecDigest(archive, "sha256"),
  };
}

function validateSidecarSbom(
  sourceRoot,
  sbomSourcePath,
  spec,
  upstream,
  license,
  archive,
  executableSha256,
) {
  const sbom = readSidecarSbom(sourceRoot, sbomSourcePath);
  const component = findSidecarSbomComponent(sbom, upstream.name);
  const checks = [
    sidecarSbomIdentityMatches(sbom, component, spec.name, upstream),
    sidecarSbomLicenseMatches(component, license.spdxId),
    sidecarSbomHashMatches(component, executableSha256),
    sidecarSbomDistributionMatches(component, archive),
  ];
  if (checks.includes(false)) {
    fail("sidecar SBOM identity, version, license, executable, or archive provenance mismatch");
  }
}

function readSidecarSbom(sourceRoot, sbomSourcePath) {
  try {
    return JSON.parse(readFileSync(resolveSidecarSourcePath(sourceRoot, sbomSourcePath), "utf8"));
  } catch {
    fail("sidecar SBOM evidence must be valid JSON");
  }
}

function findSidecarSbomComponent(sbom, upstreamName) {
  if (!Array.isArray(sbom.components)) return undefined;
  return sbom.components.find((candidate) => candidate?.name === upstreamName);
}

function sidecarSbomIdentityMatches(sbom, component, runtimeName, upstream) {
  return (
    sbom.bomFormat === "CycloneDX" &&
    sidecarSbomMetadataMatches(sbom.metadata, runtimeName, upstream.version) &&
    sidecarSbomComponentIdentityMatches(component, upstream)
  );
}

function sidecarSbomMetadataMatches(metadata, runtimeName, upstreamVersion) {
  return (
    metadata?.component?.name === runtimeName && metadata?.component?.version === upstreamVersion
  );
}

function sidecarSbomComponentIdentityMatches(component, upstream) {
  const expectedPurl = `pkg:github/${upstream.owner}/${upstream.repository}@${upstream.tag}`;
  return component?.version === upstream.version && component?.purl === expectedPurl;
}

function sidecarSbomLicenseMatches(component, spdxId) {
  return component?.licenses?.some((entry) => entry?.license?.id === spdxId) === true;
}

function sidecarSbomHashMatches(component, executableSha256) {
  return (
    component?.hashes?.some(
      (entry) => entry?.alg === "SHA-256" && entry?.content === executableSha256,
    ) === true
  );
}

function sidecarSbomDistributionMatches(component, archive) {
  return (
    component?.externalReferences?.some(
      (entry) => entry?.type === "distribution" && sidecarDistributionMatches(entry, archive),
    ) === true
  );
}

function sidecarDistributionMatches(reference, archive) {
  return (
    reference.url === archive.url &&
    reference.hashes?.some(
      (hash) => hash?.alg === "SHA-256" && hash?.content === archive.sha256,
    ) === true
  );
}

function hashExecutableTree(sourceRoot, executableRelativePath) {
  const executable = resolveSidecarSourcePath(sourceRoot, executableRelativePath);
  const digest = sha256(readFileSync(executable));
  return createHash("sha256").update(`${executableRelativePath}\0${digest}\0`).digest("hex");
}

function sidecarPlatformTarget(spec, target) {
  const platformTarget = requiredSpecString(spec, "platformTarget");
  if (platformTarget !== target.platformTarget) fail("sidecar platformTarget must match --target");
  return platformTarget;
}

function sidecarEvidence(sourceRoot, sourcePath, payloadPath) {
  return {
    path: payloadPath,
    sha256: sha256(readFileSync(resolveSidecarSourcePath(sourceRoot, sourcePath))),
  };
}

/**
 * The one place this producer names a pre-signing lane. `--evaluation-build` is the only way to
 * reach the evaluation triple; without it every writer emits the unchanged staging triple. Neither
 * lane may ever assert a platform proof — `signatureVerified`, `notarizationVerified` and every
 * entry of `createPortableVerificationChecks(..., false)` stay hard-coded false on both.
 */
function stageVerificationLane(evaluation) {
  return evaluation
    ? {
        verificationPolicy: "evaluation",
        verificationStatus: "evaluation-unqualified",
        verificationReasonCodes: ["evaluation-artifact", "evaluation-unsigned-allowed"],
      }
    : {
        verificationPolicy: "staging",
        verificationStatus: "unverified-staging",
        verificationReasonCodes: ["staging-unverified"],
      };
}

function nativeHelperStagingStatus(evaluation) {
  return evaluation ? "evaluation-unqualified" : "unverified-staging";
}

function sidecarStagingSigning(target, executable, evaluation) {
  return {
    ...stageVerificationLane(evaluation),
    signatureKind: target.signatureKind,
    signatureVerified: false,
    notarizationRequired: target.nodePlatform === "darwin",
    notarizationVerified: false,
    verificationChecks: createPortableVerificationChecks(target.platformTarget, false),
    shippedExecutableSha256: executable.executableSha256,
    shippedExecutableTreeAlgorithm: executable.executableTreeAlgorithm,
    shippedExecutableTreeSha256: executable.executableTreeSha256,
  };
}

function sidecarTreeFiles(sourceRoot) {
  let rootEntry;
  try {
    rootEntry = lstatSync(sourceRoot);
  } catch {
    fail("sidecar sourceRoot must be an existing directory");
  }
  if (!rootEntry.isDirectory()) fail("sidecar sourceRoot must be a real directory");
  const files = listSidecarFiles(sourceRoot, sourceRoot);
  if (files.length === 0) fail("sidecar sourceRoot must contain payload files");
  if (findForbiddenPortablePaths(files.map((file) => file.relativePath)).length > 0) {
    fail("sidecar source tree contains forbidden portable payload paths");
  }
  return files;
}

function listSidecarFiles(root, current) {
  const files = [];
  for (const entry of readdirSync(current)) {
    files.push(...sidecarEntryFiles(root, join(current, entry)));
  }
  return files;
}

function sidecarEntryFiles(root, path) {
  const entry = lstatSync(path);
  if (entry.isDirectory()) return listSidecarFiles(root, path);
  if (!entry.isFile()) fail("sidecar source tree contains unsupported entries");
  if (entry.nlink > 1) fail("sidecar source tree contains hardlinked files");
  return [{ relativePath: portableRelativePath(root, path), sizeBytes: entry.size }];
}

function portableRelativePath(root, path) {
  return relative(root, path).replaceAll("\\", "/");
}

function sidecarTreeSize(files) {
  return files.reduce((total, file) => total + file.sizeBytes, 0);
}

function validateExpectedSidecarDigest(spec, payloadSha256) {
  const expected = spec.expectedPayloadSha256 ?? spec.expectedSha256;
  if (expected === undefined) return;
  if (typeof expected !== "string" || !SHA256_PATTERN.test(expected)) {
    fail("sidecar expected digest must be a SHA-256 digest");
  }
  if (expected !== payloadSha256) fail("sidecar expected digest does not match payload");
}

function validateSidecarMetadata(metadata) {
  const failures = findPortableMetadataRedactionFailures(metadata, "sidecarRuntimeSpec");
  if (failures.length > 0)
    fail(`sidecar metadata is not redacted:\n  - ${failures.join("\n  - ")}`);
}

function resolveSidecarSourcePath(sourceRoot, sourcePath) {
  const candidate = resolve(sourceRoot, sourcePath);
  const rel = relative(sourceRoot, candidate);
  if (rel.startsWith("..") || rel === "" || /^[A-Za-z]:/u.test(rel)) {
    fail("sidecar source path must stay inside sourceRoot");
  }
  return candidate;
}

function requiredSpecRecord(spec, key) {
  const value = spec[key];
  if (!isRecord(value)) fail(`sidecar ${key} must be an object`);
  return value;
}

function requireExactSpecKeys(spec, allowedKeys) {
  requireExactRecordKeys(spec, allowedKeys, "spec");
}

function requireExactRecordKeys(record, allowedKeys, context) {
  const unexpected = Object.keys(record).filter((key) => !allowedKeys.includes(key));
  if (unexpected.length > 0) {
    const [firstUnexpected] = unexpected.toSorted((left, right) => left.localeCompare(right));
    fail(`sidecar ${context} contains unsupported key ${firstUnexpected}`);
  }
}

function requiredSpecString(spec, key) {
  const value = spec[key];
  if (typeof value !== "string" || value.length === 0) {
    fail(`sidecar ${key} must be a non-empty string`);
  }
  return value;
}

function requiredSpecLiteral(spec, key, expected) {
  const value = spec[key];
  if (value !== expected) fail(`sidecar ${key} must be ${String(expected)}`);
  return value;
}

function requiredSpecDigest(spec, key) {
  const value = requiredSpecString(spec, key);
  if (!SHA256_PATTERN.test(value)) fail(`sidecar ${key} must be a SHA-256 digest`);
  return value;
}

function requiredSpecCommit(spec, key) {
  const value = requiredSpecString(spec, key);
  if (!COMMIT_PATTERN.test(value)) fail(`sidecar ${key} must be a commit SHA`);
  return value;
}

function requiredSpecRelativePath(spec, key) {
  const value = requiredSpecString(spec, key).replaceAll("\\", "/");
  if (!isSafePortableRelativePath(value)) fail(`sidecar ${key} must be a contained relative path`);
  return value;
}

function requiredSpecHttpsUrl(spec, key) {
  const value = requiredSpecString(spec, key);
  let url;
  try {
    url = new URL(value);
  } catch {
    fail(`sidecar ${key} must be a valid URL`);
  }
  if (url.protocol !== "https:" || url.username.length > 0 || url.password.length > 0) {
    fail(`sidecar ${key} must be a credential-free HTTPS URL`);
  }
  return url.toString();
}

function requiredSpecPositiveInteger(spec, key) {
  const value = spec[key];
  if (!Number.isSafeInteger(value) || value <= 0) {
    fail(`sidecar ${key} must be a positive safe integer`);
  }
  return value;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, { cwd: repoRoot, encoding: "utf8", ...options });
  if (result.error !== undefined)
    fail(`${cmd} ${args.join(" ")} could not spawn: ${result.error.message}`);
  if (result.status !== 0)
    fail(`${cmd} ${args.join(" ")} exited ${String(result.status)}: ${result.stderr}`);
  return result;
}

// npm is `npm.cmd` on Windows, which spawnSync can only launch through a shell (a bare "npm"
// yields spawnSync ENOENT); POSIX resolves the bare "npm" directly. The staging temp/pack paths are
// created by mkdtempSync under the OS temp root, so no npm argument contains spaces — shell
// arg-splitting is safe here. This is the only place staging shells out to npm.
// SECURITY-SHELL-OK: shell is enabled only on win32 to resolve npm.cmd; all args are static
// literals or mkdtemp-generated paths (no user/network input), so there is no injection surface.
function runNpm(args, options = {}) {
  return run("npm", args, { ...options, shell: process.platform === "win32" });
}

function packRoot(packDir) {
  const result = runNpm(["pack", "--silent", "--ignore-scripts", "--pack-destination", packDir]);
  const tarballName = result.stdout.trim().split(/\r?\n/u).findLast(Boolean);
  if (tarballName === undefined) fail("npm pack did not report a tarball name");
  const tarball = join(packDir, tarballName);
  if (!existsSync(tarball)) fail(`expected npm pack tarball at ${tarball}`);
  return tarball;
}

function preparePackageSurface() {
  runNpm(["run", "build"]);
  runNpm(["run", "build:ui"]);
  runNpm(["run", "prepare:bin"]);
  runNpm(["run", "prune:package-build-artifacts"]);
  runNpm(["run", "prune:package-native-optionals"]);
  runNpm(["run", "check:package-surface"]);
}

function stagePackedPackage(tarball, extractRoot, stageRoot) {
  const appRoot = join(stageRoot, "app");
  extractArchiveRoot(tarball, "tar.gz", "package", extractRoot, appRoot, {
    tarLinkPolicy: TAR_LINK_POLICY_SKIP_SAFE,
  });
  validateStagedAppSurface(appRoot);
}

export function bindMacosReleaseTeamIdentifier(appRoot, target, appleTeamId) {
  if (target.platformTarget === "windows-x64" || appleTeamId === undefined) return;
  const modulePath = join(appRoot, MACOS_RELEASE_TEAM_IDENTIFIER_MODULE);
  const source = readFileSync(modulePath, "utf8");
  const occurrences = source.split(MACOS_RELEASE_TEAM_IDENTIFIER_PLACEHOLDER).length - 1;
  if (occurrences !== 1) {
    fail("packaged macOS identity module must contain exactly one release team placeholder");
  }
  writeFileSync(modulePath, source.replace(MACOS_RELEASE_TEAM_IDENTIFIER_PLACEHOLDER, appleTeamId));
}

async function stageNodeRuntime(options, target, stageRoot) {
  const runtimeRoot = join(stageRoot, "runtime", "node");
  mkdirSync(runtimeRoot, { recursive: true });
  const archive = await resolveNodeArchive(options, target);
  extractNodeRuntime(archive.path, target, options.nodeVersion, runtimeRoot);
  ensureRuntimeNotice(runtimeRoot, archive);
  validateExtractedNodeRuntime(target, runtimeRoot);
  writeFileSync(
    join(runtimeRoot, "NODE_RUNTIME_SOURCE.json"),
    JSON.stringify(
      {
        fileName: archive.fileName,
        nodeVersion: options.nodeVersion,
        sha256: archive.sha256,
        source: archive.source,
        target: target.runtimeTarget,
      },
      null,
      2,
    ) + "\n",
  );
  return archive.sha256;
}

function extractNodeRuntime(archivePath, target, nodeVersion, runtimeRoot) {
  const extractRoot = join(runtimeRoot, ".extract");
  try {
    extractArchiveRoot(
      archivePath,
      target.nodeArchiveExtension,
      expectedNodeArchiveRootName(target, nodeVersion),
      extractRoot,
      runtimeRoot,
      { tarLinkPolicy: TAR_LINK_POLICY_SKIP_SAFE },
    );
  } finally {
    rmSync(extractRoot, { recursive: true, force: true });
  }
}

function extractArchiveRoot(
  archivePath,
  archiveKind,
  expectedRoot,
  extractRoot,
  destinationRoot,
  policy,
) {
  rmSync(extractRoot, { recursive: true, force: true });
  mkdirSync(extractRoot, { recursive: true });
  const entries = safeExtractionEntries(archivePath, archiveKind, expectedRoot, policy);
  extractArchive(archivePath, archiveKind, extractRoot, entries);
  copySafeTreeContents(join(extractRoot, expectedRoot), destinationRoot);
}

function extractArchive(archivePath, archiveKind, extractRoot, entries) {
  if (archiveKind === "zip") {
    createPortableZipAdapter().extract(archivePath, extractRoot);
    return;
  }
  const includeFile = join(extractRoot, "portable-runtime-tar-include.txt");
  writeFileSync(includeFile, `${entries.join("\n")}\n`);
  run("tar", ["-xzf", archivePath, "-C", extractRoot, "-T", includeFile]);
  rmSync(includeFile, { force: true });
}

function safeExtractionEntries(archivePath, archiveKind, expectedRoot, policy) {
  if (archiveKind === "zip") {
    return safeZipExtractionEntries(archivePath, expectedRoot, createPortableZipAdapter());
  }
  const entries = archiveEntries(archivePath);
  if (!entries.some((entry) => archiveEntryInsideRoot(entry, expectedRoot))) {
    fail(`archive must contain ${expectedRoot}`);
  }
  for (const entry of entries) {
    if (!archiveEntryInsideRoot(entry, expectedRoot)) fail(`archive entry escapes ${expectedRoot}`);
  }
  return tarExtractionEntries(archivePath, entries, expectedRoot, policy.tarLinkPolicy);
}

function archiveEntries(archivePath) {
  return run("tar", ["-tzf", archivePath])
    .stdout.split(/\r?\n/u)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function safeZipExtractionEntries(archivePath, expectedRoot, adapter) {
  const entries = adapter.list(archivePath);
  if (!entries.some((entry) => archiveEntryInsideRoot(entry, expectedRoot))) {
    throw new Error(`archive must contain ${expectedRoot}`);
  }
  for (const entry of entries) {
    if (!archiveEntryInsideRoot(entry, expectedRoot)) {
      throw new Error(`archive entry escapes ${expectedRoot}`);
    }
  }
  return entries;
}

function archiveEntryInsideRoot(entry, expectedRoot) {
  const normalized = normalizeArchiveEntry(entry);
  return normalized === expectedRoot || normalized.startsWith(`${expectedRoot}/`);
}

// A plain backward scan replaces `/\/+$/u` (S8786): that regex is unanchored at the front, so an
// archive entry with a long run of `/` not at the very end (an attacker-controlled tar/zip entry
// name, here) forces the engine to retry the same O(n) backtrack at every position in that run —
// O(n^2) overall. Trailing-slash stripping never needs backtracking at all.
function stripTrailingSlashes(value) {
  let end = value.length;
  while (end > 0 && value.codePointAt(end - 1) === 47 /* '/' */) end -= 1;
  return value.slice(0, end);
}

function normalizeArchiveEntry(entry) {
  const normalized = stripTrailingSlashes(entry.replaceAll("\\", "/"));
  if (normalized.length === 0 || normalized.startsWith("/") || /^[A-Za-z]:/u.test(normalized)) {
    return "";
  }
  const parts = normalized.split("/");
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) return "";
  return normalized;
}

function tarExtractionEntries(archivePath, entries, expectedRoot, linkPolicy) {
  const lines = run("tar", ["-tvzf", archivePath]).stdout.split(/\r?\n/u).filter(Boolean);
  if (lines.length !== entries.length) fail("tar archive listing is inconsistent");
  const extractable = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const entry = entries[index];
    const type = line[0];
    if (type === "-") {
      extractable.push(entry);
    } else if (type === "d") {
      continue;
    } else if (type === "l" && linkPolicy === TAR_LINK_POLICY_SKIP_SAFE) {
      assertTarSymlinkTargetSafe(entry, line, expectedRoot);
    } else {
      fail("archive contains unsupported link or special-file entries");
    }
  }
  return extractable;
}

function assertTarSymlinkTargetSafe(entry, line, expectedRoot) {
  const marker = " -> ";
  const markerIndex = line.lastIndexOf(marker);
  if (markerIndex === -1) fail("tar symlink entry is missing target");
  const target = line.slice(markerIndex + marker.length);
  if (target.startsWith("/") || /^[A-Za-z]:/u.test(target)) {
    fail("archive symlink target escapes expected root");
  }
  const normalizedTarget = normalizeArchiveEntry(posix.join(posix.dirname(entry), target));
  if (!archiveEntryInsideRoot(normalizedTarget, expectedRoot)) {
    fail("archive symlink target escapes expected root");
  }
}

export function createPortableZipAdapter(platform = process.platform, commandRunner = run) {
  return platform === "win32" ? createNodeZipAdapter() : createInfoZipAdapter(commandRunner);
}

function createNodeZipAdapter() {
  return {
    list(archivePath) {
      return readZipArchiveEntries(archivePath).map((entry) => entry.name);
    },
    extract(archivePath, extractRoot) {
      extractZipArchiveEntries(archivePath, extractRoot);
    },
    create(sourceRoot, entryName, archivePath) {
      writeZipArchiveFromDirectory(join(sourceRoot, entryName), archivePath, {
        rootName: entryName,
        followSymlinks: true,
      });
    },
  };
}

function createInfoZipAdapter(commandRunner) {
  return {
    list(archivePath) {
      assertInfoZipEntryTypesSafe(archivePath, commandRunner);
      return commandRunner("unzip", ["-Z1", archivePath])
        .stdout.split(/\r?\n/u)
        .map((entry) => entry.trim())
        .filter(Boolean);
    },
    extract(archivePath, extractRoot) {
      commandRunner("unzip", ["-q", archivePath, "-d", extractRoot]);
    },
    create(sourceRoot, entryName, archivePath) {
      commandRunner("zip", ["-qr", archivePath, entryName], { cwd: sourceRoot });
    },
  };
}

function assertInfoZipEntryTypesSafe(archivePath, commandRunner) {
  const lines = commandRunner("unzip", ["-Z", "-l", archivePath]).stdout.split(/\r?\n/u);
  for (const line of lines) {
    if (!/^[dl-][rwx-]/u.test(line)) continue;
    const type = line[0];
    if (type === "d" || type === "-") continue;
    throw new Error("archive contains unsupported special-file entries");
  }
}

function copySafeTreeContents(sourceRoot, destinationRoot) {
  if (!existsSync(sourceRoot)) fail(`archive root not found at ${basename(sourceRoot)}`);
  mkdirSync(destinationRoot, { recursive: true });
  for (const entry of readdirSync(sourceRoot)) {
    copySafeEntry(join(sourceRoot, entry), join(destinationRoot, entry));
  }
}

function copySafeEntry(sourcePath, destinationPath) {
  const entry = lstatSync(sourcePath);
  if (entry.isDirectory()) {
    copySafeDirectory(sourcePath, destinationPath);
    return;
  }
  if (entry.isFile()) {
    copySafeFile(sourcePath, destinationPath, entry.nlink);
    return;
  }
  fail("archive contains unsupported special-file entries");
}

function copySafeDirectory(sourcePath, destinationPath) {
  mkdirSync(destinationPath, { recursive: true });
  for (const entry of readdirSync(sourcePath)) {
    copySafeEntry(join(sourcePath, entry), join(destinationPath, entry));
  }
}

function copySafeFile(sourcePath, destinationPath, linkCount) {
  if (linkCount > 1) fail("archive contains hardlinked file entries");
  mkdirSync(dirname(destinationPath), { recursive: true });
  copyFileSync(sourcePath, destinationPath);
}

function validateExtractedNodeRuntime(target, runtimeRoot) {
  const launcherPath = target.nodePlatform === "win32" ? "node.exe" : "bin/node";
  requireRuntimeFile(runtimeRoot, launcherPath);
  requireRuntimeFile(runtimeRoot, "LICENSE");
  requireRuntimeFile(runtimeRoot, "NOTICE");
}

function requireRuntimeFile(runtimeRoot, relativePath) {
  const path = join(runtimeRoot, relativePath);
  if (!existsSync(path) || !statSync(path).isFile()) {
    fail(`Node runtime must include ${relativePath}`);
  }
}

function validateStagedAppSurface(appRoot) {
  const failures = appSurfaceFailures(appRoot);
  if (failures.length > 0)
    fail(`packed app surface is incomplete:\n  - ${failures.join("\n  - ")}`);
}

function stageSidecarRuntimes(sidecarRuntimeSpecs, resourceRoot) {
  return sidecarRuntimeSpecs.map((spec) => stageSidecarRuntime(spec, resourceRoot));
}

function stageSidecarRuntime(spec, resourceRoot) {
  const destinationRoot = join(resourceRoot, ...spec.payloadRootPath.split("/"));
  copySafeTreeContents(spec.sourceRoot, destinationRoot);
  if (hashDirectoryTree(destinationRoot) !== spec.payloadSha256) {
    fail("copied sidecar payload digest does not match validated source payload");
  }
  requireRuntimeFile(resourceRoot, spec.executablePath);
  requireRuntimeFile(resourceRoot, spec.licenseEvidence.path);
  requireRuntimeFile(resourceRoot, spec.sbomEvidence.path);
  return sidecarManifestMetadata(spec);
}

function sidecarManifestMetadata(spec) {
  const metadata = { ...spec };
  delete metadata.sourceRoot;
  return metadata;
}

export function appSurfaceFailures(appRoot) {
  const failures = [];
  for (const file of REQUIRED_APP_SURFACE_FILES) {
    if (!existsSync(join(appRoot, file)) || !statSync(join(appRoot, file)).isFile()) {
      failures.push(`${file} is required`);
    }
  }
  validateStagedPackageJson(appRoot, failures);
  return failures;
}

function validateStagedPackageJson(appRoot, failures) {
  const packagePath = join(appRoot, "package.json");
  if (!existsSync(packagePath)) return;
  const stagedPackage = JSON.parse(readFileSync(packagePath, "utf8"));
  if (stagedPackage.name !== rootPackage.name) failures.push("package.json name must match root");
  if (stagedPackage.version !== rootPackage.version) {
    failures.push("package.json version must match root");
  }
}

function ensureRuntimeNotice(runtimeRoot, archive) {
  const noticePath = join(runtimeRoot, "NOTICE");
  if (existsSync(noticePath)) return;
  writeFileSync(
    noticePath,
    [
      "Keiko bundled Node.js runtime notice.",
      `Source archive: ${archive.fileName}`,
      `Source archive SHA-256: ${archive.sha256}`,
      "The upstream Node.js runtime license is included in LICENSE.",
      "",
    ].join("\n"),
  );
}

function payloadResourceRoot(target, payloadRoot) {
  if (target.nodePlatform === "darwin") {
    return join(payloadRoot, "Keiko.app", "Contents", "Resources");
  }
  return payloadRoot;
}

function payloadSupportRoot(payloadRoot) {
  return join(payloadRoot, "support");
}

async function resolveNodeArchive(options, target) {
  if (options.nodeArchive !== undefined) {
    return cacheLocalNodeArchive(options, target);
  }
  return downloadNodeArchive(options, target);
}

async function cacheLocalNodeArchive(options, target) {
  const { nodeArchive: path, nodeCacheDir: cacheDir, nodeSha256: sha256 } = options;
  assertNodeArchiveIdentity(path, target, options.nodeVersion);
  await verifySha256File(path, sha256);
  const cachePath = cacheArchivePath(cacheDir, sha256, basename(path));
  mkdirSync(dirname(cachePath), { recursive: true });
  copyFileSync(path, cachePath);
  await verifySha256File(cachePath, sha256);
  return {
    fileName: basename(cachePath),
    path: cachePath,
    sha256,
    source: "local-verified-archive",
  };
}

async function downloadNodeArchive(options, target) {
  const { nodeArchiveUrl: rawUrl, nodeCacheDir: cacheDir, nodeSha256: sha256 } = options;
  const url = validateNodeArchiveUrl(rawUrl, target, options.nodeVersion);
  const cachePath = cacheArchivePath(cacheDir, sha256, basename(url.pathname));
  if (existsSync(cachePath)) {
    assertNodeArchiveIdentity(cachePath, target, options.nodeVersion);
    await verifySha256File(cachePath, sha256);
    return {
      fileName: basename(cachePath),
      path: cachePath,
      sha256,
      source: "official-nodejs-url",
    };
  }
  await downloadVerifiedArchive(url, sha256, cachePath, target, options.nodeVersion);
  return { fileName: basename(cachePath), path: cachePath, sha256, source: "official-nodejs-url" };
}

async function downloadVerifiedArchive(url, sha256, cachePath, target, nodeVersion) {
  mkdirSync(dirname(cachePath), { recursive: true });
  const tempPath = `${cachePath}.${String(process.pid)}.tmp`;
  const response = await globalThis.fetch(url, {
    signal: globalThis.AbortSignal.timeout(NODE_ARCHIVE_TIMEOUT_MS),
  });
  await writeBoundedResponse(response, url.toString(), tempPath, target, nodeVersion);
  assertNodeArchiveIdentity(tempPath, target, nodeVersion, basename(cachePath));
  await verifySha256File(tempPath, sha256);
  renameSync(tempPath, cachePath);
}

async function writeBoundedResponse(response, requestedUrl, path, target, nodeVersion) {
  validateDownloadResponse(response, requestedUrl, target, nodeVersion);
  const contentLength = Number.parseInt(response.headers.get("content-length") ?? "0", 10);
  if (contentLength > NODE_ARCHIVE_MAX_BYTES) fail("Node archive download exceeds size limit");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength > NODE_ARCHIVE_MAX_BYTES) fail("Node archive download exceeds size limit");
  writeFileSync(path, bytes);
}

function cacheArchivePath(cacheDir, sha256, fileName) {
  return join(resolve(cacheDir), sha256, safeNodeArchiveFileName(fileName));
}

function safeNodeArchiveFileName(fileName) {
  if (fileName.length === 0 || fileName.includes("/") || fileName.includes("\\")) {
    fail("Node archive file name must be contained");
  }
  return fileName;
}

function validateNodeArchiveUrl(rawUrl, target, nodeVersion) {
  const url = new URL(rawUrl);
  if (url.protocol !== "https:") fail("--node-archive-url must use https");
  if (url.username.length > 0 || url.password.length > 0) {
    fail("--node-archive-url must not contain credentials");
  }
  if (!ALLOWED_NODE_ARCHIVE_HOSTS.has(url.hostname)) {
    fail("--node-archive-url must point to an official nodejs.org distribution host");
  }
  assertNodeArchiveName(basename(url.pathname), target, nodeVersion);
  return url;
}

function validateDownloadResponse(response, requestedUrl, target, nodeVersion) {
  if (!response.ok) {
    fail(`Node archive download failed for ${requestedUrl}: HTTP ${String(response.status)}`);
  }
  if (response.url !== requestedUrl) validateNodeArchiveUrl(response.url, target, nodeVersion);
}

function assertNodeArchiveIdentity(path, target, nodeVersion, fileName = basename(path)) {
  assertNodeArchiveName(fileName, target, nodeVersion);
  const size = statSync(path).size;
  if (size <= 0 || size > NODE_ARCHIVE_MAX_BYTES) fail("Node archive size is outside limits");
  assertNodeArchiveMagic(path, target);
}

function assertNodeArchiveName(fileName, target, nodeVersion) {
  const safeName = safeNodeArchiveFileName(fileName);
  const expected = expectedNodeArchiveFileName(target, nodeVersion);
  if (safeName !== expected) fail(`Node archive must be named ${expected}`);
}

function expectedNodeArchiveFileName(target, nodeVersion) {
  return `${expectedNodeArchiveRootName(target, nodeVersion)}.${target.nodeArchiveExtension}`;
}

function expectedNodeArchiveRootName(target, nodeVersion) {
  return `node-v${nodeVersion}-${target.nodeArchiveTarget}`;
}

function assertNodeArchiveMagic(path, target) {
  const header = readFileSync(path).subarray(0, 4);
  if (target.nodeArchiveExtension === "zip" && header[0] === 0x50 && header[1] === 0x4b) return;
  if (target.nodeArchiveExtension === "tar.gz" && header[0] === 0x1f && header[1] === 0x8b) return;
  fail(`Node archive bytes do not match ${target.nodeArchiveExtension}`);
}

function nativeHelperBuildScript(name) {
  return name === SECURE_READ_NAME
    ? "scripts/build-secure-workspace-read.mjs"
    : "scripts/build-runtime-supervisor.mjs";
}

function nativeHelperSbomComponent(helper) {
  return {
    type: "application",
    "bom-ref": helper.sbomBomRef,
    name: helper.name,
    version: rootPackage.version,
    licenses: [{ license: { id: "Apache-2.0" } }],
    hashes: [{ alg: "SHA-256", content: helper.shippedSha256 }],
    properties: [
      { name: "keiko:platform-target", value: helper.platformTarget },
      { name: "keiko:architecture", value: helper.architecture },
      { name: "keiko:source-commit", value: helper.source.commitSha },
      { name: "keiko:source-tree-sha256", value: helper.source.treeSha256 },
      { name: "keiko:unsigned-sha256", value: helper.unsignedSha256 },
      { name: "keiko:build-script", value: nativeHelperBuildScript(helper.name) },
      { name: "keiko:executable-path", value: helper.executablePath },
      { name: "keiko:protocol-request-magic", value: helper.protocol.requestMagic },
      { name: "keiko:protocol-response-magic", value: helper.protocol.responseMagic },
      { name: "keiko:protocol-schema-version", value: String(helper.protocol.schemaVersion) },
      { name: "keiko:source-path", value: helper.source.path },
    ],
  };
}

function nativeAddonSbomComponent(addon) {
  return {
    type: "library",
    "bom-ref": addon.sbomBomRef,
    name: addon.name,
    version: addon.version,
    purl: `pkg:npm/usearch@${addon.version}`,
    licenses: [{ license: { id: "Apache-2.0" } }],
    hashes: [{ alg: "SHA-256", content: addon.shippedSha256 }],
    externalReferences: [
      {
        type: "distribution",
        url: addon.source.tarballUrl,
        hashes: [{ alg: "SHA-256", content: addon.source.tarballSha256 }],
      },
    ],
    properties: [
      { name: "keiko:platform-target", value: addon.platformTarget },
      { name: "keiko:architecture", value: addon.architecture },
      { name: "keiko:source-commit", value: addon.source.commitSha },
      { name: "keiko:unsigned-sha256", value: addon.unsignedSha256 },
      { name: "keiko:executable-path", value: addon.executablePath },
      { name: "keiko:license-path", value: addon.licensePath },
    ],
  };
}

function sbomForManifest(manifest) {
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    version: 1,
    components: [
      ...manifest.nativeHelpers.map(nativeHelperSbomComponent),
      ...(manifest.nativeAddons ?? []).map(nativeAddonSbomComponent),
    ],
  };
}

function thirdPartyNotices(manifest) {
  const addon = manifest.nativeAddons[0];
  return [
    "Portable runtime notices are assembled by the release pipeline.",
    "",
    `USearch ${addon.version}`,
    "Copyright Unum Cloud and contributors.",
    "Licensed under Apache-2.0.",
    "The complete upstream license is included at runtime/licenses/usearch/LICENSE.",
    `Source: ${addon.source.tarballUrl}`,
    "",
  ].join("\n");
}

function writeEvidence(stageRoot, manifest, provenanceStatement) {
  const evidenceRoot = join(stageRoot, "evidence");
  mkdirSync(evidenceRoot, { recursive: true });
  writeFileSync(
    join(evidenceRoot, "SHA256SUMS.txt"),
    `${manifest.artifact.sha256}  ${manifest.artifact.assetName}\n`,
  );
  writeFileSync(
    join(evidenceRoot, "sbom.cdx.json"),
    JSON.stringify(sbomForManifest(manifest), null, 2) + "\n",
  );
  writeFileSync(join(evidenceRoot, "third-party-notices.txt"), thirdPartyNotices(manifest));
  writeFileSync(
    join(evidenceRoot, "signing-verification.json"),
    JSON.stringify(portableVerificationSummaryForManifest(manifest), null, 2) + "\n",
  );
  writeFileSync(join(evidenceRoot, "provenance.intoto.jsonl"), provenanceStatement);
}

function writeManifest(stageRoot, manifest) {
  mkdirSync(join(stageRoot, "manifest"), { recursive: true });
  writeFileSync(
    join(stageRoot, "manifest", "portable-manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
}

function provenanceStatementFor(
  options,
  target,
  digests,
  sidecarRuntimes,
  nativeHelpers,
  nativeAddons,
) {
  return (
    JSON.stringify({
      artifact: target.assetName,
      buildWorkflowAttempt: options.workflowRunAttempt ?? 0,
      buildWorkflowRunId: options.workflowRunId ?? 0,
      packageVersion: rootPackage.version,
      sourceCommitSha: options.commitSha,
      nativeHelpers: nativeHelpers.map((helper) => ({
        architecture: helper.architecture,
        executablePath: helper.executablePath,
        name: helper.name,
        shippedSha256: helper.shippedSha256,
        signatureKind: helper.signing.signatureKind,
        signatureVerified: helper.signing.signatureVerified,
        notarizationVerified: helper.signing.notarizationVerified,
        sourceTreeSha256: helper.source.treeSha256,
        unsignedSha256: helper.unsignedSha256,
      })),
      nativeAddons: nativeAddons.map((addon) => ({
        architecture: addon.architecture,
        executablePath: addon.executablePath,
        name: addon.name,
        shippedSha256: addon.shippedSha256,
        signatureKind: addon.signing.signatureKind,
        signatureVerified: addon.signing.signatureVerified,
        notarizationVerified: addon.signing.notarizationVerified,
        sourceCommitSha: addon.source.commitSha,
        tarballSha256: addon.source.tarballSha256,
        unsignedSha256: addon.unsignedSha256,
        version: addon.version,
      })),
      sidecarRuntimeNames: sidecarRuntimes.map((runtime) => runtime.name),
      subjectDigest: digests.assetSha256,
      target: target.platformTarget,
    }) + "\n"
  );
}

function createZipArchive(payloadContainer, assetName, outRoot) {
  const assetPath = join(outRoot, assetName);
  writeZipArchiveFromDirectory(join(payloadContainer, "Keiko"), assetPath, {
    followSymlinks: true,
    rootName: "Keiko",
  });
  if (!existsSync(assetPath)) fail(`expected ZIP asset at ${assetPath}`);
  return assetPath;
}

function launcherPath(target, stageRoot) {
  if (target.primaryLauncher === "Keiko.exe") return join(stageRoot, "Keiko.exe");
  return join(stageRoot, "Keiko.app", "Contents", "MacOS", "Keiko");
}

function stageLauncher(target, stageRoot, resourceRoot, options, hooks) {
  const path = launcherPath(target, stageRoot);
  mkdirSync(dirname(path), { recursive: true });
  (hooks.buildPrimaryLauncher ?? buildNativeLauncher)(target, path, options);
  chmodLauncher(path);
  if (target.nodePlatform === "darwin") {
    stageMacAppMetadata(target, stageRoot, resourceRoot);
  }
  stageSetupManifest(target, resourceRoot);
  stageSupportLauncher(target, stageRoot);
}

function secureReadExecutablePath(target) {
  return `runtime/native/${SECURE_READ_NAME}${target.nodePlatform === "win32" ? ".exe" : ""}`;
}

function stageSecureReadHelper(target, resourceRoot, options, hooks) {
  const executablePath = secureReadExecutablePath(target);
  const destination = join(resourceRoot, ...executablePath.split("/"));
  mkdirSync(dirname(destination), { recursive: true });
  (hooks.buildSecureReadHelper ?? buildSecureReadHelper)(target, destination);
  const entry = existsSync(destination) ? lstatSync(destination) : undefined;
  if (entry === undefined || !entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) {
    fail("secure workspace read helper build did not produce the fixed executable");
  }
  chmodLauncher(destination);
  const unsignedSha256 = createHash("sha256").update(readFileSync(destination)).digest("hex");
  return nativeHelperMetadata({
    executablePath,
    kind: "secure-workspace-text-read",
    name: SECURE_READ_NAME,
    options,
    protocol: { schemaVersion: 1, requestMagic: "KSR1", responseMagic: "KSS1" },
    sourcePath: "native/secure-workspace-read",
    sourceRoot: SECURE_READ_SOURCE_ROOT,
    target,
    unsignedSha256,
    sizeBytes: entry.size,
  });
}

function provisionedUsearchRuntime(target) {
  const targetKey = usearchRuntimeTargetKey(target.nodePlatform, target.nodeArchitecture);
  if (targetKey === undefined) fail("USearch has no approved runtime for the portable target");
  const approved = usearchRuntimeApproval(targetKey);
  if (approved === undefined) fail("USearch has no approved runtime for the portable target");
  const provisionedRoot = join(repoRoot, ".usearch", approved.version, targetKey);
  const sourceBinary = join(provisionedRoot, "usearch.node");
  const sourceLicense = join(provisionedRoot, "LICENSE");
  if (
    !existsSync(sourceBinary) ||
    !existsSync(sourceLicense) ||
    sha256(readFileSync(sourceBinary)) !== approved.binarySha256 ||
    sha256(readFileSync(sourceLicense)) !== approved.licenseSha256
  ) {
    fail("USearch runtime is absent or failed its pinned digest");
  }
  return { approved, sourceBinary, sourceLicense };
}

function stageUsearchFiles(resourceRoot, runtime, copyFile) {
  const executablePath = "runtime/native/usearch.node";
  const licensePath = "runtime/licenses/usearch/LICENSE";
  const destination = join(resourceRoot, ...executablePath.split("/"));
  const licenseDestination = join(resourceRoot, ...licensePath.split("/"));
  mkdirSync(dirname(destination), { recursive: true });
  mkdirSync(dirname(licenseDestination), { recursive: true });
  copyFile(runtime.sourceBinary, destination);
  copyFile(runtime.sourceLicense, licenseDestination);
  chmodLauncher(destination);
  return { destination, executablePath, licensePath };
}

function failUsearchStaging(onFailure, message) {
  onFailure(message);
  throw new Error("portable USearch staging aborted");
}

export function stageUsearchAddon(
  target,
  resourceRoot,
  {
    copyFile = copyFileSync,
    onFailure = fail,
    resolveRuntime = provisionedUsearchRuntime,
    evaluation = false,
  } = {},
) {
  const runtime = resolveRuntime(target);
  const staged = stageUsearchFiles(resourceRoot, runtime, copyFile);
  const shippedSha256 = sha256(readFileSync(staged.destination));
  if (shippedSha256 !== runtime.approved.binarySha256) {
    return failUsearchStaging(
      onFailure,
      "USearch staged runtime failed its platform-pinned digest",
    );
  }
  return [
    {
      name: "usearch",
      kind: "node-native-addon",
      version: runtime.approved.version,
      platformTarget: target.platformTarget,
      architecture: target.nodeArchitecture,
      executablePath: staged.executablePath,
      licensePath: staged.licensePath,
      source: {
        commitSha: runtime.approved.sourceCommit,
        tarballUrl: runtime.approved.tarballUrl,
        tarballSha256: runtime.approved.tarballSha256,
        binarySha256: runtime.approved.binarySha256,
        licenseSha256: runtime.approved.licenseSha256,
      },
      unsignedSha256: runtime.approved.binarySha256,
      shippedSha256,
      sizeBytes: lstatSync(staged.destination).size,
      sbomBomRef: `pkg:npm/usearch@${runtime.approved.version}?platform=${target.platformTarget}`,
      signing: {
        signatureKind: target.signatureKind,
        verificationStatus: nativeHelperStagingStatus(evaluation),
        signatureVerified: false,
        notarizationRequired: target.nodePlatform === "darwin",
        notarizationVerified: false,
      },
    },
  ];
}

function buildSecureReadHelper(target, destination) {
  run(process.execPath, [
    join(repoRoot, "scripts", "build-secure-workspace-read.mjs"),
    target.platformTarget,
    destination,
  ]);
}

function runtimeSupervisorSource(target) {
  const platform = target.nodePlatform === "win32" ? "windows" : "macos";
  return {
    path: `native/runtime-supervisor/${platform}`,
    root: join(repoRoot, "native", "runtime-supervisor", platform),
  };
}

function runtimeSupervisorExecutablePath(target) {
  return `runtime/native/${RUNTIME_SUPERVISOR_NAME}${target.nodePlatform === "win32" ? ".exe" : ""}`;
}

function stageRuntimeSupervisor(target, resourceRoot, options, hooks) {
  const executablePath = runtimeSupervisorExecutablePath(target);
  const destination = join(resourceRoot, ...executablePath.split("/"));
  mkdirSync(dirname(destination), { recursive: true });
  (hooks.buildRuntimeSupervisor ?? buildRuntimeSupervisor)(target, destination);
  const entry = existsSync(destination) ? lstatSync(destination) : undefined;
  if (entry === undefined || !entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) {
    fail("runtime supervisor build did not produce the fixed executable");
  }
  chmodLauncher(destination);
  if (target.nodePlatform === "darwin") validateMacosRuntimeSupervisorSurface(destination);
  const unsignedSha256 = createHash("sha256").update(readFileSync(destination)).digest("hex");
  const source = runtimeSupervisorSource(target);
  return nativeHelperMetadata({
    executablePath,
    kind: "runtime-process-supervisor",
    name: RUNTIME_SUPERVISOR_NAME,
    options,
    protocol: { schemaVersion: 1, requestMagic: "KRP1", responseMagic: "KRS1" },
    sourcePath: source.path,
    sourceRoot: source.root,
    target,
    unsignedSha256,
    sizeBytes: entry.size,
  });
}

function validateMacosRuntimeSupervisorSurface(supervisor) {
  const appRoot = resolve(dirname(supervisor), "../../../..");
  const required = [
    join(appRoot, "Contents", "MacOS", "KeikoSystemExtensionManager"),
    join(
      appRoot,
      "Contents",
      "Library",
      "SystemExtensions",
      MACOS_SYSTEM_EXTENSION_ID,
      "Contents",
      "MacOS",
      "KeikoRuntimeMonitor",
    ),
    join(
      appRoot,
      "Contents",
      "Library",
      "SystemExtensions",
      MACOS_SYSTEM_EXTENSION_ID,
      "Contents",
      "Info.plist",
    ),
  ];
  for (const path of required) {
    const entry = existsSync(path) ? lstatSync(path) : undefined;
    if (entry === undefined || !entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) {
      fail("macOS Endpoint Security runtime surface is incomplete");
    }
  }
  chmodLauncher(required[0]);
  chmodLauncher(required[1]);
}

function nativeHelperMetadata(input) {
  return {
    name: input.name,
    kind: input.kind,
    platformTarget: input.target.platformTarget,
    architecture: input.target.nodeArchitecture,
    executablePath: input.executablePath,
    protocol: input.protocol,
    source: {
      commitSha: input.options.commitSha,
      path: input.sourcePath,
      treeSha256: hashDirectoryTree(input.sourceRoot),
    },
    unsignedSha256: input.unsignedSha256,
    shippedSha256: input.unsignedSha256,
    sizeBytes: input.sizeBytes,
    sbomBomRef: `pkg:generic/${input.name}@${rootPackage.version}?platform=${input.target.platformTarget}`,
    signing: {
      signatureKind: input.target.signatureKind,
      verificationStatus: nativeHelperStagingStatus(input.options.evaluation === true),
      signatureVerified: false,
      notarizationRequired: input.target.nodePlatform === "darwin",
      notarizationVerified: false,
    },
  };
}

function buildRuntimeSupervisor(target, destination) {
  run(process.execPath, [
    join(repoRoot, "scripts", "build-runtime-supervisor.mjs"),
    target.platformTarget,
    destination,
  ]);
}

function stageMacAppMetadata(target, stageRoot, resourceRoot) {
  requireMacAppIconSource();
  mkdirSync(resourceRoot, { recursive: true });
  writeFileSync(join(stageRoot, "Keiko.app", "Contents", "Info.plist"), macInfoPlist(target));
  copyFileSync(MAC_APP_ICON_SOURCE, join(resourceRoot, MAC_APP_ICON_FILE));
}

function requireMacAppIconSource() {
  if (!existsSync(MAC_APP_ICON_SOURCE) || !statSync(MAC_APP_ICON_SOURCE).isFile()) {
    fail("portable macOS app icon is required");
  }
}

function buildNativeLauncher(target, destination, options) {
  if (options.launcherBinary !== undefined) {
    copyFileSync(resolve(options.launcherBinary), destination);
    return;
  }
  if (target.nodePlatform === "darwin" && process.platform === "darwin") {
    compileMacLauncher(target, destination);
    return;
  }
  if (target.nodePlatform === "win32" && process.platform === "win32") {
    compileWindowsLauncher(target, destination);
    return;
  }
  fail(
    `pass --launcher-binary for ${target.platformTarget}, or run portable staging on a native ${target.nodePlatform} builder`,
  );
}

function chmodLauncher(path) {
  try {
    chmodSync(path, 0o755);
  } catch {
    // Best-effort on Windows.
  }
}

function nativeLauncherSource() {
  return join(repoRoot, "native", "portable-launcher", "keiko-portable-launcher.c");
}

function windowsLauncherResourceSource() {
  return WINDOWS_LAUNCHER_RESOURCE_SOURCE;
}

function nativeLauncherTargetDefine(target) {
  return `KEIKO_PORTABLE_TARGET="${target.platformTarget}"`;
}

function macCompilerArch(target) {
  return target.nodeArchitecture === "arm64" ? "arm64" : "x86_64";
}

function compileMacLauncher(target, destination) {
  run("cc", [
    "-Os",
    "-Wall",
    "-Wextra",
    "-arch",
    macCompilerArch(target),
    `-D${nativeLauncherTargetDefine(target)}`,
    nativeLauncherSource(),
    "-o",
    destination,
  ]);
}

// Resolves the MSVC toolchain environment for the rc/cl launcher compile. The staging script
// owns its toolchain instead of depending on a workflow step (or a developer) having persisted
// vcvars into the process environment: a plain shell resolves Visual Studio through the fixed
// vswhere installer path and imports the single-line vcvars64 variables; a Developer Command
// Prompt (INCLUDE and LIB already present) is used as-is. Fails closed when no toolchain exists.
function locateVisualStudioInstallation(baseEnv) {
  const programFiles = baseEnv["ProgramFiles(x86)"] ?? String.raw`C:\Program Files (x86)`;
  const vswhere = join(programFiles, "Microsoft Visual Studio", "Installer", "vswhere.exe");
  if (!existsSync(vswhere)) {
    fail("MSVC toolchain not found: install the Visual Studio C++ Build Tools (vswhere missing)");
  }
  const located = spawnSync(
    vswhere,
    [
      "-latest",
      "-products",
      "*",
      "-requires",
      "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
      "-property",
      "installationPath",
    ],
    { encoding: "utf8" },
  );
  const installationPath = located.stdout?.trim().split(/\r?\n/u)[0] ?? "";
  if (located.status !== 0 || installationPath === "") {
    fail("MSVC toolchain not found: Visual Studio C++ Build Tools are not installed");
  }
  return installationPath;
}

function importVcvarsEnvironment(baseEnv, installationPath) {
  const vcvars = join(installationPath, "VC", "Auxiliary", "Build", "vcvars64.bat");
  const systemRoot = baseEnv.SystemRoot ?? baseEnv.WINDIR ?? String.raw`C:\Windows`;
  const dump = spawnSync(
    join(systemRoot, "System32", "cmd.exe"),
    ["/d", "/s", "/c", `""${vcvars}" >nul && set"`],
    { encoding: "utf8", windowsVerbatimArguments: true },
  );
  if (dump.status !== 0) fail("MSVC environment initialization failed (vcvars64)");
  const resolved = { ...baseEnv };
  for (const line of dump.stdout.split(/\r?\n/u)) {
    const separator = line.indexOf("=");
    if (separator > 0) resolved[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return resolved;
}

export function resolveWindowsMsvcEnv(baseEnv = process.env) {
  if (baseEnv.INCLUDE !== undefined && baseEnv.LIB !== undefined) return baseEnv;
  const resolved = importVcvarsEnvironment(baseEnv, locateVisualStudioInstallation(baseEnv));
  if (resolved.INCLUDE === undefined || resolved.LIB === undefined) {
    fail("MSVC environment initialization did not define INCLUDE and LIB");
  }
  return resolved;
}

// Child-process PATH search does not reliably honour an options.env PATH, so the two MSVC tools
// are located explicitly on the resolved toolchain PATH and spawned by absolute path.
function windowsToolFromPath(envPath, tool) {
  for (const dir of (envPath ?? "").split(";")) {
    if (dir === "") continue;
    const candidate = join(dir, tool);
    if (existsSync(candidate)) return candidate;
  }
  return fail(`MSVC tool ${tool} was not found on the resolved toolchain PATH`);
}

function compileWindowsLauncher(target, destination) {
  requireWindowsLauncherIconSource();
  const env = resolveWindowsMsvcEnv();
  const tempRoot = mkdtempSync(join(tmpdir(), "keiko-windows-launcher-resource-"));
  try {
    const resourcePath = join(tempRoot, "keiko-portable-launcher.res");
    run(
      windowsToolFromPath(env.PATH, "rc.exe"),
      ["/nologo", `/fo${resourcePath}`, windowsLauncherResourceSource()],
      { env },
    );
    run(
      windowsToolFromPath(env.PATH, "cl.exe"),
      [
        "/nologo",
        "/O2",
        "/DUNICODE",
        "/D_UNICODE",
        `/D${nativeLauncherTargetDefine(target)}`,
        `/Fe:${destination}`,
        nativeLauncherSource(),
        resourcePath,
        "/link",
        "/SUBSYSTEM:WINDOWS",
        "/ENTRY:wmainCRTStartup",
      ],
      { env },
    );
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

function requireWindowsLauncherIconSource() {
  if (
    !existsSync(WINDOWS_LAUNCHER_ICON_SOURCE) ||
    !statSync(WINDOWS_LAUNCHER_ICON_SOURCE).isFile()
  ) {
    fail("portable Windows launcher icon is required");
  }
  if (
    !existsSync(WINDOWS_LAUNCHER_RESOURCE_SOURCE) ||
    !statSync(WINDOWS_LAUNCHER_RESOURCE_SOURCE).isFile()
  ) {
    fail("portable Windows launcher resource is required");
  }
}

function stageSupportLauncher(target, stageRoot) {
  const supportRoot = payloadSupportRoot(stageRoot);
  mkdirSync(supportRoot, { recursive: true });
  if (target.nodePlatform === "win32") {
    writeFileSync(
      join(supportRoot, "keiko-support.cmd"),
      '@echo off\r\nset "SCRIPT_DIR=%~dp0"\r\n"%SCRIPT_DIR%..\\Keiko.exe" %*\r\n',
    );
    return;
  }
  const scriptPath = join(supportRoot, "keiko-support.sh");
  writeFileSync(
    scriptPath,
    [
      "#!/bin/sh",
      'SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)',
      'exec "$SCRIPT_DIR/../Keiko.app/Contents/MacOS/Keiko" "$@"',
      "",
    ].join("\n"),
  );
  chmodLauncher(scriptPath);
}

function stageSetupManifest(target, resourceRoot) {
  const manifestRoot = join(resourceRoot, ".portable");
  mkdirSync(manifestRoot, { recursive: true });
  writeFileSync(
    join(manifestRoot, "setup-manifest.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        platformTarget: target.platformTarget,
        packageName: rootPackage.name,
        packageVersion: rootPackage.version,
        stable: !rootPackage.version.includes("-"),
        primaryLauncher: target.primaryLauncher,
        bootstrapUpdateEligible: false,
        runtime: {
          nodePlatform: target.nodePlatform,
          nodeArchitecture: target.nodeArchitecture,
        },
      },
      null,
      2,
    ) + "\n",
  );
}

function macInfoPlist(target) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>CFBundleExecutable</key>",
    "  <string>Keiko</string>",
    "  <key>CFBundleIdentifier</key>",
    `  <string>dev.oscharko.keiko.${target.platformTarget}</string>`,
    "  <key>CFBundleIconFile</key>",
    `  <string>${MAC_APP_ICON_FILE}</string>`,
    "  <key>CFBundleInfoDictionaryVersion</key>",
    "  <string>6.0</string>",
    "  <key>CFBundleName</key>",
    "  <string>Keiko</string>",
    "  <key>CFBundlePackageType</key>",
    "  <string>APPL</string>",
    "  <key>CFBundleShortVersionString</key>",
    `  <string>${rootPackage.version}</string>`,
    "  <key>CFBundleVersion</key>",
    `  <string>${rootPackage.version}</string>`,
    "  <key>NSSystemExtensionUsageDescription</key>",
    "  <string>Keiko uses its runtime monitor to contain Coding Workbench processes and stop their descendants safely.</string>",
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

function manifestProduct() {
  return {
    name: "Keiko",
    packageName: rootPackage.name,
    packageVersion: rootPackage.version,
  };
}

function manifestRelease(options) {
  return {
    releaseId: options.releaseId,
    releaseTag: options.releaseTag,
    stable: !rootPackage.version.includes("-"),
    commitSha: options.commitSha,
  };
}

function manifestArtifact(options, target, digests) {
  return {
    platformTarget: target.platformTarget,
    assetId: STAGING_ASSET_ID_UNAVAILABLE,
    assetName: target.assetName,
    archiveFormat: "zip",
    sizeBytes: digests.sizeBytes,
    sha256: digests.assetSha256,
  };
}

function manifestProvenance(options, digests) {
  return {
    sourceCommitSha: options.commitSha,
    rootPackageVersion: rootPackage.version,
    rootPackageTarballSha256: digests.tarballSha256,
    packagedAppTreeSha256: digests.appTreeSha256,
    buildWorkflowRunId: options.workflowRunId ?? 0,
    buildWorkflowAttempt: options.workflowRunAttempt ?? 0,
    provenanceStatementPath: "evidence/provenance.intoto.jsonl",
    provenanceStatementSha256: digests.provenanceSha256,
  };
}

function manifestRuntime(options, target, digests) {
  return {
    nodeVersion: options.nodeVersion,
    nodePlatform: target.nodePlatform,
    nodeArchitecture: target.nodeArchitecture,
    nodeDistribution: "official-nodejs-dist",
    nodeArchiveSha256: digests.nodeArchiveSha256,
  };
}

function manifestPackageSurface() {
  return {
    source: "root-npm-package-surface",
    packageSurfaceGate: "npm run check:package-surface",
    publishManifestGate: "npm run check:publish-manifests",
    workspaceSupplyChainGate: "npm run check:workspace-supply-chain",
  };
}

function manifestInstallLayout() {
  return {
    installMode: "portable-managed",
    bootstrapUpdateEligible: false,
    managedRootKind: "user-local-keiko-owned",
    sameVolumeStagingRequired: true,
    stateRootPolicy: "separate-local-runtime-state",
  };
}

function manifestStateExclusion() {
  return {
    excludesDotKeiko: true,
    excludesCustomerData: true,
    excludesSecrets: true,
    excludesRawLogs: true,
    excludesRepositories: true,
  };
}

function manifestSecurity(target, evaluation) {
  return {
    ...stageVerificationLane(evaluation),
    signatureKind: target.signatureKind,
    signatureVerified: false,
    notarizationRequired: target.nodePlatform === "darwin",
    notarizationVerified: false,
    verificationChecks: createPortableVerificationChecks(target.platformTarget, false),
    verificationSummaryPath: "evidence/signing-verification.json",
  };
}

function manifestEvidence() {
  return {
    checksumsPath: "evidence/SHA256SUMS.txt",
    sbomPath: "evidence/sbom.cdx.json",
    licenseNoticePath: "evidence/third-party-notices.txt",
  };
}

function manifestReviewedBinding(input) {
  const {
    options,
    target,
    digests,
    nodeIdentity,
    security,
    sidecarRuntimes,
    nativeHelpers,
    nativeAddons,
  } = input;
  const binding = {
    releaseId: options.releaseId,
    releaseTag: options.releaseTag,
    assetId: STAGING_ASSET_ID_UNAVAILABLE,
    assetName: target.assetName,
    assetSizeBytes: digests.sizeBytes,
    platformTarget: target.platformTarget,
    packageVersion: rootPackage.version,
    nodeRuntimeIdentity: nodeIdentity,
    archiveSha256: digests.assetSha256,
    provenanceStatementSha256: digests.provenanceSha256,
    sbomPath: "evidence/sbom.cdx.json",
    licenseNoticePath: "evidence/third-party-notices.txt",
    checksumsPath: "evidence/SHA256SUMS.txt",
    verificationPolicy: security.verificationPolicy,
    verificationStatus: security.verificationStatus,
    verificationReasonCodes: security.verificationReasonCodes,
    platformSignatureLocallyVerified: false,
    signatureKind: security.signatureKind,
    signatureVerified: security.signatureVerified,
    notarizationRequired: security.notarizationRequired,
    notarizationVerified: security.notarizationVerified,
    verificationChecks: security.verificationChecks,
  };
  if (sidecarRuntimes.length > 0) binding.sidecarRuntimes = cloneJson(sidecarRuntimes);
  binding.nativeHelpers = cloneJson(nativeHelpers);
  binding.nativeAddons = cloneJson(nativeAddons);
  return binding;
}

function manifestReleaseImpact(input) {
  const { options } = input;
  return {
    catalogPath: "app/release-impact.catalog.json",
    entryId: input.releaseImpactEntry.id,
    entryPackageVersion: rootPackage.version,
    entryReleaseTag: options.releaseTag,
    reviewedBinding: manifestReviewedBinding(input),
  };
}

function manifestUpdateEligibility() {
  return {
    stableOnly: true,
    rollbackSupported: false,
    eligibleAfterSetupOnly: true,
    requiredPredicates: {
      managedRootAttested: true,
      artifactShaVerified: true,
      platformSignatureLocallyVerified: false,
      manifestReleaseImpactBound: true,
      sameVolumeCrashSafePromotionAvailable: true,
      relaunchVersionVerificationAvailable: true,
    },
    manualOnlyWhen: [
      "managed-root-cannot-be-attested",
      "signature-or-notarization-cannot-be-verified",
      "crash-safe-promotion-unavailable",
      "admin-or-organization-managed-root",
      "prerelease-beta-downgrade-or-rollback",
    ],
  };
}

function manifestFor(
  options,
  target,
  digests,
  sidecarRuntimes = [],
  nativeHelpers = [],
  nativeAddons = [],
) {
  const assetSha = digests.assetSha256;
  const nodeIdentity = `node-v${options.nodeVersion}-${target.runtimeTarget}`;
  const security = manifestSecurity(target, options.evaluation === true);
  const releaseImpactEntry = reviewedReleaseImpactEntry(options);
  const manifest = {
    schemaVersion: 1,
    product: manifestProduct(),
    release: manifestRelease(options),
    artifact: manifestArtifact(options, target, { ...digests, assetSha256: assetSha }),
    provenance: manifestProvenance(options, digests),
    runtime: manifestRuntime(options, target, digests),
    nativeHelpers,
    nativeAddons,
    packageSurface: manifestPackageSurface(),
    entrypoints: {
      primaryLauncher: target.primaryLauncher,
      supportLaunchers: supportLaunchersFor(target),
    },
    installLayout: manifestInstallLayout(),
    stateExclusion: manifestStateExclusion(),
    security,
    evidence: manifestEvidence(),
    releaseImpact: manifestReleaseImpact({
      options,
      target,
      digests: { ...digests, assetSha256: assetSha },
      nodeIdentity,
      security,
      releaseImpactEntry,
      sidecarRuntimes,
      nativeHelpers,
      nativeAddons,
    }),
    updateEligibility: manifestUpdateEligibility(),
  };
  if (sidecarRuntimes.length > 0) manifest.sidecarRuntimes = sidecarRuntimes;
  return manifest;
}

function cloneJson(value) {
  return structuredClone(value);
}

function supportLaunchersFor(target) {
  return target.nodePlatform === "win32"
    ? ["support/keiko-support.cmd"]
    : ["support/keiko-support.sh"];
}

function reviewedReleaseImpactEntry(options) {
  const entries = Array.isArray(releaseImpactCatalog.entries) ? releaseImpactCatalog.entries : [];
  const matches = entries.filter((candidate) => releaseImpactEntryMatches(candidate, options));
  if (matches.length !== 1) {
    fail("release-impact catalog must contain exactly one reviewed portable runtime staging entry");
  }
  return matches[0];
}

function releaseImpactEntryMatches(entry, options) {
  return (
    entry.packageName === rootPackage.name &&
    entry.packageVersion === rootPackage.version &&
    entry.releaseTag === options.releaseTag &&
    entry.review?.status === "reviewed" &&
    entry.review?.humanApproved === true &&
    portableRuntimeContractMatches(entry.portableRuntimeArtifactContract)
  );
}

function portableRuntimeContractMatches(contract) {
  return (
    contract !== null &&
    typeof contract === "object" &&
    contract.issue === PORTABLE_RELEASE_IMPACT_CONTRACT.issue &&
    contract.parentEpic === PORTABLE_RELEASE_IMPACT_CONTRACT.parentEpic &&
    contract.programEpic === PORTABLE_RELEASE_IMPACT_CONTRACT.programEpic &&
    contract.stagingOnly === PORTABLE_RELEASE_IMPACT_CONTRACT.stagingOnly &&
    sameStringSet(contract.targets, PORTABLE_RELEASE_IMPACT_CONTRACT.targets)
  );
}

function sameStringSet(actual, expected) {
  if (!Array.isArray(actual) || actual.length !== expected.length) return false;
  const actualSet = new Set(actual);
  return actualSet.size === expected.length && expected.every((value) => actualSet.has(value));
}

export async function assemblePortableStage(options, hooks = {}) {
  const target = portableTargetByName(options.target);
  const sidecarSpecs = normalizeSidecarRuntimeSpecs(
    options.sidecarRuntimeSpecs ?? [],
    target,
    options.evaluation === true,
  );
  const tmp = mkdtempSync(join(tmpdir(), "keiko-portable-stage-"));
  const paths = portableStagePaths(tmp, target, options);
  rmSync(paths.finalRoot, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  try {
    const result = await assembleStageRoot(options, hooks, target, sidecarSpecs, paths);
    promoteStageRoot(options, paths);
    return { finalRoot: paths.finalRoot, manifest: result.manifest, tarball: result.tarball };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function portableStagePaths(tmp, target, options) {
  const stageRoot = join(tmp, "stage", target.platformTarget);
  const payloadContainer = join(stageRoot, "payload");
  const payloadRoot = join(payloadContainer, "Keiko");
  return {
    extractRoot: join(tmp, "extract"),
    finalRoot: resolve(options.outDir, target.platformTarget),
    payloadContainer,
    payloadRoot,
    resourceRoot: payloadResourceRoot(target, payloadRoot),
    stageRoot,
  };
}

async function assembleStageRoot(options, hooks, target, sidecarSpecs, paths) {
  mkdirSync(paths.extractRoot, { recursive: true });
  mkdirSync(paths.resourceRoot, { recursive: true });
  const nodeArchiveSha256 = await stageNodeRuntime(options, target, paths.resourceRoot);
  (hooks.preparePackageSurface ?? preparePackageSurface)();
  const tarball = packRoot(dirname(paths.extractRoot));
  stagePackedPackage(tarball, paths.extractRoot, paths.resourceRoot);
  bindMacosReleaseTeamIdentifier(join(paths.resourceRoot, "app"), target, options.appleTeamId);
  stageLauncher(target, paths.payloadRoot, paths.resourceRoot, options, hooks);
  const nativeHelpers = [
    stageSecureReadHelper(target, paths.resourceRoot, options, hooks),
    stageRuntimeSupervisor(target, paths.resourceRoot, options, hooks),
  ];
  const nativeAddons = (hooks.stageUsearchAddon ?? stageUsearchAddon)(target, paths.resourceRoot, {
    evaluation: options.evaluation === true,
  });
  const sidecarRuntimes = stageSidecarRuntimes(sidecarSpecs, paths.resourceRoot);
  const staged = {
    nodeArchiveSha256,
    sidecarRuntimes,
    nativeHelpers,
    nativeAddons,
  };
  const firstPass = await manifestInputFor(options, target, paths, tarball, staged);
  const firstActivation = writeRuntimeActivationManifest(paths.resourceRoot, firstPass.manifest);
  sealMacosAppBundle(target, paths.payloadRoot, hooks);
  const manifestInput = await manifestInputFor(options, target, paths, tarball, staged);
  const finalActivation = writeRuntimeActivationManifest(
    paths.resourceRoot,
    manifestInput.manifest,
  );
  if (target.nodePlatform === "darwin" && firstActivation.sha256 !== finalActivation.sha256) {
    fail("runtime activation manifest changed after the app bundle was sealed");
  }
  verifyMacosAppBundleSeal(target, paths.payloadRoot, hooks);
  writeEvidence(paths.stageRoot, manifestInput.manifest, manifestInput.provenanceStatement);
  writeManifest(paths.stageRoot, manifestInput.manifest);
  validateGeneratedManifest(manifestInput.manifest, options.evaluation === true);
  return { manifest: manifestInput.manifest, tarball };
}

async function manifestInputFor(options, target, paths, tarball, staged) {
  const assetPath = createZipArchive(paths.payloadContainer, target.assetName, paths.stageRoot);
  const assetSha256 = await sha256File(assetPath);
  const provenanceStatement = provenanceStatementFor(
    options,
    target,
    { assetSha256 },
    staged.sidecarRuntimes,
    staged.nativeHelpers,
    staged.nativeAddons,
  );
  const provenanceSha256 = sha256(provenanceStatement);
  return {
    manifest: manifestFor(
      options,
      target,
      {
        appTreeSha256: hashDirectoryTree(join(paths.resourceRoot, "app")),
        assetSha256,
        nodeArchiveSha256: staged.nodeArchiveSha256,
        provenanceSha256,
        sizeBytes: statSync(assetPath).size,
        tarballSha256: await sha256File(tarball),
      },
      staged.sidecarRuntimes,
      staged.nativeHelpers,
      staged.nativeAddons,
    ),
    provenanceStatement,
  };
}

/**
 * Seals the assembled macOS app bundle with an ad-hoc code signature. Every Mach-O inside the
 * bundle is already individually signed (linker ad-hoc at minimum), but Gatekeeper judges the
 * BUNDLE: a bundle whose main executable carries a signature while the bundle has no resource
 * seal is reported as "damaged", and macOS then offers no "Open Anyway" approval path at all —
 * the one journey an unsigned evaluation download depends on (ADR-0163 D9). The ad-hoc seal
 * asserts no author; it makes the bundle internally consistent so the platform can offer its
 * normal unidentified-developer approval. The Developer ID lane later replaces this seal with
 * the real one (`codesign --force` in run-macos-portable-signing.sh), so sealing here is safe
 * for every lane. The seal must cover the final runtime-activation manifest, so it runs after
 * that write and before the shipped ZIP is created.
 */
function sealMacosAppBundle(target, payloadRoot, hooks) {
  if (target.nodePlatform !== "darwin") return;
  const appRoot = join(payloadRoot, "Keiko.app");
  if (hooks.sealMacosAppBundle !== undefined) {
    hooks.sealMacosAppBundle(appRoot);
    return;
  }
  requireDarwinBuilder(target, "sealing");
  // Inside-out, nested code first. The arm64 linker ad-hoc signs every Mach-O at link time, but
  // the x86_64 one does not, and codesign refuses to seal a bundle over unsigned subcomponents —
  // measured on macos-15-intel: "code object is not signed at all — In subcomponent:
  // …/KeikoSystemExtensionManager". Signing these two here is digest-safe: they are bound by the
  // outer seal and the install-time identity, both computed after this step, and NOT by the
  // nativeHelpers digests, which cover only the supervisor executable staged under Resources.
  run("/usr/bin/codesign", [
    "--force",
    "--sign",
    "-",
    join(appRoot, "Contents", "Library", "SystemExtensions", MACOS_SYSTEM_EXTENSION_ID),
  ]);
  run("/usr/bin/codesign", [
    "--force",
    "--sign",
    "-",
    join(appRoot, "Contents", "MacOS", "KeikoSystemExtensionManager"),
  ]);
  run("/usr/bin/codesign", ["--force", "--sign", "-", appRoot]);
}

/**
 * The platform's own verifier is the fail-closed assert that nothing mutated the bundle after the
 * seal: a divergent activation rewrite, a stray staging write, or a broken nested signature all
 * fail `--verify --deep --strict`, and a bundle that fails it here would have shown the beta.0
 * "damaged" dead end on the first customer double-click.
 */
function verifyMacosAppBundleSeal(target, payloadRoot, hooks) {
  if (target.nodePlatform !== "darwin") return;
  const appRoot = join(payloadRoot, "Keiko.app");
  if (hooks.verifyMacosAppBundleSeal !== undefined) {
    hooks.verifyMacosAppBundleSeal(appRoot);
    return;
  }
  requireDarwinBuilder(target, "seal verification");
  run("/usr/bin/codesign", ["--verify", "--deep", "--strict", appRoot]);
}

function requireDarwinBuilder(target, step) {
  if (process.platform !== "darwin") {
    fail(
      `${step} for ${target.platformTarget} requires a native darwin builder or an injected hook`,
    );
  }
}

function validateGeneratedManifest(manifest, evaluation) {
  const failures = evaluation
    ? validatePortableEvaluationManifest(manifest)
    : validatePortableStagingManifest(manifest);
  if (failures.length > 0) fail(`generated manifest is invalid:\n  - ${failures.join("\n  - ")}`);
}

export function isCrossDeviceError(error) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "EXDEV" || error.code === "ENOTSUP")
  );
}

// Windows CI stages under the OS temp drive (C:) but promotes into the workspace checkout (D:),
// so a same-filesystem rename fails with EXDEV. Fall back to a filesystem-agnostic recursive
// copy + remove; macOS/Linux keep the atomic rename fast path. `renameImpl` is a seam for tests.
export function moveStagedDirectory(sourceDir, destDir, renameImpl = renameSync) {
  try {
    renameImpl(sourceDir, destDir);
  } catch (error) {
    if (!isCrossDeviceError(error)) throw error;
    cpSync(sourceDir, destDir, { recursive: true });
    rmSync(sourceDir, { recursive: true, force: true });
  }
}

function promoteStageRoot(options, paths) {
  if (options.dryRun) return;
  mkdirSync(resolve(options.outDir), { recursive: true });
  moveStagedDirectory(paths.stageRoot, paths.finalRoot);
}

export async function runPortableStage(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const result = await assemblePortableStage(options);
  console.log(
    `portable-stage: PASS ${options.target} staged from ${basename(result.tarball)} at ${result.finalRoot}`,
  );
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runPortableStage();
}
