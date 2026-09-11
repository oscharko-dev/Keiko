import { basename, dirname, join, resolve, win32 } from "node:path";
import type { UpdatePortableTarget } from "@oscharko-dev/keiko-contracts";

const SHA256 = /^[a-f0-9]{64}$/u;
const BINDING_KEYS = [
  "schemaVersion",
  "resourceRoot",
  "treeHashSchema",
  "treeSha256",
  "launcherPath",
  "launcherSha256",
] as const;

export interface WindowsGenerationBinding {
  readonly schemaVersion: 1;
  readonly resourceRoot: string;
  readonly treeHashSchema: "KHT1";
  readonly treeSha256: string;
  readonly launcherPath: "Keiko.exe";
  readonly launcherSha256: string;
}

export interface WindowsGenerationLayout {
  readonly installRoot: string;
  readonly resourceRoot: string;
  readonly appRoot: string;
  readonly packageJsonPath: string;
  readonly runtimeNodePath: string;
  readonly runtimeSupervisorPath: string;
  readonly rootLauncherPath: string;
  readonly rootSetupManifestPath: string;
  readonly rootSupportLauncherPath: string;
}

export interface PortablePackageLayout {
  readonly kind: "macos-bundle-v1" | "windows-flat-v1" | "windows-generation-v1";
  readonly installRoot: string;
  readonly resourceRoot: string;
  readonly appRoot: string;
  readonly packageJsonPath: string;
  readonly rootLauncherPath: string;
  readonly rootSetupManifestPath: string;
  readonly generationTreeSha256?: string | undefined;
}

type PathApi = Pick<typeof win32, "basename" | "dirname" | "join" | "resolve">;

