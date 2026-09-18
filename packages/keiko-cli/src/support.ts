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

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir as defaultHomedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
  activityLogEvent,
  defineActivityLogOperation,
  type ActivityLogErrorKind,
  type ActivityLogFields,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { KEIKO_PRODUCT_VERSION } from "@oscharko-dev/keiko-contracts/runtime/version";
import type { EvidenceStore } from "@oscharko-dev/keiko-evidence";
import type { EnvSource } from "@oscharko-dev/keiko-model-gateway";
import { emitSecurityLogEvent, securityErrorKind } from "@oscharko-dev/keiko-security";
import {
  acknowledgeSafeArtifactFileSet,
  isSafeArtifactClass,
  isSafeArtifactFailureKind,
  publishSafeArtifactFileSet,
  recoverSafeArtifactFileSet,
  safeArtifactPublicationSlot,
  type SafeArtifactClass,
  type SafeArtifactFileFailureKind,
  type SafeArtifactPublicationResult,
} from "@oscharko-dev/keiko-security/fs-hardening";
import { type AuditCliDeps, AuditLoadError, auditLocalStateResult } from "./audit.js";
// KEIKO-0655: shared argv-parsing helper replaces the byte-identical flagValue copy this file held.
import { flagValue } from "./cli-arg-parsing.js";
import {
  cliControlStateConflictsWithTarget,
  cliTargetIdentitySha256,
  resolveCliControlStateDir,
} from "./cli-control-state.js";
import {
  installLayoutOverrideEvidence,
  writeInstallLayoutOverrideEvidenceWithFactory,
} from "./install-layout.js";
// GEN-PERF-CLI-001 — the evidence graph (and, below, the server module graph) load at dispatch,
// and only for `export`; tool-lifecycle analysis lazily loads its narrow validator subpath. Store-fingerprint collection (ui,
// local-knowledge, memory-vault) is owned by keiko-server (ADR-0019 direction rule 7: keiko-cli
// is a leaf consumer and must not import keiko-local-knowledge directly) and reached through the
// same lazily-loaded server module, via `server.collectStoreFingerprints`.
import { loadEvidence, loadServer, loadToolLifecycle } from "./lazy-modules.js";
import type { CliIo } from "./runner.js";
import { createCliSecurityLogSink, type CliSecurityLogSinkFactory } from "./security-log.js";
import { inspectStateRoot, resolveStateDir } from "./state-paths.js";
import {
  analyzeLogText,
  buildReproductionSeed,
  findTimeline,
  hasIssueToPrJourneyOps,
  renderGatewayReplayScriptFixture,
  renderHumanAllTimelines,
  renderHumanClusters,
  renderHumanReproductionSeed,
  renderHumanTimeline,
  type AnalyzeAllResult,
  type ProcessSummary,
  type SourceKind,
  type SupportAnalyzeOptions,
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
  CURRENT_LOG_FILE_NAME,
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
Publication exclusively creates the report and sidecar and never replaces an existing destination.
If a process stops mid-publication, rerun the same explicit --out command; for the default output,
rerun from the same working directory. Keiko recovers the durable prior bytes before taking a new
clock or log snapshot, or fails closed when the bounded recovery slot conflicts.

<state-dir>/ui.log (the UI/BFF process's raw, unredacted stdout+stderr) is excluded by default and
always named in the manifest's sectionsExcluded — attaching it requires BOTH --include-ui-log AND
--i-understand-this-is-unredacted; either flag alone still excludes it. --include-evidence attaches
the FULL EvidenceStore manifest for each listed runId (beyond the index-only summary above) for
deep replay; a runId that does not exist under --state-dir contributes no section.

analyze reads FILE (a support bundle or a raw server.log — auto-detected), groups its lines by
correlationId, and prints one reconstructed timeline per id. Each process lifetime is ordered by
seq; lifetimes are ordered by the position of their first line in the file, because the log
envelope promises no order across processes. The default and per-correlation reports identify the
resolved input file, an inferable raw-log state directory, newest valid event and instance, and
whether the raw log is current and apparently active. A raw log more than five minutes behind the
analysis clock is reported as stale; bundles are historical artifacts and are never presented as
live processes.
--correlation-id narrows to a single id; --json emits the machine-readable form. --clusters prints
a whole-file view of every parsed line grouped by (category, op, errorKind), independent of
--correlation-id: a count and up to 5 sample correlation ids per group. --seed (requires
--correlation-id) prints a ReproductionSeed — a gatewayScript/httpRequest/storeFingerprint/
indexingJob/issueToPrJourney/stackFrames/causeChain reconstruction for that one correlationId, plus
a warnings field naming exactly what could not be reconstructed and why. --emit-fixture PATH (requires
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
  /** Test seam for determining whether the newest raw-log process still exists. */
  readonly processIsRunning?: ((pid: number) => boolean) | undefined;
  readonly activityLogSinkFactory?: CliSecurityLogSinkFactory | undefined;
  readonly controlActivityStateDir?: string | undefined;
  readonly homedir?: (() => string) | undefined;
  readonly platform?: NodeJS.Platform | undefined;
}

type SupportLogFreshness = "current" | "stale" | "unknown";
type SupportProcessActivity = "apparently-active" | "inactive" | "unknown" | "not-applicable";

interface SupportAnalysisContext {
  readonly sourceKind: SourceKind;
  readonly inputFile: string;
  readonly stateDir?: string | undefined;
  readonly latestTimestamp?: string | undefined;
  readonly latestInstanceId?: string | undefined;
  readonly freshness: SupportLogFreshness;
  readonly processActivity: SupportProcessActivity;
}

interface SupportAnalysisReport extends AnalyzeAllResult {
  readonly analysisContext: SupportAnalysisContext;
}

interface Assessment<T> {
  readonly value: T;
  readonly warning?: string | undefined;
}

const CLI_SUPPORT_EXPORT_FAILED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "cli.support.export.failed",
  category: "diagnostic",
  owner: "keiko-cli",
  emitter: "support.emitSupportInstallLayoutRefusal",
  fields: {
    reason: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["unsafe-state-root", "activity-log-unavailable", "state-root-validation-failed"],
    },
    targetSha256: { type: "string", dataClass: "digest", required: true, maxLength: 64 },
    failureKind: { type: "string", dataClass: "error-kind", required: true, maxLength: 64 },
  },
  causal: "correlation",
  lifecycle: "failure",
  analyzerProjection: "failure-cluster",
  failureClasses: ["cli-support-export"],
  proofIds: ["cli.support.export.install-layout-refusal"],
  releaseImpact: "patch",
});

