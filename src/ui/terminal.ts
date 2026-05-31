// Local terminal backend for the desktop workbench. Shell execution stays in the loopback BFF:
// the browser only receives a token-scoped WebSocket for a session that was first created through
// the CSRF-guarded JSON API. PTYs are never spawned from user-supplied command strings.

import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, statSync } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { createRequire } from "node:module";
import { homedir, platform as osPlatform } from "node:os";
import {
  delimiter,
  dirname,
  isAbsolute,
  join,
  parse as parsePath,
  resolve,
} from "node:path";
import type { Duplex } from "node:stream";
import * as pty from "node-pty";
import type { IDisposable, IPty } from "node-pty";
import { WebSocketServer } from "ws";
import type { RawData, WebSocket as WsSocket } from "ws";
import type { UiHandlerDeps } from "./deps.js";
import { isAllowedHost } from "./host-check.js";
import { errorBody, type RouteContext, type RouteResult } from "./routes.js";

const MAX_TERMINAL_BODY_BYTES = 64_000;
const MAX_INPUT_BYTES = 64_000;
const MAX_OUTPUT_CHUNKS = 400;
const MAX_OUTPUT_BYTES = 512_000;
const MAX_ACTIVE_SESSIONS = 12;
const DEFAULT_COLS = 100;
const DEFAULT_ROWS = 30;
const SESSION_IDLE_TTL_MS = 30_000;
const EXITED_SESSION_TTL_MS = 30_000;
const WS_MAX_PAYLOAD_BYTES = 128_000;
const requireFromHere = createRequire(import.meta.url);
type TerminalEnv = Readonly<Record<string, string | undefined>>;

type TerminalStatus = "running" | "exited";

export interface TerminalShell {
  readonly id: string;
  readonly label: string;
  readonly path: string;
  readonly args: readonly string[];
}

export interface TerminalDirectoryRoot {
  readonly label: string;
  readonly path: string;
}

export interface TerminalConfig {
  readonly platform: NodeJS.Platform;
  readonly defaultCwd: string;
  readonly defaultShell: string | null;
  readonly shells: readonly TerminalShell[];
  readonly roots: readonly TerminalDirectoryRoot[];
  readonly maxSessions: number;
}

export interface TerminalDirectoryEntry {
  readonly name: string;
  readonly path: string;
}

export interface TerminalDirectoryListing {
  readonly path: string;
  readonly parent: string | null;
  readonly entries: readonly TerminalDirectoryEntry[];
  readonly roots: readonly TerminalDirectoryRoot[];
}

export interface TerminalSessionMeta {
  readonly id: string;
  readonly cwd: string;
  readonly shellId: string;
  readonly shellLabel: string;
  readonly createdAt: number;
  readonly status: TerminalStatus;
  readonly cols: number;
  readonly rows: number;
  readonly exitCode?: number | undefined;
  readonly signal?: number | undefined;
}

export interface CreateTerminalSessionInput {
  readonly cwd?: string | undefined;
  readonly shellId?: string | undefined;
  readonly cols?: number | undefined;
  readonly rows?: number | undefined;
}

export interface CreateTerminalSessionResult {
  readonly session: TerminalSessionMeta;
  readonly webSocketPath: string;
}

interface TerminalManagerOptions {
  readonly env?: TerminalEnv | undefined;
  readonly defaultCwd?: string | undefined;
  readonly redactor?: ((value: unknown) => unknown) | undefined;
  readonly maxSessions?: number | undefined;
}

type ServerMessage =
  | { readonly type: "ready"; readonly session: TerminalSessionMeta }
  | { readonly type: "output"; readonly data: string }
  | { readonly type: "exit"; readonly exitCode: number; readonly signal?: number | undefined }
  | { readonly type: "error"; readonly message: string };

type ClientMessage =
  | { readonly type: "input"; readonly data: string }
  | { readonly type: "resize"; readonly cols: number; readonly rows: number };

export class TerminalError extends Error {
  public constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "TerminalError";
  }
}

class BodyTooLargeError extends Error {
  public constructor() {
    super("terminal request body too large");
    this.name = "BodyTooLargeError";
  }
}

