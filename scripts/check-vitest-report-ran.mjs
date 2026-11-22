// Fails a CI step whose vitest run was green only because its suite never ran (#4530).
//
// A suite gated on an environment flag or a platform skips silently when the gate is not met, and
// vitest then exits 0. This reads the run's JSON report (`--reporter=json --outputFile=<file>`)
// and requires a successful run with at least one passed test, no failed test, and no skipped or
// placeholder test.
//
//   node scripts/check-vitest-report-ran.mjs <report.json>

import { pathToFileURL } from "node:url";

import { readJsonArgument } from "./lib/json-argument.mjs";

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
  const read = readJsonArgument(argv, io, { name: NAME, input: "report" });
  if ("exitCode" in read) return read.exitCode;
  const verdict = vitestReportVerdict(read.value);
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
