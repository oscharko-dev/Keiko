// `keiko investigate` — investigates a bounded bug report and proposes a minimal fix + a
// regression test (ADR-0009 D14). Dry-run by default; --apply writes the fix and runs verification.
// The text path prints the proposed diff (when present) plus clearly-labelled verified facts and
// the UNVERIFIED model hypothesis; --json emits the full BugInvestigationReport. Failing output and
// stack traces may be read from files (--output-file / --stack-file) to avoid huge argv. Evidence
// files are read through the workspace boundary, never raw node:fs. The gateway ModelPort is built
// from config (loadGatewayConfigFromFile); tests inject deps.model directly so no live gateway is needed.
// Exit 0 on fix-applied/fix-proposed/investigation-only, 1 on
// rejected/cancelled/failed/runtime, 2 on usage. Mirrors runGenTestsCli's structure.

import type { EnvSource } from "@oscharko-dev/keiko-model-gateway";
import type { ModelPort } from "@oscharko-dev/keiko-harness";
import type { WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import type { BugInvestigationReport, BugReportInput } from "@oscharko-dev/keiko-workflows";
import { loadGatewayConfigFromFile } from "./gateway-config.js";
// GEN-PERF-CLI-001 — heavy graphs load at dispatch; module scope stays type-only.
import {
  loadHarness,
  loadModelGateway,
  loadWorkflows,
  loadWorkspaceModule,
} from "./lazy-modules.js";
import type { CliIo } from "./runner.js";

type GatewayModule = typeof import("@oscharko-dev/keiko-model-gateway");
type HarnessModule = typeof import("@oscharko-dev/keiko-harness");
type WorkspacePackage = typeof import("@oscharko-dev/keiko-workspace");

const USAGE = `Usage:
  keiko investigate [--description TEXT] [--output TEXT | --output-file PATH]
                    [--stack TEXT | --stack-file PATH] [--file PATH[,PATH]]
                    [--apply] [--model MODEL_ID] [--config PATH] [--json] [--dir-root PATH]

Investigates a bounded bug report and proposes a root-cause hypothesis with a
minimal fix and a regression test, separating verified facts from model
hypotheses. At least one evidence source is required (--description, --output[-file],
--stack[-file], or --file). Dry-run by default (writes nothing); pass --apply to
write the fix and run verification through the safe tool + verification layers.
`;

export interface InvestigateDeps {
  // Injected ModelPort for tests. When absent, a GatewayModelPort is built from config.
  readonly model?: ModelPort | undefined;
  // Injected file reader for tests. Production defaults to readWorkspaceFile.
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
  readonly config: string | undefined;
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
  "--config",
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
    config: values["--config"],
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

function workspaceEvidenceReader(
  workspace: WorkspaceInfo,
  readWorkspaceFile: WorkspacePackage["readWorkspaceFile"],
): (path: string) => string {
  return (path: string): string => readWorkspaceFile(workspace, path).text;
}

async function buildModel(
  parsed: InvestigateArgs,
  io: CliIo,
  env: EnvSource,
  gateway: GatewayModule,
  harness: HarnessModule,
): Promise<{ port: ModelPort; modelId: string } | number> {
  try {
    const path = parsed.config ?? env.KEIKO_CONFIG_FILE;
    if (path === undefined) {
      throw new gateway.ConfigInvalidError(
        "no config source; pass --config PATH or set KEIKO_CONFIG_FILE",
      );
    }
    const config = await loadGatewayConfigFromFile(path, env);
    if (parsed.model !== undefined) {
      gateway.assertConfiguredModel(config, parsed.model);
    }
    const modelId =
      parsed.model ??
      gateway.selectConfiguredModel(config, {
        kind: "chat",
        toolCalling: true,
        structuredOutput: true,
      });
    if (modelId === undefined) {
      io.err("Error: no configured workflow-capable chat model is available.\n");
      return 1;
    }
    return { port: new harness.GatewayModelPort(new gateway.Gateway(config)), modelId };
  } catch (error) {
    if (error instanceof gateway.GatewayError) {
      io.err(
        `Error: model gateway configuration problem — ${gateway.redact(error.message)}\n` +
          `Provide a gateway config with --config PATH or KEIKO_CONFIG_FILE.\n`,
      );
      return 1;
    }
    throw error;
  }
}

async function resolveConfiguredModelId(
  parsed: InvestigateArgs,
  env: EnvSource,
  gateway: GatewayModule,
): Promise<string | undefined> {
  const path = parsed.config ?? env.KEIKO_CONFIG_FILE;
  if (path === undefined) {
    return parsed.model ?? "default";
  }
  const config = await loadGatewayConfigFromFile(path, env);
  if (parsed.model !== undefined) {
    gateway.assertConfiguredModel(config, parsed.model);
    return parsed.model;
  }
  return gateway.selectConfiguredModel(config, {
    kind: "chat",
    toolCalling: true,
    structuredOutput: true,
  });
}

async function resolveModel(
  parsed: InvestigateArgs,
  io: CliIo,
  env: EnvSource,
  deps: InvestigateDeps,
  gateway: GatewayModule,
  harness: HarnessModule,
): Promise<{ port: ModelPort; modelId: string } | number> {
  if (deps.model !== undefined) {
    try {
      const modelId = await resolveConfiguredModelId(parsed, env, gateway);
      if (modelId === undefined) {
        io.err("Error: no configured workflow-capable chat model is available.\n");
        return 1;
      }
      return { port: deps.model, modelId };
    } catch (error) {
      if (error instanceof gateway.GatewayError) {
        io.err(`Error: model gateway configuration problem — ${gateway.redact(error.message)}\n`);
        return 1;
      }
      throw error;
    }
  }
  return buildModel(parsed, io, env, gateway, harness);
}

function printText(
  report: BugInvestigationReport,
  io: CliIo,
  renderBugMarkdownReport: (report: BugInvestigationReport) => string,
): void {
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

function emitReport(
  report: BugInvestigationReport,
  io: CliIo,
  json: boolean,
  renderBugMarkdownReport: (report: BugInvestigationReport) => string,
): number {
  if (json) {
    io.out(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    printText(report, io, renderBugMarkdownReport);
  }
  return exitCodeFor(report.status);
}

// Maps a boundary error to an exit code, or rethrows when it is not a recognised IO failure.
function handleCliError(
  error: unknown,
  io: CliIo,
  gateway: GatewayModule,
  workspaceModule: WorkspacePackage,
): number {
  if (error instanceof workspaceModule.WorkspaceError) {
    io.err(`Error [${error.code}]: ${error.message}\n`);
    return 1;
  }
  if (error instanceof Error && isFileReadError(error)) {
    io.err(`Error: could not read an evidence file — ${gateway.redact(error.message)}\n`);
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
  // Issue #640: handle --help / -h before workflow-arg validation so help discovery exits 0
  // with usage on stdout, not 2 with a validation error on stderr.
  if (args.includes("--help") || args.includes("-h")) {
    io.out(USAGE);
    return 0;
  }
  const parsed = parseArgs(args);
  if (parsed === null || !hasEvidenceFlag(parsed)) {
    io.err(USAGE);
    return 2;
  }
  const [gateway, harness, workflows, workspaceModule] = await Promise.all([
    loadModelGateway(),
    loadHarness(),
    loadWorkflows(),
    loadWorkspaceModule(),
  ]);
  const model = await resolveModel(parsed, io, env, deps, gateway, harness);
  if (typeof model === "number") {
    return model;
  }
  try {
    const workspace = workspaceModule.detectWorkspace(parsed.dirRoot);
    const readFile =
      deps.readFile ?? workspaceEvidenceReader(workspace, workspaceModule.readWorkspaceFile);
    const report = await workflows.investigateBug(
      {
        workspaceRoot: workspace.root,
        report: resolveReport(parsed, readFile),
        apply: parsed.apply,
        modelId: model.modelId,
      },
      { model: model.port },
    );
    return emitReport(report, io, parsed.json, workflows.renderBugMarkdownReport);
  } catch (error) {
    return handleCliError(error, io, gateway, workspaceModule);
  }
}

// A Node fs read error carries a string `code` (e.g. ENOENT); narrow without `any`.
function isFileReadError(error: Error): boolean {
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && code.length > 0;
}
