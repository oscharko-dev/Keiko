// Bounded, best-effort failure-location extraction (Issue #2211, Epic #2092, ADR-0126 D3). Runs over
// the already-redacted, byte-capped CommandResult output at the one point it is still available
// (orchestrator.toResult, before outputDigest discards it), and produces the structured
// VerificationFailureLocation set the editor problems panel jumps to.
//
// Scope is intentionally ASYMMETRIC across kinds because their default output reliability differs:
//   - typecheck: the tsc default `path(line,col): error TSxxxx: message` format is stable → reliable.
//   - lint:      ESLint's default "stylish" per-file block → best-effort.
//   - test:      vitest's default failure stack frames → best-effort (Keiko does not pin the reporter).
//   - build:     too heterogeneous across the ecosystem → never attempted (always empty).
//
// Any parse failure, ambiguous match, or unrecognized format degrades to an EMPTY array — never a
// thrown error and never a fabricated location. Parsing is line-based (each line bounded by the
// output byte cap), so there is no ReDoS surface. Every result is clamped to the contract caps.

import {
  VERIFICATION_FAILURE_MESSAGE_MAX_CHARS,
  VERIFICATION_MAX_FAILURE_LOCATIONS,
  type VerificationFailureLocation,
  type VerificationKind,
} from "@oscharko-dev/keiko-contracts";
import type { CommandResult } from "@oscharko-dev/keiko-tools";

// A defensive per-line length ceiling: a pathological single line is skipped rather than matched.
const MAX_LINE_LENGTH = 4_096;

// tsc default: "src/a.ts(12,34): error TS2322: Type 'x' is not assignable to type 'y'."
const TSC_DIAGNOSTIC =
  /^(?<file>[^()]+?)\((?<line>\d+),(?<col>\d+)\): (?:error|warning) (?<rule>TS\d+): (?<msg>.*)$/u;
// ESLint stylish row under a bare file-path header line: "  12:34  error  message  rule-id".
const ESLINT_ROW =
  /^\s+(?<line>\d+):(?<col>\d+)\s+(?:error|warning)\s+(?<msg>.+?)(?:\s{2,}(?<rule>[\w@/.-]+))?\s*$/u;
// A bare file-path line preceding ESLint rows (absolute or workspace-relative, no leading space).
const ESLINT_FILE = /^(?<file>[^\s].*\.[cm]?[jt]sx?)$/u;
// vitest default failure stack frame: "❯ src/a.test.ts:12:34" or "at src/a.test.ts:12:34".
const VITEST_FRAME = /(?<file>[^\s()]+\.(?:test|spec)\.[cm]?[jt]sx?):(?<line>\d+):(?<col>\d+)/u;
// A vitest failure title line ("FAIL src/a.test.ts > suite > case", "× case", "✗ case").
const VITEST_TITLE = /^\s*(?:FAIL\b|×|✗|✖)\s*(?<title>.+?)\s*$/u;

function toInt(value: string): number {
  return Number.parseInt(value, 10);
}

function cap(text: string): string {
  return text.length <= VERIFICATION_FAILURE_MESSAGE_MAX_CHARS
    ? text
    : text.slice(0, VERIFICATION_FAILURE_MESSAGE_MAX_CHARS);
}

function extractTsc(lines: readonly string[]): VerificationFailureLocation[] {
  const out: VerificationFailureLocation[] = [];
  for (const line of lines) {
    const groups = TSC_DIAGNOSTIC.exec(line)?.groups;
    if (groups?.file === undefined) continue;
    out.push({
      file: groups.file.trim(),
      line: toInt(groups.line ?? "0"),
      column: toInt(groups.col ?? "0"),
      message: cap((groups.msg ?? "").trim()),
      ...(groups.rule === undefined ? {} : { ruleId: groups.rule }),
    });
  }
  return out;
}

function matchEslintFile(line: string): string | undefined {
  return ESLINT_FILE.exec(line)?.groups?.file?.trim();
}

function matchEslintRow(line: string, file: string): VerificationFailureLocation | undefined {
  const groups = ESLINT_ROW.exec(line)?.groups;
  if (groups?.line === undefined) return undefined;
  return {
    file,
    line: toInt(groups.line),
    column: toInt(groups.col ?? "0"),
    message: cap((groups.msg ?? "").trim()),
    ...(groups.rule === undefined ? {} : { ruleId: groups.rule }),
  };
}

function extractEslint(lines: readonly string[]): VerificationFailureLocation[] {
  const out: VerificationFailureLocation[] = [];
  let currentFile: string | undefined;
  for (const line of lines) {
    const file = matchEslintFile(line);
    if (file !== undefined) {
      currentFile = file;
      continue;
    }
    if (currentFile === undefined) continue;
    const location = matchEslintRow(line, currentFile);
    if (location !== undefined) out.push(location);
  }
  return out;
}

function matchVitestFrame(
  line: string,
  title: string | undefined,
): VerificationFailureLocation | undefined {
  const groups = VITEST_FRAME.exec(line)?.groups;
  if (groups?.file === undefined) return undefined;
  return {
    file: groups.file,
    line: toInt(groups.line ?? "0"),
    column: toInt(groups.col ?? "0"),
    message: cap(title ?? "Test failure"),
  };
}

function extractVitest(lines: readonly string[]): VerificationFailureLocation[] {
  const out: VerificationFailureLocation[] = [];
  let title: string | undefined;
  for (const line of lines) {
    const titleMatch = VITEST_TITLE.exec(line)?.groups?.title;
    if (titleMatch !== undefined) {
      title = titleMatch;
      continue;
    }
    const location = matchVitestFrame(line, title);
    if (location !== undefined) out.push(location);
  }
  return out;
}

function extractByKind(
  kind: VerificationKind,
  lines: readonly string[],
): VerificationFailureLocation[] {
  switch (kind) {
    case "typecheck":
      return extractTsc(lines);
    case "lint":
      return extractEslint(lines);
    case "test":
    case "targeted-test":
      return extractVitest(lines);
    case "build":
      return [];
  }
}

// Deduplicate by file:line:column and clamp to the contract's per-result count cap. A location with a
// non-positive or non-finite line is dropped (a fabricated coordinate must never surface).
function clamp(
  raw: readonly VerificationFailureLocation[],
): readonly VerificationFailureLocation[] {
  const seen = new Set<string>();
  const out: VerificationFailureLocation[] = [];
  for (const location of raw) {
    if (out.length >= VERIFICATION_MAX_FAILURE_LOCATIONS) break;
    if (location.line !== undefined && (!Number.isInteger(location.line) || location.line <= 0)) {
      continue;
    }
    const key = `${location.file}:${String(location.line)}:${String(location.column)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(location);
  }
  return out;
}

// Best-effort extractor over an already-redacted CommandResult. Returns [] for a missing result, an
// unparseable format, or the build kind. Pure and throw-free — fully unit-testable against fixtures.
export function extractFailureLocations(
  kind: VerificationKind,
  result: CommandResult | undefined,
): readonly VerificationFailureLocation[] {
  if (result === undefined) return [];
  const lines = `${result.stdout}\n${result.stderr}`
    .split(/\r?\n/u)
    .filter((line) => line.length <= MAX_LINE_LENGTH);
  return clamp(extractByKind(kind, lines));
}
