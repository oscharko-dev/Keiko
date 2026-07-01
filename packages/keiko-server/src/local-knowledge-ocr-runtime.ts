import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type {
  TesseractCommandRequest,
  TesseractCommandResult,
} from "@oscharko-dev/keiko-local-knowledge";

const MAX_STDOUT_BYTES = 8 * 1024 * 1024;
const MAX_STDERR_BYTES = 16 * 1024;

interface SpawnState {
  stdoutBytes: number;
  stderrBytes: number;
  timedOut: boolean;
  settled: boolean;
  error: unknown;
}

interface SpawnHandlerContext {
  readonly child: ChildProcessWithoutNullStreams;
  readonly request: TesseractCommandRequest;
  readonly state: SpawnState;
  readonly stdout: Buffer[];
  readonly timer: ReturnType<typeof setTimeout>;
  readonly onAbort: () => void;
  readonly finish: (result: TesseractCommandResult) => void;
}

function appendLimited(
  chunks: Buffer[],
  currentBytes: number,
  chunk: Buffer,
  limitBytes: number,
): number {
  const remaining = limitBytes - currentBytes;
  if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
  return Math.min(limitBytes, currentBytes + chunk.byteLength);
}

function countLimited(currentBytes: number, chunk: Buffer, limitBytes: number): number {
  return Math.min(limitBytes, currentBytes + chunk.byteLength);
}

function mapProcessResult(
  code: number | null,
  state: SpawnState,
  stdout: readonly Buffer[],
): TesseractCommandResult {
  if (state.timedOut) return { ok: false, reason: "timeout" };
  if (state.error !== undefined) return { ok: false, reason: "engine-error" };
  if (code === 0) return { ok: true, stdout: Buffer.concat(stdout) };
  return { ok: false, reason: "unsupported-input" };
}

function settleProcessError(ctx: SpawnHandlerContext, error: unknown): void {
  ctx.state.error = error;
  clearTimeout(ctx.timer);
  ctx.request.signal?.removeEventListener("abort", ctx.onAbort);
  ctx.finish({ ok: false, reason: "engine-error" });
}

function attachSpawnHandlers(ctx: SpawnHandlerContext): void {
  ctx.child.stdin.on("error", (error: unknown) => {
    ctx.state.error = error;
  });
  ctx.child.stdout.on("data", (chunk: Buffer) => {
    ctx.state.stdoutBytes = appendLimited(ctx.stdout, ctx.state.stdoutBytes, chunk, MAX_STDOUT_BYTES);
  });
  ctx.child.stdout.on("error", (error: unknown) => {
    ctx.state.error = error;
  });
  ctx.child.stderr.on("data", (chunk: Buffer) => {
    ctx.state.stderrBytes = countLimited(ctx.state.stderrBytes, chunk, MAX_STDERR_BYTES);
  });
  ctx.child.stderr.on("error", (error: unknown) => {
    ctx.state.error = error;
  });
  ctx.child.on("error", (error: unknown) => {
    settleProcessError(ctx, error);
  });
  ctx.child.on("close", (code) => {
    clearTimeout(ctx.timer);
    ctx.request.signal?.removeEventListener("abort", ctx.onAbort);
    ctx.finish(mapProcessResult(code, ctx.state, ctx.stdout));
  });
}

export function runLocalTesseractCommand(
  request: TesseractCommandRequest,
): Promise<TesseractCommandResult> {
  if (request.signal?.aborted === true) return Promise.resolve({ ok: false, reason: "timeout" });
  return new Promise<TesseractCommandResult>((resolve) => {
    const stdout: Buffer[] = [];
    const state: SpawnState = {
      stdoutBytes: 0,
      stderrBytes: 0,
      timedOut: false,
      settled: false,
      error: undefined,
    };
    const child = spawn(request.command, request.args, { stdio: ["pipe", "pipe", "pipe"] });
    const finish = (result: TesseractCommandResult): void => {
      if (state.settled) return;
      state.settled = true;
      resolve(result);
    };
    const timer = setTimeout(() => {
      state.timedOut = true;
      child.kill("SIGKILL");
    }, request.timeoutMs);
    const onAbort = (): void => {
      state.timedOut = true;
      child.kill("SIGKILL");
    };
    request.signal?.addEventListener("abort", onAbort, { once: true });
    attachSpawnHandlers({ child, request, state, stdout, timer, onAbort, finish });
    child.stdin.end(Buffer.from(request.stdin));
  });
}
