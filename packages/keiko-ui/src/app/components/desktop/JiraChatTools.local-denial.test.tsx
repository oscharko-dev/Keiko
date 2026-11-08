import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChatToolExchange, ChatToolTranscript } from "@oscharko-dev/keiko-contracts/bff-wire";
import { I18N_STORAGE_KEY, I18nProvider, loadLocaleMessages } from "@/lib/i18n";
import { loadOptionalWidgetMessages } from "@/lib/optional-widget-i18n";
import { JiraChatTools } from "./JiraChatTools";
import { jiraLocalAccessDenialNotice } from "./jira-tool-presentation";

function refused(mutationOutcome: "not-dispatched" | "unknown"): ChatToolExchange {
  return {
    call: { id: "local-refusal", name: "jira_edit", arguments: { issueKey: "SYN-1" } },
    mutationOutcome,
    result: {
      schemaVersion: 1,
      invocationId: "local-refusal",
      toolRef: null,
      projectionDigest: null,
      effectStarted: false,
      metrics: { inputBytes: 0, outputBytes: 0, resultCount: 0, durationMs: 0 },
      status: "denied",
      reason: "effect-denied",
      page: null,
      data: null,
    },
  };
}
afterEach(() => localStorage.removeItem(I18N_STORAGE_KEY));
describe.each(["en", "de"] as const)("persisted local Jira scope refusal in %s", (locale) => {
  beforeEach(async () => {
    await Promise.all([loadLocaleMessages(locale), loadOptionalWidgetMessages(locale)]);
    localStorage.setItem(I18N_STORAGE_KEY, locale);
  });
  it.each(["not-dispatched", "unknown"] as const)(
    "keeps journal outcome %s and a local connector notice after reload",
    (outcome) => {
      const restored = JSON.parse(
        JSON.stringify({ schemaVersion: 1, exchanges: [refused(outcome)] }),
      ) as ChatToolTranscript;
      const show = (): ReturnType<typeof render> =>
        render(
          <I18nProvider>
            <JiraChatTools transcript={restored} turnState="failed" />
          </I18nProvider>,
        );
      const first = show();
      const previous = first.container.textContent;
      first.unmount();
      const { container } = show();
      expect(container.textContent).toBe(previous);
      expect(
        screen.getByText(
          locale === "en"
            ? "Connector access is not permitted for this action."
            : "Connector-Zugriff ist für diese Aktion nicht zulässig.",
        ),
      ).toBeVisible();
      const label =
        outcome === "not-dispatched"
          ? locale === "en"
            ? "Not sent to Jira"
            : "Nicht an Jira gesendet"
          : locale === "en"
            ? "Jira outcome unknown"
            : "Ausgang der Jira-Aktion unbekannt";
      expect(screen.getByText(label)).toBeVisible();
      expect(
        screen.queryByText(locale === "en" ? "Jira change confirmed" : "Jira-Änderung bestätigt"),
      ).toBeNull();
      if (outcome === "unknown")
        expect(
          screen.getByText(
            locale === "en"
              ? "The change may have been applied. Check Jira before requesting another change. This action is not retried automatically."
              : "Die Änderung wurde möglicherweise ausgeführt. Prüfe Jira, bevor du eine weitere Änderung anforderst. Diese Aktion wird nicht automatisch wiederholt.",
          ),
        ).toBeVisible();
      expect(container.querySelector("button, pre, a")).toBeNull();
    },
  );
});
it("does not reinterpret unrelated tools or another closed refusal as Jira connector access", () => {
  const exchange = refused("not-dispatched");
  expect(
    jiraLocalAccessDenialNotice({
      ...exchange,
      call: { ...exchange.call, name: "mcp_external_write" },
    }),
  ).toBeUndefined();
  expect(
    jiraLocalAccessDenialNotice({
      ...exchange,
      call: { ...exchange.call, name: "jira_unregistered_tool" },
    }),
  ).toBeUndefined();
  expect(jiraLocalAccessDenialNotice({ call: exchange.call })).toBeUndefined();
  if (exchange.result?.status !== "denied") throw new TypeError("Missing denied fixture");
  expect(
    jiraLocalAccessDenialNotice({
      ...exchange,
      result: { ...exchange.result, reason: "budget-exhausted" },
    }),
  ).toBeUndefined();
});
