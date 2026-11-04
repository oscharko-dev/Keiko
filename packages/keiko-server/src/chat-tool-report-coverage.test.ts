import { describe, expect, it } from "vitest";
import type { ChatToolExchange } from "@oscharko-dev/keiko-contracts/bff-wire";
import {
  omittedReportFindingKeys,
  reportCoverageCorrection,
  reportCoverageMismatches,
  reportFindingCorrection,
  unsupportedIssueKeyCorrection,
  unsupportedIssueKeys,
} from "./chat-tool-report-coverage.js";

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

function jiraExchange(
  tool: string,
  args: Record<string, unknown>,
  data: Record<string, unknown>,
  status = "completed",
): ChatToolExchange {
  return {
    call: { id: `call-${tool}`, name: tool.replace(".", "_"), arguments: args },
    result: {
      schemaVersion: 1,
      invocationId: `invocation-${tool}`,
      toolRef: { canonicalId: `keiko.${tool}`, contractVersion: 1 },
      status,
      reason: "none",
      effectStarted: true,
      data,
    },
  } as unknown as ChatToolExchange;
}

// S01 of epic #4173: Qwen answered "successfully created … REQ-42" after three refused creates.
describe("unsupportedIssueKeys", () => {
  const projects = jiraExchange(
    "jira.projects",
    {},
    {
      outcome: "succeeded",
      items: [{ id: "10100", key: "REQ", name: "Anforderungen" }],
    },
  );
  const refused = jiraExchange(
    "jira.create",
    { projectId: "10100", fields: { summary: "[LH-004] Anmeldung", description: "LH-004" } },
    { outcome: "rejected", reason: "field-validation" },
    "failed",
  );

  it("names a key of the turn's project that no tool result and no message shows", () => {
    expect(
      unsupportedIssueKeys(
        [projects, refused],
        ["Lege für LH-004 ein Epic an."],
        "Angelegt: REQ-42",
      ),
    ).toEqual(["REQ-42"]);
  });

  it("accepts keys a tool result, a call or an earlier message shows", () => {
    const created = jiraExchange("jira.create", {}, { outcome: "succeeded", key: "REQ-43" });
    const read = jiraExchange("jira.issue", { issueKey: "REQ-7" }, { outcome: "succeeded" });
    expect(
      unsupportedIssueKeys(
        [projects, created, read],
        ["Earlier answer: REQ-5 was created."],
        "REQ-43 is new; REQ-7 and REQ-5 already existed.",
      ),
    ).toEqual([]);
  });

  it("accepts every key inside a compact draft range, and nothing outside it", () => {
    const draft = jiraExchange(
      "jira.draft",
      {},
      {
        outcome: "succeeded",
        createdRanges: ["SYN-1..SYN-1200"],
      },
    );
    expect(unsupportedIssueKeys([draft], [], "SYN-1, SYN-640 and SYN-1200")).toEqual([]);
    expect(unsupportedIssueKeys([draft], [], "SYN-1201")).toEqual(["SYN-1201"]);
  });

  it("never judges keys of other shapes or projects, or a turn without a Jira tool", () => {
    // LH-004 is a requirement id the model wrote into a description, not a Jira key field.
    expect(
      unsupportedIssueKeys([projects, refused], [], "LH-099, UTF-8, ISO-29148 and REQ-"),
    ).toEqual([]);
    const knowledge = {
      ...projects,
      result: { ...projects.result, toolRef: { canonicalId: "keiko.knowledge.requirements" } },
    } as unknown as ChatToolExchange;
    expect(unsupportedIssueKeys([knowledge], [], "REQ-42")).toEqual([]);
    expect(unsupportedIssueKeys([], [], "REQ-42")).toEqual([]);
  });

  it("learns the project from issue keys in key fields, and names each key once", () => {
    const search = jiraExchange(
      "jira.search",
      {},
      {
        outcome: "succeeded",
        items: [{ key: "RPT-1" }, { issueKey: "RPT-2" }],
      },
    );
    expect(unsupportedIssueKeys([search], [], "RPT-1, RPT-9, RPT-9 and RPT-2")).toEqual(["RPT-9"]);
  });
});

it("asks for an answer with only shown keys in one fixed sentence", () => {
  expect(unsupportedIssueKeyCorrection(["REQ-42"])).toBe(
    "Your answer names 1 issue key(s) that no tool result of this turn and no earlier message " +
      "contains: REQ-42. No tool created or read them. Answer again and name only issue keys a " +
      "tool result shows. If a change was refused, either correct the call as the tool result " +
      "states and call the tool again, or say that nothing was created and give the reason the " +
      "tool result states.",
  );
});

