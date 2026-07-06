import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  explicitPrivateWorkspaceExclusions,
  internalDependencyEntries,
  scope,
} from "./release-workspace-policy.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const expectedRepositoryUrl = "https://github.com/oscharko-dev/Keiko";
const deniedWorkspaceExports = new Map([
  [
    "@oscharko-dev/keiko-model-gateway",
    new Set(["./internal/openai-adapter", "./internal/normalize"]),
  ],
]);
const deniedPublicWorkspaceExports = new Map([
  ["@oscharko-dev/keiko-local-knowledge", new Set(["./testing"])],
]);

function readJson(relativePath) {
  return JSON.parse(readFileSync(join(repoRoot, relativePath), "utf8"));
}

function readJsonAt(root, relativePath) {
  return JSON.parse(readFileSync(join(root, relativePath), "utf8"));
}

function collectWorkspaceManifests(root = repoRoot) {
  const workspaceManifests = [];
  for (const dir of readdirSync(join(root, "packages"), { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const relativePath = join("packages", dir.name, "package.json");
    if (!existsSync(join(root, relativePath))) continue;
    const manifest = readJsonAt(root, relativePath);
    workspaceManifests.push({ relativePath, manifest });
  }
  return workspaceManifests;
}

function dependencyHas(entries, name) {
  return entries.some((entry) => entry.name === name);
}

function failMalformedDependency(owner, entry, failures) {
  if (entry.name !== undefined) return false;
  failures.push(`${owner}: ${entry.field} must be an object when present.`);
  return true;
}

function pushDeniedWorkspaceExportFailures(exportsMap, denied, failures, messageFor) {
  if (denied === undefined) return;
  for (const subpath of denied) {
    if (Object.hasOwn(exportsMap, subpath)) {
      failures.push(messageFor(subpath));
    }
  }
}

function validateWorkspaceExports(relativePath, manifest, failures) {
  const exportsMap = manifest.exports;
  if (exportsMap === undefined || exportsMap === null || typeof exportsMap !== "object") return;
  pushDeniedWorkspaceExportFailures(
    exportsMap,
    deniedWorkspaceExports.get(manifest.name),
    failures,
    (subpath) =>
      `${relativePath}: ${manifest.name} must not export productive provider-runtime subpath ${subpath}.`,
  );
  if (manifest.private === true) return;
  pushDeniedWorkspaceExportFailures(
    exportsMap,
    deniedPublicWorkspaceExports.get(manifest.name),
    failures,
    (subpath) =>
      `${relativePath}: public workspace ${manifest.name} must not export test-only subpath ${subpath}.`,
  );
}

// eslint-disable-next-line max-lines-per-function, complexity -- release manifest gate intentionally reports all violations in one pass.
export function validatePublishManifests(rootManifest, workspaceManifests) {
  const failures = [];
  const expectedVersion = rootManifest.version;

  if (rootManifest.private === true) {
    failures.push(
      "package.json: root product package must remain publishable (private must not be true).",
    );
  }
  if (typeof expectedVersion !== "string" || expectedVersion.length === 0) {
    failures.push("root package.json must declare a release version.");
  }
  if (rootManifest.repository?.url !== expectedRepositoryUrl) {
    failures.push(
      `package.json: repository.url must be ${expectedRepositoryUrl} so npm provenance can validate the GitHub source repository.`,
    );
  }

  const workspaceNames = new Set(workspaceManifests.map(({ manifest }) => manifest.name));
  const rootInternalDependencies = internalDependencyEntries(rootManifest);
  const bundled = new Set(
    Array.isArray(rootManifest.bundleDependencies) ? rootManifest.bundleDependencies : [],
  );

  for (const { relativePath, manifest } of workspaceManifests) {
    if (typeof manifest.name !== "string" || !manifest.name.startsWith(scope)) {
      failures.push(`${relativePath}: workspace package must declare an ${scope} package name.`);
      continue;
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
    validateWorkspaceExports(relativePath, manifest, failures);
    const privateExclusion = explicitPrivateWorkspaceExclusions.get(manifest.name);
    const inRootDependencies = dependencyHas(rootInternalDependencies, manifest.name);
    const inBundle = bundled.has(manifest.name);
    if (privateExclusion !== undefined) {
      if (inRootDependencies || inBundle) {
        failures.push(
          `${relativePath}: ${manifest.name} is a build-time-only workspace exclusion (${privateExclusion}) and must not appear in root dependencies or bundleDependencies.`,
        );
      }
    } else {
      if (!inRootDependencies) {
        failures.push(
          `${relativePath}: runtime workspace ${manifest.name} must be listed in root dependencies.`,
        );
      }
      if (!inBundle) {
        failures.push(
          `${relativePath}: runtime workspace ${manifest.name} must be listed in root bundleDependencies.`,
        );
      }
    }
    for (const entry of internalDependencyEntries(manifest)) {
      if (failMalformedDependency(manifest.name ?? relativePath, entry, failures)) continue;
      if (!workspaceNames.has(entry.name)) {
        failures.push(
          `${relativePath}: ${entry.field}.${entry.name} does not refer to a local workspace package.`,
        );
      }
      if (entry.specifier !== expectedVersion) {
        failures.push(
          `${relativePath}: ${entry.field}.${entry.name} must be pinned to ${expectedVersion}, got ${entry.specifier}.`,
        );
      }
    }
  }

  for (const entry of rootInternalDependencies) {
    if (failMalformedDependency("package.json", entry, failures)) continue;
    const { field, name, specifier } = entry;
    if (field !== "dependencies") {
      failures.push(
        `package.json: root published package must list ${name} under dependencies only.`,
      );
    }
    if (!workspaceNames.has(name)) {
      failures.push(
        `package.json: dependency ${name} does not refer to a local workspace package.`,
      );
    }
    if (explicitPrivateWorkspaceExclusions.has(name)) {
      failures.push(
        `package.json: dependency ${name} is a private build-time workspace exclusion.`,
      );
    }
    if (specifier !== expectedVersion) {
      failures.push(
        `package.json: dependency ${name} must be pinned to ${expectedVersion}, got ${specifier}.`,
      );
    }
    if (!bundled.has(name)) {
      failures.push(`package.json: dependency ${name} must also be listed in bundleDependencies.`);
    }
  }

  for (const name of bundled) {
    if (!name.startsWith(scope)) continue;
    if (!workspaceNames.has(name)) {
      failures.push(
        `package.json: bundleDependencies entry ${name} is not a local workspace package.`,
      );
      continue;
    }
    if (explicitPrivateWorkspaceExclusions.has(name)) {
      failures.push(
        `package.json: bundleDependencies entry ${name} is a private build-time workspace exclusion.`,
      );
    }
    const workspace = workspaceManifests.find(({ manifest }) => manifest.name === name);
    if (workspace?.manifest.private !== true) {
      failures.push(`package.json: bundled workspace ${name} must set private: true.`);
    }
    if (!dependencyHas(rootInternalDependencies, name)) {
      failures.push(`package.json: bundleDependencies entry ${name} is missing from dependencies.`);
    }
  }

  return failures;
}

function main() {
  const rootManifest = readJson("package.json");
  const workspaceManifests = collectWorkspaceManifests();
  const failures = validatePublishManifests(rootManifest, workspaceManifests);

  if (failures.length > 0) {
    console.error("publish-manifests: FAIL");
    for (const message of failures) {
      console.error(`  - ${message}`);
    }
    process.exit(1);
  }

  const runtimeWorkspaceCount = (rootManifest.bundleDependencies ?? []).filter(
    (name) => typeof name === "string" && name.startsWith(scope),
  ).length;
  console.log(
    `publish-manifests: PASS - ${runtimeWorkspaceCount} private runtime workspaces are bundled into the root package; no workspace is independently publishable.`,
  );
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
