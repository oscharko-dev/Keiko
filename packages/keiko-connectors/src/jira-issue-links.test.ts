import { describe, expect, it } from "vitest";
import type { JiraFieldMetadata } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import {
  JIRA_ISSUE_LINKS_MAX,
  isJiraIssueLinkWrite,
  jiraIssueLinkAccount,
  jiraIssueLinkBody,
  jiraIssueLinkUpdate,
  jiraIssueLinksPresent,
  orderedJiraIssueLinks,
  parseJiraIssueLinks,
  planJiraIssueLinks,
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
      jiraIssueLinkUpdate([LINKS], [{ type: "Blocks", direction: "outward", issueKey: "REQ-2" }]),
    ).toEqual({
      ok: true,
      update: [{ add: { type: { name: "Blocks" }, outwardIssue: { key: "REQ-2" } } }],
    });
    expect(
      jiraIssueLinkUpdate([LINKS], [{ type: "Relates", direction: "inward", issueKey: "REQ-3" }]),
    ).toEqual({
      ok: true,
      update: [{ add: { type: { name: "Relates" }, inwardIssue: { key: "REQ-3" } } }],
    });
  });

  it("refuses a second operation, which Jira Data Center and Cloud both reject", () => {
    expect(
      jiraIssueLinkUpdate(
        [LINKS],
        [
          { type: "Blocks", direction: "outward", issueKey: "REQ-2" },
          { type: "Relates", direction: "inward", issueKey: "REQ-3" },
        ],
      ),
    ).toEqual({
      ok: false,
      reason: "field-validation",
      detail: { fieldId: "issuelinks", validation: "bounds-exceeded" },
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

  it("reads a symmetric link type on either side, as a lab Data Center lists a Relates link", () => {
    const relates = { name: "Relates", inward: "relates to", outward: "relates to" };
    const flipped = [{ id: "1", type: relates, inwardIssue: { key: "REQ-2" } }];
    const request = { type: "Relates", direction: "outward", issueKey: "REQ-2" } as const;
    expect(jiraIssueLinksPresent(flipped, [request])).toBe(true);
    expect(jiraIssueLinksPresent(flipped, [{ ...request, issueKey: "REQ-3" }])).toBe(false);
    // An asymmetric type still has a direction.
    const blocks = { name: "Blocks", inward: "is blocked by", outward: "blocks" };
    expect(
      jiraIssueLinksPresent(
        [{ id: "2", type: blocks, inwardIssue: { key: "REQ-2" } }],
        [{ type: "Blocks", direction: "outward", issueKey: "REQ-2" }],
      ),
    ).toBe(false);
  });

  it("treats a missing or malformed value as not present", () => {
    expect(jiraIssueLinksPresent(undefined, [blocks])).toBe(false);
    expect(jiraIssueLinksPresent("links", [blocks])).toBe(false);
    expect(jiraIssueLinksPresent(undefined, [])).toBe(true);
  });
});

const REQUESTS = ["REQ-2", "REQ-3", "REQ-4"].map((issueKey) => ({
  type: "Relates",
  direction: "outward" as const,
  issueKey,
}));

describe("planJiraIssueLinks", () => {
  it("keeps at most one link for the request itself and routes the rest to separate calls", () => {
    const plan = planJiraIssueLinks(REQUESTS);
    expect(plan.present).toEqual([]);
    expect(plan.inline).toEqual(REQUESTS.slice(0, 1));
    expect(plan.further).toEqual(REQUESTS.slice(1));
    expect(orderedJiraIssueLinks(plan)).toEqual(REQUESTS);
  });

  it("never writes a link the issue already has, whatever the case of its type or key", () => {
    const existing = [
      { id: "1", type: { name: "relates" }, outwardIssue: { key: "req-3" } },
      { id: "2", type: { name: "Relates" }, inwardIssue: { key: "REQ-4" } },
    ];
    const plan = planJiraIssueLinks(REQUESTS, existing);
    expect(plan.present).toEqual([REQUESTS[1]]);
    expect(plan.inline).toEqual([REQUESTS[0]]);
    expect(plan.further).toEqual([REQUESTS[2]]);
    expect(orderedJiraIssueLinks(plan)).toEqual([REQUESTS[1], REQUESTS[0], REQUESTS[2]]);
  });

  it("plans nothing for no links", () => {
    expect(planJiraIssueLinks([])).toEqual({ present: [], inline: [], further: [] });
  });
});

describe("jiraIssueLinkBody", () => {
  it("makes the inward issue the source: an outward link has this issue there", () => {
    expect(
      jiraIssueLinkBody("REQ-1", { type: "Blocks", direction: "outward", issueKey: "REQ-2" }),
    ).toEqual({
      type: { name: "Blocks" },
      inwardIssue: { key: "REQ-1" },
      outwardIssue: { key: "REQ-2" },
    });
    expect(
      jiraIssueLinkBody("REQ-1", { type: "Blocks", direction: "inward", issueKey: "REQ-2" }),
    ).toEqual({
      type: { name: "Blocks" },
      inwardIssue: { key: "REQ-2" },
      outwardIssue: { key: "REQ-1" },
    });
  });
});

describe("isJiraIssueLinkWrite", () => {
  it.each([
    ["POST", "https://jira.example.invalid/rest/api/2/issueLink", true],
    ["POST", "https://jira.example.invalid/context/rest/api/2/issueLink", true],
    ["PUT", "https://jira.example.invalid/rest/api/2/issueLink", false],
    ["POST", "https://jira.example.invalid/rest/api/2/issue", false],
    ["POST", "https://jira.example.invalid/rest/api/2/issueLinkType", false],
    ["POST", "https://jira.example.invalid/rest/api/2/issue/REQ-1/issueLink", false],
    ["POST", "not a url", false],
  ])("%s %s -> %s", (method, url, expected) => {
    expect(isJiraIssueLinkWrite({ method, url })).toBe(expected);
  });
});

describe("jiraIssueLinkAccount", () => {
  it("names the requested links that are not on the issue", () => {
    const current = [{ id: "1", type: { name: "Relates" }, outwardIssue: { key: "REQ-2" } }];
    expect(jiraIssueLinkAccount(REQUESTS, current, 3)).toEqual({
      requested: 3,
      created: 1,
      missing: REQUESTS.slice(1),
      unconfirmed: false,
    });
  });

  it("reports the links it could not confirm when the issue could not be read back", () => {
    expect(jiraIssueLinkAccount(REQUESTS, undefined, 2)).toEqual({
      requested: 3,
      created: 2,
      missing: REQUESTS.slice(2),
      unconfirmed: true,
    });
    expect(jiraIssueLinkAccount(REQUESTS, undefined, 99).missing).toEqual([]);
  });
});
