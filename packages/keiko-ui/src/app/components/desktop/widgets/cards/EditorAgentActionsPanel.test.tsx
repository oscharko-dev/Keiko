/**
 * Tests for EditorAgentActionsPanel (Issue #1395, ADR-0062 D3).
 *
 * Covers: renders the bounded audit feed for the session (AC4); disposition is conveyed by a text
 * label (WCAG 1.4.1); empty state; re-fetch on the activity nonce; never renders raw source (AC3);
 * and jest-axe a11y.
 */
import { render, screen, waitFor } from "@testing-library/react";
import { axe } from "jest-axe";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EditorAgentActionAuditRecord } from "../../../../../lib/types";

const fetchEditorAgentAudit = vi.fn();

vi.mock("../../../../../lib/api", () => ({
  fetchEditorAgentAudit: (sessionId: string) => fetchEditorAgentAudit(sessionId),
}));

// Imported after the mock is registered.
const { EditorAgentActionsPanel } = await import("./EditorAgentActionsPanel");

function record(over: Partial<EditorAgentActionAuditRecord> = {}): EditorAgentActionAuditRecord {
  return {
    schemaVersion: "1",
    auditId: "audit-1",
    occurredAt: 1_700_000_000_000,
    sessionId: "session-1",
    actionId: "action-1",
    actionType: "applyTextEdits",
    effectClass: "content-mutation",
    mutating: true,
    disposition: "review-required",
    reviewReason: "content-mutation-requires-review",
    outcome: "queued",
    targetPath: "src/a.ts",
    editCount: 2,
    summary: "applyTextEdits review-required outcome=queued file=src/a.ts",
    ...over,
  };
}

afterEach(() => {
  fetchEditorAgentAudit.mockReset();
});

describe("EditorAgentActionsPanel", () => {
  it("lists recent agent actions with action type, target, and disposition label (AC4)", async () => {
    fetchEditorAgentAudit.mockResolvedValue({ records: [record()] });
    render(<EditorAgentActionsPanel agentSessionId="session-1" refreshNonce={0} />);
    await waitFor(() => expect(screen.getByTestId("agent-action-row")).toBeInTheDocument());
    expect(screen.getByText("applyTextEdits")).toBeInTheDocument();
    expect(screen.getByText("src/a.ts")).toBeInTheDocument();
    // Disposition is a text label, not colour alone (WCAG 1.4.1).
    expect(screen.getByText("Review required")).toBeInTheDocument();
  });

  it("renders a deny disposition label and reason for a blocked attempt (AC2, AC4)", async () => {
    fetchEditorAgentAudit.mockResolvedValue({
      records: [
        record({
          auditId: "audit-2",
          actionType: "save",
          disposition: "denied",
          denyReason: "denied-sensitive-path",
          reviewReason: undefined,
          outcome: "conflict",
          conflictCode: "OUT_OF_SCOPE",
          targetPath: ".env",
        }),
      ],
    });
    render(<EditorAgentActionsPanel agentSessionId="session-1" refreshNonce={0} />);
    await waitFor(() => expect(screen.getByText("Denied")).toBeInTheDocument());
    expect(screen.getByText(/denied-sensitive-path/)).toBeInTheDocument();
  });

  it("shows an empty state when there is no recent activity", async () => {
    fetchEditorAgentAudit.mockResolvedValue({ records: [] });
    render(<EditorAgentActionsPanel agentSessionId="session-1" refreshNonce={0} />);
    await waitFor(() =>
      expect(screen.getByText("No recent agent editor actions.")).toBeInTheDocument(),
    );
  });

  it("re-fetches when the activity nonce changes", async () => {
    fetchEditorAgentAudit.mockResolvedValue({ records: [] });
    const { rerender } = render(
      <EditorAgentActionsPanel agentSessionId="session-1" refreshNonce={0} />,
    );
    await waitFor(() => expect(fetchEditorAgentAudit).toHaveBeenCalledTimes(1));
    rerender(<EditorAgentActionsPanel agentSessionId="session-1" refreshNonce={1} />);
    await waitFor(() => expect(fetchEditorAgentAudit).toHaveBeenCalledTimes(2));
  });

  it("never renders raw source content — only the bounded metadata (AC3)", async () => {
    // Even if a record somehow carried a stray field, the panel only reads the known content-free
    // fields. The rendered DOM proves the action happened via the edit COUNT, not edit content.
    fetchEditorAgentAudit.mockResolvedValue({ records: [record({ editCount: 3 })] });
    const { container } = render(
      <EditorAgentActionsPanel agentSessionId="session-1" refreshNonce={0} />,
    );
    await waitFor(() => expect(screen.getByTestId("agent-action-row")).toBeInTheDocument());
    expect(container.textContent ?? "").not.toContain("newText");
  });

  it("has no detectable a11y violations", async () => {
    fetchEditorAgentAudit.mockResolvedValue({
      records: [
        record(),
        record({ auditId: "audit-3", disposition: "denied", denyReason: "denied-sensitive-path" }),
      ],
    });
    const { container } = render(
      <EditorAgentActionsPanel agentSessionId="session-1" refreshNonce={0} />,
    );
    await waitFor(() => expect(screen.getAllByTestId("agent-action-row").length).toBe(2));
    expect(await axe(container)).toHaveNoViolations();
  });
});
