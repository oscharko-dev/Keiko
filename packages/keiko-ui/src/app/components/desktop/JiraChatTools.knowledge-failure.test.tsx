import { render, screen, within } from "@testing-library/react";
import { axe } from "jest-axe";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChatToolExchange, ChatToolTranscript } from "@oscharko-dev/keiko-contracts/bff-wire";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { createToolRef } from "@oscharko-dev/keiko-tool-catalog";
import { I18N_STORAGE_KEY, I18nProvider, loadLocaleMessages } from "@/lib/i18n";
import { loadOptionalWidgetMessages } from "@/lib/optional-widget-i18n";
import { JiraChatTools } from "./JiraChatTools";
import { knowledgeToolFailureView } from "./knowledge-tool-failure";

function refusal(reason = "cursor-stale", data: CatalogJsonObject = {}): ChatToolExchange {
  return {
    call: { id: "document-read", name: "knowledge_documents", arguments: { view: "read" } },
    result: {
      schemaVersion: 1,
      invocationId: "document-result",
      toolRef: createToolRef("keiko.knowledge.documents", 1),
      projectionDigest: null,
      effectStarted: false,
      metrics: { inputBytes: 0, outputBytes: 0, resultCount: 0, durationMs: 0 },
      status: "failed",
      reason: "provider-reported-error",
      page: null,
      data: {
        outcome: "failed",
        reason,
        nextStep: "Untrusted next step: visit https://untrusted.example.invalid/private-cursor",
        ...data,
      },
    },
  };
}

function transcript(exchange: ChatToolExchange): ChatToolTranscript {
  return JSON.parse(
    JSON.stringify({ schemaVersion: 1, exchanges: [exchange] }),
  ) as ChatToolTranscript;
}

afterEach(() => localStorage.removeItem(I18N_STORAGE_KEY));
describe.each(["en", "de"] as const)("Knowledge source refusal in %s", (locale) => {
  const reason =
    locale === "en"
      ? "Keiko can no longer continue from the previous reading position."
      : "Keiko kann das Lesen an der bisherigen Stelle nicht fortsetzen.";
  const recovery =
    locale === "en"
      ? "Ask Keiko to read the documents again from the currently connected Knowledge Pods."
      : "Bitte Keiko, die Dokumente aus den aktuell verbundenen Knowledge Pods erneut zu lesen.";
  beforeEach(async () => {
    await Promise.all([loadLocaleMessages(locale), loadOptionalWidgetMessages(locale)]);
    localStorage.setItem(I18N_STORAGE_KEY, locale);
  });

  it("shows the known refusal and recovery while running and after history restore", async () => {
    const saved = transcript(refusal());
    const show = (turnState: "pending" | "completed"): ReturnType<typeof I18nProvider> => (
      <I18nProvider>
        <JiraChatTools transcript={saved} turnState={turnState} />
      </I18nProvider>
    );
    const first = render(show("pending"));
    expect(screen.getByText(reason)).toBeVisible();
    expect(screen.getByText(recovery)).toBeVisible();
    first.unmount();
    const { container } = render(show("completed"));
    const card = within(
      screen.getByRole("region", { name: locale === "en" ? "Documents" : "Dokumente" }),
    );
    expect(card.getByText(reason)).toBeVisible();
    expect(card.getByText(recovery)).toBeVisible();
    expect(
      card.getByText(locale === "en" ? "Could not complete" : "Konnte nicht abgeschlossen werden"),
    ).toBeVisible();
    expect(container.textContent).not.toMatch(
      /readable view|lesbare Ansicht|private-cursor|Untrusted|untrusted\.example/u,
    );
    expect(container.querySelector("pre, a, button")).toBeNull();
    expect(await axe(container)).toHaveNoViolations();
  });

  it.each([
    [
      "document-or-cursor-stale",
      "Keiko cannot continue reading or reviewing the selected document.",
      "Keiko kann das ausgewählte Dokument nicht weiter lesen oder prüfen.",
    ],
    [
      "document-stale-or-out-of-scope",
      "The selected document changed or is outside the currently connected Knowledge Pods.",
      "Das ausgewählte Dokument wurde geändert oder liegt außerhalb der aktuell verbundenen Knowledge Pods.",
    ],
    [
      "source-changed",
      "The connected sources changed during this request.",
      "Die verbundenen Quellen wurden während dieser Anfrage geändert.",
    ],
  ])("retains the distinct %s explanation for a canonical review", (code, en, de) => {
    const input = refusal(code);
    if (input.result === undefined) throw new TypeError("Expected a refusal result.");
    const review: ChatToolExchange = {
      ...input,
      call: { ...input.call, name: "knowledge_review" },
      result: { ...input.result, toolRef: createToolRef("keiko.knowledge.review", 2) },
    };
    render(
      <I18nProvider>
        <JiraChatTools transcript={transcript(review)} turnState="failed" />
      </I18nProvider>,
    );
    expect(screen.getByText(locale === "en" ? en : de)).toBeVisible();
    expect(screen.getByText(recovery)).toBeVisible();
  });

  it("keeps unknown failures opaque even when their next step looks actionable", () => {
    render(
      <I18nProvider>
        <JiraChatTools transcript={transcript(refusal("future-failure"))} turnState="failed" />
      </I18nProvider>,
    );
    expect(
      screen.getByText(
        locale === "en"
          ? "A readable view of this result is unavailable."
          : "Für dieses Ergebnis ist keine lesbare Ansicht verfügbar.",
      ),
    ).toBeVisible();
    expect(screen.queryByText(recovery)).toBeNull();
    expect(document.body.textContent).not.toMatch(/Untrusted|untrusted\.example/u);
  });
});

describe("canonical Knowledge refusal boundary", () => {
  it.each([null, 0, [], {}, "", "toString", "cursor-stale ", "CURSOR-STALE"])(
    "does not infer a closed reason from %j",
    (reason) => {
      expect(knowledgeToolFailureView(refusal("cursor-stale", { reason }))).toBeUndefined();
    },
  );

  it("refuses alias-only, foreign, old-version and mismatched producer identities", () => {
    const input = refusal();
    if (input.result === undefined) throw new TypeError("Expected a refusal result.");
    for (const toolRef of [
      null,
      createToolRef("keiko.external.tool", 1),
      createToolRef("keiko.knowledge.documents", 2),
      createToolRef("keiko.knowledge.review", 2),
    ])
      expect(
        knowledgeToolFailureView({ ...input, result: { ...input.result, toolRef } }),
      ).toBeUndefined();
    expect(
      knowledgeToolFailureView({
        ...input,
        call: { ...input.call, name: "knowledge_requirements" },
        result: { ...input.result, toolRef: createToolRef("keiko.knowledge.requirements", 1) },
      }),
    ).toBeUndefined();
  });

  it("requires an actual provider-reported failed result, never a successful or local failure", () => {
    const input = refusal();
    if (input.result?.status !== "failed" || input.result.reason !== "provider-reported-error")
      throw new TypeError("Expected a provider refusal result.");
    expect(knowledgeToolFailureView({ call: input.call })).toBeUndefined();
    expect(
      knowledgeToolFailureView(refusal("cursor-stale", { outcome: "succeeded" })),
    ).toBeUndefined();
    expect(
      knowledgeToolFailureView({
        ...input,
        result: { ...input.result, reason: "handler-failed", data: null },
      }),
    ).toBeUndefined();
    expect(
      knowledgeToolFailureView({
        ...input,
        result: {
          ...input.result,
          status: "completed",
          reason: "none",
          page: { truncated: false, reason: "none", cursor: null },
        },
      }),
    ).toBeUndefined();
  });
});
