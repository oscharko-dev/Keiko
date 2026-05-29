// `keiko investigate` — investigates a bounded bug report and proposes a minimal fix + a
// regression test (ADR-0009 D14). Dry-run by default; --apply writes the fix and runs verification.
// The text path prints the proposed diff (when present) plus clearly-labelled verified facts and
// the UNVERIFIED model hypothesis; --json emits the full BugInvestigationReport. Failing output and
// stack traces may be read from files (--output-file / --stack-file) to avoid huge argv. The gateway
// ModelPort is built from config (loadConfigFromFile); tests inject deps.model directly so no live
// gateway is needed. Exit 0 on fix-applied/fix-proposed/investigation-only, 1 on
// rejected/cancelled/failed/runtime, 2 on usage. Mirrors runGenTestsCli's structure.

import { readFileSync } from "node:fs";
import { Gateway } from "../gateway/gateway.js";
import { loadConfigFromFile, type EnvSource } from "../gateway/config.js";
import { GatewayError } from "../gateway/errors.js";
import { redact } from "../gateway/redaction.js";
import { GatewayModelPort } from "../harness/adapters.js";
import type { ModelPort } from "../harness/ports.js";
import { WorkspaceError } from "../workspace/index.js";
import { investigateBug, renderBugMarkdownReport } from "../workflows/index.js";
import type {
  BugInvestigationReport,
  BugReportInput,
} from "../workflows/bug-investigation/types.js";
import type { CliIo } from "./runner.js";

const DEFAULT_CONFIG_PATH = "./keiko.config.json";

const USAGE = `Usage:
  keiko investigate [--description TEXT] [--output TEXT | --output-file PATH]
                    [--stack TEXT | --stack-file PATH] [--file PATH[,PATH]]
                    [--apply] [--model MODEL_ID] [--json] [--dir-root PATH]

Investigates a bounded bug report and proposes a root-cause hypothesis with a
minimal fix and a regression test, separating verified facts from model
hypotheses. At least one evidence source is required (--description, --output[-file],
--stack[-file], or --file). Dry-run by default (writes nothing); pass --apply to
write the fix and run verification through the safe tool + verification layers.
`;

export interface InvestigateDeps {
  // Injected ModelPort for tests. When absent, a GatewayModelPort is built from config.
  readonly model?: ModelPort | undefined;
  // Injected file reader for tests. Defaults to node:fs readFileSync (utf8).
  readonly readFile?: ((path: string) => string) | undefined;
}

interface InvestigateArgs {
  readonly description: string | undefined;
  readonly output: string | undefined;
  readonly outputFile: string | undefined;
  readonly stack: string | undefined;
  readonly stackFile: string | undefined;
  readonly files: readonly string[] | undefined;
  readonly apply: boolean;
  readonly model: string | undefined;
  readonly json: boolean;
  readonly dirRoot: string;
}

// Returns the value of a `--flag value` pair, undefined if absent, or null if present without a
// value (a usage error) — identical contract to runGenTestsCli's flagValue.
function flagValue(args: readonly string[], name: string): string | undefined | null {
  const i = args.indexOf(name);
  if (i === -1) {
    return undefined;
  }
  const value = args[i + 1];
  return value === undefined || value.startsWith("--") ? null : value;
}

const VALUE_FLAGS = [
  "--description",
  "--output",
  "--output-file",
  "--stack",
  "--stack-file",
  "--file",
  "--model",
  "--dir-root",
] as const;
type ValueFlag = (typeof VALUE_FLAGS)[number];
type FlagValues = Record<ValueFlag, string | undefined>;

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

function parseFiles(raw: string | undefined): readonly string[] | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const parts = raw
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  return parts.length === 0 ? undefined : parts;
}

function parseArgs(args: readonly string[]): InvestigateArgs | null {
  const values = readValueFlags(args);
  if (values === null) {
    return null;
  }
  return {
    description: values["--description"],
    output: values["--output"],
    outputFile: values["--output-file"],
    stack: values["--stack"],
    stackFile: values["--stack-file"],
    files: parseFiles(values["--file"]),
    apply: args.includes("--apply"),
    model: values["--model"],
    json: args.includes("--json"),
    dirRoot: values["--dir-root"] ?? ".",
  };
}

// At least one evidence source must be present, else there is nothing to investigate.
function hasEvidenceFlag(parsed: InvestigateArgs): boolean {
  return (
    parsed.description !== undefined ||
    parsed.output !== undefined ||
    parsed.outputFile !== undefined ||
    parsed.stack !== undefined ||
    parsed.stackFile !== undefined ||
    parsed.files !== undefined
  );
}

