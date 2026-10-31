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
  compliance: { issuesChecked: 2350, issuesWithDeviations: 235, deviationCount: 240 },
  coverage: { uncoveredEpics: { total: 1, items: ["REP-4"] }, orphans: { total: 9, items: [] } },
};
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
