import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { explicitPrivateWorkspaceExclusions, scope } from "./release-workspace-policy.mjs";

const defaultRepoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function runtimeWorkspaceNames(rootManifest) {
  if (!Array.isArray(rootManifest.bundleDependencies)) {
    throw new TypeError("root package.json must declare the runtime workspace bundle list");
  }
  return rootManifest.bundleDependencies.filter((name) => name.startsWith(scope));
}

function workspaceRecords(repoRoot) {
  const records = new Map();
  const packagesRoot = join(repoRoot, "packages");
  for (const directory of rootManifestDirectories(packagesRoot)) {
    const packageRoot = join(packagesRoot, directory);
    const manifestPath = join(packageRoot, "package.json");
    if (!existsSync(manifestPath)) continue;
    const manifest = readJson(manifestPath);
    records.set(manifest.name, { directory, manifest, packageRoot });
  }
  return records;
}

function rootManifestDirectories(packagesRoot) {
  return readdirSync(packagesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

export function stagedVendorDirectory(workspaceName) {
  if (!workspaceName.startsWith(scope)) {
    throw new TypeError(`workspace package must use the ${scope} scope`);
  }
  const directory = workspaceName.slice(scope.length);
  if (!/^keiko-[a-z0-9-]+$/u.test(directory)) {
    throw new TypeError(`workspace package has an unsafe vendor directory: ${workspaceName}`);
  }
  return directory;
}

function copyRootSurface(repoRoot, stageRoot, rootManifest) {
  for (const relativePath of rootManifest.files ?? []) {
    if (relativePath === "vendor") continue;
    const source = resolve(repoRoot, relativePath);
    if (!source.startsWith(`${repoRoot}${sep}`) || !existsSync(source)) {
      throw new Error(`root publish file is missing or unsafe: ${String(relativePath)}`);
    }
    const destination = join(stageRoot, relativePath);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(source, destination, { recursive: true });
  }
}

function objectField(manifest, field) {
  const value = manifest[field];
  if (value === undefined) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${manifest.name}.${field} must be an object when present`);
  }
  return { ...value };
}

function setObjectField(manifest, field, entries) {
  if (Object.keys(entries).length === 0) {
    Reflect.deleteProperty(manifest, field);
    return;
  }
  manifest[field] = entries;
}

function moveInternalDependenciesToPeers(manifest, runtimeNames) {
  const peers = objectField(manifest, "peerDependencies");
  const peerMeta = objectField(manifest, "peerDependenciesMeta");
  for (const field of ["dependencies", "optionalDependencies"]) {
    const dependencies = objectField(manifest, field);
    for (const [name, specifier] of Object.entries(dependencies)) {
      if (!name.startsWith(scope)) continue;
      if (!runtimeNames.has(name)) {
        throw new Error(`${manifest.name}.${field}.${name} is not a vendored runtime workspace`);
      }
      peers[name] = specifier;
      if (field === "optionalDependencies") peerMeta[name] = { optional: true };
      Reflect.deleteProperty(dependencies, name);
    }
    setObjectField(manifest, field, dependencies);
  }
  setObjectField(manifest, "peerDependencies", peers);
  setObjectField(manifest, "peerDependenciesMeta", peerMeta);
}

function stagedWorkspaceManifest(sourceManifest, runtimeNames) {
  const manifest = structuredClone(sourceManifest);
  moveInternalDependenciesToPeers(manifest, runtimeNames);
  delete manifest.devDependencies;
  delete manifest.scripts;
  delete manifest.bundleDependencies;
  return manifest;
}

function copyWorkspace(stageRoot, record, runtimeNames) {
  const vendorRoot = join(stageRoot, "vendor", stagedVendorDirectory(record.manifest.name));
  const dist = join(record.packageRoot, "dist");
  if (!existsSync(dist)) {
    throw new Error(`${record.manifest.name} has no built dist directory`);
  }
  mkdirSync(vendorRoot, { recursive: true });
  cpSync(dist, join(vendorRoot, "dist"), { recursive: true });
  writeJson(
    join(vendorRoot, "package.json"),
    stagedWorkspaceManifest(record.manifest, runtimeNames),
  );
}

function lockedDependencyVersion(lockfile, workspaceDirectory, dependencyName) {
  const candidates = [
    `packages/${workspaceDirectory}/node_modules/${dependencyName}`,
    `node_modules/${dependencyName}`,
  ];
  for (const key of candidates) {
    const version = lockfile.packages?.[key]?.version;
    if (typeof version === "string" && version.length > 0) return version;
  }
  throw new Error(`${dependencyName} has no resolved runtime version in package-lock.json`);
}

function addExternalDependencies(
  target,
  source,
  runtimeNames,
  owner,
  workspaceDirectory,
  lockfile,
  promotedVersions,
) {
  for (const [name, specifier] of Object.entries(source)) {
    if (runtimeNames.has(name)) continue;
    const version = lockedDependencyVersion(lockfile, workspaceDirectory, name);
    const existing = promotedVersions.get(name);
    if (existing !== undefined && existing !== version) {
      throw new Error(
        `${owner} resolves ${name}@${version} from ${specifier}, which conflicts with the promoted ${existing}`,
      );
    }
    promotedVersions.set(name, version);
    target[name] = version;
  }
}

function rootResolvedVersions(manifest, runtimeNames, lockfile) {
  const versions = new Map();
  for (const field of ["dependencies", "optionalDependencies"]) {
    for (const name of Object.keys(objectField(manifest, field))) {
      if (runtimeNames.has(name)) continue;
      versions.set(name, lockedDependencyVersion(lockfile, "", name));
    }
  }
  return versions;
}

function promoteWorkspaceDependencies(manifest, runtimeNames, records, lockfile) {
  const dependencies = objectField(manifest, "dependencies");
  const optionalDependencies = objectField(manifest, "optionalDependencies");
  const promotedVersions = rootResolvedVersions(manifest, runtimeNames, lockfile);
  for (const name of runtimeNames) {
    const record = records.get(name);
    const workspace = record?.manifest;
    if (record === undefined || workspace === undefined) {
      throw new Error(`${name} does not map to a workspace manifest`);
    }
    addExternalDependencies(
      dependencies,
      objectField(workspace, "dependencies"),
      runtimeNames,
      name,
      record.directory,
      lockfile,
      promotedVersions,
    );
    addExternalDependencies(
      optionalDependencies,
      objectField(workspace, "optionalDependencies"),
      runtimeNames,
      name,
      record.directory,
      lockfile,
      promotedVersions,
    );
  }
  for (const [name, specifier] of Object.entries(optionalDependencies)) {
    const requiredSpecifier = dependencies[name];
    if (requiredSpecifier !== undefined && requiredSpecifier !== specifier) {
      throw new Error(
        `required ${name}@${requiredSpecifier} conflicts with promoted optional ${specifier}`,
      );
    }
  }
  for (const name of Object.keys(dependencies)) Reflect.deleteProperty(optionalDependencies, name);
  setObjectField(manifest, "dependencies", dependencies);
  setObjectField(manifest, "optionalDependencies", optionalDependencies);
}

function stagedRootManifest(sourceManifest, runtimeNames, records, lockfile) {
  const manifest = structuredClone(sourceManifest);
  promoteWorkspaceDependencies(manifest, new Set(runtimeNames), records, lockfile);
  const dependencies = objectField(manifest, "dependencies");
  for (const name of runtimeNames) {
    dependencies[name] = `file:vendor/${stagedVendorDirectory(name)}`;
  }
  manifest.dependencies = dependencies;
  manifest.files = [...new Set([...(manifest.files ?? []), "vendor"])];
  delete manifest.bundleDependencies;
  return manifest;
}

function validateRuntimeRecords(runtimeNames, records) {
  for (const name of runtimeNames) {
    if (explicitPrivateWorkspaceExclusions.has(name)) {
      throw new Error(`${name} is build-time-only and cannot be vendored`);
    }
    if (!records.has(name)) throw new Error(`${name} does not map to a workspace package`);
  }
}

export function createStagedPublishPackage({
  repoRoot = defaultRepoRoot,
  temporaryRoot = tmpdir(),
} = {}) {
  const resolvedRepoRoot = resolve(repoRoot);
  const rootManifest = readJson(join(resolvedRepoRoot, "package.json"));
  const lockfile = readJson(join(resolvedRepoRoot, "package-lock.json"));
  const names = runtimeWorkspaceNames(rootManifest);
  const runtimeNames = new Set(names);
  const records = workspaceRecords(resolvedRepoRoot);
  validateRuntimeRecords(runtimeNames, records);
  const stageRoot = mkdtempSync(join(temporaryRoot, "keiko-publish-stage-"));
  try {
    copyRootSurface(resolvedRepoRoot, stageRoot, rootManifest);
    for (const name of names) copyWorkspace(stageRoot, records.get(name), runtimeNames);
    writeJson(
      join(stageRoot, "package.json"),
      stagedRootManifest(rootManifest, names, records, lockfile),
    );
  } catch (error) {
    rmSync(stageRoot, { recursive: true, force: true });
    throw error;
  }
  return {
    packageDir: stageRoot,
    cleanup: () => rmSync(stageRoot, { recursive: true, force: true }),
  };
}
