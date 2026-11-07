import { render, screen } from "@testing-library/react";
import { axe } from "jest-axe";
import { afterEach, describe, expect, it } from "vitest";
import type { ChatToolExchange, ChatToolTranscript } from "@oscharko-dev/keiko-contracts/bff-wire";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { I18N_STORAGE_KEY, I18nProvider, loadLocaleMessages } from "@/lib/i18n";
import { loadOptionalWidgetMessages } from "@/lib/optional-widget-i18n";
import { JiraChatTools } from "./JiraChatTools";

const PROJECT_ID = "9223372036854775807";
const PROJECT_URL = "https://jira.example.test/context/projects/SYN/summary";
const PROJECT = {
  projectId: PROJECT_ID,
  projectKey: "SYN",
  projectName: "Delivery workspace",
  browseUrl: PROJECT_URL,
};

function projectExchange(
  data: CatalogJsonObject,
  operation = "jira_create_project",
): ChatToolExchange {
  return {
    call: { id: "project-call", name: operation, arguments: {} },
    result: {
      schemaVersion: 1,
      invocationId: "project-invocation",
      toolRef: null,
      projectionDigest: null,
      effectStarted: operation === "jira_create_project" || operation === "jira_update_project",
      metrics: { inputBytes: 10, outputBytes: 10, resultCount: 1, durationMs: 20 },
      status: "completed",
      reason: "none",
      page: { truncated: false, reason: "none", cursor: null },
      data,
    },
  };
}

function show(exchange: ChatToolExchange): ReturnType<typeof render> {
  return render(
    <I18nProvider>
      <JiraChatTools
        transcript={{ schemaVersion: 1, exchanges: [exchange] }}
        turnState="completed"
      />
    </I18nProvider>,
  );
}

afterEach(() => localStorage.removeItem(I18N_STORAGE_KEY));

