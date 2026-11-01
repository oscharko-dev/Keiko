import { describe, expect, it } from "vitest";
import type { ChatToolExchange } from "@oscharko-dev/keiko-contracts/bff-wire";
import {
  omittedReportFindingKeys,
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
      "contains: REQ-42. No tool created or read them. Answer again: name only issue keys a tool " +
      "result shows. If a change was refused, say that nothing was created and give the reason " +
      "the tool result states.",
  );
});
