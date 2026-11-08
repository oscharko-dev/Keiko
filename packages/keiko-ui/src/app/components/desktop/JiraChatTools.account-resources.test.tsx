import { fireEvent, render, screen, within } from "@testing-library/react";
import { axe } from "jest-axe";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChatToolTranscript } from "@oscharko-dev/keiko-contracts/bff-wire";
import { I18N_STORAGE_KEY, I18nProvider, loadLocaleMessages } from "@/lib/i18n";
import { loadOptionalWidgetMessages } from "@/lib/optional-widget-i18n";
import { JiraChatTools } from "./JiraChatTools";
import { ACCOUNT_RESOURCE_CASES, accountResourceCase, accountResourceExchange } from "./jira-account-resource.test-fixture";
import { configurationExchange } from "./jira-configuration-mutation.test-fixture";

function expand(container: HTMLElement): void {
  for (const summary of container.querySelectorAll("details > summary")) fireEvent.click(summary);
}
afterEach(() => localStorage.removeItem(I18N_STORAGE_KEY));
describe.each(["en", "de"] as const)("account/resource result cards in %s", (locale) => {
  const say = (english: string, german: string): string => locale === "en" ? english : german;
  beforeEach(async () => {
    await Promise.all([loadLocaleMessages(locale), loadOptionalWidgetMessages(locale)]);
    localStorage.setItem(I18N_STORAGE_KEY, locale);
  });
  it("restores all forty-five readable cards without replay, raw payloads or external destinations", async () => {
    const exchanges = ACCOUNT_RESOURCE_CASES.map((selected, index) => accountResourceExchange(selected, index,
      { ...selected.receipt, outcome: "succeeded", browseUrl: "https://untrusted.invalid/target" }));
    const transcript = JSON.parse(JSON.stringify({ schemaVersion: 1, exchanges })) as ChatToolTranscript;
    const view = <I18nProvider><JiraChatTools transcript={transcript} turnState="completed" /></I18nProvider>;
    const first = render(view); expand(first.container); const before = first.container.textContent; first.unmount();
    const restored = render(view); expand(restored.container);
    expect(restored.container.textContent).toBe(before);
    expect(screen.getAllByRole("group")).toHaveLength(45);
    expect(restored.container.textContent).toContain("9223372036854775807");
    expect(restored.container.textContent).toContain("9007199254740993");
    expect(restored.container.textContent).not.toMatch(/untrusted\.invalid|atlassianConnectors\.action|chat\.jira\.accountWrite|actorUserKey|sessionEstablished|bulkFailedElementNumbers/u);
    expect(restored.container.querySelector("pre, textarea, a, img")).toBeNull();
    for (const card of screen.getAllByRole("group")) expect(card.querySelector("button")).toBeNull();
    const deletion = screen.getByRole("group", { name: say("Delete Jira project", "Jira-Projekt löschen") });
    expect(within(deletion).getByText(say("Jira accepted the change; confirmation incomplete", "Jira hat die Änderung angenommen; Bestätigung unvollständig"))).toBeVisible();
    const avatar = screen.getByRole("group", { name: say("Select Jira project avatar", "Jira-Projektavatar auswählen") });
    expect(avatar.textContent).toContain(say("Independently observed avatar selection", "Unabhängig beobachtete Avatarauswahl"));
    const batch = screen.getByRole("group", { name: say("Create Jira issues in one batch", "Jira-Vorgänge gemeinsam erstellen") });
    expect(batch.textContent).toContain(say("without assigning successes to input rows", "ohne Erfolgszuordnung zu Eingabezeilen"));
    expect(await axe(restored.container)).toHaveNoViolations();
  });
  it("keeps journal uncertainty above avatar selection and private login on remount", () => {
    const exchanges = ["jira.set-user-avatar", "jira.login"].map((operation, index) => {
      const selected = accountResourceCase(operation);
      return accountResourceExchange(selected, index, { ...selected.receipt, outcome: "succeeded" }, "unknown");
    });
    const transcript = JSON.parse(JSON.stringify({ schemaVersion: 1, exchanges })) as ChatToolTranscript;
    const view = <I18nProvider><JiraChatTools transcript={transcript} turnState="completed" /></I18nProvider>;
    const first = render(view); first.unmount(); const restored = render(view); expand(restored.container);
    expect(screen.getAllByText(say("Jira outcome unknown", "Ausgang der Jira-Aktion unbekannt"))).toHaveLength(2);
    expect(restored.container.textContent).toContain(say("Requested avatar selection", "Angeforderte Avatarauswahl"));
    expect(restored.container.textContent).not.toContain(say("Independently observed avatar selection", "Unabhängig beobachtete Avatarauswahl"));
    expect(restored.container.textContent).not.toContain(say("The private session actor was independently observed", "Der private Sitzungsakteur wurde unabhängig"));
    expect(restored.container.querySelector("button, a, pre")).toBeNull();
  });
  it("shows policy rejection as an observed false/count without revealing license or password errors", async () => {
    const selected = accountResourceCase("jira.validate-license");
    const exchange = accountResourceExchange(selected, 0, { ...selected.receipt, outcome: "succeeded", messages: ["private-value-must-not-render"],
      fieldErrors: [{ fieldName: "license", message: "private-value-must-not-render" }] });
    const transcript: ChatToolTranscript = { schemaVersion: 1, exchanges: [exchange] };
    const { container } = render(<I18nProvider><JiraChatTools transcript={transcript} turnState="completed" /></I18nProvider>);
    expand(container);
    expect(container.textContent).toContain(say("Native validation accepted", "Native Validierung akzeptiert"));
    expect(container.textContent).toContain("false");
    expect(container.textContent).toContain(say("no license was activated", "Keine Lizenz wurde aktiviert"));
    expect(container.textContent).not.toContain("private-value-must-not-render");
    expect(container.querySelector("pre, input, textarea, button")).toBeNull();
    expect(await axe(container)).toHaveNoViolations();
  });
  it("retains known creation context with missing ACK identities", () => {
    const exchanges = [
      accountResourceExchange(accountResourceCase("jira.create-user"), 0, { actorUserKey: "actor-key", userPresent: true, outcome: "unknown" }, "unknown"),
      accountResourceExchange(accountResourceCase("jira.create-issues"), 1, { userKey: "actor-key", requestedIssueCount: 2, outcome: "succeeded-unconfirmed" }),
    ];
    const { container } = render(<I18nProvider><JiraChatTools transcript={{ schemaVersion: 1, exchanges }} turnState="completed" /></I18nProvider>);
    expand(container);
    expect(container.textContent).toContain("actor-key");
    expect(container.textContent).toContain(say("did not provide the new identity", "enthielt keine neue Identität"));
    expect(container.textContent).toContain(say("Created issue identities were not returned", "Neue Vorgangsidentitäten wurden nicht zurückgegeben"));
    expect(container.textContent).not.toContain("target-key");
    expect(container.querySelector("button, a, pre")).toBeNull();
  });
  it("preserves task owner and human-attestation limits after an unlock result reload", async () => {
    const selected = accountResourceCase("jira.unlock-user-anonymization");
    const progress = { userKey: "target-key", submittedTime: "native-submitted", status: "INTERRUPTED", operations: [], isRerun: false, currentProgress: 0, warnings: [] };
    const exchanges = [accountResourceExchange(selected, 0, { ...selected.receipt, outcome: "succeeded" }),
      configurationExchange("jira_anonymization_progress", { outcome: "succeeded", taskSelection: "active-or-latest", progress,
        reviewSnapshot: { ...progress, executingNode: "node-a", startTime: null, errors: null, warnings: [] } }, 1)];
    const transcript = JSON.parse(JSON.stringify({ schemaVersion: 1, exchanges })) as ChatToolTranscript;
    const view = <I18nProvider><JiraChatTools transcript={transcript} turnState="completed" /></I18nProvider>;
    const first = render(view); first.unmount(); const { container } = render(view); expand(container);
    expect(container.textContent).toContain("node-a");
    expect(container.textContent).toContain(say("human attestation, not native proof", "menschliche Auskunft, kein nativer Nachweis"));
    expect(container.textContent).toContain(say("Bound native anonymization task review available", "Gebundener nativer Prüfstand des Anonymisierungsauftrags verfügbar"));
    const card = screen.getByRole("group", { name: say("Request Jira anonymization unlock", "Entsperren der Jira-Anonymisierung anfordern") });
    expect(within(card).getByText(say("Jira accepted the change; confirmation incomplete", "Jira hat die Änderung angenommen; Bestätigung unvollständig"))).toBeVisible();
    expect(container.querySelector("a, img, pre, button")).toBeNull();
    expect(await axe(container)).toHaveNoViolations();
  });
  it("restores only saved matching project and issue browse links while retaining unconfirmed status", async () => {
    const project = accountResourceCase("jira.restore-project");
    const issue = accountResourceCase("jira.restore-issue");
    const projectUrl = "https://jira.example/jira/projects/SYN/summary";
    const issueUrl = "https://jira.example/jira/browse/SYN-1";
    const exchanges = [
      accountResourceExchange(project, 0, { ...project.receipt, outcome: "succeeded-unconfirmed", browseUrl: projectUrl }),
      accountResourceExchange(issue, 1, { ...issue.receipt, outcome: "succeeded-unconfirmed", browseUrl: issueUrl }),
    ];
    const transcript = JSON.parse(JSON.stringify({ schemaVersion: 1, exchanges })) as ChatToolTranscript;
    const view = <I18nProvider><JiraChatTools transcript={transcript} turnState="completed" /></I18nProvider>;
    const first = render(view); first.unmount(); const { container } = render(view); expand(container);
    expect(screen.getByRole("link", { name: /^SYN\s/u })).toHaveAttribute("href", projectUrl);
    expect(screen.getByRole("link", { name: /^SYN-1\s/u })).toHaveAttribute("href", issueUrl);
    for (const link of screen.getAllByRole("link")) expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.getAllByText(say("Jira accepted the change; confirmation incomplete", "Jira hat die Änderung angenommen; Bestätigung unvollständig"))).toHaveLength(2);
    expect(await axe(container)).toHaveNoViolations();
  });
});