describe.each(["en", "de"] as const)("saved project results in %s (#4293)", (locale) => {
  it("keeps a denied project write actionable without a success claim or automatic retry", async () => {
    await Promise.all([loadLocaleMessages(locale), loadOptionalWidgetMessages(locale)]);
    localStorage.setItem(I18N_STORAGE_KEY, locale);
    const exchange = projectExchange({ outcome: "rejected", reason: "permission-denied" });
    const { container } = show({ ...exchange, mutationOutcome: "rejected" });
    expect(
      screen.getByText(locale === "en" ? "Jira action rejected" : "Jira-Aktion abgelehnt"),
    ).toBeVisible();
    expect(
      screen.getByText(
        locale === "en"
          ? "Check the Jira account's permission for the requested project and action."
          : "Prüfe die Berechtigung des Jira-Kontos für das angeforderte Projekt und die Aktion.",
      ),
    ).toBeVisible();
    expect(
      screen.queryByText(locale === "en" ? "Jira change confirmed" : "Jira-Änderung bestätigt"),
    ).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.queryByRole("button", { name: /retry|erneut/iu })).toBeNull();
    expect(container.querySelector("pre")).toBeNull();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("shows key validation, permission decisions and the project type without raw objects", async () => {
    await Promise.all([loadLocaleMessages(locale), loadOptionalWidgetMessages(locale)]);
    localStorage.setItem(I18N_STORAGE_KEY, locale);
    const exchanges = [
      projectExchange(
        { outcome: "succeeded", key: "FREE", valid: true },
        "jira_validate_project_key",
      ),
      projectExchange(
        { outcome: "succeeded", key: "TAKEN", valid: false },
        "jira_validate_project_key",
      ),
      projectExchange(
        {
          outcome: "succeeded",
          permissions: [
            { key: "ADMINISTER_PROJECTS", name: "Administer projects", havePermission: true },
            { key: "ADMINISTER", name: "Jira administration", havePermission: false },
          ],
        },
        "jira_project_permissions",
      ),
      projectExchange(
        { outcome: "succeeded", projectTypeKey: "software", name: "Software" },
        "jira_project_type",
      ),
    ].map((exchange, index) => ({
      ...exchange,
      call: { ...exchange.call, id: `read-${String(index)}` },
    }));
    const { container } = render(
      <I18nProvider>
        <JiraChatTools transcript={{ schemaVersion: 1, exchanges }} turnState="completed" />
      </I18nProvider>,
    );
    for (const name of ["FREE", "TAKEN", "Administer projects", "Jira administration", "Software"])
      expect(screen.getByText(name, { exact: true })).toBeVisible();
    const states =
      locale === "en"
        ? [
            "This project key is available.",
            "This project key cannot be used. Choose another key.",
            "Permission granted",
            "Permission not granted",
            "Returned results: 2.",
          ]
        : [
            "Dieser Projektschlüssel ist verfügbar.",
            "Dieser Projektschlüssel ist nicht verwendbar. Wähle einen anderen Schlüssel.",
            "Berechtigung erteilt",
            "Berechtigung nicht erteilt",
            "Zurückgegebene Ergebnisse: 2.",
          ];
    for (const state of states) expect(screen.getByText(state, { exact: true })).toBeVisible();
    expect(container.querySelector("pre")).toBeNull();
    expect(await axe(container)).toHaveNoViolations();
  });

  it.each(["jira_project", "jira_create_project", "jira_update_project"])(
    "keeps %s identity, name and trusted link after serialization without rounding its ID",
    async (operation) => {
      await Promise.all([loadLocaleMessages(locale), loadOptionalWidgetMessages(locale)]);
      localStorage.setItem(I18N_STORAGE_KEY, locale);
      const exchange = projectExchange({ outcome: "succeeded", ...PROJECT }, operation);
      const first = show(exchange);
      first.unmount();
      const restored = JSON.parse(
        JSON.stringify({ schemaVersion: 1, exchanges: [exchange] }),
      ) as ChatToolTranscript;
      const { container } = render(
        <I18nProvider>
          <JiraChatTools transcript={restored} turnState="completed" />
        </I18nProvider>,
      );
      expect(screen.getByText("Delivery workspace")).toBeVisible();
      expect(screen.getByRole("link", { name: /SYN/u })).toHaveAttribute("href", PROJECT_URL);
      expect(
        screen.getByText(`${locale === "en" ? "Project ID" : "Projekt-ID"}: ${PROJECT_ID}`),
      ).toBeVisible();
      expect(container.querySelector("pre")).toBeNull();
      expect(await axe(container)).toHaveNoViolations();
    },
  );

  it("keeps accepted project identity visible when readback is unconfirmed without offering a retry", async () => {
    await Promise.all([loadLocaleMessages(locale), loadOptionalWidgetMessages(locale)]);
    localStorage.setItem(I18N_STORAGE_KEY, locale);
    const exchange = projectExchange({ outcome: "succeeded-unconfirmed", ...PROJECT });
    show({ ...exchange, mutationOutcome: "succeeded-unconfirmed" });
    expect(
      screen.getByText(
        locale === "en"
          ? "Jira accepted the change; confirmation incomplete"
          : "Jira hat die Änderung angenommen; Bestätigung unvollständig",
      ),
    ).toBeVisible();
    expect(screen.getByRole("link", { name: /SYN/u })).toHaveAttribute("href", PROJECT_URL);
    expect(screen.queryByRole("button", { name: /retry|erneut/iu })).toBeNull();
  });
});

it.each([
  "javascript:alert(1)",
  "http://jira.example.test/projects/SYN/summary",
  "https://user:credential@jira.example.test/projects/SYN/summary",
  "https://jira.example.test/projects/OTHER/summary",
  "https://jira.example.test/projects/SYN/summary?token=private",
  "https://jira.example.test/projects/SYN/summary#private",
  "https://jira.example.test/rest/api/2/project/SYN",
  "https://jira.example.test/browse/SYN-1",
])("retains the project key without opening unsafe or non-project URL %s", (browseUrl) => {
  const { container } = show(projectExchange({ outcome: "succeeded", ...PROJECT, browseUrl }));
  expect(screen.getByText("SYN", { exact: true })).toBeVisible();
  expect(screen.queryByRole("link")).toBeNull();
  expect(container.querySelector("pre")).toBeNull();
});

it("never substitutes a project homepage or REST self URL for a missing saved browse link", () => {
  show(
    projectExchange({
      outcome: "succeeded",
      projectId: PROJECT_ID,
      projectKey: "SYN",
      projectName: "Delivery workspace",
      url: "https://homepage.example.test/projects/SYN/summary",
      self: "https://jira.example.test/rest/api/2/project/SYN",
    }),
  );
  expect(screen.getByText("SYN", { exact: true })).toBeVisible();
  expect(screen.queryByRole("link")).toBeNull();
});

it("keeps the saved instance and context when another project has the same key", () => {
  const otherUrl = "https://other-jira.example.test/another-context/projects/SYN/summary";
  show(projectExchange({ outcome: "succeeded", ...PROJECT, browseUrl: otherUrl }));
  expect(screen.getByRole("link", { name: /SYN/u })).toHaveAttribute("href", otherUrl);
});
