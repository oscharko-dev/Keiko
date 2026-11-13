// A report answer shows figures, not the product's raw result keys (#4355).
import { describe, expect, it } from "vitest";
import {
  gradeAnswerClean,
  reportResultKeys,
  storedFlags,
} from "../testing/jira-chat-lab/requirements/raw-keys.mjs";

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

const message = (uncertainty) => ({
  role: "assistant",
  content: "ANZAHL;Aufgabe;Fertig;37",
  ...(uncertainty === undefined ? {} : { groundedAnswer: { uncertainty } }),
});
const clean = (overrides) =>
  gradeAnswerClean({
    answer: "ANZAHL;Aufgabe;Fertig;37\nEPIC;RPT-1;5;1",
    exchanges: [RESULT],
    stored: message(undefined),
    turn: { failure: undefined },
    ...overrides,
  });

describe("the flags of a stored assistant message", () => {
  it("are the unsupported-claim and entailment-unavailable elements of groundedAnswer.uncertainty", () => {
    expect(
      storedFlags(message([{ kind: "unsupported-claim", claim: "3 unsupported claims" }])),
    ).toEqual(["unsupported-claim"]);
    expect(
      storedFlags(
        message([
          { kind: "entailment-unavailable", claim: "judge ran partly" },
          { kind: "conflict", claim: "other" },
          { kind: "unsupported-claim", claim: "x" },
        ]),
      ),
    ).toEqual(["entailment-unavailable", "unsupported-claim"]);
  });

  it("are none when the message has no grounded answer, no uncertainty or only other kinds", () => {
    expect(storedFlags(message(undefined))).toEqual([]);
    expect(storedFlags(message([]))).toEqual([]);
    expect(storedFlags(message([{ kind: "conflict", claim: "x" }]))).toEqual([]);
    expect(storedFlags(undefined)).toEqual([]);
  });
});

describe("gradeAnswerClean", () => {
  it("is green when the answer shows figures only and the stored message carries no flag", () => {
    const grade = clean({});
    expect(grade.status).toBe("green");
    expect(grade.detail).toContain("no unsupported-claim or entailment flag");
  });

  it("is red, naming the keys and the count, when the answer shows a raw key as a whole word", () => {
    const grade = clean({ answer: "byStatus: Aufgabe 37, typeName=Aufgabe" });
    expect(grade.status).toBe("red");
    expect(grade.detail).toContain("2 raw result keys");
    expect(grade.detail).toContain("byStatus");
    // A key inside a longer word is not the key.
    expect(clean({ answer: "Die byStatusAnzeige fehlt." }).status).toBe("green");
  });

  it("is red when the stored message carries an unsupported-claim or an entailment-unavailable element", () => {
    for (const kind of ["unsupported-claim", "entailment-unavailable"]) {
      const grade = clean({ stored: message([{ kind, claim: "3 unsupported claims" }]) });
      expect(grade.status).toBe("red");
      expect(grade.detail).toContain("1 unsupported-claim or entailment flags");
      expect(grade.detail).toContain(kind);
    }
  });

  it("is red when both halves fail, and reports both", () => {
    const grade = clean({
      answer: "reportId: 1",
      stored: message([{ kind: "unsupported-claim", claim: "x" }]),
    });
    expect(grade.detail).toContain("1 raw result keys");
    expect(grade.detail).toContain("unsupported-claim");
  });

  it("is unverified, never green, when the step did not run or cannot be read", () => {
    expect(clean({ exchanges: [] }).status).toBe("unverified");
    expect(clean({ exchanges: undefined }).status).toBe("unverified");
    expect(clean({ stored: undefined }).detail).toContain("stored assistant message");
    expect(clean({ turn: { failure: { kind: "gateway" } } }).status).toBe("unverified");
    expect(clean({ answer: "  " }).status).toBe("unverified");
    // The raw key would be red, but a turn that never answered proves nothing either way.
    expect(clean({ answer: "", exchanges: [RESULT] }).status).toBe("unverified");
  });
});
