// `keiko support query` and `keiko support manifest` (#3531), plus the selection step selective
// `keiko support export` shares with them.
//
// This file owns argv parsing, state-dir resolution, incident lookup through the lazily loaded
// server module, and Activity Log evidence; the engine itself (`support-query.ts`) and the manifest
// store (`support-segment-manifest.ts`, `support-segment-scan.ts`) stay argv-free and are tested on
// data. Human output is always derived from the versioned machine result.

import { randomUUID } from "node:crypto";
import {
  ACTIVITY_LOG_FAILURE_CLASS_COVERAGE,
  DEFECT_FINGERPRINT_ALGORITHM_VERSION,
  activityLogOperationSchema,
  isActivityLogCorrelationId,
  isActivityLogErrorKind,
  isDefectFingerprint,
  isSupportIncidentId,
  type ActivityLogErrorKind,
  type SupportIncidentRecord,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import type { EnvSource } from "@oscharko-dev/keiko-model-gateway";
import { flagValue } from "./cli-arg-parsing.js";
import { loadServer } from "./lazy-modules.js";
import type { CliIo } from "./runner.js";
import { resolveStateDir } from "./state-paths.js";
import { activityLogFailureClassesOf } from "./support-analyze-sufficiency.js";
import { describeErrorKind } from "./support-export.js";
import {
  DEFAULT_SUPPORT_QUERY_LIMITS,
  renderSupportQuery,
  runSupportQuery,
  supportQueryJson,
  type SupportClosureSelection,
  type SupportEventFilter,
  type SupportEventSelection,
  type SupportQueryClass,
  type SupportQueryLimits,
  type SupportQueryResult,
  type SupportQuerySelection,
  type SupportQueryWindow,
} from "./support-query.js";
import {
  emitSupportManifestEvidence,
  emitSupportQueryEvidence,
  emitSupportQueryFailure,
  type SupportQueryEvidenceSink,
  type SupportQueryFailureStage,
  type SupportQuerySurface,
} from "./support-query-evidence.js";
import {
  ActivityLogScanner,
  ensureSegmentManifests,
  listActivityLogStoreFiles,
  verifySegmentManifests,
  type ActivityLogScannerDeps,
  type ActivityLogStoreFile,
  type SegmentManifestPassStats,
} from "./support-segment-scan.js";

export const SUPPORT_QUERY_USAGE = `Usage:
  keiko support query [--state-dir PATH] [--json]
        (--correlation-id ID | --incident ID | --defect-fingerprint SHA256)
        [--context-ms N] [--max-bytes N]
  keiko support query [--state-dir PATH] [--json]
        [--parent-correlation-id ID] [--op OP] [--error-kind KIND] [--failure-class CLASS]
        [--from ISO] [--to ISO] [--max-bytes N]
  keiko support manifest rebuild|verify [--state-dir PATH] [--json]

query streams the Activity Log of the state directory in bounded memory. Each sealed segment has a
rebuildable manifest (safe time, process and sequence ranges, registered operation/error/failure
counts, integrity and loss state, and a correlation filter), so a segment that cannot match is never
opened. --correlation-id, --incident and --defect-fingerprint select the full registered causal
closure: the correlation, every ancestor over parentCorrelationId, and every descendant, plus the
uncorrelated process signals of those processes within --context-ms (default 5000) of the closure.
An incident or fingerprint resolves through the local SupportIncident records. The other selectors
filter single events and combine with AND. --max-bytes (default 16777216) bounds the selection: a
closure that does not fit returns no events and is insufficient (report-budget-exceeded) instead of
being cut. Every result states exactly one diagnostic sufficiency (complete, degraded or
insufficient) with closed reasons; --json prints the versioned machine form (keiko.support.query v1).

manifest rebuild derives every sealed segment's manifest again and replaces the stored one;
manifest verify re-derives them without writing and reports stored manifests that are missing or
differ. Manifests live in <state-dir>/activity-log-manifests/ and can always be deleted.
`;

// ─── Argument parsing ──────────────────────────────────────────────────────────────────────────

export interface SupportSelectorArgs {
  readonly correlationId?: string | undefined;
  readonly incidentId?: string | undefined;
  readonly defectFingerprint?: string | undefined;
  readonly filter: SupportEventFilter;
}

export interface SupportQueryArgs {
  readonly stateDir: string | undefined;
  readonly json: boolean;
  readonly selector: SupportSelectorArgs;
  readonly limits: SupportQueryLimits;
}

export interface SupportManifestArgs {
  readonly action: "rebuild" | "verify";
  readonly stateDir: string | undefined;
  readonly json: boolean;
}

export type SupportParseResult<T> =
  | { readonly kind: "help" }
  | { readonly kind: "usage"; readonly message: string }
  | { readonly kind: "ok"; readonly value: T };

/** A malformed selector flag; its message names the flag, never the value. */
export class SupportUsageError extends Error {}

function usage<T>(message: string): SupportParseResult<T> {
  return { kind: "usage", message: `keiko support: ${message}\n${SUPPORT_QUERY_USAGE}` };
}

// A flag given without its value is a usage error, never silently ignored.
function flag(args: readonly string[], name: string): string | undefined {
  const value = flagValue(args, name);
  if (value === null) throw new SupportUsageError(`${name} is missing its value.`);
  return value;
}

function checked(
  args: readonly string[],
  name: string,
  valid: (value: string) => boolean,
): string | undefined {
  const value = flag(args, name);
  if (value !== undefined && !valid(value)) throw new SupportUsageError(`${name} is not valid.`);
  return value;
}

const FAILURE_CLASSES: ReadonlySet<string> = new Set(
  (ACTIVITY_LOG_FAILURE_CLASS_COVERAGE.classes as readonly { readonly failureClass: string }[]).map(
    (entry) => entry.failureClass,
  ),
);

function parseTimestamp(args: readonly string[], name: string): number | undefined {
  const value = flag(args, name);
  if (value === undefined) return undefined;
  const ms = Date.parse(value);
  if (!/^\d{4}-\d{2}-\d{2}T/u.test(value) || !Number.isFinite(ms)) {
    throw new SupportUsageError(`${name} must be an ISO 8601 timestamp.`);
  }
  return ms;
}

function parseBoundedInteger(
  args: readonly string[],
  name: string,
  bounds: { readonly min: number; readonly max: number; readonly fallback: number },
): number {
  const value = flag(args, name);
  if (value === undefined) return bounds.fallback;
  const parsed = /^\d{1,16}$/u.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < bounds.min || parsed > bounds.max) {
    throw new SupportUsageError(`${name} must be an integer from ${String(bounds.min)}.`);
  }
  return parsed;
}

