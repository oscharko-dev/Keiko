import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  ACTIVITY_LOG_DIRECTORY_NAME,
  MAX_SUPPORT_REPORT_BYTES,
  MAX_SUPPORT_REPORT_EVENT_BYTES,
  supportIncidentPrivateProjection,
  type SupportIncidentRecord,
  type SupportReport,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import type { EnvSource } from "@oscharko-dev/keiko-model-gateway";
import { SafeArtifactFileError } from "@oscharko-dev/keiko-security/fs-hardening";
import {
  createFileServerLogSink,
  reportServerLogFailure,
  recordUserReportedIncident,
  listSupportIncidents,
  readSupportIncident,
  supportIncidentSegmentFiles,
  type ServerLogSink,
} from "@oscharko-dev/keiko-activity-log";
import {
  analyzeSupportReport,
  buildSupportReport,
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
  type AnalyzedSupportReport,
  type SupportAnalyzeOptions,
} from "@oscharko-dev/keiko-activity-log/reader";
import { cliTargetIsAtOrBelow, resolveCliControlStateDir } from "./cli-control-state.js";
import { resolveStateDir } from "./state-paths.js";
import { loadActivityLog, loadToolLifecycle } from "./lazy-modules.js";
import { collectSupportReportQuery } from "./support-selective-export.js";
import { resolveSupportIncident } from "./support-incident.js";
import { type SupportSelectorArgs } from "./support-query-cli.js";
import {
  emitSupportReportStarted,
  emitSupportReportCompleted,
  emitSupportReportFailed,
  type SupportReportSurface,
} from "./support-report-evidence.js";
import { publishSupportReportFile, readSupportReportFile } from "./support-export.js";
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

function existingIncident(
  stateDir: string,
  selector: SupportSelectorArgs | undefined,
): SupportIncidentRecord | undefined {
  if (selector === undefined) return undefined;
  if (selector.incidentId !== undefined) {
    const record = readSupportIncident(stateDir, selector.incidentId);
    if (record === undefined) throw new SupportReportError("unsafe-report");
    return record;
  }
  return listSupportIncidents(stateDir).find((candidate) => matchesIncident(candidate, selector));
}

function matchesIncident(candidate: SupportIncidentRecord, selector: SupportSelectorArgs): boolean {
  return (
    (selector.correlationId !== undefined &&
      candidate.correlation.rootCorrelationId === selector.correlationId) ||
    (selector.defectFingerprint !== undefined &&
      candidate.fingerprint.defectFingerprint === selector.defectFingerprint)
  );
}

function selectedIncident(
  stateDir: string,
  args: SafeSupportExportArgs,
  correlationId: string,
): SupportIncidentRecord {
  const selector = args.selector;
  const record = existingIncident(stateDir, selector);
  if (record !== undefined) return record;
  if (selector?.defectFingerprint !== undefined) throw new SupportReportError("unsafe-report");
  const creation = recordUserReportedIncident(stateDir, {
    correlationId: selector?.correlationId ?? correlationId,
  });
  if (creation.status === "rejected" || creation.record === undefined)
    throw new SupportReportError("unsafe-report");
  return creation.record;
}

function reportOutputPath(
  cwd: string,
  out: string | undefined,
  stateDir: string,
  report: SupportReport,
): string {
  const date = new Date(report.incident.createdAtMs).toISOString().slice(0, 10);
  const filename = `keiko-support-v${String(report.schemaVersion)}-${report.incident.incidentId.slice(0, 12)}-${date}.json`;
  const directory = reportOutputDirectory(cwd, out, stateDir);
  assertReportDestination(directory, stateDir);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  assertReportDestination(directory, stateDir);
  return join(directory, filename);
}

function reportOutputDirectory(cwd: string, out: string | undefined, stateDir: string): string {
  return out === undefined ? join(stateDir, "support-reports") : resolve(cwd, out);
}

function assertReportDestination(directory: string, stateDir: string): void {
  if (cliTargetIsAtOrBelow(directory, join(stateDir, ACTIVITY_LOG_DIRECTORY_NAME)))
    throw new SafeArtifactFileError("support-report", "unsafe-target");
}

function reportFailureReason(error: unknown): string {
  if (error instanceof SupportReportError) return error.reason;
  if (error instanceof SafeArtifactFileError) return error.kind;
  return "internal";
}

function reportFailure(error: unknown, io: CliIo): number {
  const reason = reportFailureReason(error);
  io.err(`keiko support: ${reason}\n`);
  if (error instanceof SupportReportError && error.reason === "unsupported-report")
    io.err(`Minimum analyzer version: ${error.minimumAnalyzerVersion}\n`);
  return 1;
}

