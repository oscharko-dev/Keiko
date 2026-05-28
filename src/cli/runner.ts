import { runModelsCli } from "./models.js";
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

Exit codes:
  0  Success
  1  Runtime error
  2  Usage error
`;

export function runCli(args: readonly string[], io: CliIo, env: EnvSource = {}): number {
  const first = args[0];
  if (first === undefined || first === "--help" || first === "-h") {
    io.out(HELP_TEXT);
    return 0;
  }
  if (first === "--version" || first === "-v") {
    io.out(`keiko ${SDK_VERSION}\n`);
    return 0;
  }
  if (first === "models") {
    return runModelsCli(args.slice(1), io, env);
  }
  io.err(`keiko: unknown ${first.startsWith("-") ? "option" : "command"}: ${first}\n`);
  io.err("Run `keiko --help` for usage.\n");
  return 2;
}
