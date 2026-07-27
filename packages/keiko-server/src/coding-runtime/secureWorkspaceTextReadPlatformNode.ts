import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import type { BigIntStats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

import type {
  PortableSecureWorkspaceReadMetadata,
  PortableSecureWorkspaceReadPathEntry,
  PortableSecureWorkspaceReadPlatformInspection,
} from "./secureWorkspaceTextReadPortable.js";

const MAX_SIGNATURE_CHECK_MS = 10_000;

export function createNodePortableSecureWorkspaceReadInspection(): PortableSecureWorkspaceReadPlatformInspection {
  return Object.freeze({
    inspectPath: inspectPathEntries,
    openReadSameIdentity,
    verifySignature,
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
): Promise<boolean> {
  return Promise.resolve(
    target === "win32-x64" ? verifyWindowsAuthenticode(executable) : verifyMacosCode(executable),
  );
}

function verifyWindowsAuthenticode(executable: string): boolean {
  const script =
    "$s=Get-AuthenticodeSignature -LiteralPath $args[0];" +
    "if($s.Status -ne 'Valid' -or $null -eq $s.TimeStamperCertificate){exit 1}";
  return (
    spawnSync(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script, executable],
      {
        encoding: "utf8",
        env: {
          PATH: process.env.PATH ?? "",
          SystemRoot: process.env.SystemRoot ?? "C:\\Windows",
        },
        shell: false,
        windowsHide: true,
        timeout: MAX_SIGNATURE_CHECK_MS,
      },
    ).status === 0
  );
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
