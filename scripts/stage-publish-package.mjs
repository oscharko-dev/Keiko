import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveHostExecutable, shellCommandForTrustedExecutable } from "./lib/host-executable.mjs";
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

function addExportTargets(value, paths) {
  if (typeof value === "string") {
    if (value.startsWith("./")) paths.add(value.slice(2));
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const entry of Object.values(value)) addExportTargets(entry, paths);
}

function declaredPublishPaths(manifest) {
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new TypeError(`${manifest.name}.files must declare a bounded publish surface`);
  }
  const paths = new Set(manifest.files);
  const bin = manifest.bin;
  if (typeof bin === "string") paths.add(bin);
  if (bin !== null && typeof bin === "object" && !Array.isArray(bin)) {
    for (const target of Object.values(bin)) paths.add(target);
  }
  addExportTargets(manifest.exports, paths);
  for (const field of ["main", "module", "types", "typings"]) {
    if (typeof manifest[field] === "string") paths.add(manifest[field]);
  }
  return [...paths];
}

function normalizedPublishPath(value, packageName) {
  if (typeof value !== "string" || value.length === 0 || isAbsolute(value)) {
    throw new TypeError(`${packageName} declares an invalid publish path`);
  }
  const normalized = value.replace(/^\.\//u, "");
  if (normalized.length === 0 || /(?:^|\/)\.\.(?:\/|$)|[*?[\]{}\\]/u.test(normalized)) {
    throw new TypeError(`${packageName} declares an unsafe or unsupported publish path: ${value}`);
  }
  return normalized;
}

function assertRegularPublishTree(path, packageName, relativePath) {
  const stats = lstatSync(path);
  if (stats.isSymbolicLink()) {
    throw new Error(`${packageName} publish path contains a symlink: ${relativePath}`);
  }
  if (stats.isFile()) return;
  if (!stats.isDirectory()) {
    throw new Error(`${packageName} publish path has an unsupported file type: ${relativePath}`);
  }
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    assertRegularPublishTree(join(path, entry.name), packageName, join(relativePath, entry.name));
  }
}

function copyWorkspaceSurface(sourceRoot, destinationRoot, manifest) {
  for (const value of declaredPublishPaths(manifest)) {
    const relativePath = normalizedPublishPath(value, manifest.name);
    const source = resolve(sourceRoot, relativePath);
    if (!source.startsWith(`${sourceRoot}${sep}`) || !existsSync(source)) {
      throw new Error(`${manifest.name} publish path is missing or unsafe: ${relativePath}`);
    }
    assertRegularPublishTree(source, manifest.name, relativePath);
    const destination = join(destinationRoot, relativePath);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(source, destination, { recursive: true });
  }
}

export function assertWorkspacePack(result, record, archivePath) {
  if (result.error !== undefined) {
    throw new Error(`${record.manifest.name} archive packer could not spawn`);
  }
  if (result.status !== 0) {
    throw new Error(
      `${record.manifest.name} archive packer failed with status ${String(result.status)}`,
    );
  }
  if (!existsSync(archivePath)) {
    throw new Error(`${record.manifest.name} archive packer produced no archive`);
  }
}

function packedFiles(packageRoot) {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      if (entry.isFile()) files.push(relative(packageRoot, path).split(sep).join("/"));
    }
  };
  visit(packageRoot);
  return files.sort((left, right) => left.localeCompare(right));
}

function vendorArchiveName(record) {
  const version = record.manifest.version;
  if (typeof version !== "string" || !/^[0-9A-Za-z.-]+$/u.test(version)) {
    throw new TypeError(`${record.manifest.name} has an unsafe archive version`);
  }
  return `oscharko-dev-${stagedVendorDirectory(record.manifest.name)}-${version}.tgz`;
}

export function workspacePackInvocation(npmExecutable, platform = process.platform) {
  return {
    args: ["pack", "--silent", "--ignore-scripts"],
    command: shellCommandForTrustedExecutable(npmExecutable, platform),
    // SECURITY-SHELL-OK: Windows requires a shell for the trusted npm.cmd executable; argv is static.
    shell: platform === "win32",
  };
}

