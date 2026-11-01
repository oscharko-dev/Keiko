import { describe, expect, it } from "vitest";
import type { ChatToolExchange } from "@oscharko-dev/keiko-contracts/bff-wire";
import { omittedReportFindingKeys, reportFindingCorrection } from "./chat-tool-report-coverage.js";

function reportPage(
  name: string,
  keys: readonly string[],
  canonicalId = "keiko.jira.report",
  status = "completed",
): ChatToolExchange {
  return {
    call: { id: `call-${name}`, name: "jira_report", arguments: { section: name } },
    result: {
      schemaVersion: 1,
      invocationId: `invocation-${name}`,
      toolRef: { canonicalId, contractVersion: 1 },
      status,
      reason: "none",
      effectStarted: true,
      data: {
        outcome: "succeeded",
        section: {
          name,
          startAt: 0,
          total: keys.length,
          items: keys.map((key) => ({ key, details: ["field-missing: Time Tracking"] })),
        },
      },
    },
  } as unknown as ChatToolExchange;
}

describe("omittedReportFindingKeys", () => {
  it("names every listed finding the answer leaves out, across pages, once", () => {
    const exchanges = [
      reportPage("deviations", ["RPT-5", "RPT-50", "RPT-63"]),
      reportPage("deviations", ["RPT-76", "RPT-5"]),
    ];
    // RPT-5 appears; RPT-50 is not "mentioned" by RPT-5, nor RPT-5 by RPT-50.
    expect(
      omittedReportFindingKeys(exchanges, "**RPT-5**: summary pattern; RPT-76: estimate"),
    ).toEqual(["RPT-50", "RPT-63"]);
    expect(omittedReportFindingKeys(exchanges, "RPT-50, RPT-63 and RPT-76")).toEqual(["RPT-5"]);
  });

  it("is satisfied by an answer that names every finding", () => {
    const exchanges = [reportPage("orphans", ["RPT-48", "RPT-59"])];
    expect(omittedReportFindingKeys(exchanges, "RPT-48 and RPT-59 have no epic.")).toEqual([]);
  });

  it("ignores figure sections, other tools, unfinished results and malformed keys", () => {
    const exchanges = [
      reportPage("epics", ["RPT-1"]),
      reportPage("statuses", ["RPT-2"]),
      reportPage("deviations", ["RPT-3"], "keiko.jira.search"),
      reportPage("deviations", ["RPT-4"], "keiko.jira.report", "denied"),
      reportPage("deviations", ["not a key", "rpt-5", "RPT-"]),
    ];
    expect(omittedReportFindingKeys(exchanges, "nothing")).toEqual([]);
  });
});

it("asks for the omitted keys in one fixed sentence", () => {
  expect(reportFindingCorrection(["RPT-50", "RPT-63"])).toBe(
    "Your answer leaves out 2 issue(s) that the jira.report pages read in this turn list: " +
      "RPT-50, RPT-63. Answer again in full: name every listed issue with its finding as the " +
      "report states it.",
  );
});
