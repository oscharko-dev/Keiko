import { render, screen } from "@testing-library/react";
import { axe } from "jest-axe";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChatToolExchange, ChatToolTranscript } from "@oscharko-dev/keiko-contracts/bff-wire";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { JIRA_MUTATION_OPERATIONS } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
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
      effectStarted: JIRA_MUTATION_OPERATIONS.some(
        (name) => name.replace(/[.-]/gu, "_") === operation,
      ),
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

describe.each(["en", "de"] as const)("changed source requirements in %s", (locale) => {
  beforeEach(async () => {
    await Promise.all([loadLocaleMessages(locale), loadOptionalWidgetMessages(locale)]);
    localStorage.setItem(I18N_STORAGE_KEY, locale);
  });
  it("restores actionable source-change guidance from the real pre-approval refusal shape", () => {
    const data = {
      outcome: "rejected",
      reason: "field-validation",
      requirementRefusal: "source-changed",
    };
    const receipt = projectExchange(data, "jira_draft");
    if (receipt.result?.status !== "completed") throw new Error("Missing source-refusal fixture");
    const rejected: ChatToolExchange = {
      ...receipt,
      result: {
        ...receipt.result,
        effectStarted: false,
        status: "failed",
        reason: "provider-reported-error",
        page: null,
        data,
      },
    };
    const restored = JSON.parse(JSON.stringify(rejected)) as ChatToolExchange;
    const { container } = show(restored);
    expect(
      screen.getByText(
        locale === "en"
          ? "The source requirements changed. Read them again and prepare the draft again. No change was made in Jira."
          : "Die Quellanforderungen haben sich geändert. Lies sie erneut und bereite den Entwurf neu vor. In Jira wurde nichts geändert.",
      ),
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: /retry|wiederholen/iu })).toBeNull();
    expect(container.querySelector("pre")).toBeNull();
  });
});

describe.each(["en", "de"] as const)("explicit unchanged receipts in %s", (locale) => {
  beforeEach(async () => {
    await Promise.all([loadLocaleMessages(locale), loadOptionalWidgetMessages(locale)]);
    localStorage.setItem(I18N_STORAGE_KEY, locale);
  });
  it("restores an explicit no-change observation without presenting rejection or inventing success", () => {
    const data = {
      outcome: "rejected",
      reason: "conflict",
      unchanged: true,
      issueKey: "SYN-7",
      commentId: "91",
    };
    const receipt = projectExchange(data, "jira_update_comment");
    if (receipt.result?.status !== "completed") throw new Error("Missing unchanged fixture result");
    const rejected: ChatToolExchange = {
      ...receipt,
      mutationOutcome: "rejected",
      result: {
        ...receipt.result,
        effectStarted: false,
        status: "failed",
        reason: "provider-reported-error",
        page: null,
        data,
      },
    };
    const stored = JSON.parse(JSON.stringify(rejected)) as ChatToolExchange;
    show(stored);
    expect(
      screen.getByText(locale === "en" ? "Already up to date" : "Bereits aktuell"),
    ).toBeVisible();
    expect(
      screen.getByText(
        locale === "en"
          ? "The requested values already match Jira. No change was made."
          : "Die gewünschten Werte stimmen bereits mit Jira überein. Es wurde nichts geändert.",
      ),
    ).toBeVisible();
    expect(
      screen.queryByText(locale === "en" ? "Jira action rejected" : "Jira-Aktion abgelehnt"),
    ).toBeNull();
    expect(screen.queryByText(/The Jira state changed|Der Jira-Stand hat sich/u)).toBeNull();
    expect(stored.result?.data).toMatchObject({ outcome: "rejected" });
  });
  it.each([
    { outcome: "rejected", reason: "conflict" },
    { outcome: "rejected", reason: "permission-denied", unchanged: true },
    { outcome: "unknown", reason: "conflict", unchanged: true },
  ])("keeps other conflicts, refusals and unknown outcomes actionable", (data) => {
    show(projectExchange(data, "jira_update_comment"));
    expect(
      screen.queryByText(locale === "en" ? "Already up to date" : "Bereits aktuell"),
    ).toBeNull();
  });
  it("keeps an unknown journal outcome authoritative over a contradictory unchanged payload", () => {
    show({
      ...projectExchange(
        { outcome: "rejected", reason: "conflict", unchanged: true },
        "jira_update_comment",
      ),
      mutationOutcome: "unknown",
    });
    expect(
      screen.queryByText(locale === "en" ? "Already up to date" : "Bereits aktuell"),
    ).toBeNull();
    expect(
      screen.getByText(
        locale === "en" ? "Jira outcome unknown" : "Ausgang der Jira-Aktion unbekannt",
      ),
    ).toBeVisible();
  });
});

