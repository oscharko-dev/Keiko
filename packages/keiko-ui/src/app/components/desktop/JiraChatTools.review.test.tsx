import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ChatToolExchange, ChatToolTranscript } from "@oscharko-dev/keiko-contracts/bff-wire";
import { createToolRef } from "@oscharko-dev/keiko-tool-catalog";
import { I18N_STORAGE_KEY, I18nProvider, loadLocaleMessages } from "@/lib/i18n";
import { loadOptionalWidgetMessages } from "@/lib/optional-widget-i18n";
import { JiraChatTools } from "./JiraChatTools";
import { knowledgeReviewFailureNotice } from "./jira-tool-presentation";
import { axe } from "jest-axe";

function failedReview(failureStage: string, data: Record<string, unknown> = {}): ChatToolExchange {
  return {
    call: { id: "review-1", name: "knowledge_review", arguments: { documentScope: "doc-a" } },
    result: {
      schemaVersion: 1,
      invocationId: "review-result",
      projectionDigest: null,
      toolRef: createToolRef("keiko.knowledge.review", 2),
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
    ["keiko.external.tool", 2],
    ["keiko.knowledge.review", 1],
  ] as const)(
    "does not trust %s contract version %s as the source-checked review contract",
    (canonicalId, contractVersion) => {
      const exchange = failedReview("model-output-invalid");
      if (exchange.result === undefined) throw new Error("Expected receipt");
      expect(
        knowledgeReviewFailureNotice({
          ...exchange,
          result: { ...exchange.result, toolRef: createToolRef(canonicalId, contractVersion) },
        }),
      ).toBeUndefined();
    },
  );
});

describe("cited Knowledge review proposals", () => {
  it.each(["en", "de"] as const)(
    "renders the stored %s source window as a proposal, not an applied or exhaustive result",
    async (locale) => {
      await Promise.all([loadLocaleMessages(locale), loadOptionalWidgetMessages(locale)]);
      localStorage.setItem(I18N_STORAGE_KEY, locale);
      try {
        const failed = failedReview("model-output-invalid");
        if (failed.result === undefined) throw new TypeError("Missing review fixture");
        const exchange: ChatToolExchange = {
          ...failed,
          result: {
            ...failed.result,
            status: "completed",
            reason: "none",
            page: { truncated: false, reason: "none", cursor: null },
            data: {
              outcome: "succeeded",
              view: "review",
              items: [
                {
                  proposalId: "finding-7",
                  origin: "model-proposal",
                  status: "proposed",
                  kind: "clarification",
                  proposal: "Clarify retention duration.",
                  question: "How long is evidence retained?",
                  sources: [
                    {
                      documentScope: "doc-a",
                      revisionDigest: "revision-a",
                      textRevision: "text-a",
                      characterStart: 5,
                      characterEnd: 25,
                      quote: "Retain the evidence.",
                      quoteTruncated: false,
                    },
                  ],
                },
              ],
              coverage: {
                documentScope: "doc-a",
                revisionDigest: "revision-a",
                textRevision: "text-a",
                reviewFingerprint: "review-a",
                characterStart: 0,
                characterEnd: 30,
                documentChars: 90,
                reviewedWindows: 1,
                totalWindows: 3,
                windowReviewComplete: true,
                documentReviewComplete: false,
                originalModified: false,
                semanticExhaustivenessProven: false,
              },
              nextCursor: "private-review-cursor",
            },
          },
        };
        const transcript: ChatToolTranscript = { schemaVersion: 1, exchanges: [exchange] };
        const restoredTranscript = JSON.parse(JSON.stringify(transcript)) as ChatToolTranscript;
        const show = (): ReturnType<typeof render> =>
          render(
            <I18nProvider>
              <JiraChatTools turnState="completed" transcript={restoredTranscript} />
            </I18nProvider>,
          );
        const first = show();
        const text = first.container.textContent;
        first.unmount();
        const restored = show();
        expect(restored.container.textContent).toBe(text);
        expect(screen.getByText("Clarify retention duration.")).toBeVisible();
        expect(screen.getByText(/doc-a · 5–25/u)).toBeVisible();
        expect(screen.getByText(/Retain the evidence\./u)).toBeVisible();
        expect(
          screen.getByText(
            locale === "en"
              ? "Model proposal; the source remains unchanged."
              : "Modellvorschlag; die Quelle bleibt unverändert.",
          ),
        ).toBeVisible();
        expect(
          screen.getByText(
            locale === "en"
              ? "Partial result. Some document information is not included."
              : "Teilergebnis. Nicht alle Dokumentinformationen sind enthalten.",
          ),
        ).toBeVisible();
        expect(restored.container.querySelector("pre, a, input, button")).toBeNull();
        expect(restored.container.textContent).not.toContain("private-review-cursor");
        expect(await axe(restored.container)).toHaveNoViolations();
      } finally {
        localStorage.removeItem(I18N_STORAGE_KEY);
      }
    },
  );
});