interface TerminalRecord {
  readonly id: string;
  readonly token: string;
  readonly shell: TerminalShell;
  readonly cwd: string;
  readonly createdAt: number;
  readonly pty: IPty;
  readonly disposables: IDisposable[];
  readonly buffer: string[];
  clients: Set<WsSocket>;
  bufferBytes: number;
  status: TerminalStatus;
  cols: number;
  rows: number;
  exitCode?: number | undefined;
  signal?: number | undefined;
  idleTimer?: NodeJS.Timeout | undefined;
  cleanupTimer?: NodeJS.Timeout | undefined;
}

export interface TerminalSessionManager {
  readonly getConfig: () => TerminalConfig;
  readonly listDirectories: (pathInput?: string) => Promise<TerminalDirectoryListing>;
  readonly createSession: (input: CreateTerminalSessionInput) => Promise<CreateTerminalSessionResult>;
  readonly killSession: (sessionId: string) => boolean;
  readonly attachWebSocket: (sessionId: string, token: string, socket: WsSocket) => void;
  readonly dispose: () => void;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise<string>((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let capped = false;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_TERMINAL_BODY_BYTES) {
        if (!capped) {
          capped = true;
          chunks.length = 0;
          reject(new BodyTooLargeError());
          req.resume();
        }
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!capped) resolveBody(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });
}

async function readJsonRecord(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new TerminalError(400, "BAD_REQUEST", "Request body is not valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new TerminalError(400, "BAD_REQUEST", "Request body must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function optionalString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new TerminalError(400, "BAD_REQUEST", `Field "${key}" must be a string.`);
  }
  return value;
}

function optionalNumber(body: Record<string, unknown>, key: string): number | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TerminalError(400, "BAD_REQUEST", `Field "${key}" must be a finite number.`);
  }
  return value;
}

function terminalErrorResult(error: TerminalError): RouteResult {
  return { status: error.status, body: errorBody(error.code, error.message) };
}

async function runTerminalHandler(
  work: () => Promise<RouteResult> | RouteResult,
): Promise<RouteResult> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      return {
        status: 413,
        body: errorBody("PAYLOAD_TOO_LARGE", "Request body exceeds the size limit."),
      };
    }
    if (error instanceof TerminalError) return terminalErrorResult(error);
    throw error;
  }
}

function expandHome(input: string, home: string): string {
  if (input === "~") return home;
  if (input.startsWith("~/") || input.startsWith("~\\")) return join(home, input.slice(2));
  return input;
}

function defaultCwd(input: string | undefined): string {
  if (input !== undefined && input.length > 0 && existsSync(input)) return input;
  return process.cwd();
}

function candidateEnv(options: TerminalManagerOptions): TerminalEnv {
  return options.env ?? process.env;
}

function pathEntries(env: TerminalEnv): readonly string[] {
  const pathValue = env.PATH ?? env.Path ?? env.path ?? "";
  return pathValue.split(delimiter).filter((entry) => entry.length > 0);
}

function commandCandidates(command: string): readonly string[] {
  if (isAbsolute(command)) return [command];
  if (osPlatform() !== "win32" || /\.[A-Za-z0-9]+$/.test(command)) return [command];
  return [`${command}.exe`, `${command}.cmd`, `${command}.bat`, command];
}

function findExecutable(command: string, env: TerminalEnv): string | undefined {
  if (isAbsolute(command)) return existsSync(command) ? command : undefined;
  for (const dir of pathEntries(env)) {
    for (const candidate of commandCandidates(command)) {
      const full = join(dir, candidate);
      if (existsSync(full)) return full;
    }
  }
  return undefined;
}

interface ShellCandidate {
  readonly id: string;
  readonly label: string;
  readonly commands: readonly string[];
  readonly args?: readonly string[] | undefined;
}