describe.each(["en", "de"] as const)(
  "saved views and sharing observations in %s (C7)",
  (locale) => {
    beforeEach(async () => {
      await Promise.all([loadLocaleMessages(locale), loadOptionalWidgetMessages(locale)]);
      localStorage.setItem(I18N_STORAGE_KEY, locale);
    });
    it("restores dashboard identities and configured share facts accessibly without remote links or JSON", async () => {
      const exchanges = [
        projectExchange(
          {
            outcome: "succeeded",
            startAt: 0,
            total: 1,
            items: [
              {
                id: "9007199254740993",
                name: "Delivery dashboard",
                view: "https://untrusted.invalid/dashboard",
                browseUrl: "https://untrusted.invalid/browse/SYN-7",
                issueKey: "SYN-7",
              },
            ],
          },
          "jira_dashboards",
        ),
        projectExchange(
          {
            outcome: "succeeded",
            filterId: "700",
            items: [
              { id: "91", type: "group", groupName: "Delivery group", edit: false, view: true },
              { id: "92", type: "future-share", roleId: "5", roleName: "Developers" },
            ],
          },
          "jira_filter_permissions",
        ),
        projectExchange({ outcome: "succeeded", scope: "PRIVATE" }, "jira_filter_share_scope"),
      ].map((exchange, index) => ({
        ...exchange,
        call: { ...exchange.call, id: `saved-view-${String(index)}` },
      }));
      const transcript = { schemaVersion: 1 as const, exchanges };
      const initial = render(
        <I18nProvider>
          <JiraChatTools transcript={transcript} turnState="completed" />
        </I18nProvider>,
      );
      expect(screen.getByText("Delivery dashboard")).toBeVisible();
      initial.unmount();
      const restored = JSON.parse(JSON.stringify(transcript)) as ChatToolTranscript;
      const { container } = render(
        <I18nProvider>
          <JiraChatTools transcript={restored} turnState="completed" />
        </I18nProvider>,
      );
      for (const value of locale === "en"
        ? [
            "Dashboard ID: 9007199254740993",
            "Group: Delivery group",
            "Role: Developers",
            "Share type: future-share",
            "Entry does not grant editing",
            "Entry grants viewing",
            "Default sharing: private",
          ]
        : [
            "Dashboard-ID: 9007199254740993",
            "Gruppe: Delivery group",
            "Rolle: Developers",
            "Freigabetyp: future-share",
            "Eintrag erlaubt kein Bearbeiten",
            "Eintrag erlaubt Anzeigen",
            "Standardfreigabe: privat",
          ])
        expect(screen.getByText(value, { exact: true })).toBeVisible();
      expect(
        screen.getAllByText(
          locale === "en" ? "Saved filter ID: 700" : "Gespeicherte Filter-ID: 700",
        ),
      ).toHaveLength(2);
      expect(
        screen.getByText(
          locale === "en"
            ? "This is the default for future filters, not the sharing state of an existing filter."
            : "Dies ist die Voreinstellung für künftige Filter, nicht der Freigabestatus eines vorhandenen Filters.",
        ),
      ).toBeVisible();
      expect(screen.queryByRole("link")).toBeNull();
      expect(container.querySelector("pre, details")).toBeNull();
      expect(
        screen.getByRole("group", {
          name: locale === "en" ? "Read Jira dashboards" : "Jira-Dashboards lesen",
        }),
      ).toBeVisible();
      expect(
        screen.getByRole("group", {
          name:
            locale === "en"
              ? "Read Jira filter share entries"
              : "Jira-Filter-Freigabeeinträge lesen",
        }),
      ).toBeVisible();
      expect(await axe(container)).toHaveNoViolations();
    });
    it("does not infer missing permission flags or private sharing from an empty list", () => {
      show(
        projectExchange(
          { outcome: "succeeded", filterId: "700", items: [], startAt: 0, total: 0 },
          "jira_filter_permissions",
        ),
      );
      expect(
        screen.getByText(locale === "en" ? "Saved filter ID: 700" : "Gespeicherte Filter-ID: 700"),
      ).toBeVisible();
      expect(
        screen.queryByText(
          /Entry grants|Entry does not grant|Default sharing|Eintrag erlaubt|Standardfreigabe/u,
        ),
      ).toBeNull();
    });
    it("keeps numeric native continuation visible as a partial dashboard result", () => {
      show(
        projectExchange(
          {
            outcome: "succeeded",
            items: [{ id: "17", name: "Next dashboard" }],
            startAt: 1,
            total: 3,
            nextStartAt: 2,
          },
          "jira_dashboards",
        ),
      );
      expect(
        screen.getByText(
          locale === "en"
            ? "Partial Jira result. Some available data is not included."
            : "Jira-Teilergebnis. Nicht alle verfügbaren Daten sind enthalten.",
        ),
      ).toBeVisible();
    });
  },
);

