import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { isMainModule } from "./lib/is-main-module.mjs";

const MATRIX_PATH = join(import.meta.dirname, "security-regression-matrix.json");
const REPO_ROOT = join(import.meta.dirname, "..");

export const EXPECTED_IDS = [
  "AUDIT-SEC-001",
  "AUDIT-FS-001",
  "AUDIT-EVID-001",
  "AUDIT-MEMSEC-001",
  "AUDIT-UISEC-001",
  "AUDIT-CRED-001",
  "AUDIT-SUPPLYSEC-001",
  "AUDIT-SUPPLYSEC-002",
  "AUDIT-CMD-001",
  "AUDIT-EVID-002",
  "AUDIT-FS-002",
  "AUDIT-PRIV-001",
  "AUDIT-MODEL-001",
  "AUDIT-FS-003",
  "AUDIT-FS-004",
  "AUDIT-MODEL-002",
  "AUDIT-NET-001",
  "AUDIT-NET-002",
  "AUDIT-NET-003",
  "AUDIT-EVID-003",
  "AUDIT-EVID-004",
  "AUDIT-MEMSEC-002",
  "AUDIT-UISEC-002",
  "AUDIT-SUPPLYSEC-003",
  "AUDIT-SUPPLYSEC-004",
  "AUDIT-SUPPLYSEC-005",
  "AUDIT-SUPPLYSEC-006",
  "AUDIT-CRED-002",
  "AUDIT-SECDOC-001",
  "AUDIT-SECTEST-001",
  "AUDIT-UISEC-003",
  "AUDIT-UISEC-004",
  "AUDIT-PRIV-002",
  "AUDIT-FS-005",
  "AUDIT-SECDOC-002",
  "AUDIT-SECDOC-003",
  "AUDIT-CMD-002",
  "AUDIT-CMD-003",
  "AUDIT-HARDEN-001",
  "AUDIT-HARDEN-002",
  "AUDIT-HARDEN-003",
  "AUDIT-HARDEN-004",
];

// The CLI surface takes its sinks by injection so the suite can drive the real read/validate/report
// path — including both failure branches — without spawning a subprocess or exiting the runner.
const CONSOLE_REPORTER = {
  log: (message) => {
    console.log(message);
  },
  error: (message) => {
    console.error(message);
  },
  exit: (code) => {
    process.exit(code);
  },
};

function fail(reporter, message) {
  reporter.error(`security-regression-matrix: FAIL - ${message}`);
  reporter.exit(1);
}

