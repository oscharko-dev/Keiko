import { spawnSync } from "node:child_process";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  fstatSync,
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
  findPortableMetadataRedactionFailures,
  PORTABLE_TARGET_NAMES,
  PORTABLE_TARGETS,
  portableVerificationSummaryForManifest,
  readPortableManifest,
  validatePortableCandidateManifest,
  validatePortablePublishedManifest,
  WINDOWS_PORTABLE_SETUP_ASSET_NAME,
} from "./portable-runtime.mjs";
import { internalDependencyEntries, scope } from "./release-workspace-policy.mjs";
import { renderReleaseImpactNotes } from "./release-impact-notes.mjs";
import { parseDotEnvTokenLine } from "./dotenv-token.mjs";
import {
  normalizePortableSetupCompanion,
  portableSetupCompanionRecord,
} from "./lib/portable-setup-companion.mjs";
import { resolveHostExecutable } from "./lib/host-executable.mjs";
import { PORTABLE_EVALUATION_MANIFEST_ASSET_NAME } from "./lib/portable-evaluation-manifest.mjs";
import { resolveReleaseOwnerAllowlist } from "./lib/release-owner-allowlist.mjs";
import {
  collectEvaluationArtifactDigests,
  jsonFromCommand,
  portableReleaseGate,
} from "./lib/portable-release-verification.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const packageRegistryScope = scope.slice(0, -1);
const portableAssetManifestSchemaVersion = 1;
const maxPortableEvidenceBytes = 16 * 1024 * 1024;
const maxPortableArchiveBytes = 2 * 1024 * 1024 * 1024;
const portableAssetsArtifactName = "portable-release-assets";
const portableAssetsWorkflowPath = ".github/workflows/portable-assets.yml";
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

  let index = 0;
  while (index < argv.length) {
    index = applyArg(argv, index, options) + 1;
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

// A stable `latest` release must offer the customer downloads — that requirement did not move.
// What moved is WHERE it is answered. The old gate demanded a qualified asset MANIFEST as a
// publish INPUT, which only the Developer-ID/Azure-signed production lane can produce; the release
// owner scoped the first public release to the unsigned EVALUATION lane, so no stable `latest`
// publish this project can currently produce was accepted. The requirement is now answered against
// REALITY: before npm learns the dist-tag, the GitHub Release must carry all four downloads, and
// downloads this run did not upload must be bound to evidence and re-fetched byte for byte.
//
// The decisions live in scripts/lib/portable-release-verification.mjs because THIS file only ever
// runs as a spawned CLI — nothing defined here can be exercised in-process, so a gate written here
// would be untestable by construction. What stays here is its process I/O.
const portableGate = portableReleaseGate({
  fail,
  fetchAssetToFile: (url, destination) =>
    commandResult(
      "curl",
      [
        "--fail",
        "--silent",
        "--show-error",
        "--location",
        // Bounded so a stalled endpoint cannot hang the publish run indefinitely.
        "--connect-timeout",
        "10",
        "--max-time",
        "120",
        "--output",
        destination,
        url,
      ],
      { env: networkEnvironment() },
    ),
  gh,
  log: (message) => {
    console.log(message);
  },
  setupAssetName: WINDOWS_PORTABLE_SETUP_ASSET_NAME,
  snapshot: githubReleaseSnapshot,
  collectRunArtifactDigests: (repository, runId, artifacts, relevantAssetNames) =>
    collectEvaluationArtifactDigests(
      { gh, fetchArtifactZip: fetchRunArtifactZip, hashFile: sha256FileSync },
      repository,
      runId,
      artifacts,
      relevantAssetNames,
    ),
  targets: PORTABLE_TARGETS,
  verifyBytes: runPortableDownloadSmoke,
});

/**
 * Binary-safe by construction: the shared gh seam decodes stdout as utf8, which would corrupt a
 * zip stream, so this port spawns gh with buffer output, an explicit size ceiling, and writes
 * the bytes untouched. Downloading by immutable artifact id is what keeps a rerun of the
 * referenced workflow from substituting or blocking the recorded evidence (Codex finding on
 * #3054).
 */
function fetchRunArtifactZip(artifactId, destination) {
  // Streamed to the destination through a file descriptor: a staged runtime artifact is hundreds
  // of megabytes, and capturing it in spawnSync's stdout buffer holds the whole archive in
  // memory before a single byte lands on disk (Codex finding on #3055).
  const fd = openSync(destination, "w", 0o600);
  try {
    const result = spawnSync(
      resolveHostExecutable("gh"),
      ["api", `repos/${githubRepository()}/actions/artifacts/${String(artifactId)}/zip`],
      // Bounded twice: a stalled transfer must not block publication forever, and the landed
      // bytes must respect the same archive ceiling every portable input honors.
      { cwd: repoRoot, stdio: ["ignore", fd, "pipe"], env: process.env, timeout: 900_000 },
    );
    if (result.error !== undefined || result.status !== 0) return { status: 1 };
    if (fstatSync(fd).size > maxPortableArchiveBytes) return { status: 1 };
    return { status: 0 };
  } finally {
    closeSync(fd);
  }
}

function verifyPrepublishedStableRelease(rootManifest, options) {
  if (!stableLatestRelease(rootManifest, options) || options.dryRun) return false;
  const head = commandResult("git", ["rev-parse", "HEAD"]);
  if (head.status !== 0) fail("could not resolve the commit being released.");
  return portableGate.verifyPrepublished(
    releaseTag(rootManifest.version),
    githubRepository(),
    portableAssetsWorkflowPath,
    head.stdout.trim(),
  );
}

/**
 * Release notes advertise portable downloads exactly when the release is guaranteed to carry them.
 * For a stable `latest` release that guarantee is now unconditional: ensureStableLatestDownloads
 * fails the publish before npm learns the dist-tag unless all four downloads are present and
 * evidence-bound, so the notes can no longer point at downloads that do not exist — the failure
 * Codex raised on #3051. A prerelease never advertises them; it is not a promotion surface.
 */
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
    const stdout = result.stdout;
    const stderr = result.stderr;
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
    const value = parseDotEnvTokenLine(trimmed);
    if (value !== undefined) return value;
  }
  return undefined;
}