describe.each(["en", "de"] as const)("saved collaboration facts in %s (#4298)", (locale) => {
  beforeEach(async () => {
    await Promise.all([loadLocaleMessages(locale), loadOptionalWidgetMessages(locale)]);
    localStorage.setItem(I18N_STORAGE_KEY, locale);
  });
  it("restores comments and distinct worklogs for the same issue with named facts and accessible links", async () => {
    const exchanges = [
      projectExchange(
        {
          outcome: "succeeded",
          browseUrl: "https://jira.example.test/context/browse/SYN-7",
          items: [
            {
              id: "9007199254740993",
              issueKey: "SYN-7",
              body: "Updated native comment",
              authorDisplayName: "Comment owner",
              visibility: { type: "role", value: "Developers" },
            },
          ],
        },
        "jira_get_comment",
      ),
      projectExchange(
        {
          outcome: "succeeded",
          issueKey: "SYN-7",
          items: [
            { id: "22", issueKey: "SYN-7", comment: "First work entry", timeSpentSeconds: 0 },
            { id: "23", issueKey: "SYN-7", comment: "Second work entry", timeSpentSeconds: 1800 },
          ],
          startAt: 0,
          total: 2,
        },
        "jira_worklogs",
      ),
      projectExchange(
        {
          outcome: "succeeded",
          items: [
            {
              id: "30",
              name: "Blocks",
              inward: "is blocked by",
              outward: "blocks",
              inwardIssueKey: "SYN-7",
              outwardIssueKey: "SYN-8",
            },
          ],
        },
        "jira_issue_link",
      ),
    ].map((exchange, index) => ({
      ...exchange,
      call: { ...exchange.call, id: `collaboration-${String(index)}` },
    }));
    const transcript = { schemaVersion: 1 as const, exchanges };
    const first = render(
      <I18nProvider>
        <JiraChatTools transcript={transcript} turnState="completed" />
      </I18nProvider>,
    );
    expect(screen.getByText("Updated native comment")).toBeVisible();
    first.unmount();
    const restored = JSON.parse(JSON.stringify(transcript)) as ChatToolTranscript;
    const { container } = render(
      <I18nProvider>
        <JiraChatTools transcript={restored} turnState="completed" />
      </I18nProvider>,
    );
    for (const value of [
      "Updated native comment",
      "First work entry",
      "Second work entry",
      "Blocks",
    ])
      expect(screen.getByText(value, { exact: true })).toBeVisible();
    expect(
      screen.getByText(
        locale === "en" ? "Comment ID: 9007199254740993" : "Kommentar-ID: 9007199254740993",
      ),
    ).toBeVisible();
    expect(
      screen.getByText(
        locale === "en" ? "Visible to role: Developers" : "Sichtbar für Rolle: Developers",
      ),
    ).toBeVisible();
    expect(
      screen.getByText(locale === "en" ? "Time spent (seconds): 0" : "Zeitaufwand (Sekunden): 0"),
    ).toBeVisible();
    expect(
      screen.getByText(
        locale === "en" ? "Time spent (seconds): 1800" : "Zeitaufwand (Sekunden): 1800",
      ),
    ).toBeVisible();
    expect(
      screen.getByText(locale === "en" ? "Outward issue: SYN-8" : "Ausgehender Vorgang: SYN-8"),
    ).toBeVisible();
    expect(screen.getByRole("link", { name: /SYN-7/u })).toHaveAttribute(
      "href",
      "https://jira.example.test/context/browse/SYN-7",
    );
    expect(container.querySelector("pre, details")).toBeNull();
    expect(await axe(container)).toHaveNoViolations();
  });
  it("does not invent effort or visibility and preserves a partial native page notice", () => {
    show(
      projectExchange(
        {
          outcome: "succeeded",
          items: [{ id: "24", issueKey: "SYN-7", comment: "Unmeasured entry" }],
          startAt: 1,
          total: 3,
          nextStartAt: 2,
        },
        "jira_worklogs",
      ),
    );
    expect(screen.getByText("Unmeasured entry")).toBeVisible();
    expect(screen.queryByText(/Time spent|Zeitaufwand|Visible to|Sichtbar für/u)).toBeNull();
    expect(
      screen.getByText(
        locale === "en"
          ? "Partial Jira result. Some available data is not included."
          : "Jira-Teilergebnis. Nicht alle verfügbaren Daten sind enthalten.",
      ),
    ).toBeVisible();
  });
  it("keeps an unknown comment mutation distinct from confirmed success", () => {
    show(
      projectExchange(
        { outcome: "unknown", ...{ issueKey: "SYN-7", commentId: "91" } },
        "jira_update_comment",
      ),
    );
    expect(screen.getByText(locale === "en" ? "Comment ID: 91" : "Kommentar-ID: 91")).toBeVisible();
    expect(
      screen.getByText(
        locale === "en" ? "Jira outcome unknown" : "Ausgang der Jira-Aktion unbekannt",
      ),
    ).toBeVisible();
  });
});

