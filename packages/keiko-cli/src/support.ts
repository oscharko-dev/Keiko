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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { KEIKO_PRODUCT_VERSION } from "@oscharko-dev/keiko-contracts";
import type { EvidenceStore } from "@oscharko-dev/keiko-evidence";
import type { EnvSource } from "@oscharko-dev/keiko-model-gateway";
import { type AuditCliDeps, AuditLoadError, auditLocalStateResult } from "./audit.js";
// KEIKO-0655: shared argv-parsing helper replaces the byte-identical flagValue copy this file held.
import { flagValue } from "./cli-arg-parsing.js";
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
  buildReproductionSeed,
  findTimeline,
  renderGatewayReplayScriptFixture,
  renderHumanAllTimelines,
  renderHumanClusters,
  renderHumanReproductionSeed,
  renderHumanTimeline,
  type AnalyzeAllResult,
  type LogTimeline,
  type OpCluster,
  type ReproductionSeed,
} from "./support-analyze.js";
import {
  buildConfigSnapshotSection,
  buildEvidenceManifestSection,
  buildSupportBundleManifest,
  buildUiLogSection,
  bundleSha256Hex,
  bundleText,
  DEFAULT_MAX_BUNDLE_BYTES,
  describeErrorKind,
  discoverServerLogFiles,
  readKeptFiles,
  selectLogFilesWithinBudget,
  serializeBundleLines,
  sha256SidecarPath,
  UI_LOG_FILE_NAME,
  UI_LOG_SECTION,
  type CurrentFileTailTruncated,
  type SkippedLogFile,
  type SupportBundleConfigSnapshotSection,
  type SupportBundleEvidenceManifestSection,
  type SupportBundleUiLogSection,
} from "./support-export.js";

