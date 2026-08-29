// Installable-package smoke (Issue #169 D2, AC2). Packs the root, installs the tarball into a
// fresh npm and Yarn projects, and asserts that (a) every private runtime workspace resolves from
// the tarball-local vendor graph, (b) the CLI bin is executable end-to-end (`--version`, `--help`),
// (c) the SDK root export resolves with the vendor graph in place, and (d) the packaged UI static
// export resolves through `keiko ui`. This is the
// runtime mirror of `scripts/check-package-surface.mjs`'s static tarball assertions, intended to
// fire BEFORE publish so a broken bundle can never reach users.

import { Buffer } from "node:buffer";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { satisfies } from "semver";
import ts from "typescript";
import { resolveHostExecutable, shellCommandForTrustedExecutable } from "./lib/host-executable.mjs";
import {
  PINNED_YARN,
  PINNED_YARN_NAME,
  yarnLocatorParts,
  yarnPackageManagerFromIntegrityLocator,
  yarnPackageManagerFromLocator,
} from "./lib/pinned-yarn.mjs";
import { createStagedPublishPackage } from "./stage-publish-package.mjs";

export const DEFAULT_NPM_INSTALL_TIMEOUT_MS = 600_000;
export const WINDOWS_NPM_INSTALL_TIMEOUT_MS = 600_000;
export const DEFAULT_EFFECTIVE_NPM_INSTALL_TIMEOUT_MS =
  process.platform === "win32" ? WINDOWS_NPM_INSTALL_TIMEOUT_MS : DEFAULT_NPM_INSTALL_TIMEOUT_MS;
export const NPM_INSTALL_TIMEOUT_MS = initialNpmInstallTimeoutMs();
const WINDOWS_SHELL_UNSAFE_ARG = /[\0\r\n&|<>^%!"]/u;
const UI_HEALTH_TIMEOUT_MS = 30_000;
const UI_HEALTH_POLL_INTERVAL_MS = 250;
const LIFECYCLE_COMMAND_TIMEOUT_MS = 90_000;
const TEST_RUNNER_ENV = "VITEST_WORKER_ID";
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rootPackageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
const rootPackageSurfaceContract = JSON.parse(
  readFileSync(join(repoRoot, "scripts", "root-package-surface.contract.json"), "utf8"),
);
const rootVersion = rootPackageJson.version;
const runtimeWorkspaces = rootPackageJson.bundleDependencies ?? [];

export function parseArgs(argv) {
  return {
    includeOptional: argv.includes("--include-optional"),
  };
}

function fail(message) {
  console.error(`installable-smoke failed: ${message}`);
  process.exit(1);
}

export class SmokeGateFailure extends Error {
  constructor(message) {
    super(message);
    this.name = "SmokeGateFailure";
  }
}

export function isSmokeGateFailure(error) {
  return error instanceof SmokeGateFailure;
}

function smokeGateFailure(message) {
  return new SmokeGateFailure(message);
}

function initialNpmInstallTimeoutMs() {
  const value = process.env.KEIKO_SMOKE_INSTALL_TIMEOUT_MS;
  if (value === undefined || value === "") return DEFAULT_EFFECTIVE_NPM_INSTALL_TIMEOUT_MS;
  if (!/^[1-9]\d*$/u.test(value)) return DEFAULT_EFFECTIVE_NPM_INSTALL_TIMEOUT_MS;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) ? parsed : DEFAULT_EFFECTIVE_NPM_INSTALL_TIMEOUT_MS;
}

export function smokeGateFailureLogSummary(error) {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? (error.stack ?? "") : "";
  const messageSha256 = createHash("sha256").update(message, "utf8").digest("hex");
  const stackSha256 = createHash("sha256").update(stack, "utf8").digest("hex");
  const messageBytes = Buffer.byteLength(message, "utf8");
  const stackBytes = Buffer.byteLength(stack, "utf8");
  return (
    `redacted SmokeGateFailure (messageSha256=${messageSha256}, ` +
    `messageBytes=${String(messageBytes)}, stackSha256=${stackSha256}, ` +
    `stackBytes=${String(stackBytes)})`
  );
}

export function smokeGateFailureSetupSummary(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (
    message.startsWith("corepack could not provision ") ||
    message.startsWith("corepack cached ")
  ) {
    return message;
  }
  return smokeGateFailureLogSummary(error);
}

function yarnLocatorLogSummary(locator) {
  const { version } = yarnLocatorParts(locator);
  const locatorSha256 = createHash("sha256").update(locator, "utf8").digest("hex");
  return `${PINNED_YARN_NAME}@${version} (locatorSha256=${locatorSha256})`;
}

function yarnPackageManagerFromSmokeLocator(locator) {
  if (locator === PINNED_YARN) return yarnPackageManagerFromLocator(locator);
  if (process.env.NODE_ENV !== "test" || process.env[TEST_RUNNER_ENV] === undefined) {
    throw smokeGateFailure("fixture Yarn locators are only accepted inside Vitest");
  }
  return yarnPackageManagerFromIntegrityLocator(locator);
}

export function parsePositiveTimeoutEnv(name) {
  const value = process.env[name];
  if (value === undefined || value === "") {
    return undefined;
  }
  if (!/^[1-9]\d*$/u.test(value)) {
    fail(`${name} must be a positive integer number of milliseconds.`);
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed)) {
    fail(`${name} must be a safe integer number of milliseconds.`);
  }
  return parsed;
}

export function npmInstallTimeoutMs() {
  return (
    parsePositiveTimeoutEnv("KEIKO_SMOKE_INSTALL_TIMEOUT_MS") ??
    DEFAULT_EFFECTIVE_NPM_INSTALL_TIMEOUT_MS
  );
}

function assertWindowsShellArguments(cmd, args) {
  if (args.every((arg) => !WINDOWS_SHELL_UNSAFE_ARG.test(String(arg)))) return;
  throw smokeGateFailure(`${cmd} Windows shell arguments contain unsafe shell metacharacters`);
}

function commandForPlatform(cmd, args, options = {}) {
  if (process.platform !== "win32" || (cmd !== "npm" && cmd !== "corepack")) {
    return { command: cmd, shell: false };
  }
  assertWindowsShellArguments(cmd, args);
  const executable = resolveHostExecutable(cmd, { env: options.env ?? process.env });
  // SECURITY-SHELL-OK: npm/corepack Windows .cmd compatibility, with trusted absolute executable.
  return { command: shellCommandForTrustedExecutable(executable), shell: true };
}

function runResult(cmd, args, options = {}) {
  // SECURITY-SHELL-OK: npm/corepack Windows .cmd compatibility, with the executable resolved to a
  // trusted absolute path before the shell is enabled. POSIX and node/bin paths stay shell:false.
  const { command, shell } = commandForPlatform(cmd, args, options);
  return spawnSync(command, args, { encoding: "utf8", ...options, shell });
}

function run(cmd, args, options = {}) {
  const result = runResult(cmd, args, options);
  if (result.error) {
    fail(`${cmd} ${args.join(" ")} could not spawn: ${result.error.message}`);
  }
  return result;
}

function childOutputByteSummary(result) {
  const stdoutBytes = Buffer.byteLength(String(result.stdout ?? ""), "utf8");
  const stderrBytes = Buffer.byteLength(String(result.stderr ?? ""), "utf8");
  return `stdoutBytes=${String(stdoutBytes)}, stderrBytes=${String(stderrBytes)}`;
}

function safeErrorCode(error) {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const { code } = error;
  return typeof code === "string" && /^[A-Z0-9_]+$/u.test(code) ? code : undefined;
}

function corepackSpawnFailureSetupSummary(error, timeoutMs) {
  const code = safeErrorCode(error);
  if (code === "ETIMEDOUT") {
    return `corepack did not finish before the ${String(timeoutMs)}ms setup timeout`;
  }
  if (code === "ENOENT") return "corepack executable was not found";
  if (code !== undefined) return `corepack spawn failed with code ${code}`;
  return "corepack spawn failed before producing output";
}

const DEFAULT_ASYNC_OUTPUT_LIMIT_BYTES = 10 * 1024 * 1024;

export function terminateProcessTree(child) {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    spawnSync(resolveHostExecutable("taskkill"), ["/pid", String(child.pid), "/T", "/F"], {
      encoding: "utf8",
      shell: false,
      windowsHide: true,
    });
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch (error) {
    if (error?.code !== "ESRCH") child.kill("SIGKILL");
  }
}

function settleTerminatedProcess(child, stdout, stderr, settle, details) {
  let terminationError;
  try {
    terminateProcessTree(child);
  } catch (error) {
    terminationError = error instanceof Error ? error.message : String(error);
  }
  child.stdout?.destroy();
  child.stderr?.destroy();
  child.unref();
  settle({
    ...details,
    status: null,
    signal: process.platform === "win32" ? "TASKKILL" : "SIGKILL",
    stdout: stdout.join(""),
    stderr:
      terminationError === undefined
        ? stderr.join("")
        : `${stderr.join("")}\nprocess-tree termination failed: ${terminationError}`,
  });
}

function settleTimedOutProcess(child, stdout, stderr, settle) {
  settleTerminatedProcess(child, stdout, stderr, settle, { timedOut: true });
}

function settleOutputLimitedProcess(child, stdout, stderr, settle) {
  settleTerminatedProcess(child, stdout, stderr, settle, { outputLimitExceeded: true });
}

function asyncOutputLimitBytes(outputLimitBytes) {
  const limit = outputLimitBytes ?? DEFAULT_ASYNC_OUTPUT_LIMIT_BYTES;
  if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0) {
    throw new TypeError("runAsync requires a positive finite outputLimitBytes");
  }
  return Math.floor(limit);
}

function appendBoundedOutput(chunks, chunk, state) {
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
  const remaining = state.limitBytes - state.capturedBytes;
  if (remaining > 0) {
    const accepted = buffer.byteLength > remaining ? buffer.subarray(0, remaining) : buffer;
    chunks.push(accepted.toString("utf8"));
    state.capturedBytes += accepted.byteLength;
  }
  return buffer.byteLength > remaining;
}

export function runAsync(cmd, args, options = {}) {
  const { timeout, outputLimitBytes, ...spawnOptions } = options;
  if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0) {
    throw new TypeError("runAsync requires a positive finite timeout in milliseconds");
  }
  const outputState = { capturedBytes: 0, limitBytes: asyncOutputLimitBytes(outputLimitBytes) };
  const { command, shell } = commandForPlatform(cmd, args, spawnOptions);
  return new Promise((resolvePromise) => {
    let settled = false;
    const stdout = [];
    const stderr = [];
    // SECURITY-SHELL-OK: npm/corepack Windows .cmd compatibility, with trusted absolute executable.
    const child = spawn(command, args, {
      ...spawnOptions,
      detached: process.platform !== "win32",
      shell,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const settle = (result) => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timer);
      resolvePromise(result);
    };
    const capture = (chunks) => (chunk) => {
      if (settled) return;
      if (appendBoundedOutput(chunks, chunk, outputState)) {
        settleOutputLimitedProcess(child, stdout, stderr, settle);
      }
    };
    const timer = globalThis.setTimeout(() => {
      settleTimedOutProcess(child, stdout, stderr, settle);
    }, timeout);
    child.stdout?.on("data", capture(stdout));
    child.stderr?.on("data", capture(stderr));
    child.once("error", (error) => {
      settle({ error, status: null, signal: null, stdout: "", stderr: "" });
    });
    child.once("close", (status, signal) => {
      settle({ status, signal, stdout: stdout.join(""), stderr: stderr.join("") });
    });
  });
}

function sleep(ms) {
  return new Promise((resolvePromise) => globalThis.setTimeout(resolvePromise, ms));
}

const COREPACK_CACHE_LOCK_POLL_MS = 100;
const COREPACK_CACHE_LOCK_STALE_MS = 30 * 60_000;
const COREPACK_CACHE_LOCK_OWNER_FILE = "owner.json";
const COREPACK_CACHE_STALE_CLAIM_FILE = "stale-claimer.json";
const COREPACK_CACHE_STALE_CLAIM_STALE_MS = 60_000;
const COREPACK_CACHE_LOCK_MISSING_CODES = new Set(["ENOENT", "ENOTDIR"]);
const COREPACK_CACHE_STALE_CLAIM_RACE_CODES = new Set(["EEXIST", "ENOENT", "ENOTDIR"]);
const heldCorepackCacheLocks = new Set();

export function corepackCacheLockDir(locator) {
  return join(corepackCacheDir(locator), ".lock");
}

function sameDirectoryIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function lockOwnerPath(lockDir) {
  return join(lockDir, COREPACK_CACHE_LOCK_OWNER_FILE);
}

function lockOwnerTempPath(lockDir) {
  return join(
    lockDir,
    `${COREPACK_CACHE_LOCK_OWNER_FILE}.${process.pid}.${randomBytes(9).toString("hex")}.tmp`,
  );
}

function readCorepackCacheLockOwner(lockDir) {
  try {
    const owner = JSON.parse(readFileSync(lockOwnerPath(lockDir), "utf8"));
    if (typeof owner?.token !== "string") return undefined;
    return {
      expiresAtMs:
        typeof owner.expiresAtMs === "number" && Number.isFinite(owner.expiresAtMs)
          ? owner.expiresAtMs
          : undefined,
      token: owner.token,
    };
  } catch {
    return undefined;
  }
}

function corepackCacheLockLeaseMs(timeoutMs) {
  return Math.max(timeoutMs * 2, COREPACK_CACHE_LOCK_STALE_MS);
}

function corepackCacheLockRenewalMs(timeoutMs) {
  return Math.max(COREPACK_CACHE_LOCK_POLL_MS, Math.floor(timeoutMs / 2));
}

function corepackCacheLockOwnerRecord(ownerToken, timeoutMs) {
  const leaseMs = corepackCacheLockLeaseMs(timeoutMs);
  return JSON.stringify({
    acquiredAt: new Date().toISOString(),
    expiresAtMs: Date.now() + leaseMs,
    pid: process.pid,
    token: ownerToken,
  });
}