function parseFilter(args: readonly string[]): SupportEventFilter {
  const filter: SupportEventFilter = {
    parentCorrelationId: checked(args, "--parent-correlation-id", isActivityLogCorrelationId),
    op: checked(args, "--op", (value) => activityLogOperationSchema(value) !== undefined),
    errorKind: checked(args, "--error-kind", isActivityLogErrorKind),
    failureClass: checked(args, "--failure-class", (value) => FAILURE_CLASSES.has(value)),
    fromMs: parseTimestamp(args, "--from"),
    toMs: parseTimestamp(args, "--to"),
  };
  if (filter.fromMs !== undefined && filter.toMs !== undefined && filter.fromMs > filter.toMs) {
    throw new SupportUsageError("--from must not be after --to.");
  }
  return filter;
}

function filterIsEmpty(filter: SupportEventFilter): boolean {
  return Object.values(filter).every((value) => value === undefined);
}

/** Parses the selector flags `query` and selective `export` share; `undefined` selects nothing. */
export function parseSupportSelector(args: readonly string[]): SupportSelectorArgs {
  const selector: SupportSelectorArgs = {
    correlationId: checked(args, "--correlation-id", isActivityLogCorrelationId),
    incidentId: checked(args, "--incident", isSupportIncidentId),
    defectFingerprint: checked(args, "--defect-fingerprint", isDefectFingerprint),
    filter: parseFilter(args),
  };
  const closureSelectors = [
    selector.correlationId,
    selector.incidentId,
    selector.defectFingerprint,
  ].filter((value) => value !== undefined).length;
  if (closureSelectors > 1) {
    throw new SupportUsageError(
      "--correlation-id, --incident and --defect-fingerprint are exclusive.",
    );
  }
  if (closureSelectors === 1 && !filterIsEmpty(selector.filter)) {
    throw new SupportUsageError("a closure selector cannot be combined with event filters.");
  }
  return selector;
}

