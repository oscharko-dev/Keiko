import { expect, it } from "vitest";
import {
  jiraIssueContextDetails as details,
  jiraIssuePickerGroups as picker,
  jiraPinnedCommentDetails as pinned,
} from "./jira-issue-context-presentation";

it("keeps picker sections and suggestions separate from created relationships", () => {
  const groups = picker({
    outcome: "succeeded",
    suggestionsScope: "native-suggestions",
    sections: [
      {
        id: "history",
        label: "Recent issues",
        issues: [
          {
            key: "SYN-2",
            summary: "Plain summary",
            browseUrl: "https://jira.example.test/context/browse/SYN-2",
          },
        ],
      },
      { id: "empty", issues: [] },
      { id: "unknown" },
    ],
  });
  expect(groups[0]?.details.labels).toContain("chat.jira.issueContext.suggestionsScope");
  expect(groups[1]?.details.facts).toContainEqual({
    label: "chat.jira.issueContext.sectionLabel",
    value: "Recent issues",
  });
  expect(groups[1]?.issues).toEqual([
    {
      key: "SYN-2",
      summary: "Plain summary",
      browseUrl: "https://jira.example.test/context/browse/SYN-2",
    },
  ]);
  expect(groups[2]?.details.labels).toContain("chat.jira.issueContext.suggestionsEmpty");
  expect(groups[3]?.details.labels).toContain("chat.jira.issueContext.suggestionsUnknown");
});
it("distinguishes missing and empty picker sections without inferring a total issue count", () => {
  expect(picker({ outcome: "succeeded" })[0]?.details.labels).toContain(
    "chat.jira.issueContext.sectionsUnknown",
  );
  expect(picker({ outcome: "succeeded", sections: [] })[0]?.details.labels).toContain(
    "chat.jira.issueContext.sectionsEmpty",
  );
  expect(picker({ outcome: "failed" })).toEqual([]);
});
it.each([true, false, undefined])(
  "describes native within-parent reordering=%s without reparenting authority",
  (canReorderSubtasks) => {
    const card = details("jira_subtask_move_availability", {
      outcome: "succeeded",
      issueId: "10001",
      issueKey: "SYN-1",
      canReorderSubtasks,
    })[0];
    expect(card?.facts).toContainEqual({ label: "chat.jira.fact.issue", value: "SYN-1" });
    expect(card?.labels).toContain("chat.jira.issueContext.reorderScope");
    expect(card?.labels).toContain(
      canReorderSubtasks === true
        ? "chat.jira.issueContext.reorderAllowed"
        : canReorderSubtasks === false
          ? "chat.jira.issueContext.reorderUnavailable"
          : "chat.jira.issueContext.reorderUnknown",
    );
  },
);
it("reuses comment details while preserving native pin metadata", () => {
  expect(
    pinned({
      id: "10002",
      body: "Pinned native text",
      created: "Native date",
      author: { name: "Synthetic", displayName: "Synthetic author" },
      pinnedBy: "Pin owner",
      pinnedDate: "Native pin date",
    }),
  ).toMatchObject({
    body: "Pinned native text",
    name: "Synthetic author",
    facts: expect.arrayContaining([
      { label: "chat.jira.fact.commentId", value: "10002" },
      { label: "chat.jira.issueContext.pinnedBy", value: "Pin owner" },
    ]),
    labels: ["chat.jira.issueContext.pinObservation"],
  });
});
it("shows remote link metadata as an observation and omits every native destination", () => {
  const cards = details("jira_remote_link", {
    outcome: "succeeded",
    issueId: "10001",
    issueKey: "SYN-1",
    id: "71",
    globalId: "app=synthetic&id=1",
    application: { type: "synthetic", name: "Reference app" },
    relationship: "references",
    title: "External title",
    summary: "External summary",
    resolved: false,
    url: "https://untrusted.invalid",
    self: "https://untrusted.invalid/self",
    icon: { url: "https://untrusted.invalid/icon" },
  });
  expect(cards[1]).toMatchObject({
    name: "External title",
    body: "External summary",
    labels: ["chat.jira.issueContext.linkObservation", "chat.jira.issueContext.notResolved"],
  });
  expect(JSON.stringify(cards)).not.toContain("untrusted.invalid");
  expect(details("jira_remote_links", { outcome: "succeeded", items: [] })[0]?.labels).toContain(
    "chat.jira.issueContext.linksEmpty",
  );
  expect(details("jira_remote_links", { outcome: "succeeded" })[0]?.labels).toContain(
    "chat.jira.issueContext.linksUnknown",
  );
  expect(details("jira_remote_links", { id: "71", resolved: false })[0]?.facts).toContainEqual({
    label: "chat.jira.fact.linkId",
    value: "71",
  });
});
it.each(["jira_pinned_comments", "jira_subtasks"])(
  "keeps unknown and empty %s collections distinct",
  (tool) => {
    expect(details(tool, { issueId: "10001", issueKey: "SYN-1" })[0]?.labels).toContain(
      "chat.jira.issueContext.collectionUnknown",
    );
    expect(details(tool, { issueId: "10001", issueKey: "SYN-1", items: [] })[0]?.labels).toContain(
      "chat.jira.issueContext.collectionEmpty",
    );
  },
);
