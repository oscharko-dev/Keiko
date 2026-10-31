import { describe, expect, it } from "vitest";
import type { JiraFieldMetadata } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import {
  JIRA_ISSUE_LINKS_MAX,
  jiraIssueLinkUpdate,
  jiraIssueLinksPresent,
  parseJiraIssueLinks,
} from "./jira-issue-links.js";

const LINKS: JiraFieldMetadata = {
  id: "issuelinks",
  name: "Linked Issues",
  kind: "links",
  required: false,
  hasDefaultValue: false,
  operations: ["add"],
  richText: false,
};

describe("parseJiraIssueLinks", () => {
  it("treats an omitted argument as no links and collapses duplicates", () => {
    expect(parseJiraIssueLinks(undefined)).toEqual([]);
    expect(
      parseJiraIssueLinks([
        { type: "Blocks", direction: "outward", issueKey: "REQ-2" },
        { type: "BLOCKS", direction: "outward", issueKey: "req-2" },
        { type: "Blocks", direction: "inward", issueKey: "REQ-2" },
      ]),
    ).toHaveLength(2);
  });

  it.each([
    null,
    "REQ-2",
    [{}],
    [{ type: "", direction: "outward", issueKey: "REQ-2" }],
    [{ type: " ", direction: "outward", issueKey: "REQ-2" }],
    [{ type: "x".repeat(256), direction: "outward", issueKey: "REQ-2" }],
    [{ type: "Blocks\u0007", direction: "outward", issueKey: "REQ-2" }],
    [{ type: "Blocks", direction: "both", issueKey: "REQ-2" }],
    [{ type: "Blocks", direction: "outward", issueKey: "REQ-0" }],
    [{ type: "Blocks", direction: "outward", issueKey: "2-REQ" }],
    [{ type: "Blocks", direction: "outward", issueKey: "REQ-2", extra: 1 }],
  ])("refuses a malformed request %#", (value) => {
    expect(parseJiraIssueLinks(value)).toBeUndefined();
  });

  it("bounds the number of links", () => {
    const links = Array.from({ length: JIRA_ISSUE_LINKS_MAX + 1 }, (_, index) => ({
      type: "Relates",
      direction: "outward",
      issueKey: `REQ-${String(index + 1)}`,
    }));
    expect(parseJiraIssueLinks(links.slice(0, JIRA_ISSUE_LINKS_MAX))).toHaveLength(
      JIRA_ISSUE_LINKS_MAX,
    );
    expect(parseJiraIssueLinks(links)).toBeUndefined();
  });
});

describe("jiraIssueLinkUpdate", () => {
  it("maps each direction onto Jira's canonical add update", () => {
    expect(
      jiraIssueLinkUpdate(
        [LINKS],
        [
          { type: "Blocks", direction: "outward", issueKey: "REQ-2" },
          { type: "Relates", direction: "inward", issueKey: "REQ-3" },
        ],
      ),
    ).toEqual({
      ok: true,
      update: [
        { add: { type: { name: "Blocks" }, outwardIssue: { key: "REQ-2" } } },
        { add: { type: { name: "Relates" }, inwardIssue: { key: "REQ-3" } } },
      ],
    });
  });

  const unoffered: JiraFieldMetadata[][] = [
    [],
    [{ ...LINKS, operations: [] }],
    [{ ...LINKS, kind: "unsupported" }],
  ];
  it.each(unoffered.map((metadata) => [metadata]))(
    "refuses links current metadata does not offer %#",
    (metadata) => {
      expect(
        jiraIssueLinkUpdate(metadata, [
          { type: "Blocks", direction: "outward", issueKey: "REQ-2" },
        ]),
      ).toEqual({
        ok: false,
        reason: "field-validation",
        detail: { fieldId: "issuelinks", validation: "unsupported-field" },
      });
    },
  );
});

describe("jiraIssueLinksPresent", () => {
  const blocks = { type: "Blocks", direction: "outward", issueKey: "REQ-2" } as const;

  it("accepts a link only in its requested direction", () => {
    const current = [{ id: "1", type: { name: "blocks" }, outwardIssue: { key: "req-2" } }];
    expect(jiraIssueLinksPresent(current, [blocks])).toBe(true);
    expect(jiraIssueLinksPresent(current, [{ ...blocks, direction: "inward" }])).toBe(false);
    expect(jiraIssueLinksPresent(current, [{ ...blocks, type: "Relates" }])).toBe(false);
  });

  it("treats a missing or malformed value as not present", () => {
    expect(jiraIssueLinksPresent(undefined, [blocks])).toBe(false);
    expect(jiraIssueLinksPresent("links", [blocks])).toBe(false);
    expect(jiraIssueLinksPresent(undefined, [])).toBe(true);
  });
});