export function supportSelectorIsEmpty(selector: SupportSelectorArgs): boolean {
  return (
    selector.correlationId === undefined &&
    selector.incidentId === undefined &&
    selector.defectFingerprint === undefined &&
    filterIsEmpty(selector.filter)
  );
}

function parseLimits(args: readonly string[]): SupportQueryLimits {
  return {
    ...DEFAULT_SUPPORT_QUERY_LIMITS,
    maxResultBytes: parseBoundedInteger(args, "--max-bytes", {
      min: 1,
      max: Number.MAX_SAFE_INTEGER,
      fallback: DEFAULT_SUPPORT_QUERY_LIMITS.maxResultBytes,
    }),
    contextMs: parseBoundedInteger(args, "--context-ms", {
      min: 0,
      max: 600_000,
      fallback: DEFAULT_SUPPORT_QUERY_LIMITS.contextMs,
    }),
  };
}

export function parseSupportQueryArgs(
  args: readonly string[],
): SupportParseResult<SupportQueryArgs> {
  if (args.includes("--help") || args.includes("-h")) return { kind: "help" };
  try {
    const selector = parseSupportSelector(args);
    if (supportSelectorIsEmpty(selector)) {
      return usage("query needs a selector (--correlation-id, --incident, a filter, …).");
    }
    return {
      kind: "ok",
      value: {
        stateDir: flag(args, "--state-dir"),
        json: args.includes("--json"),
        selector,
        limits: parseLimits(args),
      },
    };
  } catch (error) {
    if (error instanceof SupportUsageError) return usage(error.message);
    throw error;
  }
}

export function parseSupportManifestArgs(
  args: readonly string[],
): SupportParseResult<SupportManifestArgs> {
  const [action, ...rest] = args;
  if (action === undefined || action === "--help" || action === "-h") return { kind: "help" };
  if (action !== "rebuild" && action !== "verify") {
    return usage(`unknown manifest action: ${action}`);
  }
  try {
    return {
      kind: "ok",
      value: { action, stateDir: flag(rest, "--state-dir"), json: rest.includes("--json") },
    };
  } catch (error) {
    if (error instanceof SupportUsageError) return usage(error.message);
    throw error;
  }
}

// ─── Selection resolution ──────────────────────────────────────────────────────────────────────

type LoadedServer = Awaited<ReturnType<typeof loadServer>>;

function incidentRoots(record: SupportIncidentRecord): readonly string[] {
  const roots = [...record.correlation.childCorrelationIds];
  if (record.correlation.rootCorrelationId !== undefined) {
    roots.unshift(record.correlation.rootCorrelationId);
  }
  return roots;
}

function incidentWindow(
  server: LoadedServer,
  stateDir: string,
  record: SupportIncidentRecord,
): SupportQueryWindow {
  const segments = server.supportIncidentSegmentFiles(stateDir, record);
  return {
    fromMs: record.window.fromMs,
    toMs: record.window.toMs,
    segmentIds: new Set(segments.map((segment) => segment.segmentId)),
  };
}

interface IncidentSelectionPart {
  readonly roots: readonly string[];
  readonly windows: readonly SupportQueryWindow[];
  readonly declaredClasses: readonly string[];
  readonly userReport: boolean;
}

