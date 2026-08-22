// `keiko investigate` — investigates a bounded bug report and proposes a minimal fix + a
// regression test (ADR-0009 D14). Dry-run by default; --apply writes the fix and runs verification.
// The text path prints the proposed diff (when present) plus clearly-labelled verified facts and
// the UNVERIFIED model hypothesis; --json emits the full BugInvestigationReport. Failing output and
// stack traces may be read from files (--output-file / --stack-file) to avoid huge argv. Evidence
// files are read through the workspace boundary, never raw node:fs. The gateway ModelPort is built
// from config (loadGatewayConfigFromFile); tests inject deps.model directly so no live gateway is needed.
// Exit 0 on fix-applied/fix-proposed/investigation-only, 1 on
// rejected/cancelled/failed/runtime, 2 on usage. Mirrors runGenTestsCli's structure.
//
// Wave 6 closeout (epic #3233, w6-investigate-from-timeline):
//   - `--from-timeline PATH` reads a `LogTimeline` JSON file (the shape `keiko support analyze
//     --json --correlation-id ID` emits — see `./support-analyze.js`) and, via
//     `timelineToBugReportInput`, seeds the SAME BugReportInput shape --stack-file already accepts
//     from reconstructed log evidence: `frames` -> a synthesized "at <frame>" stackTrace (one frame
//     per line, matching `failure-parse.ts`'s `peelLocation` so the workflow's own failureFrames
//     reference the identical file:line pairs), `errorKinds`/observed `op`s -> `description`, frame
//     file paths -> `targetFiles`. The file is untrusted input (a trust boundary — AGENTS.md §7), so
//     its shape is validated before use; a malformed file fails closed via `InvalidTimelineFileError`.
//   - g23: the UI/BFF bug-investigation path already persists evidence (keiko-server's
//     `evidence.ts`); this CLI path did not. `runInvestigateCli` now threads
//     `persistWorkflowEvidence` (mirroring `runAgentCli`'s `writeEvidence`) on by default, with the
//     same `--no-evidence` opt-out `keiko run` has. The evidence report is written to the store but
//     — unlike `keiko run` — never echoed to stdout, so `--json`'s single-JSON-object contract stays
//     intact; a write failure still fails the command closed (exit 1) before the report is printed.

import type { EnvSource } from "@oscharko-dev/keiko-model-gateway";
import type { ModelPort } from "@oscharko-dev/keiko-harness";
import type { WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import type { EvidenceStore } from "@oscharko-dev/keiko-evidence";
import type {
  BugInvestigationEvent,
  BugInvestigationReport,
  BugReportInput,
  BugWorkflowEventSink,
} from "@oscharko-dev/keiko-workflows";
import { loadGatewayConfigFromFile } from "./gateway-config.js";
// GEN-PERF-CLI-001 — heavy graphs load at dispatch; module scope stays type-only.
import {
  loadEvidence,
  loadHarness,
  loadModelGateway,
  loadWorkflows,
  loadWorkspaceModule,
} from "./lazy-modules.js";
import type { CliIo } from "./runner.js";
import type { LogTimeline, ServerLogLineView } from "./support-analyze.js";

type GatewayModule = typeof import("@oscharko-dev/keiko-model-gateway");
type HarnessModule = typeof import("@oscharko-dev/keiko-harness");
type WorkspacePackage = typeof import("@oscharko-dev/keiko-workspace");
type EvidenceModule = typeof import("@oscharko-dev/keiko-evidence");
type WorkflowsModule = typeof import("@oscharko-dev/keiko-workflows");

const USAGE = `Usage:
  keiko investigate [--description TEXT] [--output TEXT | --output-file PATH]
                    [--stack TEXT | --stack-file PATH] [--file PATH[,PATH]]
                    [--from-timeline PATH]
                    [--apply] [--model MODEL_ID] [--config PATH] [--json] [--dir-root PATH]
                    [--no-evidence] [--evidence-dir PATH]

Investigates a bounded bug report and proposes a root-cause hypothesis with a
minimal fix and a regression test, separating verified facts from model
hypotheses. At least one evidence source is required (--description, --output[-file],
--stack[-file], --file, or --from-timeline). Dry-run by default (writes nothing); pass --apply to
write the fix and run verification through the safe tool + verification layers.

  --from-timeline PATH     Seed the report from a LogTimeline JSON file (the output of
                            keiko support analyze --json --correlation-id ID). Combines with
                            --description/--output[-file]/--stack[-file]/--file, which take
                            precedence over the timeline-derived value for the same field.
  --no-evidence             Do not write an evidence manifest (written by default, matching
                            keiko run).
  --evidence-dir PATH      Write evidence under PATH (default $KEIKO_EVIDENCE_DIR or ./.keiko/evidence).
`;

export interface InvestigateDeps {
  // Injected ModelPort for tests. When absent, a GatewayModelPort is built from config.
  readonly model?: ModelPort | undefined;
  // Injected file reader for tests. Production defaults to readWorkspaceFile.
  readonly readFile?: ((path: string) => string) | undefined;
  // Injected EvidenceStore for tests. Production defaults to a node store under the resolved
  // evidence dir (mirrors RunDeps.store in run.ts).
  readonly store?: EvidenceStore | undefined;
}

interface InvestigateArgs {
  readonly description: string | undefined;
  readonly output: string | undefined;
  readonly outputFile: string | undefined;
  readonly stack: string | undefined;
  readonly stackFile: string | undefined;
  readonly files: readonly string[] | undefined;
  readonly fromTimeline: string | undefined;
  readonly apply: boolean;
  readonly model: string | undefined;
  readonly config: string | undefined;
  readonly json: boolean;
  readonly dirRoot: string;
  readonly noEvidence: boolean;
  readonly evidenceDir: string | undefined;
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
  "--from-timeline",
  "--model",
  "--config",
  "--dir-root",
  "--evidence-dir",
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
    fromTimeline: values["--from-timeline"],
    apply: args.includes("--apply"),
    model: values["--model"],
    config: values["--config"],
    json: args.includes("--json"),
    dirRoot: values["--dir-root"] ?? ".",
    noEvidence: args.includes("--no-evidence"),
    evidenceDir: values["--evidence-dir"],
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
    parsed.files !== undefined ||
    parsed.fromTimeline !== undefined
  );
}

