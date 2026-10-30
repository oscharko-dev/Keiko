import { realpathSync } from "node:fs";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { ownedStdioEnvironment, runOwnedStdio } from "./owned-stdio-process.js";
import { supportsOwnedMcpStdio } from "./owned-stdio.js";

interface WorkerRuntime {
  readonly args: readonly string[];
  readonly environment: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  readonly input: Readable;
  readonly output: Writable;
  readonly errors: Writable;
  readonly observeStop: (stop: () => void) => () => void;
  readonly stopOwner: (code: number) => never;
}

export async function runOwnedStdioWorker(runtime: WorkerRuntime): Promise<number> {
  const lifetime = new AbortController();
  const unobserve = runtime.observeStop(() => {
    lifetime.abort();
  });
  const parameters = [...runtime.args];
  const nativeJob = runtime.platform === "win32" && parameters[0] === "--native-job";
  if (nativeJob) parameters.shift();
  const [command, ...args] = parameters;
  try {
    if (!supportsOwnedMcpStdio(runtime.platform) && !nativeJob) return 78;
    if (command === undefined) return 78;
    return await runOwnedStdio({
      command,
      args,
      environment: ownedStdioEnvironment(runtime.environment),
      input: runtime.input,
      output: runtime.output,
      errors: runtime.errors,
      signal: lifetime.signal,
      ...(nativeJob ? { stopOwner: runtime.stopOwner } : {}),
    });
  } catch {
    throw new Error("Local MCP process startup failed");
  } finally {
    unobserve();
  }
}

export function workerRuntime(processPort: NodeJS.Process): WorkerRuntime {
  return {
    args: processPort.argv.slice(2),
    environment: processPort.env,
    platform: processPort.platform,
    input: processPort.stdin,
    output: processPort.stdout,
    errors: processPort.stderr,
    observeStop: (stop) => {
      processPort.once("SIGTERM", stop);
      processPort.once("SIGINT", stop);
      return (): void => {
        processPort.off("SIGTERM", stop);
        processPort.off("SIGINT", stop);
      };
    },
    stopOwner: (code): never => processPort.exit(code),
  };
}

// Importing this private entrypoint for qualification must never start a provider.
if (
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = await runOwnedStdioWorker(workerRuntime(process));
}
