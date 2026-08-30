// Controllable in-memory fake LSP process (Issue #1381, Epic #1491, ADR-0069 D7). It satisfies the
// `LspSpawnHandle & kill/onExit/onError` shape via three PassThrough streams — NO real subprocess —
// so every manager branch (initialize, request, timeout, oversized frame, crash, ignore-shutdown) is
// exercised deterministically with an injected clock. This is the shared harness Stage C/D reuse; it
// is committed as a non-test module so other test files can import it without a `.test` collision.

import { PassThrough } from "node:stream";

import { createLspFrameReader, writeLspFrame } from "../lspFrameCodec.js";
import type { LspBytes } from "../lspFrameCodec.js";
import type { LspProcessKillResult } from "../lspNodeAdapter.js";
import type { LspSpawnHandle } from "../lspTransport.js";

// "unresponsive" answers `initialize` (so the manager reaches READY) but ignores BOTH the `shutdown`
// request AND the `exit` notification, so it never goes down on its own — the only way to terminate it
// is the manager's SIGKILL escalation. "ignore-shutdown" ignores only `shutdown` but still exits on
// `exit`, modelling a well-behaved server that simply never answers the shutdown RPC.
// "unresponsive-request" answers `initialize` normally (so the manager reaches READY quickly) but
// silently drops every other id-bearing request, modelling a provider that hangs mid-operation —
// this reproduces the manager's real per-request `requestTimeoutMs` deadline deterministically,
// without paying the much larger `initializeTimeoutMs` wait that "slow" would incur.
export type FakeLspBehavior =
  "normal" | "slow" | "oversized" | "ignore-shutdown" | "unresponsive" | "unresponsive-request";

