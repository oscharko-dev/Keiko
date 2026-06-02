// `keiko gen-tests` — generates a reviewable unit-test patch for a target file/dir/changed-set
// (ADR-0008 D9). Dry-run by default; --apply writes the tests and runs verification. The text path
// prints the reviewable proposed diff AND the #6 validation summary so a terminal reviewer sees the
// actual generated test code (AC #4/#6); --json emits the full UnitTestWorkflowReport. The gateway
// ModelPort is built from config (loadConfigFromFile); tests inject deps.model directly so no live
// gateway is needed. Exit 0 on completed/dry-run, 1 on rejected/cancelled/failed/runtime, 2 on
// usage. Mirrors runVerifyCli's flag-parse / typed-error-catch structure.

import { Gateway } from "../gateway/gateway.js";
import { loadConfigFromFile, type EnvSource } from "../gateway/config.js";
import { ConfigInvalidError, GatewayError } from "../gateway/errors.js";
import { assertConfiguredModel, selectConfiguredModel } from "../gateway/model-selection.js";
import { redact } from "../gateway/redaction.js";
import { GatewayModelPort } from "../harness/adapters.js";
import type { ModelPort } from "../harness/ports.js";
import { WorkspaceError } from "../workspace/index.js";
import { generateUnitTests, renderMarkdownReport } from "../workflows/index.js";
import type { UnitTestTarget, UnitTestWorkflowReport } from "../workflows/unit-tests/types.js";
import type { CliIo } from "./runner.js";

const USAGE = `Usage:
  keiko gen-tests (--file PATH | --dir PATH) [--function NAME] [--changed FILE[,FILE]]
                  [--apply] [--model MODEL_ID] [--config PATH] [--json] [--dir-root PATH]

Generates a reviewable unit-test patch for a target TypeScript file, function, or
module. Dry-run by default (prints the proposed diff, writes nothing); pass --apply
to write the tests and run verification through the safe tool + verification layers.
`;

export interface GenTestsDeps {
  // Injected ModelPort for tests. When absent, a GatewayModelPort is built from config.
  readonly model?: ModelPort | undefined;
}

interface GenTestsArgs {
  readonly file: string | undefined;
  readonly dir: string | undefined;
  readonly fn: string | undefined;
  readonly changed: readonly string[] | undefined;
  readonly apply: boolean;
  readonly model: string | undefined;
  readonly config: string | undefined;
  readonly json: boolean;
  readonly dirRoot: string;
}

// Returns the value of a `--flag value` pair, undefined if absent, or null if present without a
// value (a usage error) — identical contract to runVerifyCli's flagValue.
function flagValue(args: readonly string[], name: string): string | undefined | null {
  const i = args.indexOf(name);
  if (i === -1) {
    return undefined;
  }
  const value = args[i + 1];
  return value === undefined || value.startsWith("--") ? null : value;
}

const VALUE_FLAGS = [
  "--file",
  "--dir",
  "--function",
  "--changed",
  "--model",
  "--config",
  "--dir-root",
] as const;
type ValueFlag = (typeof VALUE_FLAGS)[number];
type FlagValues = Record<ValueFlag, string | undefined>;

// Reads every value flag once; returns null if any is present without a value (a usage error).
function readValueFlags(args: readonly string[]): FlagValues | null {
  const values = {} as FlagValues;
  for (const flag of VALUE_FLAGS) {
    const value = flagValue(args, flag);
    if (value === null) {
      return null;
    }
    values[flag] = value;
  }
  return values;
}

function parseArgs(args: readonly string[]): GenTestsArgs | null {
  const values = readValueFlags(args);
  if (values === null) {
    return null;
  }
  const file = values["--file"];
  const dir = values["--dir"];
  // Exactly one of --file / --dir is required.
  if ((file === undefined) === (dir === undefined)) {
    return null;
  }
  const changedRaw = values["--changed"];
  const changedPaths =
    changedRaw === undefined
      ? undefined
      : changedRaw
          .split(",")
          .map((p) => p.trim())
          .filter((p) => p.length > 0);
  return {
    file,
    dir,
    fn: values["--function"],
    changed: changedPaths === undefined || changedPaths.length === 0 ? undefined : changedPaths,
    apply: args.includes("--apply"),
    model: values["--model"],
    config: values["--config"],
    json: args.includes("--json"),
    dirRoot: values["--dir-root"] ?? ".",
  };
}

