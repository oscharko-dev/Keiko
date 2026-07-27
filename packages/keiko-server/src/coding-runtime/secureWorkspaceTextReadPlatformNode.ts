import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import type { BigIntStats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

import { safeRealFile } from "./nativeRuntimeProcessPaths.js";
import type {
  PortableSecureWorkspaceReadMetadata,
  PortableSecureWorkspaceReadPathEntry,
  PortableSecureWorkspaceReadPlatformInspection,
} from "./secureWorkspaceTextReadPortable.js";
import {
  windowsPublisherIdentityMatches,
  type WindowsAuthenticodeCommandRunner,
} from "./windowsPortableAuthenticode.js";

const MAX_SIGNATURE_CHECK_MS = 10_000;

export interface NodePortableSecureWorkspaceReadInspectionOptions {
  readonly resourceRoot?: string | undefined;
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
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`)) {
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
  target: "win32-x64" | "darwin-arm64" | "darwin-x64",
  options: NodePortableSecureWorkspaceReadInspectionOptions,
): Promise<boolean> {
  return Promise.resolve(
    target === "win32-x64"
      ? verifyWindowsAuthenticode(executable, options)
      : verifyMacosCode(executable),
  );
}

function verifyWindowsAuthenticode(
  executable: string,
  options: NodePortableSecureWorkspaceReadInspectionOptions,
): boolean {
  const launcher = windowsLauncher(options.resourceRoot);
  return (
    launcher !== undefined &&
    windowsPublisherIdentityMatches(launcher, executable, options.windowsRunCommand)
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

function verifyMacosCode(executable: string): boolean {
  return (
    spawnSync("/usr/bin/codesign", ["--verify", "--strict", executable], {
      encoding: "utf8",
      env: { PATH: "/usr/bin" },
      shell: false,
      timeout: MAX_SIGNATURE_CHECK_MS,
    }).status === 0
  );
}
