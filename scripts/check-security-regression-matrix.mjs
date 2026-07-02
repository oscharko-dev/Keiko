import { readFileSync } from "node:fs";
import { join } from "node:path";

const MATRIX_PATH = join(import.meta.dirname, "security-regression-matrix.json");

const EXPECTED_IDS = [
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

function fail(message) {
  console.error(`security-regression-matrix: FAIL - ${message}`);
  process.exit(1);
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

function verificationFailures(id, verification) {
  if (!stringArray(verification) || verification.length === 0) {
    return [`${id} must list at least one verification command`];
  }
  return placeholderVerificationFailures(id, verification);
}

function notesFailures(id, notes) {
  if (typeof notes === "string" && notes.trim().length > 0) return [];
  return [`${id} must include non-empty notes`];
}

function validateMatrixEntry(entry, index, expected, seen) {
  const failures = [];
  if (!isMatrixEntryObject(entry)) {
    return [`entry ${String(index)} must be an object`];
  }
  const id = entry.id;
  const idFailure = knownFindingIdFailure(id, index, expected);
  if (idFailure !== undefined) return [idFailure];
  failures.push(...duplicateFindingIdFailures(id, seen));
  failures.push(...verificationFailures(id, entry.verification));
  failures.push(...notesFailures(id, entry.notes));
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

function validateMatrix(matrix) {
  if (!Array.isArray(matrix)) {
    fail("matrix root must be a JSON array.");
  }
  const expected = new Set(EXPECTED_IDS);
  const seen = new Set();
  const failures = [];
  for (const [index, entry] of matrix.entries()) {
    failures.push(...validateMatrixEntry(entry, index, expected, seen));
  }
  failures.push(...missingExpectedIdFailures(expected, seen));
  return { failures, count: seen.size };
}

function printFailuresAndExit(failures) {
  if (failures.length > 0) {
    console.error("security-regression-matrix: FAIL");
    for (const failure of failures) {
      console.error(`  - ${failure}`);
    }
    process.exit(1);
  }
}

function main() {
  const matrix = JSON.parse(readFileSync(MATRIX_PATH, "utf8"));
  const { failures, count } = validateMatrix(matrix);
  printFailuresAndExit(failures);
  console.log(`security-regression-matrix: PASS - ${String(count)} findings mapped.`);
}

main();
