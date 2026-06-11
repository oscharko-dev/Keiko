// `keiko ui` — launches the local Wave 1 UI BFF (ADR-0011). It resolves the packaged static export
// (dist/ui/static) and the precomputed CSP hashes (dist/ui/csp-hashes.json) relative to this
// compiled module, builds the CSP, starts createUiServer bound to 127.0.0.1 only, prints the local
// URL, and keeps running until the process is signalled. Exit 2 on a usage error (bad --host/--port
// or a flag missing its value), 1 when the static export is not present (the package was built with
// `npm run build` but not `npm run build:ui`).
//
// ADR-0013 D2 site 1 — Detect-and-re-exec guard. Node 22.0–22.11 builds require
// --experimental-sqlite to import node:sqlite; 22.22+ loads it without the flag. The guard tries
// the import; on failure it re-spawns the current process with --experimental-sqlite prepended,
// inheriting stdio and forwarding SIGINT/SIGTERM to the child, then propagates the child's exit
// code. Injected-test invocations skip the guard entirely.

import type { Server } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawn, type SpawnOptions, type ChildProcess } from "node:child_process";
import {
  createUiServer,
  loadCspHeader,
  buildUiHandlerDeps,
  DEFAULT_UI_PORT,
  UI_HOST,
  UiStoreError,
  type UiHandlerDeps,
} from "@oscharko-dev/keiko-server";
import type { EnvSource } from "@oscharko-dev/keiko-model-gateway";
import type { CliIo } from "./runner.js";

const ALLOWED_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "localhost"]);
const SQLITE_FLAG = "--experimental-sqlite";
const KEIKO_ENV_NAME_RE = /^KEIKO_[A-Z0-9_]+$/;
const DEFAULT_STATE_DIR = ".keiko";

const USAGE = `Usage:
  keiko ui [--port PORT] [--host 127.0.0.1|localhost] [--evidence-dir PATH] [--config PATH] [--ui-db PATH]

Launches the local Keiko UI on the loopback interface and prints its URL. The server
binds 127.0.0.1 only and serves the packaged UI assets (built with \`npm run build:ui\`).
`;

export interface UiCliArgs {
  readonly port: number;
  readonly evidenceDir: string | undefined;
  readonly config: string | undefined;
  readonly uiDbPath: string | undefined;
}

type UiParseResult = UiCliArgs | "help" | null;
type UiFlag = "--port" | "--host" | "--evidence-dir" | "--config" | "--ui-db";

interface RawUiOptions {
  portRaw?: string | undefined;
  hostRaw?: string | undefined;
  evidenceRaw?: string | undefined;
  configRaw?: string | undefined;
  uiDbRaw?: string | undefined;
}

// Test seam: inject a server factory and the resolved asset paths so unit tests never bind a real
// socket or require a built dist/. Defaults resolve the packaged assets relative to this module.
export interface UiCliDeps {
  readonly createServer?: (deps: {
    staticRoot: string;
    csp: string;
    port: number;
    handlerDeps: UiHandlerDeps;
  }) => Server | Promise<Server>;
  readonly staticRoot?: string;
  readonly hashesFile?: string;
  // ADR-0013 D2 — test seams for the re-exec guard. `sqliteProbe` returns true when node:sqlite
  // loads without the flag; spawnFn replaces child_process.spawn so we can drive the branch
  // synchronously in tests without ever forking a real process.
  readonly sqliteProbe?: () => boolean;
  readonly spawnFn?: SpawnFn;
  // Test seam: returns the current execArgv. Defaults to process.execArgv. Tests override this
  // so the vitest worker's own --experimental-sqlite does not short-circuit the guard.
  readonly currentExecArgv?: () => readonly string[];
  // Test seam for local .env discovery. Defaults to process.cwd().
  readonly cwd?: string | undefined;
}

export type SpawnFn = (
  command: string,
  args: readonly string[],
  opts: SpawnOptions,
) => ChildProcess;

function parsePort(raw: string): number | null {
  if (!/^\d{1,5}$/.test(raw)) {
    return null;
  }
  const port = Number(raw);
  return port >= 1 && port <= 65535 ? port : null;
}