function packWorkspace(stageRoot, record, runtimeNames) {
  const directory = stagedVendorDirectory(record.manifest.name);
  const workspaceStage = join(stageRoot, ".vendor-stage", directory);
  const packageRoot = join(workspaceStage, "package");
  const vendorRoot = join(stageRoot, "vendor");
  const manifest = stagedWorkspaceManifest(record.manifest, runtimeNames);
  if (!existsSync(join(record.packageRoot, "dist"))) {
    throw new Error(`${record.manifest.name} has no built dist directory`);
  }
  mkdirSync(packageRoot, { recursive: true });
  mkdirSync(vendorRoot, { recursive: true });
  copyWorkspaceSurface(record.packageRoot, packageRoot, manifest);
  writeJson(join(packageRoot, "package.json"), manifest);
  const archiveName = vendorArchiveName(record);
  const archivePath = join(vendorRoot, archiveName);
  const stagedArchivePath = join(packageRoot, archiveName);
  const invocation = workspacePackInvocation(resolveHostExecutable("npm"));
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: packageRoot,
    encoding: "utf8",
    // SECURITY-SHELL-OK: Windows requires a shell for the trusted npm.cmd executable. Every
    // shell-visible argument is static; the dynamic destination is handled with renameSync.
    shell: invocation.shell,
  });
  assertWorkspacePack(result, record, stagedArchivePath);
  renameSync(stagedArchivePath, archivePath);
  const files = packedFiles(packageRoot);
  const bundledRoot = join(stageRoot, "node_modules", ...record.manifest.name.split("/"));
  mkdirSync(dirname(bundledRoot), { recursive: true });
  cpSync(packageRoot, bundledRoot, { recursive: true });
  rmSync(workspaceStage, { recursive: true, force: true });
  return {
    name: record.manifest.name,
    archivePath: `vendor/${archiveName}`,
    files,
    manifest,
  };
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

function promoteWorkspacePeers(
  dependencies,
  optionalDependencies,
  workspace,
  runtimeNames,
  record,
  lockfile,
  promotedVersions,
) {
  const peerDependencies = objectField(workspace, "peerDependencies");
  const peerMeta = objectField(workspace, "peerDependenciesMeta");
  const requiredPeers = {};
  const optionalPeers = {};
  for (const [peerName, specifier] of Object.entries(peerDependencies)) {
    if (runtimeNames.has(peerName)) continue;
    const target = peerMeta[peerName]?.optional === true ? optionalPeers : requiredPeers;
    target[peerName] = specifier;
  }
  for (const [target, peers] of [
    [dependencies, requiredPeers],
    [optionalDependencies, optionalPeers],
  ]) {
    addExternalDependencies(
      target,
      peers,
      runtimeNames,
      workspace.name,
      record.directory,
      lockfile,
      promotedVersions,
    );
  }
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
    promoteWorkspacePeers(
      dependencies,
      optionalDependencies,
      workspace,
      runtimeNames,
      record,
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

function stagedRootManifest(sourceManifest, runtimeNames, records, lockfile, vendorPackages) {
  const manifest = structuredClone(sourceManifest);
  promoteWorkspaceDependencies(manifest, new Set(runtimeNames), records, lockfile);
  const dependencies = objectField(manifest, "dependencies");
  const archives = new Map(
    vendorPackages.map((vendorPackage) => [vendorPackage.name, vendorPackage.archivePath]),
  );
  for (const name of runtimeNames) {
    const archivePath = archives.get(name);
    if (archivePath === undefined) throw new Error(`${name} has no staged vendor archive`);
    dependencies[name] = `file:${archivePath}`;
  }
  manifest.dependencies = dependencies;
  manifest.files = [...new Set([...(manifest.files ?? []), "vendor"])];
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
  const vendorPackages = [];
  try {
    copyRootSurface(resolvedRepoRoot, stageRoot, rootManifest);
    for (const name of names) {
      vendorPackages.push(packWorkspace(stageRoot, records.get(name), runtimeNames));
    }
    rmSync(join(stageRoot, ".vendor-stage"), { recursive: true, force: true });
    writeJson(
      join(stageRoot, "package.json"),
      stagedRootManifest(rootManifest, names, records, lockfile, vendorPackages),
    );
  } catch (error) {
    rmSync(stageRoot, { recursive: true, force: true });
    throw error;
  }
  return {
    packageDir: stageRoot,
    vendorPackages,
    cleanup: () => rmSync(stageRoot, { recursive: true, force: true }),
  };
}
