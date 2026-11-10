import { render, screen } from "@testing-library/react";
import { axe } from "jest-axe";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChatToolExchange, ChatToolTranscript } from "@oscharko-dev/keiko-contracts/bff-wire";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { I18N_STORAGE_KEY, I18nProvider, loadLocaleMessages } from "@/lib/i18n";
import { loadOptionalWidgetMessages } from "@/lib/optional-widget-i18n";
import { JiraChatTools } from "./JiraChatTools";
import { partialJiraReadPage } from "./jira-result.test-fixture";
import { jiraAdministrativeObservationDetails as details } from "./jira-administrative-observation-presentation";

const RESULTS: readonly [string, CatalogJsonObject][] = [
  [
    "jira_permission_scheme_attribute",
    { schemeId: "37", attributeKey: "review ~state", valueState: "observed", textValue: "" },
  ],
  [
    "jira_permission_scheme_attribute",
    { schemeId: "37", attributeKey: "unavailable", valueState: "unknown" },
  ],
  [
    "jira_email_template_types",
    {
      items: [
        {
          id: "1",
          eventName: "Issue created",
          templateName: "/server/templates/issuecreated.vm",
          active: false,
          html: true,
          text: false,
        },
        { id: "1", templateName: "issuecreated-text.vm", text: true },
      ],
      startAt: 0,
      total: 2,
      templateScope: "notification-type-metadata",
    },
  ],
];
afterEach(() => localStorage.removeItem(I18N_STORAGE_KEY));
describe.each(["en", "de"] as const)(
  "persistent native configuration observations in %s",
  (locale) => {
    beforeEach(async () => {
      await Promise.all([loadLocaleMessages(locale), loadOptionalWidgetMessages(locale)]);
      localStorage.setItem(I18N_STORAGE_KEY, locale);
    });
    it("restores accessible readable configuration and format facts without file links or JSON", async () => {
      const exchanges = RESULTS.map(([name, data], index): ChatToolExchange => ({
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
      const transcript = JSON.parse(
        JSON.stringify({ schemaVersion: 1, exchanges }),
      ) as ChatToolTranscript;
      const show = (): ReturnType<typeof render> =>
        render(
          <I18nProvider>
            <JiraChatTools transcript={transcript} turnState="completed" />
          </I18nProvider>,
        );
      const first = show();
      const content = first.container.textContent;
      first.unmount();
      const { container } = show();
      expect(container.textContent).toBe(content);
      const name =
        locale === "en"
          ? "Read Jira email notification types"
          : "Jira-E-Mail-Benachrichtigungstypen lesen";
      expect(screen.getByRole("group", { name })).toBeVisible();
      const expected =
        locale === "en"
          ? [
              "Jira returned an empty attribute value.",
              "The attribute value was not provided.",
              "Returned notification-type entries: 2",
              "Reported notification type: inactive",
              "Batched notification: unknown",
            ]
          : [
              "Jira hat einen leeren Attributwert zurückgegeben.",
              "Der Attributwert wurde nicht angegeben.",
              "Zurückgegebene Benachrichtigungstyp-Einträge: 2",
              "Gemeldeter Benachrichtigungstyp: inaktiv",
              "Gebündelte Benachrichtigung: unbekannt",
            ];
      for (const value of [
        ...expected,
        "review ~state",
        "/server/templates/issuecreated.vm",
        "issuecreated-text.vm",
      ])
        expect(container.textContent).toContain(value);
      expect(container.querySelector("a, pre, img")).toBeNull();
      expect(container.textContent).not.toContain('"templateScope"');
      expect(await axe(container)).toHaveNoViolations();
    });
  },
);
it("does not infer a zero count or permission grant from missing or refused metadata", () => {
  const absent = details("jira_email_template_types", { outcome: "succeeded" });
  expect(absent[0]?.facts).toEqual([]);
  expect(absent[0]?.labels).toContain("chat.jira.adminObservation.countUnknown");
  expect(
    details("jira_permission_scheme_attribute", {
      outcome: "succeeded",
      valueState: "unknown",
      textValue: "invented default",
    })[0]?.facts,
  ).not.toContainEqual({
    label: "chat.jira.adminObservation.attributeValue",
    value: "invented default",
  });
  expect(details("jira_email_template_types", { outcome: "failed", total: 0, items: [] })).toEqual(
    [],
  );
  expect(details("jira_send_email", { outcome: "succeeded" })).toEqual([]);
});