describe("server-minted board read links", () => {
  beforeEach(async () => {
    await Promise.all([loadLocaleMessages("en"), loadOptionalWidgetMessages("en")]);
  });
  it("keeps the saved context and exact board identity", () => {
    show(
      projectExchange(
        {
          outcome: "succeeded",
          items: [
            {
              id: "17",
              name: "Delivery board",
              type: "scrum",
              browseUrl: "https://jira.example.test/context/secure/RapidBoard.jspa?rapidView=17",
            },
          ],
        },
        "jira_board",
      ),
    );
    expect(screen.getByRole("link", { name: /Delivery board/u })).toHaveAttribute(
      "href",
      "https://jira.example.test/context/secure/RapidBoard.jspa?rapidView=17",
    );
  });
  it("does not use an issue URL as a fallback destination for a board", () => {
    show(
      projectExchange(
        {
          outcome: "succeeded",
          items: [
            {
              id: "17",
              name: "Delivery board",
              issueKey: "SYN-7",
              browseUrl: "https://jira.example.test/context/browse/SYN-7",
            },
          ],
        },
        "jira_board",
      ),
    );
    expect(screen.getByText("Delivery board")).toBeVisible();
    expect(screen.queryByRole("link")).toBeNull();
  });
  it.each([
    "not a URL",
    "https://jira.example.test/context/secure/RapidBoard.jspa?rapidView=18",
    "https://jira.example.test/context/secure/RapidBoard.jspa?rapidView=17&rapidView=17",
    "https://jira.example.test/context/secure/RapidBoard.jspa?rapidView=17&other=1",
    "https://jira.example.test/context/secure/RapidBoard.jspa?rapidView=17#fragment",
    "https://secret@jira.example.test/context/secure/RapidBoard.jspa?rapidView=17",
    "http://jira.example.test/context/secure/RapidBoard.jspa?rapidView=17",
    "https://jira.example.test/context/projects/SYN/summary?rapidView=17",
  ])("refuses a URL that does not preserve the exact trusted board route", (browseUrl) => {
    show(
      projectExchange(
        { outcome: "succeeded", items: [{ id: "17", name: "Delivery board", browseUrl }] },
        "jira_board",
      ),
    );
    expect(screen.getByText("Delivery board")).toBeVisible();
    expect(screen.queryByRole("link")).toBeNull();
  });
});

