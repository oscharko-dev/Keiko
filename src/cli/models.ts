// `keiko models` CLI handler. Synchronous by design: `list` reads built-in
// capability metadata; `validate` reads a config file with readFileSync and runs
// the hand-rolled validator. Neither path needs a live async Gateway, so the
// existing `process.exit(runCli(...))` shim stays synchronous. No credential value
// is ever written to stdout or stderr.

import { listCapabilities } from "../gateway/capabilities.js";
import { loadConfigFromFile, type EnvSource } from "../gateway/config.js";
import { GatewayError } from "../gateway/errors.js";
import { resolveConfigPathFromArgs } from "./gateway-config.js";
import type { CliIo } from "./runner.js";

const USAGE = `Usage:
  keiko models list                      List registered model capabilities.
  keiko models validate [--config PATH]  Validate gateway configuration.
`;

function formatUseCases(useCases: readonly string[]): string {
  return useCases.map((useCase) => useCase.toLowerCase().replace(/\s+/g, "-")).join(",");
}

function listModels(io: CliIo): number {
  io.out("ID\tKIND\tCOST\tLATENCY\tTOOLS\tSTRUCT\tUSE-CASES\n");
  for (const cap of listCapabilities()) {
    const tools = cap.toolCalling ? "yes" : "no";
    const struct = cap.structuredOutput ? "yes" : "no";
    io.out(
      `${cap.id}\t${cap.kind}\t${cap.costClass}\t${cap.latencyClass}\t${tools}\t${struct}\t${formatUseCases(cap.preferredUseCases)}\n`,
    );
  }
  return 0;
}

function validateConfig(args: readonly string[], io: CliIo, env: EnvSource): number {
  const resolution = resolveConfigPathFromArgs(args, env);
  if (resolution.kind === "missing-value") {
    io.err("Error: --config requires a path argument.\n");
    return 2;
  }
  if (resolution.kind === "not-configured") {
    io.err(
      "Error [GATEWAY_CONFIG_INVALID]: no config source; pass --config PATH or set KEIKO_CONFIG_FILE.\n",
    );
    return 1;
  }
  try {
    const config = loadConfigFromFile(resolution.path, env);
    io.out(
      `Gateway config valid. ${String(config.providers.length)} model providers configured.\n`,
    );
    return 0;
  } catch (error) {
    if (error instanceof GatewayError) {
      io.err(`Error [${error.code}]: ${error.message}\n`);
      return 1;
    }
    throw error;
  }
}

export function runModelsCli(args: readonly string[], io: CliIo, env: EnvSource): number {
  const sub = args[0];
  if (sub === "list") {
    return listModels(io);
  }
  if (sub === "validate") {
    return validateConfig(args.slice(1), io, env);
  }
  if (sub === undefined) {
    io.err(USAGE);
    return 2;
  }
  io.err(`keiko models: unknown sub-command: ${sub}\n`);
  io.err(USAGE);
  return 2;
}
