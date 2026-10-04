import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  ACTIVITY_LOG_DIRECTORY_NAME,
  MAX_SUPPORT_REPORT_BYTES,
  MAX_SUPPORT_REPORT_EVENT_BYTES,
  SUPPORT_REPORT_DIRECTORY_NAME,
  supportIncidentPrivateProjection,
  supportReportFileName,
  type SupportIncidentRecord,
  type SupportIncidentDescriptorRecord,
  type SupportReport,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import type { EnvSource } from "@oscharko-dev/keiko-model-gateway";
import {
  SafeArtifactFileError,
  isSafeArtifactStageFileName,
} from "@oscharko-dev/keiko-security/fs-hardening";
import {
  createFileServerLogSink,
  reportServerLogFailure,
  listSupportIncidents,
  readSupportIncident,
  type ServerLogSink,
} from "@oscharko-dev/keiko-activity-log";
import {
  prepareManualSupportReportIncident,
  readManualSupportReportEvidence,
  DesktopSupportReportPreparationError,
  analyzeSupportReport,
  buildSupportReport,
  describeErrorKind,
  serializeSupportReport,
  SupportReportError,
  renderHumanAllTimelines,
  renderHumanClusters,
  renderHumanTimeline,
  findTimeline,
  hasIssueToPrJourneyOps,
  prepareSupportReportSeed,
  renderHumanReproductionSeed,
  renderGatewayReplayScriptFixture,
  supportReportTimeline,
  type AnalyzedSupportReport,
  type ReproductionSeed,
  type SupportAnalyzeOptions,
  resolveSelectedSupportIncident,
} from "@oscharko-dev/keiko-activity-log/reader";
import {
  cliControlStateConflictsWithTarget,
  cliDirectoryIsWithin,
  cliTargetIsAtOrBelow,
  resolveCliControlStateDir,
} from "./cli-control-state.js";
import { resolveStateDir } from "./state-paths.js";
import { loadActivityLog, loadToolLifecycle } from "./lazy-modules.js";
import { collectSupportReportQuery } from "./support-selective-export.js";
import { type SupportQueryRun, type SupportSelectorArgs } from "./support-query-cli.js";
import {
  emitSupportReportStarted,
  emitSupportReportCompleted,
  emitSupportReportDegraded,
  emitSupportReportFailed,
  supportReportFailureReason,
  type SupportReportAnalysisOutcome,
  type SupportReportSurface,
} from "./support-report-evidence.js";
import {
  publishSupportReportFile,
  readSupportReportFile,
  type SupportReportPublication,
} from "./support-export.js";
import type { SupportCliDeps } from "./support.js";
import type { CliIo } from "./runner.js";

export interface SafeSupportExportArgs {
  readonly out: string | undefined;
  readonly stateDir: string | undefined;
  readonly maxBytes: number | undefined;
  readonly selector?: SupportSelectorArgs | undefined;
}
export interface SafeSupportAnalyzeArgs {
  readonly file: string;
  readonly correlationId: string | undefined;
  readonly json: boolean;
  readonly clusters: boolean;
  readonly seed: boolean;
  readonly emitFixture: string | undefined;
}

// ─── Incident selection ────────────────────────────────────────────────────────────────────────

function matchesIncident(candidate: SupportIncidentRecord, selector: SupportSelectorArgs): boolean {
  return (
    (selector.correlationId !== undefined &&
      candidate.correlation.rootCorrelationId === selector.correlationId) ||
    (selector.defectFingerprint !== undefined &&
      candidate.fingerprint.defectFingerprint === selector.defectFingerprint)
  );
}

function existingIncident(
  stateDir: string,
  selector: SupportSelectorArgs | undefined,
): SupportIncidentRecord | undefined {
  if (selector === undefined) return undefined;
  if (selector.incidentId !== undefined) {
    const record = readSupportIncident(stateDir, selector.incidentId);
    if (record === undefined) throw new SupportReportError("selection-unavailable");
    return record;
  }
  return listSupportIncidents(stateDir).find((candidate) => matchesIncident(candidate, selector));
}

// Only an explicit "Report a problem" (no selector) or a correlation that still has evidence
// records a new user-reported incident; a named incident or fingerprint must already exist.
function createdIncident(
  stateDir: string,
  selector: SupportSelectorArgs | undefined,
  correlationId: string,
  io: CliIo,
): SupportIncidentDescriptorRecord {
  if (selector?.defectFingerprint !== undefined)
    throw new SupportReportError("selection-unavailable");
  try {
    return prepareManualSupportReportIncident(stateDir, selector?.correlationId ?? correlationId);
  } catch (error) {
    if (!(error instanceof DesktopSupportReportPreparationError)) throw error;
    io.err(`keiko support export: the incident was not recorded (${error.reason})\n`);
    throw new SupportReportError("selection-unavailable");
  }
}

