import { describe, expect, it, vi } from "vitest";
import {
  JIRA_ATTACHMENTS_AVAILABLE,
  JIRA_ATTACHMENTS_UNAVAILABLE_MESSAGE,
  JIRA_ATTACHMENT_OPERATIONS,
  jiraOperationInReleaseScope,
  type JiraMutationOperation,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { AtlassianHttpBodyPort } from "./atlassian-http-port.js";
import { checkJiraManagedMutation, executeJiraManagedMutation } from "./jira-managed-mutations.js";

// #4354, owner decision 2026-11-13: attachments are left out of Release 1 behind one switch. The
// code stays; the operations are neither offered nor executed.
const CONTEXT = {
  invocationId: "scope",
  correlationId: "scope",
  signal: new AbortController().signal,
  beforeEffect: (): boolean => true,
};
const ARGS: Record<(typeof JIRA_ATTACHMENT_OPERATIONS)[number], Record<string, unknown>> = {
  "jira.attach": { issueKey: "SYN-1", source: "folder", path: "notes.txt" },
  "jira.delete-attachment": { attachmentId: "10300", expectedFilename: "notes.txt" },
};

describe("the Release 1 scope switch for attachments", () => {
  it("is off, and names exactly the two attachment operations", () => {
    expect(JIRA_ATTACHMENTS_AVAILABLE).toBe(false);
    expect([...JIRA_ATTACHMENT_OPERATIONS]).toEqual(["jira.attach", "jira.delete-attachment"]);
    expect(jiraOperationInReleaseScope("jira.attach")).toBe(false);
    expect(jiraOperationInReleaseScope("jira.delete-attachment")).toBe(false);
    for (const operation of ["jira.create", "jira.comment", "jira.delete-comment", "jira.watch"])
      expect(jiraOperationInReleaseScope(operation)).toBe(true);
  });

  it.each(JIRA_ATTACHMENT_OPERATIONS)(
    "refuses %s with a readable message and sends no request, executing or checking",
    async (operation) => {
      const http = vi.fn<AtlassianHttpBodyPort>();
      const connection = {
        deployment: "data-center" as const,
        baseUrl: "https://jira.example.invalid/context",
        http,
      };
      const refusal = {
        ok: false,
        reason: "unavailable",
        detail: { messages: [JIRA_ATTACHMENTS_UNAVAILABLE_MESSAGE] },
      };
      const executed = await executeJiraManagedMutation(
        operation as JiraMutationOperation,
        ARGS[operation] as never,
        CONTEXT,
        connection,
      );
      expect(executed).toEqual(refusal);
      const checked = await checkJiraManagedMutation(
        operation as JiraMutationOperation,
        ARGS[operation] as never,
        CONTEXT,
        connection,
      );
      expect(checked).toMatchObject({ ok: false, reason: "unavailable" });
      expect(http).not.toHaveBeenCalled();
      expect(JIRA_ATTACHMENTS_UNAVAILABLE_MESSAGE).toMatch(/not part of this release/u);
    },
  );
});
