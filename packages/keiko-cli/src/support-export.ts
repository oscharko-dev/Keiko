// `keiko support export` — pure/synchronous logic for the minimal Wave 1 support bundle
// (design doc "Keiko Activity Log v2", §6.5 Wave 1; ADR-0173 draft). Composes only existing,
// hardened pieces: the caller supplies an `AuditResult` (the same in-process value
// `auditLocalStateResult` in ./audit.ts produces for `keiko audit local-state --json`) and an
// `evidenceIndexCount` (from `listEvidence` in @oscharko-dev/keiko-evidence). NO new redaction
// logic is written here: every server*.log line is already redacted at write time
// (packages/keiko-server/src/observability/server-log.ts's `formatServerLogLine`), so this module
// reads and concatenates raw bytes rather than re-parsing and re-serializing them — re-encoding an
// already-safe line risks introducing exactly the leak the redaction choke point exists to
// prevent, the same "a fixture never re-derives what the producer owns" discipline AGENTS.md §7
// states for formulas, applied here to bytes.
//
// `support.ts` owns argv parsing, stdout/stderr, environment/state-dir resolution, and calling the
// audit/evidence subsystems; this file owns everything that can be exercised without touching
// argv, process.*, or another package's runtime.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { isStoreFingerprint, type StoreFingerprint } from "@oscharko-dev/keiko-contracts";
import type { AuditResult } from "./audit.js";

export const CURRENT_LOG_FILE_NAME = "server.log";

// The sink's own DEFAULT_LOG_RETENTION_DAYS (7) keeps at most a week of rotated files on disk, so
// 50MB is a generous ceiling for a single export; --max-bytes on the CLI overrides it.
export const DEFAULT_MAX_BUNDLE_BYTES = 50 * 1024 * 1024;

// Versions the JSONL bundle FORMAT itself (line 1 is always the manifest; every subsequent line is
// a verbatim log line) — independent of the log envelope's own schema version below.
export const BUNDLE_FORMAT_VERSION = 1;

const ROTATED_LOG_FILE_PATTERN = /^server-(\d{4}-\d{2}-\d{2})\.log$/;

export interface LogFileInfo {
  readonly name: string;
  readonly path: string;
  readonly sizeBytes: number;
}

// A file the export skipped instead of failing for: `name` is relative only (never the absolute
// path an fs error's own message can quote, AGENTS.md §7), and `errorKind` is the one diagnosable
// fact about why — the fs error's `code` (ENOENT, EACCES, EISDIR, EMFILE, …) when it has one, else
// its constructor name. Recording nothing here (as the previous string[] shape did) turned every
// skip into "rotation pruned this file", even when the real cause was a permission error or a
// directory sitting where a log file was expected — a wrong diagnosis for an operator reading the
// bundle.
export interface SkippedLogFile {
  readonly name: string;
  readonly errorKind: string;
}

const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]*$/;

// Identifies an unknown error for redacted diagnostics without ever surfacing its `message` (which
// an fs error uses to quote the absolute path it failed on, AGENTS.md §7): Node's own fs errors
// set a short, all-caps `code` (ENOENT, EACCES, EISDIR, EMFILE, EROFS, …); anything else — no
// `code` at all, or a `code` that is not shaped like one of those short identifiers — falls back to
// the error's own constructor name.
export function describeErrorKind(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && ERROR_CODE_PATTERN.test(code)) return code;
  return error instanceof Error ? error.constructor.name : "Error";
}

// The sink prunes rotated files on its own retention schedule, so a name `readdirSync` just
// returned can already be gone by the time it is `stat`'d — a race, not a failed export. Returns
// the skip (name plus the fs error's diagnosable kind — never its absolute path) so the caller can
// record it and keep going; the export must never fail for one unreadable log file.
function toLogFileInfoOrSkip(
  logsDir: string,
  name: string,
): { readonly info: LogFileInfo } | { readonly skip: SkippedLogFile } {
  const path = join(logsDir, name);
  try {
    return { info: { name, path, sizeBytes: statSync(path).size } };
  } catch (error) {
    return { skip: { name, errorKind: describeErrorKind(error) } };
  }
}

interface RotatedMatch {
  readonly name: string;
  readonly day: string;
}

function rotatedMatchOrUndefined(name: string): RotatedMatch | undefined {
  const match = ROTATED_LOG_FILE_PATTERN.exec(name);
  return match === null ? undefined : { name, day: match[1] ?? "" };
}

function sortedRotatedNames(names: readonly string[]): readonly string[] {
  const matches: RotatedMatch[] = [];
  for (const name of names) {
    const match = rotatedMatchOrUndefined(name);
    if (match !== undefined) matches.push(match);
  }
  // Explicit collator over the ISO day, matching the sink's own rotation pruning: the ordering
  // decides which file is copied first, and "oldest first" is part of the bundle contract.
  matches.sort((a, b) => a.day.localeCompare(b.day, "en-US"));
  return matches.map((m) => m.name);
}