function writeCorepackCacheLockOwnerFile(lockDir, ownerToken, timeoutMs, expectedToken) {
  const tempPath = lockOwnerTempPath(lockDir);
  writeFileSync(tempPath, corepackCacheLockOwnerRecord(ownerToken, timeoutMs), {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  try {
    if (
      expectedToken !== undefined &&
      readCorepackCacheLockOwner(lockDir)?.token !== expectedToken
    ) {
      rmSync(tempPath, { force: true });
      return false;
    }
    renameSync(tempPath, lockOwnerPath(lockDir));
    return true;
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw error;
  }
}

function writeCorepackCacheLockOwner(lockDir, ownerToken, timeoutMs) {
  try {
    writeCorepackCacheLockOwnerFile(lockDir, ownerToken, timeoutMs);
  } catch (error) {
    rmSync(lockDir, { recursive: true, force: true });
    throw error;
  }
}

function renewCorepackCacheLockOwner(lockDir, ownerToken, timeoutMs) {
  if (readCorepackCacheLockOwner(lockDir)?.token !== ownerToken) return;
  writeCorepackCacheLockOwnerFile(lockDir, ownerToken, timeoutMs, ownerToken);
}

function startCorepackCacheLockRenewal(lockDir, ownerToken, timeoutMs) {
  let renewalError;
  const timer = globalThis.setInterval(() => {
    try {
      renewCorepackCacheLockOwner(lockDir, ownerToken, timeoutMs);
    } catch (error) {
      renewalError = error;
      globalThis.clearInterval(timer);
    }
  }, corepackCacheLockRenewalMs(timeoutMs));
  timer.unref?.();
  return {
    assertHealthy: () => {
      if (renewalError !== undefined) throw renewalError;
    },
    stop: () => globalThis.clearInterval(timer),
  };
}

function releaseCorepackCacheLock(lockDir, ownerToken) {
  if (readCorepackCacheLockOwner(lockDir)?.token === ownerToken) {
    rmSync(lockDir, { recursive: true, force: true });
  }
}

function statCorepackCacheLock(lockDir) {
  try {
    return statSync(lockDir);
  } catch (error) {
    if (COREPACK_CACHE_LOCK_MISSING_CODES.has(error?.code)) return undefined;
    throw error;
  }
}

function corepackCacheLockIsStale(lockDir, stats, timeoutMs) {
  const owner = readCorepackCacheLockOwner(lockDir);
  if (owner?.expiresAtMs !== undefined) return Date.now() > owner.expiresAtMs;
  const staleAfterMs = Math.max(timeoutMs * 2, COREPACK_CACHE_LOCK_STALE_MS);
  return Date.now() - stats.mtimeMs > staleAfterMs;
}

function staleClaimPath(lockDir) {
  return join(lockDir, COREPACK_CACHE_STALE_CLAIM_FILE);
}

function staleClaimTombstonePath(lockDir) {
  return join(
    lockDir,
    `${COREPACK_CACHE_STALE_CLAIM_FILE}.${process.pid}.${randomBytes(9).toString("hex")}`,
  );
}

function readCorepackCacheStaleClaim(path) {
  try {
    const claim = JSON.parse(readFileSync(path, "utf8"));
    return {
      expiresAtMs:
        typeof claim?.expiresAtMs === "number" && Number.isFinite(claim.expiresAtMs)
          ? claim.expiresAtMs
          : undefined,
      token: typeof claim?.token === "string" ? claim.token : undefined,
    };
  } catch {
    return { expiresAtMs: undefined, token: undefined };
  }
}

function staleClaimIsExpired(claim, stats) {
  const expiresAtMs = claim.expiresAtMs ?? stats.mtimeMs + COREPACK_CACHE_STALE_CLAIM_STALE_MS;
  return Date.now() > expiresAtMs;
}

function restoreLiveStaleClaim(claimPath, tombstonePath) {
  try {
    writeFileSync(claimPath, readFileSync(tombstonePath), { flag: "wx", mode: 0o600 });
  } catch (error) {
    rmSync(tombstonePath, { force: true });
    if (COREPACK_CACHE_STALE_CLAIM_RACE_CODES.has(error?.code)) return false;
    throw error;
  }
  rmSync(tombstonePath, { force: true });
  return false;
}

function removeExpiredStaleClaim(lockDir) {
  const claimPath = staleClaimPath(lockDir);
  const claimStats = statCorepackCacheLock(claimPath);
  if (claimStats === undefined) return true;
  const claim = readCorepackCacheStaleClaim(claimPath);
  if (!staleClaimIsExpired(claim, claimStats)) return false;
  const tombstonePath = staleClaimTombstonePath(lockDir);
  try {
    renameSync(claimPath, tombstonePath);
  } catch (error) {
    if (COREPACK_CACHE_LOCK_MISSING_CODES.has(error?.code)) return true;
    throw error;
  }
  const tombstoneStats = statSync(tombstonePath);
  const tombstoneClaim = readCorepackCacheStaleClaim(tombstonePath);
  if (
    !sameDirectoryIdentity(claimStats, tombstoneStats) ||
    !staleClaimIsExpired(tombstoneClaim, tombstoneStats)
  ) {
    return restoreLiveStaleClaim(claimPath, tombstonePath);
  }
  rmSync(tombstonePath, { force: true });
  return true;
}

function writeStaleCorepackCacheClaim(lockDir) {
  const token = `${process.pid}-${randomBytes(9).toString("hex")}`;
  const claimedAtMs = Date.now();
  try {
    writeFileSync(
      staleClaimPath(lockDir),
      JSON.stringify({
        claimedAt: new Date(claimedAtMs).toISOString(),
        expiresAtMs: claimedAtMs + COREPACK_CACHE_STALE_CLAIM_STALE_MS,
        pid: process.pid,
        token,
      }),
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
    return token;
  } catch (error) {
    if (COREPACK_CACHE_STALE_CLAIM_RACE_CODES.has(error?.code)) return undefined;
    throw error;
  }
}

function claimStaleCorepackCacheLock(lockDir) {
  const token = writeStaleCorepackCacheClaim(lockDir);
  if (token !== undefined) return token;
  if (!removeExpiredStaleClaim(lockDir)) return undefined;
  return writeStaleCorepackCacheClaim(lockDir);
}

function removeStaleCorepackCacheLock(lockDir, timeoutMs) {
  const stats = statCorepackCacheLock(lockDir);
  if (stats === undefined || !corepackCacheLockIsStale(lockDir, stats, timeoutMs)) return;
  const claimToken = claimStaleCorepackCacheLock(lockDir);
  const currentStats = statCorepackCacheLock(lockDir);
  if (
    claimToken !== undefined &&
    currentStats !== undefined &&
    readCorepackCacheStaleClaim(staleClaimPath(lockDir)).token === claimToken &&
    sameDirectoryIdentity(stats, currentStats)
  ) {
    rmSync(lockDir, { recursive: true, force: true });
  }
}

async function acquireCorepackCacheLock(locator, timeoutMs) {
  const lockDir = corepackCacheLockDir(locator);
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const ownerToken = `${process.pid}-${randomBytes(9).toString("hex")}`;
    try {
      mkdirSync(lockDir, { mode: 0o700 });
      writeCorepackCacheLockOwner(lockDir, ownerToken, timeoutMs);
      const renewal = startCorepackCacheLockRenewal(lockDir, ownerToken, timeoutMs);
      return () => {
        renewal.stop();
        releaseCorepackCacheLock(lockDir, ownerToken);
        renewal.assertHealthy();
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    removeStaleCorepackCacheLock(lockDir, timeoutMs);
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw smokeGateFailure(`timed out waiting for Corepack cache lock for ${locator}`);
    }
    await sleep(Math.min(COREPACK_CACHE_LOCK_POLL_MS, remainingMs));
  }
}

export async function withCorepackYarnCacheLock(
  locator,
  action,
  timeoutMs = npmInstallTimeoutMs(),
) {
  const lockDir = corepackCacheLockDir(locator);
  if (heldCorepackCacheLocks.has(lockDir)) return await action();
  const release = await acquireCorepackCacheLock(locator, timeoutMs);
  heldCorepackCacheLocks.add(lockDir);
  let actionResult;
  let actionError;
  try {
    actionResult = await action();
  } catch (error) {
    actionError = error;
  }
  heldCorepackCacheLocks.delete(lockDir);
  try {
    release();
  } catch (error) {
    if (actionError === undefined) throw error;
  }
  if (actionError !== undefined) throw actionError;
  return actionResult;
}

function formatTsDiagnostics(diagnostics) {
  return diagnostics
    .map((diagnostic) => {
      const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
      if (diagnostic.file === undefined || diagnostic.start === undefined) {
        return message;
      }
      const { line, character } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
      return `${diagnostic.file.fileName}:${String(line + 1)}:${String(character + 1)} ${message}`;
    })
    .join("\n");
}

function diffExpectedExports(actual, expected) {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  return {
    missing: expected.filter((item) => !actualSet.has(item)),
    unexpected: actual.filter((item) => !expectedSet.has(item)),
  };
}

function externalConsumerCompilerOptions() {
  return {
    baseUrl: repoRoot,
    ignoreDeprecations: "6.0",
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    module: ts.ModuleKind.NodeNext,
    target: ts.ScriptTarget.ES2022,
    noEmit: true,
    skipLibCheck: false,
    paths: {
      ws: ["node_modules/@types/ws/index.d.ts"],
    },
    strict: true,
    typeRoots: [join(repoRoot, "node_modules", "@types")],
    types: ["node", "ws"],
  };
}

function probeHost(compilerOptions, probeFile, probeText) {
  const host = ts.createCompilerHost(compilerOptions, true);
  host.readFile = (fileName) => {
    if (fileName === probeFile) {
      return probeText;
    }
    return ts.sys.readFile(fileName);
  };
  host.fileExists = (fileName) => fileName === probeFile || ts.sys.fileExists(fileName);
  return host;
}

function collectConsumerVisibleTypeExports(specifier, fromDirectory) {
  // TypeScript normalises program filenames to forward slashes internally, and the custom compiler
  // host below matches the in-memory probe by exact string (`fileName === probeFile`). On Windows
  // `join` yields backslashes, so TS would look up `C:/.../probe.ts` while the host holds
  // `C:\...\probe.ts` → no match → "probe file not found". Use a forward-slash path so the host and
  // `program.getSourceFile` agree with TS's normalisation on every OS (POSIX is already `/`).
  const probeFile = join(fromDirectory, "__keiko-public-api-probe__.ts").replaceAll("\\", "/");
  const probeText =
    `export * from ${JSON.stringify(specifier)};\n` +
    `export type __Probe = typeof import(${JSON.stringify(specifier)});\n`;
  const compilerOptions = externalConsumerCompilerOptions();
  const host = probeHost(compilerOptions, probeFile, probeText);
  const program = ts.createProgram([probeFile], compilerOptions, host);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.length > 0) {
    fail(
      "installed declarations do not typecheck for an external consumer:\n" +
        formatTsDiagnostics(diagnostics),
    );
  }
  const sourceFile = program.getSourceFile(probeFile);
  if (sourceFile === undefined) {
    fail(`TypeScript source file not found: ${probeFile}`);
  }
  const checker = program.getTypeChecker();
  const symbol = checker.getSymbolAtLocation(sourceFile);
  if (symbol === undefined) {
    fail(`TypeScript module symbol not found for: ${probeFile}`);
  }
  return checker
    .getExportsOfModule(symbol)
    .map((item) => item.getName())
    .filter((item) => item !== "__Probe")
    .sort((left, right) => left.localeCompare(right));
}

export function packRoot() {
  // BEHAVIOURAL BRANCH (env-gated, opt-in): default behaviour is unchanged — the gating Linux
  // `build-scan-sbom-smoke` job leaves the flag unset and packs with the full `prepack` chain
  // (clean + build + every release gate). ONLY the cross-platform runtime smoke (#284 AC4) opts in
  // by setting KEIKO_SMOKE_PACK_IGNORE_SCRIPTS=1, which packs the
  // ALREADY-BUILT dist (assembled by the job's explicit build / prepare:bin / build:ui steps)
  // WITHOUT re-running that chain: the prepack gates (arch-check, package-surface, supply-chain)
  // are the Linux publish gate — they run on the gating `build-scan-sbom-smoke` job and several
  // shell out to `npx`/`npm` in ways that are not Windows-portable, which is a separate concern from
  // verifying that the PACKED ARTIFACT runs cross-platform. On Linux the gate keeps the full
  // prepack pack (flag unset), so its coverage is unchanged.
  if (process.env.KEIKO_SMOKE_PACK_IGNORE_SCRIPTS !== "1") {
    const gateResult = run("npm", ["run", "prepack"], { cwd: repoRoot });
    if (gateResult.status !== 0) {
      fail(`npm run prepack exited ${String(gateResult.status)}: ${gateResult.stderr}`);
    }
  }
  const staged = createStagedPublishPackage();
  const manifest = JSON.parse(readFileSync(join(staged.packageDir, "package.json"), "utf8"));
  const artifactRoot = mkdtempSync(join(tmpdir(), "keiko-install-artifact-"));
  const result = run(
    "npm",
    ["pack", "--silent", "--ignore-scripts", "--pack-destination", artifactRoot],
    { cwd: staged.packageDir },
  );
  const bundledManifests = staged.vendorPackages.map((vendorPackage) => vendorPackage.manifest);
  staged.cleanup();
  if (result.status !== 0) {
    rmSync(artifactRoot, { recursive: true, force: true });
    fail(`npm pack exited ${String(result.status)}: ${result.stderr}`);
  }
  const tarballName = `oscharko-dev-keiko-${rootVersion}.tgz`;
  const tarballPath = join(artifactRoot, tarballName);
  if (!existsSync(tarballPath)) {
    rmSync(artifactRoot, { recursive: true, force: true });
    fail(`expected tarball at ${tarballPath} after npm pack`);
  }
  return {
    manifest,
    // The staged bundled workspace manifests, as they will ship INSIDE the tarball. They are a
    // third descriptor surface: `assertStagedRootDescriptors` sees the promoted root and
    // `assertRegistryOnlyDescriptors` the seeded third parties, but neither reads these (#3133).
    bundledManifests,
    tarballPath,
    cleanup: () => rmSync(artifactRoot, { recursive: true, force: true }),
  };
}

function installInto(tmp, tarballPath, options) {
  const timeoutMs = npmInstallTimeoutMs();
  const initResult = run("npm", ["init", "-y"], { cwd: tmp });
  if (initResult.status !== 0) {
    fail(`npm init -y exited ${String(initResult.status)}: ${initResult.stderr}`);
  }
  // `--ignore-scripts` matches the conservative posture the gate models for consumer installs:
  // a future vendored package that acquires a `postinstall` hook would otherwise execute it on
  // every CI build and developer machine before review (issue #169 security-triage finding L1).
  const installResult = run(
    "npm",
    [
      "install",
      tarballPath,
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      ...(options.includeOptional ? [] : ["--omit=optional"]),
    ],
    { cwd: tmp, timeout: timeoutMs },
  );
  if (installResult.status !== 0) {
    fail(
      `npm install of tarball exited ${String(installResult.status)} ` +
        `(signal=${String(installResult.signal)}): ${installResult.stderr}`,
    );
  }
}

function registryPackument(registryUrl, artifact, tarballBytes) {
  const integrity = `sha512-${createHash("sha512").update(tarballBytes).digest("base64")}`;
  return {
    name: rootPackageJson.name,
    "dist-tags": { latest: rootVersion },
    versions: {
      [rootVersion]: {
        ...artifact.manifest,
        dist: {
          integrity,
          tarball: `${registryUrl}/@oscharko-dev/keiko/-/keiko-${rootVersion}.tgz`,
        },
      },
    },
  };
}

// The published root declares 23 bundled private workspaces plus a handful of genuine third-party
// runtime dependencies. Everything the Yarn consumer resolves therefore has to come from somewhere,
// and before #3130 only the `oscharko-dev` scope was pointed at this local registry — the rest was
// resolved live from the public npm registry, on every run. That made a required gate depend on a
// stranger's publish timing: on 2026-08-13 `@napi-rs/canvas` 1.0.6 was published 22 minutes before
// its own `linux-x64-musl` platform package, and every Keiko pull request went red in that window.
// The closure below is seeded from THIS repository's `node_modules`, i.e. exactly the versions the
// committed `package-lock.json` already pins, so the smoke answers the Yarn-compatibility question
// offline and deterministically.
/** `@oscharko-dev/keiko-ui` -> `packages/keiko-ui`, the path package-lock.json keys that workspace by. */
function bundledWorkspaceLockfilePath(workspace) {
  const directory = /^@oscharko-dev\/(?<name>[^/]+)$/u.exec(workspace)?.groups?.name;
  if (directory === undefined) {
    fail(
      `bundled workspace ${workspace} is outside the @oscharko-dev scope, so its lockfile path ` +
        `cannot be derived for the offline closure`,
    );
  }
  return `packages/${directory ?? ""}`;
}

function workspaceThirdPartyRequirements(workspace, packagesRoot) {
  // A bundled workspace outside the product scope would leave `@other/foo` in the path and miss
  // its manifest, silently dropping that workspace's third-party dependencies from the closure —
  // Yarn would then request a package this registry never seeded. Both that case and a genuinely
  // absent manifest fail loudly instead, naming the workspace.
  const scoped = /^@oscharko-dev\/(?<name>[^/]+)$/u.exec(workspace);
  const directory = scoped?.groups?.name;
  if (directory === undefined) {
    fail(
      `bundled workspace ${workspace} is outside the @oscharko-dev scope, so its third-party ` +
        `dependencies cannot be located for the offline closure`,
    );
  }
  const manifestPath = join(packagesRoot, "packages", directory ?? "", "package.json");
  if (!existsSync(manifestPath)) {
    fail(
      `bundled workspace ${workspace} has no manifest at packages/${directory ?? ""}, so its ` +
        `third-party dependencies cannot be added to the offline closure`,
    );
  }
  const workspaceManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  // Same npm precedence as any other manifest: an optional entry overrides a same-named required
  // one within this file. Flattening both groups separately would emit a required record for a
  // name npm treats as optional.
  return manifestRequirements(workspaceManifest).filter(
    ({ name }) => !name.startsWith("@oscharko-dev/"),
  );
}

/**
 * Whether the version an edge resolves to satisfies THIS descriptor's range.
 *
 * Per descriptor, not per name: when one parent's optional range is satisfied by an installed copy
 * and a second parent declares a NON-OVERLAPPING optional range for the same name, npm may resolve
 * the second to nothing and the walk-up then finds the first parent's copy. Serving it would answer
 * a descriptor it does not satisfy, and Yarn fails with "no candidates" for the other one.
 *
 * `semver` decides this rather than `minimumSatisfyingVersion`'s lowest-member approximation: the
 * ranges here come from every manifest in the transitive closure, and a hand-rolled matcher over
 * that grammar is exactly the guessing this file already refuses to do elsewhere. An `npm:` alias
 * descriptor carries its range after the target, which is the half `semver` needs.
 */
export function descriptorIsSatisfied(requirement, version) {
  if (version === undefined) return false;
  const range = aliasRange(requirement.range ?? "");
  if (range === "" || range === "*" || range === "latest") return true;
  return satisfies(version, range, { includePrerelease: true, loose: true });
}

/**
 * `npm:target@^1.2.3` -> `^1.2.3`. `assertRegistryOnlyDescriptors` already accepts `npm:` as a
 * registry protocol; treating it as unresolvable here is the inconsistency #3133 records, and it
 * made a legitimately absent optional alias fatal instead of stubbing it.
 */
export function aliasRange(range) {
  const trimmed = range.trim();
  if (!trimmed.startsWith("npm:")) return trimmed;
  const target = trimmed.slice("npm:".length);
  const at = target.lastIndexOf("@");
  return at <= 0 ? "*" : target.slice(at + 1);
}

/**
 * A concrete version that satisfies `range`, used only to name an inert stub for an optional
 * dependency this repository does not install. Handles the npm forms that actually occur —
 * exact, `^`, `~`, `>=`, `v`-prefixed, x-ranges and `*` — and returns `undefined` for anything
 * else, which `recordAbsent` treats as fatal. Guessing at a grammar this does not model would
 * serve a stub that does not satisfy the requested range, and Yarn would fail with a confusing
 * "no candidates" error instead of a diagnosable one.
 */
export function minimumSatisfyingVersion(range) {
  const trimmed = aliasRange(range ?? "");
  if (trimmed === "" || trimmed === "*" || trimmed === "x" || trimmed === "latest") return "0.0.0";
  // A strict `>` or `<` excludes the boundary version, so the lowest member of the range is not
  // derivable this way. Those return undefined and the absence becomes fatal, rather than serving
  // a stub the descriptor itself rejects.
  if (/^[<>]\s*[^=]/u.test(trimmed)) return undefined;
  // Anchored, with disjoint leading operators and digits, so there is nothing to backtrack over.
  // The prerelease suffix is preserved: an exact `1.2.3-beta.1` is satisfied only by itself, so
  // dropping it would again produce a stub the range rejects.
  const exact = /^[\s^~>=v]*(\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?)/u.exec(trimmed);
  if (exact !== null) return exact[1];
  // x-ranges: 1.x, 1.2.x, 1.*
  return partialRangeVersion(trimmed);
}

/** x-ranges (`1.x`, `1.2.x`, `1.*`) and a bare major, each resolving to the range's lowest member. */
function partialRangeVersion(trimmed) {
  // Every partial form npm accepts resolves to the lowest member of its range: an x-range
  // (`1.x`, `1.2.*`), a two-part version (`1.2`, `~1.2`, `^1.2`) or a bare major (`3`, `^3`).
  const partial = /^[\s^~>=v]*(\d+)(?:\.(\d+))?(?:\.[x*])?$/u.exec(trimmed);
  if (partial !== null) return `${partial[1]}.${partial[2] ?? "0"}.0`;
  const xRange = /^[\s^~>=v]*(\d+)(?:\.(\d+))?\.[x*]/u.exec(trimmed);
  return xRange === null ? undefined : `${xRange[1]}.${xRange[2] ?? "0"}.0`;
}

/**
 * npm's package-json documentation: "Entries in optionalDependencies will override entries of the
 * same name in dependencies." That precedence is applied per manifest, so a name listed in both is
 * treated as optional. Across DIFFERENT manifests a genuine required edge still wins — see
 * `record()` — because another package really does need it.
 */
function manifestRequirements(manifest, bundledSet = new Set()) {
  const merged = new Map();
  for (const [name, range] of Object.entries(manifest.dependencies ?? {})) {
    merged.set(name, { name, range, optional: false });
  }
  for (const [name, range] of Object.entries(manifest.optionalDependencies ?? {})) {
    merged.set(name, { name, range, optional: true });
  }
  return [...merged.values()].filter((requirement) => !bundledSet.has(requirement.name));
}

export function vendoredDependencyRequirements(
  manifest = rootPackageJson,
  packagesRoot = repoRoot,
) {
  const bundled = manifest.bundleDependencies ?? manifest.bundledDependencies ?? [];
  const bundledSet = new Set(bundled);
  const requirements = new Map();
  // Keyed by name AND range AND kind, so each descriptor keeps the origins that actually declared
  // IT. Keying by name alone unioned the origins across ranges: two bundled workspaces declaring
  // the same optional package under non-overlapping ranges produced a range/origin cross-product,
  // so the origin resolving `foo@2.x` was also checked against `1.x`, missed, and minted a spurious
  // minimum-version stub that `assertStubsAreForeignOnly` then rejected as unpinned. Required
  // edges had the same defect one step earlier — the last range overwrote the others while every
  // origin was retained.
  const record = ({ name, range, optional }, origin) => {
    const key = `${name}\u0000${optional === true ? "optional" : "required"}\u0000${range}`;
    const existing = requirements.get(key) ?? {
      name,
      range,
      optional: optional === true,
      origins: new Set(),
    };
    // The lockfile path the edge was declared from. npm resolves a bundled workspace's dependency
    // from that workspace's own directory, so a closure that resolved everything from the root
    // would miss a nested copy — and pick up a hoisted one the workspace never sees.
    existing.origins.add(origin);
    requirements.set(key, existing);
  };
  // The staged root carries optional entries too — `promoteWorkspacePeers` lifts a workspace's
  // optional third-party peers into exactly that field — so both groups belong in the closure.
  for (const requirement of manifestRequirements(manifest, bundledSet)) record(requirement, "");
  // A bundled workspace ships inside the tarball, but its own third-party dependencies do not:
  // the consumer's package manager still resolves those from a registry. `keiko-local-knowledge`
  // declaring `@napi-rs/canvas` is exactly how the 2026-08-13 upstream publish race reached a
  // required Keiko gate, so the closure has to include them.
  for (const workspace of bundled) {
    const origin = bundledWorkspaceLockfilePath(workspace);
    for (const requirement of workspaceThirdPartyRequirements(workspace, packagesRoot)) {
      record(requirement, origin);
    }
  }
  // A required edge from any manifest supersedes this name's optional descriptors, since that one
  // must genuinely be present and must never be answered with an inert stub.
  const required = new Set(
    [...requirements.values()].filter(({ optional }) => !optional).map(({ name }) => name),
  );
  return [...requirements.values()]
    .filter(({ name, optional }) => !optional || !required.has(name))
    .sort(
      (left, right) =>
        compareStrings(left.name, right.name) || compareStrings(left.range, right.range),
    )
    .map(({ name, range, optional, origins }) => ({
      name,
      range,
      optional,
      origins: [...origins].sort(compareStrings),
    }));
}

export function vendoredDependencyNames(manifest = rootPackageJson, packagesRoot = repoRoot) {
  return vendoredDependencyRequirements(manifest, packagesRoot).map(({ name }) => name);
}

/**
 * Yarn resolves every `optionalDependencies` entry unless the supported architectures are pinned,
 * which for a package like `@napi-rs/canvas` means all eleven prebuilt platform packages. Only the
 * running platform's variant is installed here, so narrowing this to the current host keeps the
 * offline closure both small and complete. `glibcVersionRuntime` is absent on musl builds.
 */
function linuxLibc() {
  if (process.platform !== "linux") return undefined;
  const glibc = process.report?.getReport?.()?.header?.glibcVersionRuntime;
  return glibc === undefined ? "musl" : "glibc";
}

export function supportedArchitectures() {
  const libc = linuxLibc();
  return {
    os: [process.platform],
    cpu: [process.arch],
    ...(libc === undefined ? {} : { libc: [libc] }),
  };
}

function compareStrings(left, right) {
  if (left < right) return -1;
  return left > right ? 1 : 0;
}

function readInstalledManifest(name, modulesRoot) {
  const manifestPath = join(modulesRoot, ...name.split("/"), "package.json");
  if (!existsSync(manifestPath)) return undefined;
  return JSON.parse(readFileSync(manifestPath, "utf8"));
}

// ─── Lockfile closure (#3133) ──────────────────────────────────────────────────────────────────
//
// The offline registry used to be seeded by scanning the installed tree for each needed NAME,
// anywhere it appeared: the hoisted `node_modules`, every `packages/<workspace>/node_modules`, and
// nested roots below both. That set is wider than the production graph. A development tool's copy of
// a runtime dependency name was offered in the packument beside the real one — `typescript` 6.0.3
// (a root dependency) and 5.7.3 (`packages/keiko-ui`'s devDependency, `dev: true` in the lockfile)
// were both seeded — and a stale local copy could be served in place of the version the committed
// lockfile resolves. The smoke could then exercise a graph consumers never receive.
//
// The closure is therefore walked over `package-lock.json`'s own edges. Every question the guards
// used to ask of the tree — which copies exist, at which versions, under which platform scope — is
// asked of the lockfile instead, and the installed directory is only ever the payload.

const lockfilePackageCache = new Map();

function readLockfilePackages(lockfilePath) {
  const cached = lockfilePackageCache.get(lockfilePath);
  if (cached !== undefined) return cached;
  if (!existsSync(lockfilePath)) {
    fail(`${lockfilePath} does not exist, so the vendored closure cannot be derived from it`);
  }
  const parsed = JSON.parse(readFileSync(lockfilePath, "utf8"));
  const packages = new Map(Object.entries(parsed.packages ?? {}));
  lockfilePackageCache.set(lockfilePath, packages);
  return packages;
}

/**
 * The install path that owns `path` — where Node's resolution continues when a name is not found
 * beside it. `node_modules/a/node_modules/b` is owned by `node_modules/a`; a workspace path and a
 * hoisted package alike are owned by the project root, spelled `""`.
 */
export function lockfileOwnerPath(path) {
  const marker = "/node_modules/";
  const at = path.lastIndexOf(marker);
  return at === -1 ? "" : path.slice(0, at);
}

/**
 * Resolve one dependency edge the way Node does: beside the requesting package first, then in each
 * owner up to the project root. This is the whole point of #3133 — the answer comes from the edges
 * the lockfile pins, so a copy the production graph never selects is never even considered.
 */
export function resolveLockfileEdge(packages, originPath, name) {
  let owner = originPath;
  for (;;) {
    const candidate = owner === "" ? `node_modules/${name}` : `${owner}/node_modules/${name}`;
    if (packages.has(candidate)) return candidate;
    if (owner === "") return undefined;
    owner = lockfileOwnerPath(owner);
  }
}

/**
 * The name and version a lockfile record pins. An `npm:` alias is installed under the ALIAS
 * directory while Yarn requests the packument under the TARGET name, and the record carries that
 * target in its own `name` field — which is why the alias question this issue also tracks is
 * answered here rather than by re-parsing a descriptor `minimumSatisfyingVersion` cannot read.
 */
export function lockfileRecordIdentity(path, entry) {
  const installedAs = path.split("node_modules/").at(-1) ?? "";
  return {
    name: typeof entry.name === "string" && entry.name.length > 0 ? entry.name : installedAs,
    version: typeof entry.version === "string" ? entry.version : undefined,
  };
}

/**
 * npm hoists what it can and nests the rest, so one dependency name can be installed at several
 * versions across the workspace tree (`@napi-rs/canvas` is hoisted at 1.0.0 while
 * `keiko-local-knowledge` carries 1.0.2 for its own `^1.0.2` range). The offline registry has to
 * offer every installed copy, or Yarn resolves a range this repository genuinely satisfies against
 * a packument that happens to omit it.
 */
export function findInstalledCopies(name, modulesRoot, packagesRoot = repoRoot) {
  const copies = new Map();
  const record = (root) => {
    const manifest = readInstalledManifest(name, root);
    if (manifest === undefined) return;
    // Keyed by TARGET name and version: two parents may use one alias key for different targets at
    // the same version (`codec: "npm:foo@1.0.0"` and `codec: "npm:bar@1.0.0"`), and npm installs
    // both. A version-only key would discard whichever was scanned second, and Yarn would then ask
    // for a packument this registry never seeded.
    const copyKey = `${typeof manifest.name === "string" ? manifest.name : name}@${manifest.version}`;
    if (copies.has(copyKey)) return;
    copies.set(copyKey, {
      // An `npm:real@1.0.0` alias is installed under the alias directory, but Yarn requests the
      // packument under the TARGET name from the manifest, so that is the key to serve it by.
      name: typeof manifest.name === "string" && manifest.name.length > 0 ? manifest.name : name,
      version: manifest.version,
      directory: join(root, ...name.split("/")),
      manifest,
    });
  };
  for (const root of installedModuleRoots(modulesRoot, packagesRoot)) record(root);
  return [...copies.values()];
}

/**
 * npm hoists what it can, nests the rest under `packages/<workspace>/node_modules`, and nests a
 * third conflicting version under `node_modules/<pkg>/node_modules`. All three are searched, so a
 * version this repository genuinely pins can never be missing from the served packument.
 */
const moduleRootCache = new Map();

function installedModuleRoots(modulesRoot, packagesRoot) {
  // The root set cannot change during a run, and this walk is otherwise repeated for every visited
  // package name, multiplying syscalls in a required gate.
  const cacheKey = `${modulesRoot}\u0000${packagesRoot}`;
  const cached = moduleRootCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const roots = [modulesRoot];
  const workspacesDir = join(packagesRoot, "packages");
  if (existsSync(workspacesDir)) {
    for (const workspace of readdirSync(workspacesDir)) {
      roots.push(join(workspacesDir, workspace, "node_modules"));
    }
  }
  // Every root is scanned recursively, workspace roots included: npm nests a conflict under a
  // workspace exactly as it does under the hoisted tree.
  const all = [...roots, ...roots.flatMap((root) => nestedModuleRoots(root))];
  moduleRootCache.set(cacheKey, all);
  return all;
}

// npm resolves a conflict below an already nested dependency too
// (`node_modules/a/node_modules/b/node_modules/c`), and a chain of incompatible peer ranges can go
// deeper still. The walk is therefore complete rather than capped at an arbitrary depth: a fixed
// limit would silently omit a package the committed installation genuinely contains, and the gate
// would report it missing or serve a stub in its place. Termination comes from a visited set over
// resolved paths, which also breaks symlink cycles; the whole walk is memoized once per run.
function nestedModuleRoots(modulesRoot, visited = new Set()) {
  if (!existsSync(modulesRoot)) return [];
  const resolvedRoot = realpathSync(modulesRoot);
  if (visited.has(resolvedRoot)) return [];
  visited.add(resolvedRoot);
  const roots = [];
  for (const entry of readdirSync(modulesRoot)) {
    if (entry.startsWith(".")) continue;
    const owners = entry.startsWith("@")
      ? readdirSync(join(modulesRoot, entry)).map((scoped) => join(modulesRoot, entry, scoped))
      : [join(modulesRoot, entry)];
    for (const owner of owners) {
      const nested = join(owner, "node_modules");
      if (!existsSync(nested)) continue;
      roots.push(nested, ...nestedModuleRoots(nested, visited));
    }
  }
  return roots;
}

/**
 * Walks the third-party dependency closure the Yarn consumer has to resolve — the root's own
 * non-bundled dependencies plus those declared by the bundled workspaces — against this
 * repository's installed tree, i.e. the versions `package-lock.json` already pins. A dependency
 * that is only reachable as an optional entry and is not installed here is not an error: Yarn is
 * told not to ask for it via `supportedArchitectures`.
 */
export function resolveVendorClosure(
  modulesRoot,
  manifest = rootPackageJson,
  packagesRoot = repoRoot,
  lockfilePath = join(dirname(modulesRoot), "package-lock.json"),
) {
  // `manifest` should be the STAGED manifest (`artifact.manifest`), not the repo root:
  // `promoteWorkspacePeers` in stage-publish-package.mjs lifts a bundled workspace's third-party
  // peer dependencies into the staged root, and a closure that re-derived only the workspace's
  // own dependency fields would miss them — the consumer would then request a package this
  // registry never seeded. Deriving from the producer's output keeps the two in step.
  const state = {
    installRoot: dirname(modulesRoot),
    packages: readLockfilePackages(lockfilePath),
    resolved: new Map(),
    visited: new Set(),
    stubs: new Map(),
    missing: [],
  };
  for (const requirement of vendoredDependencyRequirements(manifest, packagesRoot)) {
    for (const origin of requirement.origins) visitClosureEdge(state, origin, requirement);
  }
  return {
    packages: [...state.resolved.values()],
    stubs: [...state.stubs.values()],
    missing: state.missing,
  };
}

function recordClosureMissing(state, name) {
  if (!state.missing.includes(name)) state.missing.push(name);
}

/**
 * An optional edge the tree does not carry becomes an inert stub: resolvable, never linked. The
 * version comes from the LOCKFILE record when there is one — npm still pins every platform
 * prebuild it declined to install — and only falls back to the range's lowest member when the
 * lockfile pins nothing at all. That fallback is what `minimumSatisfyingVersion` is for, and a
 * range it cannot model leaves the absence fatal rather than serving a stub the descriptor rejects.
 */
/**
 * `name` is the LOCKFILE identity when the edge resolved, not the descriptor's own name.
 *
 * An `npm:` alias declares one name and the lockfile records another: `entry.name` carries the
 * target. Keying the stub by the alias seeded a packument no consumer resolves, and then
 * `assertStubsAreForeignOnly` rejected it as unpinned — the lockfile has no record under the alias
 * — so the absent-alias path failed closed on a closure that was in fact valid. Where no edge
 * resolved there is no identity to prefer, and the descriptor's name is the only one there is.
 */
function stubClosureEdge(state, requirement, version, name = requirement.name) {
  if (requirement.optional !== true || version === undefined) {
    recordClosureMissing(state, requirement.name);
    return;
  }
  // Keyed by name AND version: two platform builds of one package each demand their own stub.
  state.stubs.set(`${name}@${version}`, { name, version });
}

/**
 * A required edge withdraws the stub an optional edge left behind AT THAT VERSION: serving an inert
 * package for a genuinely required dependency would let the smoke pass without it.
 *
 * Only that one version. Stubs are keyed by name AND version, and a recursive child traversal can
 * legitimately mint several for one name — a transitive optional descriptor does not pass through
 * the supersede rule that drops a name's optional entries at the root. Deleting every version
 * removed a stub some other descriptor still needs, leaving Yarn with no candidate for it.
 */
function withdrawClosureStub(state, name, version) {
  state.stubs.delete(`${name}@${String(version)}`);
}

function visitClosureEdge(state, originPath, requirement) {
  const edge = resolveLockfileEdge(state.packages, originPath, requirement.name);
  if (edge === undefined) {
    // The lockfile pins no such edge from here: an optional dependency npm dropped entirely, or a
    // closure defect. Both are decided by the descriptor, never by scanning the tree for the name.
    stubClosureEdge(state, requirement, minimumSatisfyingVersion(requirement.range));
    return;
  }
  const entry = state.packages.get(edge) ?? {};
  const identity = lockfileRecordIdentity(edge, entry);
  if (!descriptorIsSatisfied(requirement, identity.version)) {
    // The edge exists but this descriptor's range excludes it — the non-overlapping optional range
    // case. It needs its own stub; seeding the resolved copy would answer the wrong descriptor.
    stubClosureEdge(state, requirement, minimumSatisfyingVersion(requirement.range), identity.name);
    return;
  }
  if (requirement.optional !== true) withdrawClosureStub(state, identity.name, identity.version);
  seedClosurePackage(state, edge, entry, identity, requirement);
}

function seedClosurePackage(state, edge, entry, identity, requirement) {
  if (state.visited.has(edge)) return;
  state.visited.add(edge);
  const directory = join(state.installRoot, edge);
  const installed = readManifestAt(directory);
  if (installed === undefined) {
    // The lockfile selects a path this checkout does not have. For an optional edge that is npm
    // declining a platform prebuild — the stub path. For a required one it is a broken tree.
    state.visited.delete(edge);
    stubClosureEdge(state, requirement, identity.version, identity.name);
    return;
  }
  assertInstalledMatchesLockfile(edge, identity, installed);
  state.resolved.set(edge, {
    name: identity.name,
    version: identity.version,
    directory,
    manifest: installed,
  });
  for (const child of manifestRequirements(installed)) visitClosureEdge(state, edge, child);
}

/**
 * A tree that has drifted from the lockfile answers a different question than the committed
 * closure does, and serving its bytes is exactly the "graph consumers never receive" this issue
 * exists to stop. Named loudly rather than tolerated.
 */
function assertInstalledMatchesLockfile(edge, identity, installed) {
  // The NAME is checked too. A directory carrying the pinned version but a different package's
  // manifest used to pass: the seed was then advertised under the lockfile identity while `npm
  // pack` archived the directory under its own, so the smoke exercised bytes for the wrong package
  // or failed later inside Yarn with nothing naming the cause. An alias is unaffected — its
  // installed manifest already carries the target name, which is what the identity resolves to.
  if (installed.name === identity.name && installed.version === identity.version) return;
  fail(
    `${edge} is installed as ${String(installed.name)}@${String(installed.version)} but ` +
      `package-lock.json pins ${identity.name}@${String(identity.version)}, so the offline ` +
      `registry would serve something the committed closure does not resolve — run ` +
      `\`npm install\` before the installable-package smoke`,
  );
}

function readManifestAt(directory) {
  const manifestPath = join(directory, "package.json");
  if (!existsSync(manifestPath)) return undefined;
  return JSON.parse(readFileSync(manifestPath, "utf8"));
}

function packVendoredPackage(entry, destination) {
  const timeoutMs = npmInstallTimeoutMs();
  // npm names its output `<flattened-name>-<version>.tgz`, which collides across the scope
  // boundary: `@foo/bar@1.2.3` and `foo-bar@1.2.3` both produce `foo-bar-1.2.3.tgz`. A per-package
  // directory keeps the second pack from overwriting the first after its integrity was recorded,
  // which would hand Yarn the wrong bytes.
  // Keyed by a digest of the exact name, not a character-class replacement: collapsing every
  // separator to "-" maps `@foo/bar-baz` and `@foo-bar/baz` onto the same directory, and npm then
  // names both archives `foo-bar-baz-1.2.3.tgz`, so the second overwrites the first after its
  // integrity was recorded and Yarn receives bytes that fail the checksum it was handed.
  const nameDigest = createHash("sha256").update(entry.name).digest("hex").slice(0, 16);
  const packDir = join(destination, `pack-${nameDigest}`);
  mkdirSync(packDir, { recursive: true });
  const result = run(
    "npm",
    ["pack", entry.directory, "--pack-destination", packDir, "--ignore-scripts", "--json"],
    { cwd: repoRoot, timeout: timeoutMs },
  );
  if (result.status !== 0) {
    fail(
      `npm pack of vendored dependency ${entry.name} exited ${String(result.status)}: ` +
        `${(result.stderr || result.stdout).trim()}`,
    );
  }
  const produced = JSON.parse(result.stdout).at(0)?.filename;
  if (typeof produced !== "string" || produced.length === 0) {
    fail(`npm pack of vendored dependency ${entry.name} printed no tarball name`);
  }
  return join(packDir, produced);
}

/**
 * A stub carries the real name and a satisfying version so the resolution graph closes, and an
 * `os`/`cpu` pair that matches no host so the package manager never links it. It exists only for
 * optional dependencies this repository does not install; nothing real is ever replaced by one.
 */
// Yarn evaluates platform compatibility from packument metadata, not only from the tarball, so
// these guards have to appear in BOTH. Without them in the packument, an absent optional package
// would be linked as an empty stub and a native-binding regression could pass unnoticed (#3130).
const STUB_INCOMPATIBLE_PLATFORM = "keiko-smoke-never-matches";

export function stubManifest(name, version) {
  return {
    name,
    version,
    description:
      "Inert offline stub served by the Keiko installable-package smoke (#3130). Never linked.",
    os: [STUB_INCOMPATIBLE_PLATFORM],
    cpu: [STUB_INCOMPATIBLE_PLATFORM],
  };
}

function packStubPackage(entry, destination) {
  const stubDir = mkdtempSync(join(destination, "stub-"));
  mkdirSync(stubDir, { recursive: true });
  writeFileSync(
    join(stubDir, "package.json"),
    `${JSON.stringify(stubManifest(entry.name, entry.version), null, 2)}\n`,
    "utf8",
  );
  try {
    return packVendoredPackage({ name: entry.name, directory: stubDir }, destination);
  } finally {
    // The tarball is already written to `destination`; the scaffolding directory is not needed
    // beyond this point, so it goes immediately rather than lingering until the caller cleans up.
    rmSync(stubDir, { recursive: true, force: true });
  }
}

const isStubEntry = (entry) => entry?.manifest?.os?.[0] === STUB_INCOMPATIBLE_PLATFORM;

/**
 * A stub is only ever legitimate for a FOREIGN platform prebuild. If a package is seeded for real
 * but the optional binding matching this host is a stub, the install would run without the native
 * binding while ADR-0021 D7 claims the running platform's binding is installed and proven — so the
 * gate says so instead of quietly shipping the weaker guarantee (#3130).
 */
function stubbedHostBindings(seeded, entry, hostSuffixes) {
  if (isStubEntry(entry)) return [];
  return Object.entries(entry.manifest?.optionalDependencies ?? {})
    .filter(([optional]) => hostSuffixes.some((suffix) => optional.endsWith(suffix)))
    .filter(([optional, range]) => {
      // The version THIS parent declares, not any version under the name. The lockfile carries
      // canvas 1.0.0 and 1.0.2, so an aggregate check passes as soon as one binding is real while
      // the other parent still resolves its exact binding to a stub.
      const required = minimumSatisfyingVersion(range);
      const versions = seeded.get(optional);
      if (versions === undefined || required === undefined) return false;
      const candidate = versions.get(required);
      return candidate !== undefined && isStubEntry(candidate);
    })
    .map(([optional, range]) => `${entry.name}@${entry.version} -> ${optional}@${range}`);
}

/**
 * Prebuilt binding names carry an ABI suffix on some platforms — `-linux-x64-gnu`, `-linux-x64-musl`,
 * `-win32-x64-msvc` — so a bare `-<platform>-<arch>` suffix matches nothing on exactly the lanes CI
 * runs. The set is derived from the same libc detection `supportedArchitectures()` uses, so a glibc
 * host does not accept the musl build as its own.
 */
/** The toolchain spellings a Linux prebuild for this libc and architecture may carry. */
function linuxBindingAbis(libc, arch) {
  if (libc === "musl") return ["musl"];
  if (arch === "arm") return ["gnueabihf", "gnu"];
  return ["gnu"];
}

export function hostBindingSuffixes(
  platform = process.platform,
  arch = process.arch,
  libc = undefined,
) {
  const base = `-${platform}-${arch}`;
  if (platform === "linux") {
    const resolvedLibc = libc ?? linuxLibc();
    // `linuxLibc()` yields the value Yarn's `supportedArchitectures` expects — `glibc` — while the
    // prebuilt packages are named with the toolchain, `-gnu`. Using the Yarn spelling here would
    // generate `-linux-x64-glibc`, which matches no published binding, and the guard would be
    // inert on the glibc lane exactly as the bare suffix was on every lane.
    //
    // 32-bit ARM is the one architecture where "the toolchain" is not `gnu`: its glibc builds are
    // hard-float, spelled `gnueabihf`, and `package-lock.json` carries exactly that name
    // (`@napi-rs/canvas-linux-arm-gnueabihf`). Emitting only `-linux-arm-gnu` there would match no
    // published binding, so a stubbed host binding would pass unnoticed on that lane — the very
    // gap this helper closes everywhere else (Codex thread 3780358321). Both spellings are
    // returned rather than one, because the suffix set is matched with `endsWith` and a name that
    // does not exist can never produce a false positive.
    return [base, ...linuxBindingAbis(resolvedLibc, arch).map((abi) => `${base}-${abi}`)];
  }
  if (platform === "win32") return [base, `${base}-msvc`];
  return [base];
}

/**
 * npm's `os`/`cpu` semantics, including the `!` negation form: an empty or absent list means "every
 * platform", a negated list excludes what it names, and a plain list is an allowlist.
 */
function platformListAllows(list, value) {
  if (!Array.isArray(list) || list.length === 0) return true;
  const entries = list.filter((item) => typeof item === "string");
  // npm evaluates BOTH halves of a mixed list: any matching negation rejects outright, and when
  // positive entries exist one of them must also match. Treating the presence of a negation as the
  // whole answer made `os: ["darwin", "!win32"]` allow Linux, which would classify a legitimately
  // foreign stub as host-installable (Codex thread 3780652044).
  if (entries.some((item) => item.startsWith("!") && item.slice(1) === value)) return false;
  const positive = entries.filter((item) => !item.startsWith("!"));
  return positive.length === 0 || positive.includes(value);
}

// Keyed by PATH, not a single bare cache. `assertStubsAreForeignOnly` takes `lockfilePath` as an
// injectable parameter, so an unkeyed cache would answer every later call from whichever file
// happened to be read first — the argument silently ignored, the result decided by call order.
// Production passes one path and would never notice; a fixture would (CodeRabbit thread
// 3780586007).
const lockfilePlatformScopes = new Map();

/**
 * The `os`/`cpu`/`libc` `package-lock.json` records for a name, or `undefined` if it pins no such
 * name.
 */
function lockfilePlatformScope(name, version, lockfilePath) {
  let scopes = lockfilePlatformScopes.get(lockfilePath);
  if (scopes === undefined) {
    scopes = new Map();
    const raw = existsSync(lockfilePath) ? JSON.parse(readFileSync(lockfilePath, "utf8")) : {};
    for (const [path, entry] of Object.entries(raw.packages ?? {})) {
      const identity = lockfileRecordIdentity(path, entry);
      if (identity.name === "" || identity.version === undefined) continue;
      // Keyed by name AND version (#3133). Keeping only the first record per NAME judged every
      // seeded version by the first one's scope: with two versions of one optional package under
      // different os/cpu, that accepts an inert host stub in one lockfile ordering and rejects a
      // legitimate foreign stub in the other, decided by nothing but which record came first.
      scopes.set(`${identity.name}@${identity.version}`, {
        cpu: entry.cpu,
        libc: entry.libc,
        os: entry.os,
      });
    }
    lockfilePlatformScopes.set(lockfilePath, scopes);
  }
  return scopes.get(`${name}@${version}`);
}

/**
 * A stub is legitimate ONLY for a package this host would never link. `package-lock.json` is what
 * says which those are, and it is more than the platform-suffix heuristic knows: it covers `cpu`
 * and `libc` as well as `os`, and it covers packages whose NAME carries no platform at all.
 *
 * `@napi-rs/canvas` is exactly that case. `keiko-local-knowledge` declares the parent package
 * itself optional and the lockfile records no `os`/`cpu` for it, so it installs everywhere — yet an
 * optional-fetch failure would stub it, `stubbedHostBindings` returns early on a stubbed parent,
 * and the lane would go green with no Canvas implementation at all, against the guarantee
 * ADR-0021 D7 makes (Codex thread 3780501190).
 *
 * A name the lockfile does not pin is not judged here: that is a closure defect, which the missing
 * list and `assertRegistryOnlyDescriptors` already govern, not a platform question.
 */
function currentHostPlatformScope() {
  return { arch: process.arch, libc: linuxLibc(), platform: process.platform };
}

function scopeInstallsOnHost(scope, host) {
  const libcAllows =
    scope.libc === undefined ||
    (host.libc !== undefined && platformListAllows(scope.libc, host.libc));
  return (
    platformListAllows(scope.os, host.platform) &&
    platformListAllows(scope.cpu, host.arch) &&
    libcAllows
  );
}

/** Whether the lockfile pins this name AND records no platform scope excluding the supplied host. */
export function lockfilePackageInstallsOnHost(
  name,
  version,
  lockfilePath,
  host = currentHostPlatformScope(),
) {
  const scope = lockfilePlatformScope(name, version, lockfilePath);
  if (scope === undefined) return false;
  return scopeInstallsOnHost(scope, host);
}

/** Whether the lockfile pins this exact name and version at all. */
export function lockfilePinsPackage(name, version, lockfilePath) {
  return lockfilePlatformScope(name, version, lockfilePath) !== undefined;
}

/** `name@version` pairs, comma-joined. Extracted so the failure messages stay unnested (S4624). */
function formatSpecifiers(entries) {
  return entries.map(({ name, version }) => `${name}@${version}`).join(", ");
}

export function assertStubsAreForeignOnly(
  seeded,
  lockfilePath = join(repoRoot, "package-lock.json"),
) {
  const stubs = [...seeded].flatMap(([name, versions]) =>
    [...versions.values()].filter(isStubEntry).map((entry) => ({ name, version: entry.version })),
  );
  const installsHere = stubs.filter(({ name, version }) =>
    lockfilePackageInstallsOnHost(name, version, lockfilePath),
  );
  if (installsHere.length > 0) {
    fail(
      `these packages install on this host but were seeded as inert stubs, so the Yarn arm would ` +
        `resolve them and link nothing: ` +
        `${formatSpecifiers(installsHere)} — run ` +
        `\`npm install\` before the installable-package smoke`,
    );
  }
  // A stub for a name+version the lockfile pins NOWHERE used to be waved through as "a closure
  // question, not a platform one" — but nothing else caught it either, so adding an optional
  // third-party dependency without regenerating the closure left the smoke green while Yarn linked
  // nothing. A stub is legitimate only when a lockfile record proves that exact version foreign.
  const unpinned = stubs.filter(
    ({ name, version }) => !lockfilePinsPackage(name, version, lockfilePath),
  );
  if (unpinned.length > 0) {
    fail(
      `these packages were seeded as inert stubs but package-lock.json pins no such version, so ` +
        `nothing proves them foreign to this host: ` +
        `${formatSpecifiers(unpinned)} — regenerate the ` +
        `vendored closure`,
    );
  }
}

export function assertHostBindingsAreReal(seeded) {
  const hostSuffixes = hostBindingSuffixes();
  const offenders = [...seeded.values()].flatMap((versions) =>
    [...versions.values()].flatMap((entry) => stubbedHostBindings(seeded, entry, hostSuffixes)),
  );
  if (offenders.length > 0) {
    fail(
      `this host's native bindings are not installed, so the Yarn arm would pass without them: ` +
        `${offenders.join(", ")} — run \`npm install\` before the installable-package smoke`,
    );
  }
}

/**
 * An entry seeded by an earlier pass wins — it was captured before `prepack` pruned the tree,
 * including entries restored from a previous PROCESS through the index. The one exception is a
 * cached STUB: once the real package is installed again it must supersede the placeholder, or the
 * lane would keep skipping a native binding that is now available.
 */
function shouldSeed(seeded, entry) {
  const existing = seeded.get(entry.name)?.get(entry.version);
  if (existing === undefined) return true;
  return isStubEntry(existing) && !isStubEntry(entry);
}

function seedEntry(seeded, entry, tarballPath) {
  const versions = seeded.get(entry.name) ?? new Map();
  versions.set(entry.version, {
    ...entry,
    tarballPath,
    integrity: tarballIntegrity(tarballPath),
  });
  seeded.set(entry.name, versions);
}

const SEED_INDEX_FILE = "seed-index.json";

/**
 * The seed has to survive across processes, not just across calls: CI runs this script twice and
 * the first run's `prepack` prunes the native optionals out of `node_modules`. A directory alone
 * is not enough — without an index the second process starts from an empty map, re-derives from
 * the pruned tree, and overwrites the real archives with stubs. The index is what makes the
 * pre-prune artifacts reusable (#3130).
 */
export function loadSeedIndex(destination) {
  const indexPath = join(destination, SEED_INDEX_FILE);
  if (!existsSync(indexPath)) return new Map();
  let raw;
  try {
    raw = JSON.parse(readFileSync(indexPath, "utf8"));
  } catch {
    // A malformed index is recoverable state, not a reason to fail a required gate: the closure is
    // simply re-packed from the tree. Failing here would turn an interrupted previous run into a
    // red build that no change to this checkout could fix.
    return new Map();
  }
  // A document that parses but is not an index object would throw on Object.entries outside the
  // try, defeating the recovery this function documents.
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return new Map();
  const seeded = new Map();
  for (const [name, versions] of Object.entries(raw)) {
    const restored = new Map();
    for (const [version, entry] of Object.entries(versions)) {
      // An indexed entry is only reused when its archive still exists, lives INSIDE this cache,
      // and still hashes to the integrity that was recorded for it. Anything else is dropped and
      // re-packed from the tree rather than served on trust.
      if (isReusableSeedEntry(destination, entry))
        restored.set(version, { ...entry, name, version });
    }
    if (restored.size > 0) seeded.set(name, restored);
  }
  return seeded;
}

function isReusableSeedEntry(destination, entry) {
  if (typeof entry?.tarballPath !== "string" || !existsSync(entry.tarballPath)) return false;
  // Containment: an index that points outside the cache could otherwise name any file on disk.
  const resolvedRoot = realpathSync(destination);
  const resolved = realpathSync(entry.tarballPath);
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${sep}`)) return false;
  return entry.integrity === tarballIntegrity(resolved);
}

/**
 * A stub for something this host would actually link. Judged by the same criterion
 * `assertStubsAreForeignOnly` rejects on — what `package-lock.json` scopes to this host — because
 * the two must not disagree. They did: this filter matched host-binding NAME SUFFIXES, so a
 * platform-agnostic parent like `@napi-rs/canvas` carried no suffix, was published to the shared
 * index, and the assertion below then rejected it — leaving an integrity-valid poisoned entry that
 * every later invocation reloaded and rejected again (Codex thread 3780652032).
 *
 * The lockfile criterion subsumes the suffix one: a host binding is scoped to this host by its own
 * `os`/`cpu`, so it is still caught, and a foreign binding is still shareable.
 */
function isNonDurableStub(name, entry, lockfilePath) {
  if (!isStubEntry(entry)) return false;
  // The UNION of both criteria, because neither covers the other. The lockfile answers for a pinned
  // package including a platform-agnostic parent, but says nothing about a name it does not pin;
  // the suffix answers for this host's own binding by name, whether pinned or not. Using only the
  // lockfile let an unpinned host-binding stub through, which the suffix rule had been catching.
  if (hostBindingSuffixes().some((suffix) => name.endsWith(suffix))) return true;
  return lockfilePackageInstallsOnHost(name, entry.version, lockfilePath);
}

export function writeSeedIndex(
  destination,
  seeded,
  lockfilePath = join(repoRoot, "package-lock.json"),
) {
  // Published by rename so a concurrent reader never sees a half-written file: two smoke commands
  // share this path within one checkout, and an interrupted write would otherwise leave malformed
  // JSON that the next invocation cannot parse.
  //
  // A stub for THIS HOST'S OWN binding is never persisted (Codex thread 3780203131). Two
  // invocations sharing this cache read the index before either publishes, so a process that
  // seeded AFTER a prune — where the native packages are gone and every binding stubs — would
  // otherwise publish the host's own binding as a stub with a matching integrity value. The other
  // process would read it, pass the integrity check precisely because the stub is intact, and run
  // the Yarn arm against a placeholder where the real binding belongs.
  //
  // FOREIGN-platform stubs must be persisted, and the first revision of this filter dropped them
  // too — which broke the CI sequence outright. There the seed is taken from the intact tree and
  // `prune:package-native-optionals` then deletes the native packages, so the second process can
  // no longer read `@napi-rs/canvas@1.0.2`'s manifest to learn that it declares
  // `canvas-android-arm64@1.0.2`: that stub is only derivable BEFORE the prune, and without it
  // Yarn 404s on a package the lockfile genuinely pins. A foreign stub is also not a poisoning
  // vector — it is the correct artifact for a platform no host here would link.
  //
  // Real archives are safe to share regardless: they are integrity-verified on read, so a replaced
  // or torn one is rejected and re-packed.
  const serializable = {};
  for (const [name, versions] of seeded) {
    const durable = [...versions].filter(
      ([, entry]) => !isNonDurableStub(name, entry, lockfilePath),
    );
    if (durable.length === 0) continue;
    serializable[name] = Object.fromEntries(
      durable.map(([version, entry]) => [
        version,
        { tarballPath: entry.tarballPath, integrity: entry.integrity, manifest: entry.manifest },
      ]),
    );
  }
  const target = join(destination, SEED_INDEX_FILE);
  const staging = `${target}.${String(process.pid)}.tmp`;
  writeFileSync(staging, `${JSON.stringify(serializable, null, 2)}\n`);
  renameSync(staging, target);
}

export function seedVendoredRegistry(
  destination,
  modulesRoot = join(repoRoot, "node_modules"),
  manifest = rootPackageJson,
  seeded = loadSeedIndex(destination),
) {
  // One lockfile answers every question in this function: which copies the closure selects, and
  // which stubs a platform scope proves foreign. Letting the closure read the fixture's lockfile
  // while the stub assertions read the repository's would judge one tree by another's pins.
  const lockfilePath = join(dirname(modulesRoot), "package-lock.json");
  const { packages, stubs, missing } = resolveVendorClosure(
    modulesRoot,
    manifest,
    repoRoot,
    lockfilePath,
  );
  // A name already restored from the index was captured from an intact tree by an earlier process;
  // its absence now is `prepack`'s pruning, not a broken checkout. Likewise a stub must never
  // replace a real archive we already hold.
  const restored = (name) => seeded.has(name);
  const genuinelyMissing = missing.filter((name) => !restored(name));
  const neededStubs = stubs.filter((entry) => !restored(entry.name));
  if (genuinelyMissing.length > 0) {
    fail(
      `vendored dependency closure is not installed: ${genuinelyMissing.join(", ")} — ` +
        `run \`npm install\` before the installable-package smoke`,
    );
  }
  const pending = [
    ...packages.map((entry) => ({ entry, pack: packVendoredPackage })),
    ...neededStubs.map((entry) => ({
      entry: { ...entry, manifest: stubManifest(entry.name, entry.version) },
      pack: packStubPackage,
    })),
  ];
  for (const { entry, pack } of pending) {
    if (shouldSeed(seeded, entry)) seedEntry(seeded, entry, pack(entry, destination));
  }
  writeSeedIndex(destination, seeded, lockfilePath);
  assertHostBindingsAreReal(seeded);
  // Broader than the check above and derived from a different source: that one asks whether the
  // host's own BINDING resolved to a stub, from the running platform triple; this one asks whether
  // ANY package the lockfile installs here did, including a platform-agnostic parent like
  // `@napi-rs/canvas` whose name carries no platform to match on.
  assertStubsAreForeignOnly(seeded, lockfilePath);
  return seeded;
}