function pathApiFor(value: string): PathApi {
  return value.includes("\\") || /^[a-z]:[\\/]/iu.test(value)
    ? win32
    : { basename, dirname, join, resolve };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordAt(
  record: Record<string, unknown> | undefined,
  key: string,
): Record<string, unknown> | undefined {
  if (record === undefined) return undefined;
  const value = record[key];
  return isRecord(value) ? value : undefined;
}

function hasExactKeys(record: Record<string, unknown>): boolean {
  const actual = Object.keys(record).sort((left, right) => left.localeCompare(right, "en-US"));
  const expected = [...BINDING_KEYS].sort((left, right) => left.localeCompare(right, "en-US"));
  return actual.length === expected.length && expected.every((key, index) => actual[index] === key);
}

export function parseWindowsGenerationBinding(
  value: unknown,
): WindowsGenerationBinding | undefined {
  if (!isRecord(value) || !hasExactKeys(value)) return undefined;
  const treeSha256 = value.treeSha256;
  const launcherSha256 = value.launcherSha256;
  const valid = [
    value.schemaVersion === 1,
    value.treeHashSchema === "KHT1",
    typeof treeSha256 === "string" && SHA256.test(treeSha256),
    value.resourceRoot === `.portable/generations/${String(treeSha256)}`,
    value.launcherPath === "Keiko.exe",
    typeof launcherSha256 === "string" && SHA256.test(launcherSha256),
  ].every(Boolean);
  if (!valid || typeof treeSha256 !== "string" || typeof launcherSha256 !== "string") {
    return undefined;
  }
  return {
    schemaVersion: 1,
    resourceRoot: `.portable/generations/${treeSha256}`,
    treeHashSchema: "KHT1",
    treeSha256,
    launcherPath: "Keiko.exe",
    launcherSha256,
  };
}

export function windowsGenerationBindingsEqual(
  left: WindowsGenerationBinding,
  right: WindowsGenerationBinding,
): boolean {
  return BINDING_KEYS.every((key) => left[key] === right[key]);
}

export function verifiedWindowsGenerationManifestBinding(
  manifest: Record<string, unknown>,
  target: UpdatePortableTarget,
): WindowsGenerationBinding | undefined {
  if (target !== "windows-x64") return undefined;
  if (manifest.schemaVersion !== 2) return undefined;
  const outer = parseWindowsGenerationBinding(manifest.windowsGeneration);
  const provenance = parseWindowsGenerationBinding(
    recordAt(manifest, "provenance")?.windowsGeneration,
  );
  const reviewed = parseWindowsGenerationBinding(
    recordAt(recordAt(manifest, "releaseImpact"), "reviewedBinding")?.windowsGeneration,
  );
  if (
    outer === undefined ||
    provenance === undefined ||
    reviewed === undefined ||
    !windowsGenerationBindingsEqual(outer, provenance) ||
    !windowsGenerationBindingsEqual(outer, reviewed)
  ) {
    return undefined;
  }
  return outer;
}

export function portableManifestGenerationSchemaVerified(
  manifest: Record<string, unknown>,
  target: UpdatePortableTarget,
): boolean {
  if (target === "windows-x64") {
    return verifiedWindowsGenerationManifestBinding(manifest, target) !== undefined;
  }
  return (
    manifest.schemaVersion === 1 &&
    manifest.windowsGeneration === undefined &&
    recordAt(manifest, "provenance")?.windowsGeneration === undefined &&
    recordAt(recordAt(manifest, "releaseImpact"), "reviewedBinding")?.windowsGeneration ===
      undefined
  );
}

export function resolveWindowsGenerationLayout(
  installRoot: string,
  binding: WindowsGenerationBinding,
): WindowsGenerationLayout {
  const pathApi = pathApiFor(installRoot);
  const resourceRoot = pathApi.join(installRoot, ...binding.resourceRoot.split("/"));
  return {
    installRoot,
    resourceRoot,
    appRoot: pathApi.join(resourceRoot, "app"),
    packageJsonPath: pathApi.join(resourceRoot, "app", "package.json"),
    runtimeNodePath: pathApi.join(resourceRoot, "runtime", "node", "node.exe"),
    runtimeSupervisorPath: pathApi.join(
      resourceRoot,
      "runtime",
      "native",
      "keiko-runtime-supervisor.exe",
    ),
    rootLauncherPath: pathApi.join(installRoot, binding.launcherPath),
    rootSetupManifestPath: pathApi.join(installRoot, ".portable", "setup-manifest.json"),
    rootSupportLauncherPath: pathApi.join(installRoot, "support", "keiko-support.cmd"),
  };
}

/**
 * Resolves the package location reported by the running server without reading mutable setup
 * state. Policy callers must still validate the setup and registration that select a Windows
 * generation. This function only owns the canonical path grammar.
 */
export function portablePackageLayout(
  target: UpdatePortableTarget,
  packageRoot: string | undefined,
): PortablePackageLayout | undefined {
  if (packageRoot === undefined) return undefined;
  const pathApi = pathApiFor(packageRoot);
  if (pathApi.basename(packageRoot) !== "app") return undefined;

  const resourceRoot = pathApi.dirname(packageRoot);
  if (target !== "windows-x64") {
    return macosPackageLayout(pathApi, packageRoot, resourceRoot);
  }

  return windowsPackageLayout(pathApi, packageRoot, resourceRoot);
}

function macosPackageLayout(
  pathApi: PathApi,
  packageRoot: string,
  resourceRoot: string,
): PortablePackageLayout | undefined {
  const contents = pathApi.dirname(resourceRoot);
  const installRoot = pathApi.dirname(contents);
  if (pathApi.basename(resourceRoot) !== "Resources" || pathApi.basename(contents) !== "Contents") {
    return undefined;
  }
  return {
    kind: "macos-bundle-v1",
    installRoot,
    resourceRoot,
    appRoot: packageRoot,
    packageJsonPath: pathApi.join(packageRoot, "package.json"),
    rootLauncherPath: pathApi.join(installRoot, "Contents", "MacOS", "Keiko"),
    rootSetupManifestPath: pathApi.join(resourceRoot, ".portable", "setup-manifest.json"),
  };
}

function windowsPackageLayout(
  pathApi: PathApi,
  packageRoot: string,
  resourceRoot: string,
): PortablePackageLayout {
  const generationTreeSha256 = pathApi.basename(resourceRoot);
  const generationsRoot = pathApi.dirname(resourceRoot);
  const portableRoot = pathApi.dirname(generationsRoot);
  if (
    SHA256.test(generationTreeSha256) &&
    pathApi.basename(generationsRoot) === "generations" &&
    pathApi.basename(portableRoot) === ".portable"
  ) {
    const installRoot = pathApi.dirname(portableRoot);
    return {
      kind: "windows-generation-v1",
      installRoot,
      resourceRoot,
      appRoot: packageRoot,
      packageJsonPath: pathApi.join(packageRoot, "package.json"),
      rootLauncherPath: pathApi.join(installRoot, "Keiko.exe"),
      rootSetupManifestPath: pathApi.join(installRoot, ".portable", "setup-manifest.json"),
      generationTreeSha256,
    };
  }

  return {
    kind: "windows-flat-v1",
    installRoot: resourceRoot,
    resourceRoot,
    appRoot: packageRoot,
    packageJsonPath: pathApi.join(packageRoot, "package.json"),
    rootLauncherPath: pathApi.join(resourceRoot, "Keiko.exe"),
    rootSetupManifestPath: pathApi.join(resourceRoot, ".portable", "setup-manifest.json"),
  };
}

export function generationBindingMatchesPackageLayout(
  binding: WindowsGenerationBinding,
  layout: PortablePackageLayout,
): boolean {
  return (
    layout.kind === "windows-generation-v1" && layout.generationTreeSha256 === binding.treeSha256
  );
}