function windowsShellCandidates(env: TerminalEnv): readonly ShellCandidate[] {
  const systemRoot = env.SystemRoot ?? "C:\\Windows";
  const comspec = env.COMSPEC ?? env.ComSpec;
  const cmdCommands = comspec !== undefined
    ? [comspec, join(systemRoot, "System32", "cmd.exe")]
    : [join(systemRoot, "System32", "cmd.exe")];
  return [
    { id: "pwsh", label: "PowerShell 7", commands: ["pwsh"], args: ["-NoLogo"] },
    {
      id: "powershell",
      label: "Windows PowerShell",
      commands: [join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), "powershell"],
      args: ["-NoLogo"],
    },
    { id: "cmd", label: "Command Prompt", commands: cmdCommands },
    {
      id: "git-bash",
      label: "Git Bash",
      commands: [
        "bash",
        "C:\\Program Files\\Git\\bin\\bash.exe",
        "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
      ],
    },
  ];
}

function posixShellCandidates(): readonly ShellCandidate[] {
  return [
    { id: "zsh", label: "zsh", commands: ["zsh", "/bin/zsh", "/usr/bin/zsh"] },
    { id: "bash", label: "bash", commands: ["bash", "/bin/bash", "/usr/bin/bash", "/opt/homebrew/bin/bash"] },
    {
      id: "fish",
      label: "fish",
      commands: ["fish", "/opt/homebrew/bin/fish", "/usr/local/bin/fish", "/usr/bin/fish"],
    },
    { id: "sh", label: "sh", commands: ["sh", "/bin/sh", "/usr/bin/sh"] },
  ];
}

function installedShells(env: TerminalEnv): readonly TerminalShell[] {
  const candidates = osPlatform() === "win32" ? windowsShellCandidates(env) : posixShellCandidates();
  const seen = new Set<string>();
  const shells: TerminalShell[] = [];
  for (const candidate of candidates) {
    for (const command of candidate.commands) {
      const executable = findExecutable(command, env);
      if (executable === undefined || seen.has(executable)) continue;
      seen.add(executable);
      shells.push({
        id: candidate.id,
        label: candidate.label,
        path: executable,
        args: candidate.args ?? [],
      });
      break;
    }
  }
  return shells;
}

function ensureExecutable(pathValue: string): void {
  try {
    const mode = statSync(pathValue).mode;
    if ((mode & 0o111) === 0) chmodSync(pathValue, mode | 0o755);
  } catch {
    // A non-fixable helper permission issue is surfaced by node-pty.spawn.
  }
}

function ensureNodePtySpawnHelperExecutable(): void {
  if (process.platform === "win32") return;
  try {
    const packageJson = requireFromHere.resolve("node-pty/package.json");
    const packageRoot = dirname(packageJson);
    const candidates = [
      join(packageRoot, "build", "Release", "spawn-helper"),
      join(packageRoot, "build", "Debug", "spawn-helper"),
      join(packageRoot, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper"),
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate)) ensureExecutable(candidate);
    }
  } catch {
    // Best-effort only; spawning reports a typed error if node-pty remains unusable.
  }
}

function clampInteger(value: number | undefined, min: number, max: number, fallback: number): number {
  if (value === undefined) return fallback;
  const rounded = Math.round(value);
  if (!Number.isFinite(rounded)) return fallback;
  return Math.max(min, Math.min(max, rounded));
}

function parentPath(pathValue: string): string | null {
  const parsed = parsePath(pathValue);
  return pathValue === parsed.root ? null : dirname(pathValue);
}

function rootPaths(home: string, cwd: string): readonly TerminalDirectoryRoot[] {
  const roots: TerminalDirectoryRoot[] = [
    { label: "Home", path: home },
    { label: "Current workspace", path: cwd },
  ];
  const fsRoot = parsePath(cwd).root;
  if (fsRoot.length > 0 && fsRoot !== home && fsRoot !== cwd) {
    roots.push({ label: "Filesystem root", path: fsRoot });
  }
  return roots;
}

function normalizeClientPath(pathInput: string | undefined, home: string, cwd: string): string {
  const raw = pathInput?.trim();
  const base = raw === undefined || raw.length === 0 ? cwd : expandHome(raw, home);
  return isAbsolute(base) ? base : resolve(cwd, base);
}