// --changed composes with both --file and --dir: when present it is the authoritative target set.
function resolveTarget(parsed: GenTestsArgs): UnitTestTarget {
  if (parsed.changed !== undefined) {
    return { kind: "changedFiles", filePaths: parsed.changed };
  }
  if (parsed.dir !== undefined) {
    return { kind: "module", moduleDir: parsed.dir };
  }
  return {
    kind: "file",
    filePath: parsed.file ?? "",
    ...(parsed.fn === undefined ? {} : { targetFunction: parsed.fn }),
  };
}

// Builds a ModelPort from the gateway config, or returns a usage/runtime error code via io. The
// default selector is workflow-safe: generated test patches need tool use and structured output.
// Explicit --model remains operator-controlled after config membership checks.
function buildModel(
  parsed: GenTestsArgs,
  io: CliIo,
  env: EnvSource,
): { port: ModelPort; modelId: string } | number {
  try {
    const path = parsed.config ?? env.KEIKO_CONFIG_FILE;
    if (path === undefined) {
      throw new ConfigInvalidError("no config source; pass --config PATH or set KEIKO_CONFIG_FILE");
    }
    const config = loadConfigFromFile(path, env);
    if (parsed.model !== undefined) {
      assertConfiguredModel(config, parsed.model);
    }
    const modelId =
      parsed.model ??
      selectConfiguredModel(config, {
        kind: "chat",
        toolCalling: true,
        structuredOutput: true,
      });
    if (modelId === undefined) {
      io.err("Error: no configured workflow-capable chat model is available.\n");
      return 1;
    }
    return { port: new GatewayModelPort(new Gateway(config)), modelId };
  } catch (error) {
    if (error instanceof GatewayError) {
      io.err(
        `Error: model gateway configuration problem — ${redact(error.message)}\n` +
          `Provide a gateway config with --config PATH or KEIKO_CONFIG_FILE.\n`,
      );
      return 1;
    }
    throw error;
  }
}

function resolveConfiguredModelId(parsed: GenTestsArgs, env: EnvSource): string | undefined {
  const path = parsed.config ?? env.KEIKO_CONFIG_FILE;
  if (path === undefined) {
    return parsed.model ?? "default";
  }
  const config = loadConfigFromFile(path, env);
  if (parsed.model !== undefined) {
    assertConfiguredModel(config, parsed.model);
    return parsed.model;
  }
  return selectConfiguredModel(config, {
    kind: "chat",
    toolCalling: true,
    structuredOutput: true,
  });
}

function resolveModel(
  parsed: GenTestsArgs,
  io: CliIo,
  env: EnvSource,
  deps: GenTestsDeps,
): { port: ModelPort; modelId: string } | number {
  if (deps.model !== undefined) {
    try {
      const modelId = resolveConfiguredModelId(parsed, env);
      if (modelId === undefined) {
        io.err("Error: no configured workflow-capable chat model is available.\n");
        return 1;
      }
      return { port: deps.model, modelId };
    } catch (error) {
      if (error instanceof GatewayError) {
        io.err(`Error: model gateway configuration problem — ${redact(error.message)}\n`);
        return 1;
      }
      throw error;
    }
  }
  return buildModel(parsed, io, env);
}

function printText(report: UnitTestWorkflowReport, io: CliIo): void {
  io.out(`${renderMarkdownReport(report)}\n`);
  if (report.dryRunPreview !== undefined) {
    io.out(`\n${report.dryRunPreview}\n`);
  }
  if (report.proposedDiff !== undefined) {
    io.out(`\n--- proposed test patch ---\n${report.proposedDiff}\n`);
  }
}

function exitCodeFor(status: UnitTestWorkflowReport["status"]): number {
  return status === "completed" || status === "dry-run" ? 0 : 1;
}

export async function runGenTestsCli(
  args: readonly string[],
  io: CliIo,
  env: EnvSource = {},
  deps: GenTestsDeps = {},
): Promise<number> {
  const parsed = parseArgs(args);
  if (parsed === null) {
    io.err(USAGE);
    return 2;
  }
  const model = resolveModel(parsed, io, env, deps);
  if (typeof model === "number") {
    return model;
  }
  try {
    const report = await generateUnitTests(
      {
        workspaceRoot: parsed.dirRoot,
        target: resolveTarget(parsed),
        apply: parsed.apply,
        modelId: model.modelId,
      },
      { model: model.port },
    );
    if (parsed.json) {
      io.out(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      printText(report, io);
    }
    return exitCodeFor(report.status);
  } catch (error) {
    if (error instanceof WorkspaceError) {
      io.err(`Error [${error.code}]: ${error.message}\n`);
      return 1;
    }
    throw error;
  }
}
