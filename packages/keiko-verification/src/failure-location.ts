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
import { posix as posixPath, win32 as win32Path } from "node:path";
import { stripVTControlCharacters } from "node:util";

// A defensive per-line length ceiling: a pathological single line is skipped rather than matched.
const MAX_LINE_LENGTH = 4_096;
const MAX_PATH_BYTES = 4_096;
const MAX_COORDINATE = 2_147_483_647;
const MAX_RULE_ID_CHARS = 128;
const TEXT_ENCODER = new TextEncoder();
const WINDOWS_ROOT = /^(?:[A-Za-z]:[\\/]|\\{2}|\/{2})/u;
const WINDOWS_QUALIFIED = /^(?:[A-Za-z]:|\\{2}|\/{2})/u;

// tsc default: "src/a.ts(12,34): error TS2322: Type 'x' is not assignable to type 'y'."
const TSC_DIAGNOSTIC =
  /^(?<file>[^()]+?)\((?<line>\d+),(?<col>\d+)\): (?:error|warning) (?<rule>TS\d+): (?<msg>.*)$/u;
// ESLint stylish row under a bare file-path header line: "  12:34  error  message  rule-id".
// Only the unambiguous coordinate/severity prefix is parsed with a regex. The optional trailing
// rule id is scanned from right to left so message whitespace and the optional rule cannot create
// the super-linear backtracking shape that SonarCloud S8786 rejects.
const ESLINT_ROW_PREFIX = /^\s+(\d+):(\d+)\s+(?:error|warning)\s+(?=.)/u;
// A bare file-path line preceding ESLint rows (absolute or workspace-relative, no leading space).
const ESLINT_FILE = /^(?<file>[^\s].*\.[cm]?[jt]sx?)$/u;
// vitest default failure stack frame: "❯ src/a.test.ts:12:34" or "at src/a.test.ts:12:34".
// The leading token is bounded to 512 chars (far more than any real workspace-relative path) so a
// line with no ".test."/".spec." marker anywhere cannot force an O(line-length) greedy backtrack
// at every scanned start position (S8786) — empirically an O(n^2) case for the previous unbounded
// `[^\s()]+` (confirmed via adversarial timing before this change).
const VITEST_FRAME =
  /(?<file>[^\s()]{1,512}\.(?:test|spec)\.[cm]?[jt]sx?):(?<line>\d+):(?<col>\d+)/u;
// A vitest failure title line ("FAIL src/a.test.ts > suite > case", "× case", "✗ case").
// Bounded for the same reason as ESLINT_ROW above: the lazy title capture and the trailing
// `\s*$` both match whitespace, so an unbounded title is a genuine (line-length-capped, but
// otherwise real) polynomial-backtracking shape, not just an S8786 static-analysis preference.
// The bound alone doesn't remove the *shape* the analyzer flags, though (a capped ambiguity is
// still ambiguity) — so the trailing `\s*$` is dropped entirely: the capture is greedy and
// unconditionally reaches `$` in one pass (nothing left to backtrack against), and the title is
// trimmed in code (`trimEnd`) instead, which can never backtrack.
const VITEST_TITLE = /^\s*(?:FAIL\b|×|✗|✖)\s*(?<title>.{1,4096})$/u;

function toInt(value: string): number {
  return Number.parseInt(value, 10);
}

