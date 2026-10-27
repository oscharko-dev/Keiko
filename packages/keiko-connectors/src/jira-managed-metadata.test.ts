import { expect, it } from "vitest";
import { jiraMetadataPageLast, remoteJiraPage } from "./jira-managed-metadata.js";

it.each([
  { startAt: 0, maxResults: 2, isLast: false, total: 3 },
  { start: 0, size: 2, last: false, total: 3 },
])("normalizes a bounded nonterminal metadata page: %j", (body) => {
  expect(jiraMetadataPageLast(body, 2, 0, 2)).toBe(false);
  expect(remoteJiraPage(body, [{ id: "1" }, { id: "2" }], 0, 2)).toEqual({
    data: {
      outcome: "succeeded",
      items: [{ id: "1" }, { id: "2" }],
      startAt: 0,
      total: 3,
      nextStartAt: 2,
    },
  });
});

it("accepts the independently observed Jira10.3.26 terminal envelope", () => {
  const body = { startAt: 0, maxResults: 100, isLast: true, total: 2 };
  expect(jiraMetadataPageLast(body, 2, 0, 100)).toBe(true);
  expect(remoteJiraPage(body, [{ id: "1" }, { id: "2" }], 0, 100).data).not.toHaveProperty(
    "nextStartAt",
  );
});

it.each([
  { startAt: 1, maxResults: 100, isLast: true, total: 2 },
  { startAt: 0, maxResults: 1, isLast: true, total: 2 },
  { startAt: 0, maxResults: 101, isLast: true, total: 2 },
  { startAt: 0, maxResults: 100, isLast: "true", total: 2 },
  { startAt: 0, maxResults: 100, isLast: true, total: 3 },
  { startAt: 0, maxResults: 100, isLast: false, total: 2 },
  { startAt: 0, maxResults: 100, total: 2 },
  { maxResults: 100, isLast: true, start: 0 },
  { startAt: 0, maxResults: 100, isLast: true, start: 0, size: 100, last: true },
  { startAt: 0, maxResults: 100, isLast: true, total: -1 },
])("rejects contradictory, incomplete or mixed metadata envelopes: %j", (body) => {
  expect(jiraMetadataPageLast(body, 2, 0, 100)).toBeUndefined();
});

it("rejects an empty nonterminal page without guessing continuation", () => {
  expect(
    jiraMetadataPageLast({ startAt: 0, maxResults: 100, isLast: false }, 0, 0, 100),
  ).toBeUndefined();
});