export interface LogFileDiscovery {
  readonly files: readonly LogFileInfo[];
  // Entries `readdirSync` returned but that vanished before they could be `stat`'d — the sink's
  // own rotation/retention pruning racing this scan — named (never `LogFileInfo.path`, which is
  // absolute) alongside the fs error kind that caused the skip, so it can be attested in the
  // bundle manifest and diagnosed by an operator.
  readonly skippedLogFiles: readonly SkippedLogFile[];
}

// Lists the rotated + current server*.log files, oldest rotated file first, current file last —
// exactly the order they are copied into the bundle. A missing logs directory (a state dir that
// predates any server run, or one the operator moved) yields an empty result rather than throwing:
// the bundle is still worth producing, just without log content.
export function discoverServerLogFiles(logsDir: string): LogFileDiscovery {
  let names: readonly string[];
  try {
    names = readdirSync(logsDir);
  } catch {
    return { files: [], skippedLogFiles: [] };
  }
  const ordered = names.includes(CURRENT_LOG_FILE_NAME)
    ? [...sortedRotatedNames(names), CURRENT_LOG_FILE_NAME]
    : sortedRotatedNames(names);
  const files: LogFileInfo[] = [];
  const skippedLogFiles: SkippedLogFile[] = [];
  for (const name of ordered) {
    const lookup = toLogFileInfoOrSkip(logsDir, name);
    if ("info" in lookup) {
      files.push(lookup.info);
    } else {
      skippedLogFiles.push(lookup.skip);
    }
  }
  return { files, skippedLogFiles };
}

export interface LogFileSelection {
  readonly kept: readonly LogFileInfo[];
  readonly truncatedLogFiles: readonly string[];
}

// Drops the OLDEST files first when the combined size would exceed maxBytes, and never drops the
// last (current) file: dropping the most recent evidence instead of the least recent, or dropping
// silently, would defeat the whole point of naming what was truncated. maxBytes bounds the sum of
// the copied log-file bytes only — the one manifest line is a small, roughly-constant addition on
// top of that budget, not subtracted from it.
export function selectLogFilesWithinBudget(
  files: readonly LogFileInfo[],
  maxBytes: number,
): LogFileSelection {
  const kept = [...files];
  const truncatedLogFiles: string[] = [];
  let total = kept.reduce((sum, file) => sum + file.sizeBytes, 0);
  while (total > maxBytes && kept.length > 1) {
    const dropped = kept.shift();
    if (dropped === undefined) break;
    truncatedLogFiles.push(dropped.name);
    total -= dropped.sizeBytes;
  }
  return { kept, truncatedLogFiles };
}

