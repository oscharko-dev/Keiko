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
    "template-unavailable": "Could not complete",
  },
  de: {
    "no-requirements": "Keine Anforderung passte zur Auswahl",
    "project-not-found": "Projekt nicht gefunden",
    "issue-type-not-found": "Vorgangstyp in diesem Projekt nicht verfügbar",
    "template-unavailable": "Konnte nicht abgeschlossen werden",
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
