// `keiko ui` — launches the local Wave 1 UI BFF (ADR-0011). It resolves the packaged static export
// (dist/ui/static) and the precomputed CSP hashes (dist/ui/csp-hashes.json) relative to this
// compiled module, builds the CSP, starts createUiServer bound to 127.0.0.1 only, prints the local
// URL, and keeps running until the process is signalled. Exit 2 on a usage error (bad --host/--port
// or a flag missing its value), 1 when the static export is not present (the package was built with
// `npm run build` but not `npm run build:ui`).

import type { Server } from "node:http";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createUiServer,
  loadCspHeader,
  buildUiHandlerDeps,
  DEFAULT_UI_PORT,
  UI_HOST,
  type UiHandlerDeps,
} from "../ui/index.js";
import type { EnvSource } from "../gateway/config.js";
import type { CliIo } from "./runner.js";

const ALLOWED_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "localhost"]);

const USAGE = `Usage:
  keiko ui [--port PORT] [--host 127.0.0.1|localhost] [--evidence-dir PATH] [--config PATH]

Launches the local Keiko UI on the loopback interface and prints its URL. The server
binds 127.0.0.1 only and serves the packaged UI assets (built with \`npm run build:ui\`).
`;

export interface UiCliArgs {
  readonly port: number;
  readonly evidenceDir: string | undefined;
  readonly config: string | undefined;
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
}

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
  if (portRaw === null || hostRaw === null || evidenceRaw === null || configRaw === null) {
    return null;
  }
  if (hostRaw !== undefined && !ALLOWED_HOSTS.has(hostRaw)) {
    return null;
  }
  const port = portRaw === undefined ? DEFAULT_UI_PORT : parsePort(portRaw);
  if (port === null) {
    return null;
  }
  return { port, evidenceDir: evidenceRaw, config: configRaw };
}

function defaultStaticRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "ui", "static");
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

export async function runUiCli(
  args: readonly string[],
  io: CliIo,
  env: EnvSource,
  deps: UiCliDeps = {},
): Promise<number> {
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
    configPath: parsed.config,
    evidenceDir: parsed.evidenceDir,
    env,
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