async function selectionQuery(
  selector: SupportSelectorArgs,
  stateDir: string,
  io: CliIo,
  correlationId: string,
): Promise<SupportQueryRun> {
  const run = await collectSupportReportQuery(
    selector,
    stateDir,
    MAX_SUPPORT_REPORT_EVENT_BYTES,
    io,
    await loadActivityLog(),
    correlationId,
  );
  if (typeof run === "number") throw new SupportReportError("selection-unavailable");
  return run;
}

async function reportQuery(
  record: SupportIncidentDescriptorRecord,
  selected: SupportQueryRun | undefined,
  stateDir: string,
  io: CliIo,
  correlationId: string,
): Promise<SupportQueryRun> {
  if (selected !== undefined) return selected;
  if (!("slotIndex" in record)) return readManualSupportReportEvidence(stateDir, record);
  return selectionQuery(
    {
      incidentId: record.incidentId,
      correlationId: undefined,
      defectFingerprint: undefined,
      filter: {},
    },
    stateDir,
    io,
    correlationId,
  );
}

async function makeReport(
  stateDir: string,
  args: SafeSupportExportArgs,
  correlationId: string,
  io: CliIo,
): Promise<SupportReport> {
  const existing = existingIncident(stateDir, args.selector);
  const selected =
    args.selector === undefined
      ? undefined
      : await selectionQuery(args.selector, stateDir, io, correlationId);
  // An explicit causal selection is evaluated before any creation: a correlation without retained
  // evidence never records an incident, so a mistyped id leaves no pinned window behind.
  if (existing === undefined && selected?.result.events.length === 0)
    throw new SupportReportError("selection-unavailable");
  const record = existing ?? createdIncident(stateDir, args.selector, correlationId, io);
  const query = await reportQuery(record, selected, stateDir, io, correlationId);
  return buildSupportReport(
    supportIncidentPrivateProjection(resolveSelectedSupportIncident(record, query.result)),
    query.result,
    args.maxBytes ?? MAX_SUPPORT_REPORT_BYTES,
  );
}

// ─── Destination ───────────────────────────────────────────────────────────────────────────────

function reportDirectory(cwd: string, out: string | undefined, stateDir: string): string {
  return out === undefined ? join(stateDir, SUPPORT_REPORT_DIRECTORY_NAME) : resolve(cwd, out);
}

function reportFileName(report: SupportReport): string {
  return supportReportFileName(
    report.schemaVersion,
    report.incident.incidentId,
    report.incident.createdAtMs,
  );
}

// A report never lands in an Activity Log directory, whether named directly, through a path
// alias, or through a filesystem alias only device and inode reveal (a firmlink, a bind mount).
function assertReportDestination(directory: string, logDirectories: readonly string[]): void {
  for (const logs of logDirectories) {
    if (cliTargetIsAtOrBelow(directory, logs) || cliDirectoryIsWithin(directory, logs))
      throw new SafeArtifactFileError("support-report", "unsafe-target");
  }
}

function unsafeReportDirectory(): SafeArtifactFileError {
  return new SafeArtifactFileError("support-report", "unsafe-target");
}

// Holds the default directory owner-only through a descriptor that refuses a final symlink, so a
// redirected `support-reports` can never have its target's permissions changed.
function hardenOwnedReportDirectory(directory: string): void {
  if (process.platform === "win32") return;
  let descriptor: number;
  try {
    descriptor = openSync(
      directory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
  } catch (error) {
    // A final symlink (ELOOP) or a non-directory is a redirected destination; anything else is the
    // filesystem failure itself.
    const code: unknown = error instanceof Error ? Reflect.get(error, "code") : undefined;
    if (code === "ELOOP" || code === "ENOTDIR") throw unsafeReportDirectory();
    throw error;
  }
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isDirectory() || stat.uid !== process.getuid?.()) throw unsafeReportDirectory();
    fchmodSync(descriptor, 0o700);
  } finally {
    closeSync(descriptor);
  }
}

// The default directory is Keiko's own: created owner-only, or an existing real directory of this
// user. A symlink or any other redirect is refused before anything is changed.
function prepareDefaultReportDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!lstatSync(directory).isDirectory()) throw unsafeReportDirectory();
  hardenOwnedReportDirectory(directory);
}

