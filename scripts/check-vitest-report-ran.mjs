// Fails a CI step whose vitest run was green only because its suite never ran (#4530).
//
// A suite gated on an environment flag or a platform skips silently when the gate is not met, and
// vitest then exits 0. This reads the run's JSON report (`--reporter=json --outputFile=<file>`)
// and requires a successful run with at least one passed test, no failed test, and no skipped or
// todo test.
//
//   node scripts/check-vitest-report-ran.mjs <report.json>

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const NAME = "check-vitest-report-ran";

function count(value) {
  return Number.isInteger(value) && value > 0 ? value : 0;
}

/** The verdict on one vitest JSON report: `ok` only when tests really ran and all passed. */
export function vitestReportVerdict(report) {
  const passed = count(report?.numPassedTests);
  const failed = count(report?.numFailedTests);
  const skipped = count(report?.numPendingTests) + count(report?.numTodoTests);
  if (report?.success !== true || failed > 0) {
    return { ok: false, reason: `the run did not succeed (${String(failed)} failed)` };
  }
  if (skipped > 0) return { ok: false, reason: `${String(skipped)} tests were skipped` };
  if (passed === 0) return { ok: false, reason: "no test ran" };
  return { ok: true, reason: `${String(passed)} passed, none skipped` };
}

/** Reads the report named by `argv[2]` and returns the process exit code. */
export function runCheck(argv, io = console) {
  const file = argv[2];
  if (file === undefined || file === "") {
    io.error(`${NAME}: FAIL usage: node scripts/${NAME}.mjs <report.json>`);
    return 2;
  }
  let report;
  try {
    report = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    io.error(`${NAME}: FAIL the report could not be read (${detail})`);
    return 1;
  }
  const verdict = vitestReportVerdict(report);
  if (!verdict.ok) {
    io.error(`${NAME}: FAIL ${verdict.reason}`);
    return 1;
  }
  io.log(`${NAME}: PASS ${verdict.reason}`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = runCheck(process.argv);
}