type SupportInstallLayoutFailureReason =
  "unsafe-state-root" | "activity-log-unavailable" | "state-root-validation-failed";

interface SupportRefusalContext {
  readonly stateDir: string;
  readonly controlStateDir: string;
  readonly correlationId: string;
  readonly factory: CliSecurityLogSinkFactory | undefined;
}

function emitSupportInstallLayoutRefusal(
  context: SupportRefusalContext,
  failureKind: string,
  reason: SupportInstallLayoutFailureReason,
): void {
  try {
    if (cliControlStateConflictsWithTarget(context.controlStateDir, context.stateDir)) return;
  } catch {
    return;
  }
  const sink = createCliSecurityLogSink(
    context.controlStateDir,
    context.factory,
    context.correlationId,
  );
  emitSecurityLogEvent(
    sink,
    activityLogEvent(
      CLI_SUPPORT_EXPORT_FAILED_OPERATION,
      {
        level: "error",
        correlationId: context.correlationId,
        errorKind: reason === "unsafe-state-root" ? "unsafe-target" : "unavailable",
      },
      {
        reason,
        targetSha256: cliTargetIdentitySha256(context.stateDir),
        failureKind,
      },
    ),
  );
}

function refuseSupportInstallLayout(
  context: SupportRefusalContext,
  failureKind: string,
  reason: SupportInstallLayoutFailureReason,
): "refused" {
  emitSupportInstallLayoutRefusal(context, failureKind, reason);
  return "refused";
}

function writeSupportInstallLayoutEvidence(
  stateDir: string,
  env: EnvSource,
  deps: SupportCliDeps,
): "ready" | "refused" {
  const evidence = installLayoutOverrideEvidence(env);
  if (evidence === undefined) return "ready";
  const controlStateDir =
    deps.controlActivityStateDir ??
    resolveCliControlStateDir(
      deps.platform ?? process.platform,
      (deps.homedir ?? defaultHomedir)(),
    );
  const context: SupportRefusalContext = {
    stateDir,
    controlStateDir,
    correlationId: evidence.correlationId,
    factory: deps.activityLogSinkFactory,
  };
  try {
    const stateRoot = inspectStateRoot(stateDir);
    if (stateRoot.status === "symlink") {
      return refuseSupportInstallLayout(
        context,
        "SupportStateRootSymlinkError",
        "unsafe-state-root",
      );
    }
    if (stateRoot.status === "not-directory") {
      return refuseSupportInstallLayout(
        context,
        "SupportStateRootNotDirectoryError",
        "unsafe-state-root",
      );
    }
    return writeInstallLayoutOverrideEvidenceWithFactory(deps.activityLogSinkFactory, stateDir, env)
      ? "ready"
      : refuseSupportInstallLayout(
          context,
          "SupportActivityLogUnavailableError",
          "activity-log-unavailable",
        );
  } catch (error) {
    return refuseSupportInstallLayout(
      context,
      securityErrorKind(error),
      "state-root-validation-failed",
    );
  }
}

function prepareSupportInstallLayoutEvidence(
  stateDir: string,
  env: EnvSource,
  deps: SupportCliDeps,
  io: CliIo,
): boolean {
  if (writeSupportInstallLayoutEvidence(stateDir, env, deps) === "ready") return true;
  io.err(
    "keiko support export: refusing to consume a normalized install path because durable " +
      "activity logging is unavailable.\n",
  );
  return false;
}

const SUPPORT_LOG_STALE_AFTER_MS = 5 * 60_000;
const SERVER_LOG_FILE_PATTERN = /^server(?:-\d{4}-\d{2}-\d{2})?\.log$/;

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

export function resolveOutPath(cwd: string, outArg: string | undefined, generatedAt: Date): string {
  const value = outArg ?? defaultOutFileName(generatedAt);
  return isAbsolute(value) ? value : resolve(cwd, value);
}

function supportDestinationCollidesWithActivityLog(
  cwd: string,
  stateDir: string,
  outArg: string | undefined,
): boolean {
  if (outArg === undefined) return false;
  return resolve(cwd, outArg) === resolve(stateDir, "logs", CURRENT_LOG_FILE_NAME);
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
  readonly terminalFragment: boolean;
  readonly sourceLogFiles: readonly string[];
  readonly truncatedLogFiles: readonly string[];
  readonly currentFileTailTruncated: CurrentFileTailTruncated | undefined;
  readonly budgetExceeded: boolean;
  readonly skippedLogFiles: readonly SkippedLogFile[];
}

