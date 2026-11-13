// The legacy Jira write executors are retired (#4354, ADR-0128 "Templates are required to create"):
// `create-issue`, `update-issue-fields`, `transition-issue` and `add-issue-comment` created and
// changed issues through the Jira Cloud REST v3 shape with no saved-template gate, had no caller in
// the product, and Jira Cloud is outside the supported scope. Every Jira write now goes through the
// governed Jira tools and their one managed executor. What remains here is what the Confluence
// executors and the BFF's input validation share.

import type { AtlassianConnectorWriteFailureReason } from "@oscharko-dev/keiko-contracts";

export const JIRA_SUMMARY_MAX_CHARS = 255;
export const JIRA_ISSUE_LABELS_MAX_ENTRIES = 20;

// The shared typed failure arm every write executor returns. The reason vocabulary is the closed
// contract union, so the server's activity records and wire results carry these codes without
// re-mapping.
export interface AtlassianWriteActionFailure {
  readonly ok: false;
  readonly reason: AtlassianConnectorWriteFailureReason;
  readonly httpStatus?: number | undefined;
}
