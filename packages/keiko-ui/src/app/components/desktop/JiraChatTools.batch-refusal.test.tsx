import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ChatToolExchange } from "@oscharko-dev/keiko-contracts/bff-wire";
import { JiraChatTools } from "./JiraChatTools";
import { I18N_STORAGE_KEY, I18nProvider, loadLocaleMessages } from "@/lib/i18n";
import { loadOptionalWidgetMessages } from "@/lib/optional-widget-i18n";

type Locale = "en" | "de";

function refused(reason: string): ChatToolExchange {
  return {
    call: { id: "batch-1", name: "jira_draft_batch", arguments: {} },
    result: {
      schemaVersion: 1,
      invocationId: "invocation-1",
      toolRef: null,
      projectionDigest: null,
      effectStarted: false,
      metrics: { inputBytes: 10, outputBytes: 10, resultCount: 1, durationMs: 20 },
      status: "failed",
      reason: "provider-reported-error",
      page: null,
      data: { outcome: "failed", reason },
    } as NonNullable<ChatToolExchange["result"]>,
  };
}

const COPY = {
  en: {
    "no-requirements": "No requirement matched the selection",
    "project-not-found": "Project not found",
    "issue-type-not-found": "Issue type not available in this project",
    "no-usable-issue-type": "No issue type available for drafting in this project",
    "template-unavailable": "The project's template rules could not be read from Jira",
    "requirements-ambiguous":
      "The same requirement IDs appear in documents with different content. Name the document to draft from",
    "an-unknown-reason": "Could not complete",
  },
  de: {
    "no-requirements": "Keine Anforderung passte zur Auswahl",
    "project-not-found": "Projekt nicht gefunden",
    "issue-type-not-found": "Vorgangstyp in diesem Projekt nicht verfügbar",
    "no-usable-issue-type": "Kein Vorgangstyp zum Entwerfen in diesem Projekt verfügbar",
    "template-unavailable": "Die Vorlagenregeln des Projekts konnten nicht aus Jira gelesen werden",
    "requirements-ambiguous":
      "Dieselben Anforderungs-IDs stehen in Dokumenten mit unterschiedlichem Inhalt. Nenne das Dokument, aus dem entworfen werden soll",
    "an-unknown-reason": "Konnte nicht abgeschlossen werden",
  },
} as const;

describe.each(["en", "de"] as const)("refused draft batch card in %s", (locale: Locale) => {
  it.each(Object.entries(COPY[locale]))(
    "shows the reason %s in plain words",
    async (reason, text) => {
      await Promise.all([loadLocaleMessages(locale), loadOptionalWidgetMessages(locale)]);
      localStorage.setItem(I18N_STORAGE_KEY, locale);
      render(
        <I18nProvider>
          <JiraChatTools
            transcript={{ schemaVersion: 1, exchanges: [refused(reason)] }}
            turnState="completed"
          />
        </I18nProvider>,
      );
      expect(screen.getByText(text)).toBeVisible();
    },
  );
});

describe.each(["en", "de"] as const)("paused draft batch card in %s", (locale: Locale) => {
  it("says it paused and counts what is drafted", async () => {
    await Promise.all([loadLocaleMessages(locale), loadOptionalWidgetMessages(locale)]);
    localStorage.setItem(I18N_STORAGE_KEY, locale);
    const exchange: ChatToolExchange = {
      call: { id: "batch-1", name: "jira_draft_batch", arguments: {} },
      batchProgress: {
        phase: "complete",
        draftedCount: 20,
        plannedCount: 25,
        coveredRequirementCount: 20,
        requirementCount: 25,
        failedCount: 0,
      },
      result: {
        ...refused("x").result,
        status: "completed",
        reason: "none",
        page: { truncated: false, reason: "none", cursor: null },
        data: { outcome: "succeeded", paused: true },
      } as NonNullable<ChatToolExchange["result"]>,
    };
    render(
      <I18nProvider>
        <JiraChatTools
          transcript={{ schemaVersion: 1, exchanges: [exchange] }}
          turnState="completed"
        />
      </I18nProvider>,
    );
    const text = locale === "en" ? /Paused after 20 of 25 issues/u : /Pausiert nach 20 von 25/u;
    expect(screen.getByText(text)).toBeVisible();
  });
});
