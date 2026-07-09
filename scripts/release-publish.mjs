import { spawnSync } from "node:child_process";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { URL } from "node:url";

import {
  PORTABLE_TARGET_NAMES,
  PORTABLE_TARGETS,
  readPortableManifest,
  validatePortableManifest,
} from "./portable-runtime.mjs";
import { internalDependencyEntries, scope } from "./release-workspace-policy.mjs";
import { renderReleaseImpactNotes } from "./release-impact-notes.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const packageRegistryScope = scope.slice(0, -1);
const portableAssetManifestSchemaVersion = 1;
const supportedDistTags = new Set(["beta", "next", "latest"]);
const booleanArgHandlers = new Map([
  ["--allow-untagged", (options) => (options.allowUntagged = true)],
  ["--dry-run", (options) => (options.dryRun = true)],
  ["--plan-only", (options) => (options.planOnly = true)],
  ["--skip-github-release", (options) => (options.skipGithubRelease = true)],
  ["--skip-smoke", (options) => (options.skipSmoke = true)],
]);
const valueArgFields = new Map([
  ["--portable-assets-manifest", "portableAssetsManifest"],
  ["--registry", "registry"],
  ["--tag", "tag"],
]);
const verifyAttempts = positiveIntegerEnv("KEIKO_RELEASE_VERIFY_ATTEMPTS", 13);
const verifyDelayMs = nonNegativeIntegerEnv("KEIKO_RELEASE_VERIFY_DELAY_MS", 5000);

function positiveIntegerEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw.length === 0) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < 1) {
    fail(`${name} must be a positive integer.`);
  }
  return value;
}

function nonNegativeIntegerEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw.length === 0) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < 0) {
    fail(`${name} must be a non-negative integer.`);
  }
  return value;
}

function fail(message) {
  console.error(`release-publish: FAIL - ${message}`);
  process.exit(1);
}

function readJson(relativePath) {
  return JSON.parse(readFileSync(join(repoRoot, relativePath), "utf8"));
}

function readJsonFile(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function readReleaseImpactCatalog() {
  const override = process.env.KEIKO_RELEASE_IMPACT_CATALOG_PATH;
  if (override === undefined || override.length === 0 || process.env.NODE_ENV !== "test") {
    return readJson("release-impact.catalog.json");
  }
  return JSON.parse(readFileSync(resolve(repoRoot, override), "utf8"));
}

function defaultOptions() {
  return {
    allowUntagged: false,
    dryRun: false,
    planOnly: false,
    portableAssetsManifest: process.env.KEIKO_PORTABLE_ASSETS_MANIFEST,
    registry: process.env.KEIKO_REGISTRY_URL ?? "https://registry.npmjs.org/",
    skipGithubRelease: false,
    skipSmoke: false,
    tag: process.env.NPM_DIST_TAG,
  };
}

function applyAssignmentArg(arg, options) {
  const match = /^(--portable-assets-manifest|--registry|--tag)=(.*)$/u.exec(arg);
  if (match === null) return false;
  options[valueArgFields.get(match[1])] = match[2];
  return true;
}

function applyArg(argv, index, options) {
  const arg = argv[index];
  const booleanHandler = booleanArgHandlers.get(arg);
  if (booleanHandler !== undefined) {
    booleanHandler(options);
    return index;
  }
  const valueField = valueArgFields.get(arg);
  if (valueField !== undefined) {
    options[valueField] = argv[index + 1];
    return index + 1;
  }
  if (applyAssignmentArg(arg, options)) return index;
  fail(`unsupported argument: ${arg}`);
}

function parseArgs(argv) {
  const options = defaultOptions();

  for (let index = 0; index < argv.length; index += 1) {
    index = applyArg(argv, index, options);
  }

  validateDistTag(options);
  normalizeRegistry(options);

  return options;
}

function validateDistTag(options) {
  if (typeof options.tag !== "string" || options.tag.length === 0) {
    fail("pass an npm dist-tag explicitly with --tag beta, --tag next, or --tag latest.");
  }
  if (!supportedDistTags.has(options.tag)) {
    fail(`unsupported npm dist-tag ${options.tag}. Supported tags: beta, next, latest.`);
  }
  if (options.allowUntagged && options.tag === "latest") {
    fail("--allow-untagged cannot be used with --tag latest.");
  }
}

function releaseTag(version) {
  return `v${version}`;
}

function releaseIsPrerelease(version, tag) {
  return version.includes("-") || tag !== "latest";
}

function stableLatestRelease(rootManifest, options) {
  return options.tag === "latest" && !releaseIsPrerelease(rootManifest.version, options.tag);
}

function portableUploadEnabled(options) {
  return !options.skipGithubRelease && !options.dryRun;
}

function stablePortableAssetsRequired(rootManifest, options) {
  return !options.planOnly && !options.dryRun && stableLatestRelease(rootManifest, options);
}

function portableReleasePromotionEnabled(rootManifest, options) {
  return stableLatestRelease(rootManifest, options);
}

function normalizeRegistry(options) {
  if (typeof options.registry !== "string" || options.registry.length === 0) {
    fail("pass a registry URL with --registry or KEIKO_REGISTRY_URL.");
  }

  const registryUrl = new URL(options.registry);
  if (registryUrl.username !== "" || registryUrl.password !== "") {
    fail("registry URL must not include credentials.");
  }
  registryUrl.pathname = registryUrl.pathname.endsWith("/")
    ? registryUrl.pathname
    : `${registryUrl.pathname}/`;
  options.registry = registryUrl.toString();
}

function commandResult(cmd, args, options = {}) {
  return spawnSync(cmd, args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: options.stdio ?? "pipe",
    env: options.env ?? process.env,
  });
}