// A registered failure selects its causal closure; a user report also selects its pinned window and
// takes every correlation in it as a root (#3533's descriptor references, resolved here).
function incidentPart(
  server: LoadedServer,
  stateDir: string,
  record: SupportIncidentRecord,
): IncidentSelectionPart {
  const userReport = record.trigger === "user-report";
  return {
    roots: incidentRoots(record),
    windows: userReport ? [incidentWindow(server, stateDir, record)] : [],
    declaredClasses: userReport ? [] : activityLogFailureClassesOf([record.fingerprint.op]),
    userReport,
  };
}

function incidentSelection(
  queryClass: "incident" | "defect-fingerprint",
  parts: readonly IncidentSelectionPart[],
): SupportClosureSelection {
  const declared = [...new Set(parts.flatMap((part) => part.declaredClasses))];
  return {
    kind: "closure",
    queryClass,
    roots: [...new Set(parts.flatMap((part) => part.roots))],
    windows: parts.flatMap((part) => part.windows),
    requiredClasses: parts.some((part) => part.userReport)
      ? { kind: "observed-failures" }
      : { kind: "declared", failureClasses: declared },
    unresolved: parts.length === 0,
  };
}

function eventQueryClass(filter: SupportEventFilter): SupportEventSelection["queryClass"] {
  if (filter.parentCorrelationId !== undefined) return "parent-correlation";
  if (filter.op !== undefined) return "operation";
  if (filter.errorKind !== undefined) return "error-kind";
  if (filter.failureClass !== undefined) return "failure-class";
  return "time-window";
}

/** Turns parsed selector flags into one engine selection; incidents resolve through the server. */
export async function resolveSupportSelection(
  selector: SupportSelectorArgs,
  stateDir: string,
  loadIncidentServer: () => Promise<LoadedServer> = loadServer,
): Promise<SupportQuerySelection> {
  if (selector.incidentId !== undefined) {
    const server = await loadIncidentServer();
    const record = server.readSupportIncident(stateDir, selector.incidentId);
    return incidentSelection(
      "incident",
      record === undefined ? [] : [incidentPart(server, stateDir, record)],
    );
  }
  if (selector.defectFingerprint !== undefined) {
    const server = await loadIncidentServer();
    const records = server
      .listSupportIncidents(stateDir)
      .filter(
        (record) =>
          record.fingerprint.algorithm === DEFECT_FINGERPRINT_ALGORITHM_VERSION &&
          record.fingerprint.defectFingerprint === selector.defectFingerprint,
      );
    return incidentSelection(
      "defect-fingerprint",
      records.map((record) => incidentPart(server, stateDir, record)),
    );
  }
  if (selector.correlationId !== undefined) {
    return {
      kind: "closure",
      queryClass: "correlation",
      roots: [selector.correlationId],
      windows: [],
      requiredClasses: { kind: "observed" },
      unresolved: false,
    };
  }
  return { kind: "events", queryClass: eventQueryClass(selector.filter), filter: selector.filter };
}

// ─── Running ───────────────────────────────────────────────────────────────────────────────────

export interface SupportQueryRunDeps {
  readonly scanner?: ActivityLogScannerDeps | undefined;
  readonly loadServer?: (() => Promise<LoadedServer>) | undefined;
}

export interface SupportQueryRun {
  readonly result: SupportQueryResult;
  readonly manifestStats: SegmentManifestPassStats;
}

/** Lists the store, maintains the manifests, and runs `selection` over them. */
export function executeSupportQuery(
  stateDir: string,
  selection: SupportQuerySelection,
  limits: SupportQueryLimits,
  options: { readonly trigger: "query" | "export"; readonly scanner?: ActivityLogScannerDeps },
): SupportQueryRun {
  const files = listActivityLogStoreFiles(stateDir);
  const scanner = new ActivityLogScanner(stateDir, options.scanner);
  const pass = ensureSegmentManifests(stateDir, files, scanner, {
    trigger: options.trigger,
    persist: true,
    rebuild: false,
  });
  const result = runSupportQuery({
    files,
    manifests: pass.manifests,
    manifestStats: pass.stats,
    scanner: new ActivityLogScanner(stateDir, options.scanner),
    selection,
    limits,
  });
  return { result, manifestStats: pass.stats };
}

