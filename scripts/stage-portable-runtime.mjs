import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
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
  validatePortableManifest,
  verifySha256File,
} from "./portable-runtime.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const rootPackage = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
const releaseImpactCatalog = JSON.parse(
  readFileSync(join(repoRoot, "release-impact.catalog.json"), "utf8"),
);
const ALLOWED_NODE_ARCHIVE_HOSTS = new Set(["nodejs.org", "dist.nodejs.org"]);
const COMMIT_PATTERN = /^[a-f0-9]{40}$/u;
const NODE_ARCHIVE_MAX_BYTES = 128 * 1024 * 1024;
const NODE_ARCHIVE_TIMEOUT_MS = 300_000;
const NODE_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const SIDECAR_RUNTIME_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/u;
const STAGING_ASSET_ID_UNAVAILABLE = 0;
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
    commitSha: process.env.GITHUB_SHA,
    dryRun: false,
    launcherBinary: undefined,
    nodeArchive: undefined,
    nodeArchiveUrl: undefined,
    nodeCacheDir: join(repoRoot, ".portable-runtime", "cache", "node"),
    nodeSha256: undefined,
    nodeVersion: undefined,
    outDir: join(repoRoot, ".portable-runtime", "staging"),
    releaseId: Number(process.env.GITHUB_RUN_ID ?? 0),
    releaseTag: `v${rootPackage.version}`,
    sidecarRuntimeSpecs: [],
    target: undefined,
  };
  for (let index = 0; index < argv.length; index += 1) {
    index = applyArg(argv, index, options);
  }
  if (options.target === undefined) fail(`pass --target ${PORTABLE_TARGET_NAMES.join("|")}`);
  const target = portableTargetByName(options.target);
  if (target === undefined) fail(`unsupported target ${options.target}`);
  validateNodeRuntimeOptions(options);
  validateReleaseOptions(options);
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
  if (arg === "--sidecar-runtime-spec") {
    options.sidecarRuntimeSpecs.push(parseSidecarRuntimeSpec(requiredArgValue(argv, index, arg)));
    return index + 1;
  }
  const fields = new Map([
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
  ]);
  const field = fields.get(arg);
  if (field === undefined) fail(`unsupported argument: ${arg}`);
  const value = requiredArgValue(argv, index, arg);
  options[field] = field === "releaseId" ? Number(value) : value;
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
  if (typeof options.releaseTag !== "string" || options.releaseTag.length === 0) {
    fail("--release-tag must be a non-empty release tag");
  }
  if (rootPackage.version.includes("-") || options.releaseTag !== `v${rootPackage.version}`) {
    fail("--release-tag must match the stable package version for portable v1");
  }
}

function normalizeSidecarRuntimeSpecs(specs, target) {
  const names = new Set();
  return specs.map((spec, index) => normalizeSidecarRuntimeSpec(spec, target, names, index));
}

