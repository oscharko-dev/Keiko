import { describe, expect, it } from "vitest";
import { OPTIONAL_WIDGET_DE_MESSAGES } from "./i18n-messages.optional.de";
import { OPTIONAL_WIDGET_EN_MESSAGES } from "./i18n-messages.optional.en";

describe("Jira Pod terminology (#4353)", () => {
  it("spells the German Pod name one way: Jira Pod, never Jira-Pod", () => {
    const hyphenated = Object.entries(OPTIONAL_WIDGET_DE_MESSAGES).filter(([, text]) =>
      /Jira-Pod/u.test(text),
    );
    expect(hyphenated).toEqual([]);
  });
  it("gives every closed auth-unverified message in both languages and none of them names a host or identity", () => {
    for (const catalog of [OPTIONAL_WIDGET_EN_MESSAGES, OPTIONAL_WIDGET_DE_MESSAGES]) {
      for (const key of [
        "chat.jira.outcome.failure.authUnverified",
        "atlassianConnectors.result.reason.auth-unverified",
      ] as const) {
        const text = catalog[key];
        expect(text.length).toBeGreaterThan(20);
        expect(text).not.toMatch(/https?:|@|\{/u);
      }
    }
  });
});
