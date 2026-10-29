import type { ChildProcessWithoutNullStreams } from "node:child_process";
import spawn from "cross-spawn";
import type { Readable, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { MCP_STDIO_ENV_PREFIX } from "./owned-stdio.js";

export function ownedStdioEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(environment)) {
    if (!key.startsWith(MCP_STDIO_ENV_PREFIX)) continue;
    const entry: unknown = JSON.parse(value ?? "");
    if (
      !Array.isArray(entry) ||
      entry.length !== 2 ||
      typeof entry[0] !== "string" ||
      typeof entry[1] !== "string"
    )
      throw new TypeError("Invalid local process environment");
    Object.defineProperty(result, entry[0], { value: entry[1], enumerable: true });
  }
  return result;
}

function signalGroup(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

async function stopGroup(pid: number | undefined): Promise<void> {
  if (pid === undefined || pid <= 1 || !signalGroup(pid, "SIGTERM")) return;
  // Keep the owner alive through escalation even after the provider exits or closes its pipes.
  await delay(150);
  signalGroup(pid, "SIGKILL");
}

interface OwnedStdioOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly input: Readable;
  readonly output: Writable;
  readonly errors: Writable;
  readonly signal: AbortSignal;
  readonly stopOwner?: (code: number) => never;
}

export async function runOwnedStdio(options: OwnedStdioOptions): Promise<number> {
  if (options.signal.aborted || options.input.readableEnded) return 1;
  const child = spawn(options.command, [...options.args], {
    env: options.environment,
    detached: options.stopOwner === undefined,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;
  let stopping: Promise<boolean> | undefined;
  const stop = (): void => {
    if (options.stopOwner !== undefined) options.stopOwner(0);
    stopping ??= stopGroup(child.pid).then(
      () => false,
      () => true,
    );
  };
  const completed = new Promise<number>((resolve) => {
    child.once("error", () => {
      resolve(1);
    });
    child.once("close", (code) => {
      resolve(code ?? 1);
    });
  });
  child.once("exit", stop);
  options.signal.addEventListener("abort", stop, { once: true });
  options.input.once("end", stop);
  const unwire = wireStdio(child, options, stop);
  try {
    const code = await completed;
    stop();
    if ((await stopping) === true) throw new Error("Local process cleanup failed");
    return code;
  } finally {
    options.signal.removeEventListener("abort", stop);
    options.input.off("end", stop).unpipe(child.stdin);
    unwire();
  }
}

function wireStdio(
  child: ChildProcessWithoutNullStreams,
  options: OwnedStdioOptions,
  stop: () => void,
): () => void {
  const streams = [
    options.input,
    options.output,
    options.errors,
    child.stdin,
    child.stdout,
    child.stderr,
  ];
  for (const stream of streams) stream.on("error", stop);
  options.input.pipe(child.stdin);
  child.stdout.pipe(options.output, { end: false });
  child.stderr.pipe(options.errors, { end: false });
  return (): void => {
    child.stdout.unpipe(options.output);
    child.stderr.unpipe(options.errors);
    for (const stream of streams) stream.off("error", stop);
  };
}