function cap(text: string, maxChars = VERIFICATION_FAILURE_MESSAGE_MAX_CHARS): string {
  if (text.length <= maxChars) return text;
  const capped = text.slice(0, maxChars);
  const last = capped.codePointAt(capped.length - 1) ?? 0;
  return last >= 0xd800 && last <= 0xdbff ? capped.slice(0, -1) : capped;
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

function isEslintRuleChar(char: string | undefined): boolean {
  if (char === undefined) return false;
  return /[\w@/.-]/u.test(char);
}

function isWhitespace(char: string | undefined): boolean {
  return char !== undefined && /\s/u.test(char);
}

interface EslintMessageParts {
  readonly message: string;
  readonly ruleId?: string | undefined;
}

function eslintMessageParts(body: string): EslintMessageParts | undefined {
  if (body.length === 0) return undefined;
  let end = body.length;
  while (isWhitespace(body[end - 1])) end -= 1;
  let ruleStart = end;
  while (isEslintRuleChar(body[ruleStart - 1])) ruleStart -= 1;
  let separatorStart = ruleStart;
  while (isWhitespace(body[separatorStart - 1])) separatorStart -= 1;
  if (ruleStart < end && ruleStart - separatorStart >= 2 && separatorStart > 0) {
    return {
      message: body.slice(0, separatorStart).trim(),
      ruleId: body.slice(ruleStart, end),
    };
  }
  return { message: body.trim() };
}

function matchEslintRow(line: string, file: string): VerificationFailureLocation | undefined {
  const match = ESLINT_ROW_PREFIX.exec(line);
  const lineNumber = match?.[1];
  if (match === null || lineNumber === undefined) return undefined;
  const parts = eslintMessageParts(line.slice(match[0].length));
  if (parts === undefined) return undefined;
  return {
    file,
    line: toInt(lineNumber),
    column: toInt(match[2] ?? "0"),
    message: cap(parts.message),
    ...(parts.ruleId === undefined ? {} : { ruleId: parts.ruleId }),
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
      title = titleMatch.trimEnd();
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

function hasTraversal(path: string): boolean {
  return path.split(/[\\/]/u).includes("..");
}

function isEscapingRelative(path: string, absolute: boolean): boolean {
  if (path.length === 0 || absolute) return true;
  const first = path.split(/[\\/]/u)[0];
  return first === "..";
}

function normalizeWindowsPath(file: string, workspaceRoot: string): string | undefined {
  if (!WINDOWS_ROOT.test(workspaceRoot) || (file.startsWith("/") && !file.startsWith("//"))) {
    return undefined;
  }
  if (WINDOWS_QUALIFIED.test(file) && !win32Path.isAbsolute(file)) return undefined;
  const root = win32Path.resolve(workspaceRoot);
  const absolute = win32Path.isAbsolute(file)
    ? win32Path.resolve(file)
    : win32Path.resolve(root, file);
  const relative = win32Path.relative(root, absolute);
  if (isEscapingRelative(relative, win32Path.isAbsolute(relative))) return undefined;
  return relative.replaceAll("\\", "/");
}

function normalizePosixPath(file: string, workspaceRoot: string): string | undefined {
  if (!posixPath.isAbsolute(workspaceRoot) || WINDOWS_QUALIFIED.test(file)) return undefined;
  const normalizedFile = file.replaceAll("\\", "/");
  const root = posixPath.resolve(workspaceRoot);
  const absolute = posixPath.isAbsolute(normalizedFile)
    ? posixPath.resolve(normalizedFile)
    : posixPath.resolve(root, normalizedFile);
  const relative = posixPath.relative(root, absolute);
  return isEscapingRelative(relative, posixPath.isAbsolute(relative)) ? undefined : relative;
}

function normalizeFailurePath(file: string, workspaceRoot: string): string | undefined {
  if (
    file.length === 0 ||
    workspaceRoot.length === 0 ||
    file.includes("\u0000") ||
    workspaceRoot.includes("\u0000") ||
    TEXT_ENCODER.encode(file).length > MAX_PATH_BYTES ||
    hasTraversal(file)
  ) {
    return undefined;
  }
  const normalized = WINDOWS_ROOT.test(workspaceRoot)
    ? normalizeWindowsPath(file, workspaceRoot)
    : normalizePosixPath(file, workspaceRoot);
  if (normalized === undefined || TEXT_ENCODER.encode(normalized).length > MAX_PATH_BYTES) {
    return undefined;
  }
  return normalized;
}

function isValidCoordinate(value: number | undefined): boolean {
  return value === undefined || (Number.isInteger(value) && value > 0 && value <= MAX_COORDINATE);
}

function normalizeLocation(
  location: VerificationFailureLocation,
  workspaceRoot: string,
): VerificationFailureLocation | undefined {
  const file = normalizeFailurePath(location.file, workspaceRoot);
  if (
    file === undefined ||
    !isValidCoordinate(location.line) ||
    !isValidCoordinate(location.column)
  ) {
    return undefined;
  }
  return {
    file,
    ...(location.line === undefined ? {} : { line: location.line }),
    ...(location.column === undefined ? {} : { column: location.column }),
    message: cap(location.message),
    ...(location.ruleId === undefined ? {} : { ruleId: cap(location.ruleId, MAX_RULE_ID_CHARS) }),
  };
}

// Normalize to a workspace-relative POSIX path, deduplicate by file:line:column, and clamp to the
// contract's per-result count cap. Invalid coordinates and any path that is ambiguous or outside the
// active workspace are dropped, so hostile output cannot become a host-path disclosure.
function clamp(
  raw: readonly VerificationFailureLocation[],
  workspaceRoot: string,
): readonly VerificationFailureLocation[] {
  const seen = new Set<string>();
  const out: VerificationFailureLocation[] = [];
  for (const candidate of raw) {
    if (out.length >= VERIFICATION_MAX_FAILURE_LOCATIONS) break;
    const location = normalizeLocation(candidate, workspaceRoot);
    if (location === undefined) continue;
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
  workspaceRoot: string,
): readonly VerificationFailureLocation[] {
  if (result === undefined) return [];
  const lines = `${result.stdout}\n${result.stderr}`
    .split(/\r?\n/u)
    // Vitest 4 inserts ANSI styling between a path's colon and its line/column digits on Linux.
    // Bound raw lines before doing any work, then strip terminal presentation controls so colored
    // and non-colored reporters parse identically. Stripping only removes characters, so the raw
    // bound also guarantees a bounded normalized line.
    .filter((line) => line.length <= MAX_LINE_LENGTH)
    .map((line) => stripVTControlCharacters(line));
  return clamp(extractByKind(kind, lines), workspaceRoot);
}