function activityErrorKind(error: unknown): ActivityLogErrorKind {
  const kind = describeErrorKind(error);
  if (kind === "EACCES" || kind === "EPERM" || kind === "permission-failed") {
    return "permission-denied";
  }
  if (kind === "unsafe-target" || kind === "unsafe-ancestor" || kind === "permission-unsafe") {
    return "unsafe-target";
  }
  return kind === "ENOENT" ? "unavailable" : "read-failed";
}

interface EvidenceContext {
  readonly server: LoadedServer;
  readonly stateDir: string;
  readonly correlationId: string;
  readonly io: CliIo;
  readonly command: "query" | "manifest" | "export";
}

// The independent fallback when the Activity Log itself cannot be opened: a closed, content-free
// stderr notice. The command then fails closed instead of running unevidenced.
function reportActivityLogUnavailable(context: EvidenceContext, error: unknown): void {
  context.io.err(
    `keiko support ${context.command}: Activity Log unavailable (${describeErrorKind(error)})\n`,
  );
}

function withActivityLog(
  context: EvidenceContext,
  write: (sink: SupportQueryEvidenceSink) => void,
): void {
  const sink = context.server.createFileServerLogSink(context.stateDir);
  try {
    write(sink);
  } finally {
    sink.close?.();
  }
}

/** Persists the run's manifest and query evidence; `false` when the Activity Log is unavailable. */
export function recordSupportQueryEvidence(
  context: EvidenceContext,
  surface: "query" | "export",
  run: SupportQueryRun,
): boolean {
  try {
    withActivityLog(context, (sink) => {
      emitSupportManifestEvidence(sink, context.correlationId, run.manifestStats);
      emitSupportQueryEvidence(sink, context.correlationId, surface, run.result);
    });
    return true;
  } catch (error) {
    reportActivityLogUnavailable(context, error);
    return false;
  }
}

export function recordSupportQueryFailure(
  context: EvidenceContext,
  failure: {
    readonly surface: SupportQuerySurface;
    readonly queryClass: SupportQueryClass | undefined;
    readonly stage: SupportQueryFailureStage;
    readonly error: unknown;
  },
): void {
  try {
    withActivityLog(context, (sink) => {
      emitSupportQueryFailure(sink, context.correlationId, {
        surface: failure.surface,
        queryClass: failure.queryClass,
        stage: failure.stage,
        errorKind: activityErrorKind(failure.error),
      });
    });
  } catch (error) {
    reportActivityLogUnavailable(context, error);
  }
}

export interface SupportQueryCliDeps {
  readonly cwd?: string | undefined;
  readonly run?: SupportQueryRunDeps | undefined;
}

function printQuery(result: SupportQueryResult, json: boolean, io: CliIo): void {
  io.out(json ? `${JSON.stringify(supportQueryJson(result))}\n` : renderSupportQuery(result));
}

async function resolveOrFail(
  args: SupportQueryArgs,
  context: EvidenceContext,
  io: CliIo,
  loadIncidentServer: () => Promise<LoadedServer>,
): Promise<SupportQuerySelection | undefined> {
  try {
    return await resolveSupportSelection(args.selector, context.stateDir, loadIncidentServer);
  } catch (error) {
    io.err(`keiko support query: incident lookup failed (${describeErrorKind(error)})\n`);
    recordSupportQueryFailure(context, {
      surface: "query",
      queryClass: undefined,
      stage: "incident-lookup",
      error,
    });
    return undefined;
  }
}