// A `packages/<pkg>/(dist|src)/relative.(js|ts):LINE:COL` frame (stack-frames.ts's reducer shape)
// with its trailing `:LINE:COL` peeled off, the same way `failure-parse.ts`'s `peelLocation` would
// read it back off an "at <frame>" stackTrace line. Bounded string ops only (no ReDoS surface),
// matching that module's own discipline for evidence-derived, not attacker-typed, text.
const ALL_DIGITS = /^\d+$/;

function framePath(frame: string): string {
  const parts = frame.split(":");
  const last = parts.at(-1);
  const secondLast = parts.at(-2);
  if (
    last !== undefined &&
    secondLast !== undefined &&
    ALL_DIGITS.test(last) &&
    ALL_DIGITS.test(secondLast)
  ) {
    return parts.slice(0, -2).join(":");
  }
  return frame;
}

function timelineFramePaths(frames: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const frame of frames) {
    const path = framePath(frame);
    if (path.length > 0 && !seen.has(path)) {
      seen.add(path);
      paths.push(path);
    }
  }
  return paths;
}

function timelineOps(lines: readonly ServerLogLineView[]): readonly string[] {
  const seen = new Set<string>();
  const ops: string[] = [];
  for (const line of lines) {
    if (!seen.has(line.op)) {
      seen.add(line.op);
      ops.push(line.op);
    }
  }
  return ops;
}

// Content-free by construction: op names and errorKind are already closed-vocabulary strings the
// analyzer read off the log envelope, never prose or raw values.
function timelineDescription(timeline: LogTimeline): string | undefined {
  const ops = timelineOps(timeline.lines);
  if (ops.length === 0 && timeline.errorKinds.length === 0) {
    return undefined;
  }
  const parts = [`Reconstructed from log timeline (correlationId=${timeline.correlationId}).`];
  if (ops.length > 0) {
    parts.push(`Operations observed: ${ops.join(", ")}.`);
  }
  if (timeline.errorKinds.length > 0) {
    parts.push(`Error kinds: ${timeline.errorKinds.join(", ")}.`);
  }
  return parts.join(" ");
}

