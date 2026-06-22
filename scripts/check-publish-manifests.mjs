import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const scope = "@oscharko-dev/";
const failures = [];
const explicitPrivateWorkspaceExclusions = new Map([
  [
    "@oscharko-dev/keiko-ui",
    "build-time UI workspace; the root package ships the static UI artifact under dist/ui",
  ],
  [
    "@oscharko-dev/keiko-editor",
    "build-time editor workspace; not part of the root runtime dependency closure",
  ],
]);

function readJson(relativePath) {
  return JSON.parse(readFileSync(join(repoRoot, relativePath), "utf8"));
}

function fail(message) {
  failures.push(message);
}

function internalDependencyEntries(manifest) {
  const entries = [];
  for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
    const deps = manifest[field];
    if (deps === undefined) continue;
    if (deps === null || typeof deps !== "object" || Array.isArray(deps)) {
      fail(`${manifest.name ?? "<unnamed>"}: ${field} must be an object when present.`);
      continue;
    }
    for (const [name, specifier] of Object.entries(deps)) {
      if (name.startsWith(scope)) {
        entries.push({ field, name, specifier });
      }
    }
  }
  return entries;
}

const rootManifest = readJson("package.json");
const expectedVersion = rootManifest.version;

if (typeof expectedVersion !== "string" || expectedVersion.length === 0) {
  fail("root package.json must declare a release version.");
}

const workspaceManifests = [];
for (const dir of readdirSync(join(repoRoot, "packages"), { withFileTypes: true })) {
  if (!dir.isDirectory()) continue;
  const relativePath = join("packages", dir.name, "package.json");
  if (!existsSync(join(repoRoot, relativePath))) continue;
  const manifest = readJson(relativePath);
  if (typeof manifest.name !== "string" || !manifest.name.startsWith(scope)) {
    fail(`${relativePath}: workspace package must declare an ${scope} package name.`);
    continue;
  }
  workspaceManifests.push({ relativePath, manifest });
}

const workspaceNames = new Set(workspaceManifests.map(({ manifest }) => manifest.name));

for (const { relativePath, manifest } of workspaceManifests) {
  if (manifest.version !== expectedVersion) {
    fail(`${relativePath}: version ${manifest.version} does not match root ${expectedVersion}.`);
  }
  const privateExclusion = explicitPrivateWorkspaceExclusions.get(manifest.name);
  if (manifest.private === true && privateExclusion === undefined) {
    fail(`${relativePath}: publishable release workspace must not set private: true.`);
  }
  if (manifest.private !== true && privateExclusion !== undefined) {
    fail(`${relativePath}: ${manifest.name} must stay private (${privateExclusion}).`);
  }
  for (const { field, name, specifier } of internalDependencyEntries(manifest)) {
    if (!workspaceNames.has(name)) {
      fail(`${relativePath}: ${field}.${name} does not refer to a local workspace package.`);
    }
    if (specifier !== expectedVersion) {
      fail(
        `${relativePath}: ${field}.${name} must be pinned to ${expectedVersion}, got ${specifier}.`,
      );
    }
  }
}

const rootInternalDependencies = internalDependencyEntries(rootManifest);
const bundled = new Set(
  Array.isArray(rootManifest.bundleDependencies) ? rootManifest.bundleDependencies : [],
);

for (const { field, name, specifier } of rootInternalDependencies) {
  if (field !== "dependencies") {
    fail(`package.json: root published package must list ${name} under dependencies only.`);
  }
  if (!workspaceNames.has(name)) {
    fail(`package.json: dependency ${name} does not refer to a local workspace package.`);
  }
  if (explicitPrivateWorkspaceExclusions.has(name)) {
    fail(`package.json: dependency ${name} is a private build-time workspace exclusion.`);
  }
  if (specifier !== expectedVersion) {
    fail(`package.json: dependency ${name} must be pinned to ${expectedVersion}, got ${specifier}.`);
  }
  if (!bundled.has(name)) {
    fail(`package.json: dependency ${name} must also be listed in bundleDependencies.`);
  }
}

for (const name of bundled) {
  if (!name.startsWith(scope)) continue;
  if (!workspaceNames.has(name)) {
    fail(`package.json: bundleDependencies entry ${name} is not a local workspace package.`);
  }
  if (explicitPrivateWorkspaceExclusions.has(name)) {
    fail(`package.json: bundleDependencies entry ${name} is a private build-time workspace exclusion.`);
  }
  if (!rootInternalDependencies.some((entry) => entry.name === name)) {
    fail(`package.json: bundleDependencies entry ${name} is missing from dependencies.`);
  }
}

if (failures.length > 0) {
  console.error("publish-manifests: FAIL");
  for (const message of failures) {
    console.error(`  - ${message}`);
  }
  process.exit(1);
}

console.log(
  `publish-manifests: PASS - ${workspaceManifests.length - explicitPrivateWorkspaceExclusions.size} runtime workspaces are publishable and pinned to ${expectedVersion}.`,
);