// Discovers, budget-selects, and reads the state dir's server*.log files in one pass, tolerating
// concurrent removal of the current file or a compatible legacy archive at both boundaries
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
    terminalFragment: read.terminalFragment,
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
// over the EXACT report bytes. A crash can leave a bounded, intent-owned partial publication;
// the next invocation recovers those original bytes before reading a new clock or log snapshot.
type BundlePublicationOutcome =
  | {
      readonly status: "published";
      readonly result: SafeArtifactPublicationResult;
      readonly reportBytes: number;
      readonly reportSha256: string;
      readonly recoveryState: "none" | "rolled-back";
    }
  | {
      readonly status: "recovered";
      readonly result: SafeArtifactPublicationResult & {
        readonly status: "recovered";
        readonly commitPath: string;
      };
      readonly reportBytes: number;
      readonly reportSha256: string;
      readonly recoveryState: "recovered";
    }
  | {
      readonly status: "failed";
      readonly errorKind: SafeArtifactFileFailureKind | "unknown";
      readonly failedArtifactClass: SupportFailedArtifactClass;
      readonly recoveryState: "conflict" | "none" | "rolled-back";
    };

type CompletedBundlePublicationOutcome = Extract<
  BundlePublicationOutcome,
  { readonly status: "published" | "recovered" }
>;

interface AcknowledgementFailedOutcome {
  readonly status: "acknowledgement-failed";
  readonly errorKind: SafeArtifactFileFailureKind | "unknown";
  readonly publication: CompletedBundlePublicationOutcome;
}

interface RolledBackRecoveryOutcome {
  readonly status: "rolled-back";
  readonly recoveryState: "rolled-back";
}

type SupportFailedArtifactClass = "support-report" | "integrity-artifact" | "manifest";

function safeArtifactFailureRecord(error: unknown):
  | {
      readonly artifactClass: SafeArtifactClass;
      readonly kind: SafeArtifactFileFailureKind;
    }
  | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const artifactClass: unknown = Reflect.get(error, "artifactClass");
  const kind: unknown = Reflect.get(error, "kind");
  if (!isSafeArtifactClass(artifactClass) || !isSafeArtifactFailureKind(kind)) return undefined;
  return { artifactClass, kind };
}

type SupportPublicationEvidenceOutcome =
  BundlePublicationOutcome | AcknowledgementFailedOutcome | RolledBackRecoveryOutcome;

export function supportPublicationErrorKind(
  error: unknown,
): SafeArtifactFileFailureKind | "unknown" {
  try {
    return safeArtifactFailureRecord(error)?.kind ?? "unknown";
  } catch {
    return "unknown";
  }
}

function supportPublicationFailure(
  error: unknown,
): Pick<
  Extract<BundlePublicationOutcome, { readonly status: "failed" }>,
  "errorKind" | "failedArtifactClass"
> {
  try {
    const failure = safeArtifactFailureRecord(error);
    if (failure !== undefined) {
      const failedArtifactClass =
        failure.artifactClass === "integrity-artifact" || failure.artifactClass === "manifest"
          ? failure.artifactClass
          : "support-report";
      return { errorKind: failure.kind, failedArtifactClass };
    }
  } catch {
    return { errorKind: "unknown", failedArtifactClass: "support-report" };
  }
  return { errorKind: "unknown", failedArtifactClass: "support-report" };
}

interface SupportPublicationContext {
  readonly root: string;
  readonly slot: string;
}

export function supportPublicationContext(
  cwd: string,
  outArg: string | undefined,
): SupportPublicationContext {
  const explicitPath = outArg === undefined ? undefined : resolve(cwd, outArg);
  const root = explicitPath === undefined ? resolve(cwd) : dirname(explicitPath);
  const namespace =
    explicitPath === undefined ? "support-export/default" : "support-export/explicit";
  return { root, slot: safeArtifactPublicationSlot(namespace, explicitPath ?? root) };
}

function publishSupportBundle(
  outPath: string,
  contents: string,
  io: CliIo,
  context: SupportPublicationContext,
  recoveryState: "none" | "rolled-back",
): BundlePublicationOutcome {
  const reportSha256 = bundleSha256Hex(contents);
  try {
    const result = publishSafeArtifactFileSet(
      [
        { path: outPath, contents, artifactClass: "support-report" },
        {
          path: sha256SidecarPath(outPath),
          contents: `${reportSha256}\n`,
          artifactClass: "integrity-artifact",
        },
      ],
      {
        commitPath: outPath,
        publicationSlot: context.slot,
        trustedRoot: context.root,
      },
    );
    return {
      status: "published",
      result,
      reportBytes: Buffer.byteLength(contents),
      reportSha256,
      recoveryState,
    };
  } catch (error) {
    const failure = supportPublicationFailure(error);
    const { errorKind } = failure;
    io.err(`keiko support export: could not write the bundle: ${errorKind}\n`);
    return { status: "failed", ...failure, recoveryState };
  }
}

type SupportRecoveryOutcome =
  | { readonly status: "none" }
  | RolledBackRecoveryOutcome
  | Extract<BundlePublicationOutcome, { readonly status: "recovered" | "failed" }>;

function recoverSupportBundle(
  context: SupportPublicationContext,
  io: CliIo,
): SupportRecoveryOutcome {
  try {
    const result = recoverSafeArtifactFileSet({
      publicationSlot: context.slot,
      trustedRoot: context.root,
    });
    if (result.status === "rolled-back") {
      return { status: "rolled-back", recoveryState: "rolled-back" };
    }
    if (result.status !== "recovered") return { status: "none" };
    return {
      status: "recovered",
      result,
      reportBytes: result.commitByteCount,
      reportSha256: result.commitSha256,
      recoveryState: "recovered",
    };
  } catch (error) {
    const failure = supportPublicationFailure(error);
    const { errorKind } = failure;
    io.err(`keiko support export: could not recover the prior publication: ${errorKind}\n`);
    return { status: "failed", ...failure, recoveryState: "conflict" };
  }
}

