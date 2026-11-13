// A report answer shows figures, not the product's raw result keys (#4355).
import { describe, expect, it } from "vitest";
import { gradeRawKeys, reportResultKeys } from "../testing/jira-chat-lab/requirements/raw-keys.mjs";

const report = (data) => ({
  call: { id: "r", name: "jira_report", arguments: { projectKey: "RPT" } },
  result: {
    toolRef: { canonicalId: "keiko.jira.report", contractVersion: 1 },
    status: "completed",
    data: { outcome: "succeeded", ...data },
  },
});
const RESULT = report({
  reportId: "id-1",
  report: {
    progress: { byStatus: { items: [{ typeName: "Aufgabe", statusName: "Fertig", total: 37 }] } },
    completeness: { issuesRead: 181, issuesTotal: 181, pageCount: 4 },
  },
  epics: { nextStartAt: 15 },
});

describe("the raw result keys of a report", () => {
  it("are every camelCase property name of the stored jira.report results, at any depth", () => {
    expect([...reportResultKeys([RESULT])].sort()).toEqual(
      [
        "byStatus",
        "issuesRead",
        "issuesTotal",
        "nextStartAt",
        "pageCount",
        "reportId",
        "statusName",
        "typeName",
      ].sort(),
    );
  });

  it("ignore other tools, failed calls and plain words", () => {
    const other = {
      ...RESULT,
      result: { ...RESULT.result, toolRef: { canonicalId: "keiko.jira.search" } },
    };
    const failed = { ...RESULT, result: { ...RESULT.result, status: "failed" } };
    expect(reportResultKeys([other, failed]).size).toBe(0);
    expect(reportResultKeys(undefined).size).toBe(0);
    expect(reportResultKeys([RESULT]).has("outcome")).toBe(false);
  });
});

describe("gradeRawKeys", () => {
  it("is green when the answer shows figures only", () => {
    const grade = gradeRawKeys("ANZAHL;Aufgabe;Fertig;37\nEPIC;RPT-1;5;1", [RESULT]);
    expect(grade.status).toBe("green");
  });

  it("is red, naming the keys, when the answer shows a raw key as a whole word", () => {
    const grade = gradeRawKeys("byStatus: Aufgabe 37, typeName=Aufgabe", [RESULT]);
    expect(grade.status).toBe("red");
    expect(grade.detail).toContain("byStatus");
    expect(grade.detail).toContain("typeName");
    // A key inside a longer word is not the key.
    expect(gradeRawKeys("Die byStatusAnzeige fehlt.", [RESULT]).status).toBe("green");
  });

  it("is unverified when the turn holds no stored report result: nothing to look for", () => {
    expect(gradeRawKeys("byStatus", []).status).toBe("unverified");
    expect(gradeRawKeys("byStatus", undefined).status).toBe("unverified");
  });
});