// Splits raw file bytes into lines, dropping only the single empty artifact a trailing newline
// produces — never re-parsing or re-serializing a line, so a re-encoding bug cannot introduce a
// leak into content that is already redacted (AGENTS.md §7).
export function readVerbatimLogLines(path: string): readonly string[] {
  const text = readFileSync(path, "utf8");
  if (text.length === 0) return [];
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

// Same rotation race as `discoverServerLogFiles`, one step later: a name that survived the
// `readdirSync`→`statSync` gap and was kept for the bundle can still vanish before its bytes are
// actually read. The `skip` branch signals that race to the caller (distinct from the legitimate
// `lines: []` an empty-but-present file produces) — with the fs error's diagnosable kind — so the
// file is skipped, not aborted.
function readVerbatimLogLinesOrSkip(
  path: string,
): { readonly lines: readonly string[] } | { readonly skip: string } {
  try {
    return { lines: readVerbatimLogLines(path) };
  } catch (error) {
    return { skip: describeErrorKind(error) };
  }
}

export interface ReadKeptFilesResult {
  readonly contentLines: readonly string[];
  // Relative names only, from `LogFileInfo.name` — never the absolute `LogFileInfo.path`.
  readonly skippedLogFiles: readonly SkippedLogFile[];
}

// Reads every kept log file's bytes verbatim, in file order, tolerating the same
// discover-to-read rotation race `discoverServerLogFiles` guards against one step earlier. A file
// that vanishes here contributes no lines and is skipped, not aborted — recorded by name so the
// manifest can attest to it. Lines are appended one at a time rather than via
// `contentLines.push(...fileLines)`: a spread of a large array as call arguments can throw
// `RangeError: Maximum call stack size exceeded` (observed at ~262k elements on Node v24), and a
// single oversized rotated log file must not abort the whole export.
export function readKeptFiles(keptFiles: readonly LogFileInfo[]): ReadKeptFilesResult {
  const contentLines: string[] = [];
  const skippedLogFiles: SkippedLogFile[] = [];
  for (const file of keptFiles) {
    const lookup = readVerbatimLogLinesOrSkip(file.path);
    if ("lines" in lookup) {
      for (const line of lookup.lines) contentLines.push(line);
    } else {
      skippedLogFiles.push({ name: file.name, errorKind: lookup.skip });
    }
  }
  return { contentLines, skippedLogFiles };
}

// What the manifest is allowed to say about the audit: everything EXCEPT `stateDir`. `AuditResult`
// (audit.ts) echoes back the absolute directory it audited — the exact same value
// `resolveStateDir` computes by default, which embeds the operator's OS username on a real
// machine (e.g. `/Users/jsmith/Projects/my-app/.keiko`). The manifest already carries the safe
// `stateDirSource` closed-union label at the top level for "was this the default or an override",
// so nothing an agent needs is lost by dropping the raw path here too.
export type RedactedAuditSummary = Omit<AuditResult, "stateDir">;

function redactedAuditSummary(audit: AuditResult): RedactedAuditSummary {
  return { ok: audit.ok, classes: audit.classes };
}

// ─── Store fingerprints (Wave 4a, epic #3233 §6.2/§8) ──────────────────────────────────────────
//
// `support.ts` opens each of the three stores (ui, local-knowledge, memory-vault) through that
// store package's genuinely read-only open (`openNodeUiDatabaseReadOnly` /
// `openKnowledgeStoreReadOnly` / `openMemoryDatabaseReadOnly`, `node:sqlite`'s `readOnly: true`) —
// never the mutating production open path, which migrates, recovers, re-encrypts, or quarantines as
// an ordinary part of opening — against the resolved state-dir paths, and calls that store
// package's own `computeStoreFingerprint(db)`. A store that does not exist yet (never used from
// this state dir) or that cannot be opened (corrupt, or a vault key the operator has not supplied)
// contributes no fingerprint — its name and a closed-vocabulary reason go to `storesUnavailable`
// instead, never a path or the underlying error's message.
// `invalid-fingerprint`: the collector handed the exporter an object that fails the contract's
// `isStoreFingerprint` guard. The exporter never embeds such an object — and never drops it
// silently either: a store that disappears from both manifest lists would read as "never used",
// which is the one thing a support bundle must not say about a store that exists.
export type StoreUnavailableReasonKind = "missing" | "open-failed" | "invalid-fingerprint";

export interface StoreUnavailableEntry {
  readonly store: StoreFingerprint["store"];
  readonly reasonKind: StoreUnavailableReasonKind;
}

export interface SupportBundleManifest {
  readonly $section: "manifest";
  readonly schemaVersion: 2;
  readonly bundleFormatVersion: 1;
  readonly productVersion: string;
  readonly platform: string;
  readonly arch: string;
  readonly nodeVersion: string;
  readonly generatedAt: string;
  readonly installMode: string;
  // "cli-flag" collapses into "env-override" for this minimal version — an operator-supplied
  // --state-dir and an operator-supplied KEIKO_STATE_DIR are both "the operator pointed us
  // somewhere other than the default", which is the one distinction Wave 1's manifest makes.
  readonly stateDirSource: "default" | "env-override";
  readonly redactionAttested: true;
  readonly sourceLogFiles: readonly string[];
  readonly truncatedLogFiles: readonly string[];
  // Files a directory listing named but that had vanished (the sink's own rotation/retention
  // pruning) by the time this export tried to size or read them — named (never the files'
  // absolute paths) alongside the fs error kind that caused the skip. Distinct from
  // `truncatedLogFiles`: those were dropped on purpose for the size budget; these were simply gone.
  readonly skippedLogFiles: readonly SkippedLogFile[];
  // Always empty in this minimal version: ui.log gating and evidence/config-snapshot sections are
  // Wave 6 features, so nothing is yet excluded that this manifest could name.
  readonly sectionsExcluded: readonly string[];
  readonly auditSummary: RedactedAuditSummary;
  readonly evidenceIndexCount: number;
  // Wave 4a additions (epic #3233 §6.2/§8), additive over the Wave 1 shape above. A bundle
  // produced by a pre-Wave-4a build simply lacks `storeFingerprints`; `storesUnavailable` is
  // always present once this exporter runs, even when every store fingerprinted cleanly (empty
  // array), so a reader never has to distinguish "not attempted" from "nothing to report".
  readonly storeFingerprints?: readonly StoreFingerprint[];
  readonly storesUnavailable: readonly StoreUnavailableEntry[];
}

export interface ManifestInput {
  // The server activity log's own envelope schema version (`SERVER_LOG_SCHEMA_VERSION`,
  // `packages/keiko-server/src/observability/server-log.ts`). Supplied by the caller — never
  // read here — because this module stays pure/synchronous (this file's header comment) and is
  // exercised in tests without touching argv, process.*, or another package's runtime; `support.ts`
  // (the `keiko support export` command) is the one place allowed to lazily load `keiko-server`
  // (GEN-PERF-CLI-001 — `support analyze` never needs it and must not pay that cost) and passes the
  // real constant through. The literal `2` type is deliberate: if the server ever bumps its own
  // constant, `support.ts`'s call site stops type-checking until this type (and
  // `SupportBundleManifest.schemaVersion` below) is bumped by hand, in lockstep — the same
  // "bumped by hand" invariant the previous hard-coded copy documented only in a comment, now
  // enforced by the type checker instead of trusted to be remembered.
  readonly schemaVersion: 2;
  readonly productVersion: string;
  readonly platform: string;
  readonly arch: string;
  readonly nodeVersion: string;
  readonly generatedAt: string;
  readonly installMode: string;
  readonly stateDirSource: "default" | "env-override";
  readonly sourceLogFiles: readonly string[];
  readonly truncatedLogFiles: readonly string[];
  readonly skippedLogFiles: readonly SkippedLogFile[];
  readonly auditSummary: AuditResult;
  readonly evidenceIndexCount: number;
  readonly storeFingerprints: readonly StoreFingerprint[];
  readonly storesUnavailable: readonly StoreUnavailableEntry[];
}

const KNOWN_STORES: ReadonlySet<string> = new Set(["ui", "local-knowledge", "memory-vault"]);

function knownStoreName(value: unknown): StoreFingerprint["store"] | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const store: unknown = Reflect.get(value, "store");
  return typeof store === "string" && KNOWN_STORES.has(store)
    ? (store as StoreFingerprint["store"])
    : undefined;
}

