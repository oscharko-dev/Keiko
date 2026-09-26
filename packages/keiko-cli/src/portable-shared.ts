import type { ChildProcess, SpawnOptions } from "node:child_process";
import { basename, dirname, join } from "node:path";
import type { EnvSource } from "@oscharko-dev/keiko-model-gateway";

export type PortableCommand = "setup" | "launch" | "status" | "resolve-root";
export type PortableTarget = "linux-x64" | "windows-x64" | "macos-arm64" | "macos-x64";
export type SetupStatus = "managed" | "setup-failed" | "unmanaged";
export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export interface SetupRuntimeManifest {
  readonly nodePlatform: "linux" | "win32" | "darwin";
  readonly nodeArchitecture: "x64" | "arm64";
}

interface SetupManifestFields {
  readonly platformTarget: PortableTarget;
  readonly packageName: string;
  readonly packageVersion: string;
  readonly stable: boolean;
  readonly primaryLauncher: string;
  readonly bootstrapUpdateEligible: boolean;
  readonly runtime: SetupRuntimeManifest;
}

export interface WindowsGenerationBinding {
  readonly schemaVersion: 1;
  readonly resourceRoot: string;
  readonly treeHashSchema: "KHT1";
  readonly treeSha256: string;
  readonly launcherPath: "Keiko.exe";
  readonly launcherSha256: string;
}

