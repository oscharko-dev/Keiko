import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { resolveHostExecutable, shellCommandForTrustedExecutable } from "./lib/host-executable.mjs";

export const NPM_PACK_STDIO_MAX_BUFFER = 8 * 1024 * 1024;

export function npmCommand({
  env = process.env,
  platform = process.platform,
  resolveHostExecutableImpl = resolveHostExecutable,
  shellCommandForTrustedExecutableImpl = shellCommandForTrustedExecutable,
} = {}) {
  return shellCommandForTrustedExecutableImpl(
    resolveHostExecutableImpl("npm", { env, platform }),
    platform,
  );
}

export function shouldShellNpmCommand(platform = process.platform) {
  return platform === "win32";
}

function formatBytes(bytes) {
  if (bytes % (1024 * 1024) === 0) {
    return `${String(bytes / (1024 * 1024))} MiB`;
  }
  if (bytes % 1024 === 0) {
    return `${String(bytes / 1024)} KiB`;
  }
  return `${String(bytes)} bytes`;
}

function outputOverflowMessage(maxBuffer) {
  return (
    `npm pack --dry-run output exceeded the bounded ${formatBytes(maxBuffer)} capture buffer. ` +
    "The package metadata is too large to verify safely; increase the explicit package-surface " +
    "buffer only after confirming the packed file list is expected."
  );
}

function capturedBytes(value) {
  return typeof value === "string" ? Buffer.byteLength(value, "utf8") : 0;
}

function subprocessStatus(result) {
  if (typeof result.signal === "string" && /^SIG[A-Z0-9]+$/u.test(result.signal)) {
    return `signal ${result.signal}`;
  }
  if (result.status === null || result.status === undefined) {
    return "unknown status";
  }
  return `exit ${String(result.status)}`;
}

function subprocessFailureMessage(result) {
  const status = subprocessStatus(result);
  return (
    `npm pack --dry-run failed (${status}; stdout bytes: ${String(capturedBytes(result.stdout))}; ` +
    `stderr bytes: ${String(capturedBytes(result.stderr))})`
  );
}

function spawnErrorCode(error) {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : "unknown";
}

function packageSurfaceEnv(processEnv) {
  const env = { ...processEnv };
  delete env.npm_command;
  delete env.npm_lifecycle_event;
  delete env.npm_lifecycle_script;
  delete env.npm_package_json;
  return env;
}

function parsePackFiles(stdout) {
  try {
    const parsed = JSON.parse(stdout);
    const entry = Array.isArray(parsed) ? parsed[0] : parsed;
    return entry?.files ?? [];
  } catch {
    throw new Error(
      `npm pack --dry-run emitted invalid JSON (stdout bytes: ${String(capturedBytes(stdout))})`,
    );
  }
}

function assertPackResult(result, maxBuffer) {
  if (spawnErrorCode(result.error) === "ENOBUFS") {
    throw new Error(outputOverflowMessage(maxBuffer));
  }
  if (result.error !== undefined) {
    throw new Error(`npm pack --dry-run could not spawn (code: ${spawnErrorCode(result.error)})`);
  }
  if (result.status !== 0) {
    throw new Error(subprocessFailureMessage(result));
  }
}

export function packFiles({
  spawnSyncImpl = spawnSync,
  platform = process.platform,
  processEnv = process.env,
  maxBuffer = NPM_PACK_STDIO_MAX_BUFFER,
  resolveHostExecutableImpl = resolveHostExecutable,
  shellCommandForTrustedExecutableImpl = shellCommandForTrustedExecutable,
} = {}) {
  const env = packageSurfaceEnv(processEnv);
  const command = npmCommand({
    env,
    platform,
    resolveHostExecutableImpl,
    shellCommandForTrustedExecutableImpl,
  });
  const result = spawnSyncImpl(command, ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    encoding: "utf8",
    env,
    maxBuffer,
    // SECURITY-SHELL-OK: Windows requires a shell for npm.cmd. The command is resolved through
    // resolveHostExecutable("npm") and shell-quoted as a trusted host executable; argv is static.
    shell: shouldShellNpmCommand(platform),
  });

  assertPackResult(result, maxBuffer);
  return parsePackFiles(result.stdout);
}