describe.each(["en", "de"] as const)(
  "saved version and component results in %s (#4297)",
  (locale) => {
    beforeEach(async () => {
      await Promise.all([loadLocaleMessages(locale), loadOptionalWidgetMessages(locale)]);
      localStorage.setItem(I18N_STORAGE_KEY, locale);
    });
    it("restores distinct entity IDs, names, states and calendar dates accessibly without URLs or JSON", async () => {
      const exchanges = [
        projectExchange(
          {
            outcome: "succeeded",
            versionId: "9223372036854775807",
            projectId: "10000",
            name: "Delivery release",
            released: true,
            archived: false,
            startDate: "2028-02-29",
            releaseDate: "2028-03-01",
            browseUrl: "https://jira.example.test/browse/SYN-7",
            issueKey: "SYN-7",
          },
          "jira_version",
        ),
        projectExchange(
          {
            outcome: "succeeded",
            items: [
              {
                id: "12001",
                name: "Delivery component",
                project: "SYN",
                leadUserName: "component-owner",
                assigneeType: "COMPONENT_LEAD",
                archived: true,
                self: "https://untrusted.invalid",
              },
            ],
          },
          "jira_components",
        ),
      ].map((entry, index) => ({
        ...entry,
        call: { ...entry.call, id: `metadata-${String(index)}` },
      }));
      const transcript = { schemaVersion: 1 as const, exchanges };
      const first = render(
        <I18nProvider>
          <JiraChatTools transcript={transcript} turnState="completed" />
        </I18nProvider>,
      );
      expect(screen.getByText("Delivery release", { exact: true })).toBeVisible();
      first.unmount();
      const restored = JSON.parse(JSON.stringify(transcript)) as ChatToolTranscript;
      const { container } = render(
        <I18nProvider>
          <JiraChatTools transcript={restored} turnState="completed" />
        </I18nProvider>,
      );
      for (const value of ["Delivery release", "Delivery component"])
        expect(screen.getByText(value, { exact: true })).toBeVisible();
      expect(
        screen.getByText(
          locale === "en" ? "Version ID: 9223372036854775807" : "Versions-ID: 9223372036854775807",
        ),
      ).toBeVisible();
      expect(
        screen.getByText(locale === "en" ? "Component ID: 12001" : "Komponenten-ID: 12001"),
      ).toBeVisible();
      expect(
        screen.getByText(locale === "en" ? "Project key: SYN" : "Projektschlüssel: SYN"),
      ).toBeVisible();
      expect(
        screen.getByText(
          locale === "en" ? "Release date: 2028-03-01" : "Veröffentlichungsdatum: 2028-03-01",
        ),
      ).toBeVisible();
      expect(
        screen.getByText(locale === "en" ? "Released version" : "Veröffentlichte Version"),
      ).toBeVisible();
      expect(
        screen.getByText(
          locale === "en" ? "Assignee: component lead" : "Zuständigkeit: Komponentenleitung",
        ),
      ).toBeVisible();
      expect(screen.queryByText("SYN-7", { exact: true })).toBeNull();
      expect(screen.queryByRole("link")).toBeNull();
      expect(container.querySelector("pre")).toBeNull();
      expect(await axe(container)).toHaveNoViolations();
    });

    it("keeps missing version state and totals unknown", () => {
      show(
        projectExchange(
          {
            outcome: "succeeded",
            items: [{ versionId: "12000", projectId: "10000", name: "State unknown" }],
          },
          "jira_versions",
        ),
      );
      expect(
        screen.getByText(
          locale === "en" ? "Release state unavailable" : "Veröffentlichungsstatus nicht verfügbar",
        ),
      ).toBeVisible();
      expect(
        screen.getByText(
          locale === "en" ? "Archive state unavailable" : "Archivierungsstatus nicht verfügbar",
        ),
      ).toBeVisible();
      expect(
        screen.getByText(
          locale === "en" ? "Returned results: 1." : "Zurückgegebene Ergebnisse: 1.",
        ),
      ).toBeVisible();
      expect(
        screen.queryByText(locale === "en" ? "Unreleased version" : "Unveröffentlichte Version"),
      ).toBeNull();
      expect(screen.queryByText(locale === "en" ? "Not archived" : "Nicht archiviert")).toBeNull();
    });

    it.each([0, 2])("keeps local collection page at offset %s explicitly partial", (startAt) => {
      show(
        projectExchange(
          {
            outcome: "succeeded",
            items: [{ versionId: "12000", projectId: "10000", name: "One page" }],
            startAt,
            total: 3,
            ...(startAt === 0 ? { nextStartAt: 1 } : {}),
          },
          "jira_versions",
        ),
      );
      expect(
        screen.getByText(
          locale === "en" ? "1 of 3 results returned." : "1 von 3 Ergebnissen zurückgegeben.",
        ),
      ).toBeVisible();
      expect(
        screen.getByText(
          locale === "en"
            ? "Partial Jira result. Some available data is not included."
            : "Jira-Teilergebnis. Nicht alle verfügbaren Daten sind enthalten.",
        ),
      ).toBeVisible();
    });

    it.each(["jira_create_version", "jira_create_component"])(
      "keeps unknown %s with only project context distinct from a created entity",
      (operation) => {
        const exchange = projectExchange(
          {
            outcome: "unknown",
            projectId: "10000",
            projectKey: "SYN",
            projectName: "Context only",
            browseUrl: PROJECT_URL,
            reason: "timeout",
          },
          operation,
        );
        const { container } = show({ ...exchange, mutationOutcome: "unknown" });
        expect(
          screen.getByText(
            locale === "en" ? "Jira outcome unknown" : "Ausgang der Jira-Aktion unbekannt",
          ),
        ).toBeVisible();
        expect(
          screen.getByText(locale === "en" ? "Project ID: 10000" : "Projekt-ID: 10000"),
        ).toBeVisible();
        expect(screen.queryByText("Context only", { exact: true })).toBeNull();
        expect(container.textContent).not.toMatch(
          /(?:Version ID|Versions-ID|Component ID|Komponenten-ID):/u,
        );
        expect(screen.queryByRole("link")).toBeNull();
        expect(
          screen.queryByText(locale === "en" ? "Jira change confirmed" : "Jira-Änderung bestätigt"),
        ).toBeNull();
      },
    );

    it.each([
      ["jira_create_version", { versionId: "12000" }, "Version ID: 12000", "Versions-ID: 12000"],
      ["jira_update_version", { versionId: "12000" }, "Version ID: 12000", "Versions-ID: 12000"],
      [
        "jira_create_component",
        { componentId: "12001", projectId: "10000", projectKey: "SYN" },
        "Component ID: 12001",
        "Komponenten-ID: 12001",
      ],
      [
        "jira_update_component",
        { componentId: "12001", projectId: "10000", projectKey: "SYN" },
        "Component ID: 12001",
        "Komponenten-ID: 12001",
      ],
    ] as const)(
      "retains %s identity without inventing a confirmed state",
      (operation, receipt, en, de) => {
        show({
          ...projectExchange({ outcome: "succeeded-unconfirmed", ...receipt }, operation),
          mutationOutcome: "succeeded-unconfirmed",
        });
        expect(screen.getByText(locale === "en" ? en : de)).toBeVisible();
        expect(
          screen.queryByText(locale === "en" ? "Released version" : "Veröffentlichte Version"),
        ).toBeNull();
        expect(screen.queryByRole("link")).toBeNull();
      },
    );
  },
);

