// `keiko support export` / `keiko support analyze` — the minimal Wave 1 agent-reconstruction
// tooling (design doc "Keiko Activity Log v2" §6.5; ADR-0173 draft). `export` composes only
// existing, hardened pieces into one redacted `.jsonl` bundle: the in-process `AuditResult`
// `keiko audit local-state --json` already produces, the evidence-index count from
// `listEvidence`, and a verbatim copy of `<state-dir>/logs/server*.log`. `analyze` groups a
// bundle's (or a raw server.log's) lines by correlationId into reconstructed timelines.
//
// This file owns argv parsing, stdout/stderr, environment/state-dir resolution, and calling the
// audit/evidence subsystems. The exporter's and analyzer's own logic — file discovery, size-budget
// selection, manifest assembly, parsing, grouping, ordering, rendering — lives in
// ./support-export.ts and ./support-analyze.ts, each independently unit-tested on data, not argv.

import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { KEIKO_PRODUCT_VERSION } from "@oscharko-dev/keiko-contracts";
import type { EvidenceStore } from "@oscharko-dev/keiko-evidence";
import type { EnvSource } from "@oscharko-dev/keiko-model-gateway";
import { type AuditCliDeps, AuditLoadError, auditLocalStateResult } from "./audit.js";
// GEN-PERF-CLI-001 — the evidence graph (and, below, the server module graph) load at dispatch,
// and only for `export`; `analyze` never needs either. Store-fingerprint collection (ui,
// local-knowledge, memory-vault) is owned by keiko-server (ADR-0019 direction rule 7: keiko-cli
// is a leaf consumer and must not import keiko-local-knowledge directly) and reached through the
// same lazily-loaded server module, via `server.collectStoreFingerprints`.
import { loadEvidence, loadServer } from "./lazy-modules.js";
import type { CliIo } from "./runner.js";
import { resolveStateDir } from "./state-paths.js";
import {
  analyzeLogText,
  findTimeline,
  renderHumanAllTimelines,
  renderHumanTimeline,
  type AnalyzeAllResult,
  type LogTimeline,
} from "./support-analyze.js";
import {
  buildSupportBundleManifest,
  bundleText,
  DEFAULT_MAX_BUNDLE_BYTES,
  describeErrorKind,
  discoverServerLogFiles,
  readKeptFiles,
  selectLogFilesWithinBudget,
  serializeBundleLines,
  type CurrentFileTailTruncated,
  type SkippedLogFile,
} from "./support-export.js";

const USAGE = `Usage:
  keiko support export [--out PATH] [--state-dir PATH] [--max-bytes N]
  keiko support analyze FILE [--correlation-id ID] [--json]

export writes a redacted .jsonl support bundle: a manifest line (local-state audit summary,
evidence-index count, exactly which log files were copied, and a redacted schema/integrity
fingerprint for each of the ui, local-knowledge, and memory-vault stores found under --state-dir)
followed by every line of <state-dir>/logs/server*.log, copied byte-for-byte. A store that has
never been used from this state dir, or that cannot be opened (corrupt, or a vault key the
operator has not supplied), is named in the manifest's storesUnavailable instead of failing the
export. Default --out is ./keiko-support-<timestamp>.jsonl (colons replaced with '-'); default
--max-bytes is 50MB — the oldest log files are dropped first when the cap would be exceeded, and
always named in the manifest's truncatedLogFiles. The current log file is never dropped; if it
alone still exceeds the cap, only its tail is exported instead, named in the manifest's
currentFileTailTruncated.

analyze reads FILE (a support bundle or a raw server.log — auto-detected), groups its lines by
correlationId, and prints one reconstructed timeline per id. Each process lifetime is ordered by
seq; lifetimes are ordered by the position of their first line in the file, because the log
envelope promises no order across processes.
--correlation-id narrows to a single id; --json emits the machine-readable form.
`;

export interface SupportCliDeps {
  readonly cwd?: string | undefined;
  readonly now?: (() => Date) | undefined;
  /** Forwarded verbatim to auditLocalStateResult — the same seam `keiko audit` itself uses. */
  readonly auditDeps?: AuditCliDeps | undefined;
  /** Test seam: bypasses real disk I/O for the evidence index count. */
  readonly evidenceStore?: EvidenceStore | undefined;
}

interface ExportArgs {
  readonly out: string | undefined;
  readonly stateDir: string | undefined;
  readonly maxBytes: number | undefined;
}

interface AnalyzeArgs {
  readonly file: string;
  readonly correlationId: string | undefined;
  readonly json: boolean;
}

export type ParsedSupportArgs =
  | { readonly kind: "help" }
  | { readonly kind: "usage"; readonly message: string }
  | { readonly kind: "export"; readonly value: ExportArgs }
  | { readonly kind: "analyze"; readonly value: AnalyzeArgs };

