import { render, screen } from "@testing-library/react";
import { axe } from "jest-axe";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChatToolExchange, ChatToolTranscript } from "@oscharko-dev/keiko-contracts/bff-wire";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { I18N_STORAGE_KEY, I18nProvider, loadLocaleMessages } from "@/lib/i18n";
import { loadOptionalWidgetMessages } from "@/lib/optional-widget-i18n";
import { JiraChatTools } from "./JiraChatTools";
import { partialJiraReadPage } from "./jira-result.test-fixture";
import { jiraAccountDiagnosticDetails } from "./jira-account-diagnostic-presentation";

const OBSERVATIONS: readonly [string, CatalogJsonObject][] = [
  [
    "jira_password_policy",
    {
      policyScope: "requirements-only",
      hasOldPassword: false,
      items: [{ requirement: "Use at least eight characters <native text>." }],
      startAt: 0,
      total: 1,
    },
  ],
  ["jira_duplicate_user_count", { count: 0, observationScope: "cached-duplicate-accounts" }],
  [
    "jira_duplicate_users",
    {
      observationScope: "cached-duplicate-accounts",
      items: [
        {
          username: "sample",
          directories: [
            {
              directoryId: "9223372036854775807",
              directoryName: "Local directory",
              userActive: false,
            },
            { directoryId: "2" },
          ],
        },
      ],
      startAt: 0,
      total: 1,
    },
  ],
  [
    "jira_search_error",
    {
      scope: "current-user-http-context",
      errorPresent: true,
      message: "Search unavailable; see https://jira.example.invalid/help",
    },
  ],
  ["jira_search_error", { scope: "current-user-http-context", errorPresent: false }],
];
afterEach(() => localStorage.removeItem(I18N_STORAGE_KEY));
describe.each(["en", "de"] as const)("persisted Jira account observations in %s", (locale) => {
  beforeEach(async () => {
    await Promise.all([loadLocaleMessages(locale), loadOptionalWidgetMessages(locale)]);
    localStorage.setItem(I18N_STORAGE_KEY, locale);
  });
  it("restores readable scoped facts without raw JSON, browser links or password claims", async () => {
    const exchanges = OBSERVATIONS.map(([name, data], index): ChatToolExchange => ({
      call: { id: String(index), name, arguments: {} },
      result: {
        schemaVersion: 1,
        invocationId: String(index),
        toolRef: null,
        projectionDigest: null,
        effectStarted: false,
        metrics: { inputBytes: 0, outputBytes: 0, resultCount: 1, durationMs: 1 },
        status: "completed",
        reason: "none",
        page: partialJiraReadPage(name),
        data: { outcome: "succeeded", ...data },
      },
    }));
    const restored = JSON.parse(
      JSON.stringify({ schemaVersion: 1, exchanges }),
    ) as ChatToolTranscript;
    const show = (): ReturnType<typeof render> =>
      render(
        <I18nProvider>
          <JiraChatTools transcript={restored} turnState="completed" />
        </I18nProvider>,
      );
    const first = show();
    const content = first.container.textContent;
    first.unmount();
    const { container } = show();
    expect(container.textContent).toBe(content);
    const labels =
      locale === "en"
        ? [
            "Read Jira password requirements",
            "Read Jira's cached duplicate-account count",
            "Read Jira's cached duplicate accounts",
          ]
        : [
            "Jira-Passwortanforderungen lesen",
            "Zwischengespeicherte Anzahl doppelter Jira-Konten lesen",
            "Zwischengespeicherte doppelte Jira-Konten lesen",
          ];
    for (const name of labels) expect(screen.getByRole("group", { name })).toBeVisible();
    const facts =
      locale === "en"
        ? [
            "Cached duplicate-account count: 0",
            "Reported account activity: inactive",
            "Reported account activity: unknown",
            "Jira reports no stored search error in this context.",
            "No password was supplied or tested",
          ]
        : [
            "Zwischengespeicherte Anzahl doppelter Konten: 0",
            "Gemeldete Kontoaktivität: inaktiv",
            "Gemeldete Kontoaktivität: unbekannt",
            "Jira meldet keinen gespeicherten Suchfehler in diesem Kontext.",
            "Es wurde kein Passwort übergeben oder geprüft",
          ];
    for (const value of [
      ...facts,
      "9223372036854775807",
      "sample",
      "Local directory",
      "<native text>",
      "https://jira.example.invalid/help",
    ])
      expect(container.textContent).toContain(value);
    expect(container.querySelector("pre, a, native, img")).toBeNull();
    expect(container.textContent).not.toContain('"observationScope"');
    expect(await axe(container)).toHaveNoViolations();
  });
});

it("keeps missing counts and errors unknown and never renders refused facts", () => {
  const unknownCount = jiraAccountDiagnosticDetails("jira_duplicate_user_count", {
    outcome: "succeeded",
  });
  expect(unknownCount[0]?.facts).toEqual([]);
  expect(unknownCount[0]?.labels).toContain("chat.jira.accounts.countUnknown");
  const unknownError = jiraAccountDiagnosticDetails("jira_search_error", {
    outcome: "succeeded",
    errorPresent: true,
  });
  expect(unknownError[0]?.labels).toContain("chat.jira.accounts.searchErrorUnknown");
  expect(unknownError[0]?.body).toBeUndefined();
  expect(
    jiraAccountDiagnosticDetails("jira_duplicate_user_count", { outcome: "failed", count: 0 }),
  ).toEqual([]);
  expect(jiraAccountDiagnosticDetails("jira_reset_password", { outcome: "succeeded" })).toEqual([]);
});
