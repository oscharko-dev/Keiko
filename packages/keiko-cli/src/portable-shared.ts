import type { ChildProcess, SpawnOptions } from "node:child_process";
import { basename, dirname, join } from "node:path";
import type { EnvSource } from "@oscharko-dev/keiko-model-gateway";

export type PortableCommand = "setup" | "launch" | "status";
export type PortableTarget = "windows-x64" | "macos-arm64" | "macos-x64";
export type SetupStatus = "managed" | "setup-failed" | "unmanaged";
export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export interface SetupRuntimeManifest {
  readonly nodePlatform: "win32" | "darwin";
  readonly nodeArchitecture: "x64" | "arm64";
}

export interface SetupManifest {
  readonly schemaVersion: 1;
  readonly platformTarget: PortableTarget;
  readonly packageName: string;
  readonly packageVersion: string;
  readonly stable: boolean;
  readonly primaryLauncher: string;
  readonly bootstrapUpdateEligible: boolean;
  readonly runtime: SetupRuntimeManifest;
}

export interface PortableLayout {
  readonly rootKind: "windows-root" | "macos-app";
  readonly installRoot: string;
  readonly resourceRoot: string;
  readonly appRoot: string;
  readonly packageJsonPath: string;
  readonly runtimeNodePath: string;
  readonly primaryLauncherPath: string;
  readonly setupManifestPath: string;
}

export const SETUP_MANIFEST = "setup-manifest.json";
export const REGISTRATION_FILE = "portable-install-state.json";
export const PACKAGE_NAME = "@oscharko-dev/keiko";

export function isPortableCommand(value: string | undefined): value is PortableCommand {
  return value === "setup" || value === "launch" || value === "status";
}

export function isPortableTarget(value: string | undefined): value is PortableTarget {
  return value === "windows-x64" || value === "macos-arm64" || value === "macos-x64";
}

export function targetForHost(
  platform: NodeJS.Platform,
  architecture: string,
): PortableTarget | undefined {
  if (platform === "win32" && architecture === "x64") return "windows-x64";
  if (platform === "darwin" && architecture === "arm64") return "macos-arm64";
  if (platform === "darwin" && architecture === "x64") return "macos-x64";
  return undefined;
}

export function targetRuntime(target: PortableTarget): SetupManifest["runtime"] {
  if (target === "windows-x64") return { nodePlatform: "win32", nodeArchitecture: "x64" };
  if (target === "macos-arm64") return { nodePlatform: "darwin", nodeArchitecture: "arm64" };
  return { nodePlatform: "darwin", nodeArchitecture: "x64" };
}

export function primaryLauncherName(target: PortableTarget): string {
  return target === "windows-x64" ? "Keiko.exe" : "Keiko.app";
}

export function defaultManagedRoot(target: PortableTarget, env: EnvSource, home: string): string {
  if (target === "windows-x64") {
    const localAppData = env.LOCALAPPDATA ?? join(home, "AppData", "Local");
    return join(localAppData, "Programs", "Keiko");
  }
  return join(home, "Applications", "Keiko.app");
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
      primaryLauncherPath: join(root, "Keiko.exe"),
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
    primaryLauncherPath: join(appBundle, "Contents", "MacOS", "Keiko"),
    setupManifestPath: join(resources, ".portable", SETUP_MANIFEST),
  };
}