function tarballIntegrity(tarballPath) {
  return `sha512-${createHash("sha512").update(readFileSync(tarballPath)).digest("base64")}`;
}

function rootTarballPath(name, version) {
  return `${name}/-/${name.split("/").at(-1)}-${version}.tgz`;
}

function seededTarball(seeded, requested) {
  for (const [name, versions] of seeded) {
    if (!requested.startsWith(`${name}/-/`)) continue;
    return [...versions.values()].find(
      (entry) => requested === `${name}/-/${tarballFileName(name, entry.version)}`,
    );
  }
  return undefined;
}

function tarballFileName(name, version) {
  return `${name.split("/").at(-1)}-${version}.tgz`;
}

function releaseSegments(version) {
  const [core = ""] = version.split("+");
  const [release = "", ...prerelease] = core.split("-");
  return {
    numbers: release.split(".").map((part) => Number.parseInt(part, 10) || 0),
    prerelease: prerelease.join("-"),
  };
}

function compareIdentifier(left, right) {
  const [numericLeft, numericRight] = [/^\d+$/u.test(left), /^\d+$/u.test(right)];
  if (numericLeft && numericRight) {
    return Number.parseInt(left, 10) - Number.parseInt(right, 10);
  }
  // SemVer §11: numeric identifiers always rank below alphanumeric ones.
  if (numericLeft !== numericRight) return numericLeft ? -1 : 1;
  return compareStrings(left, right);
}

