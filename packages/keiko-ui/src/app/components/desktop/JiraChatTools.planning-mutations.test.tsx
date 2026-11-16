import { say } from "./jira-result.test-fixture";
import { buttonsOutsideProgress } from "./jira-result.test-fixture";
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
  it.each(PLANNING_CASES)(
    "shows exact reviewed and target facts for $operation",
    async ({ operation, args }) => {
      const approval: ChatToolWriteApprovalView = {
        kind: "jira-chat-write",
        approvalId: "planning-approval",
        chatId: "chat-1",
        podId: "11111111-1111-4111-8111-111111111111",
        bindingGeneration: 1,
        authenticationGeneration: 1,
        invocationId: "planning-action",
        operation,
        actionDigest: "b".repeat(64),
        requestedAt: Date.now(),
        expiresAt: Date.now() + 60000,
        state: "pending",
      };
      const { container } = render(
        <I18nProvider>
          <JiraWriteApproval
            approval={approval}
            call={{
              id: "planning-action",
              name: operation.replace(/[.-]/gu, "_"),
              arguments: args,
            }}
            turnState="pending"
            observe={vi.fn().mockResolvedValue(approval)}
            decide={vi.fn()}
          />
        </I18nProvider>,
      );
      const region = screen.getByRole("region", {
        name: say(locale, "Review Jira action", "Jira-Aktion prüfen"),
      });
      expect(
        await screen.findByRole("button", {
          name: say(locale, "Approve this action", "Diese Aktion genehmigen"),
        }),
      ).toBeVisible();
      expect(region.textContent).toContain("actor-key");
      expect(region.textContent).not.toMatch(
        /expectedActorKey|expectedLinks|expectedVersionSnapshot|expectedCategory|rankCustomFieldId|valueNodes/u,
      );
      expect(region.querySelector("pre, textarea, details, a, img")).toBeNull();
      if ("expectedLinks" in args) {
        expect(region.textContent).toContain("Reviewed release");
        expect(region.textContent).toContain("9007199254740993");
        expect(region.textContent).toContain(say(locale, "Value: JSON null", "Wert: JSON-null"));
        expect(region.textContent).toContain(say(locale, "Value: empty text", "Wert: leerer Text"));
        expect(region.textContent).toContain("/a~1b");
      }
      if (operation === "jira.set-issue-estimation") {
        expect(region.textContent).toContain(say(locale, "Minutes", "Minuten"));
        expect(region.textContent).toContain(
          say(locale, "does not request clearing", "fordert keine Löschung an"),
        );
      }
      if (operation.includes("project-category"))
        expect(region.textContent).toContain(
          say(
            locale,
            "explicit Jira administration grant",
            "ausdrückliche Jira-Administrationsfreigabe",
          ),
        );
      if (operation === "jira.epic-remove-issues")
        expect(region.textContent).toContain(
          say(locale, "Explicitly observed without an epic", "Ausdrücklich ohne Epic beobachtet"),
        );
      if (
        operation === "jira.rank-issues" ||
        operation === "jira.upsert-version-remote-link-by-global-id"
      )
        expect(await axe(container)).toHaveNoViolations();
    },
  );
  it("restores every receipt without replay and gives uncertainty precedence over stale data", async () => {
    const exchanges = PLANNING_CASES.map(({ operation, receipt }, index) =>
      configurationExchange(
        operation.replace(/[.-]/gu, "_"),
        { ...receipt, browseUrl: "https://untrusted.invalid/target" },
        index,
        operation === "jira.set-issue-estimation" ? "unknown" : undefined,
      ),
    );
    const transcript = JSON.parse(
      JSON.stringify({ schemaVersion: 1, exchanges }),
    ) as ChatToolTranscript;
    const view = (
      <I18nProvider>
        <JiraChatTools transcript={transcript} turnState="completed" />
      </I18nProvider>
    );
    const initial = render(view);
    const originalText = initial.container.textContent;
    initial.unmount();
    const { container } = render(view);
    expect(container.textContent).toBe(originalText);
    for (const summary of container.querySelectorAll("details > summary")) fireEvent.click(summary);
    expect(screen.getAllByRole("group")).toHaveLength(11);
    const estimate = screen.getByRole("group", {
      name: say(locale, "Set Jira issue estimate", "Jira-Vorgang schätzen"),
    });
    expect(
      within(estimate).getByText(
        say(locale, "Jira outcome unknown", "Ausgang der Jira-Aktion unbekannt"),
      ),
    ).toBeVisible();
    expect(estimate.textContent).toContain(
      say(locale, "Native verification unit: seconds", "Native Verifikationseinheit: Sekunden"),
    );
    expect(estimate.textContent).toContain(
      say(locale, "Requested estimate", "Angeforderter Schätzwert"),
    );
    expect(estimate.textContent).not.toContain(
      say(locale, "Independently confirmed estimate", "Unabhängig bestätigter Schätzwert"),
    );
    expect(container.textContent).toContain(
      say(
        locale,
        "Ranking remains unconfirmed",
        "Die Einordnung bleibt nach Empfangsbestätigung unbestätigt",
      ),
    );
    expect(container.textContent).toContain(
      say(
        locale,
        "Category deletion remains unconfirmed",
        "Die Kategorienlöschung bleibt nach Empfangsbestätigung unbestätigt",
      ),
    );
    expect(container.textContent).not.toContain("untrusted.invalid");
    expect(container.querySelector("pre, a, img")).toBeNull();
    expect(buttonsOutsideProgress(container)).toEqual([]);
    expect(await axe(container)).toHaveNoViolations();
  });
  it("keeps legacy unavailable link identity separate from actual typed value facts after reload", async () => {
    const result = configurationExchange("jira_version_remote_links", {
      outcome: "succeeded",
      versionId: "9007199254740993",
      items: [
        { name: "Unbound legacy link", valueAvailable: true, valueNodes: PLANNING_VALUE },
        {
          name: "Bound link",
          reviewIdentityAvailable: true,
          globalId: "reviewed-link",
          valueAvailable: false,
        },
      ],
    });
    const transcript = JSON.parse(
      JSON.stringify({ schemaVersion: 1, exchanges: [result] }),
    ) as ChatToolTranscript;
    const { container } = render(
      <I18nProvider>
        <JiraChatTools transcript={transcript} turnState="completed" />
      </I18nProvider>,
    );
    for (const summary of container.querySelectorAll("details > summary")) fireEvent.click(summary);
    expect(container.textContent).toContain(
      say(locale, "Native global ID unavailable", "Native globale ID nicht verfügbar"),
    );
    expect(container.textContent).toContain("reviewed-link");
    expect(container.textContent).toContain(
      say(
        locale,
        "This row has a bound native global ID",
        "Diese Zeile hat eine gebundene native globale ID",
      ),
    );
    expect(container.querySelector("pre, a, img")).toBeNull();
    expect(buttonsOutsideProgress(container)).toEqual([]);
    expect(await axe(container)).toHaveNoViolations();
  });
});