// Validated before and after creation. The default directory is Keiko's own and is held
// owner-only; an explicit one is created owner-only and must not be writable by others.
function prepareReportDirectory(
  directory: string,
  logDirectories: readonly string[],
  keikoOwned: boolean,
): void {
  assertReportDestination(directory, logDirectories);
  if (keikoOwned) prepareDefaultReportDirectory(directory);
  else mkdirSync(directory, { recursive: true, mode: 0o700 });
  assertReportDestination(directory, logDirectories);
}

// An interrupted earlier publication can leave a private `.keiko-publish-*.stage` copy beside
// the reports. It is never a report, but it would travel with a shared directory.
function staleStageCount(directory: string): number {
  return readdirSync(directory).filter(isSafeArtifactStageFileName).length;
}

function analysisControlState(deps: SupportCliDeps): string {
  return (
    deps.controlActivityStateDir ??
    resolveCliControlStateDir(deps.platform ?? process.platform, (deps.homedir ?? homedir)())
  );
}

// ─── Failure reporting ─────────────────────────────────────────────────────────────────────────

const LEGACY_HINT =
  "Only canonical keiko-support-v1 reports are accepted. Regenerate the report on its " +
  "originating installation with keiko support export.\n";

const PRIVATE_COPY_HINT =
  "Analyze a copy owned by your account in a private directory. On macOS/Linux, " +
  "use chmod 700 on that directory and chmod 600 on the copied report, then retry.\n";

function reportFailure(error: unknown, io: CliIo, surface: SupportReportSurface): number {
  io.err(`keiko support: ${supportReportFailureReason(error)}\n`);
  if (error instanceof SupportReportError && error.minimumAnalyzerVersion !== undefined)
    io.err(`Minimum analyzer version: ${error.minimumAnalyzerVersion}\n`);
  if (error instanceof SupportReportError && error.reason === "legacy-input") io.err(LEGACY_HINT);
  if (
    surface === "analyze" &&
    error instanceof SafeArtifactFileError &&
    error.kind === "permission-unsafe"
  )
    io.err(PRIVATE_COPY_HINT);
  return 1;
}

interface ReportRunContext {
  readonly io: CliIo;
  readonly surface: SupportReportSurface;
  readonly sink: ServerLogSink;
  readonly correlationId: string;
}

function reportSupportReportFailure(context: ReportRunContext, error: unknown): number {
  try {
    emitSupportReportFailed(context.sink, context.correlationId, context.surface, error);
  } catch (sinkError) {
    reportServerLogFailure(sinkError, {
      op: "support.report.failed",
      correlationId: context.correlationId,
      loss: "event-dropped",
    });
  }
  return reportFailure(error, context.io, context.surface);
}

// The Activity Log is the command's own evidence: without it the command fails closed, naming the
// unavailable log instead of a report failure.
function reportActivityLogUnavailable(
  error: unknown,
  io: CliIo,
  correlationId: string,
  surface: SupportReportSurface,
): number {
  reportServerLogFailure(error, {
    op: "support.report.started",
    correlationId,
    loss: "event-dropped",
  });
  io.err(`keiko support ${surface}: Activity Log unavailable (${describeErrorKind(error)})\n`);
  return 1;
}

// A refused destination is evidenced in the operator's independent control-state log, never in the
// refused target, as one complete started/failed lifecycle.
function reportRejectedDestination(
  error: unknown,
  io: CliIo,
  env: EnvSource,
  deps: SupportCliDeps,
  maxBytes: number,
  stateDir: string,
): number {
  const correlationId = randomUUID();
  try {
    const controlStateDir = analysisControlState(deps);
    if (cliControlStateConflictsWithTarget(controlStateDir, stateDir))
      return reportFailure(error, io, "export");
    const sink = createFileServerLogSink(controlStateDir, { env });
    try {
      emitSupportReportStarted(sink, correlationId, "export", maxBytes);
      return reportSupportReportFailure({ io, sink, correlationId, surface: "export" }, error);
    } finally {
      sink.close?.();
    }
  } catch (sinkError) {
    reportServerLogFailure(sinkError, {
      op: "support.report.failed",
      correlationId,
      loss: "event-dropped",
    });
    return reportFailure(error, io, "export");
  }
}

// ─── Export ────────────────────────────────────────────────────────────────────────────────────

