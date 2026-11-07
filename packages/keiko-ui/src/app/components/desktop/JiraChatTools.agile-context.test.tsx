import { render, screen } from "@testing-library/react";
import { axe } from "jest-axe";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChatToolExchange, ChatToolTranscript } from "@oscharko-dev/keiko-contracts/bff-wire";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { I18N_STORAGE_KEY, I18nProvider, loadLocaleMessages } from "@/lib/i18n";
import { loadOptionalWidgetMessages } from "@/lib/optional-widget-i18n";
import { JiraChatTools } from "./JiraChatTools";

const ISSUE = { id: "10001", key: "SYN-1", summary: "Observed issue", status: { name: "Open" },
  browseUrl: "https://jira.example.invalid/context/browse/SYN-1" };
const CASES: readonly [string, CatalogJsonObject][] = [
  ["jira_board_epicless_issues", { boardId: "7", collectionScope: "visible-board-issues", items: [ISSUE], startAt: 0, total: 1 }],
  ["jira_board_epic_issues", { boardId: "7", epicId: "11", collectionScope: "visible-board-issues", items: [ISSUE], startAt: 0, total: 1 }],
  ["jira_board_sprint_issues", { boardId: "7", sprintId: "9", collectionScope: "visible-board-issues", items: [ISSUE], startAt: 0, total: 1 }],
  ["jira_epicless_issues", { collectionScope: "visible-epicless-issues", items: [ISSUE], startAt: 0, total: 1 }],
  ["jira_agile_issue", { items: [{ ...ISSUE, description: "Saved issue detail" }], startAt: 0, total: 1 }],
  ["jira_board_projects", { boardId: "7", collectionScope: "visible-board-projects", items: [], startAt: 0, total: 0 }],
  ["jira_board_versions", { boardId: "7", collectionScope: "visible-board-versions", items: [{
    versionId: "81", name: "Planned release", released: false, releaseDate: "2026-11-07", self: "https://untrusted.invalid/version/81",
  }], startAt: 0, total: 1 }],
  ["jira_board_refined_velocity", { boardId: "7", value: false }],
  ["jira_issue_estimation", { boardId: "7", issueId: "10001", issueKey: "SYN-1", fieldId: "customfield_10001", value: 0 }],
];
afterEach(() => localStorage.removeItem(I18N_STORAGE_KEY));
describe.each(["en", "de"] as const)("saved Agile context reads in %s", (locale) => {
  beforeEach(async () => {
    await Promise.all([loadLocaleMessages(locale), loadOptionalWidgetMessages(locale)]);
    localStorage.setItem(I18N_STORAGE_KEY, locale);
  });
  it("restores all nine named results with visible scope, retained issue links and unknown estimate units", async () => {
    const exchanges = CASES.map(([name, data]): ChatToolExchange => ({
      call: { id: name, name, arguments: {} }, result: {
        schemaVersion: 1, invocationId: name, toolRef: null, projectionDigest: null, effectStarted: false,
        metrics: { inputBytes: 10, outputBytes: 10, resultCount: 1, durationMs: 20 },
        status: "completed", reason: "none", page: { truncated: false, reason: "none", cursor: null },
        data: { outcome: "succeeded", ...data },
      },
    }));
    const restored = JSON.parse(JSON.stringify({ schemaVersion: 1, exchanges })) as ChatToolTranscript;
    const show = (): ReturnType<typeof render> => render(
      <I18nProvider><JiraChatTools transcript={restored} turnState="completed" /></I18nProvider>,
    );
    const first = show();
    const previous = first.container.textContent;
    first.unmount();
    const { container } = show();
    expect(container.textContent).toBe(previous);
    expect(screen.getByRole("group", { name: locale === "en" ? "Read visible board projects" : "Sichtbare Board-Projekte lesen" })).toBeVisible();
    expect(screen.getByRole("group", { name: locale === "en" ? "Read an issue estimate in board context" : "Vorgangsschätzung im Board-Kontext lesen" })).toBeVisible();
    expect(screen.getAllByRole("link", { name: /SYN-1/u })).toHaveLength(5);
    for (const link of screen.getAllByRole("link"))
      expect(link).toHaveAttribute("href", "https://jira.example.invalid/context/browse/SYN-1");
    const expected = locale === "en" ? [
      "Visible projects returned for this board", "An empty result does not prove that no other resources exist.",
      "Observed estimate value: 0", "The estimate unit is unknown.", "Refined velocity setting: disabled",
      "Archive state unavailable", "Planned release", "Saved issue detail",
    ] : [
      "Für dieses Board gelieferte sichtbare Projekte", "Ein leeres Ergebnis belegt nicht, dass keine weiteren Ressourcen existieren.",
      "Beobachteter Schätzwert: 0", "Die Schätzeinheit ist unbekannt.", "Verfeinerte Velocity: deaktiviert",
      "Archivierungsstatus nicht verfügbar", "Planned release", "Saved issue detail",
    ];
    for (const value of expected) expect(container.textContent).toContain(value);
    expect(container.textContent).not.toContain("untrusted.invalid");
    expect(container.querySelector("pre, img")).toBeNull();
    expect(await axe(container)).toHaveNoViolations();
  });
});
