import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChatToolExchange, ChatToolTranscript } from "@oscharko-dev/keiko-contracts/bff-wire";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { I18N_STORAGE_KEY, I18nProvider, loadLocaleMessages } from "@/lib/i18n";
import { loadOptionalWidgetMessages } from "@/lib/optional-widget-i18n";
import { JiraChatTools } from "./JiraChatTools";

const OPAQUE = {
  outcome: "succeeded", issueKey: "SYN-7", browseUrl: "https://untrusted.example.invalid/browse/SYN-7",
  summary: "Unvalidated native prose", description: "Opaque native body",
  nested: { password: "synthetic-untrusted-field", license: "synthetic-untrusted-license" },
};
function result(name: string, data: CatalogJsonObject = OPAQUE): ChatToolExchange {
  return {
    call: { id: "fallback-result", name, arguments: {} },
    result: {
      schemaVersion: 1, invocationId: "fallback-result", toolRef: null, projectionDigest: null,
      effectStarted: false, metrics: { inputBytes: 0, outputBytes: 0, resultCount: 0, durationMs: 0 },
      status: "completed", reason: "none", page: { truncated: false, reason: "none", cursor: null }, data,
    },
  };
}
function restored(exchange: ChatToolExchange): ChatToolTranscript {
  return JSON.parse(JSON.stringify({ schemaVersion: 1, exchanges: [exchange] })) as ChatToolTranscript;
}

afterEach(() => localStorage.removeItem(I18N_STORAGE_KEY));
describe.each(["en", "de"] as const)("closed result fallback in %s", (locale) => {
  const unavailable = locale === "en" ? "A readable view of this result is unavailable."
    : "Für dieses Ergebnis ist keine lesbare Ansicht verfügbar.";
  beforeEach(async () => {
    await Promise.all([loadLocaleMessages(locale), loadOptionalWidgetMessages(locale)]);
    localStorage.setItem(I18N_STORAGE_KEY, locale);
  });

  it.each(["knowledge_requirements", "knowledge_documents", "knowledge_review", "mcp_foreign_tool", "jira_future_tool"])(
    "withholds opaque payloads for %s before and after reload", async (name) => {
      const transcript = restored(result(name));
      const show = () => render(<I18nProvider><JiraChatTools transcript={transcript} turnState="completed" /></I18nProvider>);
      const first = show();
      const previous = first.container.textContent;
      first.unmount();
      const { container } = show();
      expect(container.textContent).toBe(previous);
      expect(screen.getByText(unavailable)).toBeVisible();
      const summary = container.querySelector("summary");
      if (summary === null) throw new TypeError("Expected the existing result disclosure");
      await userEvent.setup().click(summary);
      expect(screen.getByText(locale === "en"
        ? "Ask for a supported result view. Do not repeat an action just to recover its display; check its existing outcome first."
        : "Bitte um eine unterstützte Ergebnisansicht. Wiederhole eine Aktion nicht nur wegen der fehlenden Darstellung; prüfe zuerst ihren bisherigen Ausgang."))
        .toBeVisible();
      expect(container.querySelector("pre, a, input, button")).toBeNull();
      expect(container.textContent).not.toMatch(/SYN-7|Unvalidated native prose|Opaque native body|synthetic-untrusted|untrusted\.example|browseUrl/u);
      expect(await axe(container)).toHaveNoViolations();
    },
  );

  it("keeps the existing readable Jira owner and its validated saved link", () => {
    const transcript = restored(result("jira_issue", { outcome: "succeeded", items: [{
      key: "SYN-7", summary: "Independently observed issue", browseUrl: "https://jira.example.invalid/context/browse/SYN-7",
    }] }));
    render(<I18nProvider><JiraChatTools transcript={transcript} turnState="completed" /></I18nProvider>);
    const list = screen.getByRole("list", { name: locale === "en" ? "Jira results" : "Jira-Ergebnisse" });
    expect(within(list).getByRole("link")).toHaveAttribute("href", "https://jira.example.invalid/context/browse/SYN-7");
    expect(screen.getByText("Independently observed issue")).toBeVisible();
    expect(screen.queryByText(unavailable)).toBeNull();
    expect(document.querySelector("pre")).toBeNull();
  });

  it("does not replace durable uncertainty with the opaque provider's succeeded field", () => {
    const transcript = restored({ ...result("mcp_foreign_tool"), mutationOutcome: "unknown" });
    render(<I18nProvider><JiraChatTools transcript={transcript} turnState="failed" /></I18nProvider>);
    expect(screen.getByText(unavailable)).toBeVisible();
    expect(screen.queryByText(locale === "en" ? "Completed" : "Abgeschlossen")).toBeNull();
    expect(document.querySelector("pre, a, button")).toBeNull();
  });
});