function selectionReasonDetail(reasons: readonly string[], suffix = ""): string {
  return reasons.length === 0 ? "" : ` (${reasons.join(", ")}${suffix})`;
}

function announceReportExport(
  io: CliIo,
  publication: SupportReportPublication,
  report: SupportReport,
  staleStages: number,
): void {
  const { status, reasons, requiredBytes } = report.selection;
  const required = requiredBytes > 0 ? `; ${String(requiredBytes)} bytes required` : "";
  const detail = selectionReasonDetail(reasons, required);
  io.out(
    `Saved support report: ${publication.path}\nDiagnostic sufficiency: ${status}${detail}\nNothing has been sent.\n`,
  );
  if (staleStages > 0)
    io.err(
      `keiko support export: ${String(staleStages)} private .keiko-publish-*.stage file(s) from an ` +
        "interrupted earlier export remain in this directory. They are not reports; delete them " +
        "before sharing the directory.\n",
    );
}

interface ExportPlan {
  readonly stateDir: string;
  readonly directory: string;
  readonly logDirectories: readonly string[];
  readonly keikoOwned: boolean;
  readonly maxBytes: number;
}

function exportPlan(args: SafeSupportExportArgs, env: EnvSource, deps: SupportCliDeps): ExportPlan {
  const cwd = deps.cwd ?? process.cwd();
  const stateDir = resolveStateDir(cwd, env, args.stateDir);
  return {
    stateDir,
    directory: reportDirectory(cwd, args.out, stateDir),
    logDirectories: [
      join(stateDir, ACTIVITY_LOG_DIRECTORY_NAME),
      join(analysisControlState(deps), ACTIVITY_LOG_DIRECTORY_NAME),
    ],
    keikoOwned: args.out === undefined,
    maxBytes: args.maxBytes ?? MAX_SUPPORT_REPORT_BYTES,
  };
}

async function publishExport(
  plan: ExportPlan,
  args: SafeSupportExportArgs,
  context: ReportRunContext,
): Promise<number> {
  emitSupportReportStarted(context.sink, context.correlationId, "export", plan.maxBytes);
  // The destination exists and is verified before any incident is recorded or any byte read.
  prepareReportDirectory(plan.directory, plan.logDirectories, plan.keikoOwned);
  const report = await makeReport(plan.stateDir, args, context.correlationId, context.io);
  const text = serializeSupportReport(report);
  const publication = publishSupportReportFile(join(plan.directory, reportFileName(report)), text);
  emitSupportReportCompleted(context.sink, context.correlationId, "export", {
    reportBytes: publication.reportBytes,
    recordCount: report.evidence.recordCount,
    sufficiency: report.selection.status,
    sufficiencyReasons: report.selection.reasons,
    reportDigest: report.integrity.reportDigest,
    publication,
  });
  announceReportExport(context.io, publication, report, staleStageCount(plan.directory));
  return 0;
}

export async function runSafeSupportExport(
  args: SafeSupportExportArgs,
  io: CliIo,
  env: EnvSource,
  deps: SupportCliDeps,
): Promise<number> {
  const plan = exportPlan(args, env, deps);
  try {
    assertReportDestination(plan.directory, plan.logDirectories);
  } catch (error) {
    return reportRejectedDestination(error, io, env, deps, plan.maxBytes, plan.stateDir);
  }
  const correlationId = randomUUID();
  let sink: ServerLogSink;
  try {
    sink = createFileServerLogSink(plan.stateDir, { env });
  } catch (error) {
    return reportActivityLogUnavailable(error, io, correlationId, "export");
  }
  const context = { io, surface: "export" as const, sink, correlationId };
  let code: number;
  try {
    code = await publishExport(plan, args, context);
  } catch (error) {
    code = reportSupportReportFailure(context, error);
  } finally {
    sink.close?.();
  }
  if (code === 0) await reportSupportReadiness(plan.stateDir, env, io);
  return code;
}

// Export also states the exported directory's diagnostic readiness (#3532). The self-check
// persists its own `activity-log.readiness` line after publication, so the report stays exactly
// the evidence that existed when it was taken.
async function reportSupportReadiness(stateDir: string, env: EnvSource, io: CliIo): Promise<void> {
  const snapshot = (await loadActivityLog()).checkActivityLogReadiness({
    stateDir,
    env,
    scope: "directory",
  });
  const reasons = snapshot.reasons.length === 0 ? "" : ` (${snapshot.reasons.join(", ")})`;
  io.out(`Diagnostic evidence: ${snapshot.readiness}${reasons}.\n`);
}

