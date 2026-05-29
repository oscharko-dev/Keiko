// `keiko run` — the dry-run task command. It builds an AgentSession wired to deterministic mocked
// model/tool fixtures (no provider call, no real tools) and renders the HarnessEvent stream to
// CliIo. Since ADR-0010 it ALSO writes a redacted evidence manifest by default (evidence is the
// product value): a tee EventSink forwards every event to BOTH a MemoryEventSink (which retains raw
// content to assemble the replay manifest) and the existing CliEventSink (whose summarisers never
// print sensitive fields). After the run resolves, the audit layer builds + redacts + persists the
// manifest and the EvidenceReport is printed. Writing is on by default; --no-evidence disables it,
// --evidence-dir relocates it. Tests inject an in-memory EvidenceStore via deps so no write ever
// touches the repository tree.

import type { GatewayRequest, NormalizedResponse } from "../gateway/types.js";
import { DryRunToolPort } from "../harness/adapters.js";
import { createSession, HARNESS_VERSION, type AgentConfig } from "../harness/session.js";
import { CliEventSink, MemoryEventSink, type ManifestSeed } from "../harness/sinks.js";
import type { EventSink } from "../harness/ports.js";
import type { HarnessEvent, RunResult, TaskInput, TaskType } from "../harness/types.js";
import { DEFAULT_LIMITS } from "../harness/types.js";
import { persistEvidence } from "../audit/persist.js";
import { renderEvidenceReport } from "../audit/report.js";
import { createNodeEvidenceStore, resolveEvidenceDir, type EvidenceStore } from "../audit/store.js";
import { AuditError } from "../audit/errors.js";
import { redact } from "../gateway/redaction.js";
import type { EnvSource } from "../gateway/config.js";
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

All tasks run in dry-run mode: a patch is proposed as an event, never written to disk.
`;

// Test seam: inject an in-memory EvidenceStore so CLI tests never write to the repo tree.
export interface RunDeps {
  readonly store?: EvidenceStore | undefined;
}

interface EvidenceFlags {
  readonly write: boolean;
  // The raw --evidence-dir value (undefined when absent); the env var / default is layered in later.
  readonly evidenceDirFlag: string | undefined;
  readonly includeReasoning: boolean;
  readonly includeDiff: boolean;
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
  };
}

// A deterministic, dependency-free canned final response. It never requests tools, so the dry-run
// path is reproducible regardless of task type.
function cannedResponse(): NormalizedResponse {
  return {
    modelId: "mock-model",
    content: "--- a/file\n+++ b/file\n+// dry-run proposed change\n",
    finishReason: "stop",
    toolCalls: [],
    structuredOutput: null,
    usage: {
      requestId: "dry-run",
      promptTokens: 0,
      completionTokens: 0,
      latencyMs: 1,
      costClass: "low",
    },
  };
}

function parseTask(taskType: TaskType, args: readonly string[]): TaskInput | null {
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

function seedFor(task: TaskInput, result: RunResult): ManifestSeed {
  return {
    runId: result.runId,
    fingerprint: result.fingerprint,
    harnessVersion: HARNESS_VERSION,
    taskType: task.taskType,
    taskInput: task,
    limits: DEFAULT_LIMITS,
    modelId: "mock-model",
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
): number | undefined {
  try {
    const manifest = memory.collectManifest(seedFor(task, result));
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
      { store, env: ctx.env },
    );
    io.out(renderEvidenceReport(out.report));
    return undefined;
  } catch (error) {
    const detail = error instanceof AuditError ? error.message : redact(String(error));
    io.err(`keiko run: failed to write evidence: ${detail}\n`);
    return 1;
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
  const task = parseTask(taskType as TaskType, args.slice(1));
  if (task === null) {
    io.err(`keiko run: missing required argument for ${taskType}.\n${USAGE}`);
    return 2;
  }
  const flags = parseEvidenceFlags(args);
  const response = cannedResponse();
  const memory = new MemoryEventSink();
  const config: AgentConfig = { model: "mock-model", workingDirectory: ".", dryRun: true };
  const session = createSession(task, config, {
    model: {
      call: (request: GatewayRequest): Promise<NormalizedResponse> =>
        Promise.resolve({ ...response, modelId: request.modelId }),
    },
    tools: new DryRunToolPort(),
    sink: teeSink([memory, new CliEventSink(io)]),
  });
  const result = await session.result;
  if (flags.write) {
    const evidenceFailure = writeEvidence(result, memory, task, { flags, env, deps }, io);
    if (evidenceFailure !== undefined) {
      return evidenceFailure;
    }
  }
  return outcomeToExitCode(result, io);
}
