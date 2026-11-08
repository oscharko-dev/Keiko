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
import {
  ADMINISTRATIVE_MUTATION_CASES,
  ADMINISTRATIVE_DIGEST,
  administrativeExchange,
  REVIEWED_ISSUE_TYPE_SCHEME,
  REVIEWED_PRIORITY_SCHEME,
  REVIEWED_WORKFLOW_SCHEME,
  REVIEWED_WORKFLOW_DRAFT,
} from "./jira-administrative-mutation.test-fixture";

function expand(container: HTMLElement): void {
  for (const summary of container.querySelectorAll("details > summary")) fireEvent.click(summary);
}
afterEach(() => localStorage.removeItem(I18N_STORAGE_KEY));
describe.each(["en", "de"] as const)(
  "scheme, instance and email administration in %s",
  (locale) => {
    const say = (english: string, german: string): string => (locale === "en" ? english : german);
    beforeEach(async () => {
      await Promise.all([loadLocaleMessages(locale), loadOptionalWidgetMessages(locale)]);
      localStorage.setItem(I18N_STORAGE_KEY, locale);
    });
    it.each(ADMINISTRATIVE_MUTATION_CASES)(
      "renders exact reviewed arguments for $operation",
      async ({ operation, args }) => {
        const approval: ChatToolWriteApprovalView = {
          kind: "jira-chat-write",
          approvalId: "admin-approval",
          chatId: "chat-1",
          podId: "11111111-1111-4111-8111-111111111111",
          bindingGeneration: 1,
          authenticationGeneration: 1,
          invocationId: "admin-action",
          operation,
          actionDigest: "a".repeat(64),
          requestedAt: Date.now(),
          expiresAt: Date.now() + 60000,
          state: "pending",
        };
        const { container } = render(
          <I18nProvider>
            <JiraWriteApproval
              approval={approval}
              call={{ id: "admin-action", name: operation.replace(/[.-]/gu, "_"), arguments: args }}
              turnState="pending"
              observe={vi.fn().mockResolvedValue(approval)}
              decide={vi.fn()}
            />
          </I18nProvider>,
        );
        await screen.findByRole("button", {
          name: say("Approve this action", "Diese Aktion genehmigen"),
        });
        const review = screen.getByRole("region", {
          name: say("Review Jira action", "Jira-Aktion prüfen"),
        });
        expect(review.textContent).toContain("actor-key");
        expect(review.textContent).toContain(
          say("explicit Jira administration grant", "ausdrückliche Jira-Administrationsfreigabe"),
        );
        expect(review.textContent).not.toMatch(
          /expectedScheme|expectedDraft|expectedActorKey|expectedActiveManifestSha256|expectedFile|confirmUnverifiedConsequences/u,
        );
        expect(review.querySelector("pre, textarea, a, img")).toBeNull();
        if (operation === "jira.set-issue-type-scheme-projects") {
          expect(review.textContent).toContain(
            say("complete project association set", "vollständige Projektzuordnung"),
          );
          expect(review.textContent).toContain(
            say("Explicit empty list (0 entries)", "Ausdrücklich leere Liste (0 Einträge)"),
          );
        }
        if (operation === "jira.update-workflow-scheme-draft") {
          expect(review.textContent).toContain(
            say("Native metadata not provided (null)", "Native Metadaten nicht angegeben (null)"),
          );
          expect(review.textContent).toContain(
            say("Remove the configured default", "Konfigurierten Standard entfernen"),
          );
          expect(review.textContent).toContain(say("empty list clears", "leere Liste entfernt"));
        }
        if (operation === "jira.upload-email-template-pack") {
          expect(review.textContent).toContain("templates.zip");
          expect(review.textContent).toContain(ADMINISTRATIVE_DIGEST);
          expect(review.textContent).toContain(
            say("existing approval rules", "bestehenden Freigaberegeln"),
          );
        }
        if (operation === "jira.set-system-columns")
          expect(review.textContent).toContain(say("repeated IDs", "wiederholte IDs"));
        if (operation === "jira.set-read-only-mode")
          expect(review.textContent).toContain(say("not proof", "kein Beweis"));
        if (
          operation === "jira.update-workflow-scheme-draft" ||
          operation === "jira.upload-email-template-pack"
        )
          expect(await axe(container)).toHaveNoViolations();
      },
    );
    it("retains all thirty-five results after reload with no replay or inferred global consequences", async () => {
      const exchanges = ADMINISTRATIVE_MUTATION_CASES.map((fixture, index) =>
        administrativeExchange(
          fixture,
          {
            ...fixture.receipt,
            outcome: "succeeded",
            browseUrl: "https://untrusted.invalid/destination",
          },
          index,
          fixture.operation === "jira.set-read-only-mode" ? "unknown" : undefined,
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
      const before = initial.container.textContent;
      initial.unmount();
      const restored = render(view);
      expect(restored.container.textContent).toBe(before);
      expand(restored.container);
      expect(screen.getAllByRole("group")).toHaveLength(35);
      const replacement = screen.getByRole("group", {
        name: say("Replace Jira scheme projects", "Jira-Schemaprojekte ersetzen"),
      });
      expect(
        within(replacement).getByText(
          say(
            "Jira accepted the change; confirmation incomplete",
            "Jira hat die Änderung angenommen; Bestätigung unvollständig",
          ),
        ),
      ).toBeVisible();
      expect(replacement.textContent).toContain(
        say("Reviewed or requested project count", "Anzahl geprüfter oder angeforderter Projekte"),
      );
      const readOnly = screen.getByRole("group", {
        name: say("Set Jira read-only configuration", "Jira-Schreibschutzkonfiguration setzen"),
      });
      expect(
        within(readOnly).getByText(
          say("Jira outcome unknown", "Ausgang der Jira-Aktion unbekannt"),
        ),
      ).toBeVisible();
      expect(readOnly.textContent).toContain("false");
      expect(readOnly.textContent).not.toContain(
        say("Independently observed read-only", "Unabhängig beobachtetes Schreibschutz"),
      );
      const applied = screen.getByRole("group", {
        name: say(
          "Apply Jira staged email templates",
          "Bereitgestellte Jira-E-Mail-Vorlagen anwenden",
        ),
      });
      expect(applied.textContent).toContain(
        say("No email delivery is claimed", "Es wird keine E-Mail-Zustellung behauptet"),
      );
      expect(
        within(applied).getByText(
          say(
            "Jira accepted the change; confirmation incomplete",
            "Jira hat die Änderung angenommen; Bestätigung unvollständig",
          ),
        ),
      ).toBeVisible();
      expect(restored.container.textContent).toContain("9007199254740993");
      expect(restored.container.textContent).not.toContain("untrusted.invalid");
      expect(restored.container.querySelector("pre, a, img")).toBeNull();
      expect(buttonsOutsideProgress(restored.container)).toEqual([]);
      expect(await axe(restored.container)).toHaveNoViolations();
    });
    it("retains null, empty, false and original scheme review facts separately from missing snapshots", async () => {
      const exchanges = [
        configurationExchange("jira_issue_type_scheme", {
          items: [
            {
              ...REVIEWED_ISSUE_TYPE_SCHEME,
              reviewSnapshotAvailable: true,
              reviewSnapshot: REVIEWED_ISSUE_TYPE_SCHEME,
            },
          ],
        }),
        configurationExchange(
          "jira_priority_scheme",
          {
            ...REVIEWED_PRIORITY_SCHEME,
            reviewSnapshotAvailable: true,
            reviewSnapshot: REVIEWED_PRIORITY_SCHEME,
          },
          1,
        ),
        configurationExchange(
          "jira_workflow_scheme",
          { ...REVIEWED_WORKFLOW_SCHEME, reviewSnapshot: REVIEWED_WORKFLOW_SCHEME, items: [] },
          2,
        ),
        configurationExchange(
          "jira_workflow_scheme_draft",
          {
            ...REVIEWED_WORKFLOW_DRAFT,
            schemeId: "7",
            reviewSnapshot: REVIEWED_WORKFLOW_DRAFT,
            items: [],
          },
          3,
        ),
        configurationExchange(
          "jira_issue_type_scheme",
          { items: [{ id: "10", name: "Legacy scheme", reviewSnapshotAvailable: false }] },
          4,
        ),
      ];
      const transcript = JSON.parse(
        JSON.stringify({ schemaVersion: 1, exchanges }),
      ) as ChatToolTranscript;
      const { container } = render(
        <I18nProvider>
          <JiraChatTools transcript={transcript} turnState="completed" />
        </I18nProvider>,
      );
      expand(container);
      expect(container.textContent).toContain(
        say(
          "Complete native scheme review snapshot available",
          "Vollständiger nativer Schemaprüfstand verfügbar",
        ),
      );
      expect(container.textContent).toContain(
        say(
          "Complete native scheme review snapshot unavailable",
          "Vollständiger nativer Schemaprüfstand nicht verfügbar",
        ),
      );
      expect(container.textContent).toContain(
        say("Native metadata not provided (null)", "Native Metadaten nicht angegeben (null)"),
      );
      expect(container.textContent).toContain(say("Value: empty text", "Wert: leerer Text"));
      expect(container.textContent).toContain(
        say(
          "Complete original issue type mappings",
          "Vollständige ursprüngliche Vorgangstypzuordnungen",
        ),
      );
      expect(container.textContent).toContain("false");
      expect(container.textContent).not.toContain(
        say("Published scheme", "Veröffentlichtes Schema"),
      );
      expect(container.querySelector("pre, a")).toBeNull();
      expect(buttonsOutsideProgress(container)).toEqual([]);
      expect(await axe(container)).toHaveNoViolations();
    });
    it("shows complete archive metadata and comparison-only base URL without contents or navigation", async () => {
      const archive = {
        selectionScope: "complete-exported-email-template-pack",
        archiveBytes: 128,
        archiveSha256: ADMINISTRATIVE_DIGEST,
        manifestSha256: "b".repeat(64),
        entryCount: 1,
        items: [{ path: "templates/notification.vm", sizeBytes: 0, sha256: "c".repeat(64) }],
      };
      const exchanges = [
        configurationExchange("jira_email_template_pack", archive),
        configurationExchange(
          "jira_email_template_pack",
          { selectionScope: "complete-exported-email-template-pack" },
          1,
        ),
        configurationExchange(
          "jira_server_info",
          {
            version: "11.3.0",
            configuredBaseUrlState: "observed",
            configuredBaseUrl: "http://comparison.invalid/jira",
          },
          2,
        ),
        configurationExchange(
          "jira_server_info",
          {
            version: "11.3.0",
            configuredBaseUrlState: "unavailable",
            configuredBaseUrl: "https://stale.invalid",
          },
          3,
        ),
      ];
      const transcript = JSON.parse(
        JSON.stringify({ schemaVersion: 1, exchanges }),
      ) as ChatToolTranscript;
      const { container } = render(
        <I18nProvider>
          <JiraChatTools transcript={transcript} turnState="completed" />
        </I18nProvider>,
      );
      expand(container);
      expect(container.textContent).toContain("templates/notification.vm");
      expect(container.textContent).toContain(
        say("Raw ZIP SHA-256", "SHA-256 der rohen ZIP-Datei"),
      );
      expect(container.textContent).toContain(
        say(
          "Complete archive metadata unavailable",
          "Vollständige Archivmetadaten nicht verfügbar",
        ),
      );
      expect(container.textContent).toContain("http://comparison.invalid/jira");
      expect(container.textContent).not.toContain("stale.invalid");
      expect(container.querySelector("pre, a, img")).toBeNull();
      expect(buttonsOutsideProgress(container)).toEqual([]);
      expect(await axe(container)).toHaveNoViolations();
    });
  },
);
