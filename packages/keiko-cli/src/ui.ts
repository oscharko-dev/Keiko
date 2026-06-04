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
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawn, type SpawnOptions, type ChildProcess } from "node:child_process";
import {
  createUiServer,
  loadCspHeader,
  buildUiHandlerDeps,
  DEFAULT_UI_PORT,
  UI_HOST,
  type UiHandlerDeps,
} from "@oscharko-dev/keiko-server";
import type { EnvSource } from "@oscharko-dev/keiko-model-gateway";
import type { CliIo } from "./runner.js";

const ALLOWED_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "localhost"]);
const SQLITE_FLAG = "--experimental-sqlite";
const KEIKO_ENV_NAME_RE = /^KEIKO_[A-Z0-9_]+$/;

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

function flagValue(args: readonly string[], name: string): string | undefined | null {
  const i = args.indexOf(name);
  if (i === -1) {
    return undefined;
  }
  const value = args[i + 1];
  return value === undefined || value.startsWith("--") ? null : value;
}

function parsePort(raw: string): number | null {
  if (!/^\d{1,5}$/.test(raw)) {
    return null;
  }
  const port = Number(raw);
  return port >= 1 && port <= 65535 ? port : null;
}

// Parses flags. Returns the parsed args, or null on any usage error (missing flag value, invalid
// port, or a host other than the two loopback names).
export function parseUiArgs(args: readonly string[]): UiCliArgs | null {
  const portRaw = flagValue(args, "--port");
  const hostRaw = flagValue(args, "--host");
  const evidenceRaw = flagValue(args, "--evidence-dir");
  const configRaw = flagValue(args, "--config");
  const uiDbRaw = flagValue(args, "--ui-db");
  if (
    portRaw === null ||
    hostRaw === null ||
    evidenceRaw === null ||
    configRaw === null ||
    uiDbRaw === null
  ) {
    return null;
  }
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

export async function runUiCli(
  args: readonly string[],
  io: CliIo,
  env: EnvSource,
  deps: UiCliDeps = {},
): Promise<number> {
  const effectiveEnv = loadLocalKeikoEnv(deps.cwd ?? process.cwd(), env);
  const reExec = await maybeReExecForSqlite(effectiveEnv, deps);
  if (reExec !== undefined) return reExec;
  const parsed = parseUiArgs(args);
  if (parsed === null) {
    io.err(USAGE);
    return 2;
  }
  const staticRoot = deps.staticRoot ?? defaultStaticRoot();
  if (!existsSync(staticRoot)) {
    io.err(`keiko ui: UI assets not found at ${staticRoot}. Run \`npm run build:ui\` first.\n`);
    return 1;
  }
  const csp = await loadCspHeader(deps.hashesFile ?? join(staticRoot, "..", "csp-hashes.json"));
  const handlerDeps = buildUiHandlerDeps({
    configPath: resolveUiConfigPath(parsed, effectiveEnv),
    evidenceDir: parsed.evidenceDir,
    uiDbPath: parsed.uiDbPath,
    env: effectiveEnv,
  });
  const factory = deps.createServer ?? createUiServer;
  const server = await factory({ staticRoot, csp, port: parsed.port, handlerDeps });
  applyServerTimeouts(server);
  await listen(server, parsed.port);
  io.out(`Keiko UI listening on http://${UI_HOST}:${String(parsed.port)}\n`);
  // Block only in the real CLI path (no injected factory). Injected-server tests skip blocking so
  // they don't hang; the real process must stay alive until signalled.
  if (deps.createServer === undefined) {
    await waitForShutdown(server);
  }
  return 0;
}