interface ReportRunContext {
  readonly io: CliIo;
  readonly surface: SupportReportSurface;
  readonly maxBytes: number;
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
  return reportFailure(error, context.io);
}

async function makeReport(
  stateDir: string,
  args: SafeSupportExportArgs,
  correlationId: string,
  io: CliIo,
): Promise<SupportReport> {
  const activityLog = await loadActivityLog();
  const selectedQuery =
    args.selector === undefined
      ? undefined
      : await collectSupportReportQuery(
          args.selector,
          stateDir,
          MAX_SUPPORT_REPORT_EVENT_BYTES,
          io,
          activityLog,
          correlationId,
        );
  if (typeof selectedQuery === "number") throw new SupportReportError("unsafe-report");
  const record = selectedIncident(stateDir, args, correlationId);
  const incident = resolveSupportIncident(
    record,
    supportIncidentSegmentFiles(stateDir, record),
    stateDir,
  );
  const query =
    selectedQuery ??
    (await collectSupportReportQuery(
      {
        incidentId: record.incidentId,
        correlationId: undefined,
        defectFingerprint: undefined,
        filter: {},
      },
      stateDir,
      MAX_SUPPORT_REPORT_EVENT_BYTES,
      io,
      activityLog,
      correlationId,
    ));
  if (typeof query === "number") throw new SupportReportError("unsafe-report");
  return buildSupportReport(
    supportIncidentPrivateProjection(incident),
    query.result,
    args.maxBytes ?? MAX_SUPPORT_REPORT_BYTES,
  );
}

function reportRejectedDestination(
  error: unknown,
  io: CliIo,
  env: EnvSource,
  deps: SupportCliDeps,
  correlationId: string,
  maxBytes: number | undefined,
): number {
  try {
    const sink = createFileServerLogSink(analysisControlState(deps), { env });
    return reportSupportReportFailure(
      {
        io,
        sink,
        correlationId,
        surface: "export",
        maxBytes: maxBytes ?? MAX_SUPPORT_REPORT_BYTES,
      },
      error,
    );
  } catch (sinkError) {
    reportServerLogFailure(sinkError, {
      op: "support.report.failed",
      correlationId,
      loss: "event-dropped",
    });
    return reportFailure(error, io);
  }
}

function reportExportDestinationFailure(
  args: SafeSupportExportArgs,
  io: CliIo,
  env: EnvSource,
  deps: SupportCliDeps,
): number | undefined {
  const cwd = deps.cwd ?? process.cwd();
  const stateDir = resolveStateDir(cwd, env, args.stateDir);
  try {
    assertReportDestination(reportOutputDirectory(cwd, args.out, stateDir), stateDir);
    return undefined;
  } catch (error) {
    return reportRejectedDestination(error, io, env, deps, randomUUID(), args.maxBytes);
  }
}

export async function runSafeSupportExport(
  args: SafeSupportExportArgs,
  io: CliIo,
  env: EnvSource,
  deps: SupportCliDeps,
): Promise<number> {
  const cwd = deps.cwd ?? process.cwd();
  const stateDir = resolveStateDir(cwd, env, args.stateDir);
  const correlationId = randomUUID();
  const refused = reportExportDestinationFailure(args, io, env, deps);
  if (refused !== undefined) return refused;
  let sink: ServerLogSink;
  try {
    sink = createFileServerLogSink(stateDir, { env });
  } catch (error) {
    reportServerLogFailure(error, {
      op: "support.report.started",
      correlationId,
      loss: "event-dropped",
    });
    return reportFailure(error, io);
  }
  const context = {
    io,
    surface: "export" as const,
    maxBytes: args.maxBytes ?? MAX_SUPPORT_REPORT_BYTES,
    sink,
    correlationId,
  };
  try {
    emitSupportReportStarted(sink, correlationId, context.surface, context.maxBytes);
    const report = await makeReport(stateDir, args, correlationId, io);
    const text = serializeSupportReport(report);
    const path = reportOutputPath(cwd, args.out, stateDir, report);
    publishSupportReportFile(path, text);
    emitSupportReportCompleted(sink, correlationId, "export", {
      reportBytes: Buffer.byteLength(text),
      recordCount: report.evidence.recordCount,
      sufficiency: report.selection.status,
      reportDigest: report.integrity.reportDigest,
    });
    announceReportExport(io, path, report);
    return 0;
  } catch (error) {
    return reportSupportReportFailure(context, error);
  } finally {
    sink.close?.();
  }
}

