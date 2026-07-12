/**
 * Tests for EditorAgentActionsPanel (Issues #1395 and #2120, ADR-0062 D3).
 *
 * Covers: renders the bounded audit feed for the session (AC4); disposition is conveyed by a text
 * label (WCAG 1.4.1); composable audit filters and live additions; empty state; re-fetch on the
 * activity nonce; never renders raw source (AC3); and jest-axe a11y.
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18N_STORAGE_KEY, I18nProvider } from "@/lib/i18n";
import type { EditorAgentActionAuditRecord } from "../../../../../lib/types";

const fetchEditorAgentAudit = vi.fn();
const NOW = 1_700_000_000_000;
const HOUR_MS = 60 * 60 * 1000;

vi.mock("../../../../../lib/api", () => ({
  fetchEditorAgentAudit: (sessionId: string) => fetchEditorAgentAudit(sessionId),
}));

// Imported after the mock is registered.
const { EditorAgentActionsPanel } = await import("./EditorAgentActionsPanel");

function record(over: Partial<EditorAgentActionAuditRecord> = {}): EditorAgentActionAuditRecord {
  return {
    schemaVersion: "1",
    auditId: "audit-1",
    occurredAt: NOW,
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
  vi.restoreAllMocks();
  window.localStorage.removeItem(I18N_STORAGE_KEY);
});

describe("EditorAgentActionsPanel", () => {
  it("localizes the audit controls and dispositions when German is selected", async () => {
    window.localStorage.setItem(I18N_STORAGE_KEY, "de");
    fetchEditorAgentAudit.mockResolvedValue({ records: [record()] });
    render(
      <I18nProvider>
        <EditorAgentActionsPanel agentSessionId="session-1" refreshNonce={0} />
      </I18nProvider>,
    );

    expect(
      await screen.findByRole("region", { name: "Letzte Agentenaktionen im Editor" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Aktionstyp" })).toHaveValue("all");
    expect(screen.getByRole("option", { name: "Alle Aktionstypen" })).toBeInTheDocument();
    expect(screen.getByText("Prüfung erforderlich")).toBeInTheDocument();
  });

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

  it("distinguishes a load failure from an empty feed (AC4)", async () => {
    fetchEditorAgentAudit.mockRejectedValue(new Error("network down"));
    render(<EditorAgentActionsPanel agentSessionId="session-1" refreshNonce={0} />);
    await waitFor(() => expect(screen.getByTestId("agent-actions-error")).toBeInTheDocument());
    expect(screen.getByText("Unable to load recent agent actions.")).toBeInTheDocument();
    expect(screen.queryByText("No recent agent editor actions.")).not.toBeInTheDocument();
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

  it("exposes independent accessible filters that default to all records", async () => {
    fetchEditorAgentAudit.mockResolvedValue({ records: [record()] });
    render(<EditorAgentActionsPanel agentSessionId="session-1" refreshNonce={0} />);
    await waitFor(() => expect(screen.getByTestId("agent-action-row")).toBeInTheDocument());

    expect(screen.getByRole("combobox", { name: "Action type" })).toHaveValue("all");
    expect(screen.getByRole("combobox", { name: "Disposition" })).toHaveValue("all");
    expect(screen.getByRole("combobox", { name: "Time range" })).toHaveValue("all");
    expect(screen.getByRole("option", { name: "All action types" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "All dispositions" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "All time" })).toBeInTheDocument();
  });

  it("filters records by action type", async () => {
    const user = userEvent.setup();
    fetchEditorAgentAudit.mockResolvedValue({
      records: [record(), record({ auditId: "audit-save", actionType: "save" })],
    });
    render(<EditorAgentActionsPanel agentSessionId="session-1" refreshNonce={0} />);
    await waitFor(() => expect(screen.getAllByTestId("agent-action-row")).toHaveLength(2));

    await user.selectOptions(screen.getByRole("combobox", { name: "Action type" }), "save");

    const row = screen.getByTestId("agent-action-row");
    expect(row).toHaveTextContent("save");
    expect(row).not.toHaveTextContent("applyTextEdits");
  });

  // Issue #2214 AC9 — an agent-triggered verification run renders through the generic actionType path
  // AND is selectable via the actionType filter, so a human can recognize and isolate it in the audit.
  it("renders and filters an agent-triggered requestVerification audit record", async () => {
    const user = userEvent.setup();
    fetchEditorAgentAudit.mockResolvedValue({
      records: [
        record(),
        record({
          auditId: "audit-verify",
          actionType: "requestVerification",
          effectClass: "execution",
          mutating: false,
          disposition: "allowed",
          reviewReason: undefined,
          outcome: "succeeded",
          summary: "requestVerification allowed outcome=succeeded",
        }),
      ],
    });
    render(<EditorAgentActionsPanel agentSessionId="session-1" refreshNonce={0} />);
    await waitFor(() => expect(screen.getAllByTestId("agent-action-row")).toHaveLength(2));

    expect(screen.getByRole("option", { name: "Request verification" })).toBeInTheDocument();
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Action type" }),
      "requestVerification",
    );

    const row = screen.getByTestId("agent-action-row");
    expect(row).toHaveTextContent("requestVerification");
    expect(row).not.toHaveTextContent("applyTextEdits");
  });

  it("filters records by the existing disposition vocabulary", async () => {
    const user = userEvent.setup();
    fetchEditorAgentAudit.mockResolvedValue({
      records: [
        record(),
        record({
          auditId: "audit-denied",
          disposition: "denied",
          denyReason: "denied-sensitive-path",
          reviewReason: undefined,
        }),
      ],
    });
    render(<EditorAgentActionsPanel agentSessionId="session-1" refreshNonce={0} />);
    await waitFor(() => expect(screen.getAllByTestId("agent-action-row")).toHaveLength(2));

    await user.selectOptions(screen.getByRole("combobox", { name: "Disposition" }), "denied");

    const row = screen.getByTestId("agent-action-row");
    expect(row).toHaveTextContent("Denied");
    expect(row).not.toHaveTextContent("Review required");
  });

  it("filters records by a deterministic time range", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const user = userEvent.setup();
    fetchEditorAgentAudit.mockResolvedValue({
      records: [
        record({ auditId: "audit-recent", actionType: "save", occurredAt: NOW - HOUR_MS / 2 }),
        record({ auditId: "audit-old", actionType: "applyPatch", occurredAt: NOW - HOUR_MS * 2 }),
      ],
    });
    render(<EditorAgentActionsPanel agentSessionId="session-1" refreshNonce={0} />);
    await waitFor(() => expect(screen.getAllByTestId("agent-action-row")).toHaveLength(2));

    await user.selectOptions(screen.getByRole("combobox", { name: "Time range" }), "past-hour");

    const row = screen.getByTestId("agent-action-row");
    expect(row).toHaveTextContent("save");
    expect(row).not.toHaveTextContent("applyPatch");
  });

  it("combines action type, disposition, and time range with AND semantics", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const user = userEvent.setup();
    const denied = {
      disposition: "denied" as const,
      denyReason: "denied-sensitive-path" as const,
      reviewReason: undefined,
    };
    fetchEditorAgentAudit.mockResolvedValue({
      records: [
        record({
          ...denied,
          auditId: "audit-match",
          actionType: "save",
          targetPath: "src/match.ts",
          occurredAt: NOW - HOUR_MS / 2,
        }),
        record({
          ...denied,
          auditId: "audit-wrong-action",
          actionType: "applyPatch",
          targetPath: "src/wrong-action.ts",
          occurredAt: NOW - HOUR_MS / 2,
        }),
        record({
          auditId: "audit-wrong-disposition",
          actionType: "save",
          targetPath: "src/wrong-disposition.ts",
          occurredAt: NOW - HOUR_MS / 2,
        }),
        record({
          ...denied,
          auditId: "audit-wrong-time",
          actionType: "save",
          targetPath: "src/wrong-time.ts",
          occurredAt: NOW - HOUR_MS * 2,
        }),
      ],
    });
    render(<EditorAgentActionsPanel agentSessionId="session-1" refreshNonce={0} />);
    await waitFor(() => expect(screen.getAllByTestId("agent-action-row")).toHaveLength(4));

    await user.selectOptions(screen.getByRole("combobox", { name: "Action type" }), "save");
    await user.selectOptions(screen.getByRole("combobox", { name: "Disposition" }), "denied");
    await user.selectOptions(screen.getByRole("combobox", { name: "Time range" }), "past-hour");

    const row = screen.getByTestId("agent-action-row");
    expect(row).toHaveTextContent("src/match.ts");
    expect(row).not.toHaveTextContent("wrong-action");
    expect(row).not.toHaveTextContent("wrong-disposition");
    expect(row).not.toHaveTextContent("wrong-time");
  });

  it("resets each filter independently to its all value", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const user = userEvent.setup();
    fetchEditorAgentAudit.mockResolvedValue({
      records: [
        record({
          auditId: "audit-recent-denied-save",
          actionType: "save",
          disposition: "denied",
          denyReason: "denied-sensitive-path",
          reviewReason: undefined,
          occurredAt: NOW - HOUR_MS / 2,
        }),
        record({
          auditId: "audit-old-review-patch",
          actionType: "applyPatch",
          occurredAt: NOW - HOUR_MS * 2,
        }),
      ],
    });
    render(<EditorAgentActionsPanel agentSessionId="session-1" refreshNonce={0} />);
    await waitFor(() => expect(screen.getAllByTestId("agent-action-row")).toHaveLength(2));

    for (const filter of [
      { name: "Action type", value: "save" },
      { name: "Disposition", value: "denied" },
      { name: "Time range", value: "past-hour" },
    ] as const) {
      const control = screen.getByRole("combobox", { name: filter.name });
      await user.selectOptions(control, filter.value);
      expect(screen.getAllByTestId("agent-action-row")).toHaveLength(1);
      await user.selectOptions(control, "all");
      expect(screen.getAllByTestId("agent-action-row")).toHaveLength(2);
    }
  });

  it("distinguishes zero filter matches from empty and error states", async () => {
    const user = userEvent.setup();
    fetchEditorAgentAudit.mockResolvedValue({ records: [record()] });
    render(<EditorAgentActionsPanel agentSessionId="session-1" refreshNonce={0} />);
    await waitFor(() => expect(screen.getByTestId("agent-action-row")).toBeInTheDocument());

    await user.selectOptions(screen.getByRole("combobox", { name: "Action type" }), "applyPatch");

    expect(screen.getByTestId("agent-actions-no-match")).toHaveTextContent(
      "No agent editor actions match the current filters.",
    );
    expect(screen.queryByTestId("agent-action-row")).not.toBeInTheDocument();
    expect(screen.queryByText("No recent agent editor actions.")).not.toBeInTheDocument();
    expect(screen.queryByTestId("agent-actions-error")).not.toBeInTheDocument();
  });

  it("keeps aria-live additions scoped to records matching the active filters", async () => {
    const user = userEvent.setup();
    const firstMatch = record({ auditId: "audit-save-1", actionType: "save" });
    const updatedMatch = record({
      auditId: "audit-save-1",
      actionType: "save",
      outcome: "succeeded",
    });
    const nonMatch = record({ auditId: "audit-patch", actionType: "applyPatch" });
    const secondMatch = record({ auditId: "audit-save-2", actionType: "save" });
    fetchEditorAgentAudit
      .mockResolvedValueOnce({ records: [firstMatch] })
      .mockResolvedValueOnce({ records: [updatedMatch, nonMatch] })
      .mockResolvedValueOnce({ records: [updatedMatch, nonMatch, secondMatch] });
    const { rerender } = render(
      <EditorAgentActionsPanel agentSessionId="session-1" refreshNonce={0} />,
    );
    await waitFor(() => expect(screen.getByTestId("agent-action-row")).toBeInTheDocument());
    await user.selectOptions(screen.getByRole("combobox", { name: "Action type" }), "save");

    const liveList = screen.getByRole("list");
    expect(liveList).toHaveAttribute("aria-live", "polite");
    expect(liveList).toHaveAttribute("aria-relevant", "additions");

    rerender(<EditorAgentActionsPanel agentSessionId="session-1" refreshNonce={1} />);
    await waitFor(() => expect(within(liveList).getByText("succeeded")).toBeInTheDocument());
    expect(screen.getAllByTestId("agent-action-row")).toHaveLength(1);
    expect(within(liveList).queryByText("applyPatch")).not.toBeInTheDocument();

    rerender(<EditorAgentActionsPanel agentSessionId="session-1" refreshNonce={2} />);
    await waitFor(() => expect(screen.getAllByTestId("agent-action-row")).toHaveLength(2));
    for (const row of screen.getAllByTestId("agent-action-row")) {
      expect(row).toHaveTextContent("save");
      expect(row).not.toHaveTextContent("applyPatch");
    }
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

  it("has no detectable a11y violations with a non-default filter combination", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const user = userEvent.setup();
    fetchEditorAgentAudit.mockResolvedValue({
      records: [
        record({
          auditId: "audit-filtered-a11y",
          actionType: "save",
          disposition: "denied",
          denyReason: "denied-sensitive-path",
          reviewReason: undefined,
          occurredAt: NOW - HOUR_MS / 2,
        }),
        record({ auditId: "audit-filtered-out", actionType: "applyPatch" }),
      ],
    });
    const { container } = render(
      <EditorAgentActionsPanel agentSessionId="session-1" refreshNonce={0} />,
    );
    await waitFor(() => expect(screen.getAllByTestId("agent-action-row")).toHaveLength(2));

    await user.selectOptions(screen.getByRole("combobox", { name: "Action type" }), "save");
    await user.selectOptions(screen.getByRole("combobox", { name: "Disposition" }), "denied");
    await user.selectOptions(screen.getByRole("combobox", { name: "Time range" }), "past-hour");

    expect(screen.getAllByTestId("agent-action-row")).toHaveLength(1);
    expect(await axe(container)).toHaveNoViolations();
  });
});