function authConfigKey(registry) {
  const url = new URL(registry);
  const path = url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`;
  return `//${url.host}${path}:_authToken`;
}

function createNpmEnvironment(registry) {
  const token = process.env.NODE_AUTH_TOKEN ?? process.env.NPM_TOKEN ?? loadDotEnvToken();
  const hasToken = token !== undefined && token.length > 0;
  const tempDir = mkdtempSync(join(tmpdir(), "keiko-release-npm-"));
  const userConfig = join(tempDir, ".npmrc");
  // The publish OWNS its transport policy: strict-ssl=true is stated in this temporary
  // userconfig and re-stated through the environment below, so a user-level strict-ssl=false
  // can neither weaken TLS for a release nor block one with a refusal an operator has to
  // decode first (the 0.3.1 publish outage).
  const lines = [
    `registry=${registry}`,
    `${packageRegistryScope}:registry=${registry}`,
    "strict-ssl=true",
  ];
  // No token in CI is expected, not an oversight: the release workflow authenticates
  // `npm publish` via OIDC trusted publishing instead. Leaving no _authToken line here is
  // what lets the npm CLI attempt that OIDC exchange rather than an anonymous request.
  if (hasToken) {
    lines.push(`${authConfigKey(registry)}=${token}`);
  }
  writeFileSync(userConfig, `${lines.join("\n")}\n`);
  chmodSync(userConfig, 0o600);
  return {
    cleanup: () => rmSync(tempDir, { recursive: true, force: true }),
    env: {
      ...process.env,
      NPM_CONFIG_USERCONFIG: userConfig,
      // Environment beats userconfig in npm's precedence; without this a hostile or stale
      // NPM_CONFIG_STRICT_SSL=false in the operator shell would silently override the line above.
      NPM_CONFIG_STRICT_SSL: "true",
    },
    hasToken,
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

function sha256Text(value) {
  return createHash("sha256").update(value).digest("hex");
}

function containedPath(root, path) {
  const normalizedRoot = root.endsWith("/") ? root : `${root}/`;
  return path === root || path.startsWith(normalizedRoot);
}

function regularContainedFile(path, root, label, failures, maxBytes = maxPortableEvidenceBytes) {
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
    if (fileStat.nlink !== 1) {
      failures.push(`${label} must not be hard linked.`);
      return undefined;
    }
    if (fileStat.size <= 0) {
      failures.push(`${label} must not be empty.`);
      return undefined;
    }
    if (fileStat.size > maxBytes) {
      failures.push(`${label} exceeds its bounded size.`);
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
  const suppliesManifest =
    typeof options.portableAssetsManifest === "string" && options.portableAssetsManifest !== "";
  // Supplying assets and then skipping the GitHub Release would publish an npm dist-tag whose
  // announced downloads do not exist: still refused, for stable and prerelease alike.
  const stableLatest = stableLatestRelease(rootManifest, options);
  const live = !options.planOnly && !options.dryRun;
  const inputFailure = portableGate.inputFailure({
    suppliesManifest,
    skipGithubRelease: options.skipGithubRelease === true,
    stableLatest: stableLatest && live,
  });
  if (inputFailure !== undefined) fail(inputFailure);
  if (!suppliesManifest) return [];
  // A stable `latest` release that DOES carry assets is still held to the qualified-run
  // provenance: the same run, attempt, tag, source SHA and workflow that built them. Only a LIVE
  // publish, though — that provenance lives in `KEIKO_PORTABLE_ASSETS_*`, which exists only inside
  // the release workflow, so demanding it in plan-only and dry-run modes made a local release
  // preview fail before it could render its notes even with a perfectly valid manifest (Codex
  // finding on #3054). Those modes still run the full structural manifest validation below.
  const qualification =
    stableLatest && live ? requiredPortableQualification(rootManifest) : undefined;
  return portableAssetsFromManifest(
    resolve(options.portableAssetsManifest),
    rootManifest,
    qualification,
  );
}

function requiredPortableQualification(rootManifest) {
  const qualification = {
    artifactName: process.env.KEIKO_PORTABLE_ASSETS_ARTIFACT_NAME,
    repository: process.env.KEIKO_PORTABLE_ASSETS_REPOSITORY,
    runAttempt: Number(process.env.KEIKO_PORTABLE_ASSETS_RUN_ATTEMPT),
    runId: Number(process.env.KEIKO_PORTABLE_ASSETS_RUN_ID),
    sourceSha: process.env.KEIKO_PORTABLE_ASSETS_SOURCE_SHA,
    tag: process.env.KEIKO_PORTABLE_ASSETS_TAG,
    workflowPath: process.env.KEIKO_PORTABLE_ASSETS_WORKFLOW_PATH,
  };
  const head = commandResult("git", ["rev-parse", "HEAD"]);
  const failures = portableQualificationFailures(qualification, rootManifest, head);
  if (failures.length > 0)
    fail(`qualified portable run provenance is invalid:\n  - ${failures.join("\n  - ")}`);
  return qualification;
}

function portableQualificationFailures(qualification, rootManifest, head) {
  const positiveRunId = Number.isSafeInteger(qualification.runId) && qualification.runId > 0;
  const positiveRunAttempt =
    Number.isSafeInteger(qualification.runAttempt) && qualification.runAttempt > 0;
  const repositoryMatches =
    typeof qualification.repository === "string" &&
    qualification.repository !== "" &&
    // githubRepository() resolves the git remote when GITHUB_REPOSITORY is absent, so a local
    // stable publish compares against the repository it is actually publishing from instead of
    // against an empty string (Codex and CodeRabbit findings on #3054).
    qualification.repository === githubRepository();
  const checks = [
    [/^[a-f0-9]{40}$/u.test(qualification.sourceSha ?? ""), "source SHA must be exact"],
    [qualification.tag === releaseTag(rootManifest.version), "stable tag must match release tag"],
    [positiveRunId, "workflow run id must be positive"],
    [positiveRunAttempt, "workflow run attempt must be positive"],
    [qualification.artifactName === portableAssetsArtifactName, "artifact name must be canonical"],
    [repositoryMatches, "repository must match GITHUB_REPOSITORY"],
    [qualification.workflowPath === portableAssetsWorkflowPath, "workflow path must be canonical"],
    [
      head.status === 0 && head.stdout.trim() === qualification.sourceSha,
      "source SHA must match HEAD",
    ],
  ];
  return checks.flatMap(([valid, message]) => (valid ? [] : [`qualified portable ${message}`]));
}

// Deliberate defense-in-depth: assemble-portable-release-assets.mjs (validatePortableReleaseSet)
// enforces this same exact-three/qualification-binding invariant at assembly; keep in sync.
function portableAssetsFromManifest(inputPath, rootManifest, qualification) {
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
  const normalized = normalizePortableAssets(
    artifacts,
    baseDir,
    rootManifest,
    qualification,
    failures,
  );
  if (failures.length > 0) {
    fail(`portable assets manifest validation failed:\n  - ${failures.join("\n  - ")}`);
  }
  return normalized;
}

function normalizePortableAssets(artifacts, baseDir, rootManifest, qualification, failures) {
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
      qualification,
      failures,
    ),
  );
}

function normalizePortableTargetAsset(
  entry,
  target,
  baseDir,
  rootManifest,
  qualification,
  failures,
) {
  if (!isRecord(entry)) {
    failures.push(`missing portable asset entry for ${target.platformTarget}.`);
    return [];
  }
  const context = portableTargetAssetContext(entry, target, baseDir, failures);
  validatePortableAssetFiles({
    target,
    rootManifest,
    qualification,
    failures,
    ...context,
  });
  return [
    portableAssetRecord(
      target,
      context.archivePath,
      context.manifestPath,
      context.manifest,
      entry,
      failures,
      context.setupPath,
    ),
  ];
}

function portableTargetAssetContext(entry, target, baseDir, failures) {
  const { archivePath, manifestPath } = portableTargetPaths(entry, target, baseDir, failures);
  const stageRoot = dirname(dirname(manifestPath));
  const setupCompanion = normalizePortableSetupCompanion({
    baseDir,
    entry,
    platformTarget: target.platformTarget,
    stageRoot,
  });
  failures.push(...setupCompanion.failures);
  const archiveStat = regularContainedFile(
    archivePath,
    stageRoot,
    `${target.platformTarget}.archivePath`,
    failures,
    maxPortableArchiveBytes,
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
  return { archivePath, archiveStat, manifest, manifestPath, setupPath: setupCompanion.setupPath };
}

function portableTargetPaths(entry, target, baseDir, failures) {
  return {
    archivePath: resolve(
      baseDir,
      requiredString(entry, "archivePath", target.platformTarget, failures),
    ),
    manifestPath: resolve(
      baseDir,
      requiredString(entry, "manifestPath", target.platformTarget, failures),
    ),
  };
}

function readPortableManifestSafely(path, platformTarget, failures) {
  try {
    return readPortableManifest(path);
  } catch {
    failures.push(`${platformTarget}.manifestPath must contain valid JSON.`);
    return {};
  }
}

function validatePortableAssetFiles({
  target,
  archivePath,
  archiveStat,
  manifestPath,
  manifest,
  rootManifest,
  qualification,
  failures,
}) {
  if (basename(archivePath) !== target.assetName) {
    failures.push(`${target.platformTarget}.archivePath must be named ${target.assetName}.`);
  }
  for (const failure of validatePortableCandidateManifest(manifest)) {
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
  validateQualificationBinding(manifest, target, qualification, failures);
  validateOuterTargetBinding(manifest, target, failures);
  validatePortableArchiveDigest(target, archivePath, archiveStat, manifest, failures);
  validatePortableEvidenceFiles(target, dirname(dirname(manifestPath)), manifest, failures);
}

function validateQualificationBinding(manifest, target, qualification, failures) {
  if (qualification === undefined) return;
  const checks = [
    [manifest.release?.commitSha, qualification.sourceSha, "source SHA"],
    [manifest.provenance?.sourceCommitSha, qualification.sourceSha, "provenance source SHA"],
    [manifest.release?.releaseTag, qualification.tag, "release tag"],
    [manifest.provenance?.buildWorkflowRunId, qualification.runId, "workflow run id"],
    [manifest.provenance?.buildWorkflowAttempt, qualification.runAttempt, "workflow run attempt"],
  ];
  for (const [actual, expected, label] of checks) {
    if (actual !== expected) {
      failures.push(`${target.platformTarget}.${label} must match the downloaded workflow run.`);
    }
  }
}

function validateOuterTargetBinding(manifest, target, failures) {
  const checks = [
    [manifest.artifact?.platformTarget, target.platformTarget, "artifact.platformTarget"],
    [manifest.artifact?.assetName, target.assetName, "artifact.assetName"],
    [manifest.runtime?.nodePlatform, target.nodePlatform, "runtime.nodePlatform"],
    [manifest.runtime?.nodeArchitecture, target.nodeArchitecture, "runtime.nodeArchitecture"],
    [manifest.security?.signatureKind, target.signatureKind, "security.signatureKind"],
  ];
  for (const [actual, expected, label] of checks) {
    if (actual !== expected)
      failures.push(`${target.platformTarget}.${label} must match the outer bundle target.`);
  }
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
    const stat = regularContainedFile(
      evidence.sourcePath,
      stageRoot,
      `${target.platformTarget}.${evidence.relativePath}`,
      failures,
    );
    if (stat !== undefined && evidence.relativePath !== "manifest/portable-manifest.json")
      validateEvidenceContent(evidence.sourcePath, evidence.assetName, failures);
  }
  const checksumsPath = containedLocalPath(
    stageRoot,
    manifest.evidence?.checksumsPath,
    "checksumsPath",
    failures,
  );
  if (checksumsPath !== undefined && existsSync(checksumsPath)) {
    const expected = `${manifest.artifact?.sha256}  ${manifest.artifact?.assetName}`;
    if (readFileSync(checksumsPath, "utf8") !== `${expected}\n`) {
      failures.push(`${target.platformTarget}.checksumsPath must bind the archive digest.`);
    }
  }
  validateSigningSummary(target, stageRoot, manifest, failures);
  validateProvenanceStatement(target, stageRoot, manifest, failures);
  validateSbomAndLicense(target, stageRoot, manifest, failures);
  validateSidecarEvidenceFiles(target, stageRoot, manifest, failures);
}

function validateEvidenceContent(path, label, failures) {
  const text = readFileSync(path, "utf8");
  const redactionFailures = findPortableMetadataRedactionFailures(text, label);
  if (/\.(?:json|jsonl)$/u.test(path)) {
    try {
      redactionFailures.push(...findPortableMetadataRedactionFailures(JSON.parse(text), label));
    } catch {
      failures.push(`${label} must contain valid JSON evidence.`);
    }
  }
  if (redactionFailures.length > 0) {
    failures.push(`${label} is not redacted.`);
  }
}

function readEvidenceJson(path, label, failures) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    failures.push(`${label} must contain valid JSON.`);
    return {};
  }
}