function acknowledgeSupportPublication(
  context: SupportPublicationContext,
  io: CliIo,
): SafeArtifactFileFailureKind | "unknown" | undefined {
  try {
    acknowledgeSafeArtifactFileSet({
      publicationSlot: context.slot,
      trustedRoot: context.root,
    });
    return undefined;
  } catch (error) {
    const errorKind = supportPublicationErrorKind(error);
    io.err(`keiko support export: could not acknowledge publication: ${errorKind}\n`);
    return errorKind;
  }
}

type LoadedServer = Awaited<ReturnType<typeof loadServer>>;

const SUPPORT_EXPORT_PUBLICATION_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "support.export.publication",
  category: "diagnostic",
  owner: "keiko-cli",
  emitter: "support.emitSupportPublicationEvidence",
  fields: {
    publicationArtifactClass: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["support-report"],
    },
    artifactCount: { type: "integer", dataClass: "count", required: true },
    visibleArtifactCount: { type: "integer", dataClass: "count", required: false },
    persistenceStatus: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["published", "recovered", "rolled-back", "acknowledgement-failed", "failed"],
    },
    publicationPersistenceStatus: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["published", "recovered", "rolled-back", "acknowledgement-failed", "failed"],
    },
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    publicationCompleteness: {
      type: "string",
      dataClass: "completeness-state",
      required: true,
    },
    loss: { type: "string", dataClass: "loss-state", required: true },
    publicationLoss: { type: "string", dataClass: "loss-state", required: true },
    recoveryState: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["none", "rolled-back", "recovered", "conflict"],
    },
    publicationStatus: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["published", "recovered"],
    },
    permissionAssurance: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["verified-private", "platform-inherited"],
    },
    durabilityAssurance: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["verified", "directory-sync-unavailable"],
    },
    reportBytes: { type: "integer", dataClass: "count", required: false },
    reportSha256: {
      type: "string",
      dataClass: "digest",
      required: false,
      maxLength: 64,
    },
    receiptState: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["consumed", "acknowledgement-uncertain", "unknown"],
    },
    failedArtifactClass: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["support-report", "integrity-artifact", "manifest"],
    },
    failureKind: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: [
        "invalid-publication",
        "close-failed",
        "durability-failed",
        "open-failed",
        "permission-failed",
        "permission-unsafe",
        "publish-failed",
        "publish-unsupported",
        "read-failed",
        "recovery-conflict",
        "replace-failed",
        "target-exists",
        "target-mutated",
        "unsafe-ancestor",
        "unsafe-target",
        "write-failed",
        "unknown",
      ],
    },
  },
  causal: "correlation",
  lifecycle: "end",
  analyzerProjection: "capability",
  failureClasses: ["support-publication", "support-publication-acknowledgement"],
  proofIds: ["support.export.publication-evidence", "support.export.commit-last"],
  releaseImpact: "patch",
});

const SUPPORT_ANALYZE_CLASSIFICATION_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "support.analyze.classified",
  category: "diagnostic",
  owner: "keiko-cli",
  emitter: "support.emitSupportAnalysisEvidence",
  fields: {
    sourceKind: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["bundle", "raw-log"],
    },
    evidenceClassification: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["supported", "legacy", "unsupported", "corrupt", "truncated", "incomplete"],
    },
    supportedLineCount: { type: "integer", dataClass: "count", required: true },
    legacyLineCount: { type: "integer", dataClass: "count", required: true },
    unsupportedLineCount: { type: "integer", dataClass: "count", required: true },
    corruptLineCount: { type: "integer", dataClass: "count", required: true },
    truncatedLineCount: { type: "integer", dataClass: "count", required: true },
    incompleteLineCount: { type: "integer", dataClass: "count", required: true },
    sequenceAnomalyCount: { type: "integer", dataClass: "count", required: true },
    malformedLineCount: { type: "integer", dataClass: "count", required: true },
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
  },
  causal: "correlation",
  lifecycle: "end",
  analyzerProjection: "capability",
  failureClasses: ["support-analysis"],
  proofIds: ["support.analyze.classification-evidence"],
  releaseImpact: "patch",
});

type SupportPublicationEvidenceFields = ActivityLogFields<
  typeof SUPPORT_EXPORT_PUBLICATION_OPERATION
>;

function completedPublicationEvidenceFields(
  publication: CompletedBundlePublicationOutcome,
  persistenceStatus: "published" | "recovered" | "acknowledgement-failed",
  receiptState: "consumed" | "acknowledgement-uncertain",
): SupportPublicationEvidenceFields {
  return {
    publicationArtifactClass: "support-report",
    artifactCount: 2,
    visibleArtifactCount: 2,
    persistenceStatus,
    publicationPersistenceStatus: persistenceStatus,
    completeness: "complete",
    publicationCompleteness: "complete",
    loss: "none",
    publicationLoss: "none",
    recoveryState: publication.recoveryState,
    publicationStatus: publication.result.status,
    permissionAssurance: publication.result.permissionAssurance,
    durabilityAssurance: publication.result.durabilityAssurance,
    reportBytes: publication.reportBytes,
    reportSha256: publication.reportSha256,
    receiptState,
  };
}

function failedPublicationEvidenceFields(
  outcome: Extract<BundlePublicationOutcome, { readonly status: "failed" }>,
): SupportPublicationEvidenceFields {
  return {
    publicationArtifactClass: "support-report",
    artifactCount: 2,
    persistenceStatus: "failed",
    publicationPersistenceStatus: "failed",
    completeness: "unknown",
    publicationCompleteness: "unknown",
    loss: "publication-unavailable",
    publicationLoss: "publication-unavailable",
    recoveryState: outcome.recoveryState,
    receiptState: "unknown",
    failedArtifactClass: outcome.failedArtifactClass,
    failureKind: outcome.errorKind,
  };
}

