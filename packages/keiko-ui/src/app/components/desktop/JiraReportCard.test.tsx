import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatToolExchange, ChatToolTranscript } from "@oscharko-dev/keiko-contracts/bff-wire";

const exportJiraReport = vi.fn();
const saveTextDownload = vi.fn();
const reportClientDiagnostic = vi.fn();
vi.mock("@/lib/jira-report-api", () => ({
  exportJiraReport: (...args: unknown[]): unknown => exportJiraReport(...args),
}));
vi.mock("@/lib/browser-download", () => ({
  saveTextDownload: (...args: unknown[]): unknown => saveTextDownload(...args),
}));
vi.mock("@/lib/client-diagnostics", () => ({
  reportClientDiagnostic: (...args: unknown[]): unknown => reportClientDiagnostic(...args),
}));

import { JiraChatTools } from "./JiraChatTools";
import { jiraReportView } from "./jira-report-view";

const REPORT_ID = "11111111-2222-4333-8444-555555555555";
const report = {
  completeness: { complete: true, issuesRead: 2350, issuesTotal: 2350, pageCount: 4 },
  progress: {
    project: {
      total: 2350,
      new: 1000,
      indeterminate: 700,
      done: 650,
      noCategory: 0,
      donePercent: 27.7,
    },
  },
  hierarchy: { discovery: "complete", fieldCount: 3, observedFieldCount: 1, inferredFieldCount: 0 },
  compliance: {
    issuesChecked: 4,
    issuesJudged: 2350,
    issuesWithDeviations: 235,
    deviationCount: 240,
  },
  coverage: {
    containerRoles: "observed",
    uncoveredEpics: { total: 1, items: ["REP-4"] },
    orphans: { total: 9, items: [] },
  },
};
/** The identity a section page of the tool carries instead of the summary (jira-report-result). */
function sectionIdentity(completeness: Record<string, unknown>): Record<string, unknown> {
  return { digest: "d".repeat(64), generatedAt: "2026-11-02T10:00:00.000Z", completeness };
}
function data(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    outcome: "succeeded",
    status: "complete",
    reportId: REPORT_ID,
    progress: { issuesRead: 2350, issuesTotal: 2350, pageCount: 4, elapsedMs: 10 },
    report,
    ...overrides,
  };
}
function transcript(result: Record<string, unknown>): ChatToolTranscript {
  const exchange = {
    call: { id: "call-1", name: "jira_report", arguments: {} },
    result: {
      status: "completed",
      data: result,
      page: { truncated: false, reason: "none", cursor: null },
    },
  } as unknown as ChatToolExchange;
  return { exchanges: [exchange], grants: [] } as unknown as ChatToolTranscript;
}

beforeEach(() => {
  exportJiraReport.mockReset();
  saveTextDownload.mockReset();
  reportClientDiagnostic.mockReset();
});

