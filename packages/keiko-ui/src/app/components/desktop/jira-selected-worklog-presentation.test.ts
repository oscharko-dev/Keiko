import { expect, it } from "vitest";
import type { ChatToolExchange } from "@oscharko-dev/keiko-contracts/bff-wire";
import { jiraSelectedWorklogDetails as details } from "./jira-selected-worklog-presentation";
import { jiraToolOutcomeView } from "./jira-tool-outcome";

it("reuses worklog cards while retaining only the requested visible selection scope", () => {
  const cards = details("jira_worklogs_by_id", {
    outcome: "succeeded",
    selectionScope: "native-visible-requested-worklogs",
    requestedCount: 3,
    returnedCount: 2,
    unreturnedWorklogIds: ["103"],
    items: [
      {
        id: "101",
        issueKey: "SYN-1",
        timeSpentSeconds: 0,
        comment: "Observed work",
        authorName: "Native author",
        started: "Native time",
      },
      { id: "102", issueKey: "SYN-1" },
    ],
  });
  expect(cards).toHaveLength(3);
  expect(cards[0]?.labels).toEqual([
    "chat.jira.selectedWorklogs.scope",
    "chat.jira.selectedWorklogs.unreturnedMeaning",
  ]);
  expect(cards[0]?.facts).toContainEqual({
    label: "chat.jira.selectedWorklogs.unreturnedIds",
    value: "103",
  });
  expect(cards[1]).toMatchObject({ name: "Native author", body: "Observed work" });
  expect(cards[1]?.facts).toEqual(
    expect.arrayContaining([
      { label: "chat.jira.fact.issue", value: "SYN-1" },
      { label: "chat.jira.fact.worklogId", value: "101" },
      { label: "chat.jira.fact.timeSpentSeconds", value: "0" },
    ]),
  );
  expect(cards[2]?.facts.some((entry) => entry.label === "chat.jira.fact.timeSpentSeconds")).toBe(
    false,
  );
});
it("distinguishes an empty selected result from missing counters and an unknown collection", () => {
  const empty = details("jira_worklogs_by_id", {
    outcome: "succeeded",
    requestedCount: 1,
    returnedCount: 0,
    unreturnedWorklogIds: ["101"],
    items: [],
  });
  expect(empty[0]?.facts).toContainEqual({
    label: "chat.jira.selectedWorklogs.returnedCount",
    value: "0",
  });
  const unknown = details("jira_worklogs_by_id", { outcome: "succeeded" });
  expect(unknown[0]?.labels).toEqual(
    expect.arrayContaining([
      "chat.jira.selectedWorklogs.returnedUnknown",
      "chat.jira.selectedWorklogs.requestedUnknown",
      "chat.jira.selectedWorklogs.itemsUnknown",
    ]),
  );
});
it("does not infer a total or drop multiple selected worklogs belonging to one issue", () => {
  const exchange: ChatToolExchange = {
    call: {
      id: "selected-worklogs",
      name: "jira_worklogs_by_id",
      arguments: { worklogIds: ["101", "102"] },
    },
    result: {
      schemaVersion: 1,
      invocationId: "selected-worklogs",
      toolRef: null,
      projectionDigest: null,
      effectStarted: false,
      metrics: { inputBytes: 20, outputBytes: 100, resultCount: 2, durationMs: 10 },
      status: "completed",
      reason: "none",
      page: { truncated: false, reason: "none", cursor: null },
      data: {
        outcome: "succeeded",
        requestedCount: 2,
        returnedCount: 2,
        unreturnedWorklogIds: [],
        total: 9000,
        items: [
          { id: "101", issueKey: "SYN-1" },
          { id: "102", issueKey: "SYN-1" },
        ],
      },
    },
  };
  const view = jiraToolOutcomeView(exchange);
  expect(view.total).toBeUndefined();
  expect(view.returnedCount).toBe(2);
  expect(
    view.items
      .flatMap((item) => item.facts)
      .filter((entry) => entry.label === "chat.jira.fact.worklogId")
      .map((entry) => entry.value),
  ).toEqual(["101", "102"]);
});
it("does not render stale worklog details as a successful failed read", () => {
  expect(
    details("jira_worklogs_by_id", { outcome: "failed", items: [{ id: "101", comment: "stale" }] }),
  ).toEqual([]);
});
