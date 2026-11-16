import { buttonsOutsideProgress, partialJiraReadPage } from "./jira-result.test-fixture";
import { render, screen, within } from "@testing-library/react";
import { axe } from "jest-axe";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChatToolExchange, ChatToolTranscript } from "@oscharko-dev/keiko-contracts/bff-wire";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { I18N_STORAGE_KEY, I18nProvider, loadLocaleMessages } from "@/lib/i18n";
import { loadOptionalWidgetMessages } from "@/lib/optional-widget-i18n";
import { JiraChatTools } from "./JiraChatTools";

const CASES: readonly [string, CatalogJsonObject, ChatToolExchange["mutationOutcome"]?][] = [
  [
    "jira_create_filter",
    {
      outcome: "succeeded",
      filterId: "9001",
      userKey: "owner-key",
      defaultSharingAtomic: false,
      observedShareScope: "PRIVATE",
      browseUrl: "https://jira.example.invalid/context/issues/?filter=9001",
    },
  ],
  ["jira_update_filter", { outcome: "succeeded", filterId: "9001", userKey: "owner-key" }],
  [
    "jira_delete_filter",
    {
      outcome: "succeeded-unconfirmed",
      reason: "unavailable",
      filterId: "9001",
      userKey: "owner-key",
    },
  ],
  [
    "jira_set_filter_share_scope",
    {
      outcome: "succeeded",
      userKey: "owner-key",
      username: "bound-user",
      observedShareScope: "AUTHENTICATED",
    },
  ],
  [
    "jira_set_filter_columns",
    {
      outcome: "rejected",
      reason: "conflict",
      unchanged: true,
      filterId: "9001",
      userKey: "owner-key",
    },
  ],
  [
    "jira_reset_filter_columns",
    {
      outcome: "succeeded-unconfirmed",
      reason: "unavailable",
      filterId: "9001",
      userKey: "owner-key",
    },
  ],
  [
    "jira_add_filter_permission",
    { outcome: "succeeded", filterId: "9001", permissionId: "9002", userKey: "owner-key" },
  ],
  [
    "jira_delete_filter_permission",
    { outcome: "succeeded", filterId: "9001", permissionId: "9002", userKey: "owner-key" },
  ],
  [
    "jira_set_my_preference",
    {
      outcome: "succeeded",
      userKey: "owner-key",
      username: "bound-user",
      preferenceKey: "jira.user.locale",
      preferencePresent: true,
    },
    "unknown",
  ],
  [
    "jira_delete_my_preference",
    {
      outcome: "succeeded-unconfirmed",
      reason: "unavailable",
      userKey: "owner-key",
      username: "bound-user",
      preferenceKey: "jira.user.locale",
      preferencePresent: false,
    },
  ],
  [
    "jira_create_filter",
    {
      outcome: "succeeded",
      userKey: "owner-key",
      defaultSharingAtomic: false,
      observedShareScope: "PRIVATE",
    },
  ],
  [
    "jira_filter",
    {
      outcome: "succeeded",
      items: [
        {
          id: "9001",
          name: "Empty description",
          jql: "project = SYN",
          description: "",
          owner: { key: "owner-key", name: "bound-user" },
        },
      ],
    },
  ],
  [
    "jira_filter",
    {
      outcome: "succeeded",
      items: [{ id: "9003", name: "Missing description", jql: "project = SYN", description: null }],
    },
  ],
];
afterEach(() => localStorage.removeItem(I18N_STORAGE_KEY));
describe.each(["en", "de"] as const)("saved filter and preference changes in %s", (locale) => {
  beforeEach(async () => {
    await Promise.all([loadLocaleMessages(locale), loadOptionalWidgetMessages(locale)]);
    localStorage.setItem(I18N_STORAGE_KEY, locale);
  });
  it("restores confirmed, unchanged and uncertain receipts with their real context", async () => {
    const exchanges = CASES.map(([name, data, mutationOutcome], index): ChatToolExchange => ({
      call: { id: `configuration-${index}`, name, arguments: {} },
      ...(mutationOutcome === undefined ? {} : { mutationOutcome }),
      result: {
        schemaVersion: 1,
        invocationId: `configuration-${index}`,
        toolRef: null,
        projectionDigest: null,
        effectStarted: name !== "jira_filter" && data.outcome !== "rejected",
        metrics: { inputBytes: 10, outputBytes: 10, resultCount: 1, durationMs: 20 },
        status: "completed",
        reason: "none",
        page: partialJiraReadPage(name),
        data: {
          browseUrl: "https://untrusted.invalid/filter",
          ...data,
          extraContent: "Excluded unrelated content",
        },
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
    const savedText = first.container.textContent;
    first.unmount();
    const { container } = show();
    expect(container.textContent).toBe(savedText);
    const labels =
      locale === "en"
        ? {
            create: "Create Jira filter",
            preference: "Set a preference of the connected Jira user",
            remove: "Delete Jira filter",
            removePreference: "Delete a preference of the connected Jira user",
            confirmed: "The requested change was independently confirmed for this identity.",
            unknown: "Jira outcome unknown",
            unchanged: "Already up to date",
            unconfirmed: "Jira accepted the change; confirmation incomplete",
            noIdentity:
              "The complete identity or confirmation context is unavailable. This card does not establish a successful change.",
            targetAbsent: "Requested preference state: absent",
            empty: "The observed filter description is empty text.",
            absent: "The native filter description was not provided (null).",
          }
        : {
            create: "Jira-Filter erstellen",
            preference: "Einstellung des verbundenen Jira-Kontos festlegen",
            remove: "Jira-Filter löschen",
            removePreference: "Einstellung des verbundenen Jira-Kontos löschen",
            confirmed: "Die angeforderte Änderung wurde für diese Identität unabhängig bestätigt.",
            unknown: "Ausgang der Jira-Aktion unbekannt",
            unchanged: "Bereits aktuell",
            unconfirmed: "Jira hat die Änderung angenommen; Bestätigung unvollständig",
            noIdentity:
              "Die vollständige Identität oder der Bestätigungskontext fehlt. Diese Karte belegt keine erfolgreiche Änderung.",
            targetAbsent: "Angeforderter Einstellungszustand: nicht vorhanden",
            empty: "Die beobachtete Filterbeschreibung ist leerer Text.",
            absent: "Die native Filterbeschreibung wurde nicht angegeben (null).",
          };
    expect(screen.getAllByText(labels.confirmed, { exact: true })).toHaveLength(5);
    const invalid = screen
      .getAllByRole("group", { name: labels.create })
      .find((group) => within(group).queryByText(labels.noIdentity) !== null);
    if (invalid === undefined) throw new TypeError("Missing incomplete creation receipt");
    expect(within(invalid).getByText(labels.unknown)).toBeVisible();
    expect(within(invalid).queryByText(labels.confirmed)).toBeNull();
    const preference = screen.getByRole("group", { name: labels.preference });
    expect(within(preference).getByText(labels.unknown)).toBeVisible();
    expect(within(preference).queryByText(labels.confirmed)).toBeNull();
    for (const name of [labels.remove, labels.removePreference]) {
      const deletion = screen.getByRole("group", { name });
      expect(within(deletion).getByText(labels.unconfirmed)).toBeVisible();
      expect(within(deletion).queryByText(labels.confirmed)).toBeNull();
    }
    for (const value of [labels.targetAbsent, labels.unchanged, labels.empty, labels.absent])
      expect(screen.getByText(value)).toBeVisible();
    for (const identity of ["9001", "9002", "owner-key", "bound-user", "jira.user.locale"])
      expect(container.textContent).toContain(identity);
    expect(container.textContent).not.toMatch(/untrusted\.invalid|Excluded unrelated content/u);
    const link = screen.getByRole("link", {
      name: locale === "en" ? /Open Jira filter/u : /Jira-Filter öffnen/u,
    });
    expect(link).toHaveAttribute(
      "href",
      "https://jira.example.invalid/context/issues/?filter=9001",
    );
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(container.querySelectorAll("a")).toHaveLength(1);
    expect(container.querySelector("pre, img")).toBeNull();
    expect(buttonsOutsideProgress(container)).toEqual([]);
    expect(await axe(container)).toHaveNoViolations();
  });
});