function comparePrereleaseIdentifiers(left, right) {
  // SemVer §11: a version WITH a prerelease ranks below the same version without one.
  if (left === right) return 0;
  if (left === "") return 1;
  if (right === "") return -1;
  const leftParts = left.split(".");
  const rightParts = right.split(".");
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const [a, b] = [leftParts[index], rightParts[index]];
    if (a === undefined || b === undefined) return a === undefined ? -1 : 1;
    const difference = compareIdentifier(a, b);
    if (difference !== 0) return difference;
  }
  return 0;
}

function compareVersions(left, right) {
  const [a, b] = [releaseSegments(left), releaseSegments(right)];
  for (let index = 0; index < Math.max(a.numbers.length, b.numbers.length); index += 1) {
    const difference = (a.numbers[index] ?? 0) - (b.numbers[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return comparePrereleaseIdentifiers(a.prerelease, b.prerelease);
}

// An ALLOWLIST, not a denylist. A denylist of bad protocols is wrong by construction: it was
// missing `ssh:` and `ssh+git:` — which Yarn's Git resolver accepts and whose error output echoes
// the full descriptor, credentials included — and the next protocol would have slipped through the
// same way. Only a registry descriptor is acceptable here: no protocol at all (a semver range, a
// tag, `*`), or an explicit `npm:` alias. Everything else resolves outside the loopback registry
// and is refused before Yarn starts (#3130).
const REGISTRY_PROTOCOL = /^npm:/iu;
const HAS_PROTOCOL = /^[a-z][a-z0-9+.-]*:/iu;
// Yarn also accepts a colon-less forge shorthand (`owner/repo`, `owner/repo#semver:^1.0.0`), which
// it fetches straight from GitHub. A leading `@` is excluded so a scoped package name is not
// mistaken for one.
const FORGE_SHORTHAND = /^[^@\s/][^\s/]*\/[^\s/]+$/u;

/** A descriptor's shape, never its value: the value may carry a token or a private endpoint. */
function descriptorClass(range) {
  const protocol = /^([a-z][a-z0-9+.-]*):/iu.exec(range)?.[1];
  if (protocol !== undefined) return `${protocol.toLowerCase()}:`;
  return FORGE_SHORTHAND.test(range) ? "forge-shorthand" : "unknown";
}

function isNonRegistryDescriptor(range) {
  if (HAS_PROTOCOL.test(range)) return !REGISTRY_PROTOCOL.test(range);
  return FORGE_SHORTHAND.test(range);
}

function manifestProtocolOffenders(name, entry) {
  return ["dependencies", "optionalDependencies", "peerDependencies"]
    .flatMap((group) => Object.entries(entry.manifest?.[group] ?? {}))
    .filter(([, range]) => typeof range === "string" && isNonRegistryDescriptor(range))
    .map(
      // The descriptor VALUE never reaches the log: `git+https://token@host/pkg.git` would carry a
      // credential into a required gate's output. Only the owning package, the dependency name and
      // the descriptor's shape are reported, per the repository's body-free evidence rule.
      ([dependency, range]) =>
        `${name}@${entry.version} -> ${dependency} (${descriptorClass(range)})`,
    );
}

/**
 * `stage-publish-package.mjs` writes exactly one vendor shape — its `archivePath` is built as
 * `vendor/${archiveName}`, so the descriptor is always `file:vendor/<archive>.tgz`: one segment
 * directly under the staged `vendor/` directory. Matching that shape rather than the `file:vendor/`
 * PREFIX is the point. A prefix test also accepts `file:vendor/../../ambient-package`, which Yarn
 * resolves straight from the filesystem and therefore outside the loopback registry — the exact
 * hermeticity this check exists to enforce (KfQ thread 3780151719).
 */
export function isStagedVendorArchive(range) {
  const archive = /^file:vendor[/\\]([^/\\]+)$/u.exec(range)?.[1];
  return archive !== undefined && archive !== ".." && archive.endsWith(".tgz");
}

/**
 * The staged root's own non-bundled dependencies are checked too: a `git+https:` or tarball-URL
 * descriptor there would be resolved by Yarn outside the loopback registry just as surely as one
 * in a seeded manifest. The staged vendor archives are the intentional exception — that is how
 * `stage-publish-package.mjs` points at the tarball-local private workspaces (ADR-0021 / #3101),
 * and they never leave the installed package.
 */
export function assertStagedRootDescriptors(manifest) {
  const offenders = ["dependencies", "optionalDependencies"]
    .flatMap((group) => Object.entries(manifest?.[group] ?? {}))
    .filter(([, range]) => typeof range === "string")
    .filter(([, range]) => !isStagedVendorArchive(range))
    .filter(([, range]) => isNonRegistryDescriptor(range))
    .map(([dependency, range]) => `${dependency} (${descriptorClass(range)})`);
  if (offenders.length > 0) {
    fail(
      `staged root declares non-registry dependency protocols outside its vendor archives: ` +
        `${offenders.join(", ")}`,
    );
  }
}

/**
 * A bundled workspace ships inside the tarball, but its own third-party dependencies do not — the
 * consumer's package manager resolves those. A workspace declaring one through `git+https:`, an
 * HTTP tarball or `file:` keeps that raw descriptor in its archive, and Yarn would process it
 * outside the loopback registry: the same hermeticity hole the other two validators close, on the
 * one manifest surface neither of them reads (#3133).
 */
export function assertStagedBundledDescriptors(bundledManifests) {
  const offenders = (bundledManifests ?? []).flatMap((manifest) =>
    ["dependencies", "optionalDependencies"]
      .flatMap((group) => Object.entries(manifest?.[group] ?? {}))
      .filter(([, range]) => typeof range === "string")
      .filter(([, range]) => !isStagedVendorArchive(range))
      .filter(([, range]) => isNonRegistryDescriptor(range))
      .map(([dependency, range]) => `${manifest.name}/${dependency} (${descriptorClass(range)})`),
  );
  if (offenders.length > 0) {
    fail(
      `staged bundled workspaces declare non-registry dependency protocols, which would resolve ` +
        `outside the offline registry: ${offenders.join(", ")}`,
    );
  }
}

export function assertRegistryOnlyDescriptors(seeded) {
  const offenders = [...seeded].flatMap(([name, versions]) =>
    [...versions.values()].flatMap((entry) => manifestProtocolOffenders(name, entry)),
  );
  if (offenders.length > 0) {
    fail(
      `vendored closure declares non-registry dependency protocols, which would resolve outside ` +
        `the offline registry: ${offenders.join(", ")}`,
    );
  }
}

function vendoredPackument(name, versions, registryUrl) {
  const sorted = [...versions.values()].sort((left, right) =>
    compareVersions(left.version, right.version),
  );
  const entries = {};
  for (const entry of sorted) {
    // Optional edges are preserved so the running platform's real native binding still installs
    // and is still proven; the foreign-platform prebuilds resolve to inert stubs instead (#3130).
    entries[entry.version] = {
      ...entry.manifest,
      dist: {
        integrity: entry.integrity,
        tarball: `${registryUrl}/${name}/-/${tarballFileName(name, entry.version)}`,
      },
    };
  }
  return {
    name,
    "dist-tags": { latest: sorted.at(-1)?.version },
    versions: entries,
  };
}

function localRegistryHandler(artifact, tarballBytes, registryUrl, requests, vendored) {
  const packument = registryPackument(registryUrl, artifact, tarballBytes);
  const seeded = vendored ?? new Map();
  return (request, response) => {
    const pathname = new URL(request.url ?? "/", registryUrl).pathname;
    requests.push(pathname);
    // Decoding is REQUIRED, not incidental: npm encodes the scope separator, so a scoped package
    // arrives as `@oscharko-dev%2fkeiko/-/keiko-0.3.7.tgz` and every comparison below is written
    // against the decoded form. It is also the one call here that can throw — `new URL()` passes
    // `%zz` through untouched and `decodeURIComponent` raises `URIError` on it. Unhandled inside an
    // http handler that is an uncaught exception: the registry dies mid-install and the gate
    // reports a crash instead of a verdict (KfQ thread 3780494646). Answer it as the bad request
    // it is and keep serving.
    let requested;
    try {
      requested = decodeURIComponent(pathname.slice(1));
    } catch {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "malformed request path" }));
      return;
    }
    // Classified by the registry's ARCHIVE ROUTE shape, `<name>/-/<file>.tgz`, not by the
    // extension alone. `foo.tgz` and `@scope/foo.tgz` are valid npm package names, so a packument
    // request for one ends in `.tgz` without being an archive request — the extension test alone
    // would route it here and 404 a package the registry holds (Codex thread 3780358326). Both
    // serving paths below already require the `/-/` segment, so narrowing the branch to it can
    // serve nothing less than before.
    if (requested.includes("/-/") && pathname.endsWith(".tgz")) {
      if (requested === rootTarballPath(rootPackageJson.name, rootVersion)) {
        response.writeHead(200, { "content-type": "application/octet-stream" });
        response.end(tarballBytes);
        return;
      }
      const served = seededTarball(seeded, requested);
      if (served === undefined) {
        // An unseeded or wrong-version tarball is never answered with the root artifact: serving
        // real bytes under a foreign name would be a silent substitution, not a hermetic registry.
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "not_found" }));
        return;
      }
      response.writeHead(200, { "content-type": "application/octet-stream" });
      const stream = createReadStream(served.tarballPath);
      // An unhandled stream error would take the registry — and with it the gate — down with an
      // opaque crash; destroying the response instead surfaces as a failed fetch Yarn can report.
      stream.on("error", () => response.destroy());
      // `pipe()` only unpipes and pauses the source when the destination goes away, leaving its
      // descriptor open, so an aborted download would accumulate descriptors until EMFILE.
      response.on("close", () => stream.destroy());
      stream.pipe(response);
      return;
    }
    // Exact match only. A registry should answer for the name it was asked for and nothing else;
    // case-folding here would serve the root packument under a name npm would treat as different.
    if (requested === rootPackageJson.name) {
      response.writeHead(200, { "content-type": "application/vnd.npm.install-v1+json" });
      response.end(JSON.stringify(packument));
      return;
    }
    const vendoredVersions = seeded.get(requested);
    if (vendoredVersions !== undefined) {
      response.writeHead(200, { "content-type": "application/vnd.npm.install-v1+json" });
      response.end(JSON.stringify(vendoredPackument(requested, vendoredVersions, registryUrl)));
      return;
    }
    // A 404 here is the hermeticity guarantee, not an oversight: the install may only see packages
    // this repository already pins. An unexpected request fails the gate loudly instead of silently
    // reaching the public registry (#3130).
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "not_found" }));
  };
}

