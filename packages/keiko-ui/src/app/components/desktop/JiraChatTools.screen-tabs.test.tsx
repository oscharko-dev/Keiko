import { render, screen, within } from "@testing-library/react";
import { axe } from "jest-axe";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChatToolExchange, ChatToolTranscript } from "@oscharko-dev/keiko-contracts/bff-wire";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { I18N_STORAGE_KEY, I18nProvider, loadLocaleMessages } from "@/lib/i18n";
import { loadOptionalWidgetMessages } from "@/lib/optional-widget-i18n";
import { JiraChatTools } from "./JiraChatTools";

const CASES: readonly [string, CatalogJsonObject][] = [
  ["jira_create_screen_tab", { outcome: "succeeded", screenId: "71", tabId: "83" }],
  ["jira_rename_screen_tab", { outcome: "succeeded", screenId: "71", tabId: "81" }],
  ["jira_delete_screen_tab", { outcome: "succeeded", screenId: "71", tabId: "81" }],
  ["jira_create_screen_tab", { outcome: "unknown", reason: "timeout", screenId: "71", name: "Unconfirmed guessed tab" }],
  ["jira_rename_screen_tab", { outcome: "succeeded-unconfirmed", reason: "permission-denied", screenId: "71", tabId: "81" }],
  ["jira_delete_screen_tab", { outcome: "rejected", reason: "permission-denied", screenId: "71", tabId: "81" }],
  ["jira_rename_screen_tab", { outcome: "rejected", reason: "conflict", unchanged: true, screenId: "71", tabId: "81" }],
];
afterEach(() => localStorage.removeItem(I18N_STORAGE_KEY));
describe.each(["en", "de"] as const)("persistent Jira screen tab outcomes in %s", (locale) => {
  beforeEach(async () => {
    await Promise.all([loadLocaleMessages(locale), loadOptionalWidgetMessages(locale)]);
    localStorage.setItem(I18N_STORAGE_KEY, locale);
  });
  it("restores confirmed, unknown, unconfirmed, rejected and unchanged outcomes without inventing tab identities", async () => {
    const exchanges = CASES.map(([name, data], index): ChatToolExchange => ({ call: { id: `tab-${index}`, name, arguments: {} }, result: {
      schemaVersion: 1, invocationId: `tab-${index}`, toolRef: null, projectionDigest: null,
      effectStarted: data.outcome !== "rejected",
      metrics: { inputBytes: 10, outputBytes: 10, resultCount: 1, durationMs: 20 },
      status: "completed", reason: "none", page: { truncated: false, reason: "none", cursor: null },
      data: { ...data, browseUrl: "https://untrusted.invalid/screen" },
    } }));
    const restored = JSON.parse(JSON.stringify({ schemaVersion: 1, exchanges })) as ChatToolTranscript;
    const show = (): ReturnType<typeof render> => render(<I18nProvider><JiraChatTools transcript={restored} turnState="completed" /></I18nProvider>);
    const first = show();
    const previous = first.container.textContent;
    first.unmount();
    const { container } = show();
    expect(container.textContent).toBe(previous);
    const labels = locale === "en" ? {
      create: "Create Jira screen tab", rename: "Rename Jira screen tab", remove: "Delete Jira screen tab",
      unknown: "Jira outcome unknown", unconfirmed: "Jira accepted the change; confirmation incomplete",
      rejected: "Jira action rejected", unchanged: "Already up to date",
      created: "The new tab was confirmed on the selected screen.",
      renamed: "The tab's new name was confirmed on the selected screen.",
      deleted: "The tab's absence was confirmed on the selected screen; another tab remains.",
      noTab: "No tab identity was confirmed. The screen ID alone does not confirm a created tab.",
    } : {
      create: "Jira-Masken-Tab erstellen", rename: "Jira-Masken-Tab umbenennen", remove: "Jira-Masken-Tab löschen",
      unknown: "Ausgang der Jira-Aktion unbekannt", unconfirmed: "Jira hat die Änderung angenommen; Bestätigung unvollständig",
      rejected: "Jira-Aktion abgelehnt", unchanged: "Bereits aktuell",
      created: "Der neue Tab wurde auf der ausgewählten Maske bestätigt.",
      renamed: "Der neue Name des Tabs wurde auf der ausgewählten Maske bestätigt.",
      deleted: "Das Fehlen des Tabs wurde auf der ausgewählten Maske bestätigt; ein weiterer Tab bleibt bestehen.",
      noTab: "Es wurde keine Tab-Identität bestätigt. Die Masken-ID allein bestätigt keinen erstellten Tab.",
    };
    for (const value of [labels.created, labels.renamed, labels.deleted, labels.unknown, labels.unconfirmed, labels.rejected, labels.unchanged])
      expect(screen.getByText(value, { exact: true })).toBeVisible();
    expect(screen.getAllByRole("group", { name: labels.create })).toHaveLength(2);
    expect(screen.getAllByRole("group", { name: labels.rename })).toHaveLength(3);
    expect(screen.getAllByRole("group", { name: labels.remove })).toHaveLength(2);
    const unknown = screen.getAllByRole("group", { name: labels.create }).find((group) => within(group).queryByText(labels.unknown) !== null);
    if (unknown === undefined) throw new TypeError("Missing unconfirmed tab result");
    expect(within(unknown).getByText(labels.noTab)).toBeVisible();
    expect(unknown.textContent).toContain(locale === "en" ? "Screen ID: 71" : "Masken-ID: 71");
    expect(unknown.textContent).not.toContain(locale === "en" ? "Screen tab ID" : "Masken-Tab-ID");
    expect(unknown.textContent).not.toContain(labels.created);
    expect(container.textContent).not.toContain("Unconfirmed guessed tab");
    expect(container.textContent).not.toContain("untrusted.invalid");
    expect(container.querySelector("pre, a, img")).toBeNull();
    expect(await axe(container)).toHaveNoViolations();
  });
});