function stringArray(value) {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isMatrixEntryObject(entry) {
  return typeof entry === "object" && entry !== null && !Array.isArray(entry);
}

function knownFindingIdFailure(id, index, expected) {
  if (typeof id === "string" && expected.has(id)) return undefined;
  return `entry ${String(index)} has unknown id ${String(id)}`;
}

function duplicateFindingIdFailures(id, seen) {
  if (!seen.has(id)) {
    seen.add(id);
    return [];
  }
  seen.add(id);
  return [`${id} appears more than once`];
}

function verificationFailures(id, verification, repoRoot) {
  if (!stringArray(verification) || verification.length === 0) {
    return [`${id} must list at least one verification command`];
  }
  return [
    ...placeholderVerificationFailures(id, verification),
    ...verificationPathFailures(id, verification, repoRoot),
  ];
}

// A verification command is this matrix's coverage-of-record: the standing claim that a named test
// or document still proves a specific security finding. A command naming a file that no longer
// exists proves nothing, so every file-path-shaped token is resolved and stat-checked against the
// tree. Shape-only validation let this gate report PASS while 13 of 42 entries pointed at deleted
// or never-committed files, four of which were never in git history at all (audit KEIKO-0030).
// Operators only, with no surrounding `\s*`: this is a `split()` separator, and every consumer
// already trims or re-splits on whitespace. A `\s*(?:…)\s*` form lets the engine try each way of
// dividing a whitespace run before failing the alternation, which is super-linear (sonarjs S8786).
const COMMAND_SEPARATOR = /(?:&&|\|\||;)/u;
// Quotes are UNWRAPPED rather than stripped. Dropping the quoted text entirely let
// `npx vitest run "gone.test.ts"` name a missing file and still pass — the token never reached the
// stat-check. A quoted ripgrep PATTERN survives this too, but harmlessly: its words carry no
// extension, or carry characters (`,` `|` space) outside the path class, so none is path-shaped.
const QUOTE_MARKS = /["']/gu;
// A whitespace-delimited token carrying a file extension. Deliberately extension-agnostic so a
// future entry referencing an unanticipated file type is still checked rather than silently
// skipped; runner words (`npx`, `vitest`), npm script names (`check:local-state`) and flags
// (`--config`) carry no extension and are not path-shaped.
//
// Split into two anchored single-class patterns plus a `lastIndexOf`, rather than one
// `[\w@./-]+\.[A-Za-z0-9]+` — `.` belongs to both classes there, so the engine can split a
// dotted path many ways and backtracks super-linearly on a non-match (sonarjs S8786). Each pattern
// below has exactly one path through it.
const PATH_TOKEN_CHARACTERS = /^[\w@./-]+$/u;
const PATH_TOKEN_EXTENSION = /^[A-Za-z0-9]+$/u;
const CHANGE_DIRECTORY = /^cd\s+(\S+)$/u;

function isPathShapedToken(token) {
  if (!PATH_TOKEN_CHARACTERS.test(token)) return false;
  const lastDot = token.lastIndexOf(".");
  if (lastDot <= 0 || lastDot === token.length - 1) return false;
  return PATH_TOKEN_EXTENSION.test(token.slice(lastDot + 1));
}

// The operand a token carries, once quoting and an attached option value are accounted for. A flag
// is skipped, but `--config=path/to.ts` carries a real operand after the `=`, and skipping the whole
// token let a missing file through — the same bypass as the quoted form above.
function tokenOperand(token) {
  if (!token.startsWith("-")) return token;
  const equals = token.indexOf("=");
  return equals === -1 ? "" : token.slice(equals + 1);
}

export function verificationPathFailures(id, verification, repoRoot = REPO_ROOT) {
  const failures = [];
  for (const command of verification) {
    for (const missing of missingCommandPaths(command, repoRoot)) {
      failures.push(`${id} verification path does not exist: ${missing}`);
    }
  }
  return failures;
}

// `cd <dir> && …` is a real shape in this matrix (the keiko-ui entries run vitest from the package
// directory), so paths are resolved against the directory the command would actually run in.
function missingCommandPaths(command, repoRoot) {
  const missing = [];
  let base = "";
  for (const segment of command.split(COMMAND_SEPARATOR)) {
    const target = CHANGE_DIRECTORY.exec(segment.trim())?.[1];
    if (target === undefined) {
      missing.push(...missingSegmentPaths(segment, base, repoRoot));
      continue;
    }
    base = base === "" ? target : `${base}/${target}`;
    if (!existsSync(resolve(repoRoot, base))) missing.push(base);
  }
  return missing;
}

function missingSegmentPaths(segment, base, repoRoot) {
  const missing = [];
  for (const token of pathShapedTokens(segment)) {
    const relativePath = base === "" ? token : `${base}/${token}`;
    if (!existsSync(resolve(repoRoot, relativePath))) missing.push(relativePath);
  }
  return missing;
}

function pathShapedTokens(segment) {
  return segment
    .replace(QUOTE_MARKS, "")
    .split(/\s+/u)
    .map((token) => tokenOperand(token))
    .filter((operand) => isPathShapedToken(operand));
}

function notesFailures(id, notes) {
  if (typeof notes === "string" && notes.trim().length > 0) return [];
  return [`${id} must include non-empty notes`];
}

function validateMatrixEntry(entry, index, expected, seen, repoRoot) {
  const failures = [];
  if (!isMatrixEntryObject(entry)) {
    return [`entry ${String(index)} must be an object`];
  }
  const id = entry.id;
  const idFailure = knownFindingIdFailure(id, index, expected);
  if (idFailure !== undefined) return [idFailure];
  failures.push(
    ...duplicateFindingIdFailures(id, seen),
    ...verificationFailures(id, entry.verification, repoRoot),
    ...notesFailures(id, entry.notes),
  );
  return failures;
}

function placeholderVerificationFailures(id, verification) {
  const failures = [];
  for (const command of verification) {
    if (command.trim().length === 0 || /\b(?:TODO|TBD|needs confirmation)\b/iu.test(command)) {
      failures.push(`${id} has an empty or placeholder verification command`);
    }
  }
  return failures;
}

function missingExpectedIdFailures(expected, seen) {
  const failures = [];
  for (const id of expected) {
    if (!seen.has(id)) failures.push(`${id} is missing from the regression matrix`);
  }
  return failures;
}

export function validateMatrix(matrix, repoRoot = REPO_ROOT) {
  if (!Array.isArray(matrix)) {
    return { failures: ["matrix root must be a JSON array."], count: 0 };
  }
  const expected = new Set(EXPECTED_IDS);
  const seen = new Set();
  const failures = [];
  for (const [index, entry] of matrix.entries()) {
    failures.push(...validateMatrixEntry(entry, index, expected, seen, repoRoot));
  }
  failures.push(...missingExpectedIdFailures(expected, seen));
  return { failures, count: seen.size };
}

function printFailuresAndExit(reporter, failures) {
  if (failures.length === 0) return false;
  reporter.error("security-regression-matrix: FAIL");
  for (const failure of failures) {
    reporter.error(`  - ${failure}`);
  }
  reporter.exit(1);
  return true;
}

export function main({
  matrixPath = MATRIX_PATH,
  repoRoot = REPO_ROOT,
  reporter = CONSOLE_REPORTER,
} = {}) {
  let matrix;
  try {
    matrix = JSON.parse(readFileSync(matrixPath, "utf8"));
  } catch (error) {
    fail(
      reporter,
      `matrix could not be read: ${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }
  const { failures, count } = validateMatrix(matrix, repoRoot);
  if (printFailuresAndExit(reporter, failures)) return;
  reporter.log(`security-regression-matrix: PASS - ${String(count)} findings mapped.`);
}

// Run as a CLI unless imported by a test.
if (isMainModule(import.meta.url)) {
  main();
}