export async function startLocalRegistry(artifact, vendored) {
  const tarballBytes = readFileSync(artifact.tarballPath);
  const requests = [];
  let handler;
  const server = createHttpServer((request, response) => {
    if (handler === undefined) {
      response.writeHead(503);
      response.end();
      return;
    }
    handler(request, response);
  });
  await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("local package registry did not bind a TCP port");
  }
  const registryUrl = `http://127.0.0.1:${String(address.port)}`;
  handler = localRegistryHandler(artifact, tarballBytes, registryUrl, requests, vendored);
  try {
    const health = await globalThis.fetch(
      `${registryUrl}/${encodeURIComponent(rootPackageJson.name)}`,
    );
    if (!health.ok) {
      throw new Error(
        `local package registry failed its packument health check (HTTP ${String(health.status)})`,
      );
    }
  } catch (error) {
    await new Promise((resolvePromise) => server.close(resolvePromise));
    throw error;
  }
  return {
    registryUrl,
    requests,
    close: () => new Promise((resolvePromise) => server.close(resolvePromise)),
  };
}

/**
 * Yarn reads `YARN_*` environment variables at a HIGHER precedence than `.yarnrc.yml`, so an
 * ambient `YARN_NPM_REGISTRY_SERVER` on a runner or developer machine would silently send this
 * install back to a live registry and past the fail-closed 404s. Registry-affecting variables are
 * therefore dropped and the loopback server is re-asserted through the environment as well (#3130).
 */
