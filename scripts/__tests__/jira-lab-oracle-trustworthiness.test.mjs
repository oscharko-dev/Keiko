// The three oracles that misgraded or could misgrade (#4369): the report answer reader shared by
// every report grader (German number formatting, TAB tables), the S16 failure causes, and the S17
// grade when the lab limit, not the product, ended a turn.
import { describe, expect, it } from "vitest";
import {
  cellsOf,
  decimalCell,
  integerCell,
} from "../testing/jira-chat-lab/requirements/answer-cells.mjs";
import {
  gradeCatalogRefresh,
  gradeInterruption,
} from "../testing/jira-chat-lab/requirements/backlog-turn.mjs";
import { templateGapsLabelled } from "../testing/jira-chat-lab/requirements/deviation-report.mjs";
import * as progress from "../testing/jira-chat-lab/requirements/progress-report.mjs";
import { gradeTemplateTestCases } from "../testing/jira-chat-lab/requirements/template-test-cases.mjs";

describe("report answer reader shared by every report grader", () => {
  it("reads German and English thousands as whole counts and refuses a decimal count", () => {
    expect(integerCell("1.170")).toBe(1170);
    expect(integerCell("1,170")).toBe(1170);
    expect(integerCell("1.170.000")).toBe(1170000);
    expect(integerCell("12.5")).toBeUndefined();
    expect(integerCell("1.17")).toBeUndefined();
    expect(decimalCell("1.170,5")).toBe(1170.5);
    expect(decimalCell("1,5")).toBe(1.5);
  });

  it("splits semicolon, TAB and Markdown rows alike", () => {
    expect(cellsOf("A;B;3")).toEqual(["A", "B", "3"]);
    expect(cellsOf("A\tB\t3")).toEqual(["A", "B", "3"]);
    expect(cellsOf("| **A** | `B` | 3 |")).toEqual(["A", "B", "3"]);
    expect(cellsOf("plain prose")).toBeUndefined();
  });

  describe("template gap rows (VORLAGENLÜCKE)", () => {
    const without = new Map([
      ["Story", 1170],
      ["Bug", 4],
    ]);
    it.each([
      ["semicolons", "VORLAGENLÜCKE;Story;1170\nVORLAGENLÜCKE;Bug;4"],
      ["German thousands", "VORLAGENLÜCKE;Story;1.170\nVORLAGENLÜCKE;Bug;4"],
      ["TAB cells", "VORLAGENLÜCKE\tStory\t1.170\nVORLAGENLÜCKE\tBug\t4"],
      ["a Markdown table", "| VORLAGENLÜCKE | Story | 1.170 |\n| VORLAGENLÜCKE | Bug | 4 |"],
    ])("grades a correct answer in %s as correct", (_name, answer) => {
      expect(templateGapsLabelled(answer, without)).toBe(true);
    });

    it.each([
      ["a wrong count", "VORLAGENLÜCKE;Story;1.171\nVORLAGENLÜCKE;Bug;4"],
      ["a decimal count", "VORLAGENLÜCKE;Story;1170,5\nVORLAGENLÜCKE;Bug;4"],
      ["a missing type", "VORLAGENLÜCKE;Story;1.170"],
      [
        "a repeated type",
        "VORLAGENLÜCKE;Story;1.170\nVORLAGENLÜCKE;Story;1.170\nVORLAGENLÜCKE;Bug;4",
      ],
      ["a zero count", "VORLAGENLÜCKE;Story;0\nVORLAGENLÜCKE;Bug;4"],
    ])("grades %s as wrong", (_name, answer) => {
      expect(templateGapsLabelled(answer, without)).toBe(false);
    });
  });

  describe("unavailable estimate rows", () => {
    const exchange = {
      call: { arguments: { projectKey: "LRG" } },
      result: {
        status: "completed",
        toolRef: { canonicalId: "keiko.jira.report" },
        data: {
          outcome: "succeeded",
          status: "complete",
          reportId: "native-report",
          report: {
            digest: "a".repeat(64),
            scope: {
              projectKey: "LRG",
              estimateUnit: "unavailable",
              estimateSource: "unavailable",
              estimateUnavailableReason: "field-not-found",
            },
            progress: { project: { total: 42, estimate: null } },
            completeness: { complete: true, issuesRead: 42, issuesTotal: 42 },
          },
        },
      },
    };
    const grade = (text) => progress.gradeUnavailable(text, [exchange], { projectKey: "LRG" });
    it.each([
      "SCHÄTZUNG;NICHT_VERFÜGBAR;field-not-found\nSCOPE-LÜCKE;SCHÄTZUNG;field-not-found",
      "SCHÄTZUNG\tNICHT_VERFÜGBAR\tfield-not-found\nSCOPE-LÜCKE\tSCHÄTZUNG\tfield-not-found",
      "| SCHÄTZUNG | NICHT_VERFÜGBAR | field-not-found |\n| SCOPE-LÜCKE | SCHÄTZUNG | field-not-found |",
    ])("accepts the same correct answer in any row format", (text) => {
      expect(grade(text).ok).toBe(true);
    });
    it("still refuses a wrong reason in TAB format", () => {
      expect(
        grade(
          "SCHÄTZUNG\tNICHT_VERFÜGBAR\tambiguous-field\nSCOPE-LÜCKE\tSCHÄTZUNG\tfield-not-found",
        ).ok,
      ).toBe(false);
    });
  });
});

