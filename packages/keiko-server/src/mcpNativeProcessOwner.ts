import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { contentFreeErrorClass, emitServerDiagnostic } from "./diagnostics-log.js";
import { assertMcpNativeStdioOwner, type McpNativeStdioOwner } from "@oscharko-dev/keiko-mcp";
import { discoverQualifiedPortableOpenCode } from "./coding-runtime/productionPortableCodingRuntime.js";
import { discoverDevLaneOpenCode } from "./coding-runtime/devLanePortableCodingRuntime.js";

/** Uses admitted first-party assets without requesting a model or Coding task authority. */
export function discoverMcpNativeProcessOwner(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): McpNativeStdioOwner | undefined {
  if (platform !== "win32") return undefined;
  const owner = selectedOwner(env);
  if (owner === undefined) return undefined;
  try {
    return probeOwner(owner, env);
  } catch (error) {
    emitServerDiagnostic(undefined, {
      correlationId: randomUUID(),
      timestamp: new Date().toISOString(),
      operation: "mcp.connection",
      source: "mcp.native-owner",
      errorClass: contentFreeErrorClass(error),
      message: "runtime-turn-failed",
      code: "stage=mcp-native-owner",
    });
    return undefined;
  }
}

function probeOwner(
  owner: McpNativeStdioOwner,
  env: NodeJS.ProcessEnv,
): McpNativeStdioOwner | undefined {
  assertMcpNativeStdioOwner(owner);
  const probe = spawnSync(owner.executable, ["--probe-stdio-owner"], {
    windowsHide: true,
    timeout: 2000,
    maxBuffer: 1024,
    encoding: "utf8",
    env: { SYSTEMROOT: env.SYSTEMROOT ?? env.SystemRoot ?? "" },
  });
  if (
    probe.status !== 0 ||
    probe.stdout.trim() !== '{"schemaVersion":1,"ownedStdio":"windows-job"}'
  )
    return undefined;
  return owner;
}

function selectedOwner(env: NodeJS.ProcessEnv): McpNativeStdioOwner | undefined {
  const portable = discoverQualifiedPortableOpenCode({ env });
  const development = portable === undefined ? discoverDevLaneOpenCode({ env }) : undefined;
  const runtime =
    portable ?? (development?.outcome === "activated" ? development.runtime : undefined);
  if (runtime?.nativeHelperPath === undefined || runtime.nativeHelperSha256 === undefined)
    return undefined;
  return { executable: runtime.nativeHelperPath, sha256: runtime.nativeHelperSha256 };
}
