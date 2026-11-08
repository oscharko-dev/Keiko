import { fireEvent, render, screen, within } from "@testing-library/react";
import { axe } from "jest-axe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatToolTranscript } from "@oscharko-dev/keiko-contracts/bff-wire";
import type { ChatToolWriteApprovalView } from "@oscharko-dev/keiko-contracts";
import { I18N_STORAGE_KEY, I18nProvider, loadLocaleMessages } from "@/lib/i18n";
import { loadOptionalWidgetMessages } from "@/lib/optional-widget-i18n";
import { JiraChatTools } from "./JiraChatTools";
import { JiraWriteApproval } from "./JiraWriteApproval";
import { configurationExchange } from "./jira-configuration-mutation.test-fixture";
import { PLANNING_CASES, PLANNING_VALUE } from "./jira-planning-mutation.test-fixture";

afterEach(() => localStorage.removeItem(I18N_STORAGE_KEY));
describe.each(["en", "de"] as const)("native planning actions in %s", (locale) => {
  beforeEach(async () => {
    await Promise.all([loadLocaleMessages(locale), loadOptionalWidgetMessages(locale)]);
    localStorage.setItem(I18N_STORAGE_KEY, locale);
  });
  it.each(PLANNING_CASES)("shows exact reviewed and target facts for $operation", async ({ operation, args }) => {
    const approval: ChatToolWriteApprovalView = { kind: "jira-chat-write", approvalId: "planning-approval", chatId: "chat-1",
      podId: "11111111-1111-4111-8111-111111111111", bindingGeneration: 1, authenticationGeneration: 1,
      invocationId: "planning-action", operation, actionDigest: "b".repeat(64), requestedAt: Date.now(), expiresAt: Date.now() + 60000, state: "pending" };
    const { container } = render(<I18nProvider><JiraWriteApproval approval={approval} call={{ id: "planning-action", name: operation.replace(/[.-]/gu, "_"), arguments: args }}
      turnState="pending" observe={vi.fn().mockResolvedValue(approval)} decide={vi.fn()} /></I18nProvider>);
    const region = screen.getByRole("region", { name: locale === "en" ? "Review Jira action" : "Jira-Aktion prüfen" });
    expect(await screen.findByRole("button", { name: locale === "en" ? "Approve this action" : "Diese Aktion genehmigen" })).toBeVisible();
    expect(region.textContent).toContain("actor-key");
    expect(region.textContent).not.toMatch(/expectedActorKey|expectedLinks|expectedVersionSnapshot|expectedCategory|rankCustomFieldId|valueNodes/u);
    expect(region.querySelector("pre, textarea, details, a, img")).toBeNull();
    if ("expectedLinks" in args) {
      expect(region.textContent).toContain("Reviewed release");
      expect(region.textContent).toContain("9007199254740993");
      expect(region.textContent).toContain(locale === "en" ? "Value: JSON null" : "Wert: JSON-null");
      expect(region.textContent).toContain(locale === "en" ? "Value: empty text" : "Wert: leerer Text");
      expect(region.textContent).toContain("/a~1b");
    }
    if (operation === "jira.set-issue-estimation") {
      expect(region.textContent).toContain(locale === "en" ? "Minutes" : "Minuten");
      expect(region.textContent).toContain(locale === "en" ? "does not request clearing" : "fordert keine Löschung an");
    }
    if (operation.includes("project-category")) expect(region.textContent).toContain(locale === "en" ? "explicit Jira administration grant" : "ausdrückliche Jira-Administrationsfreigabe");
    if (operation === "jira.epic-remove-issues") expect(region.textContent).toContain(locale === "en" ? "Explicitly observed without an epic" : "Ausdrücklich ohne Epic beobachtet");
    if (operation === "jira.rank-issues" || operation === "jira.upsert-version-remote-link-by-global-id") expect(await axe(container)).toHaveNoViolations();
  });
  it("restores every receipt without replay and gives uncertainty precedence over stale data", async () => {
    const exchanges = PLANNING_CASES.map(({ operation, receipt }, index) => configurationExchange(operation.replace(/[.-]/gu, "_"),
      { ...receipt, browseUrl: "https://untrusted.invalid/target" }, index, operation === "jira.set-issue-estimation" ? "unknown" : undefined));
    const transcript = JSON.parse(JSON.stringify({ schemaVersion: 1, exchanges })) as ChatToolTranscript;
    const view = <I18nProvider><JiraChatTools transcript={transcript} turnState="completed" /></I18nProvider>;
    const initial = render(view);
    const originalText = initial.container.textContent;
    initial.unmount();
    const { container } = render(view);
    expect(container.textContent).toBe(originalText);
    for (const summary of container.querySelectorAll("details > summary")) fireEvent.click(summary);
    expect(screen.getAllByRole("group")).toHaveLength(11);
    const estimate = screen.getByRole("group", { name: locale === "en" ? "Set Jira issue estimate" : "Jira-Vorgang schätzen" });
    expect(within(estimate).getByText(locale === "en" ? "Jira outcome unknown" : "Ausgang der Jira-Aktion unbekannt")).toBeVisible();
    expect(estimate.textContent).toContain(locale === "en" ? "Native verification unit: seconds" : "Native Verifikationseinheit: Sekunden");
    expect(estimate.textContent).toContain(locale === "en" ? "Requested estimate" : "Angeforderter Schätzwert");
    expect(estimate.textContent).not.toContain(locale === "en" ? "Independently confirmed estimate" : "Unabhängig bestätigter Schätzwert");
    expect(container.textContent).toContain(locale === "en" ? "Ranking remains unconfirmed" : "Die Einordnung bleibt nach Empfangsbestätigung unbestätigt");
    expect(container.textContent).toContain(locale === "en" ? "Category deletion remains unconfirmed" : "Die Kategorienlöschung bleibt nach Empfangsbestätigung unbestätigt");
    expect(container.textContent).not.toContain("untrusted.invalid");
    expect(container.querySelector("pre, a, img, button")).toBeNull();
    expect(await axe(container)).toHaveNoViolations();
  });
  it("keeps legacy unavailable link identity separate from actual typed value facts after reload", async () => {
    const result = configurationExchange("jira_version_remote_links", { outcome: "succeeded", versionId: "9007199254740993", items: [
      { name: "Unbound legacy link", valueAvailable: true, valueNodes: PLANNING_VALUE },
      { name: "Bound link", reviewIdentityAvailable: true, globalId: "reviewed-link", valueAvailable: false },
    ] });
    const transcript = JSON.parse(JSON.stringify({ schemaVersion: 1, exchanges: [result] })) as ChatToolTranscript;
    const { container } = render(<I18nProvider><JiraChatTools transcript={transcript} turnState="completed" /></I18nProvider>);
    for (const summary of container.querySelectorAll("details > summary")) fireEvent.click(summary);
    expect(container.textContent).toContain(locale === "en" ? "Native global ID unavailable" : "Native globale ID nicht verfügbar");
    expect(container.textContent).toContain("reviewed-link");
    expect(container.textContent).toContain(locale === "en" ? "This row has a bound native global ID" : "Diese Zeile hat eine gebundene native globale ID");
    expect(container.querySelector("pre, a, img, button")).toBeNull();
    expect(await axe(container)).toHaveNoViolations();
  });
});
