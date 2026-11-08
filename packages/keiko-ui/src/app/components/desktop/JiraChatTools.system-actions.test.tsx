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
import { SYSTEM_ACTION_CASES, SYSTEM_REVIEWED_TYPE, systemActionCase, systemActionExchange } from "./jira-system-action.test-fixture";

function expand(container: HTMLElement): void {
  for (const summary of container.querySelectorAll("details > summary")) fireEvent.click(summary);
}
afterEach(() => localStorage.removeItem(I18N_STORAGE_KEY));
describe.each(["en", "de"] as const)("system configuration actions in %s", (locale) => {
  const say = (english: string, german: string): string => locale === "en" ? english : german;
  beforeEach(async () => {
    await Promise.all([loadLocaleMessages(locale), loadOptionalWidgetMessages(locale)]);
    localStorage.setItem(I18N_STORAGE_KEY, locale);
  });
  it.each(SYSTEM_ACTION_CASES)("renders reviewed $operation inputs as readable facts", async ({ operation, args }) => {
    const approval: ChatToolWriteApprovalView = { kind: "jira-chat-write", approvalId: "system-approval", chatId: "chat-1",
      podId: "11111111-1111-4111-8111-111111111111", bindingGeneration: 1, authenticationGeneration: 1,
      invocationId: "system-action", operation, actionDigest: "a".repeat(64), requestedAt: Date.now(), expiresAt: Date.now() + 60000, state: "pending" };
    const { container } = render(<I18nProvider><JiraWriteApproval approval={approval}
      call={{ id: "system-action", name: operation.replace(/[.-]/gu, "_"), arguments: args }} turnState="pending"
      observe={vi.fn().mockResolvedValue(approval)} decide={vi.fn()} /></I18nProvider>);
    await screen.findByRole("button", { name: say("Approve this action", "Diese Aktion genehmigen") });
    const review = screen.getByRole("region", { name: say("Review Jira action", "Jira-Aktion prüfen") });
    expect(review.textContent).toContain("actor-key");
    expect(review.textContent).not.toMatch(/expectedActorKey|expectedApplicationRole|confirmUnverifiedMigration|expectedIssueType|expectedObservedMembership|expectedNode/u);
    expect(review.querySelector("pre, textarea, a, img")).toBeNull();
    const admin = say("explicit Jira administration grant", "ausdrückliche Jira-Administrationsfreigabe");
    if (operation === "jira.pin-comment" || operation === "jira.notify-issue") expect(review.textContent).not.toContain(admin);
    else expect(review.textContent).toContain(admin);
    if (operation === "jira.set-application-role") {
      expect(review.textContent).toContain(say("Explicit empty list (0 entries)", "Ausdrücklich leere Liste (0 Einträge)"));
      expect(review.textContent).toContain(say("Only the selected", "Nur Gruppen und Standardgruppen der ausgewählten"));
      expect(await axe(container)).toHaveNoViolations();
    }
    if (operation === "jira.update-issue-type") expect(review.textContent).toContain(say("Native metadata not provided (null)", "Native Metadaten nicht angegeben (null)"));
  });
  it("retains all thirty-five results after reload without guessing effects, IDs or links", async () => {
    const exchanges = SYSTEM_ACTION_CASES.map((fixture, index) => systemActionExchange(fixture,
      { ...fixture.receipt, outcome: "succeeded", browseUrl: "https://untrusted.invalid/destination" }, index,
      fixture.operation === "jira.pin-comment" ? "unknown" : undefined));
    const transcript = JSON.parse(JSON.stringify({ schemaVersion: 1, exchanges })) as ChatToolTranscript;
    const view = <I18nProvider><JiraChatTools transcript={transcript} turnState="completed" /></I18nProvider>;
    const first = render(view);
    const text = first.container.textContent;
    first.unmount();
    const restored = render(view);
    expect(restored.container.textContent).toBe(text);
    expand(restored.container);
    expect(screen.getAllByRole("group")).toHaveLength(35);
    const notification = screen.getByRole("group", { name: say("Request Jira issue notification", "Jira-Vorgangsbenachrichtigung anfordern") });
    expect(within(notification).getByText(say("Jira accepted the change; confirmation incomplete", "Jira hat die Änderung angenommen; Bestätigung unvollständig"))).toBeVisible();
    expect(notification.textContent).toContain(say("Recipient delivery is unconfirmed", "Zustellung an Empfänger bleibt unbestätigt"));
    const pin = screen.getByRole("group", { name: say("Pin Jira comment", "Jira-Kommentar anheften") });
    expect(within(pin).getByText(say("Jira outcome unknown", "Ausgang der Jira-Aktion unbekannt"))).toBeVisible();
    expect(pin.textContent).toContain(say("Requested comment pin", "Angefordertes Anheften des Kommentars"));
    expect(pin.textContent).not.toContain(say("Independently observed pinned comment", "Unabhängig beobachteter angehefteter Kommentar"));
    const columns = screen.getByRole("group", { name: say("Set Jira user columns", "Jira-Benutzerspalten setzen") });
    expect(columns.textContent).toContain("actor-key");
    expect(columns.textContent).toContain("target-key");
    expect(columns.textContent).toContain("3: status");
    expect(restored.container.textContent).toContain("9223372036854775807");
    expect(restored.container.textContent).not.toContain("untrusted.invalid");
    expect(restored.container.querySelector("pre, a, img, button")).toBeNull();
    expect(await axe(restored.container)).toHaveNoViolations();
  });
  it("preserves readable no-prior-task and type review null/empty/false states after reload", async () => {
    const exchanges = [
      configurationExchange("jira_reindex_status", { outcome: "succeeded", taskSelection: "active-or-latest", taskState: "no-prior-task" }),
      configurationExchange("jira_issue_type", { ...SYSTEM_REVIEWED_TYPE, reviewSnapshot: SYSTEM_REVIEWED_TYPE }, 1),
      configurationExchange("jira_issue_type", { ...SYSTEM_REVIEWED_TYPE, description: "", reviewSnapshot: { ...SYSTEM_REVIEWED_TYPE, description: "" } }, 2),
      configurationExchange("jira_issue_type", { id: "2", name: "Legacy type", subtask: false }, 3),
    ];
    const transcript = JSON.parse(JSON.stringify({ schemaVersion: 1, exchanges })) as ChatToolTranscript;
    const view = <I18nProvider><JiraChatTools transcript={transcript} turnState="completed" /></I18nProvider>;
    const first = render(view); first.unmount();
    const { container } = render(view);
    expand(container);
    expect(container.textContent).toContain(say("Jira reports no prior reindex task", "Jira meldet keinen früheren Reindex-Auftrag"));
    expect(container.textContent).not.toContain(say("Native progress value", "Nativer Fortschrittswert"));
    expect(container.textContent).toContain(say("Complete native issue-type review snapshot available", "Vollständiger nativer Vorgangstyp-Prüfstand verfügbar"));
    expect(container.textContent).toContain(say("Complete native issue-type review snapshot unavailable", "Vollständiger nativer Vorgangstyp-Prüfstand nicht verfügbar"));
    expect(container.textContent).toContain(say("Native metadata not provided (null)", "Native Metadaten nicht angegeben (null)"));
    expect(container.textContent).toContain(say("Value: empty text", "Wert: leerer Text"));
    expect(container.textContent).toContain("false");
    expect(container.querySelector("pre, a, img, button")).toBeNull();
    expect(await axe(container)).toHaveNoViolations();
  });
  it("keeps missing acknowledgement identities absent on restored creation results", () => {
    const fixture = systemActionCase("jira.create-issue-type");
    const exchange = systemActionExchange(fixture, { userKey: "actor-key", issueTypePresent: true, outcome: "succeeded-unconfirmed" });
    const transcript = JSON.parse(JSON.stringify({ schemaVersion: 1, exchanges: [exchange] })) as ChatToolTranscript;
    const { container } = render(<I18nProvider><JiraChatTools transcript={transcript} turnState="completed" /></I18nProvider>);
    expand(container);
    expect(container.textContent).not.toContain("9007199254740993");
    expect(container.textContent).toContain(say("confirmation incomplete", "Bestätigung unvollständig"));
    expect(container.querySelector("a, pre, button")).toBeNull();
  });
});
