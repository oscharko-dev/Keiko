// `keiko support incident list|show|preview|report|dismiss` (#3533).
//
// This is the CLI face of the local SupportIncident store. It never transmits anything: `report`
// records an explicit "Report a problem" candidate on this machine, `preview` prints exactly the
// closed public-finding fields a user may choose to copy, and `show` prints the richer, still
// body-free private projection. The candidate store and its triggers live in keiko-server
// (observability/support-incident.ts), reached through the lazily loaded server module.
//
// `resolveSupportIncident` is the one place a stored record becomes the canonical descriptor: it
// reads the Activity Log segments the incident window covers (the same coverage rule the retention
// pin uses), analyzes them with the existing `keiko support analyze` machinery, and narrows the
// analyzer's per-class sufficiency to the incident's failure classes. A user report whose window
// holds no registered failure therefore resolves to `insufficient` with `no-registered-failure`.

import { basename } from "node:path";
import {
  activityLogOperationSchema,
  isSupportIncidentId,
  supportIncidentPrivateProjection,
  supportIncidentPublicProjection,
  type SupportIncident,
  type SupportIncidentRecord,
  type SupportIncidentSufficiency,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import type { EnvSource } from "@oscharko-dev/keiko-model-gateway";
import type { SupportIncidentSegmentFile } from "@oscharko-dev/keiko-server";
import { flagValue } from "./cli-arg-parsing.js";
import { loadServer } from "./lazy-modules.js";
import type { CliIo } from "./runner.js";
import { resolveStateDir } from "./state-paths.js";
import {
  ACTIVITY_LOG_EVIDENCE_INTEGRITY,
  analyzeLogText,
  type ActivityLogEvidenceSummary,
  type AnalyzeAllResult,
} from "./support-analyze.js";
import {
  activityLogFailureClassesOf,
  restrictActivityLogSufficiency,
} from "./support-analyze-sufficiency.js";
import { readKeptFiles } from "./support-export.js";

export const SUPPORT_INCIDENT_USAGE = `Usage:
  keiko support incident list [--state-dir PATH] [--json]
  keiko support incident show ID [--state-dir PATH] [--json]
  keiko support incident preview ID [--state-dir PATH] [--json]
  keiko support incident report [--state-dir PATH] [--json]
  keiko support incident dismiss ID [--state-dir PATH]

Keiko records a local incident candidate when a registered failure occurs, and when you run
'report' for a problem Keiko did not detect. Each candidate keeps the Activity Log evidence around
it (a bounded window) from being rotated away until you dismiss it or it expires. Nothing is ever
sent anywhere.

list prints the open candidates. show prints one candidate's private, body-free report projection:
references, closed enums, counts, and digests only. preview prints the smaller public projection —
the only fields a public finding may carry. report records a new candidate for a problem you
noticed. dismiss removes a candidate and stops protecting its evidence. --json prints the machine
form.
`;

type IncidentCommand = "list" | "show" | "preview" | "report" | "dismiss";

export interface SupportIncidentArgs {
  readonly command: IncidentCommand;
  readonly incidentId: string | undefined;
  readonly stateDir: string | undefined;
  readonly json: boolean;
}

export type ParsedSupportIncidentArgs =
  | { readonly kind: "help" }
  | { readonly kind: "usage"; readonly message: string }
  | { readonly kind: "ok"; readonly value: SupportIncidentArgs };

const COMMANDS: ReadonlySet<string> = new Set(["list", "show", "preview", "report", "dismiss"]);
const ID_COMMANDS: ReadonlySet<string> = new Set(["show", "preview", "dismiss"]);

function usage(message: string): ParsedSupportIncidentArgs {
  return {
    kind: "usage",
    message: `keiko support incident: ${message}\n${SUPPORT_INCIDENT_USAGE}`,
  };
}

function parseIncidentId(command: string, rest: readonly string[]): string | null | undefined {
  if (!ID_COMMANDS.has(command)) return undefined;
  const candidate = rest[0];
  return candidate !== undefined && isSupportIncidentId(candidate) ? candidate : null;
}

export function parseSupportIncidentArgs(args: readonly string[]): ParsedSupportIncidentArgs {
  const [command, ...rest] = args;
  if (
    command === undefined ||
    command === "--help" ||
    command === "-h" ||
    rest.includes("--help")
  ) {
    return { kind: "help" };
  }
  if (!COMMANDS.has(command)) return usage(`unknown subcommand: ${command}`);
  const incidentId = parseIncidentId(command, rest);
  if (incidentId === null) return usage(`${command} requires an incident ID (32 hex characters).`);
  const stateDir = flagValue(rest, "--state-dir");
  if (stateDir === null) return usage("--state-dir is missing its value.");
  return {
    kind: "ok",
    value: {
      command: command as IncidentCommand,
      incidentId,
      stateDir,
      json: rest.includes("--json"),
    },
  };
}

// ─── Resolution: record + pinned window → the canonical descriptor ─────────────────────────────

/** The window is analyzed whole or not at all: a partial read could never be labeled complete. */
export const MAX_SUPPORT_INCIDENT_WINDOW_BYTES = 64 * 1024 * 1024;

export class SupportIncidentWindowError extends Error {
  public override readonly name = "SupportIncidentWindowError";
  public readonly reason: "window-too-large" | "segment-unreadable";

  public constructor(reason: "window-too-large" | "segment-unreadable") {
    super(`support incident window ${reason}`);
    this.reason = reason;
  }
}

/** Reads the covered segments through the export's hardened reader; fails closed on any skip. */
export function readSupportIncidentWindow(segments: readonly SupportIncidentSegmentFile[]): string {
  const total = segments.reduce((sum, segment) => sum + segment.sizeBytes, 0);
  if (total > MAX_SUPPORT_INCIDENT_WINDOW_BYTES) {
    throw new SupportIncidentWindowError("window-too-large");
  }
  const read = readKeptFiles(
    segments.map((segment) => ({
      name: basename(segment.path),
      path: segment.path,
      sizeBytes: segment.sizeBytes,
    })),
  );
  if (read.skippedLogFiles.length > 0) throw new SupportIncidentWindowError("segment-unreadable");
  return read.contentLines.map((line) => `${line}\n`).join("");
}

function incidentFailureClasses(
  record: SupportIncidentRecord,
  analysis: AnalyzeAllResult,
): readonly string[] {
  if (record.trigger === "registered-failure") {
    return activityLogFailureClassesOf([record.fingerprint.op]);
  }
  // A user report attributes no operation itself; only registered failures in its window count.
  const failureOps = analysis.clusters
    .map((cluster) => cluster.op)
    .filter((op) => activityLogOperationSchema(op)?.lifecycle === "failure");
  return activityLogFailureClassesOf(failureOps);
}

function incidentSufficiency(
  record: SupportIncidentRecord,
  analysis: AnalyzeAllResult,
): SupportIncidentSufficiency {
  const required = incidentFailureClasses(record, analysis);
  const narrowed = restrictActivityLogSufficiency(analysis.sufficiency, required);
  return {
    status: narrowed.status,
    reasons: narrowed.reasons,
    coverage: {
      requiredClassCount: required.length,
      presentClassCount: narrowed.coverage.observedClassCount,
      completeClassCount: narrowed.coverage.completeClassCount,
      degradedClassCount: narrowed.coverage.degradedClassCount,
      insufficientClassCount: narrowed.coverage.insufficientClassCount,
    },
  };
}

function evidenceLineCount(evidence: ActivityLogEvidenceSummary): number {
  return (
    evidence.supportedLineCount +
    evidence.legacyLineCount +
    evidence.unsupportedLineCount +
    evidence.corruptLineCount +
    evidence.truncatedLineCount +
    evidence.incompleteLineCount
  );
}

/** Builds the canonical SupportIncident descriptor from a record and its window's evidence. */
export function resolveSupportIncident(
  record: SupportIncidentRecord,
  segments: readonly SupportIncidentSegmentFile[],
  windowText: string,
): SupportIncident {
  const analysis = analyzeLogText(windowText);
  const classification = analysis.evidence.classification;
  return {
    ...record,
    evidence: {
      segments: segments.map(({ segmentId, state, sizeBytes }) => ({
        segmentId,
        state,
        sizeBytes,
      })),
      lineCount: evidenceLineCount(analysis.evidence),
      integrity: classification,
      ...ACTIVITY_LOG_EVIDENCE_INTEGRITY[classification],
    },
    sufficiency: incidentSufficiency(record, analysis),
  };
}

// ─── Rendering (the human forms are derived from the machine projections) ──────────────────────

function renderFields(title: string, fields: object): string {
  const rows = Object.entries(fields).map(
    ([key, value]: [string, unknown]) =>
      `  ${key}: ${typeof value === "object" ? JSON.stringify(value) : String(value)}`,
  );
  return `${title}\n${rows.join("\n")}\n`;
}

function renderRecordLine(record: SupportIncidentRecord): string {
  return [
    record.incidentId,
    record.trigger,
    record.state,
    `${record.fingerprint.surface}/${record.fingerprint.op}`,
    record.fingerprint.errorKind,
    `fingerprint=${record.fingerprint.defectFingerprint.slice(0, 12)}`,
    `pin=${record.pin.status}`,
    `expires=${new Date(record.expiresAtMs).toISOString()}`,
  ].join("  ");
}

export function renderSupportIncidentList(records: readonly SupportIncidentRecord[]): string {
  if (records.length === 0) return "No open incident candidates.\n";
  return `${records.map(renderRecordLine).join("\n")}\n`;
}

export function renderSupportIncidentPreview(incident: SupportIncident): string {
  return (
    renderFields(
      "Public finding preview. Nothing has been sent; copy only what you choose to share.",
      supportIncidentPublicProjection(incident),
    ) + "Diagnostics, logs, and the private report are never part of a public finding.\n"
  );
}

export function renderSupportIncidentShow(incident: SupportIncident): string {
  return renderFields(
    "Private report projection (body-free; stays on this machine).",
    supportIncidentPrivateProjection(incident),
  );
}

// ─── Command execution ─────────────────────────────────────────────────────────────────────────

type LoadedServer = Awaited<ReturnType<typeof loadServer>>;

interface IncidentContext {
  readonly server: LoadedServer;
  readonly stateDir: string;
  readonly io: CliIo;
  readonly json: boolean;
}

function printJson(io: CliIo, value: unknown): void {
  io.out(`${JSON.stringify(value, null, 2)}\n`);
}

function runList(context: IncidentContext): number {
  const records = context.server.listSupportIncidents(context.stateDir);
  if (context.json) printJson(context.io, { incidents: records });
  else context.io.out(renderSupportIncidentList(records));
  return 0;
}

function findRecord(
  context: IncidentContext,
  incidentId: string,
): SupportIncidentRecord | undefined {
  const record = context.server
    .listSupportIncidents(context.stateDir)
    .find((candidate) => candidate.incidentId === incidentId);
  if (record === undefined)
    context.io.err(`keiko support incident: no open incident ${incidentId}\n`);
  return record;
}

function resolveOrReport(
  context: IncidentContext,
  incidentId: string,
): SupportIncident | undefined {
  const record = findRecord(context, incidentId);
  if (record === undefined) return undefined;
  const segments = context.server.supportIncidentSegmentFiles(context.stateDir, record);
  try {
    return resolveSupportIncident(record, segments, readSupportIncidentWindow(segments));
  } catch (error) {
    if (!(error instanceof SupportIncidentWindowError)) throw error;
    context.io.err(
      `keiko support incident: the incident window cannot be resolved (${error.reason})\n`,
    );
    return undefined;
  }
}

function runShow(context: IncidentContext, incidentId: string, publicOnly: boolean): number {
  const incident = resolveOrReport(context, incidentId);
  if (incident === undefined) return 1;
  if (context.json) {
    printJson(
      context.io,
      publicOnly
        ? supportIncidentPublicProjection(incident)
        : supportIncidentPrivateProjection(incident),
    );
  } else {
    context.io.out(
      publicOnly ? renderSupportIncidentPreview(incident) : renderSupportIncidentShow(incident),
    );
  }
  return 0;
}

function runReport(context: IncidentContext): number {
  const result = context.server.recordUserReportedIncident(context.stateDir);
  if (context.json) {
    printJson(
      context.io,
      result.status === "rejected"
        ? { status: result.status, reason: result.reason }
        : { status: result.status, incidentId: result.record.incidentId },
    );
  } else if (result.status === "rejected") {
    context.io.err(`keiko support incident: the report could not be recorded (${result.reason})\n`);
  } else {
    context.io.out(
      `Recorded incident ${result.record.incidentId}. Its evidence window is kept until you ` +
        `dismiss it or it expires. Nothing was sent.\n` +
        `Next: keiko support incident preview ${result.record.incidentId}\n`,
    );
  }
  return result.status === "rejected" ? 1 : 0;
}

function runDismiss(context: IncidentContext, incidentId: string): number {
  const outcome = context.server.dismissSupportIncident(context.stateDir, incidentId);
  if (outcome === "dismissed") {
    context.io.out(`Dismissed incident ${incidentId}.\n`);
    return 0;
  }
  context.io.err(`keiko support incident: dismiss ${incidentId} ${outcome}\n`);
  return 1;
}

function dispatch(context: IncidentContext, args: SupportIncidentArgs): number {
  const incidentId = args.incidentId ?? "";
  switch (args.command) {
    case "list":
      return runList(context);
    case "show":
      return runShow(context, incidentId, false);
    case "preview":
      return runShow(context, incidentId, true);
    case "report":
      return runReport(context);
    case "dismiss":
      return runDismiss(context, incidentId);
  }
}

export interface SupportIncidentCliDeps {
  readonly cwd?: string | undefined;
}

export async function runSupportIncidentCli(
  args: readonly string[],
  io: CliIo,
  env: EnvSource = {},
  deps: SupportIncidentCliDeps = {},
): Promise<number> {
  const parsed = parseSupportIncidentArgs(args);
  if (parsed.kind === "help") {
    io.out(SUPPORT_INCIDENT_USAGE);
    return 0;
  }
  if (parsed.kind === "usage") {
    io.err(parsed.message);
    return 2;
  }
  const stateDir = resolveStateDir(deps.cwd ?? process.cwd(), env, parsed.value.stateDir);
  const server = await loadServer();
  return dispatch({ server, stateDir, io, json: parsed.value.json }, parsed.value);
}
