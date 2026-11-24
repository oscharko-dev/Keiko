// Owner decision 2026-11-24: a person may take up to an hour to decide a Jira write approval.
export const ATLASSIAN_ACTION_APPROVAL_TTL_MS = 3_600_000;
export const ATLASSIAN_ACTION_APPROVAL_MAX_PENDING = 64;
// Owner decision 2026-11-24: a Jira read or report may take a minute (was 15 s and 30 s), the most
// the HTTP port admits for one request.
export const JIRA_READ_DURATION_MS = 60_000;
