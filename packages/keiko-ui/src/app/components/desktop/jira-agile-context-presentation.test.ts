import { describe, expect, it } from "vitest";
import { jiraAgileContextDetails } from "./jira-agile-context-presentation";

describe("saved Agile context observations", () => {
  it.each(["jira_board_projects", "jira_board_versions"])(
    "keeps %s empty visibility separate from board-wide absence",
    (tool) => {
      const scope =
        tool === "jira_board_projects" ? "visible-board-projects" : "visible-board-versions";
      const cards = jiraAgileContextDetails(tool, {
        boardId: "7",
        collectionScope: scope,
        items: [],
        total: 0,
      });
      expect(cards).toHaveLength(1);
      expect(cards[0]?.facts).toContainEqual({ label: "chat.jira.fact.boardId", value: "7" });
      expect(cards[0]?.labels).toContain("chat.jira.agileContext.visibleOnly");
    },
  );
  it("retains selected issue collection context without manufacturing an issue or link", () => {
    expect(
      jiraAgileContextDetails("jira_board_epic_issues", {
        boardId: "7",
        epicId: "11",
        collectionScope: "visible-board-issues",
        items: [],
      }),
    ).toEqual([
      {
        facts: [
          { label: "chat.jira.fact.boardId", value: "7" },
          { label: "chat.jira.agileContext.epicId", value: "11" },
        ],
        labels: ["chat.jira.agileContext.visibleBoardIssues", "chat.jira.agileContext.visibleOnly"],
      },
    ]);
  });
  it("reuses observed version dates and unknown release/archive state", () => {
    const cards = jiraAgileContextDetails("jira_board_versions", {
      items: [
        {
          versionId: "81",
          name: "Later",
          projectId: "10000",
          releaseDate: "2026-11-07",
          released: false,
          self: "https://untrusted.invalid/version/81",
        },
      ],
    });
    expect(cards[0]?.name).toBe("Later");
    expect(cards[0]?.facts).toContainEqual({
      label: "chat.jira.fact.releaseDate",
      value: "2026-11-07",
    });
    expect(cards[0]?.labels).toEqual([
      "chat.jira.metadata.archiveUnknown",
      "chat.jira.metadata.unreleased",
    ]);
    expect(JSON.stringify(cards)).not.toContain("untrusted.invalid");
  });
  it.each([0, 2.5, "unestimated"])(
    "keeps the native estimate %s without assigning units",
    (value) => {
      const cards = jiraAgileContextDetails("jira_issue_estimation", {
        boardId: "7",
        issueId: "10001",
        issueKey: "SYN-1",
        fieldId: "customfield_10001",
        value,
      });
      expect(cards[0]?.facts).toContainEqual({
        label: "chat.jira.agileContext.estimate",
        value: String(value),
      });
      expect(cards[0]?.labels).toEqual(["chat.jira.agileContext.estimateUnitUnknown"]);
    },
  );
  it("does not turn an absent estimate into zero", () => {
    const cards = jiraAgileContextDetails("jira_issue_estimation", {
      boardId: "7",
      fieldId: "customfield_10001",
    });
    expect(cards[0]?.facts.some(({ label }) => label === "chat.jira.agileContext.estimate")).toBe(
      false,
    );
    expect(cards[0]?.labels).toContain("chat.jira.agileContext.estimateUnknown");
  });
  it.each(["", "  "])("keeps blank native estimate text distinct from unknown", (value) => {
    const cards = jiraAgileContextDetails("jira_issue_estimation", {
      boardId: "7",
      fieldId: "customfield_10001",
      value,
    });
    expect(cards[0]?.labels).toEqual([
      "chat.jira.agileContext.estimateUnitUnknown",
      "chat.jira.agileContext.estimateBlank",
    ]);
  });
  it.each([
    [true, "refinedEnabled"],
    [false, "refinedDisabled"],
    [undefined, "refinedUnknown"],
  ] as const)("retains refined velocity %s independently", (value, suffix) => {
    expect(
      jiraAgileContextDetails("jira_board_refined_velocity", { boardId: "7", value })[0]?.labels,
    ).toEqual([`chat.jira.agileContext.${suffix}`]);
  });
});
