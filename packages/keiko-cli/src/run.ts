// `keiko run` — the dry-run task command. It builds an AgentSession with the configured model
// gateway and a dry-run tool port (provider call is real, tools are non-mutating) and renders the
// HarnessEvent stream to CliIo. Since ADR-0010 it ALSO writes a redacted evidence manifest by
// default (evidence is the product value): a tee EventSink forwards every event to BOTH a
// MemoryEventSink (which retains raw content to assemble the replay manifest) and the existing
// CliEventSink (whose summarisers never print sensitive fields). After the run resolves, the audit
// layer builds + redacts + persists the manifest and the EvidenceReport is printed. Writing is on by
// default; --no-evidence disables it, --evidence-dir relocates it. Tests inject an in-memory
// EvidenceStore via deps so no write ever touches the repository tree.

import {
  ConfigInvalidError,
  Gateway,
  GatewayError,
  assertConfiguredModel,
  loadConfigFromFile,
  redact,
  resolveCostClass,
  selectConfiguredModel,
  type EnvSource,
} from "@oscharko-dev/keiko-model-gateway";
import { DryRunToolPort, GatewayModelPort, type ModelPort } from "@oscharko-dev/keiko-harness";
import { createSession, HARNESS_VERSION, type AgentConfig } from "@oscharko-dev/keiko-harness";
import { CliEventSink, MemoryEventSink, type ManifestSeed } from "@oscharko-dev/keiko-harness";
import type { EventSink } from "@oscharko-dev/keiko-harness";
import type { HarnessEvent, RunResult, TaskInput, TaskType } from "@oscharko-dev/keiko-harness";
import { DEFAULT_LIMITS } from "@oscharko-dev/keiko-harness";
import { persistEvidence } from "@oscharko-dev/keiko-evidence";
import { renderEvidenceReport } from "@oscharko-dev/keiko-evidence";
import {
  createNodeEvidenceStore,
  resolveEvidenceDir,
  type EvidenceStore,
} from "@oscharko-dev/keiko-evidence";
import { AuditError } from "@oscharko-dev/keiko-evidence";
import type { CliIo } from "./runner.js";

const TASK_TYPES: ReadonlySet<string> = new Set<TaskType>([
  "generate-unit-tests",
  "investigate-bug",
  "explain-plan",
]);

const USAGE = `Usage:
  keiko run explain-plan --file PATH [--question TEXT]
  keiko run generate-unit-tests --file PATH [--function NAME]
  keiko run investigate-bug --description TEXT [--file PATH]

  Evidence flags (a redacted manifest is written by default):
    --no-evidence            Do not write an evidence manifest.
    --evidence-dir PATH      Write evidence under PATH (default $KEIKO_EVIDENCE_DIR or ./.keiko/evidence).
    --include-reasoning      Include redacted reasoning entries in the manifest.
    --include-diff           Include the redacted proposed diff in the manifest.
    --config PATH            Gateway config file (or set KEIKO_CONFIG_FILE).
    --model MODEL_ID         Configured model id to use.

All tasks run in dry-run mode for tools/files: a patch is proposed as an event, never written to disk.
`;

// Test seam: inject an in-memory EvidenceStore so CLI tests never write to the repo tree.
export interface RunDeps {
  readonly store?: EvidenceStore | undefined;
  readonly model?: ModelPort | undefined;
}

interface EvidenceFlags {
  readonly write: boolean;
  // The raw --evidence-dir value (undefined when absent); the env var / default is layered in later.
  readonly evidenceDirFlag: string | undefined;
  readonly includeReasoning: boolean;
  readonly includeDiff: boolean;
  readonly model: string | undefined;
  readonly config: string | undefined;
}

function flag(args: readonly string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) {
    return undefined;
  }
  const value = args[i + 1];
  return value === undefined || value.startsWith("--") ? undefined : value;
}

function parseEvidenceFlags(args: readonly string[]): EvidenceFlags {
  return {
    write: !args.includes("--no-evidence"),
    evidenceDirFlag: flag(args, "--evidence-dir"),
    includeReasoning: args.includes("--include-reasoning"),
    includeDiff: args.includes("--include-diff"),
    model: flag(args, "--model"),
    config: flag(args, "--config"),
  };
}

// The CLI only accepts the model-driven harness tasks. The "verify" task type is BFF-only
// (the run engine calls `runVerification` directly without a harness session), so it is
// excluded from this CLI-side narrowing — the upstream `TASK_TYPES` set guards entry.
type CliTaskType = Exclude<TaskType, "verify">;

function parseTask(taskType: CliTaskType, args: readonly string[]): TaskInput | null {
  const file = flag(args, "--file");
  if (taskType === "explain-plan") {
    if (file === undefined) {
      return null;
    }
    return { taskType, input: { filePath: file, question: flag(args, "--question") } };
  }
  if (taskType === "generate-unit-tests") {
    if (file === undefined) {
      return null;
    }
    return { taskType, input: { filePath: file, targetFunction: flag(args, "--function") } };
  }
  const description = flag(args, "--description");
  if (description === undefined) {
    return null;
  }
  return { taskType, input: { description, filePaths: file === undefined ? undefined : [file] } };
}

// Forwards each event to every wrapped sink. retainsRawContent is true so the harness emits raw
// SENSITIVE fields — required for the MemoryEventSink's faithful replay manifest. The CliEventSink
// summarisers never print those fields, and the audit layer redacts before anything is persisted.
function teeSink(sinks: readonly EventSink[]): EventSink {
  return {
    retainsRawContent: true,
    emit: (event: HarnessEvent): void => {
      for (const sink of sinks) {
        sink.emit(event);
      }
    },
  };
}