/**
 * Yarn reads `.yarnrc.yml` from the home directory and from every ancestor of the project, so
 * sanitizing environment variables alone leaves an ambient rc able to switch on hardened mode,
 * register plugins, or inject `packageExtensions` inside a gate that claims to be hermetic. The
 * child therefore gets a private, empty home; provisioning uses the same one so both agree on
 * Corepack's cache location (#3130).
 */
/**
 * Corepack caches package managers under `COREPACK_HOME`, which defaults to a path inside `HOME`.
 * Since the child gets a private, empty home for rc isolation, leaving the cache to follow it would
 * make every run download Yarn afresh — turning an occasional network dependency into a per-run
 * one. The cache therefore lives at a stable path of its own, keyed by the pinned version and
 * reviewed digest so a bump or digest correction does not reuse the previous tool (#3130/#3134).
 */
export function corepackCacheDir(locator = PINNED_YARN) {
  // This directory holds an EXECUTABLE that Corepack will run, so it gets the same fail-closed
  // validation as the vendor seed cache — and it needs it more. A predictable path on a shared
  // POSIX host is pre-creatable by another account, and Corepack trusts a `.corepack` metadata
  // file it finds there and executes the binary it names, networking disabled or not. The uid is
  // part of the name so two accounts never contend for one path in the first place.
  const owner = process.getuid === undefined ? "win" : String(process.getuid());
  const { version, sha512 } = yarnLocatorParts(locator);
  const dir = join(tmpdir(), `keiko-corepack-${PINNED_YARN_NAME}-${version}-${sha512}-${owner}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  assertPrivateDirectory(dir);
  return dir;
}

export function privateYarnHome() {
  const home = mkdtempSync(join(tmpdir(), "keiko-yarn-home-"));
  return home;
}

/**
 * A private, unpredictable rc filename for the throwaway project.
 *
 * Yarn merges `.yarnrc.yml` from EVERY ancestor of the project, not only from the project and the
 * home directory — and the project lives directly under `os.tmpdir()`, which is world-writable on
 * Linux. A planted `/tmp/.yarnrc.yml` therefore reaches this install and can add plugins,
 * `packageExtensions` or network settings to the gate whose entire purpose is hermeticity. The
 * private home closed the `~/.yarnrc.yml` half of the problem and left this half open; proved by
 * planting a probe at the tmpdir root, which failed the install on an unrecognized setting
 * (Codex thread 3780424132).
 *
 * Naming the file per run closes it: Yarn walks the ancestors looking for THIS name, and nothing
 * up the tree carries it. The `YARN_*` settings the gate depends on are re-asserted through the
 * environment as well, which outranks any rc file — this protects the settings it does NOT pin,
 * `plugins` above all, since a plugin is executable code.
 */
export const YARN_RC_FILENAME = `.yarnrc-keiko-${randomBytes(9).toString("hex")}.yml`;

function yarnUnsafeHttpWhitelist(registryUrl) {
  try {
    const url = new URL(registryUrl);
    if (url.protocol !== "http:") return "127.0.0.1";
    if (url.hostname === "[::1]") return "::1";
    if (url.hostname === "localhost" || url.hostname === "127.0.0.1") return url.hostname;
  } catch {
    return "127.0.0.1";
  }
  return "127.0.0.1";
}

export function yarnChildEnv(
  registryUrl,
  baseEnv = process.env,
  home = undefined,
  locator = PINNED_YARN,
) {
  // Every `YARN_*` variable is dropped, not a curated subset: Yarn maps each of its settings to
  // one, and an ambient `YARN_NODE_LINKER=pnp` or `YARN_RC_FILENAME` would change the install
  // shape just as surely as a registry override. The gate then re-asserts only what it needs, so
  // its outcome cannot depend on the machine it runs on (#3130).
  // `COREPACK_*` is stripped for the same reason as `YARN_*`: `COREPACK_ENABLE_PROJECT_SPEC=0`
  // makes Corepack ignore the project's `packageManager` field and run its system-wide Yarn, so
  // the gate would exercise an unreviewed version despite the pin.
  const env = Object.fromEntries(
    Object.entries(baseEnv).filter(([key]) => !/^(?:YARN_|COREPACK_)/u.test(key)),
  );
  return {
    ...env,
    // A private home keeps an ambient `~/.yarnrc.yml` out of this install entirely.
    ...(home === undefined ? {} : { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home }),
    // Explicit, so the cache does not follow the private home and vanish between runs.
    COREPACK_HOME: corepackCacheDir(locator),
    COREPACK_ENABLE_PROJECT_SPEC: "1",
    YARN_ENABLE_GLOBAL_CACHE: "false",
    YARN_ENABLE_TELEMETRY: "false",
    YARN_NODE_LINKER: "node-modules",
    YARN_NPM_REGISTRY_SERVER: registryUrl,
    // Points Yarn at the private rc name above, so the ancestor walk finds only our own file.
    YARN_RC_FILENAME,
    YARN_UNSAFE_HTTP_WHITELIST: yarnUnsafeHttpWhitelist(registryUrl),
    // Corepack must not reach repo.yarnpkg.com during the install: the pinned tool is provisioned
    // beforehand, so an outage there cannot fail a gate that claims to resolve offline (#3130).
    COREPACK_ENABLE_NETWORK: "0",
  };
}

/**
 * Downloads the pinned Yarn into Corepack's cache if it is not there yet. This is the one network
 * call the smoke may still make, and it is tool provisioning rather than dependency resolution:
 * it happens before the install, its failure names Corepack explicitly, and the install itself
 * then runs with `COREPACK_ENABLE_NETWORK=0`.
 *
 * `--cache-only` matters: a plain `--global` install would make this version Corepack's system-wide
 * default and change unrelated invocations on a developer machine or shared runner. A gate must not
 * mutate the environment it runs in; the throwaway project's own `packageManager` field is what
 * selects Yarn here.
 */
/**
 * Setup entry point: caches the pinned Yarn AND seeds the vendored registry, both before any step
 * that mutates the installed tree. `prune:package-native-optionals` runs ahead of the smoke in the
 * `core-quality` job, so a seed created afterwards would hold stubs where the real native packages
 * belong — the same defect the two-invocation ordering had, in a different job. Seeding here makes
 * the fixture independent of where the prune sits in any given lane (#3130).
 */
export async function prepareOfflineSmokeForSetup() {
  await provisionPinnedYarnForSetup();
  const destination = persistentVendorSeedDir();
  const seeded = seedVendoredRegistry(destination);
  console.log(
    `prepare-offline-smoke: seeded ${String(seeded.size)} package name(s) into ${destination}.`,
  );
}

/** Caches the pinned Yarn, so no gate has to reach the package-manager host mid-run. */
export async function provisionPinnedYarnForSetup(
  locator = PINNED_YARN,
  timeoutMs = npmInstallTimeoutMs(),
) {
  const provisioned = await withCorepackYarnCacheLock(
    locator,
    () => provisionPinnedYarnUnlocked(undefined, undefined, locator, timeoutMs),
    timeoutMs,
  );
  if (provisioned) {
    console.log(`provision-pinned-yarn: ${yarnLocatorLogSummary(locator)} cached.`);
  }
}

export function isPinnedYarnCached(locator = PINNED_YARN) {
  const entry = pinnedYarnCacheEntryDir(locator);
  const { sha512 } = yarnLocatorParts(locator);
  return (
    cachedCorepackMetadataMatchesLocator(join(entry, ".corepack"), locator) &&
    fileSha512Matches(join(entry, "yarn.js"), sha512)
  );
}

function repairPinnedYarnCacheMetadata(locator) {
  const entry = pinnedYarnCacheEntryDir(locator);
  const { version, sha512 } = yarnLocatorParts(locator);
  if (!fileSha512Matches(join(entry, "yarn.js"), sha512)) return false;
  writeFileSync(
    join(entry, ".corepack"),
    JSON.stringify({
      bin: ["yarn", "yarnpkg"],
      hash: `sha512.${sha512}`,
      locator: { name: PINNED_YARN_NAME, reference: `${version}+sha512.${sha512}` },
    }),
    "utf8",
  );
  return cachedCorepackMetadataMatchesLocator(join(entry, ".corepack"), locator);
}

function pinnedYarnCacheEntryDir(locator) {
  return join(corepackCacheDir(locator), "v1", PINNED_YARN_NAME, yarnLocatorParts(locator).version);
}

function cachedCorepackMetadataMatchesLocator(path, locator) {
  const { version, sha512 } = yarnLocatorParts(locator);
  const metadata = readJsonFileIfPresent(path);
  if (!isRecord(metadata) || !isRecord(metadata.locator) || !Array.isArray(metadata.bin)) {
    return false;
  }
  const reference = metadata.locator.reference;
  return (
    metadata.locator.name === PINNED_YARN_NAME &&
    (reference === version || reference === `${version}+sha512.${sha512}`) &&
    metadata.hash === `sha512.${sha512}` &&
    metadata.bin.includes("yarn") &&
    metadata.bin.includes("yarnpkg")
  );
}

function readJsonFileIfPresent(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError || error?.code === "ENOENT" || error?.code === "ENOTDIR") {
      return undefined;
    }
    throw error;
  }
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fileSha512Matches(path, expectedSha512) {
  try {
    return (
      statSync(path).isFile() &&
      createHash("sha512").update(readFileSync(path)).digest("hex") === expectedSha512
    );
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return false;
    throw error;
  }
}

function provisionPinnedYarnUnlocked(
  registryUrl,
  home,
  locator = PINNED_YARN,
  timeoutMs = npmInstallTimeoutMs(),
) {
  // Already cached from an earlier run or a CI setup step: no network call at all. That keeps an
  // outage at the package-manager host from failing a gate whose dependency install is offline.
  if (isPinnedYarnCached(locator) || repairPinnedYarnCacheMetadata(locator)) {
    console.log(`provision-pinned-yarn: ${yarnLocatorLogSummary(locator)} already cached.`);
    return false;
  }
  rmSync(pinnedYarnCacheEntryDir(locator), { recursive: true, force: true });
  // Provisioning must see the SAME sanitized environment as the install, or `COREPACK_HOME` is
  // honoured here and stripped there — Corepack would then cache the tool in one place and search
  // another with networking already disabled. Only the network flag differs.
  const env = {
    ...yarnChildEnv(registryUrl, process.env, home, locator),
    COREPACK_ENABLE_NETWORK: "1",
  };
  const provisionArgs = ["install", "--global", "--cache-only", locator];
  const result = runResult("corepack", provisionArgs, {
    timeout: timeoutMs,
    env,
  });
  if (result.error !== undefined) {
    throw smokeGateFailure(
      `corepack could not provision ${yarnLocatorLogSummary(locator)} before the offline install ` +
        `(${corepackSpawnFailureSetupSummary(result.error, timeoutMs)}) - re-run ` +
        "`npm run provision:smoke` on a host with Corepack available",
    );
  }
  if (result.status !== 0) {
    // The other children in this gate run against the local tree or the loopback registry, so
    // their stderr is echoed verbatim, as every sibling smoke gate does — that is what makes them
    // debuggable. Corepack is the one child that contacts a remote host, so it is the one whose
    // output can carry an endpoint, a proxy URL, or the credentials embedded in one. It is
    // therefore classified rather than quoted (KfQ thread 3780151718).
    throw smokeGateFailure(
      `corepack could not provision ${yarnLocatorLogSummary(locator)} before the offline install ` +
        `(exit ${String(result.status)}, ${classifyProvisionFailure(result)}) — re-run ` +
        `\`npm run provision:smoke\` on a host with network access to populate the cache`,
    );
  }
  if (!isPinnedYarnCached(locator)) {
    throw smokeGateFailure(
      `corepack cached ${yarnLocatorLogSummary(locator)}, ` +
        "but the cached Yarn bytes did not match pinned integrity.",
    );
  }
  return true;
}

