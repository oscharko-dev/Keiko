// `keiko context` — a DRY-RUN-BY-CONSTRUCTION repository-context summary. It detects a
// workspace, builds a redacted structured summary (and a context pack when --task/--budget is
// given), and prints a human table or JSON. It NEVER constructs an agent session and NEVER
// calls a model: there is no import of the harness/gateway run path in this file.

import { detectWorkspace } from "../workspace/detect.js";
import { discoverWithStats } from "../workspace/discovery.js";
import { buildContextPackFromFiles } from "../workspace/contextPack.js";
import { buildWorkspaceSummary } from "../workspace/summary.js";
import { WorkspaceError } from "../workspace/errors.js";
import { DEFAULT_CONTEXT_REQUEST, type WorkspaceSummary } from "../workspace/types.js";
import type { CliIo } from "./runner.js";

const USAGE = `Usage:
  keiko context [--dir PATH] [--task TEXT] [--budget BYTES] [--json]

Detects the workspace, prints a redacted context summary, and (with --task or
--budget) a deterministic context pack. Dry-run by construction: no model is called.
`;

interface ContextArgs {
  readonly dir: string;
  readonly task: string | undefined;
  readonly budget: number | undefined;
  readonly json: boolean;
}

// Returns the value of a `--flag value` pair, `undefined` if absent, or `null` if the flag is
// present but missing its value (a usage error).
function flagValue(args: readonly string[], name: string): string | undefined | null {
  const i = args.indexOf(name);
  if (i === -1) {
    return undefined;
  }
  const value = args[i + 1];
  return value === undefined || value.startsWith("--") ? null : value;
}

function parseArgs(args: readonly string[]): ContextArgs | null {
  const dirRaw = flagValue(args, "--dir");
  const taskRaw = flagValue(args, "--task");
  const budgetRaw = flagValue(args, "--budget");
  if (dirRaw === null || taskRaw === null || budgetRaw === null) {
    return null;
  }
  if (budgetRaw !== undefined && !/^[1-9][0-9]*$/.test(budgetRaw)) {
    return null;
  }
  const budget = budgetRaw === undefined ? undefined : Number.parseInt(budgetRaw, 10);
  if (budget !== undefined && !Number.isSafeInteger(budget)) {
    return null;
  }
  return { dir: dirRaw ?? ".", task: taskRaw, budget, json: args.includes("--json") };
}

function buildSummary(parsed: ContextArgs): WorkspaceSummary {
  const workspace = detectWorkspace(parsed.dir);
  const { files, stats } = discoverWithStats(workspace, DEFAULT_CONTEXT_REQUEST.discovery);
  const wantsPack = parsed.task !== undefined || parsed.budget !== undefined;
  if (!wantsPack) {
    return buildWorkspaceSummary(workspace, undefined, stats);
  }
  const pack = buildContextPackFromFiles(
    workspace,
    {
      ...DEFAULT_CONTEXT_REQUEST,
      task: parsed.task,
      budgetBytes: parsed.budget ?? DEFAULT_CONTEXT_REQUEST.budgetBytes,
    },
    files,
  );
  return buildWorkspaceSummary(workspace, pack, stats);
}

function renderContext(summary: WorkspaceSummary, io: CliIo): void {
  const context = summary.context;
  if (context === undefined) {
    return;
  }
  io.out(
    `Context:   used=${String(context.usedBytes)}/${String(context.budgetBytes)} bytes, dropped=${String(context.droppedForBudget)}\n`,
  );
  io.out("PATH\tREASON\tSIZE\tEXCERPT-BYTES\tTRUNCATED\n");
  for (const entry of context.entries) {
    io.out(
      `${entry.path}\t${entry.selectionReason}\t${String(entry.sizeBytes)}\t${String(entry.excerptBytes)}\t${entry.truncated ? "yes" : "no"}\n`,
    );
  }
}

function renderText(summary: WorkspaceSummary, io: CliIo): void {
  io.out(`Workspace: ${summary.root}\n`);
  io.out(`Name:      ${summary.name ?? "(none)"}\n`);
  io.out(`Version:   ${summary.version ?? "(none)"}\n`);
  io.out(`Framework: ${summary.testFramework}\n`);
  io.out(`Sources:   ${summary.sourceDirs.join(", ") || "(none)"}\n`);
  io.out(`Tests:     ${summary.testDirs.join(", ") || "(none)"}\n`);
  io.out(`Languages: ${summary.languages.join(", ")}\n`);
  io.out(
    `Counts:    discovered=${String(summary.counts.discovered)} denied=${String(summary.counts.denied)} ignored=${String(summary.counts.ignored)}\n`,
  );
  renderContext(summary, io);
}

export function runContextCli(args: readonly string[], io: CliIo): number {
  const parsed = parseArgs(args);
  if (parsed === null) {
    io.err(USAGE);
    return 2;
  }
  try {
    const summary = buildSummary(parsed);
    if (parsed.json) {
      io.out(`${JSON.stringify(summary, null, 2)}\n`);
    } else {
      renderText(summary, io);
    }
    return 0;
  } catch (error) {
    if (error instanceof WorkspaceError) {
      io.err(`Error [${error.code}]: ${error.message}\n`);
      return 1;
    }
    throw error;
  }
}