function announceReportExport(io: CliIo, path: string, report: SupportReport): void {
  io.out(
    `Saved support report: ${path}\nDiagnostic sufficiency: ${report.selection.status}\nNothing has been sent.\n`,
  );
}

function analysisControlState(deps: SupportCliDeps): string {
  return (
    deps.controlActivityStateDir ??
    resolveCliControlStateDir(deps.platform ?? process.platform, (deps.homedir ?? homedir)())
  );
}

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

function emitMachineOrHuman(
  artifact: AnalyzedSupportReport,
  args: SafeSupportAnalyzeArgs,
  io: CliIo,
): number {
  const timeline =
    args.correlationId === undefined
      ? undefined
      : findTimeline(artifact.analysis, args.correlationId);
  if (args.correlationId !== undefined && timeline === undefined)
    throw new SupportReportError("unsafe-report");
  if (args.json) {
    emitMachineProjection(artifact, io);
    return 0;
  }
  io.out(
    `Support incident ${artifact.incident.incidentId}\nDiagnostic sufficiency: ${artifact.selection.status}\nAuthenticity: unknown\n`,
  );
  if (args.clusters) io.out(renderHumanClusters(artifact.analysis.clusters));
  else
    io.out(
      timeline === undefined
        ? renderHumanAllTimelines(artifact.analysis)
        : renderHumanTimeline(timeline),
    );
  return 0;
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

async function reportAnalysisOptions(
  artifact: AnalyzedSupportReport,
): Promise<SupportAnalyzeOptions> {
  if (!needsToolLifecycle(artifact)) return {};
  const { validateToolLifecycleEvent, redactLogFields } = await loadToolLifecycle();
  return {
    toolLifecycleValidator: validateToolLifecycleEvent,
    toolDiagnosticRedactor: redactLogFields,
  };
}

export type FixtureWriter = (path: string, text: string, io: CliIo) => number | undefined;

function emitSafeSeed(
  artifact: AnalyzedSupportReport,
  args: SafeSupportAnalyzeArgs,
  io: CliIo,
  writeFixture: FixtureWriter,
  cwd: string,
  options: SupportAnalyzeOptions,
): number {
  const correlation = args.correlationId ?? artifact.incident.correlation.rootCorrelationId;
  if (correlation === undefined) throw new SupportReportError("unsafe-report");
  const seed = prepareSupportReportSeed(artifact, correlation, options);
  if (seed === undefined) throw new SupportReportError("unsafe-report");
  if (args.emitFixture !== undefined) {
    if (seed.gatewayScript === undefined) throw new SupportReportError("unsafe-report");
    const path = resolve(cwd, args.emitFixture);
    const fixture = renderGatewayReplayScriptFixture(seed.gatewayScript);
    if (fixture === undefined) throw new SupportReportError("unsafe-report");
    const failed = writeFixture(path, fixture, io);
    if (failed !== undefined) throw new SupportReportError("unsafe-report");
  }
  if (args.json)
    emitMachineProjection(
      { ...artifact, seed, fixtureWritten: args.emitFixture !== undefined },
      io,
    );
  else io.out(renderHumanReproductionSeed(seed));
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
    reportServerLogFailure(error, {
      op: "support.report.started",
      correlationId,
      loss: "event-dropped",
    });
    return reportFailure(error, io);
  }
  const context = {
    io,
    surface: "analyze" as const,
    maxBytes: MAX_SUPPORT_REPORT_BYTES,
    sink,
    correlationId,
  };
  try {
    emitSupportReportStarted(sink, correlationId, "analyze", MAX_SUPPORT_REPORT_BYTES);
    const text = readSupportReportFile(resolve(cwd, args.file));
    const basic = analyzeSupportReport(text);
    const options = await reportAnalysisOptions(basic);
    const artifact = needsToolLifecycle(basic) ? analyzeSupportReport(text, options) : basic;
    const exitCode =
      args.seed || args.emitFixture !== undefined
        ? emitSafeSeed(artifact, args, io, writeFixture, cwd, options)
        : emitMachineOrHuman(artifact, args, io);
    emitSupportReportCompleted(sink, correlationId, "analyze", {
      reportBytes: Buffer.byteLength(text),
      recordCount: artifact.analysis.evidence.supportedLineCount,
      sufficiency: artifact.selection.status,
      reportDigest: artifact.reportDigest,
    });
    return exitCode;
  } catch (error) {
    return reportSupportReportFailure(context, error);
  } finally {
    sink.close?.();
  }
}