function seedFor(task: TaskInput, result: RunResult, modelId: string): ManifestSeed {
  return {
    runId: result.runId,
    fingerprint: result.fingerprint,
    harnessVersion: HARNESS_VERSION,
    taskType: task.taskType,
    taskInput: task,
    limits: DEFAULT_LIMITS,
    modelId,
    workingDirectory: ".",
    dryRun: true,
    startedAt: new Date(result.startedAt).toISOString(),
  };
}

interface EvidenceContext {
  readonly flags: EvidenceFlags;
  readonly env: EnvSource;
  readonly deps: RunDeps;
}

// Persists the evidence manifest. This is a system boundary (filesystem write), so try/catch is
// correct here (CLAUDE.md): on any failure — typed AuditError or otherwise — print a REDACTED
// message and return exit 1 rather than rejecting out of runAgentCli as an unhandled rejection (C3).
// Returns undefined on success so the caller falls through to the run-outcome exit code.
function writeEvidence(
  result: RunResult,
  memory: MemoryEventSink,
  task: TaskInput,
  ctx: EvidenceContext,
  io: CliIo,
  modelId: string,
): number | undefined {
  try {
    const manifest = memory.collectManifest(seedFor(task, result, modelId));
    const store =
      ctx.deps.store ??
      createNodeEvidenceStore(resolveEvidenceDir(ctx.flags.evidenceDirFlag, ctx.env));
    const out = persistEvidence(
      {
        result,
        manifest,
        options: {
          includeReasoning: ctx.flags.includeReasoning,
          includeDiff: ctx.flags.includeDiff,
        },
      },
      { store, env: ctx.env, costClassResolver: resolveCostClass },
    );
    io.out(renderEvidenceReport(out.report));
    return undefined;
  } catch (error) {
    const detail = error instanceof AuditError ? error.message : redact(String(error));
    io.err(`keiko run: failed to write evidence: ${detail}\n`);
    return 1;
  }
}

function configuredModelId(flags: EvidenceFlags, env: EnvSource): string | undefined {
  const path = flags.config ?? env.KEIKO_CONFIG_FILE;
  if (path === undefined) {
    return flags.model;
  }
  const config = loadConfigFromFile(path, env);
  if (flags.model !== undefined) {
    assertConfiguredModel(config, flags.model);
    return flags.model;
  }
  return selectConfiguredModel(config, { kind: "chat" });
}

function resolveModel(
  flags: EvidenceFlags,
  io: CliIo,
  env: EnvSource,
  deps: RunDeps,
): { port: ModelPort; modelId: string } | number {
  try {
    if (deps.model !== undefined) {
      const modelId = configuredModelId(flags, env);
      if (modelId === undefined) {
        io.err("Error: no model id available; pass --model MODEL_ID for injected test runs.\n");
        return 1;
      }
      return { port: deps.model, modelId };
    }
    const path = flags.config ?? env.KEIKO_CONFIG_FILE;
    if (path === undefined) {
      throw new ConfigInvalidError("no config source; pass --config PATH or set KEIKO_CONFIG_FILE");
    }
    const config = loadConfigFromFile(path, env);
    if (flags.model !== undefined) {
      assertConfiguredModel(config, flags.model);
    }
    const modelId = flags.model ?? selectConfiguredModel(config, { kind: "chat" });
    if (modelId === undefined) {
      io.err("Error: no configured chat model is available.\n");
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

function outcomeToExitCode(result: RunResult, io: CliIo): number {
  if (result.outcome === "completed") {
    io.out(`run ${result.runId} completed (fingerprint ${result.fingerprint})\n`);
    return 0;
  }
  if (result.outcome === "cancelled") {
    io.err(`run ${result.runId} cancelled\n`);
    return 1;
  }
  const category = result.failure?.category ?? "HARNESS_INTERNAL";
  io.err(`run ${result.runId} ${result.outcome} [${category}]: ${result.failure?.message ?? ""}\n`);
  return 1;
}

export async function runAgentCli(
  args: readonly string[],
  io: CliIo,
  env: EnvSource = {},
  deps: RunDeps = {},
): Promise<number> {
  const taskType = args[0];
  if (taskType === undefined || !TASK_TYPES.has(taskType)) {
    io.err(taskType === undefined ? USAGE : `keiko run: unknown task type: ${taskType}\n${USAGE}`);
    return 2;
  }
  const task = parseTask(taskType as CliTaskType, args.slice(1));
  if (task === null) {
    io.err(`keiko run: missing required argument for ${taskType}.\n${USAGE}`);
    return 2;
  }
  const flags = parseEvidenceFlags(args);
  const model = resolveModel(flags, io, env, deps);
  if (typeof model === "number") {
    return model;
  }
  const memory = new MemoryEventSink();
  const config: AgentConfig = { model: model.modelId, workingDirectory: ".", dryRun: true };
  const session = createSession(task, config, {
    model: model.port,
    tools: new DryRunToolPort(),
    sink: teeSink([memory, new CliEventSink(io)]),
  });
  const result = await session.result;
  if (flags.write) {
    const evidenceFailure = writeEvidence(
      result,
      memory,
      task,
      { flags, env, deps },
      io,
      model.modelId,
    );
    if (evidenceFailure !== undefined) {
      return evidenceFailure;
    }
  }
  return outcomeToExitCode(result, io);
}
