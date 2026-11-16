import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatToolExchange, ChatToolTranscript } from "@oscharko-dev/keiko-contracts/bff-wire";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { I18N_STORAGE_KEY, I18nProvider, loadLocaleMessages } from "@/lib/i18n";
import { loadOptionalWidgetMessages } from "@/lib/optional-widget-i18n";
import * as diagnostics from "@/lib/client-diagnostics";
import { JiraChatTools } from "./JiraChatTools";

const OPAQUE = {
  outcome: "succeeded",
  issueKey: "SYN-7",
  browseUrl: "https://untrusted.example.invalid/browse/SYN-7",
  summary: "Unvalidated native prose",
  description: "Opaque native body",
  nested: { password: "synthetic-untrusted-field", license: "synthetic-untrusted-license" },
};
function result(name: string, data: CatalogJsonObject = OPAQUE): ChatToolExchange {
  return {
    call: { id: "fallback-result", name, arguments: {} },
    result: {
      schemaVersion: 1,
      invocationId: "fallback-result",
      toolRef: null,
      projectionDigest: null,
      effectStarted: false,
      metrics: { inputBytes: 0, outputBytes: 0, resultCount: 0, durationMs: 0 },
      status: "completed",
      reason: "none",
      page: { truncated: false, reason: "none", cursor: null },
      data,
    },
  };
}
function restored(exchange: ChatToolExchange): ChatToolTranscript {
  return JSON.parse(
    JSON.stringify({ schemaVersion: 1, exchanges: [exchange] }),
  ) as ChatToolTranscript;
}

afterEach(() => localStorage.removeItem(I18N_STORAGE_KEY));
describe.each(["en", "de"] as const)("closed result fallback in %s", (locale) => {
  const unavailable =
    locale === "en"
      ? "A readable view of this result is unavailable."
      : "Für dieses Ergebnis ist keine lesbare Ansicht verfügbar.";
  beforeEach(async () => {
    await Promise.all([loadLocaleMessages(locale), loadOptionalWidgetMessages(locale)]);
    localStorage.setItem(I18N_STORAGE_KEY, locale);
  });

  it.each([
    "knowledge_requirements",
    "knowledge_documents",
    "knowledge_review",
    "mcp_foreign_tool",
    "jira_future_tool",
  ])("withholds opaque payloads for %s before and after reload", async (name) => {
    const transcript = restored(result(name));
    const show = (): ReturnType<typeof render> =>
      render(
        <I18nProvider>
          <JiraChatTools transcript={transcript} turnState="completed" />
        </I18nProvider>,
      );
    const first = show();
    const previous = first.container.textContent;
    first.unmount();
    const { container } = show();
    expect(container.textContent).toBe(previous);
    expect(screen.getByText(unavailable)).toBeVisible();
    const summary = container.querySelector("summary");
    if (summary === null) throw new TypeError("Expected the existing result disclosure");
    await userEvent.setup().click(summary);
    expect(
      screen.getByText(
        locale === "en"
          ? "Ask for a supported result view. Do not repeat an action just to recover its display; check its existing outcome first."
          : "Bitte um eine unterstützte Ergebnisansicht. Wiederhole eine Aktion nicht nur wegen der fehlenden Darstellung; prüfe zuerst ihren bisherigen Ausgang.",
      ),
    ).toBeVisible();
    expect(container.querySelector("pre, a, input, button")).toBeNull();
    expect(container.textContent).not.toMatch(
      /SYN-7|Unvalidated native prose|Opaque native body|synthetic-untrusted|untrusted\.example|browseUrl/u,
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  it("keeps the existing readable Jira owner and its validated saved link", () => {
    const transcript = restored(
      result("jira_edit", {
        outcome: "succeeded",
        items: [
          {
            key: "SYN-7",
            summary: "Independently observed issue",
            browseUrl: "https://jira.example.invalid/context/browse/SYN-7",
          },
        ],
      }),
    );
    render(
      <I18nProvider>
        <JiraChatTools transcript={transcript} turnState="completed" />
      </I18nProvider>,
    );
    const list = screen.getByRole("list", {
      name: locale === "en" ? "Jira issues" : "Jira-Vorgänge",
    });
    expect(within(list).getByRole("link")).toHaveAttribute(
      "href",
      "https://jira.example.invalid/context/browse/SYN-7",
    );
    expect(screen.getByText("Independently observed issue")).toBeVisible();
    expect(screen.queryByText(unavailable)).toBeNull();
    expect(document.querySelector("pre")).toBeNull();
  });

  it("does not replace durable uncertainty with the opaque provider's succeeded field", () => {
    const transcript = restored({ ...result("mcp_foreign_tool"), mutationOutcome: "unknown" });
    render(
      <I18nProvider>
        <JiraChatTools transcript={transcript} turnState="failed" />
      </I18nProvider>,
    );
    expect(screen.getByText(unavailable)).toBeVisible();
    expect(screen.queryByText(locale === "en" ? "Completed" : "Abgeschlossen")).toBeNull();
    expect(document.querySelector("pre, a, button")).toBeNull();
  });

  it.each([
    "knowledge_requirements",
    "knowledge_documents",
    "knowledge_review",
    "mcp_foreign_tool",
    "jira_future_tool",
  ])("does not misclassify live or restored %s as Jira presentation evidence", (name) => {
    const report = vi.spyOn(diagnostics, "reportClientDiagnostic");
    const transcript = restored(result(name));
    const events = (): unknown[] =>
      report.mock.calls.flatMap(([, meta]) =>
        meta?.jiraResultPresentation === undefined ? [] : [meta.jiraResultPresentation],
      );
    const show = (turnState: "pending" | "completed"): ReturnType<typeof I18nProvider> => (
      <I18nProvider>
        <JiraChatTools
          transcript={transcript}
          turnState={turnState}
          messageId="private-fallback-parent"
        />
      </I18nProvider>
    );
    try {
      const live = render(show("pending"));
      expect(events()).toEqual([]);
      live.rerender(show("pending"));
      live.rerender(show("completed"));
      expect(events()).toHaveLength(0);
      live.unmount();
      render(show("completed"));
      expect(events()).toHaveLength(0);
      const recorded = JSON.stringify(report.mock.calls);
      expect(recorded).not.toContain(name);
      expect(recorded).not.toMatch(
        /private-fallback-parent|fallback-result|SYN-7|untrusted|Opaque|Unvalidated|browseUrl|password|license/u,
      );
    } finally {
      report.mockRestore();
    }
  });

  it("does not claim a fallback presentation when there is no result body to render", () => {
    const report = vi.spyOn(diagnostics, "reportClientDiagnostic");
    const exchange = result("mcp_foreign_tool");
    if (exchange.result?.status !== "completed")
      throw new TypeError("Expected completed result fixture");
    try {
      render(
        <I18nProvider>
          <JiraChatTools
            messageId="private-fallback-parent"
            turnState="pending"
            transcript={{
              schemaVersion: 1,
              exchanges: [{ ...exchange, result: { ...exchange.result, data: null } }],
            }}
          />
        </I18nProvider>,
      );
      expect(screen.queryByText(unavailable)).toBeNull();
      expect(report.mock.calls.some(([, meta]) => meta?.jiraResultPresentation !== undefined)).toBe(
        false,
      );
    } finally {
      report.mockRestore();
    }
  });
});