function supportPublicationActivityErrorKind(
  failure: SafeArtifactFileFailureKind | "unknown",
): ActivityLogErrorKind {
  switch (failure) {
    case "invalid-publication":
      return "validation-failed";
    case "permission-failed":
      return "permission-denied";
    case "permission-unsafe":
    case "unsafe-ancestor":
      return "unsafe-target";
    case "publish-failed":
    case "replace-failed":
      return "write-failed";
    case "recovery-conflict":
      return "conflict";
    case "close-failed":
      return "durability-failed";
    default:
      return failure;
  }
}

function emitSupportPublicationEvidence(
  server: LoadedServer,
  stateDir: string,
  correlationId: string,
  outcome: SupportPublicationEvidenceOutcome,
): void {
  const activityLog = server.createFileServerLogSink(stateDir);
  try {
    if (outcome.status === "rolled-back") {
      writeRolledBackRecovery(activityLog, correlationId, outcome);
      return;
    }
    if (outcome.status === "acknowledgement-failed") {
      writeAcknowledgementFailure(activityLog, correlationId, outcome);
      return;
    }
    if (outcome.status !== "failed") {
      writeCompletedPublication(activityLog, correlationId, outcome);
      return;
    }
    writeFailedPublication(activityLog, correlationId, outcome);
  } finally {
    activityLog.close?.();
  }
}

type SupportActivityLog = ReturnType<LoadedServer["createFileServerLogSink"]>;

function emitSupportAnalysisEvidence(
  server: LoadedServer,
  stateDir: string,
  result: AnalyzeAllResult,
): void {
  const activityLog = server.createFileServerLogSink(stateDir);
  try {
    activityLog.write(
      activityLogEvent(
        SUPPORT_ANALYZE_CLASSIFICATION_OPERATION,
        { correlationId: randomUUID() },
        {
          sourceKind: result.sourceKind,
          evidenceClassification: result.evidence.classification,
          supportedLineCount: result.evidence.supportedLineCount,
          legacyLineCount: result.evidence.legacyLineCount,
          unsupportedLineCount: result.evidence.unsupportedLineCount,
          corruptLineCount: result.evidence.corruptLineCount,
          truncatedLineCount: result.evidence.truncatedLineCount,
          incompleteLineCount: result.evidence.incompleteLineCount,
          sequenceAnomalyCount: result.evidence.sequenceAnomalies.length,
          malformedLineCount: result.malformedLineCount,
          completeness: "complete",
          loss: "none",
        },
      ),
    );
  } finally {
    activityLog.close?.();
  }
}

function writeRolledBackRecovery(
  activityLog: SupportActivityLog,
  correlationId: string,
  outcome: RolledBackRecoveryOutcome,
): void {
  activityLog.write(
    activityLogEvent(
      SUPPORT_EXPORT_PUBLICATION_OPERATION,
      { correlationId },
      {
        publicationArtifactClass: "support-report",
        artifactCount: 2,
        visibleArtifactCount: 0,
        persistenceStatus: "rolled-back",
        publicationPersistenceStatus: "rolled-back",
        completeness: "complete",
        publicationCompleteness: "complete",
        loss: "none",
        publicationLoss: "none",
        recoveryState: outcome.recoveryState,
        receiptState: "consumed",
      },
    ),
  );
}

function writeAcknowledgementFailure(
  activityLog: SupportActivityLog,
  correlationId: string,
  outcome: AcknowledgementFailedOutcome,
): void {
  activityLog.write(
    activityLogEvent(
      SUPPORT_EXPORT_PUBLICATION_OPERATION,
      {
        level: "error",
        correlationId,
        errorKind: supportPublicationActivityErrorKind(outcome.errorKind),
      },
      {
        ...completedPublicationEvidenceFields(
          outcome.publication,
          "acknowledgement-failed",
          "acknowledgement-uncertain",
        ),
        failedArtifactClass: "manifest",
        failureKind: outcome.errorKind,
      },
    ),
  );
}

function writeCompletedPublication(
  activityLog: SupportActivityLog,
  correlationId: string,
  outcome: CompletedBundlePublicationOutcome,
): void {
  activityLog.write(
    activityLogEvent(
      SUPPORT_EXPORT_PUBLICATION_OPERATION,
      { correlationId },
      completedPublicationEvidenceFields(outcome, outcome.status, "consumed"),
    ),
  );
}