// Matched against the failed downloader's output to route the failure. Only the right-hand label
// is ever emitted; the text that matched never is.
const PROVISION_FAILURE_CLASSES = [
  {
    pattern: /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH/u,
    label: "the host was unreachable",
  },
  {
    pattern: /\bEINTEGRITY\b|checksum|hash mismatch|\bMismatch hashes\b/iu,
    label: "the archive failed its integrity check",
  },
  {
    pattern: /\b40[13]\b|unauthorized|forbidden|authentication/iu,
    label: "the request was rejected as unauthorized",
  },
  { pattern: /\b404\b|not found/iu, label: "the requested version was not found" },
];

export function classifyProvisionFailure(result) {
  if (result.signal !== null && result.signal !== undefined) return "terminated after the timeout";
  const combined = `${result.stderr ?? ""}\n${result.stdout ?? ""}`;
  const matched = PROVISION_FAILURE_CLASSES.find((entry) => entry.pattern.test(combined));
  return matched === undefined ? "the failure matched no known class" : matched.label;
}

function writeYarnConfiguration(tmp, registryUrl) {
  const architectureLines = Object.entries(supportedArchitectures()).flatMap(([key, values]) => [
    `  ${key}:`,
    ...values.map((value) => `    - ${value}`),
  ]);
  const lines = [
    "nodeLinker: node-modules",
    "enableGlobalCache: false",
    "enableTelemetry: false",
    "globalFolder: .yarn/global",
    "cacheFolder: .yarn/cache",
    `npmRegistryServer: ${registryUrl}`,
    "npmScopes:",
    "  oscharko-dev:",
    `    npmRegistryServer: ${registryUrl}`,
    "supportedArchitectures:",
    ...architectureLines,
    "unsafeHttpWhitelist:",
    `  - ${JSON.stringify(yarnUnsafeHttpWhitelist(registryUrl))}`,
  ];
  writeFileSync(join(tmp, YARN_RC_FILENAME), `${lines.join("\n")}\n`);
}

function writeYarnInstallManifest(tmp, locator) {
  writeFileSync(
    join(tmp, "package.json"),
    `${JSON.stringify(
      {
        private: true,
        type: "module",
        packageManager: yarnPackageManagerFromSmokeLocator(locator),
        dependencies: { [rootPackageJson.name]: rootVersion },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

async function runLockedYarnInstall(tmp, registryUrl, yarnHome, locator) {
  const timeoutMs = npmInstallTimeoutMs();
  return await withCorepackYarnCacheLock(
    locator,
    async () => {
      await provisionPinnedYarnForSetup(locator, timeoutMs);
      return await runAsync(
        "corepack",
        ["yarn", "install", "--no-immutable", "--mode=skip-build"],
        {
          cwd: tmp,
          timeout: timeoutMs,
          env: yarnChildEnv(registryUrl, process.env, yarnHome, locator),
        },
      );
    },
    timeoutMs,
  );
}

function yarnInstallOutcome(result) {
  if (result.outputLimitExceeded === true) return "exceeded output limit";
  if (result.timedOut === true) return "timed out";
  return `exited ${String(result.status)}`;
}

function assertYarnInstallResult(result, registry) {
  if (result.timedOut !== true && result.error === undefined && result.status === 0) return;
  const outcome = yarnInstallOutcome(result);
  const detail =
    result.error === undefined
      ? childOutputByteSummary(result)
      : `error=${result.error.message}; ${childOutputByteSummary(result)}`;
  fail(
    `Yarn registry install ${outcome} ` +
      `(signal=${String(result.signal)}; registry=${registry.registryUrl}; ` +
      `requests=${registry.requests.join(",")}; ${detail})`,
  );
}

export async function installIntoWithYarn(tmp, artifact, vendored, locator = PINNED_YARN) {
  assertRegistryOnlyDescriptors(vendored ?? new Map());
  assertStagedRootDescriptors(artifact.manifest);
  assertStagedBundledDescriptors(artifact.bundledManifests);
  const registry = await startLocalRegistry(artifact, vendored);
  const yarnHome = privateYarnHome();
  writeYarnInstallManifest(tmp, locator);
  rmSync(join(tmp, "yarn.lock"), { force: true });
  // `npmRegistryServer` is set GLOBALLY, not only for the `oscharko-dev` scope (#3130): every
  // package this install resolves must come from the local registry, which serves the packed root
  // plus the repository-pinned third-party closure and 404s everything else. Scoping it made the
  // gate depend on live npm for the transitive graph, so an unrelated upstream publish could — and
  // did — turn every Keiko pull request red.
  writeYarnConfiguration(tmp, registry.registryUrl);
  let installResult;
  let setupFailure;
  try {
    try {
      installResult = await runLockedYarnInstall(tmp, registry.registryUrl, yarnHome, locator);
    } catch (error) {
      if (!isSmokeGateFailure(error)) throw error;
      setupFailure = error;
    }
  } finally {
    await registry.close();
    rmSync(yarnHome, { recursive: true, force: true });
  }
  if (setupFailure !== undefined) {
    fail(setupFailure.message);
  }
  assertYarnInstallResult(installResult, registry);
}

function assertCliExecutable(tmp) {
  const cliEntry = join(tmp, "node_modules", "@oscharko-dev", "keiko", "dist", "cli", "index.js");
  if (!existsSync(cliEntry)) {
    fail(`installed tarball missing CLI entry at ${cliEntry}`);
  }
  // The POSIX executable bit is meaningless on Windows: NTFS has no `0o111`, Node's statSync reports
  // a fixed `100666`, and executability is determined by file extension / PATHEXT. The CLI's *actual*
  // runnability is verified cross-platform by assertCliVersionAndHelp (it runs `node <bin> --version`
  // / `--help`). Only enforce the exec bit on the platforms where it is a real concept.
  if (process.platform !== "win32") {
    const mode = statSync(cliEntry).mode;
    if ((mode & 0o111) === 0) {
      fail(`installed CLI entry ${cliEntry} is not executable (mode ${mode.toString(8)})`);
    }
  }
}

export function assertVendoredPayload(tmp) {
  const dependencyRoot = join(tmp, "node_modules");
  for (const name of runtimeWorkspaces) {
    const shortName = name.replace(/^@oscharko-dev\//, "");
    const candidates = [
      join(dependencyRoot, "@oscharko-dev", shortName, "dist"),
      join(
        dependencyRoot,
        "@oscharko-dev",
        "keiko",
        "node_modules",
        "@oscharko-dev",
        shortName,
        "dist",
      ),
    ];
    const dist = candidates.find((candidate) => existsSync(candidate));
    if (dist === undefined) {
      fail(`vendored runtime dependency missing: ${candidates.join(" or ")}`);
    }
    const entries = readdirSync(dist);
    if (entries.length === 0) {
      fail(`vendored runtime dependency empty: ${dist}`);
    }
  }
}

export function assertProductiveTypeScriptRuntime(tmp) {
  const manifest = join(tmp, "node_modules", "typescript", "package.json");
  if (!existsSync(manifest)) {
    fail(`productive TypeScript runtime dependency missing: ${manifest}`);
  }
}

function assertCliVersionAndHelp(tmp) {
  // Resolve the installed CLI entry directly rather than the `node_modules/.bin/keiko` symlink so
  // the gate does not depend on npm's per-platform `.bin` shim shape (Copilot review on #169).
  const bin = join(tmp, "node_modules", "@oscharko-dev", "keiko", "dist", "cli", "index.js");
  const versionResult = run("node", [bin, "--version"], { cwd: tmp });
  if (versionResult.status !== 0) {
    fail(`keiko --version exited ${String(versionResult.status)}: ${versionResult.stderr}`);
  }
  if (!versionResult.stdout.includes(rootVersion)) {
    fail(`keiko --version stdout did not include ${rootVersion}: ${versionResult.stdout}`);
  }
  const helpResult = run("node", [bin, "--help"], { cwd: tmp });
  if (helpResult.status !== 0) {
    fail(`keiko --help exited ${String(helpResult.status)}: ${helpResult.stderr}`);
  }
}

async function assertInstalledRootRuntimeSurface(tmp) {
  try {
    const moduleUrl = pathToFileURL(
      join(tmp, "node_modules", "@oscharko-dev", "keiko", "dist", "index.js"),
    ).href;
    const mod = await import(moduleUrl);
    const runtimeExports = Object.keys(mod).sort((a, b) => a.localeCompare(b));
    const diff = diffExpectedExports(runtimeExports, rootPackageSurfaceContract.runtimeExports);
    if (diff.missing.length > 0 || diff.unexpected.length > 0) {
      fail(
        "installed root runtime contract drifted " +
          `(missing ${String(diff.missing.length)}, unexpected ${String(diff.unexpected.length)}).`,
      );
    }
  } catch (error) {
    fail(`installed root import failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function assertInstalledRootTypeSurface(tmp) {
  const typeExports = collectConsumerVisibleTypeExports("@oscharko-dev/keiko", tmp);
  const diff = diffExpectedExports(typeExports, rootPackageSurfaceContract.declarationExports);
  if (diff.missing.length > 0 || diff.unexpected.length > 0) {
    fail(
      "installed root declaration contract drifted " +
        `(missing ${String(diff.missing.length)}, unexpected ${String(diff.unexpected.length)}).`,
    );
  }
}

async function reserveUiPort() {
  return await new Promise((resolvePort, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("could not reserve a loopback TCP port for keiko ui"));
        return;
      }
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolvePort(address.port);
      });
    });
  });
}