// ─── Analyze ───────────────────────────────────────────────────────────────────────────────────

// Emit one JSON value after complete validation, without allocating its whole rendered string.
function* machineJsonTokens(value: unknown): Generator<string> {
  if (Array.isArray(value)) {
    yield "[";
    for (const [index, entry] of value.entries()) {
      if (index > 0) yield ",";
      yield* machineJsonTokens(entry ?? null);
    }
    yield "]";
  } else if (typeof value === "object" && value !== null) {
    yield "{";
    const entries = Object.entries(value).filter(([, entry]) => entry !== undefined);
    for (const [index, [key, entry]] of entries.entries()) {
      if (index > 0) yield ",";
      yield JSON.stringify(key) + ":";
      yield* machineJsonTokens(entry);
    }
    yield "}";
  } else {
    const text = JSON.stringify(value);
    yield text;
  }
}

function emitMachineProjection(value: unknown, io: CliIo): void {
  let pending = "";
  for (const token of machineJsonTokens(value)) {
    pending += token;
    while (pending.length >= 32 * 1024) {
      io.out(pending.slice(0, 32 * 1024));
      pending = pending.slice(32 * 1024);
    }
  }
  io.out(pending + "\n");
}

function humanHeader(artifact: AnalyzedSupportReport): string {
  const { status, reasons } = artifact.selection;
  return (
    `Support incident ${artifact.incident.incidentId}\n` +
    `Diagnostic sufficiency: ${status}${selectionReasonDetail(reasons)}\n` +
    `Authenticity: unknown\n`
  );
}

function emitMachineOrHuman(
  artifact: AnalyzedSupportReport,
  args: SafeSupportAnalyzeArgs,
  io: CliIo,
): SupportReportAnalysisOutcome {
  const timeline =
    args.correlationId === undefined
      ? undefined
      : findTimeline(artifact.analysis, args.correlationId);
  if (args.correlationId !== undefined && timeline === undefined)
    throw new SupportReportError("selection-unavailable");
  if (args.json) {
    // --correlation-id narrows the machine view to that validated timeline, the LogTimeline shape
    // `keiko investigate --from-timeline` reads; without it the complete envelope is emitted.
    emitMachineProjection(
      args.correlationId === undefined
        ? artifact
        : supportReportTimeline(artifact, args.correlationId),
      io,
    );
    return { analysisView: args.correlationId === undefined ? "analysis" : "timeline" };
  }
  io.out(humanHeader(artifact));
  if (args.clusters) io.out(renderHumanClusters(artifact.analysis.clusters));
  else
    io.out(
      timeline === undefined
        ? renderHumanAllTimelines(artifact.analysis)
        : renderHumanTimeline(timeline),
    );
  return { analysisView: humanView(args) };
}

function humanView(args: SafeSupportAnalyzeArgs): SupportReportAnalysisOutcome["analysisView"] {
  if (args.clusters) return "clusters";
  return args.correlationId === undefined ? "analysis" : "timeline";
}

function needsToolLifecycle(artifact: AnalyzedSupportReport): boolean {
  return (
    hasIssueToPrJourneyOps(artifact.analysis) ||
    artifact.analysis.timelines.some((timeline) =>
      timeline.lines.some(
        (line) =>
          line.toolCatalog?.kind === "unavailable" ||
          (line.toolCatalog?.kind === "sink-failure" &&
            line.toolCatalog.diagnostics === "unavailable"),
      ),
    )
  );
}

// The lifecycle validators load lazily. When they cannot load, the analysis proceeds without them
// and says so, on stderr and as a degraded analysis in the Activity Log: the evidence then reads
// lifecycle-validator-unavailable instead of failing.
async function reportAnalysisOptions(context: ReportRunContext): Promise<SupportAnalyzeOptions> {
  try {
    const { validateToolLifecycleEvent, redactLogFields } = await loadToolLifecycle();
    return {
      toolLifecycleValidator: validateToolLifecycleEvent,
      toolDiagnosticRedactor: redactLogFields,
    };
  } catch (error) {
    emitSupportReportDegraded(context.sink, context.correlationId, "analyze", error);
    context.io.err(
      `keiko support analyze: tool lifecycle validator unavailable — ${describeErrorKind(error)}\n`,
    );
    return {};
  }
}

/** Writes the selected fixture exclusively; throws the closed publication failure otherwise. */
export type FixtureWriter = (path: string, text: string, io: CliIo) => void;

