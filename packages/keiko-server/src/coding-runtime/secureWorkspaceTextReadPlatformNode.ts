import { execFile } from "node:child_process";
import { constants } from "node:fs";
import type { BigIntStats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep, win32 } from "node:path";

import {
  macosDeveloperIdRequirement,
  macosReleaseTeamIdentifier,
} from "./macosPortableCodeIdentity.js";
import { safeRealFile } from "./nativeRuntimeProcessPaths.js";
import type {
  PortableSecureWorkspaceReadMetadata,
  PortableSecureWorkspaceReadPathEntry,
  PortableSecureWorkspaceReadPlatformInspection,
} from "./secureWorkspaceTextReadPortable.js";
import {
  windowsPublisherIdentityMatches,
  windowsPublisherIdentityMatchesAsync,
  type WindowsAuthenticodeCommandRunner,
} from "./windowsPortableAuthenticode.js";

const MAX_SIGNATURE_CHECK_MS = 10_000;

type PortableNativeTarget = "win32-x64" | "darwin-arm64" | "darwin-x64";

export type MacosCodeCommandRunner = (command: string, args: readonly string[]) => Promise<boolean>;

export interface NodePortableSecureWorkspaceReadInspectionOptions {
  readonly resourceRoot?: string | undefined;
  readonly macosRunCommand?: MacosCodeCommandRunner | undefined;
  readonly macosExpectedTeamIdentifier?: string | undefined;
  readonly windowsRunCommand?: WindowsAuthenticodeCommandRunner | undefined;
}

export function createNodePortableSecureWorkspaceReadInspection(
  options: NodePortableSecureWorkspaceReadInspectionOptions = {},
): PortableSecureWorkspaceReadPlatformInspection {
  return Object.freeze({
    inspectPath: inspectPathEntries,
    openReadSameIdentity,
    verifySignature: (
      executable: string,
      target: "win32-x64" | "darwin-arm64" | "darwin-x64",
    ): Promise<boolean> => verifySignature(executable, target, options),
  });
}

async function inspectPathEntries(
  resourceRoot: string,
  executable: string,
): Promise<readonly PortableSecureWorkspaceReadPathEntry[]> {
  const rel = relative(resourceRoot, executable);
  if (!isContainedPortableRelativePath(rel)) {
    throw new Error("secure-workspace-read-path-invalid");
  }
  const paths = [resourceRoot];
  let current = resourceRoot;
  for (const component of rel.split(sep)) {
    current = resolve(current, component);
    paths.push(current);
  }
  return Promise.all(
    paths.map(async (path, index) => {
      const entry = await lstat(path);
      const symbolicLink = entry.isSymbolicLink();
      const leaf = index === paths.length - 1;
      return {
        symbolicLink,
        reparsePoint: process.platform === "win32" && symbolicLink,
        safeType: !symbolicLink && (leaf ? entry.isFile() : entry.isDirectory()),
      };
    }),
  );
}

export function isContainedPortableRelativePath(value: string): boolean {
  return (
    value !== "" &&
    value !== ".." &&
    !value.startsWith(`..${sep}`) &&
    !isAbsolute(value) &&
    !win32.isAbsolute(value)
  );
}

async function openReadSameIdentity(
  executable: string,
  maximumBytes: number,
): Promise<{
  readonly bytes: Uint8Array;
  readonly before: PortableSecureWorkspaceReadMetadata;
  readonly after: PortableSecureWorkspaceReadMetadata;
}> {
  const descriptor = await open(executable, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await descriptor.stat({ bigint: true });
    if (before.size <= 0n || before.size >= BigInt(maximumBytes)) {
      throw new Error("secure-workspace-read-size-invalid");
    }
    const bytes = await descriptor.readFile();
    const after = await descriptor.stat({ bigint: true });
    return {
      bytes,
      before: metadata(before),
      after: metadata(after),
    };
  } finally {
    await descriptor.close();
  }
}

function metadata(stat: BigIntStats): PortableSecureWorkspaceReadMetadata {
  return {
    identity: `${String(stat.dev)}:${String(stat.ino)}`,
    size: Number(stat.size),
    modifiedNs: String(stat.mtimeNs),
    changedNs: String(stat.ctimeNs),
    regularFile: stat.isFile(),
    linkCount: Number(stat.nlink),
  };
}

function verifySignature(
  executable: string,
  target: PortableNativeTarget,
  options: NodePortableSecureWorkspaceReadInspectionOptions,
): Promise<boolean> {
  return target === "win32-x64"
    ? verifyWindowsAuthenticode(executable, options)
    : verifyMacosCode(executable, options);
}

async function verifyWindowsAuthenticode(
  executable: string,
  options: NodePortableSecureWorkspaceReadInspectionOptions,
): Promise<boolean> {
  const launcher = windowsLauncher(options.resourceRoot);
  if (launcher === undefined) return false;
  return options.windowsRunCommand === undefined
    ? windowsPublisherIdentityMatchesAsync(launcher, executable)
    : Promise.resolve(
        windowsPublisherIdentityMatches(launcher, executable, options.windowsRunCommand),
      );
}

function windowsLauncher(resourceRoot: string | undefined): string | undefined {
  if (resourceRoot === undefined) return undefined;
  try {
    return safeRealFile(join(resourceRoot, "Keiko.exe"));
  } catch {
    return undefined;
  }
}

function verifyMacosCode(
  executable: string,
  options: NodePortableSecureWorkspaceReadInspectionOptions,
): Promise<boolean> {
  if (options.resourceRoot === undefined) return Promise.resolve(false);
  const teamIdentifier = options.macosExpectedTeamIdentifier ?? macosReleaseTeamIdentifier();
  if (teamIdentifier === undefined) return Promise.resolve(false);
  const run = options.macosRunCommand ?? runMacosCodeCommand;
  return run("/usr/bin/codesign", [
    "--verify",
    "--strict",
    `-R=${macosDeveloperIdRequirement(teamIdentifier)}`,
    executable,
  ]);
}

export function provePortableImmutableResourceTree(
  resourceRoot: string,
  target: PortableNativeTarget,
  run: MacosCodeCommandRunner = runMacosCodeCommand,
  expectedTeamIdentifier: string | undefined = macosReleaseTeamIdentifier(),
): Promise<boolean> {
  // Windows has no immutable app-resource seal. The caller instead reopens and hashes the
  // receipt-bound helper, then independently matches its Authenticode signer on every admission.
  if (target === "win32-x64") return Promise.resolve(true);
  const manifestTarget = target === "darwin-arm64" ? "macos-arm64" : "macos-x64";
  const appRoot = dirname(dirname(resourceRoot));
  if (expectedTeamIdentifier === undefined) return Promise.resolve(false);
  const bundleIdentifier = `dev.oscharko.keiko.${manifestTarget}`;
  return run("/usr/bin/codesign", [
    "--verify",
    "--deep",
    "--strict",
    `-R=${macosDeveloperIdRequirement(expectedTeamIdentifier, bundleIdentifier)}`,
    appRoot,
  ]);
}

function runMacosCodeCommand(command: string, args: readonly string[]): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      command,
      [...args],
      {
        encoding: "utf8",
        env: { PATH: "/usr/bin" },
        shell: false,
        timeout: MAX_SIGNATURE_CHECK_MS,
      },
      (error) => {
        resolve(error === null);
      },
    );
  });
}
