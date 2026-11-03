import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { posix, win32 } from "node:path";
import { isMcpLocalAbsolutePath } from "@oscharko-dev/keiko-contracts/runtime/mcp-servers";
import { ManagedMcpError } from "./definitions.js";

export const MCP_STDIO_ENV_PREFIX = "KEIKO_MCP_STDIO_ENV_";

export interface McpNativeStdioOwner {
  readonly executable: string;
  readonly sha256: string;
}

export function isNativeMcpLocalAbsolutePath(
  value: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return (
    isMcpLocalAbsolutePath(value) &&
    (platform === "win32" ? /^[A-Za-z]:[\\/]/u.test(value) : posix.isAbsolute(value))
  );
}

export function supportsOwnedMcpStdio(
  platform: NodeJS.Platform = process.platform,
  nativeOwner?: McpNativeStdioOwner,
): boolean {
  return (
    platform === "darwin" ||
    platform === "linux" ||
    (platform === "win32" && nativeOwner !== undefined)
  );
}

export function assertMcpNativeStdioOwner(owner: McpNativeStdioOwner): void {
  if (!isNativeMcpLocalAbsolutePath(owner.executable) || !/^[a-f0-9]{64}$/u.test(owner.sha256))
    throw new ManagedMcpError("not-admitted");
  const metadata = lstatSync(owner.executable);
  if (
    !metadata.isFile() ||
    metadata.size > 4 * 1024 * 1024 ||
    createHash("sha256").update(readFileSync(owner.executable)).digest("hex") !== owner.sha256
  )
    throw new ManagedMcpError("not-admitted");
}

export function guardianEnvironment(
  cwd: string,
  platform: NodeJS.Platform = process.platform,
  root: string | undefined = process.env.SYSTEMROOT ?? process.env.SystemRoot,
): Record<string, string> {
  const safe = { HOME: cwd, TMPDIR: cwd };
  if (platform !== "win32") return safe;
  if (root === undefined || !win32.isAbsolute(root) || !isMcpLocalAbsolutePath(root))
    throw new ManagedMcpError("not-admitted");
  return {
    ...safe,
    SYSTEMROOT: root,
    WINDIR: root,
    COMSPEC: win32.join(root, "System32", "cmd.exe"),
    PATH: win32.join(root, "System32"),
    USERPROFILE: cwd,
    TEMP: cwd,
    TMP: cwd,
  };
}

/** Keep interpreter and loader variables away from the lifetime owner itself. */
export function ownedStdioLaunch(
  command: readonly [string, ...string[]],
  environment: Readonly<Record<string, string>>,
  cwd: string,
  nativeOwner?: McpNativeStdioOwner,
): { command: string; args: string[]; env: Record<string, string> } {
  if (!supportsOwnedMcpStdio(process.platform, nativeOwner))
    throw new ManagedMcpError("not-admitted");
  const worker = fileURLToPath(
    new URL(
      import.meta.url.endsWith(".ts") ? "../dist/owned-stdio-worker.js" : "./owned-stdio-worker.js",
      import.meta.url,
    ),
  );
  const cleared = Object.fromEntries(
    Object.keys(environment)
      .filter((key) => !key.startsWith(MCP_STDIO_ENV_PREFIX))
      .map((key) => [key, ""]),
  );
  const encoded = Object.fromEntries(
    Object.entries(environment).map((entry, index) => [
      `${MCP_STDIO_ENV_PREFIX}${String(index)}`,
      JSON.stringify(entry),
    ]),
  );
  const env = { ...cleared, ...guardianEnvironment(cwd), ...encoded };
  if (process.platform === "win32" && nativeOwner !== undefined) {
    assertMcpNativeStdioOwner(nativeOwner);
    return {
      command: nativeOwner.executable,
      args: ["--stdio-owner", process.execPath, worker, "--native-job", ...command],
      env,
    };
  }
  return { command: process.execPath, args: [worker, ...command], env };
}
