// Fails a CI step whose vitest run was green only because its suite never ran (#4530).
//
// A suite gated on an environment flag or a platform skips silently when the gate is not met, and
// vitest then exits 0. This reads the run's JSON report (`--reporter=json --outputFile=<file>`)
// and requires a successful run with at least one passed test, no failed test, and no skipped or
// placeholder test.
//
// A lane that runs only some tests of its files (`vitest run -t <pattern>`) passes the same pattern
// as `--select`: vitest reports the tests it left out as skipped, so the verdict then covers exactly
// the tests whose full name the pattern matches, and every one of them must have passed (#4521).
//
//   node scripts/check-vitest-report-ran.mjs <report.json> [--select <pattern>]

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

/** The verdict on the tests whose full name `pattern` matches; the run's other tests are ignored. */
export function selectedReportVerdict(report, pattern) {
  const selected = (Array.isArray(report?.testResults) ? report.testResults : [])
    .flatMap((file) => (Array.isArray(file?.assertionResults) ? file.assertionResults : []))
    .filter((result) => typeof result?.fullName === "string" && pattern.test(result.fullName));
  const passed = selected.filter((result) => result.status === "passed").length;
  const failed = selected.filter((result) => result.status === "failed").length;
  const skipped = selected.length - passed - failed;
  if (report?.success !== true || failed > 0) {
    return { ok: false, reason: `the run did not succeed (${String(failed)} selected failed)` };
  }
  if (skipped > 0) return { ok: false, reason: `${String(skipped)} selected tests were skipped` };
  if (passed === 0) return { ok: false, reason: "no selected test ran" };
  return { ok: true, reason: `${String(passed)} selected passed, none skipped` };
}

function selection(argv, io) {
  const index = argv.indexOf("--select", 3);
  if (index === -1) return { pattern: undefined };
  const source = argv[index + 1];
  try {
    if (source === undefined || source === "") throw new SyntaxError("empty pattern");
    return { pattern: new RegExp(source, "u") };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    io.error(`${NAME}: FAIL --select needs a valid pattern (${detail})`);
    return { exitCode: 2 };
  }
}

/** Reads the report named by `argv[2]` and returns the process exit code. */
export function runCheck(argv, io = console) {
  const read = readJsonArgument(argv, io, { name: NAME, input: "report" });
  if ("exitCode" in read) return read.exitCode;
  const selected = selection(argv, io);
  if ("exitCode" in selected) return selected.exitCode;
  const verdict =
    selected.pattern === undefined
      ? vitestReportVerdict(read.value)
      : selectedReportVerdict(read.value, selected.pattern);
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