describe("Jira report card", () => {
  it("names the resolved estimate field before and after transcript serialization", () => {
    const result = data({
      report: {
        ...report,
        scope: {
          estimateFieldId: "customfield_10200",
          estimateFieldName: "Story Points",
          estimateUnit: "custom-field",
          estimateSource: "board-configuration",
        },
      },
    });
    const live = render(<JiraChatTools transcript={transcript(result)} />);
    expect(
      screen.getByText("Estimate field: Story Points (customfield_10200)"),
    ).toBeInTheDocument();
    const text = live.container.textContent;
    live.unmount();
    const saved = JSON.parse(JSON.stringify(transcript(result))) as ChatToolTranscript;
    const restored = render(<JiraChatTools transcript={saved} />);
    expect(restored.container.textContent).toBe(text);
  });

  it.each([
    ["field-not-found", "no estimate field is configured on the project's boards or screens"],
    ["ambiguous-field", "the project has conflicting estimate fields"],
    ["metadata-unavailable", "the project's estimate configuration could not be read"],
    ["project-not-specified", "no project was specified"],
  ])(
    "explains an unavailable estimate (%s) without presenting zero estimates",
    (reason, explanation) => {
      const result = data({
        report: {
          ...report,
          scope: {
            estimateUnit: "unavailable",
            estimateSource: "unavailable",
            estimateUnavailableReason: reason,
          },
          progress: { ...report.progress, project: { ...report.progress.project, estimate: null } },
        },
      });
      render(<JiraChatTools transcript={transcript(result)} />);
      expect(screen.getByText(`Estimate unavailable: ${explanation}`)).toBeInTheDocument();
      expect(
        screen.queryByText(/Estimate field:|0 total|without an estimate/u),
      ).not.toBeInTheDocument();
      expect(screen.getByText("Complete: 2350 issues read")).toBeInTheDocument();
    },
  );

  it.each([
    ["effect-denied", "Local authority no longer permits this Jira request."],
    ["cancelled", "This Jira request was cancelled."],
  ] as const)(
    "retains local %s guidance and an unknown denominator after reload",
    (failure, guidance) => {
      const interrupted = data({
        status: "incomplete",
        progress: { issuesRead: 1 },
        report: {
          completeness: {
            complete: false,
            reason: "read-failed",
            failure,
            issuesRead: 1,
            pageCount: 1,
          },
        },
      });
      const saved = JSON.parse(JSON.stringify(transcript(interrupted))) as ChatToolTranscript;
      const first = render(<JiraChatTools transcript={saved} />);
      const before = first.container.textContent;
      first.unmount();
      const next = render(<JiraChatTools transcript={saved} />);
      expect(next.container.textContent).toBe(before);
      expect(next.container.textContent).toContain(guidance);
      expect(next.container.textContent).toContain("1 issues read; the total is unknown");
      expect(next.container.textContent).not.toContain("1 of 1 issues");
      expect(next.container.querySelector("pre, a, button")).toBeNull();
    },
  );
  it("shows the computed figures and no export while the report is still being read", async () => {
    const reading = data({
      status: "reading",
      report: undefined,
      progress: { issuesRead: 1000, issuesTotal: 2350, pageCount: 2, elapsedMs: 1 },
    });
    const { container } = render(
      <JiraChatTools transcript={transcript(reading)} chatId="chat-1" />,
    );
    expect(screen.getByText("Reading Jira: 1000 of 2350 issues")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Export CSV" })).not.toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("renders the figures of a finished report exactly as the tool returned them", async () => {
    const { container } = render(<JiraChatTools transcript={transcript(data())} chatId="chat-1" />);
    expect(screen.getByText("Complete: 2350 issues read")).toBeInTheDocument();
    expect(screen.getByText("27.7% done")).toBeInTheDocument();
    expect(screen.getByText("235 of 2350 issues deviate (240 deviations)")).toBeInTheDocument();
    expect(
      screen.getByText("1 epics without members, 9 issues without an epic or parent"),
    ).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("does not present an unobserved empty-container count as an established zero", async () => {
    const unobserved = data({
      report: {
        ...report,
        compliance: { ...report.compliance, issuesJudged: 4, issuesWithDeviations: 0 },
        coverage: {
          containerRoles: "unobserved",
          uncoveredEpics: { total: 0, items: [] },
          orphans: { total: 4, items: [] },
        },
      },
    });
    const { container } = render(
      <JiraChatTools transcript={transcript(unobserved)} chatId="chat-1" />,
    );
    expect(
      screen.getByText(
        "Epics without members cannot be told for this scope, 4 issues without an epic or parent",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/0 epics without members/u)).not.toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("discloses a parent relation that rests on a field Jira gives no role", () => {
    const inferred = data({
      report: { ...report, hierarchy: { ...report.hierarchy, inferredFieldCount: 1 } },
    });
    render(<JiraChatTools transcript={transcript(inferred)} chatId="chat-1" />);
    expect(screen.getByText(/custom field whose role Jira does not state/u)).toBeInTheDocument();
  });

  it("says an incomplete report describes only the issues read", () => {
    const incomplete = data({
      status: "incomplete",
      report: {
        ...report,
        completeness: {
          complete: false,
          reason: "scope-changed",
          issuesRead: 250,
          issuesTotal: 253,
        },
      },
      progress: { issuesRead: 250, issuesTotal: 253, pageCount: 1, elapsedMs: 1 },
    });
    render(<JiraChatTools transcript={transcript(incomplete)} chatId="chat-1" />);
    expect(
      screen.getByText(
        "Incomplete (the issues changed while reading): 250 of 253 issues read. The figures describe only the issues read.",
      ),
    ).toBeInTheDocument();
  });

  it("never shows an unchecked compliance section as a clean one", () => {
    const unchecked = data({
      status: "incomplete",
      report: {
        ...report,
        completeness: {
          complete: false,
          reason: "template-unreadable",
          issuesRead: 253,
          issuesTotal: 253,
        },
      },
      progress: { issuesRead: 253, issuesTotal: 253, pageCount: 1, elapsedMs: 1 },
    });
    render(<JiraChatTools transcript={transcript(unchecked)} chatId="chat-1" />);
    expect(
      screen.getByText(
        "Incomplete (the issue template library could not be read, so compliance was not checked): 253 of 253 issues read. The figures describe only the issues read.",
      ),
    ).toBeInTheDocument();
  });

  it("saves the server-rendered file through the browser download path", async () => {
    const file = {
      fileName: "keiko-jira-report-aaaaaaaaaaaa.csv",
      content: "a",
      mediaType: "text/csv",
    };
    exportJiraReport.mockResolvedValue(file);
    render(<JiraChatTools transcript={transcript(data())} chatId="chat-1" />);
    await userEvent.click(screen.getByRole("button", { name: "Export CSV" }));
    await waitFor(() => {
      expect(saveTextDownload).toHaveBeenCalledExactlyOnceWith(file);
    });
    expect(exportJiraReport).toHaveBeenCalledExactlyOnceWith(REPORT_ID, "chat-1", "csv");
  });

  it("reports a failed export without a download", async () => {
    exportJiraReport.mockRejectedValue(new Error("synthetic"));
    render(<JiraChatTools transcript={transcript(data())} chatId="chat-1" />);
    await userEvent.click(screen.getByRole("button", { name: "Export Markdown" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("could not be exported");
    expect(saveTextDownload).not.toHaveBeenCalled();
    expect(reportClientDiagnostic).toHaveBeenCalledOnce();
  });

  it("keeps the status and the exports on a section page of a finished report", async () => {
    const section = {
      outcome: "succeeded",
      status: "complete",
      reportId: REPORT_ID,
      progress: { issuesRead: 40, issuesTotal: 40, pageCount: 1, elapsedMs: 2 },
      exports: ["markdown", "csv"],
      report: sectionIdentity({ complete: true, issuesRead: 40, issuesTotal: 40, pageCount: 1 }),
      section: { name: "comment", text: "Keiko Jira report REP" },
    };
    const file = { fileName: "report.csv", content: "a", mediaType: "text/csv" };
    exportJiraReport.mockResolvedValue(file);
    render(<JiraChatTools transcript={transcript(section)} chatId="chat-1" />);
    expect(screen.getByText("Complete: 40 issues read")).toBeInTheDocument();
    screen.getByRole("button", { name: "Export Markdown" });
    screen.getByRole("button", { name: "Export CSV" }).focus();
    await userEvent.keyboard("{Enter}");
    await waitFor(() => {
      expect(saveTextDownload).toHaveBeenCalledExactlyOnceWith(file);
    });
  });

  it("keeps the warning of an incomplete report on a section page", () => {
    const section = {
      outcome: "succeeded",
      status: "incomplete",
      reportId: REPORT_ID,
      progress: { issuesRead: 10, issuesTotal: 40, pageCount: 1, elapsedMs: 2 },
      exports: ["markdown", "csv"],
      report: sectionIdentity({
        complete: false,
        reason: "scope-changed",
        issuesRead: 10,
        issuesTotal: 40,
        pageCount: 1,
      }),
      section: { name: "orphans", total: 0, startAt: 0, items: [] },
    };
    render(<JiraChatTools transcript={transcript(section)} chatId="chat-1" />);
    expect(
      screen.getByText(
        "Incomplete (the issues changed while reading): 10 of 40 issues read. The figures describe only the issues read.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export CSV" })).toBeInTheDocument();
  });

  it("offers no export without a Chat to bind the report to", () => {
    render(<JiraChatTools transcript={transcript(data())} />);
    expect(screen.queryByRole("button", { name: "Export CSV" })).not.toBeInTheDocument();
  });
});

describe("jiraReportView", () => {
  it.each([
    [undefined],
    [{ outcome: "failed" }],
    [{ outcome: "succeeded", status: "nope", reportId: REPORT_ID, progress: { issuesRead: 1 } }],
    [
      {
        outcome: "succeeded",
        status: "complete",
        reportId: REPORT_ID,
        progress: { issuesRead: -1 },
      },
    ],
  ])("refuses a malformed result %j", (value) => {
    expect(jiraReportView(value)).toBeUndefined();
  });

  it("keeps a report without figures when a number is missing", () => {
    const view = jiraReportView(data({ report: { completeness: { complete: true } } }));
    expect(view).toMatchObject({ status: "complete", figures: undefined });
  });
});
