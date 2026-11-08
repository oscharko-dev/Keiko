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
import { ACCESS_CONFIGURATION_CASES, ACCESS_SCHEME } from "./jira-access-configuration.test-fixture";
import { jiraAccessConfigurationContextFacts } from "./jira-access-configuration-approval";

function expand(container: HTMLElement): void {
  for (const summary of container.querySelectorAll("details > summary")) fireEvent.click(summary);
}
afterEach(() => localStorage.removeItem(I18N_STORAGE_KEY));
describe.each(["en", "de"] as const)("permission and role review in %s", (locale) => {
  const say = (english: string, german: string): string => locale === "en" ? english : german;
  beforeEach(async () => {
    await Promise.all([loadLocaleMessages(locale), loadOptionalWidgetMessages(locale)]);
    localStorage.setItem(I18N_STORAGE_KEY, locale);
  });
  it.each(ACCESS_CONFIGURATION_CASES)("renders reviewed snapshots and exact targets for $operation", async ({ operation, args }) => {
    const approval: ChatToolWriteApprovalView = { kind: "jira-chat-write", approvalId: "access-approval", chatId: "chat-1",
      podId: "11111111-1111-4111-8111-111111111111", bindingGeneration: 1, authenticationGeneration: 1,
      invocationId: "access-action", operation, actionDigest: "a".repeat(64), requestedAt: Date.now(), expiresAt: Date.now() + 60000, state: "pending" };
    const { container } = render(<I18nProvider><JiraWriteApproval approval={approval}
      call={{ id: "access-action", name: operation.replace(/[.-]/gu, "_"), arguments: args }} turnState="pending"
      observe={vi.fn().mockResolvedValue(approval)} decide={vi.fn()} /></I18nProvider>);
    await screen.findByRole("button", { name: say("Approve this action", "Diese Aktion genehmigen") });
    const region = screen.getByRole("region", { name: say("Review Jira action", "Jira-Aktion prüfen") });
    expect(region.textContent).toContain("actor-key");
    expect(region.textContent).toContain(say("explicit Jira administration grant", "ausdrückliche Jira-Administrationsfreigabe"));
    expect(region.textContent).not.toMatch(/expectedScheme|expectedActors|expectedRole|expectedSwapActors|expectedActorKey|projectIdOrKey/u);
    expect(region.querySelector("pre, textarea, a, img")).toBeNull();
    if ("expectedScheme" in args) {
      expect(region.textContent).toContain("BROWSE_PROJECTS");
      expect(region.textContent).toContain("Developers");
      expect(region.textContent).toContain(say("Complete reviewed grant set", "Vollständige geprüfte Berechtigungseinträge"));
    }
    if ("expectedRole" in args) expect(region.textContent).toContain(say("Native metadata not provided (null)", "Native Metadaten nicht angegeben (null)"));
    if (operation === "jira.add-permission-grant") {
      expect(region.textContent).toContain("projectRole");
      expect(region.textContent).toContain("10002");
    }
    if (operation === "jira.set-project-role-actors") {
      expect(region.textContent).toContain(say("Two empty lists clear ALL", "Zwei leere Listen entfernen ALLE"));
      expect(region.textContent).toContain(say("Explicit empty set (0 entries)", "Ausdrücklich leere Menge (0 Einträge)"));
    }
    if (operation === "jira.set-permission-scheme-attribute") {
      expect(region.textContent).toContain(say("Reviewed native attribute string", "Geprüfter nativer Attributtext"));
      expect(region.textContent).toContain(say("Requested attribute boolean", "Angeforderter boolescher Attributwert"));
    }
    if (operation === "jira.add-role-default-actors" || operation === "jira.update-permission-scheme") expect(await axe(container)).toHaveNoViolations();
  });
  it("retains all fifteen receipts after reload without replay or invented successful actor effects", async () => {
    const exchanges = ACCESS_CONFIGURATION_CASES.map(({ operation, receipt }, index) => configurationExchange(operation.replace(/[.-]/gu, "_"),
      { ...receipt, outcome: "succeeded", browseUrl: "https://untrusted.invalid/role" }, index,
      operation === "jira.set-permission-scheme-attribute" ? "unknown" : undefined));
    const transcript = JSON.parse(JSON.stringify({ schemaVersion: 1, exchanges })) as ChatToolTranscript;
    const view = <I18nProvider><JiraChatTools transcript={transcript} turnState="completed" /></I18nProvider>;
    const initial = render(view);
    const before = initial.container.textContent;
    initial.unmount();
    const restored = render(view);
    expect(restored.container.textContent).toBe(before);
    expand(restored.container);
    expect(screen.getAllByRole("group")).toHaveLength(15);
    const replaced = screen.getByRole("group", { name: say("Replace Jira project role actors", "Jira-Projektrollenakteure ersetzen") });
    expect(within(replaced).getByText(say("Jira accepted the change; confirmation incomplete", "Jira hat die Änderung angenommen; Bestätigung unvollständig"))).toBeVisible();
    expect(replaced.textContent).toContain(say("Requested user count", "Anzahl angeforderter Benutzer"));
    const attribute = screen.getByRole("group", { name: say("Set Jira permission scheme attribute", "Jira-Berechtigungsschema-Attribut setzen") });
    expect(within(attribute).getByText(say("Jira outcome unknown", "Ausgang der Jira-Aktion unbekannt"))).toBeVisible();
    expect(attribute.textContent).toContain("false");
    expect(attribute.textContent).not.toContain(say("Independently confirmed attribute", "Unabhängig bestätigter boolescher Attributwert"));
    expect(restored.container.textContent).toContain("9007199254740993");
    expect(restored.container.textContent).not.toContain("untrusted.invalid");
    expect(restored.container.querySelector("pre, a, img, button")).toBeNull();
    expect(await axe(restored.container)).toHaveNoViolations();
  });
  it("distinguishes omitted replacement grants from an explicitly empty replacement", () => {
    const base = { expectedActorKey: "actor-key", expectedScheme: ACCESS_SCHEME, description: "" };
    const omitted = jiraAccessConfigurationContextFacts("jira.update-permission-scheme", base, (key) => key);
    const empty = jiraAccessConfigurationContextFacts("jira.update-permission-scheme", { ...base, permissions: [] }, (key) => key);
    expect(omitted.some(({ value }) => value.kind === "text" && value.text === "chat.jira.accessWrite.retainGrants")).toBe(true);
    expect(empty.some(({ value }) => value.kind === "text" && value.text === "chat.jira.accessWrite.replaceGrants")).toBe(true);
    expect(empty.some(({ value }) => value.kind === "text" && value.text === "chat.jira.accessWrite.retainGrants")).toBe(false);
  });
  it("shows a native role review null description separately from unknown metadata after reload", async () => {
    const source = { id: "7", name: "Reviewed role", actorsScope: "role-configuration", actors: [],
      reviewSnapshot: { id: "7", name: "Reviewed role", description: null } };
    const exchanges = [configurationExchange("jira_role", source), configurationExchange("jira_role", { id: "8", name: "Legacy role", actors: [] }, 1)];
    const transcript = JSON.parse(JSON.stringify({ schemaVersion: 1, exchanges })) as ChatToolTranscript;
    const { container } = render(<I18nProvider><JiraChatTools transcript={transcript} turnState="completed" /></I18nProvider>);
    expand(container);
    expect(container.textContent).toContain(say("Native role review snapshot available", "Nativer Rollenprüfstand verfügbar"));
    expect(container.textContent).toContain(say("Complete native role review snapshot unavailable", "Vollständiger nativer Rollenprüfstand nicht verfügbar"));
    expect(container.querySelector("pre, a, button")).toBeNull();
    expect(await axe(container)).toHaveNoViolations();
  });
});