function run(cmd, args, options = {}) {
  const result = commandResult(cmd, args, options);
  if (result.error !== undefined) {
    fail(`${cmd} ${args.join(" ")} could not spawn: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const stdout = result.stdout === undefined ? "" : result.stdout;
    const stderr = result.stderr === undefined ? "" : result.stderr;
    fail(
      `${cmd} ${args.join(" ")} exited ${String(result.status)}\n` +
        `stdout:\n${stdout}\n` +
        `stderr:\n${stderr}`,
    );
  }
  return result;
}

function githubEnvironment() {
  const env = { ...process.env };
  if (typeof env.GH_TOKEN !== "string" && typeof env.GITHUB_TOKEN === "string") {
    env.GH_TOKEN = env.GITHUB_TOKEN;
  }
  return env;
}

function networkEnvironment() {
  const env = { ...process.env };
  Reflect.deleteProperty(env, "GH_TOKEN");
  Reflect.deleteProperty(env, "GITHUB_TOKEN");
  return env;
}

function gh(args) {
  const result = commandResult("gh", args, { env: githubEnvironment() });
  if (result.error !== undefined) {
    fail(`gh ${args.join(" ")} could not spawn: ${result.error.message}`);
  }
  return result;
}

function runGh(args) {
  const result = gh(args);
  if (result.status !== 0) {
    fail(
      `gh ${args.join(" ")} exited ${String(result.status)}\n` +
        `stdout:\n${result.stdout}\n` +
        `stderr:\n${result.stderr}`,
    );
  }
  return result;
}

function loadDotEnvToken() {
  const envPath = join(repoRoot, ".env");
  if (!existsSync(envPath)) return undefined;
  const lines = readFileSync(envPath, "utf8").split(/\r?\n/u);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const match = /^(NODE_AUTH_TOKEN|NPM_TOKEN)\s*=\s*(.*)$/u.exec(trimmed);
    if (match === null) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    return value;
  }
  return undefined;
}

function readNpmStrictSsl() {
  const configured = commandResult("npm", ["config", "get", "strict-ssl"]);
  if (configured.status !== 0) return "true";
  const value = configured.stdout.trim();
  return value === "false" ? "false" : "true";
}

function authConfigKey(registry) {
  const url = new URL(registry);
  const path = url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`;
  return `//${url.host}${path}:_authToken`;
}

function createNpmEnvironment(registry) {
  const token = process.env.NODE_AUTH_TOKEN ?? process.env.NPM_TOKEN ?? loadDotEnvToken();
  const strictSsl = process.env.NPM_CONFIG_STRICT_SSL ?? readNpmStrictSsl();
  if (strictSsl !== "true") {
    fail(
      "npm strict-ssl=false is not allowed for release publishing; configure a CA bundle instead.",
    );
  }
  const tempDir = mkdtempSync(join(tmpdir(), "keiko-release-npm-"));
  const userConfig = join(tempDir, ".npmrc");
  const lines = [
    `registry=${registry}`,
    `${packageRegistryScope}:registry=${registry}`,
    `strict-ssl=${strictSsl}`,
  ];
  if (token !== undefined && token.length > 0) {
    lines.push(`${authConfigKey(registry)}=${token}`);
  }
  writeFileSync(userConfig, `${lines.join("\n")}\n`);
  chmodSync(userConfig, 0o600);
  return {
    cleanup: () => rmSync(tempDir, { recursive: true, force: true }),
    env: {
      ...process.env,
      NPM_CONFIG_USERCONFIG: userConfig,
    },
  };
}

function collectWorkspaceManifests() {
  const workspaces = [];
  for (const dir of readdirSync(join(repoRoot, "packages"), { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const relativePath = join("packages", dir.name, "package.json");
    const absolutePath = join(repoRoot, relativePath);
    if (!existsSync(absolutePath)) continue;
    const manifest = readJson(relativePath);
    workspaces.push({
      manifest,
      packageDir: `./${join("packages", dir.name)}`,
      relativePath,
    });
  }
  return workspaces;
}

function validateRootManifest(rootManifest, options, failures) {
  if (typeof rootManifest.version !== "string" || rootManifest.version.length === 0) {
    failures.push("root package.json must declare a release version.");
  }
  if (rootManifest.version.includes("-") && options.tag === "latest") {
    failures.push("prerelease versions must not be published with the latest dist-tag.");
  }
}

function validateWorkspaceIdentity(workspace, expectedVersion, failures) {
  const { manifest, relativePath } = workspace;
  if (typeof manifest.name !== "string" || !manifest.name.startsWith(scope)) {
    failures.push(`${relativePath}: workspace package must declare an ${scope} package name.`);
    return false;
  }
  if (manifest.version !== expectedVersion) {
    failures.push(
      `${relativePath}: version ${manifest.version} does not match root ${expectedVersion}.`,
    );
  }
  if (manifest.private !== true) {
    failures.push(
      `${relativePath}: internal workspace ${manifest.name} must set private: true; only the root package is published.`,
    );
  }
  return true;
}

function validateWorkspaceDependency(workspace, entry, context, failures) {
  const { manifest, relativePath } = workspace;
  const { expectedVersion, workspaceByName } = context;
  const { field, name, specifier } = entry;
  if (name === undefined) {
    failures.push(`${manifest.name}: ${field} must be an object when present.`);
    return;
  }
  if (!workspaceByName.has(name)) {
    failures.push(`${relativePath}: ${field}.${name} does not refer to a local workspace package.`);
  }
  if (specifier !== expectedVersion) {
    failures.push(
      `${relativePath}: ${field}.${name} must be pinned to ${expectedVersion}, got ${specifier}.`,
    );
  }
}

function validateReleaseManifests(rootManifest, workspaces) {
  const failures = [];
  const expectedVersion = rootManifest.version;
  const workspaceByName = new Map(
    workspaces.map((workspace) => [workspace.manifest.name, workspace]),
  );

  validateRootManifest(rootManifest, options, failures);
  const context = { expectedVersion, workspaceByName };

  for (const workspace of workspaces) {
    if (!validateWorkspaceIdentity(workspace, expectedVersion, failures)) continue;
    for (const entry of internalDependencyEntries(workspace.manifest)) {
      validateWorkspaceDependency(workspace, entry, context, failures);
    }
  }

  if (failures.length > 0) {
    fail(`manifest validation failed:\n  - ${failures.join("\n  - ")}`);
  }

  return { workspaceByName };
}

function ensureTrackedTreeIsClean() {
  const unstaged = commandResult("git", ["diff", "--quiet"]);
  const staged = commandResult("git", ["diff", "--cached", "--quiet"]);
  if (unstaged.status !== 0 || staged.status !== 0) {
    fail("tracked working tree changes are present; publish from the reviewed release commit.");
  }
}

function ensureReleaseTag(version) {
  const head = run("git", ["rev-parse", "HEAD"], { stdio: "pipe" }).stdout.trim();
  const tag = `v${version}`;
  const tagResult = commandResult("git", ["rev-parse", `${tag}^{}`]);
  if (tagResult.status !== 0) {
    fail(`release tag ${tag} does not exist locally.`);
  }
  const tagSha = tagResult.stdout.trim();
  if (head !== tagSha) {
    fail(`HEAD ${head} does not match release tag ${tag} (${tagSha}).`);
  }
}

function githubRepositoryFromRemote(remoteUrl) {
  const trimmed = remoteUrl.trim();
  const httpsMatch = /^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/u.exec(trimmed);
  if (httpsMatch !== null) return httpsMatch[1];
  const sshMatch = /^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/u.exec(trimmed);
  if (sshMatch !== null) return sshMatch[1];
  return undefined;
}

function githubRepository() {
  if (
    typeof process.env.GITHUB_REPOSITORY === "string" &&
    process.env.GITHUB_REPOSITORY.includes("/")
  ) {
    return process.env.GITHUB_REPOSITORY;
  }
  const remote = commandResult("git", ["remote", "get-url", "origin"]);
  if (remote.status === 0) {
    const repository = githubRepositoryFromRemote(remote.stdout);
    if (repository !== undefined) return repository;
  }
  fail("could not determine GitHub repository; set GITHUB_REPOSITORY=owner/repo.");
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256FileSync(path) {
  const fd = openSync(path, "r");
  const hash = createHash("sha256");
  const buffer = Buffer.alloc(1024 * 1024);
  try {
    for (;;) {
      const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) return hash.digest("hex");
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    closeSync(fd);
  }
}

function containedPath(root, path) {
  const normalizedRoot = root.endsWith("/") ? root : `${root}/`;
  return path === root || path.startsWith(normalizedRoot);
}

function regularContainedFile(path, root, label, failures) {
  try {
    const rootRealPath = realpathSync(root);
    const fileStat = lstatSync(path);
    if (fileStat.isSymbolicLink()) {
      failures.push(`${label} must not be a symbolic link.`);
      return undefined;
    }
    if (!fileStat.isFile()) {
      failures.push(`${label} must point to a regular file.`);
      return undefined;
    }
    if (fileStat.size <= 0) {
      failures.push(`${label} must not be empty.`);
      return undefined;
    }
    if (!containedPath(rootRealPath, realpathSync(path))) {
      failures.push(`${label} must stay within the portable stage root.`);
      return undefined;
    }
    return fileStat;
  } catch {
    failures.push(`${label} does not exist.`);
    return undefined;
  }
}

function requiredString(record, key, label, failures) {
  const value = record?.[key];
  if (typeof value !== "string" || value.length === 0) {
    failures.push(`${label}.${key} must be a non-empty string.`);
    return "";
  }
  return value;
}

function containedLocalPath(root, relativePath, label, failures) {
  if (typeof relativePath !== "string" || relativePath.length === 0) {
    failures.push(`${label} must be a non-empty relative path.`);
    return undefined;
  }
  const rootAbsolute = resolve(root);
  const candidate = resolve(rootAbsolute, relativePath);
  if (relativePath.startsWith("/") || !containedPath(rootAbsolute, candidate)) {
    failures.push(`${label} must stay within the portable stage root.`);
    return undefined;
  }
  return candidate;
}

function loadPortableAssets(rootManifest, options) {
  if (stablePortableAssetsRequired(rootManifest, options) && options.skipGithubRelease) {
    fail("stable latest publishes must attach portable GitHub Release Assets.");
  }
  if (typeof options.portableAssetsManifest !== "string" || options.portableAssetsManifest === "") {
    if (stablePortableAssetsRequired(rootManifest, options)) {
      fail("stable latest publishes require --portable-assets-manifest.");
    }
    return [];
  }
  return portableAssetsFromManifest(resolve(options.portableAssetsManifest), rootManifest);
}

function portableAssetsFromManifest(inputPath, rootManifest) {
  const manifest = readJsonFile(inputPath);
  const baseDir = dirname(inputPath);
  const failures = [];
  if (!isRecord(manifest)) failures.push("portable assets manifest must be an object.");
  if (manifest.schemaVersion !== portableAssetManifestSchemaVersion) {
    failures.push("portable assets manifest schemaVersion must be 1.");
  }
  const artifacts = Array.isArray(manifest.artifacts) ? manifest.artifacts : [];
  if (artifacts.length !== PORTABLE_TARGETS.length) {
    failures.push("portable assets manifest must list exactly three artifacts.");
  }
  const normalized = normalizePortableAssets(artifacts, baseDir, rootManifest, failures);
  if (failures.length > 0) {
    fail(`portable assets manifest validation failed:\n  - ${failures.join("\n  - ")}`);
  }
  return normalized;
}

function normalizePortableAssets(artifacts, baseDir, rootManifest, failures) {
  const byTarget = new Map();
  for (const entry of artifacts) {
    const targetName = isRecord(entry) ? entry.platformTarget : undefined;
    if (typeof targetName !== "string") {
      failures.push("portable asset entry platformTarget must be a string.");
      continue;
    }
    if (!PORTABLE_TARGET_NAMES.includes(targetName)) {
      failures.push(`unsupported portable platformTarget ${targetName}.`);
      continue;
    }
    if (byTarget.has(targetName)) failures.push(`duplicate portable platformTarget ${targetName}.`);
    byTarget.set(targetName, entry);
  }
  return PORTABLE_TARGETS.flatMap((target) =>
    normalizePortableTargetAsset(
      byTarget.get(target.platformTarget),
      target,
      baseDir,
      rootManifest,
      failures,
    ),
  );
}

function normalizePortableTargetAsset(entry, target, baseDir, rootManifest, failures) {
  if (!isRecord(entry)) {
    failures.push(`missing portable asset entry for ${target.platformTarget}.`);
    return [];
  }
  const archivePath = resolve(
    baseDir,
    requiredString(entry, "archivePath", target.platformTarget, failures),
  );
  const manifestPath = resolve(
    baseDir,
    requiredString(entry, "manifestPath", target.platformTarget, failures),
  );
  const stageRoot = dirname(dirname(manifestPath));
  const archiveStat = regularContainedFile(
    archivePath,
    stageRoot,
    `${target.platformTarget}.archivePath`,
    failures,
  );
  const manifestStat = regularContainedFile(
    manifestPath,
    stageRoot,
    `${target.platformTarget}.manifestPath`,
    failures,
  );
  const manifest = manifestStat
    ? readPortableManifestSafely(manifestPath, target.platformTarget, failures)
    : {};
  validatePortableAssetFiles(
    target,
    archivePath,
    archiveStat,
    manifestPath,
    manifest,
    rootManifest,
    failures,
  );
  return [
    portableAssetRecord(target, archivePath, manifestPath, manifest, entry, baseDir, failures),
  ];
}

function readPortableManifestSafely(path, platformTarget, failures) {
  try {
    return readPortableManifest(path);
  } catch {
    failures.push(`${platformTarget}.manifestPath must contain valid JSON.`);
    return {};
  }
}

function validatePortableAssetFiles(
  target,
  archivePath,
  archiveStat,
  manifestPath,
  manifest,
  rootManifest,
  failures,
) {
  if (basename(archivePath) !== target.assetName) {
    failures.push(`${target.platformTarget}.archivePath must be named ${target.assetName}.`);
  }
  for (const failure of validatePortableManifest(manifest, { allowUnverified: false })) {
    failures.push(`${target.platformTarget}.${failure}`);
  }
  if (manifest.product?.packageVersion !== rootManifest.version) {
    failures.push(
      `${target.platformTarget}.product.packageVersion must match ${rootManifest.version}.`,
    );
  }
  if (manifest.release?.releaseTag !== releaseTag(rootManifest.version)) {
    failures.push(
      `${target.platformTarget}.release.releaseTag must match ${releaseTag(rootManifest.version)}.`,
    );
  }
  validatePortableArchiveDigest(target, archivePath, archiveStat, manifest, failures);
  validatePortableEvidenceFiles(target, dirname(dirname(manifestPath)), manifest, failures);
}

function validatePortableArchiveDigest(target, archivePath, archiveStat, manifest, failures) {
  if (archiveStat !== undefined && manifest.artifact?.sizeBytes !== archiveStat.size) {
    failures.push(`${target.platformTarget}.artifact.sizeBytes must match the archive size.`);
  }
  if (archiveStat !== undefined && manifest.artifact?.sha256 !== sha256FileSync(archivePath)) {
    failures.push(`${target.platformTarget}.artifact.sha256 must match the archive bytes.`);
  }
}

function validatePortableEvidenceFiles(target, stageRoot, manifest, failures) {
  for (const evidence of requiredPortableEvidence(target, stageRoot, manifest, failures)) {
    regularContainedFile(
      evidence.sourcePath,
      stageRoot,
      `${target.platformTarget}.${evidence.relativePath}`,
      failures,
    );
  }
  const checksumsPath = containedLocalPath(
    stageRoot,
    manifest.evidence?.checksumsPath,
    "checksumsPath",
    failures,
  );
  if (checksumsPath !== undefined && existsSync(checksumsPath)) {
    const expected = `${manifest.artifact?.sha256}  ${manifest.artifact?.assetName}`;
    if (!readFileSync(checksumsPath, "utf8").includes(expected)) {
      failures.push(`${target.platformTarget}.checksumsPath must bind the archive digest.`);
    }
  }
}

function requiredPortableEvidence(target, stageRoot, manifest, failures) {
  const entries = [
    ["manifest/portable-manifest.json", `${target.platformTarget}-portable-manifest.json`],
    [manifest.evidence?.checksumsPath, `${target.platformTarget}-SHA256SUMS.txt`],
    [manifest.evidence?.sbomPath, `${target.platformTarget}-sbom.cdx.json`],
    [manifest.evidence?.licenseNoticePath, `${target.platformTarget}-third-party-notices.txt`],
    [
      manifest.security?.verificationSummaryPath,
      `${target.platformTarget}-signing-verification.json`,
    ],
    [
      manifest.provenance?.provenanceStatementPath,
      `${target.platformTarget}-provenance.intoto.jsonl`,
    ],
  ];
  return entries.flatMap(([relativePath, assetName]) => {
    const sourcePath = containedLocalPath(stageRoot, relativePath, assetName, failures);
    return sourcePath === undefined ? [] : [{ assetName, relativePath, sourcePath }];
  });
}

function portableAssetRecord(
  target,
  archivePath,
  manifestPath,
  manifest,
  entry,
  baseDir,
  failures,
) {
  const stageRoot = dirname(dirname(manifestPath));
  return {
    archiveAssetName: target.assetName,
    archivePath,
    evidenceFiles: [
      ...requiredPortableEvidence(target, stageRoot, manifest, failures),
      ...extraPortableEvidenceFiles(entry, stageRoot, target, failures),
    ],
    manifest,
    platformTarget: target.platformTarget,
    stageRoot,
  };
}

function extraPortableEvidenceFiles(entry, stageRoot, target, failures) {
  if (entry.evidencePaths === undefined) return [];
  if (!Array.isArray(entry.evidencePaths)) {
    failures.push(`${target.platformTarget}.evidencePaths must be an array when present.`);
    return [];
  }
  return entry.evidencePaths.flatMap((path, index) => {
    if (typeof path !== "string" || path.length === 0) {
      failures.push(`${target.platformTarget}.evidencePaths[${String(index)}] must be a string.`);
      return [];
    }
    const sourcePath = containedLocalPath(
      stageRoot,
      path,
      `${target.platformTarget}.evidencePaths[${String(index)}]`,
      failures,
    );
    if (sourcePath === undefined) return [];
    regularContainedFile(
      sourcePath,
      stageRoot,
      `${target.platformTarget}.evidencePaths[${String(index)}]`,
      failures,
    );
    return [
      {
        assetName: `${target.platformTarget}-${basename(path)}`,
        relativePath: path,
        sourcePath,
      },
    ];
  });
}

function withPublishApprovalRequirement(enabled, callback) {
  if (!enabled) return callback();
  const previous = process.env.KEIKO_REQUIRE_RELEASE_APPROVAL_REFERENCE;
  process.env.KEIKO_REQUIRE_RELEASE_APPROVAL_REFERENCE = "1";
  try {
    return callback();
  } finally {
    if (previous === undefined) {
      Reflect.deleteProperty(process.env, "KEIKO_REQUIRE_RELEASE_APPROVAL_REFERENCE");
    } else {
      process.env.KEIKO_REQUIRE_RELEASE_APPROVAL_REFERENCE = previous;
    }
  }
}

function releaseNotes(rootManifest, options) {
  const catalog = readReleaseImpactCatalog();
  const result = withPublishApprovalRequirement(!options.planOnly, () =>
    renderReleaseImpactNotes(catalog, rootManifest, {
      ...options,
      portableReleasePromotion: portableReleasePromotionEnabled(rootManifest, options),
    }),
  );
  if (!result.ok) {
    fail(`release-impact notes could not be generated:\n  - ${result.failures.join("\n  - ")}`);
  }
  return result.notes;
}

function printReleaseNotesPreview(notes) {
  console.log("release-publish: GitHub release notes preview follows.");
  console.log("-----BEGIN KEIKO RELEASE NOTES-----");
  console.log(notes);
  console.log("-----END KEIKO RELEASE NOTES-----");
}

function ensureGithubRelease(rootPackage, options, notes) {
  const tag = releaseTag(rootPackage.version);
  if (options.skipGithubRelease || options.dryRun) {
    console.log("release-publish: GitHub release skipped.");
    printReleaseNotesPreview(notes);
    return { repo: "", tag };
  }

  const repo = githubRepository();
  const title = `Keiko ${rootPackage.version}`;
  const prerelease = releaseIsPrerelease(rootPackage.version, options.tag);
  const latestArgs = options.tag === "latest" && !prerelease ? ["--latest"] : [];
  const prereleaseArgs = prerelease ? ["--prerelease"] : [];
  const existing = gh(["release", "view", tag, "--repo", repo]);

  if (existing.status === 0) {
    console.log(`release-publish: GitHub release ${tag} exists; updating metadata.`);
    runGh([
      "release",
      "edit",
      tag,
      "--repo",
      repo,
      "--title",
      title,
      "--notes",
      notes,
      "--verify-tag",
      ...latestArgs,
      ...prereleaseArgs,
    ]);
    return { repo, tag };
  }

  console.log(`release-publish: creating GitHub release ${tag}.`);
  runGh([
    "release",
    "create",
    tag,
    "--repo",
    repo,
    "--title",
    title,
    "--notes",
    notes,
    "--verify-tag",
    ...(latestArgs.length > 0 ? latestArgs : ["--latest=false"]),
    ...prereleaseArgs,
  ]);
  return { repo, tag };
}

function publishPortableReleaseAssets(options, assets, releaseInfo) {
  if (assets.length === 0) return;
  if (!portableUploadEnabled(options)) {
    console.log("release-publish: portable assets validated; upload skipped.");
    return;
  }
  const evidenceUpload = preparePortableEvidenceUploadRoot();
  try {
    const archiveUpload = portableArchiveUploadFiles(assets);
    runGh([
      "release",
      "upload",
      releaseInfo.tag,
      "--repo",
      releaseInfo.repo,
      "--clobber",
      ...archiveUpload.paths,
    ]);
    const archiveSnapshot = githubReleaseSnapshot(releaseInfo);
    verifyRemotePortableAssets(archiveSnapshot.assets, archiveUpload.expected, releaseInfo);
    const boundAssets = bindPortableAssetsToRemoteRelease(assets, archiveSnapshot);
    const boundEvidence = portableEvidenceUploadFiles(boundAssets, evidenceUpload.root);
    runGh([
      "release",
      "upload",
      releaseInfo.tag,
      "--repo",
      releaseInfo.repo,
      "--clobber",
      ...boundEvidence.paths,
    ]);
    const finalSnapshot = githubReleaseSnapshot(releaseInfo);
    const expected = [...archiveUpload.expected, ...boundEvidence.expected];
    verifyRemotePortableAssets(finalSnapshot.assets, expected, releaseInfo);
    runPortableDownloadSmoke(finalSnapshot.assets, expected);
    console.log(`release-publish: portable assets uploaded and verified for ${releaseInfo.tag}.`);
  } finally {
    rmSync(evidenceUpload.root, { recursive: true, force: true });
  }
}

function preparePortableEvidenceUploadRoot() {
  const root = mkdtempSync(join(tmpdir(), "keiko-portable-upload-"));
  return { root };
}

function portableArchiveUploadFiles(assets) {
  const paths = [];
  const names = new Set();
  const expected = [];
  for (const asset of assets) {
    addUploadPath(asset.archivePath, asset.archiveAssetName, names, paths);
    expected.push({
      assetName: asset.archiveAssetName,
      expectedSize: asset.manifest.artifact.sizeBytes,
      firstClassArchive: true,
    });
  }
  return { expected, paths };
}

function portableEvidenceUploadFiles(assets, root) {
  const paths = [];
  const names = new Set();
  const expected = [];
  for (const asset of assets) {
    for (const evidence of asset.evidenceFiles) {
      const destination = writePortableEvidenceUploadFile(asset, evidence, root);
      addUploadPath(destination, evidence.assetName, names, paths);
      expected.push({
        assetName: evidence.assetName,
        expectedSize: statSync(destination).size,
        firstClassArchive: false,
      });
    }
  }
  return { expected, paths };
}

function writePortableEvidenceUploadFile(asset, evidence, root) {
  const destination = join(root, evidence.assetName);
  mkdirSync(dirname(destination), { recursive: true });
  if (evidence.relativePath === "manifest/portable-manifest.json") {
    writeFileSync(destination, JSON.stringify(asset.manifest, null, 2) + "\n");
  } else {
    copyFileSync(evidence.sourcePath, destination);
  }
  return destination;
}

function addUploadPath(path, assetName, names, paths) {
  if (names.has(assetName)) fail(`duplicate portable release asset name ${assetName}.`);
  names.add(assetName);
  if (basename(path) !== assetName) {
    fail(`portable release asset path ${path} must upload as ${assetName}.`);
  }
  paths.push(path);
}

function githubReleaseSnapshot(releaseInfo) {
  const result = runGh(["api", `repos/${releaseInfo.repo}/releases/tags/${releaseInfo.tag}`]);
  try {
    const release = JSON.parse(result.stdout);
    if (isRecord(release) && Number.isSafeInteger(release.id) && Array.isArray(release.assets)) {
      return { assets: release.assets, id: release.id };
    }
  } catch {
    // Fall through to the fail-closed message below.
  }
  fail("GitHub release response did not include a release id and asset array.");
}

function bindPortableAssetsToRemoteRelease(assets, releaseSnapshot) {
  const remoteByName = new Map(releaseSnapshot.assets.map((asset) => [asset.name, asset]));
  return assets.map((asset) =>
    bindPortableAssetToRemoteRelease(asset, releaseSnapshot.id, remoteByName),
  );
}

function bindPortableAssetToRemoteRelease(asset, releaseId, remoteByName) {
  const remote = remoteByName.get(asset.archiveAssetName);
  if (!isRecord(remote) || !Number.isSafeInteger(remote.id) || remote.id <= 0) {
    fail(`${asset.archiveAssetName} must have a remote GitHub asset id before evidence upload.`);
  }
  const manifest = boundPortableManifest(asset.manifest, releaseId, remote.id);
  const failures = validatePortableManifest(manifest, { allowUnverified: false }).map(
    (failure) => `${asset.platformTarget}.${failure}`,
  );
  if (failures.length > 0) {
    fail(`portable manifest binding failed:\n  - ${failures.join("\n  - ")}`);
  }
  return { ...asset, manifest };
}

function boundPortableManifest(source, releaseId, assetId) {
  const manifest = JSON.parse(JSON.stringify(source));
  manifest.release = { ...manifest.release, releaseId };
  manifest.artifact = { ...manifest.artifact, assetId };
  manifest.releaseImpact = {
    ...manifest.releaseImpact,
    reviewedBinding: {
      ...manifest.releaseImpact.reviewedBinding,
      assetId,
      releaseId,
    },
  };
  return manifest;
}

function verifyRemotePortableAssets(remoteAssets, expectedAssets, releaseInfo) {
  const failures = [];
  verifyFirstClassArchiveSet(remoteAssets, failures);
  const remoteByName = new Map(remoteAssets.map((asset) => [asset.name, asset]));
  for (const expected of expectedAssets) {
    verifyRemotePortableAsset(remoteByName.get(expected.assetName), expected, failures);
  }
  if (failures.length > 0) {
    fail(`GitHub Release portable asset verification failed:\n  - ${failures.join("\n  - ")}`);
  }
  console.log(
    `release-publish: GitHub Release ${releaseInfo.tag} has verified portable browser_download_url values.`,
  );
}

function verifyFirstClassArchiveSet(remoteAssets, failures) {
  const expected = new Set(PORTABLE_TARGETS.map((target) => target.assetName));
  const actual = remoteAssets
    .map((asset) => asset.name)
    .filter((name) => /^keiko-[a-z0-9-]+\.zip$/u.test(name));
  if (actual.length !== expected.size || actual.some((name) => !expected.has(name))) {
    failures.push("stable portable releases must expose exactly the three first-class ZIP assets.");
  }
}

function verifyRemotePortableAsset(remote, expected, failures) {
  if (!isRecord(remote)) {
    failures.push(`${expected.assetName} is missing from the GitHub Release.`);
    return;
  }
  if (!Number.isSafeInteger(remote.id) || remote.id <= 0) {
    failures.push(`${expected.assetName} must have a non-zero GitHub asset id.`);
  }
  if (remote.size !== expected.expectedSize) {
    failures.push(`${expected.assetName} size does not match the reviewed local asset.`);
  }
  if (!validBrowserDownloadUrl(remote.browser_download_url)) {
    failures.push(`${expected.assetName} must expose an HTTPS browser_download_url.`);
  }
}

function validBrowserDownloadUrl(value) {
  try {
    if (typeof value !== "string" || value.length === 0) return false;
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}

function runPortableDownloadSmoke(remoteAssets, expectedAssets) {
  const remoteByName = new Map(remoteAssets.map((asset) => [asset.name, asset]));
  for (const expected of expectedAssets) {
    const url = remoteByName.get(expected.assetName)?.browser_download_url;
    if (typeof url !== "string") fail(`${expected.assetName} has no browser_download_url.`);
    smokePortableDownloadUrl(expected.assetName, url);
  }
}

function smokePortableDownloadUrl(assetName, url) {
  const result = commandResult(
    "curl",
    [
      "--fail",
      "--silent",
      "--show-error",
      "--location",
      "--range",
      "0-0",
      "--output",
      "/dev/null",
      url,
    ],
    { env: networkEnvironment() },
  );
  if (result.error !== undefined || result.status !== 0) {
    fail(`unauthenticated portable asset download failed for ${assetName}.`);
  }
}

function npmViewVersion(pkg, npmEnv, registry) {
  const result = npmViewVersionResult(pkg, npmEnv, registry);
  return result.kind === "available" && result.version === pkg.version;
}

function npmViewVersionResult(pkg, npmEnv, registry) {
  const result = commandResult("npm", ["view", pkg.spec, "version", "--registry", registry], {
    env: npmEnv,
  });
  if (result.status === 0) {
    return { kind: "available", version: result.stdout.trim() };
  }
  const viewOutput = `${result.stdout}\n${result.stderr}`;
  if (viewOutput.includes("E404") || viewOutput.includes("No match found")) {
    return { kind: "missing", version: "" };
  }
  fail(
    `could not inspect ${pkg.spec} in ${registry}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
}

function npmViewDistTag(pkg, npmEnv, registry, tag) {
  const result = npmViewDistTagResult(pkg, npmEnv, registry, tag);
  if (result.kind === "available") return result.version;
  return "";
}

function npmViewDistTagResult(pkg, npmEnv, registry, tag) {
  const result = commandResult(
    "npm",
    ["view", pkg.name, `dist-tags.${tag}`, "--registry", registry],
    {
      env: npmEnv,
    },
  );
  if (result.status === 0) {
    return { kind: "available", version: result.stdout.trim() };
  }
  const viewOutput = `${result.stdout}\n${result.stderr}`;
  if (viewOutput.includes("E404") || viewOutput.includes("No match found")) {
    return { kind: "missing", version: "" };
  }
  fail(
    `could not inspect ${pkg.name} dist-tag ${tag}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
}

function packageRecord(manifest, packageDir) {
  return {
    name: manifest.name,
    packageDir,
    spec: `${manifest.name}@${manifest.version}`,
    version: manifest.version,
  };
}

function publishPackage(pkg, npmEnv, options) {
  if (options.dryRun) {
    publishPackageDryRun(pkg, npmEnv, options);
    return;
  }

  if (npmViewVersion(pkg, npmEnv, options.registry)) {
    console.log(`release-publish: SKIP ${pkg.spec} already exists.`);
  } else {
    publishPackageToRegistry(pkg, npmEnv, options);
  }
  ensurePackageDistTag(pkg, npmEnv, options);
}

function publishPackageDryRun(pkg, npmEnv, options) {
  console.log(`release-publish: DRY-RUN ${pkg.spec} from ${pkg.packageDir}`);
  run(
    "npm",
    [
      "publish",
      pkg.packageDir,
      "--access",
      "public",
      "--tag",
      options.tag,
      "--registry",
      options.registry,
      "--ignore-scripts",
      "--dry-run",
    ],
    { env: npmEnv, stdio: "inherit" },
  );
}

function publishPackageToRegistry(pkg, npmEnv, options) {
  console.log(`release-publish: PUBLISH ${pkg.spec} from ${pkg.packageDir}.`);
  run(
    "npm",
    [
      "publish",
      pkg.packageDir,
      "--access",
      "public",
      "--tag",
      options.tag,
      "--registry",
      options.registry,
      "--provenance",
      "--ignore-scripts",
    ],
    { env: npmEnv, stdio: "inherit" },
  );
}

function ensurePackageDistTag(pkg, npmEnv, options) {
  const currentTag = npmViewDistTag(pkg, npmEnv, options.registry, options.tag);
  if (currentTag === pkg.version) {
    console.log(`release-publish: TAG ${pkg.name}@${options.tag} -> ${pkg.version}.`);
    return;
  }
  console.log(`release-publish: DIST-TAG ${pkg.name}@${options.tag} -> ${pkg.version}.`);
  run("npm", ["dist-tag", "add", pkg.spec, options.tag, "--registry", options.registry], {
    env: npmEnv,
    stdio: "inherit",
  });
}

function readVerificationState(pkg, npmEnv, registry, tag) {
  return {
    tag: npmViewDistTagResult(pkg, npmEnv, registry, tag),
    version: npmViewVersionResult(pkg, npmEnv, registry),
  };
}

function verificationSucceeded(pkg, state) {
  return state.version.version === pkg.version && state.tag.version === pkg.version;
}

function logPendingVerification(pkg, state, tag, attempt) {
  console.log(
    `release-publish: VERIFY pending ${pkg.spec} ` +
      `(attempt ${String(attempt)}/${String(verifyAttempts)}; ` +
      `version=${state.version.version || state.version.kind}; ` +
      `${tag}=${state.tag.version || state.tag.kind}).`,
  );
}

function failVerification(pkg, state, registry, tag) {
  if (state.version.version !== pkg.version) {
    const observed = state.version.version || state.version.kind;
    fail(`${pkg.spec} is not available in ${registry} after publish (observed ${observed}).`);
  }
  if (state.tag.version !== pkg.version) {
    const observed = state.tag.version || state.tag.kind;
    fail(`${pkg.name}@${tag} points to ${observed}, expected ${pkg.version}.`);
  }
}

function verifyPackage(pkg, npmEnv, registry, tag) {
  let state = readVerificationState(pkg, npmEnv, registry, tag);
  for (let attempt = 1; attempt <= verifyAttempts; attempt += 1) {
    if (verificationSucceeded(pkg, state)) return;
    if (attempt < verifyAttempts) {
      logPendingVerification(pkg, state, tag, attempt);
      waitForRegistryPropagation();
      state = readVerificationState(pkg, npmEnv, registry, tag);
    }
  }
  failVerification(pkg, state, registry, tag);
}

function waitForRegistryPropagation() {
  if (verifyDelayMs === 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, verifyDelayMs);
}

function runReleaseGates() {
  console.log("release-publish: running single publish gate via npm run prepack.");
  run("npm", ["run", "prepack"], { stdio: "inherit" });
}

function runRegistrySmoke(rootPackage, options, npmEnv) {
  if (options.skipSmoke || options.dryRun) {
    console.log("release-publish: registry install smoke skipped.");
    return;
  }
  console.log(`release-publish: running registry install smoke for ${rootPackage.spec}.`);
  run("npm", ["run", "smoke:registry-install"], {
    env: {
      ...npmEnv,
      KEIKO_REGISTRY_INSTALL_PACKAGE: rootPackage.spec,
      KEIKO_REGISTRY_URL: options.registry,
    },
    stdio: "inherit",
  });
}

const options = parseArgs(process.argv.slice(2));
const rootManifest = readJson("package.json");
const workspaces = collectWorkspaceManifests();
validateReleaseManifests(rootManifest, workspaces);
const workspacePackages = [];
const rootPackage = packageRecord(rootManifest, ".");
const publishPlan = [...workspacePackages, rootPackage];

console.log(
  `release-publish: ${rootPackage.spec} -> ${options.registry} with dist-tag ${options.tag}.`,
);
console.log("release-publish: root-only publish; private runtime workspaces are bundled.");
for (const pkg of publishPlan) {
  console.log(`release-publish: plan ${pkg.spec} from ${pkg.packageDir}`);
}

run("npm", ["run", "check:version-consistency"], { stdio: "inherit" });
run("npm", ["run", "check:publish-manifests"], { stdio: "inherit" });
run("npm", ["run", options.planOnly ? "check:release-impact" : "check:release-impact:publish"], {
  stdio: "inherit",
});
const githubReleaseNotes = releaseNotes(rootManifest, options);
const portableAssets = loadPortableAssets(rootManifest, options);

if (options.planOnly) {
  printReleaseNotesPreview(githubReleaseNotes);
  console.log("release-publish: PLAN-ONLY complete.");
  process.exit(0);
}

if (!options.allowUntagged) {
  ensureReleaseTag(rootManifest.version);
}
ensureTrackedTreeIsClean();

const { cleanup, env: npmEnv } = createNpmEnvironment(options.registry);
try {
  runReleaseGates();
  const releaseInfo =
    portableAssets.length > 0 && portableUploadEnabled(options)
      ? ensureGithubRelease(rootPackage, options, githubReleaseNotes)
      : undefined;
  if (releaseInfo !== undefined) {
    publishPortableReleaseAssets(options, portableAssets, releaseInfo);
  }
  for (const pkg of workspacePackages) {
    publishPackage(pkg, npmEnv, options);
  }
  publishPackage(rootPackage, npmEnv, options);

  if (!options.dryRun) {
    for (const pkg of publishPlan) {
      verifyPackage(pkg, npmEnv, options.registry, options.tag);
    }
  }
  runRegistrySmoke(rootPackage, options, npmEnv);
  if (releaseInfo === undefined) {
    const finalReleaseInfo = ensureGithubRelease(rootPackage, options, githubReleaseNotes);
    publishPortableReleaseAssets(options, portableAssets, finalReleaseInfo);
  }
  console.log(`release-publish: PASS - ${rootPackage.spec} published as ${options.tag}.`);
} finally {
  cleanup();
}