async function resolveDirectory(pathInput: string | undefined, home: string, cwd: string): Promise<string> {
  const candidate = normalizeClientPath(pathInput, home, cwd);
  let resolved: string;
  try {
    resolved = await realpath(candidate);
  } catch {
    throw new TerminalError(400, "INVALID_DIRECTORY", "The working directory does not exist.");
  }
  const info = await stat(resolved);
  if (!info.isDirectory()) {
    throw new TerminalError(400, "INVALID_DIRECTORY", "The working directory must be a directory.");
  }
  return resolved;
}

function encodeWsPath(sessionId: string, token: string): string {
  const id = encodeURIComponent(sessionId);
  const encodedToken = encodeURIComponent(token);
  return `/api/terminal/sessions/${id}/ws?token=${encodedToken}`;
}

function decodeWsSessionId(pathname: string): string | undefined {
  const parts = pathname.split("/");
  if (
    parts.length !== 6 ||
    parts[1] !== "api" ||
    parts[2] !== "terminal" ||
    parts[3] !== "sessions" ||
    parts[5] !== "ws" ||
    parts[4] === undefined ||
    parts[4].length === 0
  ) {
    return undefined;
  }
  try {
    return decodeURIComponent(parts[4]);
  } catch {
    return undefined;
  }
}

function rawDataToText(data: RawData): string {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data).toString("utf8");
}

function parseInputMessage(msg: Record<string, unknown>): ClientMessage | undefined {
  return msg.type === "input" && typeof msg.data === "string"
    ? { type: "input", data: msg.data }
    : undefined;
}

function parseResizeMessage(msg: Record<string, unknown>): ClientMessage | undefined {
  return msg.type === "resize" && typeof msg.cols === "number" && typeof msg.rows === "number"
    ? { type: "resize", cols: msg.cols, rows: msg.rows }
    : undefined;
}

function safeJsonParse(data: RawData, isBinary: boolean): ClientMessage | undefined {
  if (isBinary) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawDataToText(data));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const msg = parsed as Record<string, unknown>;
  return parseInputMessage(msg) ?? parseResizeMessage(msg);
}

function sendJson(socket: WsSocket, message: ServerMessage): void {
  if (socket.readyState !== socket.OPEN) return;
  socket.send(JSON.stringify(message), { binary: false });
}

