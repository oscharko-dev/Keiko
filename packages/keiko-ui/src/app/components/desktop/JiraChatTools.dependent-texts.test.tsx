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
function approval(
  state: ChatToolWriteApprovalView["state"],
  expiresAt = Date.now() + 60000,
): ChatToolWriteApprovalView {
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
    expiresAt,
    state,
  };
}
async function show(
  locale: (typeof LOCALES)[number],
  tool: ChatToolExchange,
  turnState: "completed" | "pending" = "completed",
): Promise<HTMLElement> {
  await Promise.all([loadLocaleMessages(locale), loadOptionalWidgetMessages(locale)]);
  window.localStorage.setItem(I18N_STORAGE_KEY, locale);
  const { container } = render(
    <I18nProvider>
      <JiraChatTools transcript={{ schemaVersion: 1, exchanges: [tool] }} turnState={turnState} />
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

  // The clock never decides that nothing was changed: a stored approval that was granted or claimed
  // may belong to a write that ran, however long ago it expired (#4355 AC5, audit of 3847c53a2).
  const PAST = Date.now() - 3_600_000;
  it.each([
    ["a succeeded result", { outcome: "succeeded", issueKey: "SYN-1" }],
    ["an unknown outcome", { outcome: "unknown" }],
  ] as const)(
    "never says nothing was changed for a stored approved approval with %s",
    async (_name, data) => {
      const container = await show(locale, exchange("jira_edit", data, approval("approved", PAST)));
      expect(
        screen.getByText(sentence(locale, "chat.jira.writeApproval.outcomeUnknownHint")),
      ).toBeVisible();
      // The state line states what was stored, not what the clock says.
      expect(container.textContent).toContain(sentence(locale, "chat.jira.writeApproval.approved"));
      expect(container.textContent).not.toContain(
        sentence(locale, "chat.jira.writeApproval.expired"),
      );
      expect(container.textContent).not.toContain(
        sentence(locale, "chat.jira.writeApproval.expiredHint"),
      );
      expect(await axe(container)).toHaveNoViolations();
    },
  );
  it("states a claimed approval as claimed, whatever the clock says, and claims nothing", async () => {
    const container = await show(locale, {
      call: { id: "call-1", name: "jira_edit", arguments: {} },
      approval: approval("claimed", PAST),
    });
    expect(container.textContent).toContain(sentence(locale, "chat.jira.writeApproval.claimed"));
    expect(container.textContent).not.toContain(
      sentence(locale, "chat.jira.writeApproval.expiredHint"),
    );
    expect(container.textContent).not.toContain(
      sentence(locale, "chat.jira.writeApproval.expired"),
    );
  });
  it("says only that the approval was revoked when a write has a result", async () => {
    const container = await show(
      locale,
      exchange("jira_edit", { outcome: "succeeded", issueKey: "SYN-1" }, approval("revoked")),
    );
    expect(container.textContent).toContain(sentence(locale, "chat.jira.writeApproval.revoked"));
    expect(
      screen.getByText(sentence(locale, "chat.jira.writeApproval.outcomeUnknownHint")),
    ).toBeVisible();
    expect(container.textContent).not.toContain(
      sentence(locale, "chat.jira.writeApproval.revokedHint"),
    );
    expect(await axe(container)).toHaveNoViolations();
  });
  it.each([
    ["no result", undefined],
    [
      "the producer's not-dispatched result",
      { outcome: "not-dispatched", reason: "effect-denied" },
    ],
  ] as const)(
    "says nothing was changed when the turn ended while the approval waited (%s)",
    async (_name, data) => {
      const base =
        data === undefined
          ? {
              call: { id: "call-1", name: "jira_edit", arguments: {} },
              approval: approval("pending"),
            }
          : exchange("jira_edit", data, approval("pending"));
      const container = await show(locale, base);
      expect(
        screen.getByText(sentence(locale, "chat.jira.writeApproval.expiredHint")),
      ).toBeVisible();
      expect(container.textContent).toContain(sentence(locale, "chat.jira.writeApproval.expired"));
      expect(await axe(container)).toHaveNoViolations();
    },
  );
  it("tells a pending approval of a running turn nothing about the outcome", async () => {
    await show(
      locale,
      {
        call: { id: "call-1", name: "jira_edit", arguments: {} },
        approval: approval("pending"),
      },
      "pending",
    );
    expect(screen.queryByText(sentence(locale, "chat.jira.writeApproval.expiredHint"))).toBeNull();
    expect(
      screen.queryByText(sentence(locale, "chat.jira.writeApproval.outcomeUnknownHint")),
    ).toBeNull();
  });
  it("announces the hint with the state line, inside the live status", async () => {
    await show(locale, exchange("jira_edit", { outcome: "not-dispatched" }, approval("expired")));
    const hint = screen.getByText(sentence(locale, "chat.jira.writeApproval.expiredHint"));
    expect(hint.closest("output")).toHaveAttribute("aria-live", "polite");
  });

  it("shows a template notice even when it is all the card has to say", async () => {
    // A read-shaped call whose card would otherwise stay empty: the notice alone earns the card.
    await show(
      locale,
      exchange("jira_projects", {
        outcome: "succeeded",
        templateNotices: [{ ruleId: "label-count", subject: "labels", template: "SYN/Story" }],
      }),
    );
    expect(screen.getByText(sentence(locale, "chat.jira.outcome.templateNotices"))).toBeVisible();
  });
  it("bounds a rule subject like the server does", async () => {
    await show(
      locale,
      exchange("jira_edit", {
        outcome: "succeeded",
        templateNotices: [{ ruleId: "parent-missing", subject: "S".repeat(300), template: "x" }],
      }),
    );
    expect(
      screen.getByText(
        sentence(locale, "chat.jira.outcome.rule.parent-missing", { subject: "S".repeat(120) }),
      ),
    ).toBeVisible();
  });
  it("labels the switch's sentence only for the attachment call it refused", async () => {
    const container = await show(
      locale,
      exchange("jira_edit", {
        outcome: "failed",
        reason: "unavailable",
        messages: [JIRA_ATTACHMENTS_UNAVAILABLE_MESSAGE],
      }),
    );
    // Any other tool keeps the message as an ordinary problem beside its ordinary failure line,
    // and the sentence is not turned into the release-scope line.
    expect(container.textContent).toContain(JIRA_ATTACHMENTS_UNAVAILABLE_MESSAGE);
    expect(container.textContent).toContain(
      sentence(locale, "chat.jira.outcome.failure.unavailable"),
    );
  });
  it("words the refusal of a delete-attachment call as well", async () => {
    await show(
      locale,
      exchange("jira_delete_attachment", {
        outcome: "failed",
        reason: "unavailable",
        messages: [JIRA_ATTACHMENTS_UNAVAILABLE_MESSAGE],
      }),
    );
    expect(
      screen.getByText(sentence(locale, "chat.jira.outcome.failure.releaseScope")),
    ).toBeVisible();
  });

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
      "chat.jira.writeApproval.outcomeUnknownHint",
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