// Maps a reconstructed LogTimeline onto the exact BugReportInput shape --stack-file already
// accepts: `frames` -> a synthesized "at <frame>" stackTrace (one frame per line — `peelLocation`
// then recovers the identical file:line pairs `verified.failureFrames` reports), observed `op`s and
// `errorKinds` -> `description`, frame file paths -> `targetFiles`.
export function timelineToBugReportInput(timeline: LogTimeline): BugReportInput {
  const description = timelineDescription(timeline);
  const stackTrace =
    timeline.frames === undefined
      ? undefined
      : timeline.frames.map((frame) => `at ${frame}`).join("\n");
  const targetFiles =
    timeline.frames === undefined ? undefined : timelineFramePaths(timeline.frames);
  return {
    ...(description === undefined ? {} : { description }),
    ...(stackTrace === undefined ? {} : { stackTrace }),
    ...(targetFiles === undefined || targetFiles.length === 0 ? {} : { targetFiles }),
  };
}

function isServerLogLineView(value: unknown): value is ServerLogLineView {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.ts === "string" &&
    typeof record.category === "string" &&
    typeof record.op === "string"
  );
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function hasLogTimelineCoreFields(record: Record<string, unknown>): boolean {
  return (
    typeof record.correlationId === "string" &&
    Array.isArray(record.lines) &&
    record.lines.every(isServerLogLineView) &&
    typeof record.firstTs === "string" &&
    typeof record.lastTs === "string" &&
    typeof record.durationMs === "number"
  );
}

// `--from-timeline`'s file crosses a trust boundary (AGENTS.md §7: "assume workspace input ...
// is hostile") — validate its shape structurally before trusting it as a LogTimeline, rather than
// trusting whatever JSON.parse happened to accept.
function isLogTimeline(value: unknown): value is LogTimeline {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    hasLogTimelineCoreFields(record) &&
    isStringArray(record.errorKinds) &&
    (record.frames === undefined || isStringArray(record.frames))
  );
}

// Content-free: `reason` is always one of the two static strings below, never file content.
export class InvalidTimelineFileError extends Error {
  constructor(reason: string) {
    super(`invalid --from-timeline file: ${reason}`);
    this.name = "InvalidTimelineFileError";
  }
}

function parseTimelineFile(raw: string): LogTimeline {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new InvalidTimelineFileError("malformed JSON");
  }
  if (!isLogTimeline(parsed)) {
    throw new InvalidTimelineFileError("not a valid LogTimeline (missing or malformed fields)");
  }
  return parsed;
}

// `--from-timeline` is read through the same workspace-bounded `readFile` as --output-file /
// --stack-file (never raw node:fs) so it is subject to the identical workspace-escape guard.
function timelineBaseReport(
  parsed: InvestigateArgs,
  readFile: (path: string) => string,
): BugReportInput {
  if (parsed.fromTimeline === undefined) {
    return {};
  }
  return timelineToBugReportInput(parseTimelineFile(readFile(parsed.fromTimeline)));
}

