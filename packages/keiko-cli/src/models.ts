// `keiko models` CLI handler. `list` reads built-in capability metadata;
// `validate` reads a config file and runs the hand-rolled validator. Neither
// needs a live Gateway; both are async only so the model-gateway module graph
// (provider SDKs) loads on dispatch instead of at CLI parse time
// (GEN-PERF-CLI-001). No credential value is ever written to stdout or stderr.

import type { EnvSource } from "@oscharko-dev/keiko-model-gateway";
import { loadGatewayConfigFromFile, resolveConfigPathFromArgs } from "./gateway-config.js";
import { loadModelGateway } from "./lazy-modules.js";
import type { CliIo } from "./runner.js";

const USAGE = `Usage:
  keiko models list                      List registered model capabilities.
  keiko models validate [--config PATH]  Validate gateway configuration.
`;

function formatUseCases(useCases: readonly string[]): string {
  return useCases.map((useCase) => useCase.toLowerCase().replace(/\s+/g, "-")).join(",");
}

async function listModels(io: CliIo): Promise<number> {
  const { listCapabilities } = await loadModelGateway();
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

async function validateConfig(args: readonly string[], io: CliIo, env: EnvSource): Promise<number> {
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
  const { GatewayError } = await loadModelGateway();
  try {
    const config = await loadGatewayConfigFromFile(resolution.path, env);
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

export function runModelsCli(
  args: readonly string[],
  io: CliIo,
  env: EnvSource,
): number | Promise<number> {
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