async function waitForHealth(baseUrl, child, stdoutChunks, stderrChunks) {
  const deadline = Date.now() + UI_HEALTH_TIMEOUT_MS;
  let lastError = "health endpoint did not respond";
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      fail(
        `keiko ui exited ${String(child.exitCode)} before /api/health was reachable.\n` +
          `stdout:\n${stdoutChunks.join("")}\n` +
          `stderr:\n${stderrChunks.join("")}`,
      );
    }
    try {
      const res = await globalThis.fetch(`${baseUrl}/api/health`);
      if (res.ok) return;
      lastError = `/api/health returned ${String(res.status)}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(UI_HEALTH_POLL_INTERVAL_MS);
  }
  fail(
    `keiko ui did not become healthy within ${String(UI_HEALTH_TIMEOUT_MS)}ms: ${lastError}\n` +
      `stdout:\n${stdoutChunks.join("")}\n` +
      `stderr:\n${stderrChunks.join("")}`,
  );
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolvePromise) => child.once("exit", () => resolvePromise())),
    sleep(5_000).then(() => {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
    }),
  ]);
}

async function assertQiRouteReachable(baseUrl) {
  // Issue #284 AC4: prove the Quality Intelligence BFF seam is reachable on the PACKED artifact and
  // that its evidence-directory path resolves cross-platform. This GET drives the QI local store's
  // directory resolution (resolveEvidenceDir -> existingQiBaseDir) without requiring a model, so it
  // is deterministic and offline — exactly the path handling most likely to break on Windows. A QI
  // run / evidence WRITE is model-gated (Model Gateway) and out of an offline smoke; the read seam
  // is what this asserts cross-platform.
  //
  // Test layering: the handler (handleListQiRuns) is already unit-tested in keiko-server's
  // uiRoutes.test.ts (populated, empty-`[]`, and limit-boundary cases), so the response SHAPE is
  // covered at the unit level. This assertion is deliberately integration-only — it verifies a
  // property a unit test cannot express: that the route is reachable and the evidence-dir path
  // resolves on the packed artifact, per OS. The `!Array.isArray` check also fails closed on a
  // null / malformed `runs` shape, so the empty and the malformed cases both surface clearly.
  const res = await globalThis.fetch(`${baseUrl}/api/quality-intelligence/runs`);
  if (!res.ok) {
    fail(`keiko ui GET /api/quality-intelligence/runs exited with HTTP ${String(res.status)}`);
  }
  const payload = await res.json();
  if (!Array.isArray(payload.runs)) {
    fail(
      `keiko ui QI runs response did not contain runs[]: ${JSON.stringify(payload).slice(0, 200)}`,
    );
  }
}

function seedNestedRepositoryPickerFixture(tmp) {
  const repoRootPath = join(tmp, "Keiko");
  mkdirSync(join(repoRootPath, ".git"), { recursive: true });
  mkdirSync(join(repoRootPath, "packages", "keiko-editor", "src"), { recursive: true });
  mkdirSync(join(tmp, "StorybookStatic", "assets"), { recursive: true });
  writeFileSync(
    join(repoRootPath, "packages", "keiko-editor", "src", "range.ts"),
    "export const sourceRange = 1;\n",
    "utf8",
  );
  writeFileSync(join(tmp, "StorybookStatic", "assets", "range.ts"), "generated\n", "utf8");
  return realpathSync(repoRootPath);
}

function assertNestedRepositoryFirstSearchResult(first, expectedRepoRoot) {
  if (!samePath(first?.root, expectedRepoRoot)) {
    fail(
      "repository picker search did not rebase the first nested repo result " +
        `to ${expectedRepoRoot}: ${JSON.stringify(first).slice(0, 240)}`,
    );
  }
  if (first.path !== "packages/keiko-editor/src/range.ts") {
    fail(`repository picker search returned non-canonical first path: ${String(first.path)}`);
  }
  if (
    first.fileRole !== "source" ||
    first.matchQuality !== "exact" ||
    first.rootKind !== "nested-git-root"
  ) {
    fail(
      "repository picker search first result metadata was not source/exact/nested-git-root: " +
        JSON.stringify(first).slice(0, 240),
    );
  }
}

function assertGeneratedRepositorySearchFixture(payload) {
  const generated = payload.results?.find(
    (entry) => entry.path === "StorybookStatic/assets/range.ts",
  );
  if (generated?.fileRole !== "generated" || generated.rootKind !== "selected-root") {
    fail(
      "repository picker search generated fixture metadata was not generated/selected-root: " +
        JSON.stringify(generated).slice(0, 240),
    );
  }
}

async function assertRepositoryPickerSearchRebasesNestedRepo(baseUrl, tmp) {
  const expectedRepoRoot = seedNestedRepositoryPickerFixture(tmp);
  const res = await globalThis.fetch(
    `${baseUrl}/api/files/search?root=${encodeURIComponent(tmp)}&query=range&limit=10`,
  );
  if (!res.ok) {
    fail(
      `keiko ui GET /api/files/search for repository picker exited with HTTP ${String(res.status)}`,
    );
  }
  const payload = await res.json();
  const first = payload.results?.[0];
  assertNestedRepositoryFirstSearchResult(first, expectedRepoRoot);
  assertGeneratedRepositorySearchFixture(payload);
  if (payload.results?.some((entry) => entry.path === "Keiko/packages/keiko-editor/src/range.ts")) {
    fail("repository picker search leaked the parent-folder label into a result path");
  }
}

// Compare two absolute paths for equality. On Windows paths are case-insensitive and may differ in
// separator (`\` vs `/`), drive-letter case, or 8.3 short-name expansion between `realpathSync`
// and the server's resolved path, so compare every realpath variant we can resolve there; POSIX
// comparison stays exact (case-sensitive).
//
// Test layering for the cross-platform path helpers (this `samePath` and the forward-slash
// `probeFile` above): they are deliberately covered by the CI matrix itself rather than a unit test.
// This script IS the integration test, and each platform branch is exercised on its own runner —
// the `win32` branches by `cross-platform-smoke (windows-latest)`, the POSIX branches by the
// `(macos-latest)` leg and the gating Linux `build-scan-sbom-smoke` job. A unit test would mock the
// platform/fs and assert against the harness, not the product, so it is intentionally not added.
function comparableWindowsPath(value) {
  return String(value)
    .replace(/^\\\\\?\\/u, "")
    .replaceAll("\\", "/")
    .toLowerCase();
}

function windowsPathVariants(value) {
  const variants = new Set([comparableWindowsPath(value)]);
  for (const resolvePath of [realpathSync, realpathSync.native]) {
    try {
      variants.add(comparableWindowsPath(resolvePath(value)));
    } catch {
      // Missing paths should still compare by their normalized literal form.
    }
  }
  return variants;
}

function samePath(a, b) {
  if (a === undefined || b === undefined) return false;
  if (process.platform !== "win32") return a === b;
  const left = windowsPathVariants(a);
  const right = windowsPathVariants(b);
  return [...left].some((candidate) => right.has(candidate));
}

async function assertUiLaunchProject(baseUrl, tmp) {
  const expectedProjectPath = realpathSync(tmp);
  const projectsRes = await globalThis.fetch(`${baseUrl}/api/projects`);
  if (!projectsRes.ok) {
    fail(`keiko ui GET /api/projects exited with HTTP ${String(projectsRes.status)}`);
  }
  const projectsPayload = await projectsRes.json();
  const launchProject = projectsPayload.projects?.[0];
  if (!samePath(launchProject?.path, expectedProjectPath)) {
    fail(`keiko ui did not select launch cwd; first project was ${String(launchProject?.path)}`);
  }
  if (launchProject.available !== true) {
    fail("keiko ui launch cwd project is not available");
  }
}

async function assertPackagedUi(tmp) {
  const packageRoot = join(tmp, "node_modules", "@oscharko-dev", "keiko");
  const staticRoot = join(packageRoot, "dist", "ui", "static");
  const hashesFile = join(packageRoot, "dist", "ui", "csp-hashes.json");
  if (!existsSync(staticRoot)) {
    fail(`installed tarball missing packaged UI static root at ${staticRoot}`);
  }
  if (readdirSync(staticRoot).length === 0) {
    fail(`installed packaged UI static root is empty: ${staticRoot}`);
  }
  if (!existsSync(hashesFile)) {
    fail(`installed tarball missing packaged UI CSP hashes at ${hashesFile}`);
  }
  const bin = join(packageRoot, "dist", "cli", "index.js");
  const port = await reserveUiPort();
  const baseUrl = `http://127.0.0.1:${String(port)}`;
  const stdoutChunks = [];
  const stderrChunks = [];
  const child = spawn(process.execPath, [bin, "ui", "--port", String(port)], {
    cwd: tmp,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk) => stdoutChunks.push(String(chunk)));
  child.stderr?.on("data", (chunk) => stderrChunks.push(String(chunk)));
  try {
    await waitForHealth(baseUrl, child, stdoutChunks, stderrChunks);
    await assertUiLaunchProject(baseUrl, tmp);
    await assertQiRouteReachable(baseUrl);
    await assertRepositoryPickerSearchRebasesNestedRepo(baseUrl, tmp);
    const home = await globalThis.fetch(`${baseUrl}/`);
    if (!home.ok) {
      fail(`keiko ui GET / exited with HTTP ${String(home.status)}`);
    }
    const html = await home.text();
    if (!html.includes("Keiko")) {
      fail("keiko ui home page did not contain the Keiko shell marker");
    }
  } finally {
    await stopChild(child);
  }
}

function lifecycleCommandRunner(tmp, bin, port, stateDir) {
  const commonArgs = [
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--state-dir",
    stateDir,
    "--start-timeout",
    "30",
    "--stop-timeout",
    "10",
  ];
  return (command, extra = []) =>
    run("node", [bin, command, ...commonArgs, ...extra], {
      cwd: tmp,
      timeout: LIFECYCLE_COMMAND_TIMEOUT_MS,
    });
}

function assertLifecycleStart(runLifecycle) {
  const startResult = runLifecycle("start");
  if (startResult.status !== 0) {
    // Surface the UI child's own log (keiko start reports its path as "Logs: <path>") so a startup
    // crash is diagnosable from CI instead of hiding behind a bare non-zero exit.
    const logMatch = /Logs:\s*(\S+)/u.exec(startResult.stderr);
    let logTail = "";
    if (logMatch) {
      try {
        logTail = `\n--- ${logMatch[1]} (tail) ---\n${readFileSync(logMatch[1], "utf8")
          .split("\n")
          .slice(-40)
          .join("\n")}`;
      } catch {
        logTail = `\n--- ${logMatch[1]} unreadable ---`;
      }
    }
    fail(`keiko start exited ${String(startResult.status)}: ${startResult.stderr}${logTail}`);
  }
  if (!startResult.stdout.includes("Keiko UI running on")) {
    fail(`keiko start did not report a running UI: ${startResult.stdout}`);
  }
}

function assertLifecycleStatusRunning(runLifecycle) {
  const statusResult = runLifecycle("status");
  if (statusResult.status !== 0 || !statusResult.stdout.includes("Keiko UI is running on")) {
    fail(
      `keiko status did not report the packaged UI as running ` +
        `(status=${String(statusResult.status)}): ${statusResult.stdout}${statusResult.stderr}`,
    );
  }
}

function assertLifecycleRestart(runLifecycle) {
  const restartResult = runLifecycle("restart");
  if (restartResult.status !== 0) {
    fail(`keiko restart exited ${String(restartResult.status)}: ${restartResult.stderr}`);
  }
  if (!restartResult.stdout.includes("Keiko UI running on")) {
    fail(`keiko restart did not report a running UI after restart: ${restartResult.stdout}`);
  }
}

function assertLifecycleStop(runLifecycle) {
  const stopResult = runLifecycle("stop");
  if (stopResult.status !== 0 || !stopResult.stdout.includes("Keiko UI stopped")) {
    fail(
      `keiko stop did not stop the packaged UI ` +
        `(status=${String(stopResult.status)}): ${stopResult.stdout}${stopResult.stderr}`,
    );
  }
}

function assertLifecycleStatusStopped(runLifecycle) {
  const stoppedStatus = runLifecycle("status");
  if (stoppedStatus.status !== 0 || !stoppedStatus.stdout.includes("not running")) {
    fail(`keiko status after stop did not report not running: ${stoppedStatus.stdout}`);
  }
}

async function assertPackagedLifecycleCommands(tmp) {
  const packageRoot = join(tmp, "node_modules", "@oscharko-dev", "keiko");
  const bin = join(packageRoot, "dist", "cli", "index.js");
  const port = await reserveUiPort();
  // The runtime state / UI data dir MUST live outside the workspace (the lifecycle cwd = tmp): keiko
  // rejects a state dir inside the current workspace so the UI DB can never overlap a selected
  // repository (packages/keiko-server/src/store/paths.ts). It must also live INSIDE the user's home
  // directory: `keiko start` refuses a state dir outside home to close the launcher's F4 env-var
  // planting attack (KEIKO-0330). A home-contained temp dir satisfies both: outside the workspace,
  // inside home, cleaned up when the smoke completes.
  const stateDir = mkdtempSync(join(homedir(), ".keiko-smoke-state-"));
  const lifecycleRun = lifecycleCommandRunner(tmp, bin, port, stateDir);

  let started = false;
  try {
    assertLifecycleStart(lifecycleRun);
    started = true;
    assertLifecycleStatusRunning(lifecycleRun);
    assertLifecycleRestart(lifecycleRun);
    assertLifecycleStop(lifecycleRun);
    started = false;
    assertLifecycleStatusStopped(lifecycleRun);
  } finally {
    if (started) {
      lifecycleRun("stop");
    }
    rmSync(stateDir, { recursive: true, force: true });
  }
}

/**
 * CI runs this script twice — `smoke:install` then `smoke:install:optional` — as separate
 * processes against one checkout. The first run's `prepack` permanently prunes `@napi-rs/canvas`
 * and its bindings out of `node_modules`, so a second run seeding from that tree would substitute
 * inert stubs and let the optional lane pass without the native binding it exists to prove.
 *
 * The seed directory is therefore stable and keyed by the lockfile, so the second invocation
 * reuses the pre-prune artifacts the first one packed instead of re-deriving them from a mutated
 * tree (#3130).
 */
export function persistentVendorSeedDir(lockfilePath = join(repoRoot, "package-lock.json")) {
  // Keyed by the CHECKOUT as well as the lockfile: two checkouts sharing a lockfile must not share
  // a cache, and a predictable path on a shared host is otherwise pre-creatable by another user.
  // The lockfile is hashed as BYTES. Interpolating the Buffer into a template string would decode
  // it as UTF-8 first, and any byte sequence that does not survive that round trip would map two
  // distinct lockfiles onto one cache directory.
  const digest = createHash("sha256").update(repoRoot).update("\u0000");
  digest.update(existsSync(lockfilePath) ? readFileSync(lockfilePath) : "no-lockfile");
  // The implementation is part of the key: switching revisions in one worktree without touching
  // the lockfile would otherwise run new packing, manifest-projection or stub logic against
  // tarballs produced by the old logic, and the gate could stay green over the very regression it
  // is meant to catch.
  digest.update("\u0000").update(readFileSync(fileURLToPath(import.meta.url)));
  const key = digest.digest("hex").slice(0, 24);
  const dir = join(tmpdir(), `keiko-yarn-vendor-seed-${key}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  assertPrivateDirectory(dir);
  return dir;
}

/** A cache another account can write is a cache that can hand this gate unverified bytes. */
function assertPrivateDirectory(dir) {
  const stats = lstatSync(dir);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    fail(`vendor seed cache ${dir} is not a real directory`);
  }
  if (process.getuid !== undefined && stats.uid !== process.getuid()) {
    fail(`vendor seed cache ${dir} is not owned by this user`);
  }
  // Group/other write bits would let another account replace an archive between runs. POSIX mode
  // bits carry no meaning on Windows — Node reports a synthetic mode there and exposes no ACL API —
  // so the check is skipped rather than evaluated against a value that says nothing. That platform
  // is not left unguarded: `os.tmpdir()` is per-user on Windows
  // (`%LOCALAPPDATA%\Temp`), so the shared-directory exposure this check addresses does not arise
  // by default, and the containment plus integrity checks in `isReusableSeedEntry` apply on every
  // platform regardless.
  if (process.platform !== "win32" && (stats.mode & 0o022) !== 0) {
    fail(`vendor seed cache ${dir} is group- or world-writable`);
  }
}

/**
 * Seeds the offline registry and THEN packs the publish artifact, in that order, because
 * `packRoot()` runs `prepack`, whose `prune:package-native-optionals` step deletes
 * `@napi-rs/canvas` and its platform bindings out of `node_modules`. Seeding afterwards would find
 * them gone, serve inert stubs in their place, and let the Yarn arm pass without the native
 * binding it exists to prove (#3130).
 *
 * Dependency-injected so the ordering is observable in a test: a pin comparing source positions
 * would stay green if a refactor moved the effective call and left the statement text in place.
 */
export function seedThenPack(vendorTmp, deps) {
  const seed = deps?.seedVendoredRegistry ?? seedVendoredRegistry;
  const pack = deps?.packRoot ?? packRoot;
  const vendored = seed(vendorTmp);
  const artifact = pack();
  return { vendored, artifact };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  // Stable and lockfile-keyed, so the second CI invocation reuses the pre-prune artifacts.
  const vendorTmp = persistentVendorSeedDir();
  // Both directories are created INSIDE the try, so a failure creating the second does not strand
  // the first; the finally tolerates either being unassigned.
  let tmp;
  let yarnTmp;
  let artifact;
  try {
    tmp = mkdtempSync(join(tmpdir(), "keiko-install-smoke-"));
    yarnTmp = mkdtempSync(join(tmpdir(), "keiko-yarn-install-smoke-"));
    const seeded = seedThenPack(vendorTmp);
    const { vendored } = seeded;
    artifact = seeded.artifact;
    installInto(tmp, artifact.tarballPath, options);
    assertCliExecutable(tmp);
    assertVendoredPayload(tmp);
    assertProductiveTypeScriptRuntime(tmp);
    assertCliVersionAndHelp(tmp);
    await assertInstalledRootRuntimeSurface(tmp);
    assertInstalledRootTypeSurface(tmp);
    await assertPackagedUi(tmp);
    await assertPackagedLifecycleCommands(tmp);
    // Top up from the STAGED manifest: `promoteWorkspacePeers` can lift third-party peers into it
    // that the repository manifest never named. Anything already captured above is kept as-is, so
    // the pre-prune copies win.
    seedVendoredRegistry(vendorTmp, undefined, artifact.manifest, vendored);
    await installIntoWithYarn(yarnTmp, artifact, vendored);
    assertCliExecutable(yarnTmp);
    assertVendoredPayload(yarnTmp);
    assertProductiveTypeScriptRuntime(yarnTmp);
    assertCliVersionAndHelp(yarnTmp);
    await assertInstalledRootRuntimeSurface(yarnTmp);
    assertInstalledRootTypeSurface(yarnTmp);
    console.log(
      `installable-smoke ok: npm tarball + Yarn registry installs passed (${options.includeOptional ? "optional deps included" : "optional deps omitted"}), ${String(runtimeWorkspaces.length)} vendored packages present, root runtime/types + CLI + UI/lifecycle reachable.`,
    );
  } finally {
    if (tmp !== undefined) rmSync(tmp, { recursive: true, force: true });
    if (yarnTmp !== undefined) rmSync(yarnTmp, { recursive: true, force: true });
    // vendorTmp is deliberately NOT removed: it is the lockfile-keyed cache the next invocation
    // reuses, and it lives under the OS temp directory.
    artifact?.cleanup();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