export async function runSupportQueryCli(
  args: SupportQueryArgs,
  io: CliIo,
  env: EnvSource,
  deps: SupportQueryCliDeps = {},
): Promise<number> {
  const stateDir = resolveStateDir(deps.cwd ?? process.cwd(), env, args.stateDir);
  const loadIncidentServer = deps.run?.loadServer ?? loadServer;
  const context: EvidenceContext = {
    server: await loadIncidentServer(),
    stateDir,
    correlationId: randomUUID(),
    io,
    command: "query",
  };
  const selection = await resolveOrFail(args, context, io, loadIncidentServer);
  if (selection === undefined) return 1;
  let run: SupportQueryRun;
  try {
    run = executeSupportQuery(stateDir, selection, args.limits, {
      trigger: "query",
      ...(deps.run?.scanner === undefined ? {} : { scanner: deps.run.scanner }),
    });
  } catch (error) {
    io.err(
      `keiko support query: the Activity Log could not be listed (${describeErrorKind(error)})\n`,
    );
    recordSupportQueryFailure(context, {
      surface: "query",
      queryClass: selection.queryClass,
      stage: "store-listing",
      error,
    });
    return 1;
  }
  if (!recordSupportQueryEvidence(context, "query", run)) return 1;
  printQuery(run.result, args.json, io);
  return 0;
}

function renderManifestStats(stats: SegmentManifestPassStats): string {
  return (
    `Manifests (${stats.trigger}): ${String(stats.segmentCount)} sealed segment(s), ` +
    `${String(stats.builtCount + stats.replacedCount)} written, ${String(stats.reusedCount)} reused, ` +
    `${String(stats.verifiedCount)} verified, ${String(stats.mismatchCount)} missing or different, ` +
    `${String(stats.removedOrphanCount)} orphan(s) removed, ${String(stats.unreadableCount)} unreadable, ` +
    `${String(stats.writeFailedCount)} write failure(s).\n`
  );
}

function manifestPass(
  stateDir: string,
  action: "rebuild" | "verify",
  scanner?: ActivityLogScannerDeps,
): SegmentManifestPassStats {
  const files: readonly ActivityLogStoreFile[] = listActivityLogStoreFiles(stateDir);
  const activityScanner = new ActivityLogScanner(stateDir, scanner);
  if (action === "verify") return verifySegmentManifests(stateDir, files, activityScanner);
  return ensureSegmentManifests(stateDir, files, activityScanner, {
    trigger: "rebuild",
    persist: true,
    rebuild: true,
  }).stats;
}

export async function runSupportManifestCli(
  args: SupportManifestArgs,
  io: CliIo,
  env: EnvSource,
  deps: SupportQueryCliDeps = {},
): Promise<number> {
  const stateDir = resolveStateDir(deps.cwd ?? process.cwd(), env, args.stateDir);
  const context: EvidenceContext = {
    server: await (deps.run?.loadServer ?? loadServer)(),
    stateDir,
    correlationId: randomUUID(),
    io,
    command: "manifest",
  };
  let stats: SegmentManifestPassStats;
  try {
    stats = manifestPass(stateDir, args.action, deps.run?.scanner);
  } catch (error) {
    io.err(
      `keiko support manifest: the Activity Log could not be listed (${describeErrorKind(error)})\n`,
    );
    recordSupportQueryFailure(context, {
      surface: args.action,
      queryClass: undefined,
      stage: "manifest",
      error,
    });
    return 1;
  }
  try {
    withActivityLog(context, (sink) => {
      emitSupportManifestEvidence(sink, context.correlationId, stats);
    });
  } catch (error) {
    reportActivityLogUnavailable(context, error);
    return 1;
  }
  io.out(
    args.json
      ? `${JSON.stringify({ kind: "keiko.support.manifest", schemaVersion: 1, ...stats })}\n`
      : renderManifestStats(stats),
  );
  const clean = stats.unreadableCount === 0 && stats.writeFailedCount === 0;
  return clean && (args.action === "rebuild" || stats.mismatchCount === 0) ? 0 : 1;
}