const WINDOWS_GENERATION_KEYS = [
  "schemaVersion",
  "resourceRoot",
  "treeHashSchema",
  "treeSha256",
  "launcherPath",
  "launcherSha256",
] as const;
const SHA256_RE = /^[a-f0-9]{64}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseWindowsGenerationBinding(value: unknown): WindowsGenerationBinding {
  if (!isRecord(value) || !hasExactKeys(value, WINDOWS_GENERATION_KEYS)) {
    throw new Error("portable setup manifest Windows generation binding is malformed");
  }
  const treeSha256 = value.treeSha256;
  const launcherSha256 = value.launcherSha256;
  const valid = [
    value.schemaVersion === 1,
    value.treeHashSchema === "KHT1",
    typeof treeSha256 === "string" && SHA256_RE.test(treeSha256),
    value.resourceRoot === `.portable/generations/${String(treeSha256)}`,
    value.launcherPath === "Keiko.exe",
    typeof launcherSha256 === "string" && SHA256_RE.test(launcherSha256),
  ].every(Boolean);
  if (!valid || typeof treeSha256 !== "string" || typeof launcherSha256 !== "string") {
    throw new Error("portable setup manifest Windows generation binding is malformed");
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

function hasExactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(record).sort((left, right) => left.localeCompare(right, "en-US"));
  return (
    actual.length === expected.length &&
    [...expected]
      .sort((left, right) => left.localeCompare(right, "en-US"))
      .every((key, i) => actual[i] === key)
  );
}

export interface LegacySetupManifest extends SetupManifestFields {
  readonly schemaVersion: 1;
}

export interface WindowsGenerationSetupManifest extends SetupManifestFields {
  readonly schemaVersion: 2;
  readonly platformTarget: "windows-x64";
  readonly primaryLauncher: "Keiko.exe";
  readonly windowsGeneration: WindowsGenerationBinding;
}

export type SetupManifest = LegacySetupManifest | WindowsGenerationSetupManifest;

export interface PortableLayout {
  readonly rootKind: "linux-root" | "windows-root" | "macos-app";
  readonly installRoot: string;
  readonly resourceRoot: string;
  readonly appRoot: string;
  readonly packageJsonPath: string;
  readonly runtimeNodePath: string;
  readonly runtimeSupervisorPath: string;
  readonly primaryLauncherPath: string;
  readonly setupManifestPath: string;
}

export const SETUP_MANIFEST = "setup-manifest.json";
export const REGISTRATION_FILE = "portable-install-state.json";
export const PACKAGE_NAME = "@oscharko-dev/keiko";

export function isPortableCommand(value: string | undefined): value is PortableCommand {
  return value === "setup" || value === "launch" || value === "status" || value === "resolve-root";
}

export function isPortableTarget(value: string | undefined): value is PortableTarget {
  return (
    value === "linux-x64" ||
    value === "windows-x64" ||
    value === "macos-arm64" ||
    value === "macos-x64"
  );
}

export function targetForHost(
  platform: NodeJS.Platform,
  architecture: string,
): PortableTarget | undefined {
  if (platform === "win32" && architecture === "x64") return "windows-x64";
  if (platform === "linux" && architecture === "x64") return "linux-x64";
  if (platform === "darwin" && architecture === "arm64") return "macos-arm64";
  if (platform === "darwin" && architecture === "x64") return "macos-x64";
  return undefined;
}

export function targetRuntime(target: PortableTarget): SetupManifest["runtime"] {
  if (target === "windows-x64") return { nodePlatform: "win32", nodeArchitecture: "x64" };
  if (target === "linux-x64") return { nodePlatform: "linux", nodeArchitecture: "x64" };
  if (target === "macos-arm64") return { nodePlatform: "darwin", nodeArchitecture: "arm64" };
  return { nodePlatform: "darwin", nodeArchitecture: "x64" };
}

export function primaryLauncherName(target: PortableTarget): string {
  if (target === "windows-x64") return "Keiko.exe";
  return target === "linux-x64" ? "Keiko" : "Keiko.app";
}

export function defaultManagedRoot(target: PortableTarget, env: EnvSource, home: string): string {
  if (target === "windows-x64") {
    const localAppData = env.LOCALAPPDATA ?? join(home, "AppData", "Local");
    return join(localAppData, "Programs", "Keiko");
  }
  if (target === "linux-x64") return join(home, ".local", "opt", "Keiko");
  return "/Applications/Keiko.app";
}

function macAppRoot(root: string): string {
  if (basename(root) === "Keiko.app") return root;
  if (basename(root) === "Resources" && basename(dirname(root)) === "Contents") {
    return dirname(dirname(root));
  }
  return join(root, "Keiko.app");
}

export function layoutFor(target: PortableTarget, root: string): PortableLayout {
  if (target === "windows-x64") {
    return {
      rootKind: "windows-root",
      installRoot: root,
      resourceRoot: root,
      appRoot: join(root, "app"),
      packageJsonPath: join(root, "app", "package.json"),
      runtimeNodePath: join(root, "runtime", "node", "node.exe"),
      runtimeSupervisorPath: join(root, "runtime", "native", "keiko-runtime-supervisor.exe"),
      primaryLauncherPath: join(root, "Keiko.exe"),
      setupManifestPath: join(root, ".portable", SETUP_MANIFEST),
    };
  }
  if (target === "linux-x64") {
    return {
      rootKind: "linux-root",
      installRoot: root,
      resourceRoot: root,
      appRoot: join(root, "app"),
      packageJsonPath: join(root, "app", "package.json"),
      runtimeNodePath: join(root, "runtime", "node", "bin", "node"),
      runtimeSupervisorPath: join(root, "runtime", "native", "keiko-runtime-supervisor"),
      primaryLauncherPath: join(root, "Keiko"),
      setupManifestPath: join(root, ".portable", SETUP_MANIFEST),
    };
  }
  const appBundle = macAppRoot(root);
  const resources = join(appBundle, "Contents", "Resources");
  return {
    rootKind: "macos-app",
    installRoot: appBundle,
    resourceRoot: resources,
    appRoot: join(resources, "app"),
    packageJsonPath: join(resources, "app", "package.json"),
    runtimeNodePath: join(resources, "runtime", "node", "bin", "node"),
    runtimeSupervisorPath: join(resources, "runtime", "native", "keiko-runtime-supervisor"),
    primaryLauncherPath: join(appBundle, "Contents", "MacOS", "Keiko"),
    setupManifestPath: join(resources, ".portable", SETUP_MANIFEST),
  };
}

export function layoutForSetupManifest(
  target: PortableTarget,
  root: string,
  manifest: SetupManifest,
): PortableLayout {
  const layout = layoutFor(target, root);
  if (target !== "windows-x64" || manifest.schemaVersion !== 2) return layout;
  const resourceRoot = join(
    layout.installRoot,
    ...manifest.windowsGeneration.resourceRoot.split("/"),
  );
  return {
    ...layout,
    resourceRoot,
    appRoot: join(resourceRoot, "app"),
    packageJsonPath: join(resourceRoot, "app", "package.json"),
    runtimeNodePath: join(resourceRoot, "runtime", "node", "node.exe"),
    runtimeSupervisorPath: join(resourceRoot, "runtime", "native", "keiko-runtime-supervisor.exe"),
  };
}
