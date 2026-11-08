import { describe, expect, it } from "vitest";
import {
  workflowUser,
  reviewWorkflowExchange,
} from "../testing/jira-chat-lab/browser-workflow-turn.mjs";

describe("Shared Jira live-browser turn boundary", () => {
  it("selects only the newly admitted user row, preserving earlier pending approvals as history", () => {
    const old = {
      id: "old",
      role: "user",
      toolTranscript: { exchanges: [{ approval: { state: "pending" } }] },
    };
    const current = { id: "current", role: "user", turnState: "pending" };
    expect(workflowUser([old, current], new Set([old.id]))).toBe(current);
    expect(workflowUser([old], new Set([old.id]))).toBeUndefined();
    expect(() => workflowUser([current, { id: "other", role: "user" }], new Set())).toThrow();
  });

  it("requires a visible pending approval for exactly the requested operation and its canonical alias", () => {
    const exchange = {
      call: { name: "jira_sprint_create" },
      approval: {
        operation: "jira.sprint-create",
        state: "pending",
        actionDigest: "synthetic-digest",
      },
    };
    expect(() => reviewWorkflowExchange(exchange, ["jira.sprint-create"])).not.toThrow();
    expect(() => reviewWorkflowExchange(exchange, ["jira.create-project"])).toThrow();
    expect(() =>
      reviewWorkflowExchange({ ...exchange, call: { name: "jira_delete_project" } }, [
        "jira.sprint-create",
      ]),
    ).toThrow();
    expect(() =>
      reviewWorkflowExchange(
        { ...exchange, approval: { ...exchange.approval, state: "approved" } },
        ["jira.sprint-create"],
      ),
    ).toThrow();
    expect(() =>
      reviewWorkflowExchange(
        { ...exchange, approval: { ...exchange.approval, actionDigest: undefined } },
        ["jira.sprint-create"],
      ),
    ).toThrow();
  });
});
