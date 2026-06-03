import { runModelsCli } from "./models.js";
import { runAgentCli } from "./run.js";
import { runContextCli } from "./context.js";
import { runVerifyCli } from "./verify.js";
import { runGenTestsCli } from "./gen-tests.js";
import { runInvestigateCli } from "./investigate.js";
import { runEvidenceCli } from "./evidence.js";
import { runEvaluateCli } from "./evaluate.js";
import { runInitCli } from "./init.js";
import { runLifecycleCli } from "./lifecycle.js";
import { runUiCli } from "./ui.js";
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
  keiko init [OPTIONS]     Add local package.json start/stop scripts.
  keiko start|stop|status|restart Manage the local Keiko UI process.
  keiko models list        List registered model capabilities.
  keiko models validate    Validate gateway configuration.
  keiko run <task>         Run a bounded dry-run task through the agent harness.
  keiko context [OPTIONS]  Print a redacted workspace context summary (dry-run).
  keiko verify [OPTIONS]   Run the project's gates and print a redacted evidence summary.
  keiko gen-tests [OPTIONS] Generate a reviewable unit-test patch (dry-run by default).
  keiko investigate [OPTIONS] Investigate a bug and propose a fix + regression test (dry-run by default).
  keiko evidence <list|show> Inspect redacted evidence manifests written by \`keiko run\`.
  keiko evaluate [OPTIONS]     Run the evaluation harness (offline by default; --live for live model).
  keiko ui [OPTIONS]       Launch the local UI on 127.0.0.1 and print its URL.

Exit codes:
  0  Success
  1  Runtime error
  2  Usage error
`;

type CommandHandler = (
  rest: readonly string[],
  io: CliIo,
  env: EnvSource,
) => number | Promise<number>;

const COMMAND_HANDLERS: Readonly<Record<string, CommandHandler>> = {
  models: runModelsCli,
  run: runAgentCli,
  context: (rest, io) => runContextCli(rest, io),
  verify: (rest, io) => runVerifyCli(rest, io),
  "gen-tests": runGenTestsCli,
  investigate: runInvestigateCli,
  evidence: (rest, io, env) => runEvidenceCli(rest, io, { env }),
  evaluate: (rest, io, env) => runEvaluateCli(rest, io, env, {}),
  init: runInitCli,
  start: (rest, io, env) => runLifecycleCli("start", rest, io, env),
  stop: (rest, io, env) => runLifecycleCli("stop", rest, io, env),
  status: (rest, io, env) => runLifecycleCli("status", rest, io, env),
  restart: (rest, io, env) => runLifecycleCli("restart", rest, io, env),
  ui: runUiCli,
};

// Dispatches named subcommands; returns undefined when the name is not recognised.
function dispatchCommand(
  name: string,
  rest: readonly string[],
  io: CliIo,
  env: EnvSource,
): number | Promise<number> | undefined {
  return COMMAND_HANDLERS[name]?.(rest, io, env);
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