function writeFailedPublication(
  activityLog: SupportActivityLog,
  correlationId: string,
  outcome: Extract<BundlePublicationOutcome, { readonly status: "failed" }>,
): void {
  activityLog.write(
    activityLogEvent(
      SUPPORT_EXPORT_PUBLICATION_OPERATION,
      {
        level: "error",
        correlationId,
        errorKind: supportPublicationActivityErrorKind(outcome.errorKind),
      },
      failedPublicationEvidenceFields(outcome),
    ),
  );
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

async function recoveredSupportExportExitCode(
  recovery: SupportRecoveryOutcome,
  stateDir: string,
  io: CliIo,
  context: SupportPublicationContext,
): Promise<number | undefined> {
  if (recovery.status === "none") return undefined;
  const server = await loadServer();
  if (recovery.status === "rolled-back") {
    emitSupportPublicationEvidence(server, stateDir, randomUUID(), recovery);
    return undefined;
  }
  if (recovery.status === "failed") {
    emitSupportPublicationEvidence(server, stateDir, randomUUID(), recovery);
    return 1;
  }
  return completeSupportPublication(
    recovery,
    server,
    stateDir,
    io,
    context,
    `Recovered support report at ${recovery.result.commitPath}\n`,
  );
}

function completeSupportPublication(
  publication: CompletedBundlePublicationOutcome,
  server: LoadedServer,
  stateDir: string,
  io: CliIo,
  context: SupportPublicationContext,
  successLine: string,
): number {
  const correlationId = randomUUID();
  io.out(successLine);
  const errorKind = acknowledgeSupportPublication(context, io);
  if (errorKind === undefined) {
    emitSupportPublicationEvidence(server, stateDir, correlationId, publication);
    return 0;
  }
  emitSupportPublicationEvidence(server, stateDir, correlationId, {
    status: "acknowledgement-failed",
    errorKind,
    publication,
  });
  return 1;
}

function publishedSupportExportExitCode(
  publication: BundlePublicationOutcome,
  server: LoadedServer,
  stateDir: string,
  lineCount: number,
  outPath: string,
  io: CliIo,
  context: SupportPublicationContext,
): number {
  if (publication.status === "failed") {
    emitSupportPublicationEvidence(server, stateDir, randomUUID(), publication);
    return 1;
  }
  return completeSupportPublication(
    publication,
    server,
    stateDir,
    io,
    context,
    `Wrote ${String(lineCount)} lines to ${outPath}\n`,
  );
}

interface FreshSupportExportContext {
  readonly cwd: string;
  readonly now: () => Date;
  readonly stateDir: string;
  readonly stateDirSource: ReturnType<typeof resolveStateDirSource>;
  readonly publication: SupportPublicationContext;
  readonly recoveryState: "none" | "rolled-back";
}

interface FreshSupportData {
  readonly logContent: LogContent;
  readonly evidenceIndexCount: number;
  readonly server: LoadedServer;
  readonly auditSummary: Awaited<ReturnType<typeof auditLocalStateResult>>;
  readonly stores: Awaited<ReturnType<LoadedServer["collectStoreFingerprints"]>>;
  readonly uiLog: UiLogInclusion;
  readonly evidenceSections: readonly SupportBundleEvidenceManifestSection[];
  readonly generatedAtDate: Date;
}

async function collectFreshSupportData(
  args: ExportArgs,
  io: CliIo,
  env: EnvSource,
  deps: SupportCliDeps,
  context: FreshSupportExportContext,
): Promise<FreshSupportData | number> {
  const logContent = collectLogContent(
    join(context.stateDir, "logs"),
    args.maxBytes ?? DEFAULT_MAX_BUNDLE_BYTES,
  );
  const evidenceDir = env.KEIKO_EVIDENCE_DIR ?? join(context.stateDir, "evidence");
  const evidenceIndexCount = await resolveEvidenceIndexCount(evidenceDir, deps);
  const server = await loadServer();
  try {
    const activityLog = server.createFileServerLogSink(context.stateDir);
    activityLog.close?.();
  } catch (error) {
    io.err(
      `keiko support export: Activity Log unavailable: ${supportPublicationErrorKind(error)}\n`,
    );
    return 1;
  }
  let auditSummary;
  try {
    auditSummary = await auditLocalStateResult(context.stateDir, env, deps.auditDeps ?? {});
  } catch (error) {
    return reportAuditFailure(error, io);
  }
  reportStoreFingerprintProgress(io);
  const stores = await server.collectStoreFingerprints({ stateDir: context.stateDir, env });
  const uiLog = resolveUiLogInclusion(context.stateDir, args);
  const evidenceSections = await resolveIncludedEvidenceSections(
    evidenceDir,
    args.includeEvidenceRunIds,
    deps,
  );
  return {
    logContent,
    evidenceIndexCount,
    server,
    auditSummary,
    stores,
    uiLog,
    evidenceSections,
    generatedAtDate: context.now(),
  };
}

async function publishFreshSupportExport(
  args: ExportArgs,
  io: CliIo,
  env: EnvSource,
  deps: SupportCliDeps,
  context: FreshSupportExportContext,
): Promise<number> {
  const data = await collectFreshSupportData(args, io, env, deps, context);
  if (typeof data === "number") return data;
  const manifest = buildSupportBundleManifest({
    ...processProvenance(data.server, data.generatedAtDate, context.stateDirSource),
    ...logContentManifestFields(data.logContent),
    auditSummary: data.auditSummary,
    evidenceIndexCount: data.evidenceIndexCount,
    storeFingerprints: data.stores.fingerprints,
    storesUnavailable: data.stores.unavailable,
    sectionsExcluded: data.uiLog.excluded ? [UI_LOG_SECTION] : [],
  });
  const sections = assembleWave6Sections(env, data.server, data.uiLog, data.evidenceSections);
  const lines = serializeBundleLines(manifest, sections, data.logContent.contentLines);
  const outPath = resolveOutPath(context.cwd, args.out, data.generatedAtDate);
  const publication = publishSupportBundle(
    outPath,
    bundleText(lines, data.logContent.terminalFragment),
    io,
    context.publication,
    context.recoveryState,
  );
  return publishedSupportExportExitCode(
    publication,
    data.server,
    context.stateDir,
    lines.length,
    outPath,
    io,
    context.publication,
  );
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
  if (!prepareSupportInstallLayoutEvidence(stateDir, env, deps, io)) return 1;
  const stateDirSource = resolveStateDirSource(env, args.stateDir);
  if (supportDestinationCollidesWithActivityLog(cwd, stateDir, args.out)) {
    io.err("keiko support export: destination collides with the Activity Log\n");
    return 1;
  }
  const publicationContext = supportPublicationContext(cwd, args.out);
  const recovery = recoverSupportBundle(publicationContext, io);
  const recoveredExitCode = await recoveredSupportExportExitCode(
    recovery,
    stateDir,
    io,
    publicationContext,
  );
  if (recoveredExitCode !== undefined) return recoveredExitCode;
  if (recovery.status !== "none" && recovery.status !== "rolled-back") return 1;
  return publishFreshSupportExport(args, io, env, deps, {
    cwd,
    now,
    stateDir,
    stateDirSource,
    publication: publicationContext,
    recoveryState: recovery.status,
  });
}

function reportMissingCorrelationId(correlationId: string, io: CliIo): number {
  io.err(`keiko support analyze: no lines found for correlation id: ${correlationId}\n`);
  return 1;
}

function inferAnalyzedStateDir(filePath: string, sourceKind: SourceKind): string | undefined {
  const logDirectory = dirname(filePath);
  return sourceKind === "raw-log" &&
    basename(logDirectory) === "logs" &&
    SERVER_LOG_FILE_PATTERN.test(basename(filePath))
    ? dirname(logDirectory)
    : undefined;
}

function assessFreshness(
  latestTimestamp: string | undefined,
  now: Date,
): Assessment<SupportLogFreshness> {
  if (latestTimestamp === undefined) return { value: "unknown" };
  const latestMs = Date.parse(latestTimestamp);
  const ageMs = now.getTime() - latestMs;
  if (!Number.isFinite(latestMs) || ageMs < -SUPPORT_LOG_STALE_AFTER_MS) {
    return {
      value: "unknown",
      warning: "analyzed log has no credible newest event timestamp",
    };
  }
  return ageMs > SUPPORT_LOG_STALE_AFTER_MS
    ? {
        value: "stale",
        warning: "analyzed log is stale: its newest valid event is older than 5 minutes",
      }
    : { value: "current" };
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === "EPERM";
  }
}

