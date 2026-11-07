import { fireEvent, render, screen, within } from "@testing-library/react";
import { axe } from "jest-axe";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChatToolExchange, ChatToolTranscript } from "@oscharko-dev/keiko-contracts/bff-wire";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { I18N_STORAGE_KEY, I18nProvider, loadLocaleMessages } from "@/lib/i18n";
import { loadOptionalWidgetMessages } from "@/lib/optional-widget-i18n";
import { JiraChatTools } from "./JiraChatTools";

function saved(cases: readonly (readonly [string, CatalogJsonObject])[]): ChatToolTranscript {
  const exchanges = cases.map(([name, data], index): ChatToolExchange => ({
    call: { id: `identity-observation-${index}`, name, arguments: {} },
    result: {
      schemaVersion: 1, invocationId: `identity-observation-${index}`, toolRef: null,
      projectionDigest: null, effectStarted: false,
      metrics: { inputBytes: 10, outputBytes: 10, resultCount: 1, durationMs: 20 },
      status: "completed", reason: "none", page: { truncated: false, reason: "none", cursor: null },
      data: { outcome: "succeeded", ...data },
    },
  }));
  return JSON.parse(JSON.stringify({ schemaVersion: 1, exchanges })) as ChatToolTranscript;
}
function restore(transcript: ChatToolTranscript): ReturnType<typeof render> {
  const show = (): ReturnType<typeof render> => render(
    <I18nProvider><JiraChatTools transcript={transcript} turnState="completed" /></I18nProvider>,
  );
  const first = show();
  const previous = first.container.textContent;
  first.unmount();
  const restored = show();
  expect(restored.container.textContent).toBe(previous);
  for (const summary of restored.container.querySelectorAll("details > summary")) fireEvent.click(summary);
  return restored;
}