function validateSigningSummary(target, stageRoot, manifest, failures) {
  const path = containedLocalPath(
    stageRoot,
    manifest.security?.verificationSummaryPath,
    "signing summary",
    failures,
  );
  if (path === undefined || !existsSync(path)) return;
  const actual = readEvidenceJson(path, `${target.platformTarget}.signing summary`, failures);
  if (JSON.stringify(actual) !== JSON.stringify(portableVerificationSummaryForManifest(manifest))) {
    failures.push(`${target.platformTarget}.signing summary must match the manifest.`);
  }
}

function validateProvenanceStatement(target, stageRoot, manifest, failures) {
  const path = containedLocalPath(
    stageRoot,
    manifest.provenance?.provenanceStatementPath,
    "provenance statement",
    failures,
  );
  if (path === undefined || !existsSync(path)) return;
  const text = readFileSync(path, "utf8");
  if (sha256Text(text) !== manifest.provenance?.provenanceStatementSha256) {
    failures.push(`${target.platformTarget}.provenance statement digest must match.`);
  }
  const statement = readEvidenceJson(
    path,
    `${target.platformTarget}.provenance statement`,
    failures,
  );
  const expected = portableProvenanceExpectation(target, manifest);
  if (!Object.entries(expected).every(([key, value]) => statement[key] === value))
    failures.push(`${target.platformTarget}.provenance statement semantics must match.`);
}

