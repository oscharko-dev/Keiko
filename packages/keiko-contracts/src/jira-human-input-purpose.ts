/** Closed native purposes that may request a human-only value. */
export const JIRA_HUMAN_INPUT_PURPOSES = [
  "update-myself", "update-my-password", "update-user-password", "validate-create-user-password",
  "validate-update-user-password", "validate-license", "login", "unlock-user-anonymization",
] as const;
export type JiraHumanInputPurpose = (typeof JIRA_HUMAN_INPUT_PURPOSES)[number];
