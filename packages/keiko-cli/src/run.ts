// `keiko run` — the dry-run task command. It builds an AgentSession with the configured model
// gateway and a dry-run tool port (provider call is real, tools are non-mutating) and renders the
// HarnessEvent stream to CliIo. Since ADR-0010 it ALSO writes a redacted evidence manifest by
// default (evidence is the product value): a tee EventSink forwards every event to BOTH a
// MemoryEventSink (which retains raw content to assemble the replay manifest) and the existing
// CliEventSink (whose summarisers never print sensitive fields). After the run resolves, the audit
// layer builds + redacts + persists the manifest and the EvidenceReport is printed. Writing is on by
// default; --no-evidence disables it, --evidence-dir relocates it. Tests inject an in-memory
// EvidenceStore via deps so no write ever touches the repository tree.
//
// GEN-PERF-CLI-001 — the gateway/harness/evidence module graphs load once at dispatch inside
// runAgentCli and are threaded into the helpers; module scope holds type imports only, so
// evaluating this file (which the CLI barrel does on every `keiko` invocation) stays cheap.

import type { EnvSource } from "@oscharko-dev/keiko-model-gateway";
import type {
  AgentConfig,
  EventSink,
  HarnessEvent,
  HarnessShaperPort,
  ManifestSeed,
  MemoryEventSink,
  ModelPort,
  RunResult,
  TaskInput,
  TaskType,
} from "@oscharko-dev/keiko-harness";
import type { EvidenceStore } from "@oscharko-dev/keiko-evidence";
import { loadGatewayConfigFromFile } from "./gateway-config.js";
import { loadEvidence, loadHarness, loadModelGateway } from "./lazy-modules.js";
import type { CliIo } from "./runner.js";
import { createHarnessToolShaper } from "./tool-shaper.js";

type GatewayModule = typeof import("@oscharko-dev/keiko-model-gateway");
type HarnessModule = typeof import("@oscharko-dev/keiko-harness");
type EvidenceModule = typeof import("@oscharko-dev/keiko-evidence");
type RedactFn = GatewayModule["redact"];

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
function teeSink(sinks: readonly EventSink[], redact: RedactFn): EventSink {
  return {
    retainsRawContent: true,
    emit: (event: HarnessEvent): void => {
      const redacted = redactEventForNonRetainingSink(event, redact);
      for (const sink of sinks) {
        sink.emit(sink.retainsRawContent === true ? event : redacted);
      }
    },
  };
}

function redactEventForNonRetainingSink(event: HarnessEvent, redact: RedactFn): HarnessEvent {
  if (event.type === "run:failed") {
    return redactRunFailedEvent(event, redact);
  }
  if (event.type === "run:completed") {
    return redactRunCompletedEvent(event, redact);
  }
  if (event.type === "reasoning:trace") {
    return redactReasoningTraceEvent(event, redact);
  }
  if (event.type === "run:cancelled" && event.reason !== undefined) {
    return { ...event, reason: redact(event.reason) };
  }
  if (event.type === "model:call:failed" || event.type === "tool:call:failed") {
    return { ...event, message: redact(event.message) };
  }
  if (event.type === "patch:proposed") return { ...event, diff: redact(event.diff) };
  if (event.type === "verification:result") return { ...event, detail: redact(event.detail) };
  return event;
}

function redactRunFailedEvent(
  event: Extract<HarnessEvent, { type: "run:failed" }>,
  redact: RedactFn,
): HarnessEvent {
  return {
    ...event,
    failure: {
      ...event.failure,
      message: redact(event.failure.message),
      ...(event.failure.detail === undefined ? {} : { detail: redact(event.failure.detail) }),
    },
  };
}

function redactRunCompletedEvent(
  event: Extract<HarnessEvent, { type: "run:completed" }>,
  redact: RedactFn,
): HarnessEvent {
  return {
    ...event,
    report: redact(event.report),
    ...(event.patchDiff === undefined ? {} : { patchDiff: redact(event.patchDiff) }),
  };
}

function redactReasoningTraceEvent(
  event: Extract<HarnessEvent, { type: "reasoning:trace" }>,
  redact: RedactFn,
): HarnessEvent {
  return {
    ...event,
    rationale: redact(event.rationale),
    ...(event.modelResponse === undefined ? {} : { modelResponse: redact(event.modelResponse) }),
  };
}