function normalizeSidecarRuntimeSpec(spec, target, names, index) {
  if (!isRecord(spec)) fail(`sidecar spec ${String(index + 1)} must be an object`);
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

function sidecarMetadataForSpec(spec, target, payloadRootPath, payloadSha256, files, sourceRoot) {
  const executablePath = sidecarPayloadPath(payloadRootPath, spec, "executablePath", files);
  const licensePath = sidecarPayloadPath(payloadRootPath, spec, "licenseEvidencePath", files);
  const sbomPath = sidecarPayloadPath(payloadRootPath, spec, "sbomEvidencePath", files);
  return {
    name: requiredSpecString(spec, "name"),
    kind: requiredSpecString(spec, "kind"),
    upstream: sidecarUpstream(spec),
    adapterCompatibility: sidecarAdapterCompatibility(spec),
    platformTarget: sidecarPlatformTarget(spec, target),
    payloadRootPath,
    executablePath,
    payloadSha256,
    sizeBytes: sidecarTreeSize(files),
    licenseEvidence: sidecarEvidence(
      sourceRoot,
      sourcePathForSpec(spec, "licenseEvidencePath"),
      licensePath,
    ),
    sbomEvidence: sidecarEvidence(
      sourceRoot,
      sourcePathForSpec(spec, "sbomEvidencePath"),
      sbomPath,
    ),
    signing: sidecarSigningForSpec(spec, target),
  };
}

function sidecarPayloadPath(payloadRootPath, spec, key, files) {
  const sourcePath = sourcePathForSpec(spec, key);
  if (!files.some((file) => file.relativePath === sourcePath)) fail(`sidecar ${key} is missing`);
  return posix.join(payloadRootPath, sourcePath);
}

function sourcePathForSpec(spec, key) {
  const path = requiredSpecString(spec, key).replaceAll("\\", "/");
  if (!isSafePortableRelativePath(path)) fail(`sidecar ${key} must be a contained relative path`);
  return path;
}

function sidecarUpstream(spec) {
  const upstream = requiredSpecRecord(spec, "upstream");
  return {
    name: requiredSpecString(upstream, "name"),
    version: requiredSpecString(upstream, "version"),
  };
}

function sidecarAdapterCompatibility(spec) {
  const adapter = requiredSpecRecord(spec, "adapterCompatibility");
  return {
    adapterName: requiredSpecString(adapter, "adapterName"),
    adapterVersion: requiredSpecString(adapter, "adapterVersion"),
    protocolVersion: requiredSpecString(adapter, "protocolVersion"),
  };
}

function sidecarPlatformTarget(spec, target) {
  const platformTarget = requiredSpecString(spec, "platformTarget");
  if (platformTarget !== target.platformTarget) fail("sidecar platformTarget must match --target");
  return platformTarget;
}

function sidecarEvidence(sourceRoot, sourcePath, payloadPath) {
  return {
    path: payloadPath,
    sha256: sha256Bytes(readFileSync(resolveSidecarSourcePath(sourceRoot, sourcePath))),
  };
}

function sidecarSigningForSpec(spec, target) {
  if (spec.signing === undefined) return sidecarStagingSigning(target);
  if (!isRecord(spec.signing)) fail("sidecar signing must be an object");
  return JSON.parse(JSON.stringify(spec.signing));
}

function sidecarStagingSigning(target) {
  return {
    verificationPolicy: "staging",
    verificationStatus: "unverified-staging",
    verificationReasonCodes: ["staging-unverified"],
    signatureKind: target.signatureKind,
    signatureVerified: false,
    notarizationRequired: target.nodePlatform === "darwin",
    notarizationVerified: false,
    verificationChecks: createPortableVerificationChecks(target.platformTarget, false),
  };
}

function sidecarTreeFiles(sourceRoot) {
  try {
    if (!statSync(sourceRoot).isDirectory()) fail("sidecar sourceRoot must be a directory");
  } catch {
    fail("sidecar sourceRoot must be an existing directory");
  }
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

function requiredSpecString(spec, key) {
  const value = spec[key];
  if (typeof value !== "string" || value.length === 0) {
    fail(`sidecar ${key} must be a non-empty string`);
  }
  return value;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256Bytes(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, { cwd: repoRoot, encoding: "utf8", ...options });
  if (result.error !== undefined)
    fail(`${cmd} ${args.join(" ")} could not spawn: ${result.error.message}`);
  if (result.status !== 0)
    fail(`${cmd} ${args.join(" ")} exited ${String(result.status)}: ${result.stderr}`);
  return result;
}

function packRoot(packDir) {
  const result = run("npm", [
    "pack",
    "--silent",
    "--ignore-scripts",
    "--pack-destination",
    packDir,
  ]);
  const tarballName = result.stdout.trim().split(/\r?\n/u).filter(Boolean).at(-1);
  if (tarballName === undefined) fail("npm pack did not report a tarball name");
  const tarball = join(packDir, tarballName);
  if (!existsSync(tarball)) fail(`expected npm pack tarball at ${tarball}`);
  return tarball;
}

function preparePackageSurface() {
  run("npm", ["run", "build"]);
  run("npm", ["run", "build:ui"]);
  run("npm", ["run", "prepare:bin"]);
  run("npm", ["run", "prune:package-build-artifacts"]);
  run("npm", ["run", "prune:package-native-optionals"]);
  run("npm", ["run", "check:package-surface"]);
}

function stagePackedPackage(tarball, extractRoot, stageRoot) {
  const appRoot = join(stageRoot, "app");
  extractArchiveRoot(tarball, "tar.gz", "package", extractRoot, appRoot, {
    tarLinkPolicy: TAR_LINK_POLICY_SKIP_SAFE,
  });
  validateStagedAppSurface(appRoot);
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
    run("unzip", ["-q", archivePath, "-d", extractRoot]);
    return;
  }
  const includeFile = join(extractRoot, "portable-runtime-tar-include.txt");
  writeFileSync(includeFile, `${entries.join("\n")}\n`);
  run("tar", ["-xzf", archivePath, "-C", extractRoot, "-T", includeFile]);
  rmSync(includeFile, { force: true });
}

function safeExtractionEntries(archivePath, archiveKind, expectedRoot, policy) {
  const entries = archiveEntries(archivePath, archiveKind);
  if (!entries.some((entry) => archiveEntryInsideRoot(entry, expectedRoot))) {
    fail(`archive must contain ${expectedRoot}`);
  }
  for (const entry of entries) {
    if (!archiveEntryInsideRoot(entry, expectedRoot)) fail(`archive entry escapes ${expectedRoot}`);
  }
  if (archiveKind === "zip") {
    assertZipEntryTypesSafe(archivePath);
    return entries;
  }
  return tarExtractionEntries(archivePath, entries, expectedRoot, policy.tarLinkPolicy);
}

function archiveEntries(archivePath, archiveKind) {
  const result =
    archiveKind === "zip" ? run("unzip", ["-Z1", archivePath]) : run("tar", ["-tzf", archivePath]);
  return result.stdout
    .split(/\r?\n/u)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function archiveEntryInsideRoot(entry, expectedRoot) {
  const normalized = normalizeArchiveEntry(entry);
  return normalized === expectedRoot || normalized.startsWith(`${expectedRoot}/`);
}

function normalizeArchiveEntry(entry) {
  const normalized = entry.replaceAll("\\", "/").replace(/\/+$/u, "");
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

function assertZipEntryTypesSafe(archivePath) {
  for (const line of run("unzip", ["-Z", "-l", archivePath])
    .stdout.split(/\r?\n/u)
    .filter(Boolean)) {
    if (!/^[dl-][rwx-]/u.test(line)) continue;
    const type = line[0];
    if (type === "d" || type === "-") continue;
    fail("archive contains unsupported special-file entries");
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

function writeEvidence(stageRoot, manifest, provenanceStatement) {
  const evidenceRoot = join(stageRoot, "evidence");
  mkdirSync(evidenceRoot, { recursive: true });
  writeFileSync(
    join(evidenceRoot, "SHA256SUMS.txt"),
    `${manifest.artifact.sha256}  ${manifest.artifact.assetName}\n`,
  );
  writeFileSync(
    join(evidenceRoot, "sbom.cdx.json"),
    JSON.stringify({ bomFormat: "CycloneDX", components: [] }, null, 2) + "\n",
  );
  writeFileSync(
    join(evidenceRoot, "third-party-notices.txt"),
    "Portable runtime notices are assembled by the release pipeline.\n",
  );
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

function provenanceStatementFor(options, target, digests, sidecarRuntimes) {
  return (
    JSON.stringify({
      artifact: target.assetName,
      buildWorkflowRunId: options.releaseId,
      packageVersion: rootPackage.version,
      sourceCommitSha: options.commitSha,
      sidecarRuntimeNames: sidecarRuntimes.map((runtime) => runtime.name),
      subjectDigest: digests.assetSha256,
      target: target.platformTarget,
    }) + "\n"
  );
}

function sha256Text(text) {
  return createHash("sha256").update(text).digest("hex");
}

function createZipArchive(payloadContainer, assetName, outRoot) {
  const assetPath = join(outRoot, assetName);
  run("zip", ["-qr", assetPath, "Keiko"], { cwd: payloadContainer });
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
    writeFileSync(join(stageRoot, "Keiko.app", "Contents", "Info.plist"), macInfoPlist(target));
  }
  stageSetupManifest(target, resourceRoot);
  stageSupportLauncher(target, stageRoot);
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

function compileWindowsLauncher(target, destination) {
  run("cl", [
    "/nologo",
    "/O2",
    "/DUNICODE",
    "/D_UNICODE",
    `/D${nativeLauncherTargetDefine(target)}`,
    `/Fe:${destination}`,
    nativeLauncherSource(),
    "/link",
    "/SUBSYSTEM:WINDOWS",
    "/ENTRY:wmainCRTStartup",
  ]);
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
    "  <key>CFBundleName</key>",
    "  <string>Keiko</string>",
    "  <key>CFBundlePackageType</key>",
    "  <string>APPL</string>",
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
    buildWorkflowRunId: options.releaseId,
    buildWorkflowAttempt: 1,
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

function manifestSecurity(target) {
  return {
    verificationPolicy: "staging",
    verificationStatus: "unverified-staging",
    verificationReasonCodes: ["staging-unverified"],
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

function manifestReviewedBinding(
  options,
  target,
  digests,
  nodeIdentity,
  security,
  sidecarRuntimes,
) {
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
  return binding;
}

function manifestReleaseImpact(
  options,
  target,
  digests,
  nodeIdentity,
  security,
  releaseImpactEntry,
  sidecarRuntimes,
) {
  return {
    catalogPath: "app/release-impact.catalog.json",
    entryId: releaseImpactEntry.id,
    entryPackageVersion: rootPackage.version,
    entryReleaseTag: options.releaseTag,
    reviewedBinding: manifestReviewedBinding(
      options,
      target,
      digests,
      nodeIdentity,
      security,
      sidecarRuntimes,
    ),
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

function manifestFor(options, target, digests, sidecarRuntimes = []) {
  const assetSha = digests.assetSha256;
  const nodeIdentity = `node-v${options.nodeVersion}-${target.runtimeTarget}`;
  const security = manifestSecurity(target);
  const releaseImpactEntry = reviewedReleaseImpactEntry(options);
  const manifest = {
    schemaVersion: 1,
    product: manifestProduct(),
    release: manifestRelease(options),
    artifact: manifestArtifact(options, target, { ...digests, assetSha256: assetSha }),
    provenance: manifestProvenance(options, digests),
    runtime: manifestRuntime(options, target, digests),
    packageSurface: manifestPackageSurface(),
    entrypoints: {
      primaryLauncher: target.primaryLauncher,
      supportLaunchers: supportLaunchersFor(target),
    },
    installLayout: manifestInstallLayout(),
    stateExclusion: manifestStateExclusion(),
    security,
    evidence: manifestEvidence(),
    releaseImpact: manifestReleaseImpact(
      options,
      target,
      { ...digests, assetSha256: assetSha },
      nodeIdentity,
      security,
      releaseImpactEntry,
      sidecarRuntimes,
    ),
    updateEligibility: manifestUpdateEligibility(),
  };
  if (sidecarRuntimes.length > 0) manifest.sidecarRuntimes = sidecarRuntimes;
  return manifest;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
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
  const sidecarSpecs = normalizeSidecarRuntimeSpecs(options.sidecarRuntimeSpecs ?? [], target);
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
  stageLauncher(target, paths.payloadRoot, paths.resourceRoot, options, hooks);
  const sidecarRuntimes = stageSidecarRuntimes(sidecarSpecs, paths.resourceRoot);
  const manifestInput = await manifestInputFor(options, target, paths, tarball, {
    nodeArchiveSha256,
    sidecarRuntimes,
  });
  writeEvidence(paths.stageRoot, manifestInput.manifest, manifestInput.provenanceStatement);
  writeManifest(paths.stageRoot, manifestInput.manifest);
  validateGeneratedManifest(manifestInput.manifest);
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
  );
  const provenanceSha256 = sha256Text(provenanceStatement);
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
    ),
    provenanceStatement,
  };
}

function validateGeneratedManifest(manifest) {
  const failures = validatePortableManifest(manifest, { allowUnverified: true });
  if (failures.length > 0) fail(`generated manifest is invalid:\n  - ${failures.join("\n  - ")}`);
}

function promoteStageRoot(options, paths) {
  if (options.dryRun) return;
  mkdirSync(resolve(options.outDir), { recursive: true });
  renameSync(paths.stageRoot, paths.finalRoot);
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