function readFlagValue(args: readonly string[], index: number): string | null {
  const value = args[index + 1];
  return value === undefined || value.startsWith("--") ? null : value;
}

function isUiFlag(arg: string): arg is UiFlag {
  return (
    arg === "--port" ||
    arg === "--host" ||
    arg === "--evidence-dir" ||
    arg === "--config" ||
    arg === "--ui-db"
  );
}

function setRawUiOption(raw: RawUiOptions, flag: UiFlag, value: string): void {
  switch (flag) {
    case "--port":
      raw.portRaw = value;
      return;
    case "--host":
      raw.hostRaw = value;
      return;
    case "--evidence-dir":
      raw.evidenceRaw = value;
      return;
    case "--config":
      raw.configRaw = value;
      return;
    case "--ui-db":
      raw.uiDbRaw = value;
      return;
  }
}

function collectUiOptions(args: readonly string[]): RawUiOptions | "help" | null {
  const raw: RawUiOptions = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) return null;
    if (arg === "--help" || arg === "-h") return "help";
    if (!isUiFlag(arg)) return null;
    const value = readFlagValue(args, i);
    if (value === null) return null;
    setRawUiOption(raw, arg, value);
    i += 1;
  }
  return raw;
}

// Parses flags. Returns the parsed args, or null on any usage error (missing flag value, invalid
// port, or a host other than the two loopback names).
export function parseUiArgs(args: readonly string[]): UiParseResult {
  const raw = collectUiOptions(args);
  if (raw === "help" || raw === null) return raw;
  const { portRaw, hostRaw, evidenceRaw, configRaw, uiDbRaw } = raw;
  if (hostRaw !== undefined && !ALLOWED_HOSTS.has(hostRaw)) {
    return null;
  }
  const port = portRaw === undefined ? DEFAULT_UI_PORT : parsePort(portRaw);
  if (port === null) {
    return null;
  }
  return { port, evidenceDir: evidenceRaw, config: configRaw, uiDbPath: uiDbRaw };
}

function defaultStaticRoot(): string {
  // The root bin shim (`dist/cli/index.js`) surfaces `KEIKO_UI_STATIC_ROOT` so the
  // cli package does not have to know its own installation layout. The
  // import.meta.url fallback preserves the standalone behaviour for callers that
  // construct UiCliDeps without going through the bin shim (e.g. in tests).
  const fromEnv = process.env.KEIKO_UI_STATIC_ROOT;
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "ui", "static");
}

function parseEnvValue(raw: string): string {
  const value = raw.trim();
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === `"` && last === `"`) || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

function loadLocalKeikoEnv(cwd: string, env: EnvSource): EnvSource {
  const file = join(cwd, ".env");
  if (!existsSync(file)) {
    return env;
  }
  const merged: Record<string, string | undefined> = { ...env };
  const text = readFileSync(file, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const equals = line.indexOf("=");
    if (equals <= 0) continue;
    const key = line.slice(0, equals).trim();
    if (!KEIKO_ENV_NAME_RE.test(key)) continue;
    if (merged[key] !== undefined) continue;
    merged[key] = parseEnvValue(line.slice(equals + 1));
  }
  return merged;
}

function resolveUiConfigPath(parsed: UiCliArgs, env: EnvSource): string | undefined {
  return parsed.config ?? env.KEIKO_CONFIG_FILE;
}

function hasEnvValue(value: string | undefined): value is string {
  return value !== undefined && value.length > 0;
}

function resolveRuntimeStateDir(cwd: string, env: EnvSource): string {
  const raw = env.KEIKO_STATE_DIR;
  if (hasEnvValue(raw)) {
    return isAbsolute(raw) ? raw : resolve(cwd, raw);
  }
  return resolve(cwd, DEFAULT_STATE_DIR);
}

function withDefaultLocalRuntimeStateEnv(
  cwd: string,
  parsed: UiCliArgs,
  env: EnvSource,
): EnvSource {
  const stateDir = resolveRuntimeStateDir(cwd, env);
  const next: Record<string, string | undefined> = { ...env, KEIKO_STATE_DIR: stateDir };
  if (parsed.uiDbPath === undefined && !hasEnvValue(next.KEIKO_UI_DATA_DIR)) {
    next.KEIKO_UI_DATA_DIR = join(stateDir, "ui");
  }
  if (!hasEnvValue(next.KEIKO_MEMORY_DIR)) {
    next.KEIKO_MEMORY_DIR = join(stateDir, "memory");
  }
  return next;
}

