import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { URL } from "node:url";

import {
  explicitPrivateWorkspaceExclusions,
  internalDependencyEntries,
  scope,
} from "./release-workspace-policy.mjs";
import { renderReleaseImpactNotes } from "./release-impact-notes.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const packageRegistryScope = scope.slice(0, -1);
const supportedDistTags = new Set(["beta", "next", "latest"]);
const booleanArgHandlers = new Map([
  ["--allow-untagged", (options) => (options.allowUntagged = true)],
  ["--dry-run", (options) => (options.dryRun = true)],
  ["--plan-only", (options) => (options.planOnly = true)],
  ["--skip-github-release", (options) => (options.skipGithubRelease = true)],
  ["--skip-smoke", (options) => (options.skipSmoke = true)],
]);
const valueArgFields = new Map([
  ["--registry", "registry"],
  ["--tag", "tag"],
]);

function fail(message) {
  console.error(`release-publish: FAIL - ${message}`);
  process.exit(1);
}

function readJson(relativePath) {
  return JSON.parse(readFileSync(join(repoRoot, relativePath), "utf8"));
}

function defaultOptions() {
  return {
    allowUntagged: false,
    dryRun: false,
    planOnly: false,
    registry: process.env.KEIKO_REGISTRY_URL ?? "https://registry.npmjs.org/",
    skipGithubRelease: false,
    skipSmoke: false,
    tag: process.env.NPM_DIST_TAG,
  };
}

function applyAssignmentArg(arg, options) {
  const match = /^(--registry|--tag)=(.*)$/u.exec(arg);
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
  const privateExclusion = explicitPrivateWorkspaceExclusions.get(manifest.name);
  if (manifest.private === true && privateExclusion === undefined) {
    failures.push(`${relativePath}: publishable release workspace must not set private: true.`);
  }
  if (manifest.private !== true && privateExclusion !== undefined) {
    failures.push(`${relativePath}: ${manifest.name} must stay private (${privateExclusion}).`);
  }
  return true;
}

function validateWorkspaceDependency(workspace, entry, context, failures) {
  const { manifest, relativePath } = workspace;
  const { expectedVersion, publishableByName, workspaceByName } = context;
  const { field, name, specifier } = entry;
  if (name === undefined) {
    failures.push(`${manifest.name}: ${field} must be an object when present.`);
    return;
  }
  if (!workspaceByName.has(name)) {
    failures.push(`${relativePath}: ${field}.${name} does not refer to a local workspace package.`);
  }
  if (manifest.private !== true && !publishableByName.has(name)) {
    failures.push(
      `${relativePath}: publishable workspace must not depend on private workspace ${name}.`,
    );
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
  const publishableByName = new Map(
    workspaces
      .filter(({ manifest }) => manifest.private !== true)
      .map((workspace) => [workspace.manifest.name, workspace]),
  );

  validateRootManifest(rootManifest, options, failures);
  const context = { expectedVersion, publishableByName, workspaceByName };

  for (const workspace of workspaces) {
    if (!validateWorkspaceIdentity(workspace, expectedVersion, failures)) continue;
    for (const entry of internalDependencyEntries(workspace.manifest)) {
      validateWorkspaceDependency(workspace, entry, context, failures);
    }
  }

  if (failures.length > 0) {
    fail(`manifest validation failed:\n  - ${failures.join("\n  - ")}`);
  }

  return { publishableByName, workspaceByName };
}

function sortPublishableWorkspaces(publishableByName) {
  const visiting = new Set();
  const visited = new Set();
  const order = [];

  function visit(name) {
    if (visited.has(name)) return;
    if (visiting.has(name)) {
      fail(`workspace dependency cycle detected at ${name}.`);
    }
    visiting.add(name);
    const workspace = publishableByName.get(name);
    for (const { name: dependencyName } of internalDependencyEntries(workspace.manifest)) {
      if (dependencyName !== undefined && publishableByName.has(dependencyName)) {
        visit(dependencyName);
      }
    }
    visiting.delete(name);
    visited.add(name);
    order.push(workspace);
  }

  for (const name of publishableByName.keys()) {
    visit(name);
  }
  return order;
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
  const catalog = readJson("release-impact.catalog.json");
  const result = withPublishApprovalRequirement(!options.planOnly, () =>
    renderReleaseImpactNotes(catalog, rootManifest, options),
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

function releaseIsPrerelease(version, tag) {
  return version.includes("-") || tag !== "latest";
}

function ensureGithubRelease(rootPackage, options, notes) {
  if (options.skipGithubRelease || options.dryRun) {
    console.log("release-publish: GitHub release skipped.");
    printReleaseNotesPreview(notes);
    return;
  }

  const tag = `v${rootPackage.version}`;
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
    return;
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
}

function npmViewVersion(pkg, npmEnv, registry) {
  const result = commandResult("npm", ["view", pkg.spec, "version", "--registry", registry], {
    env: npmEnv,
  });
  if (result.status === 0 && result.stdout.trim() === pkg.version) {
    return true;
  }
  const viewOutput = `${result.stdout}\n${result.stderr}`;
  if (viewOutput.includes("E404") || viewOutput.includes("No match found")) {
    return false;
  }
  fail(
    `could not inspect ${pkg.spec} in ${registry}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
}

function npmViewDistTag(pkg, npmEnv, registry, tag) {
  const result = commandResult(
    "npm",
    ["view", pkg.name, `dist-tags.${tag}`, "--registry", registry],
    {
      env: npmEnv,
    },
  );
  if (result.status !== 0) {
    fail(
      `could not inspect ${pkg.name} dist-tag ${tag}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
  return result.stdout.trim();
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

function verifyPackage(pkg, npmEnv, registry, tag) {
  if (!npmViewVersion(pkg, npmEnv, registry)) {
    fail(`${pkg.spec} is not available in ${registry} after publish.`);
  }
  const currentTag = npmViewDistTag(pkg, npmEnv, registry, tag);
  if (currentTag !== pkg.version) {
    fail(`${pkg.name}@${tag} points to ${currentTag}, expected ${pkg.version}.`);
  }
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
const { publishableByName } = validateReleaseManifests(rootManifest, workspaces);
const orderedWorkspaces = sortPublishableWorkspaces(publishableByName);
const workspacePackages = orderedWorkspaces.map(({ manifest, packageDir }) =>
  packageRecord(manifest, packageDir),
);
const rootPackage = packageRecord(rootManifest, ".");
const publishPlan = [...workspacePackages, rootPackage];

console.log(
  `release-publish: ${rootPackage.spec} -> ${options.registry} with dist-tag ${options.tag}.`,
);
for (const pkg of publishPlan) {
  console.log(`release-publish: plan ${pkg.spec} from ${pkg.packageDir}`);
}

run("npm", ["run", "check:version-consistency"], { stdio: "inherit" });
run("npm", ["run", "check:publish-manifests"], { stdio: "inherit" });
run("npm", ["run", options.planOnly ? "check:release-impact" : "check:release-impact:publish"], {
  stdio: "inherit",
});
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

const { cleanup, env: npmEnv } = createNpmEnvironment(options.registry);
try {
  runReleaseGates();
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
  ensureGithubRelease(rootPackage, options, githubReleaseNotes);
  console.log(`release-publish: PASS - ${rootPackage.spec} published as ${options.tag}.`);
} finally {
  cleanup();
}