// Resolves the failing output and stack trace, reading from files when the *-file flags are set.
// The inline flag is used only when its file counterpart is absent. Throws on a read failure (the
// CLI catch maps it to a runtime error). `--from-timeline`-derived fields are the BASE; any
// explicit --description/--output[-file]/--stack[-file]/--file flag overrides the same field.
function resolveReport(
  parsed: InvestigateArgs,
  readFile: (path: string) => string,
): BugReportInput {
  const failingOutput =
    parsed.outputFile !== undefined ? readFile(parsed.outputFile) : parsed.output;
  const stackTrace = parsed.stackFile !== undefined ? readFile(parsed.stackFile) : parsed.stack;
  return {
    ...timelineBaseReport(parsed, readFile),
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

// g-#3245-2: prints the persisted evidence path, matching `keiko run`'s UX, without echoing the
// full evidence report — that would break --json's single-JSON-object contract (see this file's
// header comment on g23). `undefined` (evidence write skipped via --no-evidence, or never ran)
// prints nothing extra, same as before this field existed.
function emitReport(
  report: BugInvestigationReport,
  io: CliIo,
  json: boolean,
  renderBugMarkdownReport: (report: BugInvestigationReport) => string,
  evidenceLocation: string | undefined,
): number {
  if (json) {
    const payload =
      evidenceLocation === undefined ? report : { ...report, evidencePath: evidenceLocation };
    io.out(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    printText(report, io, renderBugMarkdownReport);
    if (evidenceLocation !== undefined) {
      io.out(`Evidence: ${evidenceLocation}\n`);
    }
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
  if (error instanceof InvalidTimelineFileError) {
    io.err(`Error: ${error.message}\n`);
    return 1;
  }
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

// Buffers every emitted BugInvestigationEvent so the evidence path (g23) can fold them into the
// usage totals AND read the run's runId/fingerprint off the first event — `bug:started` is always
// emitted first (workflow.ts's `runPipeline`), unconditionally, before the intake precondition.
function collectingSink(events: BugInvestigationEvent[]): BugWorkflowEventSink {
  return {
    emit: (event: BugInvestigationEvent): void => {
      events.push(event);
    },
  };
}

function terminalStatusFor(
  status: BugInvestigationReport["status"],
): "completed" | "cancelled" | "failed" {
  if (status === "cancelled") {
    return "cancelled";
  }
  if (status === "rejected" || status === "failed") {
    return "failed";
  }
  return "completed";
}

interface InvestigateEvidenceContext {
  readonly env: EnvSource;
  readonly deps: InvestigateDeps;
  readonly gateway: GatewayModule;
  readonly evidence: EvidenceModule;
  // The raw --evidence-dir value (undefined when absent); resolveEvidenceDir layers in the env
  // var / default, same precedence run.ts's --evidence-dir already uses.
  readonly evidenceDir: string | undefined;
}

// Persists a terminated investigation's redacted evidence manifest (g23 — parity with the UI/BFF
// bug-investigation path, which already persists via keiko-server's `evidence.ts`). This is a
// system-boundary filesystem write, so try/catch is correct here (AGENTS.md §7): on any failure —
// typed AuditError or otherwise — print a REDACTED message and report exit code 1, mirroring
// runAgentCli's `writeEvidence`. "written" carries the persisted evidence location (g-#3245-2:
// --evidence-dir parity with `keiko run`, which prints its own persisted path via
// `renderEvidenceReport`) so the caller can echo it; "skipped" is the `events[0]`-absent case
// (dead in practice — it cannot happen once `investigateBug` has resolved a report — kept only so
// this function's own type stays honest); "failed" is a real write failure, already reported to
// stderr.
type EvidenceWriteOutcome =
  | { readonly kind: "written"; readonly evidenceLocation: string }
  | { readonly kind: "skipped" }
  | { readonly kind: "failed"; readonly exitCode: number };

function writeInvestigateEvidence(
  report: BugInvestigationReport,
  events: readonly BugInvestigationEvent[],
  modelId: string,
  workspaceRoot: string,
  startedAt: number,
  ctx: InvestigateEvidenceContext,
  io: CliIo,
): EvidenceWriteOutcome {
  const first = events[0];
  if (first === undefined) {
    return { kind: "skipped" };
  }
  const { evidence, gateway } = ctx;
  try {
    const store =
      ctx.deps.store ??
      evidence.createNodeEvidenceStore(evidence.resolveEvidenceDir(ctx.evidenceDir, ctx.env));
    const persisted = evidence.persistWorkflowEvidence(
      {
        runId: first.runId,
        fingerprint: first.fingerprint,
        modelId,
        kind: "bug-investigation",
        status: terminalStatusFor(report.status),
        startedAt,
        finishedAt: Date.now(),
        workspaceRoot,
      },
      report,
      events,
      { store, env: ctx.env, costClassResolver: gateway.resolveCostClass },
    );
    return { kind: "written", evidenceLocation: persisted.evidenceLocation };
  } catch (error) {
    const detail =
      error instanceof evidence.AuditError ? error.message : gateway.redact(String(error));
    io.err(`keiko investigate: failed to write evidence: ${detail}\n`);
    return { kind: "failed", exitCode: 1 };
  }
}

// Split out of `investigateAndEmit` to keep that function's line count under the repository's
// ceiling (AGENTS.md §6). `--no-evidence` short-circuits to "nothing persisted" without touching
// the store at all, same as before this helper existed.
interface PersistEvidenceInput {
  readonly parsed: InvestigateArgs;
  readonly report: BugInvestigationReport;
  readonly events: readonly BugInvestigationEvent[];
  readonly modelId: string;
  readonly workspaceRoot: string;
  readonly startedAt: number;
  readonly env: EnvSource;
  readonly deps: InvestigateDeps;
  readonly modules: { readonly gateway: GatewayModule; readonly evidence: EvidenceModule };
  readonly io: CliIo;
}

function persistEvidenceIfEnabled(
  input: PersistEvidenceInput,
): { readonly evidenceLocation: string | undefined } | { readonly exitCode: number } {
  const { parsed, modules } = input;
  if (parsed.noEvidence) {
    return { evidenceLocation: undefined };
  }
  const outcome = writeInvestigateEvidence(
    input.report,
    input.events,
    input.modelId,
    input.workspaceRoot,
    input.startedAt,
    {
      env: input.env,
      deps: input.deps,
      gateway: modules.gateway,
      evidence: modules.evidence,
      evidenceDir: parsed.evidenceDir,
    },
    input.io,
  );
  if (outcome.kind === "failed") {
    return { exitCode: outcome.exitCode };
  }
  return { evidenceLocation: outcome.kind === "written" ? outcome.evidenceLocation : undefined };
}

async function investigateAndEmit(
  parsed: InvestigateArgs,
  io: CliIo,
  env: EnvSource,
  deps: InvestigateDeps,
  model: { port: ModelPort; modelId: string },
  modules: {
    readonly workflows: WorkflowsModule;
    readonly workspaceModule: WorkspacePackage;
    readonly gateway: GatewayModule;
    readonly evidence: EvidenceModule;
  },
): Promise<number> {
  const workspace = modules.workspaceModule.detectWorkspace(parsed.dirRoot);
  const readFile =
    deps.readFile ?? workspaceEvidenceReader(workspace, modules.workspaceModule.readWorkspaceFile);
  const events: BugInvestigationEvent[] = [];
  const startedAt = Date.now();
  const report = await modules.workflows.investigateBug(
    {
      workspaceRoot: workspace.root,
      report: resolveReport(parsed, readFile),
      apply: parsed.apply,
      modelId: model.modelId,
    },
    { model: model.port, sink: collectingSink(events) },
  );
  const evidenceOutcome = persistEvidenceIfEnabled({
    parsed,
    report,
    events,
    modelId: model.modelId,
    workspaceRoot: workspace.root,
    startedAt,
    env,
    deps,
    modules,
    io,
  });
  if ("exitCode" in evidenceOutcome) {
    return evidenceOutcome.exitCode;
  }
  return emitReport(
    report,
    io,
    parsed.json,
    modules.workflows.renderBugMarkdownReport,
    evidenceOutcome.evidenceLocation,
  );
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
  const [gateway, harness, workflows, workspaceModule, evidence] = await Promise.all([
    loadModelGateway(),
    loadHarness(),
    loadWorkflows(),
    loadWorkspaceModule(),
    loadEvidence(),
  ]);
  const model = await resolveModel(parsed, io, env, deps, gateway, harness);
  if (typeof model === "number") {
    return model;
  }
  try {
    return await investigateAndEmit(parsed, io, env, deps, model, {
      workflows,
      workspaceModule,
      gateway,
      evidence,
    });
  } catch (error) {
    return handleCliError(error, io, gateway, workspaceModule);
  }
}

// A Node fs read error carries a string `code` from a fixed errno set. `code` alone is the
// discriminant of the repository's own typed error taxonomy too (GatewayError,
// ProviderCredentialVaultError, …), so a bare "has a non-empty string code" predicate
// misclassified every typed non-fs error as a file-read failure and told the operator to check
// evidence paths that were perfectly fine. Narrow to the fs errno codes we actually see through
// the workspace file reader (KEIKO-0464). Extended (PR-review follow-up) to cover I/O and
// descriptor-exhaustion errors that also surface as legitimate read failures under load: EIO
// (hardware/driver), ENFILE (system-wide fd cap), ETIMEDOUT (network filesystem), and EBUSY
// (path temporarily in use). Domain-error codes stay excluded — they never begin with 'E'
// followed by a POSIX errno name.
const FS_READ_ERROR_CODES: ReadonlySet<string> = new Set([
  "ENOENT",
  "EACCES",
  // PR-review follow-up (KfQ thread 3769766886): EPERM (POSIX "operation not permitted",
  // e.g. capability-scoped denial distinct from EACCES) and EROFS ("read-only filesystem",
  // e.g. a volume that flipped to RO mid-read on external media) both surface as legitimate
  // read failures the CLI should convert to a user-visible message instead of rethrowing.
  "EPERM",
  "EROFS",
  "EISDIR",
  "ENOTDIR",
  "ELOOP",
  "ENAMETOOLONG",
  "EMFILE",
  "ENFILE",
  "EIO",
  "ETIMEDOUT",
  "EBUSY",
]);

function isFileReadError(error: Error): boolean {
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && FS_READ_ERROR_CODES.has(code);
}
