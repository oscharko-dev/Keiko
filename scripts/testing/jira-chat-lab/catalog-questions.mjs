/** Human requests for the live read fixtures; exact arguments remain in the existing request owner. */
const READ_QUESTIONS = new Map([
  [
    "jira.projects",
    "Which Jira projects can I browse with this account? Give a short answer based on the returned list.",
  ],
  [
    "jira.issue-types",
    "Which issue types can I create in this Jira project? Briefly explain the available choices or the access limitation.",
  ],
  [
    "jira.create-fields",
    "Which fields are required when creating this Jira issue type? Briefly explain the returned requirements or the access limitation.",
  ],
  [
    "jira.edit-fields",
    "Which fields can my Jira account edit on this issue? Summarize the available fields briefly, and say explicitly if none are returned.",
  ],
  [
    "jira.search",
    "Which Jira issues match this search? Briefly list the matching issue keys, or say that none were found.",
  ],
  [
    "jira.issue",
    "What is the current status and summary of this Jira issue? Please give a short answer based on the issue you read.",
  ],
  [
    "jira.comments",
    "What comments are visible on this Jira issue? Summarize them briefly, or say that there are none.",
  ],
  [
    "jira.transitions",
    "Which workflow transitions are available to my Jira account for this issue? Name them briefly, or say that none are available.",
  ],
  [
    "jira.assignable-users",
    "Which users may be assigned to this Jira issue? Briefly describe the returned choices or the access error.",
  ],
]);

export function jiraReadQuestion(operation) {
  return READ_QUESTIONS.get(operation);
}