const USAGE = `Usage:
  keiko support export [--out PATH] [--state-dir PATH] [--max-bytes N]
                        [--include-ui-log --i-understand-this-is-unredacted]
                        [--include-evidence RUNID[,RUNID...]]
  keiko support analyze FILE [--correlation-id ID] [--json] [--clusters]
                        [--seed] [--emit-fixture PATH]

export writes a redacted .jsonl support bundle: a manifest line (local-state audit summary,
evidence-index count, exactly which log files were copied, and a redacted schema/integrity
fingerprint for each of the ui, local-knowledge, and memory-vault stores found under --state-dir),
an always-present config-snapshot section (Keiko's own resolved KEIKO_* runtime configuration,
redacted), then every line of <state-dir>/logs/server*.log, copied byte-for-byte. A store that has
never been used from this state dir, or that cannot be opened (corrupt, or a vault key the
operator has not supplied), is named in the manifest's storesUnavailable instead of failing the
export. Default --out is ./keiko-support-<timestamp>.jsonl (colons replaced with '-'); default
--max-bytes is 50MB — the oldest log files are dropped first when the cap would be exceeded, and
always named in the manifest's truncatedLogFiles. The current log file is never dropped; if it
alone still exceeds the cap, only its tail is exported instead, named in the manifest's
currentFileTailTruncated. A <output>.sha256 sidecar carries a SHA-256 digest of the bundle's bytes.

<state-dir>/ui.log (the UI/BFF process's raw, unredacted stdout+stderr) is excluded by default and
always named in the manifest's sectionsExcluded — attaching it requires BOTH --include-ui-log AND
--i-understand-this-is-unredacted; either flag alone still excludes it. --include-evidence attaches
the FULL EvidenceStore manifest for each listed runId (beyond the index-only summary above) for
deep replay; a runId that does not exist under --state-dir contributes no section.

analyze reads FILE (a support bundle or a raw server.log — auto-detected), groups its lines by
correlationId, and prints one reconstructed timeline per id. Each process lifetime is ordered by
seq; lifetimes are ordered by the position of their first line in the file, because the log
envelope promises no order across processes.
--correlation-id narrows to a single id; --json emits the machine-readable form. --clusters prints
a whole-file view of every parsed line grouped by (category, op, errorKind), independent of
--correlation-id: a count and up to 5 sample correlation ids per group. --seed (requires
--correlation-id) prints a ReproductionSeed — a gatewayScript/httpRequest/storeFingerprint/
indexingJob/stackFrames/causeChain reconstruction for that one correlationId, plus a warnings field
naming exactly what could not be reconstructed and why. --emit-fixture PATH (requires
--correlation-id) writes a ready-to-paste TypeScript GatewayReplayScriptEntry[] fixture, derived
from that seed's gatewayScript, to PATH — refusing to overwrite an existing file and creating
parent directories as needed. --seed and --emit-fixture may be combined in one invocation.
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
  // Both required together to attach <state-dir>/ui.log — a single flag is never sufficient
  // consent (design doc §6.3). See `runSupportExport`'s `uiLogIncluded`.
  readonly includeUiLog: boolean;
  readonly iUnderstandUnredacted: boolean;
  readonly includeEvidenceRunIds: readonly string[];
}

interface AnalyzeArgs {
  readonly file: string;
  readonly correlationId: string | undefined;
  readonly json: boolean;
  // Wave 6 (epic #3233 closeout, gap #1): a whole-file view of `analyzeLogText`'s own `clusters`
  // field, independent of --correlation-id.
  readonly clusters: boolean;
  // Both require --correlation-id (parseAnalyzeArgs rejects them otherwise) since both are built
  // from `buildReproductionSeed`, which is defined for exactly one correlationId.
  readonly seed: boolean;
  readonly emitFixture: string | undefined;
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

function parsePositiveInteger(value: string): number | undefined {
  if (!/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

// Splits a `--include-evidence` value on commas, trimming each id and dropping empty entries — a
// trailing comma or repeated separator must not manufacture a phantom empty runId that
// `loadEvidence` would then reject.
function parseIncludeEvidenceIds(raw: string | undefined): readonly string[] {
  if (raw === undefined) return [];
  return raw
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
}

function parseExportArgs(args: readonly string[]): ParseResult<ExportArgs> {
  if (args.includes("--help") || args.includes("-h")) return { kind: "help" };
  const out = flagValue(args, "--out");
  const stateDir = flagValue(args, "--state-dir");
  const maxBytesRaw = flagValue(args, "--max-bytes");
  const includeEvidenceRaw = flagValue(args, "--include-evidence");
  if (out === null || stateDir === null || maxBytesRaw === null || includeEvidenceRaw === null) {
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
  return {
    kind: "ok",
    value: {
      out,
      stateDir,
      maxBytes,
      includeUiLog: args.includes("--include-ui-log"),
      iUnderstandUnredacted: args.includes("--i-understand-this-is-unredacted"),
      includeEvidenceRunIds: parseIncludeEvidenceIds(includeEvidenceRaw),
    },
  };
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
  const emitFixture = flagValue(rest, "--emit-fixture");
  if (emitFixture === null) {
    return {
      kind: "usage",
      message: `keiko support analyze: --emit-fixture is missing its value.\n${USAGE}`,
    };
  }
  const seed = rest.includes("--seed");
  if ((seed || emitFixture !== undefined) && correlationId === undefined) {
    return {
      kind: "usage",
      message: `keiko support analyze: --seed/--emit-fixture require --correlation-id.\n${USAGE}`,
    };
  }
  return {
    kind: "ok",
    value: {
      file,
      correlationId,
      json: rest.includes("--json"),
      clusters: rest.includes("--clusters"),
      seed,
      emitFixture,
    },
  };
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
// Also writes the `<output>.sha256` sidecar (design doc §6.2's closing addendum): a cheap
// integrity story for an artifact that crosses a customer-machine-to-agent trust boundary, computed
// over the EXACT bytes just written to `outPath`. A failure writing either file reports the same
// content-free outcome and writes neither half — a bundle without its sidecar, or a sidecar for
// bytes that were never actually persisted, are both worse than refusing the export.
function writeBundleOrExitCode(outPath: string, contents: string, io: CliIo): number | undefined {
  try {
    writeFileSync(outPath, contents, "utf8");
    writeFileSync(sha256SidecarPath(outPath), `${bundleSha256Hex(contents)}\n`, "utf8");
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

type ManifestInput = Parameters<typeof buildSupportBundleManifest>[0];

function processProvenance(
  server: Awaited<ReturnType<typeof loadServer>>,
  generatedAt: Date,
  stateDirSource: ManifestInput["stateDirSource"],
): Pick<
  ManifestInput,
  | "schemaVersion"
  | "productVersion"
  | "platform"
  | "arch"
  | "nodeVersion"
  | "generatedAt"
  | "installMode"
  | "stateDirSource"
> {
  return {
    schemaVersion: server.SERVER_LOG_SCHEMA_VERSION,
    productVersion: KEIKO_PRODUCT_VERSION,
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.version,
    generatedAt: generatedAt.toISOString(),
    installMode: resolveExportInstallMode(server),
    stateDirSource,
  };
}

function logContentManifestFields(
  logContent: LogContent,
): Pick<
  ManifestInput,
  | "sourceLogFiles"
  | "truncatedLogFiles"
  | "currentFileTailTruncated"
  | "budgetExceeded"
  | "skippedLogFiles"
> {
  return {
    sourceLogFiles: logContent.sourceLogFiles,
    truncatedLogFiles: logContent.truncatedLogFiles,
    currentFileTailTruncated: logContent.currentFileTailTruncated,
    budgetExceeded: logContent.budgetExceeded,
    skippedLogFiles: logContent.skippedLogFiles,
  };
}

// A missing or unreadable ui.log (no `keiko start` has ever run against this state dir, or a
// permission error) means there is nothing to attach — never a failed export.
function readUiLogContentOrUndefined(stateDir: string): string | undefined {
  try {
    return readFileSync(join(stateDir, UI_LOG_FILE_NAME), "utf8");
  } catch {
    return undefined;
  }
}

// The double-confirmation gate (design doc §6.3): BOTH `--include-ui-log` AND
// `--i-understand-this-is-unredacted` must be present — a single flag is never sufficient consent.
// `excluded` is true whenever the section was NOT attached (gate failed, OR the gate passed but
// there was no content to attach), so the manifest's `sectionsExcluded` can always name "ui-log"
// except in the one case it was genuinely included.
interface UiLogInclusion {
  readonly section: SupportBundleUiLogSection | undefined;
  readonly excluded: boolean;
}

function resolveUiLogInclusion(stateDir: string, args: ExportArgs): UiLogInclusion {
  const consented = args.includeUiLog && args.iUnderstandUnredacted;
  const content = consented ? readUiLogContentOrUndefined(stateDir) : undefined;
  return content === undefined
    ? { section: undefined, excluded: true }
    : { section: buildUiLogSection(content), excluded: false };
}

// A `KEIKO_`-prefixed env name is collected with the prefix fused on, so `redactLogFields`'s
// field-NAME denylist (an exact match on the WHOLE normalized name, `log-redaction.ts`) can never
// fire on it: normalization turns `KEIKO_DEFAULT_API_KEY` into `keikodefaultapikey`, which does
// not equal the denylist's `apikey`/`key` entries. Leaving safety to the generic value-shape
// heuristics alone is not enough either — they do not catch, for example, a hex-only secret (no
// uppercase character, so the high-entropy check never fires) or any other operator-chosen
// credential shape they were never designed to enumerate. This is therefore a second, independent
// gate at the COLLECTION layer: a credential-shaped segment anywhere in the name (split on `_`)
// refuses the field outright, before its value is ever read into the snapshot at all.
const CREDENTIAL_NAME_SEGMENTS = new Set<string>([
  "key",
  "keys",
  "apikey",
  "apikeys",
  "secret",
  "secrets",
  "token",
  "tokens",
  "credential",
  "credentials",
  "password",
  "passwd",
  "pwd",
  "auth",
  "cert",
  "certificate",
]);

function isCredentialShapedEnvName(key: string): boolean {
  return key
    .toLowerCase()
    .split("_")
    .some((segment) => CREDENTIAL_NAME_SEGMENTS.has(segment));
}

// "The resolved runtime configuration" scoped to what this CLI itself resolves from the
// environment — its own `KEIKO_*` vocabulary (KEIKO_STATE_DIR, KEIKO_CONFIG_FILE,
// KEIKO_EVIDENCE_DIR, …) — passed through the server's `redactLogFields` choke point (never a
// second redaction implementation, AGENTS.md §7) before embedding. Always attached, unlike
// ui-log/evidence-manifest, which are opt-in. `isCredentialShapedEnvName` runs first and is not a
// duplicate of that choke point: it refuses a credential-shaped NAME outright, a layer
// `redactLogFields` structurally cannot reach once the prefix has fused the name.
function keikoConfigEnvFields(env: EnvSource): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith("KEIKO_") && value !== undefined && !isCredentialShapedEnvName(key)) {
      fields[key] = value;
    }
  }
  return fields;
}

function resolveConfigSnapshotSection(
  env: EnvSource,
  server: Awaited<ReturnType<typeof loadServer>>,
): SupportBundleConfigSnapshotSection {
  return buildConfigSnapshotSection(server.redactLogFields(keikoConfigEnvFields(env)) ?? {});
}

// Attaches the FULL EvidenceStore manifest for each `--include-evidence` runId, beyond the
// index-only `evidenceIndexCount` summary Wave 1 already carries — deep replay. A runId that does
// not resolve (never used from this state dir, or an unreadable/malformed manifest) contributes no
// section; this never fails the export, the same "count, don't fail" discipline
// `resolveEvidenceIndexCount` already uses.
async function resolveIncludedEvidenceSections(
  evidenceDir: string,
  runIds: readonly string[],
  deps: SupportCliDeps,
): Promise<readonly SupportBundleEvidenceManifestSection[]> {
  if (runIds.length === 0) return [];
  try {
    const evidence = await loadEvidence();
    const store = deps.evidenceStore ?? evidence.createNodeEvidenceStore(evidenceDir);
    const sections: SupportBundleEvidenceManifestSection[] = [];
    for (const runId of runIds) {
      const manifest = evidence.loadEvidence(store, runId);
      if (manifest !== undefined) sections.push(buildEvidenceManifestSection(runId, manifest));
    }
    return sections;
  } catch {
    return [];
  }
}

// Assembles every Wave 6 `$section` record in the bundle's fixed order: config-snapshot (always),
// then each requested evidence-manifest, then ui-log last (when its gate passed) — content
// verbatim, so it sits closest to the raw log lines that follow it.
function assembleWave6Sections(
  env: EnvSource,
  server: Awaited<ReturnType<typeof loadServer>>,
  uiLog: UiLogInclusion,
  evidenceSections: readonly SupportBundleEvidenceManifestSection[],
): readonly unknown[] {
  const configSnapshot = resolveConfigSnapshotSection(env, server);
  return uiLog.section === undefined
    ? [configSnapshot, ...evidenceSections]
    : [configSnapshot, ...evidenceSections, uiLog.section];
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
  const uiLog = resolveUiLogInclusion(stateDir, args);
  const evidenceSections = await resolveIncludedEvidenceSections(
    evidenceDir,
    args.includeEvidenceRunIds,
    deps,
  );
  const generatedAtDate = now();
  const manifest = buildSupportBundleManifest({
    ...processProvenance(server, generatedAtDate, stateDirSource),
    ...logContentManifestFields(logContent),
    auditSummary,
    evidenceIndexCount,
    storeFingerprints: storeFingerprintCollection.fingerprints,
    storesUnavailable: storeFingerprintCollection.unavailable,
    sectionsExcluded: uiLog.excluded ? [UI_LOG_SECTION] : [],
  });

  const sections = assembleWave6Sections(env, server, uiLog, evidenceSections);
  const lines = serializeBundleLines(manifest, sections, logContent.contentLines);
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

// Wave 6 (epic #3233 closeout, gap #1) — `--clusters`: a standalone, whole-file view independent
// of --correlation-id (support-analyze.ts's `renderHumanClusters` docstring reserves it for
// exactly this flag). Emits the bare `OpCluster[]` under --json, never nested inside a larger
// envelope, since this is deliberately a focused report, not a slice of the default output.
function emitClusters(clusters: readonly OpCluster[], json: boolean, io: CliIo): number {
  io.out(json ? `${JSON.stringify(clusters)}\n` : renderHumanClusters(clusters));
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

function resolveFixturePath(cwd: string, path: string): string {
  return isAbsolute(path) ? path : resolve(cwd, path);
}

// Fail-closed (disclosed gap #1's fix): never overwrites an existing file — a fixture is meant to
// be hand-edited after generation, and silently clobbering that would destroy real work — and
// creates the parent directory so `--emit-fixture some/new/dir/fixture.ts` does not require the
// operator to `mkdir -p` first. Content-free error reporting, same discipline as
// `writeBundleOrExitCode`: an fs error's message can quote the path it was writing.
function writeFixtureOrExitCode(path: string, contents: string, io: CliIo): number | undefined {
  if (existsSync(path)) {
    io.err(`keiko support analyze: refusing to overwrite existing file: ${path}\n`);
    return 1;
  }
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents, "utf8");
    return undefined;
  } catch (error) {
    io.err(`keiko support analyze: could not write fixture: ${describeErrorKind(error)}\n`);
    return 1;
  }
}

// Writes the `--emit-fixture` file from `seed.gatewayScript`, when present and non-empty. Returns
// undefined (nothing to report) when `--emit-fixture` was not requested; the resolved path on
// success; or an exit code on a genuine failure (no reconstructible script, or a write error).
function emitFixtureIfRequested(
  seed: ReproductionSeed,
  emitFixture: string | undefined,
  correlationId: string,
  cwd: string,
  io: CliIo,
): { readonly path: string } | { readonly exitCode: number } | undefined {
  if (emitFixture === undefined) return undefined;
  const fixtureText =
    seed.gatewayScript === undefined
      ? undefined
      : renderGatewayReplayScriptFixture(seed.gatewayScript);
  if (fixtureText === undefined) {
    io.err(
      `keiko support analyze: no gateway replay script to write for correlationId=${correlationId}\n`,
    );
    return { exitCode: 1 };
  }
  const path = resolveFixturePath(cwd, emitFixture);
  const failureCode = writeFixtureOrExitCode(path, fixtureText, io);
  return failureCode === undefined ? { path } : { exitCode: failureCode };
}

// `--emit-fixture` given without `--seed`: nothing to print but the write itself, kept in the
// same JSON-vs-text discipline as every other emit* helper here.
function reportFixtureOnly(fixturePath: string | undefined, json: boolean, io: CliIo): void {
  if (fixturePath === undefined) return;
  io.out(json ? `${JSON.stringify({ fixturePath })}\n` : `Wrote fixture to ${fixturePath}\n`);
}

// `--seed`: prints the seed itself, with `fixturePath` folded into the same JSON object when a
// fixture was also written (so --json stays a single JSON object, never two), or a trailing
// confirmation line in human mode.
function emitSeedResult(
  seed: ReproductionSeed,
  fixturePath: string | undefined,
  json: boolean,
  io: CliIo,
): void {
  if (json) {
    const payload = fixturePath === undefined ? seed : { ...seed, fixturePath };
    io.out(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  io.out(renderHumanReproductionSeed(seed));
  if (fixturePath !== undefined) io.out(`Wrote fixture to ${fixturePath}\n`);
}

// `--seed` / `--emit-fixture` (both require --correlation-id, enforced by `parseAnalyzeArgs`):
// builds one `ReproductionSeed`, optionally writes the fixture derived from its `gatewayScript`,
// then reports according to which of the two flags were actually requested.
function runSeedAndFixture(text: string, args: AnalyzeArgs, cwd: string, io: CliIo): number {
  const correlationId = args.correlationId;
  if (correlationId === undefined) {
    // Unreachable in practice: parseAnalyzeArgs rejects --seed/--emit-fixture without
    // --correlation-id before this function is ever called. Guarded so this function's own
    // string-typed correlationId use stays honest rather than relying on an external invariant.
    io.err(`keiko support analyze: --seed/--emit-fixture require --correlation-id.\n${USAGE}`);
    return 2;
  }
  const seed = buildReproductionSeed(text, correlationId, new Date());
  if (seed === undefined) return reportMissingCorrelationId(correlationId, io);

  const fixtureOutcome = emitFixtureIfRequested(seed, args.emitFixture, correlationId, cwd, io);
  if (fixtureOutcome !== undefined && "exitCode" in fixtureOutcome) return fixtureOutcome.exitCode;
  const fixturePath = fixtureOutcome?.path;

  if (args.seed) {
    emitSeedResult(seed, fixturePath, args.json, io);
  } else {
    reportFixtureOnly(fixturePath, args.json, io);
  }
  return 0;
}

function runSupportAnalyze(args: AnalyzeArgs, io: CliIo, deps: SupportCliDeps): number {
  const cwd = deps.cwd ?? process.cwd();
  const filePath = isAbsolute(args.file) ? args.file : resolve(cwd, args.file);
  const text = readAnalyzeSource(filePath, io);
  if (typeof text === "number") return text;

  if (args.clusters) {
    return emitClusters(analyzeLogText(text).clusters, args.json, io);
  }
  if (args.seed || args.emitFixture !== undefined) {
    return runSeedAndFixture(text, args, cwd, io);
  }

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
