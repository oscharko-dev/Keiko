import { describe, expect, it } from "vitest";
import { jiraWorklogFeedDetails as details } from "./jira-worklog-feed-presentation";

describe("native worklog change window presentation", () => {
  it("retains exact cursors, equal-time changes and the explicit native window limits", () => {
    const cards = details("jira_updated_worklogs", {
      outcome: "succeeded",
      since: "0",
      until: "9223372036854775807",
      isLastPage: false,
      nextSince: "9223372036854775807",
      items: [
        { worklogId: "9223372036854775807", changedAt: "0" },
        { worklogId: "9", changedAt: "0" },
      ],
      total: 999,
      nextPage: "https://untrusted.invalid/next",
    });
    expect(cards[0]?.facts).toEqual([
      { label: "chat.jira.worklogFeed.since", value: "0" },
      { label: "chat.jira.worklogFeed.until", value: "9223372036854775807" },
      { label: "chat.jira.worklogFeed.nextSince", value: "9223372036854775807" },
    ]);
    expect(cards[0]?.labels).toEqual(
      expect.arrayContaining([
        "chat.jira.worklogFeed.scope",
        "chat.jira.worklogFeed.latestMinute",
        "chat.jira.worklogFeed.morePages",
        "chat.jira.worklogFeed.inclusiveCursor",
      ]),
    );
    expect(cards[1]?.facts).toContainEqual({
      label: "chat.jira.fact.worklogId",
      value: "9223372036854775807",
    });
    expect(cards[2]?.facts).toContainEqual({
      label: "chat.jira.worklogFeed.changedAt",
      value: "0",
    });
  });
  it("does not turn a terminal empty window into all-history completeness", () => {
    const cards = details("jira_deleted_worklogs", {
      outcome: "succeeded",
      since: "0",
      until: "0",
      isLastPage: true,
      items: [],
      nextSince: "2",
    });
    expect(cards[0]?.labels).toEqual(
      expect.arrayContaining([
        "chat.jira.worklogFeed.lastPage",
        "chat.jira.worklogFeed.emptyWindow",
        "chat.jira.worklogFeed.scope",
      ]),
    );
    expect(cards[0]?.facts.some((entry) => entry.label === "chat.jira.worklogFeed.nextSince")).toBe(
      false,
    );
  });
  it("does not invent missing cursor, page, collection or change identities", () => {
    const cards = details("jira_updated_worklogs", { outcome: "succeeded" });
    expect(cards[0]?.facts).toEqual([]);
    expect(cards[0]?.labels).toEqual(
      expect.arrayContaining([
        "chat.jira.worklogFeed.pageUnknown",
        "chat.jira.worklogFeed.listUnknown",
      ]),
    );
    expect(
      details("jira_updated_worklogs", { outcome: "succeeded", isLastPage: false })[0]?.labels,
    ).toContain("chat.jira.worklogFeed.cursorUnknown");
    expect(
      details("jira_updated_worklogs", {
        outcome: "succeeded",
        items: [{ worklogId: 7, changedAt: 0 }],
      })[1],
    ).toEqual({ facts: [], labels: ["chat.jira.worklogFeed.changeUnknown"] });
    expect(details("jira_updated_worklogs", { outcome: "failed" })).toEqual([]);
    expect(details("jira_issue", { outcome: "succeeded" })).toEqual([]);
  });
});
