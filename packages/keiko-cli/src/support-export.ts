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

function toLogFileInfo(logsDir: string, name: string): LogFileInfo {
  const path = join(logsDir, name);
  return { name, path, sizeBytes: statSync(path).size };
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

// Lists the rotated + current server*.log files, oldest rotated file first, current file last —
// exactly the order they are copied into the bundle. A missing logs directory (a state dir that
// predates any server run, or one the operator moved) yields an empty list rather than throwing:
// the bundle is still worth producing, just without log content.
export function discoverServerLogFiles(logsDir: string): readonly LogFileInfo[] {
  let names: readonly string[];
  try {
    names = readdirSync(logsDir);
  } catch {
    return [];
  }
  const ordered = names.includes(CURRENT_LOG_FILE_NAME)
    ? [...sortedRotatedNames(names), CURRENT_LOG_FILE_NAME]
    : sortedRotatedNames(names);
  return ordered.map((name) => toLogFileInfo(logsDir, name));
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
  // Always empty in this minimal version: ui.log gating and evidence/config-snapshot sections are
  // Wave 6 features, so nothing is yet excluded that this manifest could name.
  readonly sectionsExcluded: readonly string[];
  readonly auditSummary: RedactedAuditSummary;
  readonly evidenceIndexCount: number;
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
  readonly auditSummary: AuditResult;
  readonly evidenceIndexCount: number;
}

export function buildSupportBundleManifest(input: ManifestInput): SupportBundleManifest {
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
    sectionsExcluded: [],
    auditSummary: redactedAuditSummary(input.auditSummary),
    evidenceIndexCount: input.evidenceIndexCount,
  };
}

// Line 1 (the manifest) plus one verbatim line per kept log file, in file order. Never touches an
// already-copied line's bytes.
export function serializeBundleLines(
  manifest: SupportBundleManifest,
  keptFiles: readonly LogFileInfo[],
): readonly string[] {
  const lines: string[] = [JSON.stringify(manifest)];
  for (const file of keptFiles) {
    lines.push(...readVerbatimLogLines(file.path));
  }
  return lines;
}

// Joins lines with a single trailing newline, the same shape server-log.ts's own file sink writes
// (one JSON object per line) so a bundle round-trips through the same line-splitting convention
// this module's own reader (and support-analyze.ts) uses.
export function bundleText(lines: readonly string[]): string {
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}
