// Controllable in-memory fake LSP process (Issue #1381, Epic #1491, ADR-0069 D7). It satisfies the
// `LspSpawnHandle & kill/onExit/onError` shape via three PassThrough streams — NO real subprocess —
// so every manager branch (initialize, request, timeout, oversized frame, crash, ignore-shutdown) is
// exercised deterministically with an injected clock. This is the shared harness Stage C/D reuse; it
// is committed as a non-test module so other test files can import it without a `.test` collision.

import { PassThrough } from "node:stream";

import { createLspFrameReader, writeLspFrame } from "../lspFrameCodec.js";
import type { LspBytes } from "../lspFrameCodec.js";
import type { LspSpawnHandle } from "../lspTransport.js";

export type FakeLspBehavior = "normal" | "slow" | "oversized" | "crash" | "ignore-shutdown";

// The spawn-handle surface a manager adapter consumes: the structural stdio handle plus lifecycle
// hooks. Mirrors the node adapter's `LspSpawnFn` return so the fake is a drop-in for the manager.
export interface FakeLspSpawnHandle extends LspSpawnHandle {
  kill(signal: NodeJS.Signals): void;
  onExit(callback: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  onError(callback: (error: Error) => void): void;
}

export interface FakeLspOptions {
  readonly behavior?: FakeLspBehavior;
  // The byte size the `oversized` behavior declares in its Content-Length header (defaults to a value
  // intentionally larger than any test's maxFrameBytes).
  readonly oversizedContentLength?: number;
  // A sentinel string the security tests inject into a response payload AND the stderr stream to prove
  // it never crosses a content-free boundary (ADR-0069 AC3 / D6).
  readonly sentinel?: string;
  // Fixed result objects keyed by LSP method, returned verbatim for `normal` behavior.
  readonly results?: Readonly<Record<string, unknown>>;
}

interface JsonRpcMessage {
  readonly id?: number;
  readonly method?: string;
}

export interface FakeLspController {
  readonly handle: FakeLspSpawnHandle;
  // Emits raw stderr bytes (counted, never stored by the transport) — used to prove the count
  // advances and the content never leaks.
  emitStderr(text: string): void;
  // Simulates a mid-session crash: emits an exit event and ends the streams.
  crash(code?: number): void;
  killed(): readonly NodeJS.Signals[];
  exitEmitted(): boolean;
}

export function createFakeLspProcess(options: FakeLspOptions = {}): FakeLspController {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const behavior = options.behavior ?? "normal";
  const killedSignals: NodeJS.Signals[] = [];
  const exitCallbacks: ((code: number | null, signal: NodeJS.Signals | null) => void)[] = [];
  let exitEmitted = false;

  const emitExit = (code: number | null, signal: NodeJS.Signals | null): void => {
    if (exitEmitted) return;
    exitEmitted = true;
    for (const callback of exitCallbacks) callback(code, signal);
    stdout.end();
    stderr.end();
  };

  void runResponder(stdin, stdout, behavior, options, emitExit);
  if (options.sentinel !== undefined && behavior !== "oversized") {
    stderr.write(Buffer.from(options.sentinel, "utf8"));
  }

  const handle: FakeLspSpawnHandle = {
    stdin,
    stdout,
    stderr,
    pid: 4242,
    kill: (signal): void => {
      killedSignals.push(signal);
      if (signal === "SIGKILL") emitExit(null, "SIGKILL");
    },
    onExit: (callback): void => {
      exitCallbacks.push(callback);
    },
    onError: (): void => {
      // The fake never emits a spawn-time error; SPAWN_FAILED is exercised via a throwing spawn fn.
    },
  };

  return {
    handle,
    emitStderr: (text): void => {
      stderr.write(Buffer.from(text, "utf8"));
    },
    crash: (code = 1): void => {
      emitExit(code, null);
    },
    killed: (): readonly NodeJS.Signals[] => killedSignals,
    exitEmitted: (): boolean => exitEmitted,
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
): Promise<void> {
  const reader = createLspFrameReader(stdin, 64 * 1024 * 1024);
  try {
    for await (const body of reader) {
      handleRequest(parse(body), stdout, behavior, options, emitExit);
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
): void {
  if (message?.method === undefined) return;
  if (message.method === "exit") {
    emitExit(0, null);
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
  if (method === "shutdown" && behavior === "ignore-shutdown") return;
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
    return { capabilities: {}, ...sentinelPayload(options) };
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
