import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ChatToolExchange } from "@oscharko-dev/keiko-contracts/bff-wire";
import { JiraChatTools } from "./JiraChatTools";
import { I18N_STORAGE_KEY, I18nProvider, loadLocaleMessages } from "@/lib/i18n";
import { loadOptionalWidgetMessages } from "@/lib/optional-widget-i18n";

function requirementsRead(totals: Record<string, unknown>, nextCursor?: string): ChatToolExchange {
  return {
    call: { id: "req-1", name: "knowledge_requirements", arguments: { view: "units" } },
    result: {
      schemaVersion: 1,
      invocationId: "invocation-req",
      toolRef: null,
      projectionDigest: null,
      effectStarted: false,
      metrics: { inputBytes: 10, outputBytes: 10, resultCount: 1, durationMs: 20 },
      status: "completed",
      reason: "none",
      page: {
        truncated: nextCursor !== undefined,
        reason: nextCursor === undefined ? "none" : "result-cap",
        cursor: null,
      },
      data: {
        outcome: "succeeded",
        view: "units",
        totals: { detectedCount: 3, cutReasons: [], unitsOmitted: 0, ...totals },
        items: [{ reference: "REQ-1", title: "Synthetic requirement" }],
        ...(nextCursor === undefined ? {} : { nextCursor }),
      },
    },
  };
}

const COPY = {
  en: {
    label: "Requirements",
    partial: "Partial list. Some requirements are not included.",
    details: "View requirements",
  },
  de: {
    label: "Anforderungen",
    partial: "Teilliste. Nicht alle Anforderungen sind enthalten.",
    details: "Anforderungen ansehen",
  },
} as const;

describe("knowledge.requirements transcript row", () => {
  it.each([
    ["en", "an omitted unit", { unitsOmitted: 2 }, undefined],
    ["en", "a named cut reason", { cutReasons: ["byte-budget"] }, undefined],
    ["en", "an omitted document", { documentsOmitted: 1 }, undefined],
    ["en", "a document that was not extracted", { documentsNotExtracted: 1 }, undefined],
    ["en", "a further page", {}, "cursor-2"],
    ["de", "an omitted unit", { unitsOmitted: 2 }, undefined],
  ] as const)(
    "names the tool and shows a truncated inventory in %s: %s",
    async (locale, _case, totals, nextCursor) => {
      await Promise.all([loadLocaleMessages(locale), loadOptionalWidgetMessages(locale)]);
      localStorage.setItem(I18N_STORAGE_KEY, locale);
      try {
        render(
          <I18nProvider>
            <JiraChatTools
              transcript={{ schemaVersion: 1, exchanges: [requirementsRead(totals, nextCursor)] }}
              turnState="completed"
            />
          </I18nProvider>,
        );
        expect(screen.getByText(COPY[locale].label)).toBeVisible();
        expect(screen.getByText(COPY[locale].partial)).toBeVisible();
        expect(screen.getByRole("region", { name: COPY[locale].label })).toBeVisible();
        expect(screen.getByText(COPY[locale].details)).toBeVisible();
        expect(screen.queryByText(/Jira/u)).not.toBeInTheDocument();
      } finally {
        localStorage.removeItem(I18N_STORAGE_KEY);
      }
    },
  );

  it("shows no partial note for a complete inventory", async () => {
    await Promise.all([loadLocaleMessages("en"), loadOptionalWidgetMessages("en")]);
    localStorage.setItem(I18N_STORAGE_KEY, "en");
    try {
      render(
        <I18nProvider>
          <JiraChatTools
            transcript={{ schemaVersion: 1, exchanges: [requirementsRead({})] }}
            turnState="completed"
          />
        </I18nProvider>,
      );
      expect(screen.getByText(COPY.en.label)).toBeVisible();
      expect(screen.queryByText(COPY.en.partial)).toBeNull();
      expect(screen.queryByText(/Partial Jira result/)).toBeNull();
    } finally {
      localStorage.removeItem(I18N_STORAGE_KEY);
    }
  });
});
