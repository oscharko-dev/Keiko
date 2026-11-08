import { expect, it } from "vitest";
import { executeJiraIssueTypeSchemeRead } from "./jira-managed-issue-type-schemes.js";
import { executeJiraPrioritySchemeRead } from "./jira-managed-priority-schemes.js";
import { optionSchemeFixture, ISSUE_SCHEME_REVIEW, PRIORITY_SCHEME_REVIEW } from "../../../tests/support/jira-option-scheme-fixture.js";
it("exposes the same strict issue-type review used by mutations", async () => {
  const native = optionSchemeFixture();
  expect(await executeJiraIssueTypeSchemeRead("jira.issue-type-scheme", { schemeId: "7" }, native.request)).toMatchObject({ data: {
    items: [{ reviewSnapshotAvailable: true, reviewSnapshot: ISSUE_SCHEME_REVIEW }],
  } });
});
it("exposes native false, exact option order and default in priority review", async () => {
  const native = optionSchemeFixture();
  expect(await executeJiraPrioritySchemeRead("jira.priority-scheme", { schemeId: "9" }, native.request)).toMatchObject({ data: {
    reviewSnapshotAvailable: true, reviewSnapshot: PRIORITY_SCHEME_REVIEW,
  } });
});
it("retains observed null description/default while keeping ordinary omitted metadata absent", async () => {
  const native = optionSchemeFixture(); const current = native.issueSchemes.get("7");
  if (current === undefined) throw new TypeError("Missing issue scheme");
  current.description = null; current.defaultIssueType = null;
  const result = await executeJiraIssueTypeSchemeRead("jira.issue-type-scheme", { schemeId: "7" }, native.request);
  expect(result).toMatchObject({ data: { items: [{ reviewSnapshotAvailable: true,
    reviewSnapshot: { description: null, defaultIssueTypeId: null, issueTypeIds: ["1", "2"] } }] } });
});
it.each(["description", "defaultIssueType", "issueTypes"])("does not invent review evidence when %s is omitted", async (field) => {
  const native = optionSchemeFixture(); const current = native.issueSchemes.get("7");
  if (current === undefined) throw new TypeError("Missing issue scheme"); delete current[field];
  const result = await executeJiraIssueTypeSchemeRead("jira.issue-type-scheme", { schemeId: "7" }, native.request);
  expect(result).toMatchObject({ data: { items: [{ reviewSnapshotAvailable: false }] } });
  const rows = result.data.items;
  if (!Array.isArray(rows)) throw new TypeError("Missing projected schemes");
  expect(rows[0]).not.toHaveProperty("reviewSnapshot");
});
it("does not infer the priority default-scheme flag", async () => {
  const native = optionSchemeFixture(); const current = native.prioritySchemes.get("9");
  if (current === undefined) throw new TypeError("Missing priority scheme"); delete current.defaultScheme;
  const result = await executeJiraPrioritySchemeRead("jira.priority-scheme", { schemeId: "9" }, native.request);
  expect(result).toMatchObject({ data: { reviewSnapshotAvailable: false } });
  expect(result.data).not.toHaveProperty("reviewSnapshot");
});