// The spawn-handle surface a manager adapter consumes: the structural stdio handle plus lifecycle
// hooks. Mirrors the node adapter's `LspSpawnFn` return so the fake is a drop-in for the manager.
interface FakeLspSpawnHandle extends LspSpawnHandle {
  kill(signal: NodeJS.Signals): void;
  lastKillResult(): LspProcessKillResult | undefined;
  onExit(callback: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  onError(callback: (error: Error) => void): void;
}

export interface FakeLspOptions {
  readonly behavior?: FakeLspBehavior;
  // Defaults to the historical synchronous confirmation. Set false to model a real kill request
  // whose OS exit notification arrives later (or never), so ownership/reaper tests cannot mistake
  // requested SIGKILL for confirmed exit.
  readonly killConfirmsExit?: boolean;
  // Defaults to confirmed containment only for SIGKILL; SIGTERM alone remains unconfirmed. Override
  // to model a failed/refused Windows tree kill where the cmd.exe wrapper can exit while its
  // language-server grandchild survives.
  readonly killResult?: LspProcessKillResult | undefined;
  // `null` selects an undefined handle pid, modelling Node's asynchronous pre-spawn ENOENT shape:
  // the ChildProcess emits `error`, never acquired an OS pid, and will not later emit `exit`.
  readonly pid?: number | null | undefined;
  // The byte size the `oversized` behavior declares in its Content-Length header (defaults to a value
  // intentionally larger than any test's maxFrameBytes).
  readonly oversizedContentLength?: number;
  // A sentinel string the security tests inject into a response payload AND the stderr stream to prove
  // it never crosses a content-free boundary (ADR-0069 AC3 / D6).
  readonly sentinel?: string;
  // Fixed result objects keyed by LSP method, returned verbatim for `normal` behavior.
  readonly results?: Readonly<Record<string, unknown>>;
  readonly initializeResult?: unknown;
  readonly onMessage?: ((method: string, params: unknown) => void) | undefined;
}

interface JsonRpcMessage {
  readonly id?: number;
  readonly method?: string;
  readonly params?: unknown;
}

export interface FakeLspController {
  readonly handle: FakeLspSpawnHandle;
  // Emits raw stderr bytes (counted, never stored by the transport) — used to prove the count
  // advances and the content never leaks.
  emitStderr(text: string): void;
  // Simulates a mid-session crash: emits an exit event and ends the streams.
  crash(code?: number): void;
  // Re-invokes the exit callbacks bypassing the once-guard, modelling a LATE OS exit/error event from
  // a child that has already been superseded by a restart (real ChildProcess can fire both `error`
  // and `exit`). Used to prove the manager discards a stale-generation crash (FIX 4).
  emitLateExit(code?: number): void;
  emitError(error?: Error): void;
  confirmExit(signal?: NodeJS.Signals): void;
  killed(): readonly NodeJS.Signals[];
  exitEmitted(): boolean;
  receivedMethods(): readonly string[];
}

export function createFakeLspProcess(options: FakeLspOptions = {}): FakeLspController {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const behavior = options.behavior ?? "normal";
  const killedSignals: NodeJS.Signals[] = [];
  const exitCallbacks: ((code: number | null, signal: NodeJS.Signals | null) => void)[] = [];
  const errorCallbacks: ((error: Error) => void)[] = [];
  let exitEmitted = false;
  const receivedMethods: string[] = [];

  const emitExit = (code: number | null, signal: NodeJS.Signals | null): void => {
    if (exitEmitted) return;
    exitEmitted = true;
    for (const callback of exitCallbacks) callback(code, signal);
    stdout.end();
    stderr.end();
  };

  void runResponder(stdin, stdout, behavior, options, emitExit, (method) => {
    receivedMethods.push(method);
  });
  if (options.sentinel !== undefined && behavior !== "oversized") {
    stderr.write(Buffer.from(options.sentinel, "utf8"));
  }

  const handle = fakeSpawnHandle(
    stdin,
    stdout,
    stderr,
    killedSignals,
    exitCallbacks,
    errorCallbacks,
    emitExit,
    options.killConfirmsExit ?? true,
    options.killResult,
    options.pid === null ? undefined : (options.pid ?? 4242),
  );

  return fakeController(handle, stderr, exitCallbacks, errorCallbacks, emitExit, {
    killedSignals,
    receivedMethods,
    exitEmitted: (): boolean => exitEmitted,
  });
}

function fakeController(
  handle: FakeLspSpawnHandle,
  stderr: PassThrough,
  exitCallbacks: ((code: number | null, signal: NodeJS.Signals | null) => void)[],
  errorCallbacks: ((error: Error) => void)[],
  emitExit: ExitFn,
  state: {
    readonly killedSignals: NodeJS.Signals[];
    readonly receivedMethods: string[];
    readonly exitEmitted: () => boolean;
  },
): FakeLspController {
  return {
    handle,
    emitStderr: (text): void => {
      stderr.write(Buffer.from(text, "utf8"));
    },
    crash: (code = 1): void => {
      emitExit(code, null);
    },
    emitLateExit: (code = 1): void => {
      for (const callback of exitCallbacks) callback(code, null);
    },
    emitError: (error = new Error("fake child error")): void => {
      for (const callback of errorCallbacks) callback(error);
    },
    confirmExit: (signal = "SIGKILL"): void => {
      emitExit(null, signal);
    },
    killed: (): readonly NodeJS.Signals[] => state.killedSignals,
    exitEmitted: state.exitEmitted,
    receivedMethods: (): readonly string[] => state.receivedMethods,
  };
}

function fakeSpawnHandle(
  stdin: PassThrough,
  stdout: PassThrough,
  stderr: PassThrough,
  killedSignals: NodeJS.Signals[],
  exitCallbacks: ((code: number | null, signal: NodeJS.Signals | null) => void)[],
  errorCallbacks: ((error: Error) => void)[],
  emitExit: ExitFn,
  killConfirmsExit: boolean,
  killResult: LspProcessKillResult | undefined,
  pid: number | undefined,
): FakeLspSpawnHandle {
  let latestKillResult: LspProcessKillResult | undefined;
  return {
    stdin,
    stdout,
    stderr,
    pid,
    kill: (signal): void => {
      killedSignals.push(signal);
      latestKillResult =
        killResult ??
        (signal === "SIGKILL"
          ? { treeContainment: "confirmed", windowsTreeKill: "not-attempted" }
          : { treeContainment: "unconfirmed", windowsTreeKill: "not-attempted" });
      if (signal === "SIGKILL" && killConfirmsExit) emitExit(null, "SIGKILL");
    },
    lastKillResult: (): LspProcessKillResult | undefined => latestKillResult,
    onExit: (callback): void => {
      exitCallbacks.push(callback);
    },
    onError: (callback): void => {
      errorCallbacks.push(callback);
    },
  };
}

type ExitFn = (code: number | null, signal: NodeJS.Signals | null) => void;

// Reads framed JSON-RPC requests from the client's stdin and replies on stdout per the behavior. It
// owns the `initialize`/`shutdown`/`exit` lifecycle plus arbitrary request echo for `normal`.
async function runResponder(
  stdin: PassThrough,
  stdout: PassThrough,
  behavior: FakeLspBehavior,
  options: FakeLspOptions,
  emitExit: ExitFn,
  onMethod: (method: string) => void,
): Promise<void> {
  const reader = createLspFrameReader(stdin, 64 * 1024 * 1024);
  try {
    for await (const body of reader) {
      handleRequest(parse(body), stdout, behavior, options, emitExit, onMethod);
    }
  } catch {
    // Stream closed (dispose/crash); nothing further to read.
  }
}

function handleRequest(
  message: JsonRpcMessage | null,
  stdout: PassThrough,
  behavior: FakeLspBehavior,
  options: FakeLspOptions,
  emitExit: ExitFn,
  onMethod: (method: string) => void,
): void {
  if (message?.method === undefined) return;
  onMethod(message.method);
  options.onMessage?.(message.method, message.params);
  if (message.method === "exit") {
    // "unresponsive" never goes down on its own — it ignores `exit`, so only SIGKILL terminates it.
    if (behavior !== "unresponsive") emitExit(0, null);
    return;
  }
  if (message.id === undefined) return;
  respond(message.id, message.method, stdout, behavior, options);
}

function respond(
  id: number,
  method: string,
  stdout: PassThrough,
  behavior: FakeLspBehavior,
  options: FakeLspOptions,
): void {
  if (behavior === "slow") return;
  if (behavior === "unresponsive-request" && method !== "initialize") return;
  if (method === "shutdown" && (behavior === "ignore-shutdown" || behavior === "unresponsive")) {
    return;
  }
  if (behavior === "oversized") {
    writeOversizedFrame(stdout, options.oversizedContentLength ?? 64 * 1024 * 1024);
    return;
  }
  writeLspFrame(stdout, JSON.stringify(buildResponse(id, method, options)));
}

function buildResponse(
  id: number,
  method: string,
  options: FakeLspOptions,
): Record<string, unknown> {
  return { jsonrpc: "2.0", id, result: resultFor(method, options) };
}

function resultFor(method: string, options: FakeLspOptions): unknown {
  if (method === "initialize") {
    return (
      options.initializeResult ?? {
        capabilities: {
          textDocumentSync: 2,
          diagnosticProvider: true,
          completionProvider: {},
          hoverProvider: true,
          documentSymbolProvider: true,
          documentFormattingProvider: true,
        },
        ...sentinelPayload(options),
      }
    );
  }
  if (method === "shutdown") {
    return null;
  }
  const fixed = options.results?.[method];
  return fixed ?? { method, ...sentinelPayload(options) };
}

function sentinelPayload(options: FakeLspOptions): Record<string, string> {
  return options.sentinel !== undefined ? { note: options.sentinel } : {};
}

// Writes a header declaring a body larger than the body actually sent: the manager's frame reader
// must reject on the declared Content-Length BEFORE reading the body (ADR-0069 I3), so the short body
// here is never consumed.
function writeOversizedFrame(stdout: PassThrough, contentLength: number): void {
  stdout.write(Buffer.from(`Content-Length: ${String(contentLength)}\r\n\r\n`, "ascii"));
}

function parse(body: LspBytes): JsonRpcMessage | null {
  try {
    const parsed: unknown = JSON.parse(body.toString("utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    return parsed;
  } catch {
    return null;
  }
}
