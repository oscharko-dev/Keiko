import type { ReactNode } from "react";
import { render } from "@testing-library/react";
import { axe } from "jest-axe";
import { describe, expect, it } from "vitest";
import { CHAT_CLAIM_NOTICES } from "@oscharko-dev/keiko-contracts/bff-wire";
import { I18N_STORAGE_KEY, I18nProvider, loadLocaleMessages } from "@/lib/i18n";
import { loadOptionalWidgetMessages } from "@/lib/optional-widget-i18n";
import { OPTIONAL_WIDGET_DE_MESSAGES } from "@/lib/i18n-messages.optional.de";
import { OPTIONAL_WIDGET_EN_MESSAGES } from "@/lib/i18n-messages.optional.en";
import { ClaimNoticeLine, useClaimNoticeText } from "./ClaimNoticeLine";

const KEYS = [
  "chat.claimNotice.label",
  "chat.claimNotice.noJiraCreate",
  "chat.claimNotice.toolCallNotExecuted",
] as const;

function Line({ notice }: { readonly notice: (typeof CHAT_CLAIM_NOTICES)[number] }): ReactNode {
  return <ClaimNoticeLine text={useClaimNoticeText(notice)} />;
}

describe("the claim notice texts (#4355 AC6)", () => {
  it("has an English and a German text with the same placeholders for each key", () => {
    const placeholders = (text: string): string[] => text.match(/\{\w+\}/gu)?.sort() ?? [];
    for (const key of KEYS) {
      const en = (OPTIONAL_WIDGET_EN_MESSAGES as Readonly<Record<string, string>>)[key];
      const de = (OPTIONAL_WIDGET_DE_MESSAGES as Readonly<Record<string, string>>)[key];
      expect(en, key).toBeTruthy();
      expect(de, key).toBeTruthy();
      expect(de, key).not.toBe(en);
      expect(placeholders(de ?? ""), key).toEqual(placeholders(en ?? ""));
    }
  });

  it("covers every closed marker value with its own sentence", () => {
    expect(CHAT_CLAIM_NOTICES).toEqual(["no-jira-create", "tool-call-not-executed"]);
    for (const key of KEYS.slice(1)) expect(OPTIONAL_WIDGET_EN_MESSAGES).toHaveProperty(key);
  });

  it("renders nothing without text", () => {
    const { container } = render(<ClaimNoticeLine text={undefined} />);
    expect(container).toBeEmptyDOMElement();
  });

  it.each(["en", "de"] as const)("passes the accessibility check in %s", async (locale) => {
    await Promise.all([loadLocaleMessages(locale), loadOptionalWidgetMessages(locale)]);
    window.localStorage.setItem(I18N_STORAGE_KEY, locale);
    try {
      const { container } = render(
        <I18nProvider>
          {CHAT_CLAIM_NOTICES.map((notice) => (
            <Line key={notice} notice={notice} />
          ))}
        </I18nProvider>,
      );
      expect(container.textContent).not.toMatch(/chat\.claimNotice/u);
      expect(await axe(container)).toHaveNoViolations();
    } finally {
      window.localStorage.removeItem(I18N_STORAGE_KEY);
    }
  });
});