describe("S16 names the check that failed", () => {
  const item = { id: "LH-002", acceptanceCount: 3 };
  const filled = "Schritte\nEins.\nErwartet\nZwei.";
  const issue = (number, overrides = {}) => ({
    key: `REQ-${number}`,
    fields: {
      summary: `LH-002/AC${number} Titel`,
      labels: ["keiko-req-LH-002"],
      description: filled,
      ...overrides,
    },
  });
  const grade = (issues) =>
    gradeTemplateTestCases({ tests: { credited: issues, duplicates: [] }, item });

  it("is green when every criterion has one conforming issue", () => {
    const result = grade([issue(1), issue(2), issue(3)]);
    expect(result.status).toBe("green");
    expect(result.detail).toContain("summary 0, label 0, section 0");
  });

  it.each([
    ["summary", { summary: "Titel ohne Kennung" }, "summary 1, label 0, section 0"],
    ["label", { labels: [] }, "summary 0, label 1, section 0"],
    ["section", { description: "Schritte\nEins." }, "summary 0, label 0, section 1"],
  ])("counts a %s failure apart from the other two", (_cause, overrides, counts) => {
    const result = grade([issue(1), issue(2), issue(3, overrides)]);
    expect(result.status).toBe("red");
    expect(result.detail).toContain("1 not conforming to the template");
    expect(result.detail).toContain(counts);
  });

  it("counts an issue that fails several checks under each of them", () => {
    const result = grade([issue(1), issue(2), issue(3, { labels: [], description: "" })]);
    expect(result.detail).toContain("summary 0, label 1, section 1");
  });
});

describe("S17 is unverified when the lab limit ended the turn", () => {
  const induced = { ok: true, startedOpen: true, turnOpen: false };
  const base = { induced, ended: true, created: [{ key: "REQ-1" }], answer: "" };

  it("does not grade the interruption's missing answer as a product failure", () => {
    expect(gradeInterruption({ ...base }).status).toBe("red");
    expect(gradeInterruption({ ...base, termination: "lab-limit" })).toMatchObject({
      status: "unverified",
      covers: ["interrupted-turn-reports-created-keys"],
    });
  });

  it("keeps a product-ended turn gradable", () => {
    expect(gradeInterruption({ ...base, answer: "REQ-1", termination: undefined }).status).toBe(
      "green",
    );
  });

  it("keeps the refresh part unverified under the lab limit, unless the product refused", () => {
    const refresh = { induced: { ok: true, turnOpen: true }, termination: "lab-limit" };
    expect(gradeCatalogRefresh({ ...refresh, refused: false }).status).toBe("unverified");
    expect(gradeCatalogRefresh({ ...refresh, refused: true }).status).toBe("red");
  });
});
