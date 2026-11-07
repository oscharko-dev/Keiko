import { render, screen } from "@testing-library/react";
import { axe } from "jest-axe";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChatToolExchange, ChatToolTranscript } from "@oscharko-dev/keiko-contracts/bff-wire";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { I18N_STORAGE_KEY, I18nProvider, loadLocaleMessages } from "@/lib/i18n";
import { loadOptionalWidgetMessages } from "@/lib/optional-widget-i18n";
import { JiraChatTools } from "./JiraChatTools";
import { jiraToolOutcomeView } from "./jira-tool-outcome";

function exchange(name: string, data: CatalogJsonObject): ChatToolExchange {
  return {
    call: { id: name, name, arguments: {} },
    result: {
      schemaVersion: 1, invocationId: name, toolRef: null, projectionDigest: null, effectStarted: false,
      metrics: { inputBytes: 10, outputBytes: 10, resultCount: 1, durationMs: 20 },
      status: "completed", reason: "none", page: { truncated: false, reason: "none", cursor: null },
      data: { outcome: "succeeded", ...data },
    },
  };
}
const TYPE = { id: "10001", name: "Story", description: "Story metadata", subtask: false, avatarId: "71" };
const PRIORITY = { id: "3", name: "Normal", statusColor: "#123456" };
const RESOLUTION = { name: "Fixed", description: "Resolution metadata" };
const CATEGORY = { id: "4", key: "indeterminate", name: "In progress category", colorName: "yellow" };
const STATUS = { id: "5", name: "In progress", statusCategory: CATEGORY };
const PROJECT_CATEGORY = { id: "51", name: "Engineering" };
const PROJECT_TYPE = { key: "software", formattedKey: "Software", descriptionI18nKey: "project.type.software.description", color: "blue" };
function page(item: CatalogJsonObject): CatalogJsonObject {
  return { items: [item], startAt: 0, total: 1 };
}
const CASES: readonly [string, CatalogJsonObject, string, string][] = [
  ["jira_global_issue_types", page(TYPE), "Read global Jira issue types", "Globale Jira-Vorgangstypen lesen"],
  ["jira_issue_type", TYPE, "Read Jira issue type", "Jira-Vorgangstyp lesen"],
  ["jira_issue_type_page", page(TYPE), "Read a Jira issue type page", "Eine Seite mit Jira-Vorgangstypen lesen"],
  ["jira_issue_type_alternatives", { ...page(TYPE), issueTypeId: "10002" }, "Read Jira issue type alternatives", "Alternative Jira-Vorgangstypen lesen"],
  ["jira_priorities", page(PRIORITY), "Read Jira priorities", "Jira-Prioritäten lesen"],
  ["jira_priority", PRIORITY, "Read Jira priority", "Jira-Priorität lesen"],
  ["jira_priority_page", page(PRIORITY), "Read a Jira priority page", "Eine Seite mit Jira-Prioritäten lesen"],
  ["jira_resolutions", page(RESOLUTION), "Read Jira resolutions", "Jira-Lösungen lesen"],
  ["jira_resolution", { ...RESOLUTION, resolutionId: "41" }, "Read Jira resolution", "Jira-Lösung lesen"],
  ["jira_resolution_page", page(RESOLUTION), "Read a Jira resolution page", "Eine Seite mit Jira-Lösungen lesen"],
  ["jira_statuses", page(STATUS), "Read Jira statuses", "Jira-Status lesen"],
  ["jira_status", STATUS, "Read Jira status", "Jira-Statusdetails lesen"],
  ["jira_status_page", page(STATUS), "Read a Jira status page", "Eine Seite mit Jira-Status lesen"],
  ["jira_status_categories", page(CATEGORY), "Read Jira status categories", "Jira-Statuskategorien lesen"],
  ["jira_status_category", CATEGORY, "Read Jira status category", "Jira-Statuskategorie lesen"],
  ["jira_project_categories", page(PROJECT_CATEGORY), "Read Jira project categories", "Jira-Projektkategorien lesen"],
  ["jira_project_category", PROJECT_CATEGORY, "Read Jira project category", "Jira-Projektkategorie lesen"],
  ["jira_project_statuses", {
    ...page({ id: TYPE.id, name: TYPE.name, subtask: TYPE.subtask, statuses: [STATUS] }),
    projectId: "9223372036854775807", projectKey: "SYN",
  }, "Read Jira project statuses", "Status eines Jira-Projekts lesen"],
  ["jira_project_types", page(PROJECT_TYPE), "Read Jira project types", "Jira-Projekttypen lesen"],
  ["jira_project_type_definition", PROJECT_TYPE, "Read Jira project type definition", "Definition eines Jira-Projekttyps lesen"],
];