// Resolves the failing output and stack trace, reading from files when the *-file flags are set.
// The inline flag is used only when its file counterpart is absent. Throws on a read failure (the
// CLI catch maps it to a runtime error).
function resolveReport(
  parsed: InvestigateArgs,
  readFile: (path: string) => string,
): BugReportInput {
  const failingOutput =
    parsed.outputFile !== undefined ? readFile(parsed.outputFile) : parsed.output;
  const stackTrace = parsed.stackFile !== undefined ? readFile(parsed.stackFile) : parsed.stack;
  return {
    ...(parsed.description === undefined ? {} : { description: parsed.description }),
    ...(failingOutput === undefined ? {} : { failingOutput }),
    ...(stackTrace === undefined ? {} : { stackTrace }),
    ...(parsed.files === undefined ? {} : { targetFiles: parsed.files }),
  };
}

function buildModel(
  parsed: InvestigateArgs,
  io: CliIo,
  env: EnvSource,
): { port: ModelPort; modelId: string } | number {
  try {
    const config = loadConfigFromFile(DEFAULT_CONFIG_PATH, env);
    const modelId = parsed.model ?? config.providers[0]?.modelId;
    if (modelId === undefined) {
      io.err("Error: no model provider configured.\n");
      return 1;
    }
    return { port: new GatewayModelPort(new Gateway(config)), modelId };
  } catch (error) {
    if (error instanceof GatewayError) {
      io.err(
        `Error: model gateway configuration problem — ${redact(error.message)}\n` +
          `Provide a model via keiko.config.json or KEIKO_DEFAULT_API_KEY / KEIKO_DEFAULT_BASE_URL.\n`,
      );
      return 1;
    }
    throw error;
  }
}

function resolveModel(
  parsed: InvestigateArgs,
  io: CliIo,
  env: EnvSource,
  deps: InvestigateDeps,
): { port: ModelPort; modelId: string } | number {
  if (deps.model !== undefined) {
    return { port: deps.model, modelId: parsed.model ?? "default" };
  }
  return buildModel(parsed, io, env);
}

function printText(report: BugInvestigationReport, io: CliIo): void {
  io.out(`${renderBugMarkdownReport(report)}\n`);
  if (report.dryRunPreview !== undefined) {
    io.out(`\n${report.dryRunPreview}\n`);
  }
  if (report.proposedDiff !== undefined) {
    io.out(`\n--- proposed fix ---\n${report.proposedDiff}\n`);
  }
}

function exitCodeFor(status: BugInvestigationReport["status"]): number {
  return status === "fix-applied" || status === "fix-proposed" || status === "investigation-only"
    ? 0
    : 1;
}

function emitReport(report: BugInvestigationReport, io: CliIo, json: boolean): number {
  if (json) {
    io.out(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    printText(report, io);
  }
  return exitCodeFor(report.status);
}

// Maps a boundary error to an exit code, or rethrows when it is not a recognised IO failure.
function handleCliError(error: unknown, io: CliIo): number {
  if (error instanceof WorkspaceError) {
    io.err(`Error [${error.code}]: ${error.message}\n`);
    return 1;
  }
  if (error instanceof Error && isFileReadError(error)) {
    io.err(`Error: could not read an evidence file — ${redact(error.message)}\n`);
    return 1;
  }
  throw error;
}

export async function runInvestigateCli(
  args: readonly string[],
  io: CliIo,
  env: EnvSource = {},
  deps: InvestigateDeps = {},
): Promise<number> {
  const parsed = parseArgs(args);
  if (parsed === null || !hasEvidenceFlag(parsed)) {
    io.err(USAGE);
    return 2;
  }
  const model = resolveModel(parsed, io, env, deps);
  if (typeof model === "number") {
    return model;
  }
  const readFile = deps.readFile ?? ((path: string): string => readFileSync(path, "utf8"));
  try {
    const report = await investigateBug(
      {
        workspaceRoot: parsed.dirRoot,
        report: resolveReport(parsed, readFile),
        apply: parsed.apply,
        modelId: model.modelId,
      },
      { model: model.port },
    );
    return emitReport(report, io, parsed.json);
  } catch (error) {
    return handleCliError(error, io);
  }
}

// A Node fs read error carries a string `code` (e.g. ENOENT); narrow without `any`.
function isFileReadError(error: Error): boolean {
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && code.length > 0;
}