describe.each(["en", "de"] as const)("saved Agile results in %s (AC6)", (locale) => {
  beforeEach(async () => {
    await Promise.all([loadLocaleMessages(locale), loadOptionalWidgetMessages(locale)]);
    localStorage.setItem(I18N_STORAGE_KEY, locale);
  });
  it("keeps a saved filter readable without assuming unknown sharing is private", async () => {
    const { container } = show(
      projectExchange(
        {
          outcome: "succeeded",
          items: [
            {
              id: "7",
              name: "Delivery filter",
              jql: "project = SYN ORDER BY Rank",
              shareScope: "unknown",
            },
          ],
          startAt: 0,
          total: 1,
        },
        "jira_favourite_filters",
      ),
    );
    expect(screen.getByText("Delivery filter", { exact: true })).toBeVisible();
    expect(
      screen.getByText(locale === "en" ? "Saved filter ID: 7" : "Gespeicherte Filter-ID: 7"),
    ).toBeVisible();
    expect(
      screen.getByText(
        locale === "en"
          ? "Filter query: project = SYN ORDER BY Rank"
          : "Filterabfrage: project = SYN ORDER BY Rank",
      ),
    ).toBeVisible();
    expect(
      screen.getByText(
        locale === "en"
          ? "Filter sharing status unavailable"
          : "Freigabestatus des Filters nicht verfügbar",
      ),
    ).toBeVisible();
    expect(screen.queryByText(locale === "en" ? "Private filter" : "Privater Filter")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
    expect(container.querySelector("pre")).toBeNull();
    expect(await axe(container)).toHaveNoViolations();
  });
  it("restores board and sprint identity, state and goal as readable facts", async () => {
    await Promise.all([loadLocaleMessages(locale), loadOptionalWidgetMessages(locale)]);
    localStorage.setItem(I18N_STORAGE_KEY, locale);
    const exchanges = [
      projectExchange(
        { outcome: "succeeded", items: [{ id: "7", name: "Delivery board", type: "scrum" }] },
        "jira_boards",
      ),
      projectExchange(
        {
          outcome: "succeeded",
          items: [
            {
              id: "9",
              name: "Delivery sprint",
              state: "active",
              originBoardId: "7",
              goal: "Deliver the reviewed scope",
            },
          ],
        },
        "jira_sprint",
      ),
    ].map((entry, index) => ({ ...entry, call: { ...entry.call, id: `agile-${String(index)}` } }));
    const restored = JSON.parse(
      JSON.stringify({ schemaVersion: 1, exchanges }),
    ) as ChatToolTranscript;
    const { container } = render(
      <I18nProvider>
        <JiraChatTools transcript={restored} turnState="completed" />
      </I18nProvider>,
    );
    for (const value of ["Delivery board", "Delivery sprint", "Deliver the reviewed scope"])
      expect(screen.getByText(value, { exact: true })).toBeVisible();
    expect(screen.getByText(locale === "en" ? "Sprint ID: 9" : "Sprint-ID: 9")).toBeVisible();
    expect(screen.getAllByText(locale === "en" ? "Board ID: 7" : "Board-ID: 7")).toHaveLength(2);
    expect(screen.getByText(locale === "en" ? "Active sprint" : "Aktiver Sprint")).toBeVisible();
    expect(screen.queryByRole("link")).toBeNull();
    expect(container.querySelector("pre")).toBeNull();
    expect(await axe(container)).toHaveNoViolations();
  });

  it.each([
    ["jira_board_create", { boardId: "7" }, "Board ID: 7", "Board-ID: 7"],
    ["jira_sprint_create", { sprintId: "9" }, "Sprint ID: 9", "Sprint-ID: 9"],
    ["jira_sprint_update", { sprintId: "9" }, "Sprint ID: 9", "Sprint-ID: 9"],
    [
      "jira_sprint_move_issues",
      { sprintId: "9", issueKeys: ["SYN-1", "SYN-2"] },
      "Sprint ID: 9",
      "Sprint-ID: 9",
    ],
    ["jira_backlog_move_issues", { issueKeys: ["SYN-1", "SYN-2"] }, "SYN-1", "SYN-1"],
    ["jira_epic_update", { epicKey: "SYN-10" }, "SYN-10", "SYN-10"],
    [
      "jira_epic_move_issues",
      { epicKey: "SYN-10", issueKeys: ["SYN-1", "SYN-2"] },
      "SYN-10",
      "SYN-10",
    ],
  ] as const)(
    "keeps %s acknowledgement identity visible without claiming confirmation",
    (operation, receipt, en, de) => {
      const entry = projectExchange({ outcome: "succeeded-unconfirmed", ...receipt }, operation);
      const { container } = show({ ...entry, mutationOutcome: "succeeded-unconfirmed" });
      expect(
        screen.getByText(
          locale === "en"
            ? "Jira accepted the change; confirmation incomplete"
            : "Jira hat die Änderung angenommen; Bestätigung unvollständig",
        ),
      ).toBeVisible();
      expect(screen.getByText(locale === "en" ? en : de, { exact: true })).toBeVisible();
      if ("issueKeys" in receipt)
        for (const key of receipt.issueKeys)
          expect(screen.getByText(key, { exact: true })).toBeVisible();
      expect(
        screen.queryByText(locale === "en" ? "Jira change confirmed" : "Jira-Änderung bestätigt"),
      ).toBeNull();
      expect(screen.queryByRole("button", { name: /retry|erneut/iu })).toBeNull();
      expect(container.querySelector("pre")).toBeNull();
    },
  );
});

it("uses an Epic's stored issue link but never treats Board or Sprint URLs as qualified links", () => {
  const entries = [
    projectExchange(
      {
        outcome: "succeeded",
        epicKey: "SYN-10",
        browseUrl: "https://jira.example.test/context/browse/SYN-10",
      },
      "jira_epic_update",
    ),
    projectExchange(
      {
        outcome: "succeeded",
        boardId: "7",
        browseUrl: "https://jira.example.test/secure/RapidBoard.jspa?rapidView=7",
      },
      "jira_board_create",
    ),
    projectExchange(
      {
        outcome: "succeeded",
        sprintId: "9",
        browseUrl: "https://jira.example.test/secure/RapidBoard.jspa?sprint=9",
      },
      "jira_sprint_create",
    ),
  ].map((entry, index) => ({ ...entry, call: { ...entry.call, id: `link-${String(index)}` } }));
  render(
    <JiraChatTools transcript={{ schemaVersion: 1, exchanges: entries }} turnState="completed" />,
  );
  expect(screen.getAllByRole("link")).toHaveLength(1);
  expect(screen.getByRole("link", { name: /SYN-10/u })).toHaveAttribute(
    "href",
    "https://jira.example.test/context/browse/SYN-10",
  );
});

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