function newestProcess(result: AnalyzeAllResult): ProcessSummary | undefined {
  if (result.latestInstanceId === undefined) return undefined;
  return result.processes.find((candidate) => candidate.instanceId === result.latestInstanceId);
}

function assessProcessActivity(
  result: AnalyzeAllResult,
  freshness: SupportLogFreshness,
  isRunning: (pid: number) => boolean,
): Assessment<SupportProcessActivity> {
  if (result.sourceKind === "bundle") return { value: "not-applicable" };
  if (freshness === "stale") return { value: "inactive" };
  const candidate = newestProcess(result);
  if (candidate === undefined || freshness !== "current") return { value: "unknown" };
  if (candidate.exitReason !== undefined) {
    return {
      value: "inactive",
      warning: "analyzed raw log belongs to a process that recorded its exit",
    };
  }
  if (!Number.isSafeInteger(candidate.pid) || candidate.pid <= 0) {
    return {
      value: "unknown",
      warning: "analyzed raw log declares a non-positive process identifier",
    };
  }
  return isRunning(candidate.pid)
    ? { value: "apparently-active" }
    : {
        value: "inactive",
        warning: "analyzed raw log does not belong to a running process",
      };
}

function buildAnalysisContext(
  result: AnalyzeAllResult,
  filePath: string,
  deps: SupportCliDeps,
): { readonly context: SupportAnalysisContext; readonly warnings: readonly string[] } {
  const freshness = assessFreshness(result.latestTimestamp, deps.now?.() ?? new Date());
  const activity = assessProcessActivity(
    result,
    freshness.value,
    deps.processIsRunning ?? processIsRunning,
  );
  const stateDir = inferAnalyzedStateDir(filePath, result.sourceKind);
  const warnings = [freshness.warning, activity.warning].filter(
    (warning): warning is string => warning !== undefined,
  );
  return {
    context: {
      sourceKind: result.sourceKind,
      inputFile: filePath,
      ...(stateDir === undefined ? {} : { stateDir }),
      ...(result.latestTimestamp === undefined ? {} : { latestTimestamp: result.latestTimestamp }),
      ...(result.latestInstanceId === undefined
        ? {}
        : { latestInstanceId: result.latestInstanceId }),
      freshness: freshness.value,
      processActivity: activity.value,
    },
    warnings,
  };
}

function buildAnalysisReport(
  result: AnalyzeAllResult,
  filePath: string,
  deps: SupportCliDeps,
): SupportAnalysisReport {
  const assessed = buildAnalysisContext(result, filePath, deps);
  return {
    ...result,
    warnings: [...result.warnings, ...assessed.warnings],
    analysisContext: assessed.context,
  };
}

function renderAnalysisContext(context: SupportAnalysisContext): string {
  const lines = [
    `Analyzed log: ${context.inputFile}`,
    `State directory: ${context.stateDir ?? "not inferred from input"}`,
    `Source: ${context.sourceKind}`,
    `Newest event: ${context.latestTimestamp ?? "not reported"}`,
    `Newest instance: ${context.latestInstanceId ?? "not reported"}`,
    `Freshness: ${context.freshness}`,
    `Process activity: ${context.processActivity}`,
  ];
  return `${lines.join("\n")}\n\n`;
}

function emitSingleTimeline(
  timeline: LogTimeline,
  malformedLineCount: number,
  context: SupportAnalysisContext,
  json: boolean,
  io: CliIo,
): number {
  if (json) {
    io.out(`${JSON.stringify({ ...timeline, malformedLineCount, analysisContext: context })}\n`);
  } else {
    io.out(`${renderAnalysisContext(context)}${renderHumanTimeline(timeline)}`);
  }
  return 0;
}