function portableProvenanceExpectation(target, manifest) {
  return {
    artifact: manifest.artifact?.assetName,
    buildWorkflowAttempt: manifest.provenance?.buildWorkflowAttempt,
    buildWorkflowRunId: manifest.provenance?.buildWorkflowRunId,
    packageVersion: manifest.product?.packageVersion,
    sourceCommitSha: manifest.release?.commitSha,
    subjectDigest: manifest.artifact?.sha256,
    target: target.platformTarget,
  };
}

function validateSbomAndLicense(target, stageRoot, manifest, failures) {
  const sbomPath = containedLocalPath(
    stageRoot,
    manifest.evidence?.sbomPath,
    "SBOM evidence",
    failures,
  );
  if (sbomPath !== undefined && existsSync(sbomPath)) {
    const sbom = readEvidenceJson(sbomPath, `${target.platformTarget}.SBOM evidence`, failures);
    if (sbom.bomFormat !== "CycloneDX")
      failures.push(`${target.platformTarget}.SBOM evidence is invalid.`);
  }
  const licensePath = containedLocalPath(
    stageRoot,
    manifest.evidence?.licenseNoticePath,
    "license evidence",
    failures,
  );
  if (licensePath !== undefined && existsSync(licensePath)) {
    const text = readFileSync(licensePath, "utf8");
    if (findPortableMetadataRedactionFailures(text).length > 0)
      failures.push(`${target.platformTarget}.license evidence is not redacted.`);
  }
}

