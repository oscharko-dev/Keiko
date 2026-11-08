import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { axe } from "jest-axe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatToolExchange, ChatToolTranscript } from "@oscharko-dev/keiko-contracts/bff-wire";
import type { ChatToolWriteApprovalView } from "@oscharko-dev/keiko-contracts";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { I18N_STORAGE_KEY, I18nProvider, loadLocaleMessages } from "@/lib/i18n";
import { loadOptionalWidgetMessages } from "@/lib/optional-widget-i18n";
import { JiraChatTools } from "./JiraChatTools";
import { JiraWriteApproval } from "./JiraWriteApproval";
import { CONFIGURATION_CASES, CONFIGURATION_SPRINT, configurationExchange, type ConfigurationOperation } from "./jira-configuration-mutation.test-fixture";

async function preview(operation: ConfigurationOperation, args: CatalogJsonObject, locale: "en" | "de"): Promise<ReturnType<typeof render>> {
  const approval: ChatToolWriteApprovalView = { kind: "jira-chat-write", approvalId: "configuration-approval", chatId: "chat-1",
    podId: "11111111-1111-4111-8111-111111111111", bindingGeneration: 1, authenticationGeneration: 1,
    invocationId: "configuration-action", operation, actionDigest: "a".repeat(64), requestedAt: Date.now(), expiresAt: Date.now() + 60000, state: "pending" };
  const result = render(<I18nProvider><JiraWriteApproval approval={approval} call={{ id: "configuration-action",
    name: operation.replace(/[.-]/gu, "_"), arguments: args }} turnState="pending" observe={vi.fn().mockResolvedValue(approval)} decide={vi.fn()} /></I18nProvider>);
  await waitFor(() => expect(screen.getByRole("button", { name: locale === "en" ? "Approve this action" : "Diese Aktion genehmigen" })).toBeEnabled());
  return result;
}
function restored(exchanges: readonly ChatToolExchange[]): ReturnType<typeof render> {
  const transcript = JSON.parse(JSON.stringify({ schemaVersion: 1, exchanges })) as ChatToolTranscript;
  const show = (): ReturnType<typeof render> => render(<I18nProvider><JiraChatTools transcript={transcript} turnState="completed" /></I18nProvider>);
  const initial = show();
  const content = initial.container.textContent;
  initial.unmount();
  const result = show();
  expect(result.container.textContent).toBe(content);
  for (const summary of result.container.querySelectorAll("details > summary")) fireEvent.click(summary);
  return result;
}
function reviewedContext(content: string, args: CatalogJsonObject, locale: "en" | "de"): void {
  if ("expectedTabs" in args)
    for (const value of ["9007199254740993", "Reviewed screen", "Overview tab", "Detail tab"]) expect(content).toContain(value);
  if ("expectedFields" in args) {
    for (const value of ["Summary", "Acceptance", "customfield_10100"]) expect(content).toContain(value);
    expect(content).toContain(locale === "en" ? "Native metadata not provided (null)" : "Native Metadaten nicht angegeben (null)");
    expect(content).toContain(locale === "en" ? "Boolean: false" : "Wahrheitswert: falsch");
  }
  if ("expectedBoardName" in args)
    for (const value of ["actor-key", "Reviewed board", "scrum", "42"]) expect(content).toContain(value);
}
afterEach(() => localStorage.removeItem(I18N_STORAGE_KEY));
describe.each(["en", "de"] as const)("screen and board configuration in %s", (locale) => {
  beforeEach(async () => {
    await Promise.all([loadLocaleMessages(locale), loadOptionalWidgetMessages(locale)]);
    localStorage.setItem(I18N_STORAGE_KEY, locale);
  });
  it.each(CONFIGURATION_CASES)("shows the complete reviewed snapshot for $operation", async ({ operation, args }) => {
    const { container } = await preview(operation, args, locale);
    const region = screen.getByRole("region", { name: locale === "en" ? "Review Jira action" : "Jira-Aktion prüfen" });
    const content = region.textContent ?? "";
    reviewedContext(content, args, locale);
    expect(content).toContain(locale === "en" ? "Jira does not atomically bind" : "Jira bindet den Schreibvorgang nicht atomar");
    expect(content).not.toMatch(/expectedTabs|expectedFields|expectedActorKey|expectedFilterId|showWhenEmpty/u);
    expect(region.querySelector("pre, textarea, details, a, img")).toBeNull();
    if (operation === "jira.move-screen-tab") {
      expect(content).toContain(locale === "en" ? "Requested tab position (zero-based)" : "Angeforderte Tabposition (nullbasiert)");
      expect(content).toContain(locale === "en" ? "Native tab position 0 is the first tab" : "Die native Tabposition 0 bezeichnet den ersten Tab");
    }
    if (operation === "jira.set-screen-field-show-when-empty" || operation === "jira.set-board-refined-velocity")
      expect(await axe(container)).toHaveNoViolations();
  });
  it("shows a genuinely empty reviewed layout and the unbound default target separately", async () => {
    const empty = CONFIGURATION_CASES.find((entry) => entry.operation === "jira.add-screen-tab-field");
    if (empty === undefined) throw new Error("Missing screen fixture");
    const first = await preview(empty.operation, { ...empty.args, expectedFields: [] }, locale);
    expect(first.container.textContent).toContain(locale === "en" ? "The reviewed tab contains no fields." : "Der geprüfte Tab enthält keine Felder.");
    first.unmount();
    const defaultField = CONFIGURATION_CASES.find((entry) => entry.operation === "jira.add-default-screen-field");
    if (defaultField === undefined) throw new Error("Missing default fixture");
    const result = await preview(defaultField.operation, defaultField.args, locale);
    expect(result.container.textContent).toContain(locale === "en" ? "Jira chooses the default screen and tab" : "Jira wählt den Standardbildschirm und Tab");
    expect(result.container.textContent).not.toContain("9007199254740993");
  });
  it("restores all thirteen receipts with journal precedence and no invented destinations", async () => {
    const exchanges = CONFIGURATION_CASES.map(({ operation, receipt }, index) => configurationExchange(operation.replace(/[.-]/gu, "_"),
      { ...receipt, browseUrl: "https://untrusted.invalid/configuration" }, index, operation === "jira.set-board-refined-velocity" ? "unknown" : undefined));
    const { container } = restored(exchanges);
    const names = locale === "en" ? ["Add field to Jira's default screen", "Add Jira screen tab field", "Remove Jira screen tab field",
      "Reorder Jira screen tab field", "Set Jira field display when empty", "Reorder Jira screen tab", "Delete Jira board", "Set Jira board refined velocity",
      "Replace Jira sprint metadata", "Delete Jira sprint", "Swap Jira sprints", "Remove synchronization from selected Jira sprints", "Remove synchronization from all Jira sprints"]
      : ["Feld zum Jira-Standardbildschirm hinzufügen", "Feld zum Jira-Bildschirmtab hinzufügen", "Feld aus Jira-Bildschirmtab entfernen",
        "Feld im Jira-Bildschirmtab umordnen", "Jira-Feldanzeige bei leerem Wert festlegen", "Jira-Bildschirmtab umordnen", "Jira-Board löschen", "Verfeinerte Velocity des Jira-Boards festlegen",
        "Jira-Sprintmetadaten ersetzen", "Jira-Sprint löschen", "Jira-Sprints tauschen", "Synchronisierung ausgewählter Jira-Sprints entfernen", "Synchronisierung aller Jira-Sprints entfernen"];
    for (const name of names) expect(screen.getByRole("group", { name })).toBeVisible();
    const board = screen.getByRole("group", { name: locale === "en" ? "Set Jira board refined velocity" : "Verfeinerte Velocity des Jira-Boards festlegen" });
    expect(within(board).getByText(locale === "en" ? "Jira outcome unknown" : "Ausgang der Jira-Aktion unbekannt")).toBeVisible();
    expect(board.textContent).toContain(locale === "en" ? "Requested setting; the current value is unconfirmed" : "Angeforderte Einstellung; aktueller Wert unbestätigt");
    expect(board.textContent).not.toContain(locale === "en" ? "Independently observed setting" : "Unabhängig beobachtete Einstellung");
    expect(container.textContent).toContain(locale === "en" ? "Deletion remains unconfirmed" : "Die Löschung bleibt nach Empfangsbestätigung unbestätigt");
    expect(container.textContent).toContain("9007199254740993");
    expect(container.textContent).not.toContain("untrusted.invalid");
    expect(container.querySelector("pre, a, img, button")).toBeNull();
    expect(await axe(container)).toHaveNoViolations();
  });
  it("makes instance-wide cleanup distinct from its reviewed sample and shows replacement clearing", async () => {
    const all = CONFIGURATION_CASES.find((entry) => entry.operation === "jira.unmap-all-sprints");
    const replace = CONFIGURATION_CASES.find((entry) => entry.operation === "jira.replace-sprint");
    if (all === undefined || replace === undefined) throw new Error("Missing sprint fixtures");
    const first = await preview(all.operation, all.args, locale);
    expect(first.container.textContent).toContain(locale === "en" ? "IRREVERSIBLE INSTANCE-WIDE CLEANUP" : "UNUMKEHRBARE INSTANZWEITE BEREINIGUNG");
    expect(first.container.textContent).toContain(locale === "en" ? "does not restrict the instance-wide effect" : "begrenzt nicht die instanzweite Wirkung");
    expect(first.container.textContent).toContain("Reviewed other sprint");
    expect(first.container.textContent).toContain(locale === "en" ? "Native metadata omitted; value unknown." : "Native Metadaten ausgelassen; Wert unbekannt.");
    expect(await axe(first.container)).toHaveNoViolations();
    first.unmount();
    const replacement = await preview(replace.operation, replace.args, locale);
    expect(replacement.container.textContent).toContain(locale === "en" ? "Requested replacement: clear this nullable value (null)." : "Angeforderter Ersatz: diesen nullable Wert löschen (null).");
    expect(replacement.container.textContent).toContain(locale === "en" ? "Native metadata not provided (null)" : "Native Metadaten nicht angegeben (null)");
    expect(replacement.container.textContent).toContain(locale === "en" ? "Value: empty text" : "Wert: leerer Text");
  });
  it("restores native sprint review facts with absent, null, empty and false kept distinct", async () => {
    const receipt = configurationExchange("jira_sprint", { outcome: "succeeded", items: [{ ...CONFIGURATION_SPRINT, reviewSnapshot: CONFIGURATION_SPRINT }] });
    const { container } = restored([receipt]);
    expect(container.textContent).toContain("Reviewed sprint");
    expect(container.textContent).toContain(locale === "en" ? "Native sprint review snapshot" : "Nativer Sprint-Prüfstand");
    expect(container.textContent).toContain(locale === "en" ? "Native metadata omitted; value unknown." : "Native Metadaten ausgelassen; Wert unbekannt.");
    expect(container.textContent).toContain(locale === "en" ? "Native metadata not provided (null)" : "Native Metadaten nicht angegeben (null)");
    expect(container.textContent).toContain(locale === "en" ? "Boolean: false" : "Wahrheitswert: falsch");
    expect(container.textContent).toContain(locale === "en" ? "Value: empty text" : "Wert: leerer Text");
    expect(container.querySelector("a, img, pre, button")).toBeNull();
    expect(await axe(container)).toHaveNoViolations();
  });
});
