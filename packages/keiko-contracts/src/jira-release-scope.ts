/**
 * Release scope of the Jira Pod. Release 1 leaves attachments out (owner decision, 2026-11-13): the
 * two attachment operations stay in the code and in the registry, but they are neither offered to a
 * model nor executed. Release 2 brings them back by setting `JIRA_ATTACHMENTS_AVAILABLE` to true;
 * nothing else has to change. A single switch, read by every layer that lists or runs an operation.
 */
export const JIRA_ATTACHMENTS_AVAILABLE = false as boolean;

/** The operations the switch governs. */
export const JIRA_ATTACHMENT_OPERATIONS = ["jira.attach", "jira.delete-attachment"] as const;
export type JiraAttachmentOperation = (typeof JIRA_ATTACHMENT_OPERATIONS)[number];

/** What a person or model is told when an operation of this release scope is called anyway. */
export const JIRA_ATTACHMENTS_UNAVAILABLE_MESSAGE =
  "Attachments are not part of this release, so nothing was changed in Jira. " +
  "Describe the file in a comment instead, or add it in Jira itself.";

/** Whether the operation is part of the Release 1 scope: false only for a switched-off attachment. */
export function jiraOperationInReleaseScope(operation: string): boolean {
  return (
    JIRA_ATTACHMENTS_AVAILABLE ||
    !(JIRA_ATTACHMENT_OPERATIONS as readonly string[]).includes(operation)
  );
}

/**
 * Whether a failure carries this release switch's own refusal of the operation: an operation the
 * switch withholds and the refusal sentence only the switch writes. Any other failure of such an
 * operation is some other refusal and is not labelled as the switch's.
 */
export function isJiraReleaseScopeRefusal(operation: string, messages: unknown): boolean {
  return (
    !jiraOperationInReleaseScope(operation) &&
    Array.isArray(messages) &&
    messages.includes(JIRA_ATTACHMENTS_UNAVAILABLE_MESSAGE)
  );
}