// The correlation a seed is prepared for: an explicit one must name a validated timeline.
function seedCorrelation(artifact: AnalyzedSupportReport, args: SafeSupportAnalyzeArgs): string {
  const correlation = args.correlationId ?? artifact.incident.correlation.rootCorrelationId;
  if (correlation === undefined) throw new SupportReportError("seed-unavailable");
  if (
    args.correlationId !== undefined &&
    findTimeline(artifact.analysis, correlation) === undefined
  )
    throw new SupportReportError("selection-unavailable");
  return correlation;
}

// Writes the explicitly selected replay fixture; undefined when none was requested.
function writeSelectedFixture(
  seed: ReproductionSeed,
  args: SafeSupportAnalyzeArgs,
  io: CliIo,
  writeFixture: FixtureWriter,
  cwd: string,
): string | undefined {
  if (args.emitFixture === undefined) return undefined;
  const fixture =
    seed.gatewayScript === undefined
      ? undefined
      : renderGatewayReplayScriptFixture(seed.gatewayScript);
  if (fixture === undefined) throw new SupportReportError("seed-unavailable");
  const fixturePath = resolve(cwd, args.emitFixture);
  writeFixture(fixturePath, fixture, io);
  return fixturePath;
}

function emitSafeSeed(
  artifact: AnalyzedSupportReport,
  args: SafeSupportAnalyzeArgs,
  io: CliIo,
  writeFixture: FixtureWriter,
  cwd: string,
  options: SupportAnalyzeOptions,
): SupportReportAnalysisOutcome {
  const seed = prepareSupportReportSeed(artifact, seedCorrelation(artifact, args), options);
  if (seed === undefined) throw new SupportReportError("seed-unavailable");
  const fixturePath = writeSelectedFixture(seed, args, io, writeFixture, cwd);
  if (args.json)
    emitMachineProjection({ ...artifact, seed, fixtureWritten: fixturePath !== undefined }, io);
  else {
    io.out(renderHumanReproductionSeed(seed));
    if (fixturePath !== undefined) io.out(`Wrote replay fixture: ${fixturePath}\n`);
  }
  return {
    analysisView: "seed",
    seedCorrelation: args.correlationId === undefined ? "incident" : "selected",
    seedCorrelationDigest: createHash("sha256").update(seed.correlationId, "utf8").digest("hex"),
    ...(fixturePath === undefined ? {} : { fixture: "published" }),
  };
}

async function analyzeReceivedReport(
  args: SafeSupportAnalyzeArgs,
  context: ReportRunContext,
  writeFixture: FixtureWriter,
  cwd: string,
): Promise<number> {
  emitSupportReportStarted(
    context.sink,
    context.correlationId,
    "analyze",
    MAX_SUPPORT_REPORT_BYTES,
  );
  const text = readSupportReportFile(resolve(cwd, args.file));
  const basic = analyzeSupportReport(text);
  const options = needsToolLifecycle(basic) ? await reportAnalysisOptions(context) : {};
  const artifact = Object.keys(options).length === 0 ? basic : analyzeSupportReport(text, options);
  const analysis =
    args.seed || args.emitFixture !== undefined
      ? emitSafeSeed(artifact, args, context.io, writeFixture, cwd, options)
      : emitMachineOrHuman(artifact, args, context.io);
  emitSupportReportCompleted(context.sink, context.correlationId, "analyze", {
    reportBytes: Buffer.byteLength(text),
    recordCount: artifact.analysis.evidence.supportedLineCount,
    sufficiency: artifact.selection.status,
    sufficiencyReasons: artifact.selection.reasons,
    reportDigest: artifact.reportDigest,
    analysis,
  });
  return 0;
}

export async function runSafeSupportAnalyze(
  args: SafeSupportAnalyzeArgs,
  io: CliIo,
  env: EnvSource,
  deps: SupportCliDeps,
  writeFixture: FixtureWriter,
): Promise<number> {
  const cwd = deps.cwd ?? process.cwd();
  const correlationId = randomUUID();
  let sink: ServerLogSink;
  try {
    sink = createFileServerLogSink(analysisControlState(deps), { env });
  } catch (error) {
    return reportActivityLogUnavailable(error, io, correlationId, "analyze");
  }
  const context = { io, surface: "analyze" as const, sink, correlationId };
  try {
    return await analyzeReceivedReport(args, context, writeFixture, cwd);
  } catch (error) {
    return reportSupportReportFailure(context, error);
  } finally {
    sink.close?.();
  }
}
