import { describe, expect, it } from "vitest";

import { createCodingJiraRunNames } from "./codingJiraWriteReview.js";

describe("the names a run's Jira reads gave its ids", () => {
  it("names the project by name and key, the issue type and the field, from the reads of the run", () => {
    const names = createCodingJiraRunNames();
    names.note("jira.projects", {
      items: [
        { id: "10002", key: "REQ", name: "Anforderungen" },
        { id: 7, name: "bad" },
      ],
    });
    names.note("jira_issue-types", { items: [{ id: "10003", name: "Task" }] });
    names.note("jira.create-fields", { items: [{ id: "customfield_1", name: "Team" }] });
    names.note("jira.issue", { items: [{ id: "99", name: "ignored" }] });

    expect(
      names.review({
        tool: "jira.create",
        arguments: { projectId: "10002", issueTypeId: "10003" },
      }),
    ).toEqual({
      tool: "jira.create",
      input: { projectId: "10002", issueTypeId: "10003" },
      names: {
        projects: [["10002", "Anforderungen (REQ)"]],
        issueTypes: [["10003", "Task"]],
        fields: [["customfield_1", "Team"]],
      },
    });
  });

  it("lets a later read of an id win and stays within its bound", () => {
    const names = createCodingJiraRunNames();
    names.note("jira.projects", { items: [{ id: "1", key: "A", name: "Old" }] });
    names.note("jira.projects", { items: [{ id: "1", key: "A", name: "Renamed" }] });
    for (let index = 2; index < 200; index += 1)
      names.note("jira.issue-types", { items: [{ id: String(index), name: `T${String(index)}` }] });
    const review = names.review({ tool: "jira.create", arguments: {} });
    expect(review.names.projects).toEqual([["1", "Renamed (A)"]]);
    expect(review.names.issueTypes).toHaveLength(64);
    expect(review.names.issueTypes.at(-1)).toEqual(["199", "T199"]);
  });
});