function seedFor(
  task: TaskInput,
  result: RunResult,
  modelId: string,
  harness: HarnessModule,
): ManifestSeed {
  return {
    runId: result.runId,
    fingerprint: result.fingerprint,
    harnessVersion: harness.HARNESS_VERSION,
    taskType: task.taskType,
    taskInput: task,
    limits: harness.DEFAULT_LIMITS,
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
  readonly gateway: GatewayModule;
  readonly harness: HarnessModule;
  readonly evidence: EvidenceModule;
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
  const { evidence, gateway, harness } = ctx;
  try {
    const manifest = memory.collectManifest(seedFor(task, result, modelId, harness));
    const store =
      ctx.deps.store ??
      evidence.createNodeEvidenceStore(
        evidence.resolveEvidenceDir(ctx.flags.evidenceDirFlag, ctx.env),
      );
    const out = evidence.persistEvidence(
      {
        result,
        manifest,
        options: {
          includeReasoning: ctx.flags.includeReasoning,
          includeDiff: ctx.flags.includeDiff,
        },
      },
      { store, env: ctx.env, costClassResolver: gateway.resolveCostClass },
    );
    io.out(evidence.renderEvidenceReport(out.report));
    return undefined;
  } catch (error) {
    const detail =
      error instanceof evidence.AuditError ? error.message : ctx.gateway.redact(String(error));
    io.err(`keiko run: failed to write evidence: ${detail}\n`);
    return 1;
  }
}

async function buildHarnessToolShaper(
  flags: EvidenceFlags,
  env: EnvSource,
  evidence: EvidenceModule,
): Promise<HarnessShaperPort> {
  if (!flags.write) {
    return createHarnessToolShaper();
  }
  return createHarnessToolShaper({
    artifactWriter: evidence.createNodeToolResultArtifactStore(
      evidence.resolveEvidenceDir(flags.evidenceDirFlag, env),
    ),
  });
}

async function configuredModelId(
  flags: EvidenceFlags,
  env: EnvSource,
  gateway: GatewayModule,
): Promise<string | undefined> {
  const path = flags.config ?? env.KEIKO_CONFIG_FILE;
  if (path === undefined) {
    return flags.model;
  }
  const config = await loadGatewayConfigFromFile(path, env);
  if (flags.model !== undefined) {
    gateway.assertConfiguredModel(config, flags.model);
    return flags.model;
  }
  return gateway.selectConfiguredModel(config, { kind: "chat" });
}

async function resolveModel(
  flags: EvidenceFlags,
  io: CliIo,
  env: EnvSource,
  deps: RunDeps,
  gateway: GatewayModule,
  harness: HarnessModule,
): Promise<{ port: ModelPort; modelId: string } | number> {
  try {
    if (deps.model !== undefined) {
      const modelId = await configuredModelId(flags, env, gateway);
      if (modelId === undefined) {
        io.err("Error: no model id available; pass --model MODEL_ID for injected test runs.\n");
        return 1;
      }
      return { port: deps.model, modelId };
    }
    const path = flags.config ?? env.KEIKO_CONFIG_FILE;
    if (path === undefined) {
      throw new gateway.ConfigInvalidError(
        "no config source; pass --config PATH or set KEIKO_CONFIG_FILE",
      );
    }
    const config = await loadGatewayConfigFromFile(path, env);
    if (flags.model !== undefined) {
      gateway.assertConfiguredModel(config, flags.model);
    }
    const modelId = flags.model ?? gateway.selectConfiguredModel(config, { kind: "chat" });
    if (modelId === undefined) {
      io.err("Error: no configured chat model is available.\n");
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

function outcomeToExitCode(result: RunResult, io: CliIo, redact: RedactFn): number {
  if (result.outcome === "completed") {
    io.out(`run ${result.runId} completed (fingerprint ${result.fingerprint})\n`);
    return 0;
  }
  if (result.outcome === "cancelled") {
    io.err(`run ${result.runId} cancelled\n`);
    return 1;
  }
  const category = result.failure?.category ?? "HARNESS_INTERNAL";
  const message = redact(result.failure?.message ?? "");
  io.err(`run ${result.runId} ${result.outcome} [${category}]: ${message}\n`);
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
  const [gateway, harness, evidence] = await Promise.all([
    loadModelGateway(),
    loadHarness(),
    loadEvidence(),
  ]);
  const model = await resolveModel(flags, io, env, deps, gateway, harness);
  if (typeof model === "number") {
    return model;
  }
  const memory = new harness.MemoryEventSink();
  const config: AgentConfig = { model: model.modelId, workingDirectory: ".", dryRun: true };
  const session = harness.createSession(task, config, {
    model: model.port,
    tools: new harness.DryRunToolPort(),
    sink: teeSink([memory, new harness.CliEventSink(io)], gateway.redact),
    shaperPort: await buildHarnessToolShaper(flags, env, evidence),
  });
  const result = await session.result;
  if (flags.write) {
    const evidenceFailure = writeEvidence(
      result,
      memory,
      task,
      { flags, env, deps, gateway, harness, evidence },
      io,
      model.modelId,
    );
    if (evidenceFailure !== undefined) {
      return evidenceFailure;
    }
  }
  return outcomeToExitCode(result, io, gateway.redact);
}