type ParseResult<T> =
  | { readonly kind: "help" }
  | { readonly kind: "usage"; readonly message: string }
  | { readonly kind: "ok"; readonly value: T };

// Returns the value of a `--flag value` pair: undefined when the flag is absent, null when it is
// present but missing (or immediately followed by another flag) its value — same contract as
// investigate.ts's flagValue.
function flagValue(args: readonly string[], name: string): string | undefined | null {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  return value === undefined || value.startsWith("--") ? null : value;
}

function parsePositiveInteger(value: string): number | undefined {
  if (!/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function parseExportArgs(args: readonly string[]): ParseResult<ExportArgs> {
  if (args.includes("--help") || args.includes("-h")) return { kind: "help" };
  const out = flagValue(args, "--out");
  const stateDir = flagValue(args, "--state-dir");
  const maxBytesRaw = flagValue(args, "--max-bytes");
  if (out === null || stateDir === null || maxBytesRaw === null) {
    return {
      kind: "usage",
      message: `keiko support export: a flag is missing its value.\n${USAGE}`,
    };
  }
  const maxBytes = maxBytesRaw === undefined ? undefined : parsePositiveInteger(maxBytesRaw);
  if (maxBytesRaw !== undefined && maxBytes === undefined) {
    return {
      kind: "usage",
      message: `keiko support export: --max-bytes must be a positive integer.\n${USAGE}`,
    };
  }
  return { kind: "ok", value: { out, stateDir, maxBytes } };
}

function parseAnalyzeArgs(args: readonly string[]): ParseResult<AnalyzeArgs> {
  if (args.includes("--help") || args.includes("-h")) return { kind: "help" };
  const file = args[0];
  if (file === undefined || file.startsWith("--")) {
    return {
      kind: "usage",
      message: `keiko support analyze: a FILE argument is required.\n${USAGE}`,
    };
  }
  const rest = args.slice(1);
  const correlationId = flagValue(rest, "--correlation-id");
  if (correlationId === null) {
    return {
      kind: "usage",
      message: `keiko support analyze: --correlation-id is missing its value.\n${USAGE}`,
    };
  }
  return { kind: "ok", value: { file, correlationId, json: rest.includes("--json") } };
}

export function parseSupportArgs(args: readonly string[]): ParsedSupportArgs {
  const [subcommand, ...rest] = args;
  if (subcommand === undefined || subcommand === "--help" || subcommand === "-h") {
    return { kind: "help" };
  }
  if (subcommand === "export") {
    const parsed = parseExportArgs(rest);
    return parsed.kind === "ok" ? { kind: "export", value: parsed.value } : parsed;
  }
  if (subcommand === "analyze") {
    const parsed = parseAnalyzeArgs(rest);
    return parsed.kind === "ok" ? { kind: "analyze", value: parsed.value } : parsed;
  }
  return { kind: "usage", message: `keiko support: unknown subcommand: ${subcommand}\n${USAGE}` };
}

function resolveStateDirSource(
  env: EnvSource,
  stateDirArg: string | undefined,
): "default" | "env-override" {
  const envSet = env.KEIKO_STATE_DIR !== undefined && env.KEIKO_STATE_DIR !== "";
  return stateDirArg !== undefined || envSet ? "env-override" : "default";
}

function defaultOutFileName(generatedAt: Date): string {
  return `keiko-support-${generatedAt.toISOString().replaceAll(":", "-")}.jsonl`;
}

function resolveOutPath(cwd: string, outArg: string | undefined, generatedAt: Date): string {
  const value = outArg ?? defaultOutFileName(generatedAt);
  return isAbsolute(value) ? value : resolve(cwd, value);
}

// Never throws: a missing or unreadable evidence directory means zero evidence to report, never a
// failed export (the manifest field is a count, not a listing, so there is nothing sensitive to
// lose by reporting zero).
async function resolveEvidenceIndexCount(
  evidenceDir: string,
  deps: SupportCliDeps,
): Promise<number> {
  try {
    const evidence = await loadEvidence();
    const store = deps.evidenceStore ?? evidence.createNodeEvidenceStore(evidenceDir);
    return evidence.listEvidence(store).length;
  } catch {
    return 0;
  }
}

// The exported detector (ADR-0173, `detectUpdateInstallMode`/`productionUpdateFacts`) answers
// "which install mode is this process running in" synchronously with no lock — the same call
// `keiko-cli`'s `ui.ts` already makes for `process.started`. Wrapped in a try/catch anyway because
// the detector walks the filesystem from `process.argv[1]` looking for this package's own
// `package.json`; a genuinely unreadable path must not fail the whole export. "unknown" is the
// same honest fallback the manifest used before this detector was reachable from here at all.
function resolveExportInstallMode(server: Awaited<ReturnType<typeof loadServer>>): string {
  try {
    const mode = server.detectUpdateInstallMode(
      server.productionUpdateFacts(process.env),
      process.env,
    );
    // `installKind` is optional on the wire contract (other producers of `UpdateInstallMode` may
    // omit it), even though this detector always sets it in practice; "unknown" covers both that
    // theoretical gap and a thrown error with the same fallback.
    return mode.installKind ?? "unknown";
  } catch {
    return "unknown";
  }
}

interface LogContent {
  readonly contentLines: readonly string[];
  readonly sourceLogFiles: readonly string[];
  readonly truncatedLogFiles: readonly string[];
  readonly currentFileTailTruncated: CurrentFileTailTruncated | undefined;
  readonly budgetExceeded: boolean;
  readonly skippedLogFiles: readonly SkippedLogFile[];
}

// Discovers, budget-selects, and reads the state dir's server*.log files in one pass, tolerating
// the sink's own rotation/retention pruning at both boundaries it can race
// (support-export.ts's `discoverServerLogFiles`, between `readdirSync` and `statSync`, and
// `readKeptFiles`, between selection and the actual read): `sourceLogFiles` names only the files
// that actually contributed content; `skippedLogFiles` names every file that vanished at either
// boundary, by name only, never by its absolute path. `budgetExceeded` and
// `currentFileTailTruncated` come from `readKeptFiles`, not `selection`: only the read step knows
// whether a tail read of the current file actually managed to keep a complete line, which is what
// decides whether the size budget was, in the end, honoured.
function collectLogContent(logsDir: string, maxBytes: number): LogContent {
  const discovery = discoverServerLogFiles(logsDir);
  const selection = selectLogFilesWithinBudget(discovery.files, maxBytes);
  const read = readKeptFiles(selection.kept, selection.currentFileTailBudgetBytes);
  const readSkipped = new Set(read.skippedLogFiles.map((skipped) => skipped.name));
  const sourceLogFiles = selection.kept
    .map((file) => file.name)
    .filter((name) => !readSkipped.has(name));
  return {
    contentLines: read.contentLines,
    sourceLogFiles,
    truncatedLogFiles: selection.truncatedLogFiles,
    currentFileTailTruncated: read.currentFileTailTruncated,
    budgetExceeded: read.budgetExceeded,
    skippedLogFiles: [...discovery.skippedLogFiles, ...read.skippedLogFiles],
  };
}

// Content-free, same discipline as readAnalyzeSource: an fs error's message can quote the path it
// was writing (AGENTS.md §7). Reports `describeErrorKind`'s result — the fs error's own `code`
// (ENOENT/EACCES/EROFS) when it has one, since a Node fs error is always a plain `Error` and
// `error.constructor.name` is therefore always just `"Error"`, telling an operator nothing the
// generic prefix didn't already say. Returns undefined on success, an exit code on failure.
function writeBundleOrExitCode(outPath: string, contents: string, io: CliIo): number | undefined {
  try {
    writeFileSync(outPath, contents, "utf8");
    return undefined;
  } catch (error) {
    io.err(`keiko support export: could not write the bundle: ${describeErrorKind(error)}\n`);
    return 1;
  }
}

// Finding 1 (minor): store fingerprint collection runs a synchronous full-DB `quick_check` plus
// a row count per table for each store, which can take a while against a large local-knowledge
// index with nothing printed while it runs. This progress line keeps a slow run from looking
// hung, without changing the collection's synchronous, untimed behavior itself.
function reportStoreFingerprintProgress(io: CliIo): void {
  io.err(
    "keiko support export: computing store fingerprints (may take a while on a large local-knowledge index)...\n",
  );
}

function reportAuditFailure(error: unknown, io: CliIo): number {
  if (error instanceof AuditLoadError) {
    io.err(
      `keiko support export: local-state audit could not produce a result (${error.reason}); ` +
        "refusing to write a bundle without an audit summary.\n",
    );
    return 1;
  }
  if (error instanceof Error) {
    io.err(`keiko support export: ${error.message}\n`);
    return 1;
  }
  throw error;
}

async function runSupportExport(
  args: ExportArgs,
  io: CliIo,
  env: EnvSource,
  deps: SupportCliDeps,
): Promise<number> {
  const cwd = deps.cwd ?? process.cwd();
  const now = deps.now ?? ((): Date => new Date());
  const stateDir = resolveStateDir(cwd, env, args.stateDir);
  const stateDirSource = resolveStateDirSource(env, args.stateDir);
  const logContent = collectLogContent(
    join(stateDir, "logs"),
    args.maxBytes ?? DEFAULT_MAX_BUNDLE_BYTES,
  );
  const evidenceDir = env.KEIKO_EVIDENCE_DIR ?? join(stateDir, "evidence");
  const evidenceIndexCount = await resolveEvidenceIndexCount(evidenceDir, deps);
  // Not a hot path (`support analyze` never reaches this function), so loading the server module
  // graph here is not the GEN-PERF-CLI-001 cost `ui.ts` guards against on every command dispatch.
  const server = await loadServer();

  let auditSummary;
  try {
    auditSummary = await auditLocalStateResult(stateDir, env, deps.auditDeps ?? {});
  } catch (error) {
    return reportAuditFailure(error, io);
  }

  // Deferred until after the audit's own fail-closed check: opening three real stores is real
  // I/O, wasted if the export is about to be refused anyway.
  reportStoreFingerprintProgress(io);
  const storeFingerprintCollection = await server.collectStoreFingerprints({ stateDir, env });
  const generatedAtDate = now();
  const manifest = buildSupportBundleManifest({
    schemaVersion: server.SERVER_LOG_SCHEMA_VERSION,
    productVersion: KEIKO_PRODUCT_VERSION,
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.version,
    generatedAt: generatedAtDate.toISOString(),
    installMode: resolveExportInstallMode(server),
    stateDirSource,
    sourceLogFiles: logContent.sourceLogFiles,
    truncatedLogFiles: logContent.truncatedLogFiles,
    currentFileTailTruncated: logContent.currentFileTailTruncated,
    budgetExceeded: logContent.budgetExceeded,
    skippedLogFiles: logContent.skippedLogFiles,
    auditSummary,
    evidenceIndexCount,
    storeFingerprints: storeFingerprintCollection.fingerprints,
    storesUnavailable: storeFingerprintCollection.unavailable,
  });

  const lines = serializeBundleLines(manifest, logContent.contentLines);
  const outPath = resolveOutPath(cwd, args.out, generatedAtDate);
  const failureCode = writeBundleOrExitCode(outPath, bundleText(lines), io);
  if (failureCode !== undefined) return failureCode;
  io.out(`Wrote ${String(lines.length)} lines to ${outPath}\n`);
  return 0;
}

function reportMissingCorrelationId(correlationId: string, io: CliIo): number {
  io.err(`keiko support analyze: no lines found for correlation id: ${correlationId}\n`);
  return 1;
}

function emitSingleTimeline(
  timeline: LogTimeline,
  malformedLineCount: number,
  json: boolean,
  io: CliIo,
): number {
  if (json) {
    io.out(`${JSON.stringify({ ...timeline, malformedLineCount })}\n`);
  } else {
    io.out(renderHumanTimeline(timeline));
  }
  return 0;
}

function emitAllTimelines(result: AnalyzeAllResult, json: boolean, io: CliIo): number {
  io.out(json ? `${JSON.stringify(result)}\n` : renderHumanAllTimelines(result));
  return 0;
}

function readAnalyzeSource(filePath: string, io: CliIo): string | number {
  try {
    return readFileSync(filePath, "utf8");
  } catch (error) {
    // Content-free: an fs error's message can quote the path it was reading (AGENTS.md §7).
    const kind = error instanceof Error ? error.constructor.name : "Error";
    io.err(`keiko support analyze: could not read ${filePath} — ${kind}\n`);
    return 1;
  }
}

function runSupportAnalyze(args: AnalyzeArgs, io: CliIo, deps: SupportCliDeps): number {
  const cwd = deps.cwd ?? process.cwd();
  const filePath = isAbsolute(args.file) ? args.file : resolve(cwd, args.file);
  const text = readAnalyzeSource(filePath, io);
  if (typeof text === "number") return text;

  const result = analyzeLogText(text);
  if (args.correlationId === undefined) {
    return emitAllTimelines(result, args.json, io);
  }
  const timeline = findTimeline(result, args.correlationId);
  if (timeline === undefined) return reportMissingCorrelationId(args.correlationId, io);
  return emitSingleTimeline(timeline, result.malformedLineCount, args.json, io);
}

export async function runSupportCli(
  args: readonly string[],
  io: CliIo,
  env: EnvSource = {},
  deps: SupportCliDeps = {},
): Promise<number> {
  const parsed = parseSupportArgs(args);
  if (parsed.kind === "help") {
    io.out(USAGE);
    return 0;
  }
  if (parsed.kind === "usage") {
    io.err(parsed.message);
    return 2;
  }
  if (parsed.kind === "export") {
    return runSupportExport(parsed.value, io, env, deps);
  }
  return runSupportAnalyze(parsed.value, io, deps);
}
