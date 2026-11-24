import { describe, expect, it } from "vitest";
import { ATLASSIAN_LIVE_SEARCH_TIMEOUT_MS } from "@oscharko-dev/keiko-connectors";
import { ATLASSIAN_HTTP_MAX_TIMEOUT_MS } from "./httpPort.js";
import { JIRA_READ_DURATION_MS } from "./actionApprovalLimits.js";
import { jiraReportDeclaration } from "./jiraReportDescriptor.js";

// Owner decision 2026-11-24: Jira reads and the report may take 60 s (were 15 s and 30 s), so a
// slow self-hosted Jira does not end a Chat turn; one request is still capped by the HTTP port.
describe("the time a Jira read may take", () => {
  it("is a minute and never exceeds the per-request ceiling of the HTTP port", () => {
    expect(JIRA_READ_DURATION_MS).toBe(60_000);
    expect(JIRA_READ_DURATION_MS).toBeLessThanOrEqual(ATLASSIAN_HTTP_MAX_TIMEOUT_MS);
    expect(ATLASSIAN_LIVE_SEARCH_TIMEOUT_MS).toBeLessThanOrEqual(ATLASSIAN_HTTP_MAX_TIMEOUT_MS);
  });
  it("gives the Jira report the same minute", () => {
    expect(jiraReportDeclaration().descriptor.bounds.maxDurationMs).toBe(JIRA_READ_DURATION_MS);
  });
});
