import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ChatToolExchange } from "@oscharko-dev/keiko-contracts/bff-wire";
import { I18N_STORAGE_KEY, I18nProvider, loadLocaleMessages } from "@/lib/i18n";
import { loadOptionalWidgetMessages } from "@/lib/optional-widget-i18n";
import { JiraChatTools } from "./JiraChatTools";
import { knowledgeReviewFailureNotice } from "./jira-tool-presentation";

function failedReview(failureStage: string, data: Record<string, unknown> = {}): ChatToolExchange {
  return {
    call: { id: "review-1", name: "knowledge_review", arguments: { documentScope: "doc-a" } },
    result: {
      schemaVersion: 1,
      invocationId: "review-result",
      projectionDigest: null,
      toolRef: { canonicalId: "keiko.knowledge.review", contractVersion: 2 },
      status: "failed",
      reason: "provider-reported-error",
      effectStarted: false,
      page: null,
      metrics: { inputBytes: 10, outputBytes: 10, resultCount: 0, durationMs: 1 },
      data: {
        outcome: "failed",
        reason: failureStage,
        failureStage,
        sourceAvailable: true,
        ...data,
      },
    },
  };
}

const CASES = [
  [
    "model-output-invalid",
    "en",
    "The document was read, but the model's response was invalid. No review was completed.",
  ],
  [
    "model-output-invalid",
    "de",
    "Das Dokument wurde gelesen, aber die Modellantwort war ungültig. Die Prüfung wurde nicht abgeschlossen.",
  ],
  [
    "model-port-unavailable",
    "en",
    "The document is available. No model is currently available for the review.",
  ],
  [
    "model-port-unavailable",
    "de",
    "Das Dokument ist verfügbar. Für die Prüfung ist derzeit kein Modell verfügbar.",
  ],
  [
    "budget-port-unavailable",
    "en",
    "The document is available. The review could not start because its budget could not be checked.",
  ],
  [
    "budget-port-unavailable",
    "de",
    "Das Dokument ist verfügbar. Das Budget für die Prüfung konnte nicht geprüft werden.",
  ],
] as const;

describe("source-checked Knowledge review failure", () => {
  it.each(CASES)(
    "shows the actual %s stage in %s after canonical restore",
    async (stage, locale, text) => {
      await Promise.all([loadLocaleMessages(locale), loadOptionalWidgetMessages(locale)]);
      localStorage.setItem(I18N_STORAGE_KEY, locale);
      try {
        const exchange = JSON.parse(JSON.stringify(failedReview(stage))) as ChatToolExchange;
        render(
          <I18nProvider>
            <JiraChatTools
              transcript={{ schemaVersion: 1, exchanges: [exchange] }}
              turnState="completed"
            />
          </I18nProvider>,
        );
        const card = within(
          screen.getByRole("region", {
            name: locale === "de" ? "Dokumentenbewertung" : "Document review",
          }),
        );
        expect(card.getByText(text)).toBeVisible();
        expect(
          card.getByText(
            locale === "de" ? "Konnte nicht abgeschlossen werden" : "Could not complete",
          ),
        ).toBeVisible();
        expect(card.queryByText(/unsupported|nicht unterstützt/iu)).toBeNull();
      } finally {
        localStorage.removeItem(I18N_STORAGE_KEY);
      }
    },
  );

  it("shows a settled model-output failure while outer synthesis still runs", async () => {
    await Promise.all([loadLocaleMessages("en"), loadOptionalWidgetMessages("en")]);
    localStorage.setItem(I18N_STORAGE_KEY, "en");
    try {
      render(
        <I18nProvider>
          <JiraChatTools
            transcript={{ schemaVersion: 1, exchanges: [failedReview("model-output-invalid")] }}
            turnState="pending"
          />
        </I18nProvider>,
      );
      expect(
        within(screen.getByRole("region", { name: "Document review" })).getByText(CASES[0][2]),
      ).toBeVisible();
    } finally {
      localStorage.removeItem(I18N_STORAGE_KEY);
    }
  });

  it.each([
    { sourceAvailable: false },
    { sourceAvailable: undefined },
    { outcome: "succeeded" },
    { reason: "unavailable" },
    { failureStage: "unknown" },
  ])(
    "does not turn an unconfirmed source or unknown result into a source-available claim: %s",
    (data) => {
      expect(
        knowledgeReviewFailureNotice(failedReview("model-output-invalid", data)),
      ).toBeUndefined();
    },
  );

  it.each([
    ["external.tool", 2],
    ["keiko.knowledge.review", 1],
  ] as const)(
    "does not trust %s contract version %s as the source-checked review contract",
    (canonicalId, contractVersion) => {
      const exchange = failedReview("model-output-invalid");
      if (exchange.result === undefined) throw new Error("Expected receipt");
      expect(
        knowledgeReviewFailureNotice({
          ...exchange,
          result: { ...exchange.result, toolRef: { canonicalId, contractVersion } },
        }),
      ).toBeUndefined();
    },
  );
});
