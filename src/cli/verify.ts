// `keiko verify` — the real verification gate (NOT a dry-run). It detects the workspace, builds a
// plan from the detected npm scripts, runs the allowlisted commands through the #6 safe tool layer
// under per-command resource limits, and prints a redacted human table (or --json of the report).
// Exit 0 when overall status is `passed`; 1 when any step did not pass or a workspace/runtime error
// occurred; 2 on a usage error. Mirrors runContextCli's structure (flag parsing, --json, typed
// error catch at the boundary).

import { detectWorkspace } from "../workspace/index.js";
import { WorkspaceError } from "../workspace/index.js";
import {
  buildVerificationPlan,
  buildVerificationSummary,
  detectScripts,
  runVerification,
  type VerificationKind,
  type VerificationReport,
} from "../verification/index.js";
import type { CliIo } from "./runner.js";

const VALID_KINDS: ReadonlySet<string> = new Set<VerificationKind>([
  "test",
  "targeted-test",
  "typecheck",
  "lint",
  "build",
]);

const USAGE = `Usage:
  keiko verify [--dir PATH] [--only KIND[,KIND]] [--changed FILE[,FILE]] [--json]

Runs the project's own gates (typecheck, lint, test, build) through the safe tool
layer under per-command resource limits and prints a redacted evidence summary.
KIND is one of: test, targeted-test, typecheck, lint, build.
`;

interface VerifyArgs {
  readonly dir: string;
  readonly only: readonly VerificationKind[] | undefined;
  readonly changed: readonly string[] | undefined;
  readonly json: boolean;
}

// Returns the value of a `--flag value` pair, undefined if absent, or null if present without a
// value (a usage error) — identical contract to runContextCli's flagValue.
function flagValue(args: readonly string[], name: string): string | undefined | null {
  const i = args.indexOf(name);
  if (i === -1) {
    return undefined;
  }
  const value = args[i + 1];
  return value === undefined || value.startsWith("--") ? null : value;
}

function parseKinds(raw: string): readonly VerificationKind[] | null {
  const parts = raw.split(",").map((p) => p.trim());
  if (parts.some((p) => !VALID_KINDS.has(p))) {
    return null;
  }
  return parts as readonly VerificationKind[];
}

function parseArgs(args: readonly string[]): VerifyArgs | null {
  const dirRaw = flagValue(args, "--dir");
  const onlyRaw = flagValue(args, "--only");
  const changedRaw = flagValue(args, "--changed");
  if (dirRaw === null || onlyRaw === null || changedRaw === null) {
    return null;
  }
  const only = onlyRaw === undefined ? undefined : parseKinds(onlyRaw);
  if (only === null) {
    return null;
  }
  const changed = changedRaw === undefined ? undefined : changedRaw.split(",").map((p) => p.trim());
  return { dir: dirRaw ?? ".", only, changed, json: args.includes("--json") };
}

async function runPlan(parsed: VerifyArgs): Promise<VerificationReport> {
  const workspace = detectWorkspace(parsed.dir);
  const catalog = detectScripts(workspace);
  const plan = buildVerificationPlan(workspace, catalog, {
    only: parsed.only,
    changedFiles: parsed.changed,
  });
  return runVerification(plan, { workspace });
}

function renderText(report: VerificationReport, io: CliIo): void {
  const summary = buildVerificationSummary(report);
  io.out(`Verification: ${summary.overallStatus} (${String(summary.durationMs)}ms)\n`);
  io.out("KIND\tSTATUS\tEXIT\tMS\tDETAIL\n");
  for (const r of summary.results) {
    const exit = r.exitCode === null ? "-" : String(r.exitCode);
    io.out(`${r.kind}\t${r.status}\t${exit}\t${String(r.durationMs)}\t${r.detail ?? ""}\n`);
  }
}

export async function runVerifyCli(args: readonly string[], io: CliIo): Promise<number> {
  const parsed = parseArgs(args);
  if (parsed === null) {
    io.err(USAGE);
    return 2;
  }
  try {
    const report = await runPlan(parsed);
    if (parsed.json) {
      io.out(`${JSON.stringify(buildVerificationSummary(report), null, 2)}\n`);
    } else {
      renderText(report, io);
    }
    return report.overallStatus === "passed" ? 0 : 1;
  } catch (error) {
    if (error instanceof WorkspaceError) {
      io.err(`Error [${error.code}]: ${error.message}\n`);
      return 1;
    }
    throw error;
  }
}
