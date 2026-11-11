import { fireEvent, render, screen, within } from "@testing-library/react";
import { axe } from "jest-axe";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChatToolExchange, ChatToolTranscript } from "@oscharko-dev/keiko-contracts/bff-wire";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { I18N_STORAGE_KEY, I18nProvider, loadLocaleMessages } from "@/lib/i18n";
import { loadOptionalWidgetMessages } from "@/lib/optional-widget-i18n";
import { JiraChatTools } from "./JiraChatTools";
import { partialJiraReadPage } from "./jira-result.test-fixture";

function saved(cases: readonly (readonly [string, CatalogJsonObject])[]): ChatToolTranscript {
  const exchanges = cases.map(([name, data], index): ChatToolExchange => ({
    call: { id: `native-observation-${index}`, name, arguments: {} },
    result: {
      schemaVersion: 1,
      invocationId: `native-observation-${index}`,
      toolRef: null,
      projectionDigest: null,
      effectStarted: false,
      metrics: { inputBytes: 10, outputBytes: 10, resultCount: 1, durationMs: 20 },
      status: "completed",
      reason: "none",
      page: partialJiraReadPage(name),
      data: { outcome: "succeeded", ...data },
    },
  }));
  return JSON.parse(JSON.stringify({ schemaVersion: 1, exchanges })) as ChatToolTranscript;
}
function restore(transcript: ChatToolTranscript): ReturnType<typeof render> {
  const show = (): ReturnType<typeof render> =>
    render(
      <I18nProvider>
        <JiraChatTools transcript={transcript} turnState="completed" />
      </I18nProvider>,
    );
  const first = show();
  const previous = first.container.textContent;
  first.unmount();
  const restored = show();
  expect(restored.container.textContent).toBe(previous);
  for (const summary of restored.container.querySelectorAll("details > summary"))
    fireEvent.click(summary);
  return restored;
}
afterEach(() => localStorage.removeItem(I18N_STORAGE_KEY));
describe.each(["en", "de"] as const)(
  "saved native link and change observations in %s",
  (locale) => {
    beforeEach(async () => {
      await Promise.all([loadLocaleMessages(locale), loadOptionalWidgetMessages(locale)]);
      localStorage.setItem(I18N_STORAGE_KEY, locale);
    });
    it("restores typed remote-link values and associations without parsing text or creating navigation", async () => {
      const { container } = restore(
        saved([
          [
            "jira_remote_version_links",
            {
              selectedGlobalId: "https://requested.invalid/exact-id",
              startAt: 1,
              total: 4,
              nextStartAt: 2,
              items: [
                {
                  name: "Native record",
                  valueAvailable: true,
                  valueNodes: [
                    { path: "", kind: "object", childCount: 4 },
                    { path: "/a~0~1b", kind: "string", textValue: "value\u0000\\u0000" },
                    { path: "/", kind: "null" },
                    { path: "/empty", kind: "array", childCount: 0 },
                    {
                      path: "/text",
                      kind: "string",
                      textValue: '<img src="https://native.invalid/image">',
                    },
                  ],
                },
              ],
            },
          ],
          [
            "jira_version_remote_links",
            {
              versionId: "9",
              versionName: "Release Nine",
              items: [
                {
                  valueAvailable: false,
                  valueNodes: [{ path: "", kind: "string", textValue: "Excluded stale value" }],
                },
              ],
            },
          ],
          [
            "jira_version_remote_link",
            {
              versionId: "9",
              versionName: "Release Nine",
              selectedGlobalId: "exact-id",
              items: [
                {
                  valueAvailable: true,
                  valueNodes: [{ path: "", kind: "boolean", booleanValue: false }],
                },
              ],
            },
          ],
        ]),
      );
      const labels =
        locale === "en"
          ? {
              global: "Read Jira version links by global ID",
              version: "Read a Jira version's remote links",
              single: "Read a Jira version's selected remote link",
              selected: "Requested global ID: https://requested.invalid/exact-id",
              unknown: "The link value was not provided. This is not an empty value or JSON null.",
              partial: "Partial Jira result. Some available data is not included.",
            }
          : {
              global: "Jira-Versionslinks anhand globaler ID lesen",
              version: "Remote-Links einer Jira-Version lesen",
              single: "Ausgewählten Remote-Link einer Jira-Version lesen",
              selected: "Angeforderte globale ID: https://requested.invalid/exact-id",
              unknown:
                "Der Linkwert wurde nicht angegeben. Dies ist weder ein leerer Wert noch JSON-null.",
              partial: "Jira-Teilergebnis. Nicht alle verfügbaren Daten sind enthalten.",
            };
      const global = screen.getByRole("group", { name: labels.global });
      expect(within(global).getByText(labels.selected)).toBeVisible();
      expect(within(global).getByText(labels.partial)).toBeVisible();
      expect(within(global).getByText("value\\u0000\\\\u0000")).toBeVisible();
      expect(within(global).getByText('<img src="https://native.invalid/image">')).toBeVisible();
      expect(
        within(screen.getByRole("group", { name: labels.version })).getByText(labels.unknown),
      ).toBeVisible();
      expect(screen.getByRole("group", { name: labels.single })).toBeVisible();
      expect(container.textContent).not.toContain("Excluded stale value");
      expect(container.querySelector("pre, a, img, script")).toBeNull();
      expect(await axe(container)).toHaveNoViolations();
    });
    it("restores inclusive cursors and terminal windows without claiming all-history completeness", async () => {
      const { container } = restore(
        saved([
          [
            "jira_updated_worklogs",
            {
              feedScope: "native-visible-change-window",
              timeUnit: "unix-milliseconds",
              excludesLatestMinute: true,
              since: "0",
              until: "1700000000000",
              isLastPage: false,
              nextSince: "1700000000000",
              items: [
                { worklogId: "9223372036854775807", changedAt: "1700000000000" },
                { worklogId: "8", changedAt: "1700000000000" },
              ],
              nextPage: "https://untrusted.invalid/feed",
              total: 10000,
            },
          ],
          [
            "jira_deleted_worklogs",
            {
              feedScope: "native-visible-change-window",
              since: "0",
              until: "0",
              isLastPage: true,
              items: [],
            },
          ],
        ]),
      );
      const labels =
        locale === "en"
          ? {
              updated: "Read Jira worklog update observations",
              deleted: "Read Jira worklog deletion observations",
              cursor: "Cursor for the next native page: 1700000000000",
              minute: "Jira excludes changes from the latest minute from this feed.",
              empty:
                "Jira returned no changes in this native window. This is not evidence that no other changes exist.",
              terminal:
                "Jira marked this as the last page of this native window. This does not mean all history is complete.",
            }
          : {
              updated: "Beobachtete Jira-Arbeitsprotokoll-Änderungen lesen",
              deleted: "Beobachtete Jira-Arbeitsprotokoll-Löschungen lesen",
              cursor: "Cursor für die nächste native Seite: 1700000000000",
              minute: "Jira schließt Änderungen aus der letzten Minute aus diesem Feed aus.",
              empty:
                "Jira hat in diesem nativen Fenster keine Änderungen zurückgegeben. Das belegt nicht, dass keine weiteren Änderungen vorhanden sind.",
              terminal:
                "Jira hat diese Seite als letzte Seite dieses nativen Fensters markiert. Damit ist nicht die gesamte Historie vollständig.",
            };
      const updates = screen.getByRole("group", { name: labels.updated });
      expect(within(updates).getByText(labels.cursor)).toBeVisible();
      expect(within(updates).getByText(labels.minute)).toBeVisible();
      expect(updates.textContent).toContain("9223372036854775807");
      const deletions = screen.getByRole("group", { name: labels.deleted });
      expect(within(deletions).getByText(labels.empty)).toBeVisible();
      expect(within(deletions).getByText(labels.terminal)).toBeVisible();
      expect(container.textContent).not.toMatch(/untrusted\.invalid|10000/u);
      expect(container.querySelector("pre, a, img")).toBeNull();
      expect(
        screen.queryByRole("button", { name: /retry|repeat|apply|erneut|wiederholen|anwenden/iu }),
      ).toBeNull();
      expect(await axe(container)).toHaveNoViolations();
    });
  },
);