// Conservative request/header timeouts on the loopback BFF (defense in depth, L2/L3): even on
// 127.0.0.1 a slow or stuck client must not hold a connection indefinitely. headersTimeout must be
// at or below requestTimeout so an incomplete request line/header set is cut first.
const REQUEST_TIMEOUT_MS = 30_000;
const HEADERS_TIMEOUT_MS = 10_000;

export function applyServerTimeouts(server: Server): void {
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.headersTimeout = HEADERS_TIMEOUT_MS;
}

async function listen(server: Server, port: number): Promise<void> {
  await new Promise<void>((res, rej) => {
    server.once("error", rej);
    server.listen(port, UI_HOST, res);
  });
}

// Keeps the real-CLI process alive until a shutdown signal or server close. Resolves cleanly so
// the caller can return 0. Registered listeners are removed on resolve to prevent leaks.
export function waitForShutdown(server: Server): Promise<void> {
  return new Promise<void>((resolve) => {
    const onClose = (): void => {
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
      resolve();
    };
    const onSignal = (): void => {
      server.removeListener("close", onClose);
      server.close(() => {
        resolve();
      });
    };
    server.once("close", onClose);
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
  });
}

// Default probe: try to require node:sqlite. Any failure (ERR_UNKNOWN_BUILTIN_MODULE on early
// 22.x, or a thrown ExperimentalWarning that escaped) means we need the flag. The require is
// guarded inside a try; we never throw past here.
function defaultSqliteProbe(): boolean {
  try {
    const req = createRequire(import.meta.url);
    req("node:sqlite");
    return true;
  } catch {
    return false;
  }
}

// Returns true if `--experimental-sqlite` is already on execArgv, meaning we are inside the child
// already and must not loop. Inspects both the supplied execArgv source (Node-level flags the
// parent inherited) AND NODE_OPTIONS (where the flag may live in env).
function alreadyFlagged(env: EnvSource, execArgv: readonly string[]): boolean {
  if (execArgv.includes(SQLITE_FLAG)) return true;
  const nodeOptions = env.NODE_OPTIONS;
  return typeof nodeOptions === "string" && nodeOptions.includes(SQLITE_FLAG);
}

// Re-spawns the current process with --experimental-sqlite prepended, inheriting stdio. Returns
// the exit code the child terminated with so the parent can propagate it.
export async function reExecWithSqliteFlag(_env: EnvSource, spawnFn: SpawnFn): Promise<number> {
  const entry = process.argv[1];
  if (entry === undefined) return 1;
  const childArgs: string[] = [SQLITE_FLAG, ...process.execArgv, entry, ...process.argv.slice(2)];
  const child = spawnFn(process.execPath, childArgs, { stdio: "inherit" });
  const forwardSigint = (): void => {
    child.kill("SIGINT");
  };
  const forwardSigterm = (): void => {
    child.kill("SIGTERM");
  };
  process.on("SIGINT", forwardSigint);
  process.on("SIGTERM", forwardSigterm);
  return new Promise<number>((res) => {
    child.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      process.removeListener("SIGINT", forwardSigint);
      process.removeListener("SIGTERM", forwardSigterm);
      if (typeof code === "number") {
        res(code);
        return;
      }
      res(signal === null ? 1 : 128);
    });
  });
}

// Returns undefined when no re-exec is needed; returns the child's exit code when a re-exec
// happened. The guard never runs when an injected test factory bypasses the production loop, and
// it never re-loops once --experimental-sqlite is already in execArgv.
async function maybeReExecForSqlite(env: EnvSource, deps: UiCliDeps): Promise<number | undefined> {
  if (deps.createServer !== undefined) return undefined;
  const execArgv = (deps.currentExecArgv ?? ((): readonly string[] => process.execArgv))();
  if (alreadyFlagged(env, execArgv)) return undefined;
  const probe = deps.sqliteProbe ?? defaultSqliteProbe;
  if (probe()) return undefined;
  const spawnFn = deps.spawnFn ?? spawn;
  return reExecWithSqliteFlag(env, spawnFn);
}

