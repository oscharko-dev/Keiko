const issue = "/rest/api/2/issue/{issueKey}";
const sprint1 = "/rest/agile/1.0/sprint/{sprint1Id}";
const sprint2 = "/rest/agile/1.0/sprint/{sprint2Id}";
const signature = (method, path) => ({ method, path });
const row = (id, title, operations, wireSignatures = []) => ({
  id,
  title,
  operations,
  expectedWrites: wireSignatures.length,
  wireSignatures,
});
const post = (path) => signature("POST", path);
const put = (path) => signature("PUT", path);
const remove = (path) => signature("DELETE", path);
export const ROLE_STEP_CATALOG = {
  projectLead: [
    row("PL1", "Create the first sprint", ["jira.sprint-create"], [post("/rest/agile/1.0/sprint")]),
    row("PL2", "Rename the sprint and change its goal", ["jira.sprint-update"], [post(sprint1)]),
    row(
      "PL3",
      "Create the second sprint",
      ["jira.sprint-create"],
      [post("/rest/agile/1.0/sprint")],
    ),
    row("PL4", "Plan four stories", ["jira.sprint-move-issues"], [post(`${sprint1}/issue`)]),
    row(
      "PL5",
      "Rank one story before another",
      ["jira.rank-issues"],
      [put("/rest/agile/1.0/issue/rank")],
    ),
    row(
      "PL6",
      "Create version 1.0 and assign three stories",
      ["jira.create-version", "jira.edit"],
      [post("/rest/api/2/version"), put(issue), put(issue), put(issue)],
    ),
    row("PL7", "Start the first sprint", ["jira.sprint-update"], [post(sprint1)]),
    row(
      "PL8",
      "Complete the sprint and move unfinished work",
      ["jira.sprint-update", "jira.sprint-move-issues"],
      [post(sprint1), post(`${sprint2}/issue`)],
    ),
    row(
      "PL9",
      "Release version 1.0",
      ["jira.update-version"],
      [put("/rest/api/2/version/{versionId}")],
    ),
    row("PL10", "Read the sprint report", ["jira.search", "jira.report"]),
    row(
      "PL11",
      "Create and delete an empty sprint",
      ["jira.sprint-create", "jira.delete-sprint"],
      [post("/rest/agile/1.0/sprint"), remove("/rest/agile/1.0/sprint/{createdSprintId}")],
    ),
  ],
  developer: [
    row("Dev1", "Read my current sprint issues", ["jira.search", "jira.report"]),
    row("Dev2", "Assign a story to myself", ["jira.assign"], [put(`${issue}/assignee`)]),
    row("Dev3", "Start the story", ["jira.transition"], [post(`${issue}/transitions`)]),
    row(
      "Dev4",
      "Log two hours",
      ["jira.create-worklog"],
      [post("/rest/api/2/issue/{issueId}/worklog?adjustEstimate=leave")],
    ),
    row("Dev5", "Comment on the story", ["jira.comment"], [post(`${issue}/comment`)]),
    row("Dev6", "Create a subtask", ["jira.create"], [post("/rest/api/2/issue")]),
    row(
      "Dev7",
      "Create a blocking bug",
      ["jira.create", "jira.create-issue-link"],
      [post("/rest/api/2/issue"), post("/rest/api/2/issueLink")],
    ),
    row(
      "Dev8",
      "Finish the story with a resolution",
      ["jira.transition"],
      [post(`${issue}/transitions`)],
    ),
    row("Dev9", "Watch the story", ["jira.watch"], [post("/rest/api/2/issue/{issueId}/watchers")]),
    row("Dev10", "Attempt to delete the future sprint", ["jira.delete-sprint"], [remove(sprint2)]),
  ],
  techLead: [
    row(
      "TL1",
      "Create the Backend component",
      ["jira.create-component"],
      [post("/rest/api/2/component")],
    ),
    row(
      "TL2",
      "Assign the component to three stories",
      ["jira.edit"],
      [put(issue), put(issue), put(issue)],
    ),
    row(
      "TL3",
      "Link two stories with a blocking dependency",
      ["jira.create-issue-link"],
      [post("/rest/api/2/issueLink")],
    ),
    row("TL4", "Read blocked issues", ["jira.search", "jira.report"]),
    row("TL5", "Label two stories as tech debt", ["jira.edit"], [put(issue), put(issue)]),
    row(
      "TL6",
      "Move a story to the other epic",
      ["jira.epic-move-issues"],
      [post("/rest/agile/1.0/epic/{epicId}/issue")],
    ),
    row("TL7", "Estimate three stories", ["jira.edit"], [put(issue), put(issue), put(issue)]),
    row("TL8", "Read unfinished version work", ["jira.search", "jira.report"]),
    row(
      "TL9",
      "Attach the pull request",
      ["jira.upsert-remote-link"],
      [post("/rest/api/2/issue/{issueId}/remotelink")],
    ),
  ],
};
export const ROLE_STEP_IDS = Object.fromEntries(
  Object.entries(ROLE_STEP_CATALOG).map(([role, rows]) => [role, rows.map(({ id }) => id)]),
);