function rejectUpgrade(socket: Duplex, status: number, message: string): void {
  socket.write(`HTTP/1.1 ${String(status)} ${message}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

export class PtyTerminalSessionManager implements TerminalSessionManager {
  private readonly env: TerminalEnv;
  private readonly maxSessions: number;
  private readonly home: string;
  private readonly cwd: string;
  private readonly redactor: (value: unknown) => unknown;
  private readonly sessions = new Map<string, TerminalRecord>();

  public constructor(options: TerminalManagerOptions = {}) {
    ensureNodePtySpawnHelperExecutable();
    this.env = candidateEnv(options);
    this.maxSessions = options.maxSessions ?? MAX_ACTIVE_SESSIONS;
    this.home = homedir();
    this.cwd = defaultCwd(options.defaultCwd);
    this.redactor = options.redactor ?? ((value: unknown): unknown => value);
  }

  public readonly getConfig = (): TerminalConfig => {
    const shells = installedShells(this.env);
    return {
      platform: process.platform,
      defaultCwd: this.cwd,
      defaultShell: shells[0]?.id ?? null,
      shells,
      roots: rootPaths(this.home, this.cwd),
      maxSessions: this.maxSessions,
    };
  };

  public readonly listDirectories = async (
    pathInput?: string,
  ): Promise<TerminalDirectoryListing> => {
    const pathValue = await resolveDirectory(pathInput, this.home, this.cwd);
    const entries = await readdir(pathValue, { withFileTypes: true });
    const dirs = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({ name: entry.name, path: join(pathValue, entry.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return {
      path: pathValue,
      parent: parentPath(pathValue),
      entries: dirs,
      roots: rootPaths(this.home, this.cwd),
    };
  };

  public readonly createSession = async (
    input: CreateTerminalSessionInput,
  ): Promise<CreateTerminalSessionResult> => {
    if (this.runningSessionCount() >= this.maxSessions) {
      throw new TerminalError(429, "TOO_MANY_TERMINALS", "The active terminal limit is reached.");
    }
    const config = this.getConfig();
    if (config.shells.length === 0) {
      throw new TerminalError(503, "NO_SHELL", "No supported local shell is available.");
    }
    const shellId = input.shellId ?? config.defaultShell ?? "";
    const shell = config.shells.find((candidate) => candidate.id === shellId);
    if (shell === undefined) {
      throw new TerminalError(400, "INVALID_SHELL", "The requested shell is not available.");
    }
    const cwd = await resolveDirectory(input.cwd, this.home, this.cwd);
    const cols = clampInteger(input.cols, 20, 300, DEFAULT_COLS);
    const rows = clampInteger(input.rows, 6, 120, DEFAULT_ROWS);
    const id = randomUUID();
    const token = randomBytes(32).toString("base64url");
    const record = this.spawnRecord({ id, token, shell, cwd, cols, rows });
    this.sessions.set(id, record);
    this.scheduleIdleCleanup(record, SESSION_IDLE_TTL_MS);
    return { session: this.meta(record), webSocketPath: encodeWsPath(id, token) };
  };

  public readonly killSession = (sessionId: string): boolean => {
    const record = this.sessions.get(sessionId);
    if (record === undefined) return false;
    this.terminate(record, "SIGHUP");
    return true;
  };

  public readonly attachWebSocket = (sessionId: string, token: string, socket: WsSocket): void => {
    const record = this.sessions.get(sessionId);
      if (record?.token !== token) {
      sendJson(socket, { type: "error", message: "Terminal session is not available." });
      socket.close(1008, "invalid terminal session");
      return;
    }
    if (record.status !== "running") {
      sendJson(socket, { type: "ready", session: this.meta(record) });
      sendJson(socket, { type: "exit", exitCode: record.exitCode ?? 0, signal: record.signal });
      socket.close(1000, "terminal exited");
      return;
    }
    record.clients.add(socket);
    this.clearIdleCleanup(record);
    sendJson(socket, { type: "ready", session: this.meta(record) });
    for (const chunk of record.buffer) {
      sendJson(socket, { type: "output", data: chunk });
    }
    socket.on("message", (data, isBinary) => {
      this.handleClientMessage(record, socket, data, isBinary);
    });
    socket.on("close", () => {
      this.detachClient(record, socket);
    });
    socket.on("error", () => {
      this.detachClient(record, socket);
    });
  };

  public readonly dispose = (): void => {
    for (const record of [...this.sessions.values()]) {
      this.terminate(record, "SIGHUP");
    }
    this.sessions.clear();
  };

  private runningSessionCount(): number {
    let count = 0;
    for (const record of this.sessions.values()) {
      if (record.status === "running") count += 1;
    }
    return count;
  }

  private spawnRecord(args: {
    readonly id: string;
    readonly token: string;
    readonly shell: TerminalShell;
    readonly cwd: string;
    readonly cols: number;
    readonly rows: number;
  }): TerminalRecord {
    const ptyProcess = this.spawnPtyProcess(args);
    const record = this.buildRecord(args, ptyProcess);
    record.disposables.push(ptyProcess.onData((data) => {
      this.handlePtyData(record, data);
    }));
    record.disposables.push(ptyProcess.onExit((exit) => {
      this.handlePtyExit(record, exit.exitCode, exit.signal);
    }));
    return record;
  }

  private spawnPtyProcess(args: {
    readonly shell: TerminalShell;
    readonly cwd: string;
    readonly cols: number;
    readonly rows: number;
  }): IPty {
    const env = { ...this.env, TERM: "xterm-256color", COLORTERM: "truecolor" };
    const ptyOptions: pty.IPtyForkOptions | pty.IWindowsPtyForkOptions = {
      name: "xterm-256color",
      cols: args.cols,
      rows: args.rows,
      cwd: args.cwd,
      env,
    };
    if (process.platform === "win32") {
      (ptyOptions as pty.IWindowsPtyForkOptions).useConpty = true;
    }
    try {
      return pty.spawn(args.shell.path, [...args.shell.args], ptyOptions);
    } catch {
      throw new TerminalError(500, "TERMINAL_SPAWN_FAILED", "The terminal process could not be started.");
    }
  }

  private buildRecord(
    args: {
      readonly id: string;
      readonly token: string;
      readonly shell: TerminalShell;
      readonly cwd: string;
      readonly cols: number;
      readonly rows: number;
    },
    ptyProcess: IPty,
  ): TerminalRecord {
    return {
      id: args.id,
      token: args.token,
      shell: args.shell,
      cwd: args.cwd,
      createdAt: Date.now(),
      pty: ptyProcess,
      disposables: [],
      buffer: [],
      clients: new Set<WsSocket>(),
      bufferBytes: 0,
      status: "running",
      cols: args.cols,
      rows: args.rows,
    };
  }

  private meta(record: TerminalRecord): TerminalSessionMeta {
    return {
      id: record.id,
      cwd: record.cwd,
      shellId: record.shell.id,
      shellLabel: record.shell.label,
      createdAt: record.createdAt,
      status: record.status,
      cols: record.cols,
      rows: record.rows,
      exitCode: record.exitCode,
      signal: record.signal,
    };
  }

  private handlePtyData(record: TerminalRecord, data: string): void {
    const redacted = this.redactor(data);
    const chunk = typeof redacted === "string" ? redacted : data;
    record.buffer.push(chunk);
    record.bufferBytes += Buffer.byteLength(chunk, "utf8");
    while (record.buffer.length > MAX_OUTPUT_CHUNKS || record.bufferBytes > MAX_OUTPUT_BYTES) {
      const removed = record.buffer.shift();
      if (removed === undefined) break;
      record.bufferBytes -= Buffer.byteLength(removed, "utf8");
    }
    this.broadcast(record, { type: "output", data: chunk });
  }

  private handlePtyExit(record: TerminalRecord, exitCode: number, signal: number | undefined): void {
    if (record.status === "exited") return;
    record.status = "exited";
    record.exitCode = exitCode;
    record.signal = signal;
    this.broadcast(record, { type: "exit", exitCode, signal });
    for (const client of record.clients) {
      client.close(1000, "terminal exited");
    }
    record.clients.clear();
    this.clearIdleCleanup(record);
    record.cleanupTimer = setTimeout(() => {
      this.cleanup(record);
    }, EXITED_SESSION_TTL_MS);
  }

  private handleClientMessage(
    record: TerminalRecord,
    socket: WsSocket,
    data: RawData,
    isBinary: boolean,
  ): void {
    const message = safeJsonParse(data, isBinary);
    if (message === undefined) {
      sendJson(socket, { type: "error", message: "Invalid terminal WebSocket message." });
      return;
    }
    if (message.type === "input") {
      if (Buffer.byteLength(message.data, "utf8") > MAX_INPUT_BYTES) {
        sendJson(socket, { type: "error", message: "Terminal input exceeds the size limit." });
        return;
      }
      record.pty.write(message.data);
      return;
    }
    const cols = clampInteger(message.cols, 20, 300, record.cols);
    const rows = clampInteger(message.rows, 6, 120, record.rows);
    try {
      record.pty.resize(cols, rows);
      record.cols = cols;
      record.rows = rows;
    } catch {
      sendJson(socket, { type: "error", message: "Terminal resize failed." });
    }
  }

  private detachClient(record: TerminalRecord, socket: WsSocket): void {
    record.clients.delete(socket);
    if (record.clients.size === 0 && record.status === "running") {
      this.scheduleIdleCleanup(record, SESSION_IDLE_TTL_MS);
    }
  }

  private broadcast(record: TerminalRecord, message: ServerMessage): void {
    for (const client of [...record.clients]) {
      sendJson(client, message);
    }
  }

  private scheduleIdleCleanup(record: TerminalRecord, delayMs: number): void {
    this.clearIdleCleanup(record);
    record.idleTimer = setTimeout(() => {
      if (record.clients.size === 0 && record.status === "running") {
        this.terminate(record, "SIGHUP");
      }
    }, delayMs);
  }

  private clearIdleCleanup(record: TerminalRecord): void {
    if (record.idleTimer !== undefined) {
      clearTimeout(record.idleTimer);
      record.idleTimer = undefined;
    }
  }

  private terminate(record: TerminalRecord, signal: string): void {
    this.clearIdleCleanup(record);
    if (record.cleanupTimer !== undefined) {
      clearTimeout(record.cleanupTimer);
      record.cleanupTimer = undefined;
    }
    for (const client of record.clients) {
      client.close(1000, "terminal closed");
    }
    record.clients.clear();
    try {
      if (process.platform === "win32") record.pty.kill();
      else record.pty.kill(signal);
    } catch {
      // The PTY may already be gone; cleanup below remains idempotent.
    }
    this.cleanup(record);
  }

  private cleanup(record: TerminalRecord): void {
    this.clearIdleCleanup(record);
    if (record.cleanupTimer !== undefined) {
      clearTimeout(record.cleanupTimer);
      record.cleanupTimer = undefined;
    }
    for (const disposable of record.disposables.splice(0)) {
      try {
        disposable.dispose();
      } catch {
        // Best-effort listener disposal only.
      }
    }
    this.sessions.delete(record.id);
  }
}

export function createPtyTerminalSessionManager(
  options: TerminalManagerOptions = {},
): TerminalSessionManager {
  return new PtyTerminalSessionManager(options);
}

const terminalManagers = new WeakMap<UiHandlerDeps, TerminalSessionManager>();

function terminalForDeps(deps: UiHandlerDeps): TerminalSessionManager {
  if (deps.terminal !== undefined) return deps.terminal;
  const existing = terminalManagers.get(deps);
  if (existing !== undefined) return existing;
  const created = createPtyTerminalSessionManager({
    env: deps.env,
    redactor: deps.redactor,
  });
  terminalManagers.set(deps, created);
  return created;
}

export function handleTerminalShells(_ctx: RouteContext, deps: UiHandlerDeps): RouteResult {
  return { status: 200, body: terminalForDeps(deps).getConfig() };
}

export async function handleTerminalDirectories(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  return runTerminalHandler(async () => {
    const requestedPath = ctx.url.searchParams.get("path") ?? undefined;
    const listing = await terminalForDeps(deps).listDirectories(requestedPath);
    return { status: 200, body: listing };
  });
}

export async function handleCreateTerminalSession(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  return runTerminalHandler(async () => {
    const body = await readJsonRecord(ctx.req);
    const session = await terminalForDeps(deps).createSession({
      cwd: optionalString(body, "cwd"),
      shellId: optionalString(body, "shellId"),
      cols: optionalNumber(body, "cols"),
      rows: optionalNumber(body, "rows"),
    });
    return { status: 201, body: session };
  });
}

export function handleDeleteTerminalSession(ctx: RouteContext, deps: UiHandlerDeps): RouteResult {
  const killed = terminalForDeps(deps).killSession(ctx.params.sessionId ?? "");
  return killed
    ? { status: 200, body: { ok: true } }
    : { status: 404, body: errorBody("NOT_FOUND", "Terminal session not found.") };
}

export interface TerminalWebSocketGateway {
  readonly handleUpgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => boolean;
  readonly close: () => void;
}

export function createTerminalWebSocketGateway(
  deps: UiHandlerDeps,
  expectedPort: number,
): TerminalWebSocketGateway {
  const wss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload: WS_MAX_PAYLOAD_BYTES,
  });
  const manager = terminalForDeps(deps);

  return {
    handleUpgrade: (req, socket, head): boolean => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const sessionId = decodeWsSessionId(url.pathname);
      if (sessionId === undefined) return false;
      if (!isAllowedHost(req, expectedPort)) {
        rejectUpgrade(socket, 403, "Forbidden");
        return true;
      }
      const token = url.searchParams.get("token") ?? "";
      wss.handleUpgrade(req, socket, head, (ws) => {
        manager.attachWebSocket(sessionId, token, ws);
      });
      return true;
    },
    close: (): void => {
      wss.close();
      manager.dispose();
    },
  };
}