afterEach(() => localStorage.removeItem(I18N_STORAGE_KEY));
describe.each(["en", "de"] as const)("persisted Jira identity observations and selected reads in %s", (locale) => {
  beforeEach(async () => {
    await Promise.all([loadLocaleMessages(locale), loadOptionalWidgetMessages(locale)]);
    localStorage.setItem(I18N_STORAGE_KEY, locale);
  });

  it("restores all four observation kinds without turning validation or native COMPLETED into an effect", async () => {
    const { container } = restore(saved([
      ["jira_anonymization_validation", { observationScope: "validation", userKey: "user-key-1", validation: {
        userName: "", displayName: "Native display", success: false, deleted: false,
        businessLogicValidationFailed: true, operations: [], errors: [
          { operation: "plugin:handler", messages: ["Native validation failed."], fields: [{ field: "owner", message: "Review the owner." }] },
        ], warnings: [],
      } }],
      ["jira_anonymization_rerun_validation", { observationScope: "rerun-validation", userKey: "user-key-2", validation: {
        operations: ["plugin:rerun"], warnings: [{ operation: "plugin:rerun", messages: ["Native warning <script>." ] }],
      } }],
      ["jira_anonymization_progress", { observationScope: "anonymization-progress", taskSelection: "selected-task", selectedTaskId: "9007199254740993",
        progress: { userKey: "user-key-1", status: "COMPLETED", currentProgress: 0, currentSubTask: "", isRerun: false,
          errors: [{ operation: "plugin:handler", messages: ["Native completion still has errors."] }], warnings: [] } }],
      ["jira_current_session", { observationScope: "bound-current-user-session", userKey: "bound-key", username: "Bound user",
        loginInfo: { failedLoginCount: 0, previousLoginTime: "Native login time" },
        session: { value: "excluded-session-value" }, self: "https://untrusted.invalid/session" }],
    ]));
    const names = locale === "en" ? [
      "Read Jira anonymization validation", "Read Jira anonymization rerun validation", "Read Jira anonymization progress", "Read the current Jira session",
    ] : [
      "Jira-Anonymisierungsvalidierung lesen", "Validierung einer Jira-Anonymisierungswiederholung lesen", "Jira-Anonymisierungsfortschritt lesen", "Aktuelle Jira-Sitzung lesen",
    ];
    for (const name of names) expect(screen.getByRole("group", { name })).toBeVisible();
    const expected = locale === "en" ? [
      "Native validation success flag: false. Review the reported errors and warnings.",
      "The native validation success flag was not provided.",
      "Native account-deleted flag: false", "Native operation names returned: 0",
      "The native user name is empty or whitespace-only.",
      "Only rerun eligibility was inspected. No existing job was resumed or repeated.",
      "Native progress value: 0", "The native progress unit was not established. The value is not shown as a percentage.",
      "COMPLETED alone does not prove an error-free anonymization; native errors and warnings remain relevant.",
      "The task ID is the requested selector. The native response contains no independent task ID to verify it.",
      "Observed failed login count: 0", "The login count was not provided.",
    ] : [
      "Natives Validierungserfolgsflag: falsch. Die gemeldeten Fehler und Warnungen prüfen.",
      "Das native Validierungserfolgsflag wurde nicht angegeben.",
      "Natives Konto-gelöscht-Flag: falsch", "Zurückgegebene native Operationsnamen: 0",
      "Der native Benutzername ist leer oder besteht nur aus Leerraum.",
      "Es wurde nur die Wiederholbarkeit geprüft. Kein vorhandener Auftrag wurde fortgesetzt oder wiederholt.",
      "Nativer Fortschrittswert: 0", "Die native Fortschrittseinheit wurde nicht bestimmt. Der Wert wird nicht als Prozentzahl dargestellt.",
      "COMPLETED allein belegt keine fehlerfreie Anonymisierung; native Fehler und Warnungen bleiben relevant.",
      "Die Aufgaben-ID ist der angeforderte Selektor. Die native Antwort enthält keine unabhängige Aufgaben-ID zur Gegenprüfung.",
      "Beobachtete fehlgeschlagene Anmeldungen: 0", "Die Anzahl der Anmeldungen wurde nicht angegeben.",
    ];
    for (const value of [...expected, "Native validation failed.", "Review the owner.", "Native warning <script>.",
      "Native completion still has errors.", "9007199254740993", "Bound user", "Native login time"])
      expect(container.textContent).toContain(value);
    expect(container.textContent).not.toMatch(/excluded-session-value|untrusted\.invalid|0%/u);
    expect(container.querySelector("pre, a, img, script")).toBeNull();
    expect(screen.queryByRole("button", { name: /retry|repeat|apply|erneut|wiederholen|anwenden/iu })).toBeNull();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("restores selected worklogs alongside ordinary search summaries without inventing inventory totals", async () => {
    const { container } = restore(saved([
      ["jira_worklogs_by_id", { selectionScope: "native-visible-requested-worklogs", requestedCount: 3, returnedCount: 2,
        unreturnedWorklogIds: ["9223372036854775807"], items: [
          { id: "101", issueKey: "SYN-1", timeSpentSeconds: 0, comment: "First selected worklog", authorName: "Native author", started: "Native start time" },
          { id: "102", issueKey: "SYN-1", comment: "Second selected worklog" },
        ], total: 9999, nextPage: "https://untrusted.invalid/worklogs" }],
      ["jira_search_post", { items: [{ key: "SYN-3", summary: "Ordinary search summary", status: { name: "Open" } }], startAt: 0, total: 1 }],
    ]));
    const label = locale === "en" ? "Read selected Jira worklogs" : "Ausgewählte Jira-Arbeitsprotokolle lesen";
    const selection = screen.getByRole("group", { name: label });
    const expected = locale === "en" ? [
      "Worklog IDs requested: 3", "Requested worklogs returned: 2", "Requested worklog IDs not returned: 9223372036854775807",
      "IDs not returned may be missing or inaccessible. This is not proof of deletion or absence.",
      "Time spent (seconds): 0",
    ] : [
      "Angeforderte Arbeitsprotokoll-IDs: 3", "Zurückgegebene angeforderte Arbeitsprotokolle: 2", "Nicht zurückgegebene angeforderte Arbeitsprotokoll-IDs: 9223372036854775807",
      "Nicht zurückgegebene IDs können fehlen oder unzugänglich sein. Dies belegt weder Löschung noch Abwesenheit.",
      "Zeitaufwand (Sekunden): 0",
    ];
    for (const value of [...expected, "First selected worklog", "Second selected worklog", "Native author", "Native start time"])
      expect(selection.textContent).toContain(value);
    expect(within(selection).getAllByText(/SYN-1/u)).toHaveLength(2);
    expect(screen.getByText(locale === "en" ? "Search Jira issues" : "Jira-Vorgänge suchen")).toBeVisible();
    expect(screen.getByText("Ordinary search summary")).toBeVisible();
    expect(container.textContent).not.toMatch(/9999|untrusted\.invalid/u);
    expect(container.querySelector("pre, a, img, script")).toBeNull();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("keeps zero returned selections distinct from missing counters after remount", () => {
    const { container } = restore(saved([
      ["jira_worklogs_by_id", { selectionScope: "native-visible-requested-worklogs", requestedCount: 1, returnedCount: 0,
        unreturnedWorklogIds: ["101"], items: [] }],
      ["jira_worklogs_by_id", { selectionScope: "native-visible-requested-worklogs" }],
      ["jira_current_session", { userKey: "bound-key", username: "Bound user" }],
    ]));
    const expected = locale === "en" ? [
      "Requested worklogs returned: 0", "The requested worklog count was not provided.",
      "The returned worklog count was not provided.", "The selected worklog collection was not provided.",
      "The failed login count was not provided.",
    ] : [
      "Zurückgegebene angeforderte Arbeitsprotokolle: 0", "Die Anzahl angeforderter Arbeitsprotokolle wurde nicht angegeben.",
      "Die Anzahl zurückgegebener Arbeitsprotokolle wurde nicht angegeben.", "Die Sammlung ausgewählter Arbeitsprotokolle wurde nicht angegeben.",
      "Die Anzahl fehlgeschlagener Anmeldungen wurde nicht angegeben.",
    ];
    for (const value of expected) expect(container.textContent).toContain(value);
  });
});
