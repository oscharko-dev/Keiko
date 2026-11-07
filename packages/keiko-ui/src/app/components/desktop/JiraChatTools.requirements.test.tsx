import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type {
  ChatToolExchange,
  ChatToolTranscript,
  ChatTurnState,
} from "@oscharko-dev/keiko-contracts/bff-wire";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { createToolRef } from "@oscharko-dev/keiko-tool-catalog";
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
  },
  de: {
    label: "Anforderungen",
    partial: "Teilliste. Nicht alle Anforderungen sind enthalten.",
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
        expect(document.querySelector("details, pre")).toBeNull();
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
      // A complete inventory earns no card: the progress already shows the step as done.
      expect(screen.queryByText(COPY.en.label)).toBeNull();
      expect(screen.queryByText(COPY.en.partial)).toBeNull();
      expect(screen.queryByText(/Partial Jira result/)).toBeNull();
    } finally {
      localStorage.removeItem(I18N_STORAGE_KEY);
    }
  });
});

function knowledgeReceipt(
  data: CatalogJsonObject,
  args: Record<string, unknown> = {},
  canonicalId = "keiko.knowledge.requirements",
): ChatToolExchange {
  const base = requirementsRead({});
  if (base.result?.status !== "completed") throw new TypeError("Expected completed tool receipt");
  return {
    ...base,
    call: { ...base.call, arguments: args },
    result: { ...base.result, toolRef: createToolRef(canonicalId, 1), data },
  };
}

async function renderCoverage(
  locale: "en" | "de",
  exchanges: readonly ChatToolExchange[],
  turnState: ChatTurnState = "completed",
): Promise<void> {
  await Promise.all([loadLocaleMessages(locale), loadOptionalWidgetMessages(locale)]);
  localStorage.setItem(I18N_STORAGE_KEY, locale);
  const transcript: ChatToolTranscript = { schemaVersion: 1, exchanges };
  // Reload and canonical reconciliation preserve the existing transcript wire, without new fields.
  const restored = JSON.parse(JSON.stringify(transcript)) as ChatToolTranscript;
  render(
    <I18nProvider>
      <JiraChatTools transcript={restored} turnState={turnState} />
    </I18nProvider>,
  );
  localStorage.removeItem(I18N_STORAGE_KEY);
}

const incompleteRead = (): ChatToolExchange =>
  knowledgeReceipt({
    outcome: "succeeded",
    view: "units",
    nextCursor: "next-page",
    totals: { documentCount: 9, unitsOmitted: 2 },
    items: [{ reference: "REQ-1", acceptanceCriteria: [] }],
  });

const COVERAGE_COPY = {
  en: {
    title: "Result with limitations",
    read: "Unfinished reads: 1.",
    omitted: "Requirements not read: 2.",
    criteria: "Requirements without detected acceptance criteria in the source: 1.",
    review: "Documents fully reviewed: 0 of 1 requested.",
  },
  de: {
    title: "Ergebnis mit Einschränkungen",
    read: "Offene Lesevorgänge: 1.",
    omitted: "Nicht eingelesene Anforderungen: 2.",
    criteria: "Anforderungen ohne erkannte Akzeptanzkriterien in der Quelle: 1.",
    review: "Vollständig geprüfte Dokumente: 0 von 1 angefragten.",
  },
} as const;

describe("durable Knowledge coverage notice", () => {
  it.each([
    ["en", "completed"],
    ["de", "completed"],
    ["en", "failed"],
    ["de", "failed"],
    ["en", "cancelled"],
    ["de", "cancelled"],
  ] as const)("retains each observed gap after %s %s and reload", async (locale, state) => {
    await renderCoverage(locale, [incompleteRead()], state);
    const notice = within(screen.getByRole("alert"));
    expect(notice.getByText(COVERAGE_COPY[locale].title)).toBeVisible();
    expect(notice.getByText(COVERAGE_COPY[locale].read)).toBeVisible();
    expect(notice.getByText(COVERAGE_COPY[locale].omitted)).toBeVisible();
    expect(notice.getByText(COVERAGE_COPY[locale].criteria)).toBeVisible();
    expect(notice.getAllByRole("listitem")).toHaveLength(3);
    expect(notice.queryByText(/Source coverage:|page chain|Explicit document reviews/u)).toBeNull();
  });

  it.each(["en", "de"] as const)("uses the requested review count in %s", async (locale) => {
    const inventory = knowledgeReceipt(
      { outcome: "succeeded", view: "inventory", totals: { documentCount: 9 }, items: [] },
      {},
      "keiko.knowledge.documents",
    );
    const review = knowledgeReceipt(
      {
        outcome: "succeeded",
        view: "review",
        items: [],
        coverage: {
          documentScope: "doc-a",
          revisionDigest: "revision-a",
          textRevision: "text-a",
          documentReviewComplete: false,
        },
      },
      { documentScope: "doc-a" },
      "keiko.knowledge.review",
    );
    await renderCoverage(locale, [
      inventory,
      { ...review, call: { ...review.call, id: "review-1" } },
    ]);
    expect(within(screen.getByRole("alert")).getByText(COVERAGE_COPY[locale].review)).toBeVisible();
    expect(screen.queryByText(/0 (?:of|von) 9/u)).toBeNull();
  });

  it("waits for the running turn to finish before announcing a partial result", async () => {
    await renderCoverage("en", [incompleteRead()], "pending");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("does not request a semantic review merely because a complete inventory contains documents", async () => {
    const inventory = knowledgeReceipt(
      { outcome: "succeeded", view: "inventory", totals: { documentCount: 9 }, items: [] },
      {},
      "keiko.knowledge.documents",
    );
    await renderCoverage("en", [inventory]);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("does not accept coverage claims from an external tool with similar output", async () => {
    const external = incompleteRead();
    if (external.result === undefined) throw new Error("Expected tool receipt");
    await renderCoverage("en", [
      {
        ...external,
        result: {
          ...external.result,
          toolRef: createToolRef("keiko.external.tool", 1),
        },
      },
    ]);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
