import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { runCheck, vitestReportVerdict } from "../check-vitest-report-ran.mjs";

const RAN = { success: true, numPassedTests: 17, numFailedTests: 0, numPendingTests: 0 };

describe("vitestReportVerdict (#4530)", () => {
  it("accepts a run whose tests passed and none was skipped", () => {
    expect(vitestReportVerdict(RAN)).toEqual({ ok: true, reason: "17 passed, none skipped" });
  });

  it("refuses a suite that skipped because its gate was not met", () => {
    const skipped = { success: true, numPassedTests: 0, numFailedTests: 0, numPendingTests: 17 };
    expect(vitestReportVerdict(skipped)).toEqual({ ok: false, reason: "17 tests were skipped" });
  });

  it("refuses a partly skipped run and todo tests", () => {
    expect(vitestReportVerdict({ ...RAN, numPendingTests: 1 }).ok).toBe(false);
    expect(vitestReportVerdict({ ...RAN, numTodoTests: 2 }).reason).toBe("2 tests were skipped");
  });

  it("refuses a run in which no test ran", () => {
    expect(vitestReportVerdict({ success: true, numPassedTests: 0 })).toEqual({
      ok: false,
      reason: "no test ran",
    });
  });

  it("refuses a failed or unsuccessful run, and a report without counts", () => {
    expect(vitestReportVerdict({ ...RAN, numFailedTests: 1, success: false }).ok).toBe(false);
    expect(vitestReportVerdict({ ...RAN, success: false }).ok).toBe(false);
    expect(vitestReportVerdict(null).ok).toBe(false);
    expect(vitestReportVerdict({ success: true, numPassedTests: "17" }).reason).toBe("no test ran");
  });
});

describe("runCheck", () => {
  const roots = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function report(content) {
    const root = mkdtempSync(join(tmpdir(), "vitest-report-ran-"));
    roots.push(root);
    const file = join(root, "report.json");
    writeFileSync(file, content);
    return file;
  }

  function capture() {
    const lines = { log: [], error: [] };
    return {
      lines,
      io: { log: (line) => lines.log.push(line), error: (line) => lines.error.push(line) },
    };
  }

  it("passes on a report of a run that ran", () => {
    const { lines, io } = capture();
    expect(runCheck(["node", "check", report(JSON.stringify(RAN))], io)).toBe(0);
    expect(lines.log).toEqual(["check-vitest-report-ran: PASS 17 passed, none skipped"]);
  });

  it("fails on a report of a skipped suite", () => {
    const { lines, io } = capture();
    const skipped = { ...RAN, numPassedTests: 0, numPendingTests: 3 };
    expect(runCheck(["node", "check", report(JSON.stringify(skipped))], io)).toBe(1);
    expect(lines.error).toEqual(["check-vitest-report-ran: FAIL 3 tests were skipped"]);
  });

  it("fails on an unreadable report and without an argument", () => {
    const { lines, io } = capture();
    expect(runCheck(["node", "check", report("{not json")], io)).toBe(1);
    expect(runCheck(["node", "check"], io)).toBe(2);
    expect(lines.error[0]).toMatch(/^check-vitest-report-ran: FAIL the report could not be read/u);
    expect(lines.error[1]).toMatch(/^check-vitest-report-ran: FAIL usage:/u);
  });
});