function validateSidecarEvidenceFiles(target, stageRoot, manifest, failures) {
  const resourceRoot =
    target.nodePlatform === "darwin"
      ? join(stageRoot, "payload", "Keiko", "Keiko.app", "Contents", "Resources")
      : join(stageRoot, "payload", "Keiko");
  for (const sidecar of manifest.sidecarRuntimes ?? []) {
    for (const [evidence, requiresCycloneDx] of [
      [sidecar.licenseEvidence, false],
      [sidecar.sbomEvidence, true],
    ]) {
      validateOneSidecarEvidence(target, resourceRoot, evidence, requiresCycloneDx, failures);
    }
  }
}

function validateOneSidecarEvidence(target, resourceRoot, evidence, requiresCycloneDx, failures) {
  const path = containedLocalPath(
    resourceRoot,
    evidence?.path,
    `${target.platformTarget} sidecar evidence`,
    failures,
  );
  if (path === undefined) return;
  const stat = regularContainedFile(path, resourceRoot, "sidecar evidence", failures);
  if (stat === undefined) return;
  validateEvidenceContent(path, "sidecar evidence", failures);
  if (requiresCycloneDx) {
    const sbom = readEvidenceJson(path, "sidecar SBOM evidence", failures);
    if (sbom.bomFormat !== "CycloneDX") failures.push("sidecar SBOM evidence is invalid.");
  }
  if (sha256FileSync(path) !== evidence.sha256)
    failures.push("sidecar evidence digest must match the manifest.");
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
  failures,
  setupPath,
) {
  const stageRoot = dirname(dirname(manifestPath));
  const requiredEvidence = requiredPortableEvidence(target, stageRoot, manifest, failures);
  const extraEvidence = extraPortableEvidenceFiles(entry, stageRoot, target, failures);
  for (const evidence of extraEvidence) {
    validateEvidenceContent(evidence.sourcePath, evidence.assetName, failures);
  }
  const evidenceFiles = [...requiredEvidence, ...extraEvidence];
  const record = portableSetupCompanionRecord(
    {
      archiveAssetName: target.assetName,
      archivePath,
      evidenceFiles,
      manifest,
      platformTarget: target.platformTarget,
      stageRoot,
    },
    setupPath,
  );
  return setupPath === undefined
    ? record
    : {
        ...record,
        setupSha256: entry.setupSha256,
        setupSizeBytes: entry.setupSizeBytes,
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

/**
 * The releases this publisher must never edit over (Codex findings on #3054). An interrupted
 * `--public-release` leaves a resumable stable-tag DRAFT; editing it would keep it private while
 * npm publishes. A COMPLETED `--public-release` leaves a published release carrying the
 * evaluation manifest; uploading qualified production assets over it would clobber only
 * same-named files and leave that evidence beside foreign bytes — a mixed-provenance surface.
 * Both belong to the evaluation lane: only the prepublished VERIFY path may touch such a tag.
 * An unreadable answer refuses: fail closed.
 */
function refuseEvaluationOwnedRelease(existing, tag) {
  const view = jsonFromCommand(existing);
  if (view?.isDraft !== false) {
    fail(
      `GitHub release ${tag} exists as a draft — an interrupted evaluation publish leaves one. Resume or delete it with scripts/release-portable-prerelease.mjs before publishing over this tag.`,
    );
  }
  const assets = Array.isArray(view.assets) ? view.assets : [];
  if (assets.some((asset) => asset?.name === PORTABLE_EVALUATION_MANIFEST_ASSET_NAME)) {
    fail(
      `GitHub release ${tag} was published by the evaluation lane and carries its evidence manifest; editing or uploading over it would mix provenance. A qualified production publish needs its own version and tag.`,
    );
  }
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
  const existing = gh(["release", "view", tag, "--repo", repo, "--json", "isDraft,assets"]);

  if (existing.status === 0) {
    refuseEvaluationOwnedRelease(existing, tag);
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
  verifyPortableSetupAttestations(assets, releaseInfo);
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

function verifyPortableSetupAttestations(assets, releaseInfo) {
  const signerWorkflow = `${releaseInfo.repo}/${portableAssetsWorkflowPath}`;
  const sourceDigest = process.env.KEIKO_PORTABLE_ASSETS_SOURCE_SHA;
  if (!/^[a-f0-9]{40}$/u.test(sourceDigest ?? "")) {
    fail("portable setup attestation source SHA must be exact.");
  }
  for (const asset of assets) {
    if (asset.setupPath === undefined) continue;
    runGh([
      "attestation",
      "verify",
      asset.setupPath,
      "--repo",
      releaseInfo.repo,
      "--signer-workflow",
      signerWorkflow,
      "--source-digest",
      sourceDigest,
      "--source-ref",
      `refs/tags/${releaseInfo.tag}`,
    ]);
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
      expectedSha256: asset.manifest.artifact.sha256,
      expectedSize: asset.manifest.artifact.sizeBytes,
      firstClassArchive: true,
    });
    if (asset.setupPath !== undefined) {
      addUploadPath(asset.setupPath, asset.setupAssetName, names, paths);
      expected.push({
        assetName: asset.setupAssetName,
        expectedSha256: asset.setupSha256,
        expectedSize: asset.setupSizeBytes,
        firstClassArchive: false,
      });
    }
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
        expectedSha256: sha256FileSync(destination),
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
  const setupBinding = remoteSetupBinding(asset, remoteByName);
  const manifest = boundPortableManifest(asset.manifest, releaseId, remote.id, setupBinding);
  const failures = validatePortablePublishedManifest(manifest, {
    assetId: remote.id,
    releaseId,
    ...(setupBinding === undefined ? {} : { setupAsset: setupBinding }),
  }).map((failure) => `${asset.platformTarget}.${failure}`);
  if (failures.length > 0) {
    fail(`portable manifest binding failed:\n  - ${failures.join("\n  - ")}`);
  }
  return { ...asset, manifest };
}

function remoteSetupBinding(asset, remoteByName) {
  if (asset.setupPath === undefined) return undefined;
  const remote = remoteByName.get(asset.setupAssetName);
  if (!isRecord(remote) || !Number.isSafeInteger(remote.id) || remote.id <= 0) {
    fail(`${asset.setupAssetName} must have a remote GitHub asset id before evidence upload.`);
  }
  return {
    assetId: remote.id,
    assetName: asset.setupAssetName,
    sha256: asset.setupSha256,
    sizeBytes: asset.setupSizeBytes,
  };
}

function boundPortableManifest(source, releaseId, assetId, setupBinding) {
  const manifest = structuredClone(source);
  manifest.release = { ...manifest.release, releaseId };
  manifest.artifact = { ...manifest.artifact, assetId };
  manifest.releaseImpact = {
    ...manifest.releaseImpact,
    reviewedBinding: {
      ...manifest.releaseImpact.reviewedBinding,
      assetId,
      releaseId,
      ...(setupBinding === undefined ? {} : { setupAsset: setupBinding }),
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
    smokePortableDownloadUrl(expected, url);
  }
}

function smokePortableDownloadUrl(expected, url) {
  const root = mkdtempSync(join(tmpdir(), "keiko-portable-download-"));
  const destination = join(root, expected.assetName);
  try {
    const result = commandResult(
      "curl",
      ["--fail", "--silent", "--show-error", "--location", "--output", destination, url],
      { env: networkEnvironment() },
    );
    if (result.error !== undefined || result.status !== 0) {
      fail(`unauthenticated portable asset download failed for ${expected.assetName}.`);
    }
    if (
      statSync(destination).size !== expected.expectedSize ||
      sha256FileSync(destination) !== expected.expectedSha256
    ) {
      fail(`downloaded portable asset bytes do not match ${expected.assetName}.`);
    }
  } finally {
    rmSync(root, { force: true, recursive: true });
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

function publishPackage(pkg, npmEnv, options, hasToken) {
  if (options.dryRun) {
    publishPackageDryRun(pkg, npmEnv, options);
    return;
  }

  if (npmViewVersion(pkg, npmEnv, options.registry)) {
    console.log(`release-publish: SKIP ${pkg.spec} already exists.`);
  } else {
    publishPackageToRegistry(pkg, npmEnv, options);
  }
  ensurePackageDistTag(pkg, npmEnv, options, hasToken);
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

/**
 * npm can attest provenance only where an OIDC provider exists — GitHub Actions announces its
 * id-token endpoint through this environment value. Everywhere else the flag makes `npm publish`
 * fail outright, which turned the documented local operator publish into a dead end (the 0.3.1
 * outage). A token publish simply carries no provenance attestation, exactly like every release
 * before attestation existed.
 */
function oidcTrustedPublishingAvailable() {
  // The identity exchange needs BOTH values GitHub Actions issues under `id-token: write`;
  // the request URL alone cannot mint a token (CodeRabbit finding on #3055).
  const url = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const token = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  return typeof url === "string" && url.length > 0 && typeof token === "string" && token.length > 0;
}

function provenancePublishArgs() {
  return oidcTrustedPublishingAvailable() ? ["--provenance"] : [];
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
      ...provenancePublishArgs(),
      "--ignore-scripts",
    ],
    { env: npmEnv, stdio: "inherit" },
  );
}

function ensurePackageDistTag(pkg, npmEnv, options, hasToken) {
  let currentTag = npmViewDistTag(pkg, npmEnv, options.registry, options.tag);
  if (currentTag === pkg.version) {
    console.log(`release-publish: TAG ${pkg.name}@${options.tag} -> ${pkg.version}.`);
    return;
  }
  // npm Trusted Publishing (OIDC) authorizes `npm publish` only, not `npm dist-tag add`. A
  // fresh `npm publish --tag` already sets the tag atomically at the source, but the very
  // next `npm view` can still race the registry's own read replicas/CDN, so a mismatch here
  // is usually transient propagation lag rather than a real problem — the same reality
  // verifyPackage() below already retries for. Only after that same retry budget is
  // exhausted do we treat it as a genuine idempotent-re-run repair and fail with a recovery
  // hint, instead of letting an unauthenticated `npm dist-tag add` 401 confusingly.
  if (!hasToken) {
    for (let attempt = 2; attempt <= verifyAttempts && currentTag !== pkg.version; attempt += 1) {
      console.log(
        `release-publish: TAG pending ${pkg.name}@${options.tag} ` +
          `(attempt ${String(attempt)}/${String(verifyAttempts)}; observed ${currentTag || "no published version"}).`,
      );
      waitForRegistryPropagation();
      currentTag = npmViewDistTag(pkg, npmEnv, options.registry, options.tag);
    }
    if (currentTag === pkg.version) {
      console.log(`release-publish: TAG ${pkg.name}@${options.tag} -> ${pkg.version}.`);
      return;
    }
    fail(
      `${pkg.name}@${options.tag} points to ${currentTag || "no published version"}, expected ` +
        `${pkg.version}, and no registry credential is configured to correct it. npm Trusted ` +
        "Publishing does not cover `npm dist-tag add`. Supply NODE_AUTH_TOKEN (or NPM_TOKEN) " +
        "for a one-off manual fix, or confirm the earlier publish attempt actually completed " +
        "before retrying.",
    );
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
// The publish-time approval verifier refuses every approval over an empty allowlist; resolve it
// the same way the workflow does before the child runs, so a local operator publish does not
// abort on an environment value only CI used to carry (the 0.3.1 outage). Resolution failure is
// only fatal where the approval itself is required — a live publish.
const releaseImpactEnv = { ...process.env };
if (!options.planOnly) {
  const allowlist = resolveReleaseOwnerAllowlist({
    configured: process.env.KEIKO_RELEASE_OWNER_GITHUB_LOGINS,
    repository: githubRepository(),
    runGh: (args) => gh(args),
  });
  if (allowlist === undefined) {
    fail(
      "the release-owner allowlist did not resolve: set KEIKO_RELEASE_OWNER_GITHUB_LOGINS or grant this checkout a gh login that can read the repository variable.",
    );
  }
  releaseImpactEnv.KEIKO_RELEASE_OWNER_GITHUB_LOGINS = allowlist;
  releaseImpactEnv.GITHUB_REPOSITORY = releaseImpactEnv.GITHUB_REPOSITORY ?? githubRepository();
  // The same preflight moment answers the auth question: a live publish that would only
  // discover a missing npm auth path AFTER the twenty-minute gate chain wastes the whole run.
  if (!options.dryRun) {
    const oidcAvailable = oidcTrustedPublishingAvailable();
    const tokenPresent = Boolean(
      process.env.NODE_AUTH_TOKEN ?? process.env.NPM_TOKEN ?? loadDotEnvToken(),
    );
    if (!oidcAvailable && !tokenPresent) {
      fail(
        "no npm auth path is available: set NODE_AUTH_TOKEN or NPM_TOKEN (or a local .env), or run in CI where OIDC trusted publishing authenticates.",
      );
    }
  }
}
run("npm", ["run", options.planOnly ? "check:release-impact" : "check:release-impact:publish"], {
  stdio: "inherit",
  env: releaseImpactEnv,
});
// Assets first: the notes may only advertise portable downloads this release actually carries.
const portableAssets = loadPortableAssets(rootManifest, options);
const githubReleaseNotes = releaseNotes(rootManifest, options);

if (options.planOnly) {
  printReleaseNotesPreview(githubReleaseNotes);
  console.log("release-publish: PLAN-ONLY complete.");
  process.exit(0);
}

if (!options.allowUntagged) {
  ensureReleaseTag(rootManifest.version);
}
ensureTrackedTreeIsClean();

const { cleanup, env: npmEnv, hasToken } = createNpmEnvironment(options.registry);
try {
  runReleaseGates();
  // A stable `latest` release must be proven complete BEFORE npm learns the dist-tag. When this
  // run has nothing to upload, that proof is taken from the release the governed evaluation lane
  // already published, and it is taken FIRST — creating the release up front would leave a public,
  // empty Latest release behind whenever the verification then failed, which also blocks the
  // evaluation lane from recreating that tag (Codex finding on #3054).
  const uploadsAssets = portableAssets.length > 0;
  // A verified prepublished release is COMPLETE — the governed evaluation lane created it with the
  // Latest flag and the customer-facing install notes (first-launch steps, checksums, provenance).
  // Rewriting its body here with the generated catalog notes would replace exactly the guidance a
  // non-technical customer needs. This run owns npm; that lane owns its release surface.
  const prepublished = !uploadsAssets && verifyPrepublishedStableRelease(rootManifest, options);
  const releaseInfo =
    uploadsAssets && portableUploadEnabled(options)
      ? ensureGithubRelease(rootPackage, options, githubReleaseNotes)
      : undefined;
  if (releaseInfo !== undefined) {
    publishPortableReleaseAssets(options, portableAssets, releaseInfo);
    portableGate.assertUploadedSetComplete(releaseInfo);
  }
  for (const pkg of workspacePackages) {
    publishPackage(pkg, npmEnv, options, hasToken);
  }
  publishPackage(rootPackage, npmEnv, options, hasToken);

  if (!options.dryRun) {
    for (const pkg of publishPlan) {
      verifyPackage(pkg, npmEnv, options.registry, options.tag);
    }
  }
  runRegistrySmoke(rootPackage, options, npmEnv);
  // A prepublished release is already correct and already Latest; anything else still needs its
  // GitHub Release created or refreshed after the registry smoke.
  if (releaseInfo === undefined && !prepublished) {
    const finalReleaseInfo = ensureGithubRelease(rootPackage, options, githubReleaseNotes);
    publishPortableReleaseAssets(options, portableAssets, finalReleaseInfo);
  }
  console.log(`release-publish: PASS - ${rootPackage.spec} published as ${options.tag}.`);
} finally {
  cleanup();
}