// Every collected fingerprint either passes the contract guard and is embedded, or is named in
// `storesUnavailable` with `invalid-fingerprint` — never silently dropped. An object that does not
// even carry a known store name cannot be attributed and is the one case that is dropped, counted
// by nothing: the collector's closed `store` union makes it unreachable from production code.
function partitionManifestFingerprints(input: ManifestInput): {
  readonly fingerprints: readonly StoreFingerprint[];
  readonly unavailable: readonly StoreUnavailableEntry[];
} {
  const fingerprints: StoreFingerprint[] = [];
  const unavailable: StoreUnavailableEntry[] = [...input.storesUnavailable];
  for (const candidate of input.storeFingerprints) {
    if (isStoreFingerprint(candidate)) {
      fingerprints.push(candidate);
      continue;
    }
    const store = knownStoreName(candidate);
    if (store !== undefined) unavailable.push({ store, reasonKind: "invalid-fingerprint" });
  }
  return { fingerprints, unavailable };
}

export function buildSupportBundleManifest(input: ManifestInput): SupportBundleManifest {
  const partitioned = partitionManifestFingerprints(input);
  return {
    $section: "manifest",
    schemaVersion: input.schemaVersion,
    bundleFormatVersion: BUNDLE_FORMAT_VERSION,
    productVersion: input.productVersion,
    platform: input.platform,
    arch: input.arch,
    nodeVersion: input.nodeVersion,
    generatedAt: input.generatedAt,
    installMode: input.installMode,
    stateDirSource: input.stateDirSource,
    redactionAttested: true,
    sourceLogFiles: input.sourceLogFiles,
    truncatedLogFiles: input.truncatedLogFiles,
    skippedLogFiles: input.skippedLogFiles,
    sectionsExcluded: [],
    auditSummary: redactedAuditSummary(input.auditSummary),
    evidenceIndexCount: input.evidenceIndexCount,
    // Defense-in-depth (never trust the producer unconditionally, matching this repo's redaction
    // doctrine): re-validated against the same closed structural guard the manifest's own bundle
    // reader would use, so a malformed fingerprint (a future producer bug, a version-skewed
    // dependency) is silently dropped rather than embedded in a customer-facing artifact.
    storeFingerprints: partitioned.fingerprints,
    storesUnavailable: partitioned.unavailable,
  };
}

// Line 1 (the manifest) plus every already-read content line, in file order. The manifest is
// built from `readKeptFiles`'s result (see `support.ts`'s `runSupportExport`) so its
// `sourceLogFiles`/`skippedLogFiles` reflect what was actually read, not merely what was kept
// after the size budget — never touches an already-copied line's bytes.
export function serializeBundleLines(
  manifest: SupportBundleManifest,
  contentLines: readonly string[],
): readonly string[] {
  return [JSON.stringify(manifest), ...contentLines];
}

// Joins lines with a single trailing newline, the same shape server-log.ts's own file sink writes
// (one JSON object per line) so a bundle round-trips through the same line-splitting convention
// this module's own reader (and support-analyze.ts) uses.
export function bundleText(lines: readonly string[]): string {
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}
