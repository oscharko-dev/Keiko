import { render, screen } from "@testing-library/react";
import { axe } from "jest-axe";
import { describe, expect, it } from "vitest";
import type { ChatToolWriteApprovalView } from "@oscharko-dev/keiko-contracts";
import type { ChatToolExchange } from "@oscharko-dev/keiko-contracts/bff-wire";
import {
  JIRA_ATTACHMENTS_UNAVAILABLE_MESSAGE,
  JIRA_TEMPLATE_RULE_IDS,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { JiraChatTools } from "./JiraChatTools";
import { I18N_STORAGE_KEY, I18nProvider, loadLocaleMessages } from "@/lib/i18n";
import { loadOptionalWidgetMessages } from "@/lib/optional-widget-i18n";
import { OPTIONAL_WIDGET_DE_MESSAGES } from "@/lib/i18n-messages.optional.de";
import { OPTIONAL_WIDGET_EN_MESSAGES } from "@/lib/i18n-messages.optional.en";

// #4355 AC5 and AC6: the texts that depend on the #4354 write path. The result shapes are the ones
// the production builders emit; tests/atlassian-connectors/jira-dependent-result-texts-view.test.ts
// builds them with those builders and reads them with this card's own view, so a change of either
// side turns that test red. This file proves what the card shows, in both languages, with axe.
const LOCALES = ["en", "de"] as const;
const CATALOGS = {
  en: OPTIONAL_WIDGET_EN_MESSAGES as Readonly<Record<string, string>>,
  de: OPTIONAL_WIDGET_DE_MESSAGES as Readonly<Record<string, string>>,
} as const;

function exchange(
  name: string,
  data: Record<string, unknown>,
  approval?: ChatToolWriteApprovalView,
): ChatToolExchange {
  return {
    call: { id: "call-1", name, arguments: {} },
    result: {
      schemaVersion: 1,
      invocationId: "invocation-1",
      toolRef: null,
      projectionDigest: null,
      effectStarted: false,
      metrics: { inputBytes: 10, outputBytes: 10, resultCount: 1, durationMs: 20 },
      status: "completed",
      reason: "none",
      page: { truncated: false, reason: "none", cursor: null },
      data,
    } as NonNullable<ChatToolExchange["result"]>,
    ...(approval === undefined ? {} : { approval }),
  };
}
function approval(state: ChatToolWriteApprovalView["state"]): ChatToolWriteApprovalView {
  return {
    kind: "jira-chat-write",
    approvalId: "approval-1",
    chatId: "chat-1",
    podId: "11111111-1111-4111-8111-111111111111",
    bindingGeneration: 1,
    authenticationGeneration: 1,
    invocationId: "action-1",
    operation: "jira.edit",
    actionDigest: "a".repeat(64),
    requestedAt: Date.now(),
    expiresAt: Date.now() + 60000,
    state,
  };
}
async function show(
  locale: (typeof LOCALES)[number],
  tool: ChatToolExchange,
): Promise<HTMLElement> {
  await Promise.all([loadLocaleMessages(locale), loadOptionalWidgetMessages(locale)]);
  window.localStorage.setItem(I18N_STORAGE_KEY, locale);
  const { container } = render(
    <I18nProvider>
      <JiraChatTools transcript={{ schemaVersion: 1, exchanges: [tool] }} turnState="completed" />
    </I18nProvider>,
  );
  return container;
}
function sentence(
  locale: (typeof LOCALES)[number],
  key: string,
  values: Record<string, string> = {},
): string {
  return (CATALOGS[locale][key] ?? "").replace(
    /\{(\w+)\}/gu,
    (_m, name: string) => values[name] ?? "",
  );
}

describe.each(LOCALES)("the texts that depend on the write path (%s)", (locale) => {
  it.each([["expired"], ["revoked"]] as const)(
    "tells the person what to do after a %s approval",
    async (state) => {
      const container = await show(
        locale,
        exchange(
          "jira_edit",
          { outcome: "not-dispatched", reason: "effect-denied" },
          approval(state),
        ),
      );
      expect(
        screen.getByText(sentence(locale, `chat.jira.writeApproval.${state}Hint`)),
      ).toBeVisible();
      // The approval ended without a decision: the card adds no connection failure on top.
      expect(container.textContent).not.toContain(
        sentence(locale, "chat.jira.outcome.failure.unavailable"),
      );
      expect(container.textContent).not.toMatch(/chat\.jira\./u);
      expect(await axe(container)).toHaveNoViolations();
    },
  );

  it.each([
    ["template-missing", "Story"],
    ["template-not-activated", "Story"],
  ] as const)(
    "says where a template is created when a create is refused (%s)",
    async (ruleId, subject) => {
      const container = await show(
        locale,
        exchange("jira_create", {
          outcome: "rejected",
          reason: "field-validation",
          violations: [{ ruleId, subject, template: "SYN/Story" }],
        }),
      );
      const expected = sentence(locale, `chat.jira.outcome.rule.${ruleId}`, { subject });
      expect(screen.getByText(expected)).toBeVisible();
      // The sentence names the place (Skills) and the action to take, in the person's language.
      expect(expected).toContain("Skills");
      expect(container.textContent).not.toMatch(/chat\.jira\./u);
      expect(await axe(container)).toHaveNoViolations();
    },
  );

  it("words every template rule of a succeeded edit from the catalog, never from free text", async () => {
    const notices = JIRA_TEMPLATE_RULE_IDS.filter(
      (ruleId) => ruleId !== "template-missing" && ruleId !== "template-not-activated",
    ).map((ruleId) => ({ ruleId, subject: "Fix version", template: "SYN/Story" }));
    const container = await show(
      locale,
      exchange("jira_edit", {
        outcome: "succeeded",
        issueKey: "SYN-1",
        guidance: "Model-facing guidance that must never reach the card.",
        templateNotices: [
          ...notices,
          { ruleId: "not-a-rule", subject: "Free text of the model", template: "x" },
        ],
      }),
    );
    expect(screen.getByText(sentence(locale, "chat.jira.outcome.templateNotices"))).toBeVisible();
    const list = screen.getByRole("list", { name: sentence(locale, "chat.jira.outcome.rules") });
    expect(list.querySelectorAll("li")).toHaveLength(notices.length);
    expect(container.textContent).not.toContain("Model-facing guidance");
    expect(container.textContent).not.toContain("Free text of the model");
    expect(container.textContent).not.toMatch(/chat\.jira\./u);
    expect(await axe(container)).toHaveNoViolations();
  });

  it("shows no notice for an edit that broke no rule", async () => {
    await show(locale, exchange("jira_edit", { outcome: "succeeded", issueKey: "SYN-1" }));
    expect(screen.queryByText(sentence(locale, "chat.jira.outcome.templateNotices"))).toBeNull();
  });

  it("words the release switch's refusal of an attachment call from the catalog", async () => {
    const container = await show(
      locale,
      exchange("jira_attach", {
        outcome: "failed",
        reason: "unavailable",
        messages: [JIRA_ATTACHMENTS_UNAVAILABLE_MESSAGE],
      }),
    );
    expect(
      screen.getByText(sentence(locale, "chat.jira.outcome.failure.releaseScope")),
    ).toBeVisible();
    // The raw English sentence of the switch is not shown beside it, and no connection failure is.
    if (locale === "de")
      expect(container.textContent).not.toContain(JIRA_ATTACHMENTS_UNAVAILABLE_MESSAGE);
    expect(container.textContent).not.toContain(
      sentence(locale, "chat.jira.outcome.failure.unavailable"),
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe("the added texts exist in both languages (#4355 AC6)", () => {
  it("has an English and a German text with the same placeholders for each key", () => {
    const keys = [
      "chat.jira.writeApproval.expiredHint",
      "chat.jira.writeApproval.revokedHint",
      "chat.jira.outcome.templateNotices",
      "chat.jira.outcome.failure.releaseScope",
      "chat.jira.outcome.rule.template-missing",
      "chat.jira.outcome.rule.template-not-activated",
      "chat.jira.outcome.validation.invalid-epic-link",
    ];
    const placeholders = (text: string): string[] => text.match(/\{\w+\}/gu)?.sort() ?? [];
    for (const key of keys) {
      const en = CATALOGS.en[key];
      const de = CATALOGS.de[key];
      expect(en, key).toBeTruthy();
      expect(de, key).toBeTruthy();
      expect(de, key).not.toBe(en);
      expect(placeholders(de ?? ""), key).toEqual(placeholders(en ?? ""));
    }
  });
});
