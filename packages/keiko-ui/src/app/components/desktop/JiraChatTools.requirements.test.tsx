import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { axe } from "jest-axe";
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
import * as diagnostics from "@/lib/client-diagnostics";

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
    partial: "Not all requirements were read.",
    unitsOmitted: "Requirements left out: 2",
    documentsOmitted: "Documents left out: 1",
    notExtracted: "Documents that could not be read: 1",
    paged: "Requirements read: 1 of 3",
  },
  de: {
    label: "Anforderungen",
    partial: "Nicht alle Anforderungen wurden gelesen.",
    unitsOmitted: "Ausgelassene Anforderungen: 2",
    documentsOmitted: "Ausgelassene Dokumente: 1",
    notExtracted: "Dokumente, die nicht gelesen werden konnten: 1",
    paged: "Anforderungen gelesen: 1 von 3",
  },
} as const;

describe("knowledge.requirements transcript row", () => {
  it.each([
    ["en", "an omitted unit", { unitsOmitted: 2 }, undefined, "unitsOmitted"],
    ["en", "a named cut reason", { cutReasons: ["byte-budget"] }, undefined, "partial"],
    ["en", "an omitted document", { documentsOmitted: 1 }, undefined, "documentsOmitted"],
    [
      "en",
      "a document that was not extracted",
      { documentsNotExtracted: 1 },
      undefined,
      "notExtracted",
    ],
    ["en", "a further page only", {}, "cursor-2", "paged"],
    ["de", "an omitted unit", { unitsOmitted: 2 }, undefined, "unitsOmitted"],
    ["de", "a further page only", {}, "cursor-2", "paged"],
  ] as const)(
    "counts the read and names only a real cut in %s: %s",
    async (locale, _case, totals, nextCursor, expected) => {
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
        const card = screen.getByRole("region", { name: COPY[locale].label });
        expect(within(card).getByText(COPY[locale].paged)).toBeVisible();
        expect(within(card).getByRole("progressbar")).toHaveAttribute("aria-valuenow", "1");
        if (expected === "paged") {
          // A further page is progress, not a cut: nothing is said to be missing.
          expect(
            within(card).queryByText(
              /left out|Ausgelassene|could not|nicht gelesen|Not all|Nicht alle/u,
            ),
          ).toBeNull();
        } else {
          expect(within(card).getByText(COPY[locale][expected])).toBeVisible();
        }
        expect(card.querySelector("[data-tone]")).toHaveAttribute(
          "data-tone",
          expected === "paged" ? "info" : "warning",
        );
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
    call: { ...base.call, name: canonicalId.replace("keiko.", "").replaceAll(".", "_"), arguments: args },
    result: { ...base.result, toolRef: createToolRef(canonicalId, canonicalId === "keiko.knowledge.review" ? 2 : 1), data },
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

describe("readable Knowledge source receipts", () => {
  it.each(["en", "de"] as const)("keeps requirements and document facts readable in %s after remount without Jira failure evidence", async (locale) => {
    await Promise.all([loadLocaleMessages(locale), loadOptionalWidgetMessages(locale)]);
    localStorage.setItem(I18N_STORAGE_KEY, locale);
    const report = vi.spyOn(diagnostics, "reportClientDiagnostic");
    try {
      const requirement = knowledgeReceipt({ outcome: "succeeded", view: "units",
        totals: { detectedCount: 3, matchedCount: 2, documentsScanned: 1, unitsOmitted: 0 },
        items: [{ reference: "source-a:REQ-7", title: "Preserve evidence", statement: "Evidence must survive reload.",
          documentScope: "source-a", documentName: "Requirements.pdf", pageLabel: "7", sectionPath: ["System", "Evidence"],
          acceptanceCriteria: [{ id: "AC-7", text: "Restored evidence is readable." }], characterStart: 0, characterEnd: 36 }], nextCursor: "private-next" });
      const document = knowledgeReceipt({ outcome: "succeeded", view: "read", totals: { documentCount: 9 },
        items: [{ documentScope: "source-a", documentName: "Source.pdf", text: "Source <script> remains text.",
          characterStart: 0, characterEnd: 30, positionSpace: "original-document-text", extractionStatus: "extracted" }],
        coverage: { documentComplete: false, returnedChars: 30, documentChars: 90 } }, {}, "keiko.knowledge.documents");
      const transcript: ChatToolTranscript = { schemaVersion: 1, exchanges: [requirement, { ...document, call: { ...document.call, id: "document-read" } }] };
      const show = (value: ChatToolTranscript, state: ChatTurnState) => <I18nProvider>
        <JiraChatTools transcript={value} turnState={state} messageId="private-knowledge-message" />
      </I18nProvider>;
      const live = render(show(transcript, "pending"));
      live.rerender(show(transcript, "completed"));
      const before = live.container.textContent;
      live.unmount();
      const saved = JSON.parse(JSON.stringify(transcript)) as ChatToolTranscript;
      const restored = render(show(saved, "completed"));
      expect(restored.container.textContent).toBe(before);
      expect(screen.getByText("source-a:REQ-7")).toBeVisible();
      expect(screen.getByText("Preserve evidence")).toBeVisible();
      expect(screen.getByText("Evidence must survive reload.")).toBeVisible();
      expect(screen.getByText(/AC-7: Restored evidence is readable\./u)).toBeVisible();
      expect(screen.getByText(locale === "en" ? "Source page: 7" : "Quellseite: 7")).toBeVisible();
      expect(screen.getByText(locale === "en" ? "Section: System › Evidence" : "Abschnitt: System › Evidence")).toBeVisible();
      expect(screen.getByText("Source <script> remains text.")).toBeVisible();
      expect(screen.getAllByRole("list", { name: locale === "en" ? "Knowledge results" : "Wissensergebnisse" })).toHaveLength(2);
      expect(screen.getByText(locale === "en" ? "1 of 2 results returned." : "1 von 2 Ergebnissen zurückgegeben.")).toBeVisible();
      expect(screen.queryByText(locale === "en" ? "1 of 9 results returned." : "1 von 9 Ergebnissen zurückgegeben.")).toBeNull();
      expect(restored.container.querySelector("pre, script, a, input, button")).toBeNull();
      expect(restored.container.textContent).not.toMatch(/private-next|readable view.*unavailable|Jira-Ergebnisse|Jira results/u);
      expect(report.mock.calls.some(([, meta]) => meta?.jiraResultPresentation !== undefined)).toBe(false);
      expect(await axe(restored.container)).toHaveNoViolations();
    } finally {
      report.mockRestore();
      localStorage.removeItem(I18N_STORAGE_KEY);
    }
  });
});
