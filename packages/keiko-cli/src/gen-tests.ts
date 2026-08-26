// `keiko gen-tests` — generates a reviewable unit-test patch for a target file/dir/changed-set
// (ADR-0008 D9). Dry-run by default; --apply writes the tests and runs verification. The text path
// prints the reviewable proposed diff AND the #6 validation summary so a terminal reviewer sees the
// actual generated test code (AC #4/#6); --json emits the full UnitTestWorkflowReport. The gateway
// ModelPort is built from config (loadGatewayConfigFromFile); tests inject deps.model directly so no live
// gateway is needed. Exit 0 on completed/dry-run, 1 on rejected/cancelled/failed/runtime, 2 on
// usage. Mirrors runVerifyCli's flag-parse / typed-error-catch structure.

import type { EnvSource } from "@oscharko-dev/keiko-model-gateway";
import type { ModelPort } from "@oscharko-dev/keiko-harness";
import type { UnitTestTarget, UnitTestWorkflowReport } from "@oscharko-dev/keiko-workflows";
// KEIKO-0655: shared argv-parsing helper replaces the byte-identical flagValue copy and the
// structurally-identical readValueFlags loop this file, evaluate.ts, and investigate.ts held —
// flagValue itself is used only inside readNamedValueFlags now, so only that is imported here.
import { readNamedValueFlags } from "./cli-arg-parsing.js";
// KEIKO-0655: shared model-resolution helpers replace the byte-identical buildModel /
// resolveConfiguredModelId / resolveModel copies this file and investigate.ts held.
import { resolveModelOrExitCode } from "./cli-model-resolution.js";
// GEN-PERF-CLI-001 — heavy graphs load at dispatch; module scope stays type-only.
import {
  loadHarness,
  loadModelGateway,
  loadWorkflows,
  loadWorkspaceModule,
} from "./lazy-modules.js";
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
  return readNamedValueFlags(args, VALUE_FLAGS);
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

// KEIKO-0655: model-resolution helpers moved to cli-model-resolution.ts. gen-tests and
// investigate now share the same buildWorkflowCapableModel / resolveConfiguredModelId /
// resolveModelOrExitCode surface — a change to the resolution rules (workflow-capable
// selector, config source precedence, GatewayError → exit-1 mapping) happens in one place.

function printText(
  report: UnitTestWorkflowReport,
  io: CliIo,
  renderMarkdownReport: (report: UnitTestWorkflowReport) => string,
): void {
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
  // Issue #640: handle --help / -h before workflow-arg validation so help discovery exits 0
  // with usage on stdout, not 2 with a validation error on stderr.
  if (args.includes("--help") || args.includes("-h")) {
    io.out(USAGE);
    return 0;
  }
  const parsed = parseArgs(args);
  if (parsed === null) {
    io.err(USAGE);
    return 2;
  }
  const [gateway, harness, workflows, { WorkspaceError }] = await Promise.all([
    loadModelGateway(),
    loadHarness(),
    loadWorkflows(),
    loadWorkspaceModule(),
  ]);
  const model = await resolveModelOrExitCode(parsed, io, env, deps.model, gateway, harness);
  if (typeof model === "number") {
    return model;
  }
  try {
    const report = await workflows.generateUnitTests(
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
      printText(report, io, workflows.renderMarkdownReport);
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