function buildHandlerDepsOrReport(
  parsed: UiCliArgs,
  cwd: string,
  effectiveEnv: EnvSource,
  io: CliIo,
): UiHandlerDeps | number {
  try {
    return buildUiHandlerDeps({
      configPath: resolveUiConfigPath(parsed, effectiveEnv),
      evidenceDir: parsed.evidenceDir,
      uiDbPath: parsed.uiDbPath,
      initialProjectPath: cwd,
      env: effectiveEnv,
    });
  } catch (error) {
    if (error instanceof UiStoreError) {
      io.err(`keiko ui: ${error.message}\n`);
      return 2;
    }
    throw error;
  }
}

function registerLaunchProjectOrReport(
  cwd: string,
  handlerDeps: UiHandlerDeps,
  io: CliIo,
): number | null {
  try {
    handlerDeps.store.createProject(cwd);
    return null;
  } catch (error) {
    if (error instanceof UiStoreError) {
      io.err(`keiko ui: ${error.message}\n`);
      return 2;
    }
    throw error;
  }
}

function ensureStaticRoot(staticRoot: string, io: CliIo): boolean {
  if (existsSync(staticRoot)) {
    return true;
  }
  io.err(`keiko ui: UI assets not found at ${staticRoot}. Run \`npm run build:ui\` first.\n`);
  return false;
}

function parseUiArgsOrExit(args: readonly string[], io: CliIo): UiCliArgs | number {
  const parsed = parseUiArgs(args);
  if (parsed === "help") {
    io.out(USAGE);
    return 0;
  }
  if (parsed === null) {
    io.err(USAGE);
    return 2;
  }
  return parsed;
}

async function maybeWaitForShutdown(server: Server, deps: UiCliDeps): Promise<void> {
  if (deps.createServer !== undefined) {
    return;
  }
  await waitForShutdown(server);
}

async function startUiServer(
  staticRoot: string,
  csp: string,
  parsed: UiCliArgs,
  handlerDeps: UiHandlerDeps,
  io: CliIo,
  deps: UiCliDeps,
): Promise<void> {
  const factory = deps.createServer ?? createUiServer;
  const server = await factory({ staticRoot, csp, port: parsed.port, handlerDeps });
  applyServerTimeouts(server);
  await listen(server, parsed.port);
  io.out(`Keiko UI listening on http://${UI_HOST}:${String(parsed.port)}\n`);
  // Block only in the real CLI path (no injected factory). Injected-server tests skip blocking so
  // they don't hang; the real process must stay alive until signalled.
  await maybeWaitForShutdown(server, deps);
}

export async function runUiCli(
  args: readonly string[],
  io: CliIo,
  env: EnvSource,
  deps: UiCliDeps = {},
): Promise<number> {
  const cwd = deps.cwd ?? process.cwd();
  const effectiveEnv = loadLocalKeikoEnv(cwd, env);
  const parsed = parseUiArgsOrExit(args, io);
  if (typeof parsed === "number") return parsed;
  const reExec = await maybeReExecForSqlite(effectiveEnv, deps);
  if (reExec !== undefined) return reExec;
  const staticRoot = deps.staticRoot ?? defaultStaticRoot();
  if (!ensureStaticRoot(staticRoot, io)) {
    return 1;
  }
  const csp = await loadCspHeader(deps.hashesFile ?? join(staticRoot, "..", "csp-hashes.json"));
  const handlerDeps = buildHandlerDepsOrReport(
    parsed,
    cwd,
    withDefaultLocalRuntimeStateEnv(cwd, parsed, effectiveEnv),
    io,
  );
  if (typeof handlerDeps === "number") return handlerDeps;
  const launchProjectResult = registerLaunchProjectOrReport(cwd, handlerDeps, io);
  if (launchProjectResult !== null) return launchProjectResult;
  await startUiServer(staticRoot, csp, parsed, handlerDeps, io, deps);
  return 0;
}
