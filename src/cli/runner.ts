import { runModelsCli } from "./models.js";
import { runAgentCli } from "./run.js";
import { runContextCli } from "./context.js";
import type { EnvSource } from "../gateway/config.js";
import { SDK_VERSION } from "../sdk/index.js";

// Pure CLI core: returns an exit code and writes through the injected IO so it is
// testable without touching process.* (the thin process shim lives in index.ts).
export interface CliIo {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
}

const HELP_TEXT = `keiko ${SDK_VERSION}
Enterprise model-agnostic developer-assist coding agent.

Usage:
  keiko [--help | -h]      Print this help and exit.
  keiko [--version | -v]   Print the version and exit.
  keiko models list        List registered model capabilities.
  keiko models validate    Validate gateway configuration.
  keiko run <task>         Run a bounded dry-run task through the agent harness.
  keiko context [OPTIONS]  Print a redacted workspace context summary (dry-run).

Exit codes:
  0  Success
  1  Runtime error
  2  Usage error
`;

// Dispatches named subcommands; returns undefined when the name is not recognised.
function dispatchCommand(
  name: string,
  rest: readonly string[],
  io: CliIo,
  env: EnvSource,
): number | Promise<number> | undefined {
  if (name === "models") {
    return runModelsCli(rest, io, env);
  }
  if (name === "run") {
    return runAgentCli(rest, io);
  }
  if (name === "context") {
    return runContextCli(rest, io);
  }
  return undefined;
}

// Returns a number for synchronous commands; the async `run` command returns a Promise.
// The process shim in index.ts awaits the union before calling process.exit.
export function runCli(
  args: readonly string[],
  io: CliIo,
  env: EnvSource = {},
): number | Promise<number> {
  const first = args[0];
  if (first === undefined || first === "--help" || first === "-h") {
    io.out(HELP_TEXT);
    return 0;
  }
  if (first === "--version" || first === "-v") {
    io.out(`keiko ${SDK_VERSION}\n`);
    return 0;
  }
  const result = dispatchCommand(first, args.slice(1), io, env);
  if (result !== undefined) {
    return result;
  }
  io.err(`keiko: unknown ${first.startsWith("-") ? "option" : "command"}: ${first}\n`);
  io.err("Run `keiko --help` for usage.\n");
  return 2;
}