afterEach(() => localStorage.removeItem(I18N_STORAGE_KEY));
describe.each(["en", "de"] as const)("saved core Jira metadata in %s", (locale) => {
  beforeEach(async () => {
    await Promise.all([loadLocaleMessages(locale), loadOptionalWidgetMessages(locale)]);
    localStorage.setItem(I18N_STORAGE_KEY, locale);
  });
  it("restores all twenty named metadata cards without raw JSON or remote rendering", async () => {
    const restored = JSON.parse(JSON.stringify({ schemaVersion: 1,
      exchanges: CASES.map(([name, data]) => exchange(name, {
        ...data, self: "https://untrusted.invalid/self", iconUrl: "https://untrusted.invalid/image",
      })),
    })) as ChatToolTranscript;
    const show = (): ReturnType<typeof render> => render(
      <I18nProvider><JiraChatTools transcript={restored} turnState="completed" /></I18nProvider>,
    );
    const first = show();
    const previous = first.container.textContent;
    first.unmount();
    const { container } = show();
    expect(container.textContent).toBe(previous);
    for (const [, , en, de] of CASES)
      expect(screen.getByRole("group", { name: locale === "en" ? en : de })).toBeVisible();
    for (const value of ["Story metadata", "Normal", "Fixed", "In progress category", "Engineering", "SYN", "9223372036854775807", "project.type.software.description"])
      expect(container.textContent).toContain(value);
    expect(container.textContent).toContain(locale === "en"
      ? "The resolution ID was not supplied by Jira." : "Die Lösungs-ID wurde von Jira nicht geliefert.");
    expect(container.textContent).toContain(locale === "en"
      ? "Requested resolution ID: 41" : "Angeforderte Lösungs-ID: 41");
    expect(container.textContent).toContain(locale === "en"
      ? "Configured statuses for this issue type: 1" : "Konfigurierte Status dieses Vorgangstyps: 1");
    expect(container.textContent).not.toContain("untrusted.invalid");
    expect(container.querySelector("pre, img, a")).toBeNull();
    expect(await axe(container)).toHaveNoViolations();
  });
  it("retains native page uncertainty and explicit empty project status lists", () => {
    const partial = exchange("jira_status_page", { items: [STATUS], startAt: 0, nextStartAt: 1 });
    const view = jiraToolOutcomeView(partial);
    expect(view).toMatchObject({ returnedCount: 1, total: undefined, unreadableCount: 0 });
    const { container } = render(<I18nProvider><JiraChatTools
      transcript={{ schemaVersion: 1, exchanges: [partial, exchange("jira_project_statuses", {
        projectId: "10000", projectKey: "SYN", startAt: 0, total: 2,
        items: [{ id: "1", name: "Unknown statuses" }, { id: "2", name: "Empty statuses", subtask: true, statuses: [] }],
      })] }} turnState="completed"
    /></I18nProvider>);
    expect(container.textContent).toContain(locale === "en"
      ? "Partial Jira result. Some available data is not included."
      : "Jira-Teilergebnis. Nicht alle verfügbaren Daten sind enthalten.");
    expect(container.textContent).toContain(locale === "en"
      ? "Statuses for this issue type were not provided." : "Status dieses Vorgangstyps wurden nicht bereitgestellt.");
    expect(container.textContent).toContain(locale === "en"
      ? "Configured statuses for this issue type: 0" : "Konfigurierte Status dieses Vorgangstyps: 0");
    expect(container.textContent).toContain(locale === "en"
      ? "The issue type's subtask classification is unknown." : "Die Einordnung als Unteraufgabentyp ist unbekannt.");
  });
});