function requirementPage(
  items: readonly Record<string, unknown>[],
  canonicalId = "keiko.jira.report",
  status = "completed",
): ChatToolExchange {
  return {
    call: { id: "call-requirements", name: "jira_report", arguments: { section: "requirements" } },
    result: {
      schemaVersion: 1,
      invocationId: "invocation-requirements",
      toolRef: { canonicalId, contractVersion: 1 },
      status,
      reason: "none",
      effectStarted: true,
      data: {
        outcome: "succeeded",
        section: { name: "requirements", startAt: 0, total: items.length, items },
      },
    },
  } as unknown as ChatToolExchange;
}

const covered = (id: string, keys: readonly string[]): Record<string, unknown> => ({
  id,
  covered: true,
  coveredBy: keys,
  coveredByTotal: keys.length,
});

// S12 of epic #4173: Qwen's coverage matrix gave eight of 41 requirements a key that fit the
// numbering (LH-011 -> RPT-10) or swapped one (LH-021: RPT-20 for RPT-19), not what the report said.
describe("reportCoverageMismatches", () => {
  const page = requirementPage([
    covered("LH-001", ["RPT-1", "RPT-38"]),
    { id: "LH-010", covered: false },
    covered("LH-011", ["RPT-65", "RPT-66", "RPT-67"]),
    covered("LH-021", ["RPT-19", "RPT-92"]),
  ]);

  it("names each requirement whose line adds, swaps or drops a key, with the report's keys", () => {
    const answer = [
      "LH-001;ABGEDECKT;RPT-1, RPT-38",
      "LH-010;OFFEN;",
      "LH-011;ABGEDECKT;RPT-10, RPT-65, RPT-66, RPT-67",
      "| LH-021 | RPT-20, RPT-92 |",
    ].join("\n");
    expect(reportCoverageMismatches([page], answer)).toEqual([
      { id: "LH-011", keys: ["RPT-65", "RPT-66", "RPT-67"] },
      { id: "LH-021", keys: ["RPT-19", "RPT-92"] },
    ]);
    expect(reportCoverageMismatches([page], "LH-001: RPT-1")).toEqual([
      { id: "LH-001", keys: ["RPT-1", "RPT-38"] },
    ]);
  });

  it("flags issues given to a requirement the report leaves uncovered", () => {
    expect(reportCoverageMismatches([page], "LH-010 is covered by RPT-5")).toEqual([
      { id: "LH-010", keys: [] },
    ]);
  });

  it("accepts the report's keys in any order and judges no line without one requirement and a key", () => {
    const answer = [
      "LH-011: RPT-67, RPT-66, RPT-65 (three tasks)",
      "LH-010 is not covered.",
      "LH-001 and LH-011 share RPT-99.",
      "LH-0011 RPT-5",
      "Summary: 3 of 4 covered, see RPT-1.",
    ].join("\n");
    expect(reportCoverageMismatches([page], answer)).toEqual([]);
  });

  it("judges nothing from capped key lists, other tools, unfinished results or other sections", () => {
    const capped = requirementPage([
      { id: "LH-011", covered: true, coveredBy: ["RPT-65"], coveredByTotal: 3 },
    ]);
    const answer = "LH-011;ABGEDECKT;RPT-10";
    expect(reportCoverageMismatches([capped], answer)).toEqual([]);
    expect(
      reportCoverageMismatches(
        [requirementPage([covered("LH-011", ["RPT-65"])], "keiko.jira.search")],
        answer,
      ),
    ).toEqual([]);
    expect(
      reportCoverageMismatches(
        [requirementPage([covered("LH-011", ["RPT-65"])], "keiko.jira.report", "denied")],
        answer,
      ),
    ).toEqual([]);
    expect(reportCoverageMismatches([reportPage("deviations", ["RPT-65"])], answer)).toEqual([]);
  });
});

it("states the report's keys for each mismatched requirement in one fixed sentence", () => {
  expect(
    reportCoverageCorrection([
      { id: "LH-011", keys: ["RPT-65", "RPT-66"] },
      { id: "LH-020", keys: [] },
    ]),
  ).toBe(
    "Your answer gives 2 requirement(s) other issues than the jira.report requirements section " +
      "read in this turn states. The report states: LH-011: RPT-65, RPT-66; LH-020: no issue. " +
      "Answer again in full and give every requirement exactly the issues the report states for it.",
  );
  const many = Array.from({ length: 70 }, (_, index) => ({
    id: `LH-${String(index + 100)}`,
    keys: [`RPT-${String(index + 1)}`],
  }));
  const text = reportCoverageCorrection(many);
  expect(text).toContain("gives 70 requirement(s)");
  expect(text).toContain("LH-163: RPT-64; and 6 more.");
  expect(text).not.toContain("LH-164");
});