function emitAllTimelines(result: SupportAnalysisReport, json: boolean, io: CliIo): number {
  io.out(
    json
      ? `${JSON.stringify(result)}\n`
      : `${renderAnalysisContext(result.analysisContext)}${renderHumanAllTimelines(result)}`,
  );
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

// Single return statement by design (sonarjs/function-return-type): both arms assign the same
// declared `string | number` union before one trailing return, rather than returning from inside
// each branch, so the function's return shape reads as one type instead of two.
function readAnalyzeSource(filePath: string, io: CliIo): string | number {
  let result: string | number;
  try {
    result = readFileSync(filePath, "utf8");
  } catch (error) {
    // Content-free: an fs error's message can quote the path it was reading (AGENTS.md §7).
    const kind = error instanceof Error ? error.constructor.name : "Error";
    io.err(`keiko support analyze: could not read ${filePath} — ${kind}\n`);
    result = 1;
  }
  return result;
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
function runSeedAndFixture(
  text: string,
  args: AnalyzeArgs,
  cwd: string,
  io: CliIo,
  options: SupportAnalyzeOptions,
): number {
  const correlationId = args.correlationId;
  if (correlationId === undefined) {
    // Unreachable in practice: parseAnalyzeArgs rejects --seed/--emit-fixture without
    // --correlation-id before this function is ever called. Guarded so this function's own
    // string-typed correlationId use stays honest rather than relying on an external invariant.
    io.err(`keiko support analyze: --seed/--emit-fixture require --correlation-id.\n${USAGE}`);
    return 2;
  }
  const seed = buildReproductionSeed(text, correlationId, new Date(), options);
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

function needsToolLifecycleValidator(result: AnalyzeAllResult): boolean {
  return result.timelines.some((timeline) =>
    timeline.lines.some(
      (line) =>
        line.toolCatalog?.kind === "unavailable" ||
        (line.toolCatalog?.kind === "sink-failure" &&
          line.toolCatalog.diagnostics === "unavailable"),
    ),
  );
}

// The tool-lifecycle validator and the redaction re-verifier `hasIssueToPrJourneyOps` needs (epic
// #3384) both live in the same lazily-loaded subpath (`loadToolLifecycle`, GEN-PERF-CLI-001), so
// either need loads it — one module load, not two, for two unrelated consumers of the same seam.
async function loadToolAnalysisOptions(
  result: AnalyzeAllResult,
  io: CliIo,
): Promise<SupportAnalyzeOptions> {
  if (!needsToolLifecycleValidator(result) && !hasIssueToPrJourneyOps(result)) return {};
  try {
    const { validateToolLifecycleEvent, redactLogFields } = await loadToolLifecycle();
    return {
      toolLifecycleValidator: validateToolLifecycleEvent,
      toolDiagnosticRedactor: redactLogFields,
    };
  } catch (error) {
    io.err(
      `keiko support analyze: tool lifecycle validator unavailable — ${describeErrorKind(error)}\n`,
    );
    return {};
  }
}

async function persistSupportAnalysisEvidence(
  result: AnalyzeAllResult,
  cwd: string,
  env: EnvSource,
  io: CliIo,
): Promise<boolean> {
  // Analysis input is immutable evidence. Persist the operator action to the CLI's local Activity
  // Log instead of appending to a raw input file, which may itself end in the crash fragment being
  // diagnosed.
  const stateDir = resolveStateDir(cwd, env);
  try {
    const server = await loadServer();
    emitSupportAnalysisEvidence(server, stateDir, result);
    return true;
  } catch (error) {
    io.err(
      `keiko support analyze: Activity Log unavailable: ${supportPublicationErrorKind(error)}\n`,
    );
    return false;
  }
}

interface AnalyzedSupportResultContext {
  readonly text: string;
  readonly args: AnalyzeArgs;
  readonly cwd: string;
  readonly filePath: string;
  readonly io: CliIo;
  readonly env: EnvSource;
  readonly deps: SupportCliDeps;
  readonly options: SupportAnalyzeOptions;
}

async function emitAnalyzedSupportResult(
  result: AnalyzeAllResult,
  context: AnalyzedSupportResultContext,
): Promise<number> {
  if (!(await persistSupportAnalysisEvidence(result, context.cwd, context.env, context.io)))
    return 1;
  if (context.args.clusters) return emitClusters(result.clusters, context.args.json, context.io);
  if (context.args.seed || context.args.emitFixture !== undefined) {
    return runSeedAndFixture(context.text, context.args, context.cwd, context.io, context.options);
  }
  const report = buildAnalysisReport(result, context.filePath, context.deps);
  if (context.args.correlationId === undefined) {
    return emitAllTimelines(report, context.args.json, context.io);
  }
  const timeline = findTimeline(result, context.args.correlationId);
  if (timeline === undefined) {
    return reportMissingCorrelationId(context.args.correlationId, context.io);
  }
  return emitSingleTimeline(
    timeline,
    result.malformedLineCount,
    report.analysisContext,
    context.args.json,
    context.io,
  );
}

async function runSupportAnalyze(
  args: AnalyzeArgs,
  io: CliIo,
  env: EnvSource,
  deps: SupportCliDeps,
): Promise<number> {
  const cwd = deps.cwd ?? process.cwd();
  const filePath = isAbsolute(args.file) ? args.file : resolve(cwd, args.file);
  const text = readAnalyzeSource(filePath, io);
  if (typeof text === "number") return text;

  const basic = analyzeLogText(text);
  const options = await loadToolAnalysisOptions(basic, io);
  const result =
    options.toolLifecycleValidator === undefined ? basic : analyzeLogText(text, options);
  return emitAnalyzedSupportResult(result, {
    text,
    args,
    cwd,
    filePath,
    io,
    env,
    deps,
    options,
  });
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
  return runSupportAnalyze(parsed.value, io, env, deps);
}
