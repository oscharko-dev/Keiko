import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatToolWriteApprovalView } from "@oscharko-dev/keiko-contracts";
import type { ChatToolExchange, ChatToolTranscript } from "@oscharko-dev/keiko-contracts/bff-wire";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { I18N_STORAGE_KEY, I18nProvider, loadLocaleMessages } from "@/lib/i18n";
import { loadOptionalWidgetMessages } from "@/lib/optional-widget-i18n";
import { JiraChatTools } from "./JiraChatTools";
import { JiraNamesContext, NO_JIRA_NAMES, type JiraNames } from "./jiraNames";
import { jiraNamesBinding } from "./jiraFieldChoices";

const connector = vi.hoisted(() => ({ observe: vi.fn(), decide: vi.fn(), diagnostic: vi.fn() }));
vi.mock("@/lib/client-diagnostics", () => ({ reportClientDiagnostic: connector.diagnostic }));
vi.mock("@/lib/atlassian-connectors-api", async () => ({
  ...(await vi.importActual<typeof import("@/lib/atlassian-connectors-api")>(
    "@/lib/atlassian-connectors-api",
  )),
  getJiraChatWriteApproval: connector.observe,
  decideJiraChatWriteApproval: connector.decide,
}));

const APPROVAL: ChatToolWriteApprovalView = {
  kind: "jira-chat-write",
  approvalId: "approval-ac9",
  chatId: "chat-ac9",
  podId: "11111111-1111-4111-8111-111111111111",
  bindingGeneration: 1,
  authenticationGeneration: 1,
  invocationId: "invocation-ac9",
  operation: "jira.edit",
  actionDigest: "a".repeat(64),
  requestedAt: 1,
  expiresAt: Date.now() + 60_000,
  state: "pending",
};

function completed(name: string, data: CatalogJsonObject, partial = false): ChatToolExchange {
  return {
    call: { id: `call-${name}`, name, arguments: {} },
    result: {
      schemaVersion: 1,
      invocationId: `invocation-${name}`,
      toolRef: null,
      projectionDigest: null,
      effectStarted: name === "jira_edit" || name === "jira_draft",
      metrics: { inputBytes: 1, outputBytes: 1, resultCount: 1, durationMs: 1 },
      status: "completed",
      reason: "none",
      page: { truncated: partial, reason: partial ? "result-cap" : "none", cursor: null },
      data,
    },
  };
}

const READ = completed(
  "jira_projects",
  {
    outcome: "succeeded",
    items: [{ id: "10001", key: "SYN", name: "Synthetic project" }],
    total: 2,
    nextStartAt: 1,
  },
  true,
);
const RECEIPT = completed("jira_edit", {
  outcome: "succeeded",
  items: [{ key: "SYN-1", summary: "Synthetic change" }],
});
const DRAFT = completed("jira_draft", {
  outcome: "succeeded",
  items: [{ ref: "story", state: "created", issueKey: "SYN-2" }],
  createdCount: 1,
  existingCount: 0,
  failedCount: 0,
});
const BATCH = completed("jira_draft_batch", {
  outcome: "succeeded",
  draftedCount: 4,
  plannedCount: 4,
  coveredRequirementCount: 8,
  requirementCount: 8,
  failedCount: 0,
});
const REPORT = completed("jira_report", {
  outcome: "succeeded",
  status: "complete",
  reportId: "11111111-2222-4333-8444-555555555555",
  progress: { issuesRead: 4, issuesTotal: 4, pageCount: 1, elapsedMs: 1 },
  report: {
    completeness: { complete: true, issuesRead: 4, issuesTotal: 4, pageCount: 1 },
    progress: {
      project: { total: 4, new: 1, indeterminate: 1, done: 2, noCategory: 0, donePercent: 50 },
    },
    hierarchy: {
      discovery: "complete",
      fieldCount: 0,
      observedFieldCount: 0,
      inferredFieldCount: 0,
    },
    compliance: { issuesChecked: 4, issuesJudged: 4, issuesWithDeviations: 1, deviationCount: 1 },
    coverage: {
      containerRoles: "observed",
      uncoveredEpics: { total: 0, items: [] },
      orphans: { total: 1, items: [] },
    },
  },
});
const PENDING: ChatToolExchange = {
  call: {
    id: "call-approval",
    name: "jira_edit",
    arguments: {
      issueKey: "SYN-1",
      fields: { summary: "Reviewed synthetic change", description: "Reviewed synthetic detail" },
    },
  },
  approval: APPROVAL,
};

type Locale = "en" | "de";
const COPY = {
  en: {
    read: "Partial Jira result. Some available data is not included.",
    receipt: "Jira change confirmed",
    approval: "Waiting for your decision",
    approve: "Approve this action",
    claimed: "Approval used for this action",
    batch: "Drafted 4 of 4 issues · 8 of 8 requirements covered",
    report: "Complete: 4 issues read",
    reportProgress: "50% done",
  },
  de: {
    read: "Jira-Teilergebnis. Nicht alle verfügbaren Daten sind enthalten.",
    receipt: "Jira-Änderung bestätigt",
    approval: "Deine Entscheidung steht aus",
    approve: "Diese Aktion genehmigen",
    claimed: "Freigabe für diese Aktion verwendet",
    batch: "4 von 4 Vorgängen entworfen · 8 von 8 Anforderungen abgedeckt",
    report: "Vollständig: 4 Vorgänge gelesen",
    reportProgress: "50 % erledigt",
  },
} as const;

function show(
  transcript: ChatToolTranscript,
  pending = false,
  names: JiraNames = NO_JIRA_NAMES,
): ReturnType<typeof render> {
  return render(
    <I18nProvider>
      <JiraNamesContext.Provider value={names}>
        <JiraChatTools
          transcript={transcript}
          turnState={pending ? "pending" : "completed"}
          chatId="chat-ac9"
        />
      </JiraNamesContext.Provider>
    </I18nProvider>,
  );
}

function transcript(exchange: ChatToolExchange): ChatToolTranscript {
  return { schemaVersion: 1, exchanges: [exchange] };
}

function expectReadable(container: HTMLElement): void {
  // Jira issue keys are meaningful user content. Translation keys, aliases, request JSON and
  // unexpanded interpolation placeholders are implementation details that must never be shown.
  expect(container.textContent).not.toMatch(
    /chat\.(?:jira|tool|pipeline)\.|jira_(?:edit|projects|draft|report)|"(?:outcome|schemaVersion)"|\{(?:count|read|percent)\}/u,
  );
  expect(container.querySelector("pre, textarea")).toBeNull();
}

/** Compare the full rendered DOM and its ID-reference graph, independent of React's mount IDs. */
function presentation(container: HTMLElement): string {
  const clone = container.cloneNode(true) as HTMLElement;
  const ids = new Map(
    [...clone.querySelectorAll("[id]")].map((node, index) => [node.id, `node-${String(index)}`]),
  );
  for (const node of clone.querySelectorAll("*")) {
    for (const attribute of ["id", "aria-labelledby", "aria-describedby", "aria-controls"]) {
      const value = node.getAttribute(attribute);
      if (value !== null)
        node.setAttribute(
          attribute,
          value
            .split(" ")
            .map((id) => ids.get(id) ?? id)
            .join(" "),
        );
    }
  }
  return clone.innerHTML;
}

afterEach(() => localStorage.removeItem(I18N_STORAGE_KEY));

describe.each(["en", "de"] as const)("AC9 Jira card families in %s", (locale: Locale) => {
  beforeEach(async () => {
    await Promise.all([loadLocaleMessages(locale), loadOptionalWidgetMessages(locale)]);
    localStorage.setItem(I18N_STORAGE_KEY, locale);
    connector.observe.mockReset().mockResolvedValue(APPROVAL);
    connector.decide.mockReset().mockResolvedValue({ ...APPROVAL, state: "claimed" });
    connector.diagnostic.mockClear();
  });

  it.each([
    ["read card", READ, "read", "Synthetic project"],
    ["write receipt", RECEIPT, "receipt", "SYN-1"],
    ["draft receipt", DRAFT, "receipt", "SYN-2"],
    ["batch receipt", BATCH, "batch", ""],
    ["report card", REPORT, "report", ""],
  ] as const)("renders the %s readably and axe-clean", async (_, exchange, label, content) => {
    const { container } = show(transcript(exchange));
    expect(screen.getByText(COPY[locale][label], { exact: true })).toBeVisible();
    if (content !== "") expect(container).toHaveTextContent(content);
    if (exchange === REPORT) expect(screen.getByText(COPY[locale].reportProgress)).toBeVisible();
    expectReadable(container);
    expect(await axe(container)).toHaveNoViolations();
    expect(connector.decide).not.toHaveBeenCalled();
  });

  it("renders the exact pending approval readably and axe-clean", async () => {
    const { container } = show(transcript(PENDING), true);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: COPY[locale].approve })).toBeEnabled(),
    );
    expect(screen.getByText(COPY[locale].approval)).toBeVisible();
    expect(container).toHaveTextContent("Reviewed synthetic change");
    expect(screen.queryByText("summary", { exact: true })).toBeNull();
    expect(screen.queryByText("description", { exact: true })).toBeNull();
    expect(
      screen.getByText(locale === "en" ? "Summary" : "Zusammenfassung", { exact: true }),
    ).toBeVisible();
    expect(
      screen.getByText(locale === "en" ? "Description" : "Beschreibung", { exact: true }),
    ).toBeVisible();
    expectReadable(container);
    expect(await axe(container)).toHaveNoViolations();
    expect(connector.decide).not.toHaveBeenCalled();
    expect(connector.diagnostic).toHaveBeenCalledExactlyOnceWith(
      "Jira built-in field labels presented.",
      { jiraFieldPresentation: { fieldCount: 3, localizedCount: 2 } },
    );
  });

  it("keeps Jira's observed field names and unnamed custom field identity", async () => {
    const custom: ChatToolExchange = {
      ...PENDING,
      call: {
        ...PENDING.call,
        arguments: {
          issueKey: "SYN-1",
          fields: {
            summary: "Reviewed value",
            customfield_20001: "Reviewed custom value",
          },
        },
      },
    };
    const names: JiraNames = {
      ...NO_JIRA_NAMES,
      fields: new Map([
        [JSON.stringify([jiraNamesBinding(APPROVAL), "summary"]), "Synthetic provider headline"],
      ]),
    };
    const { container } = show(transcript(custom), true, names);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: COPY[locale].approve })).toBeEnabled(),
    );
    expect(screen.getByText("Synthetic provider headline", { exact: true })).toBeVisible();
    expect(screen.getByText("customfield_20001", { exact: true })).toBeVisible();
    expect(container).toHaveTextContent("Reviewed custom value");
    expect(
      screen.queryByText(locale === "en" ? "Summary" : "Zusammenfassung", { exact: true }),
    ).toBeNull();
    expect(connector.diagnostic).not.toHaveBeenCalled();
  });

  it.each([
    ["completed write receipt", RECEIPT],
    ["draft receipt", DRAFT],
    ["draft batch state", BATCH],
  ] as const)(
    "hydrates the %s identically from a serialized Chat transcript",
    async (_, exchange) => {
      const saved = transcript(exchange);
      const live = show(saved);
      const before = presentation(live.container);
      live.unmount();
      const persisted = JSON.parse(JSON.stringify(saved)) as ChatToolTranscript;
      const restored = show(persisted);
      expect(presentation(restored.container)).toBe(before);
      expectReadable(restored.container);
      expect(await axe(restored.container)).toHaveNoViolations();
      expect(connector.decide).not.toHaveBeenCalled();
    },
  );

  it("re-observes a persisted pending approval without dispatch and refuses a second decision", async () => {
    const saved = transcript(PENDING);
    const live = show(saved, true);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: COPY[locale].approve })).toBeEnabled(),
    );
    const before = presentation(live.container);
    live.unmount();
    const restored = show(JSON.parse(JSON.stringify(saved)) as ChatToolTranscript, true);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: COPY[locale].approve })).toBeEnabled(),
    );
    expect(presentation(restored.container)).toBe(before);
    expect(connector.decide).not.toHaveBeenCalled();
    await userEvent.dblClick(screen.getByRole("button", { name: COPY[locale].approve }));
    await waitFor(() => expect(screen.getByText(COPY[locale].claimed)).toBeVisible());
    expect(connector.decide).toHaveBeenCalledExactlyOnceWith(APPROVAL, "approve");
    restored.unmount();
    // The saved transcript can lag a completed decision. Observation of the persisted server
    // record must outrank that stale pending state when a fresh page mounts.
    connector.observe.mockResolvedValue({ ...APPROVAL, state: "claimed" });
    show(JSON.parse(JSON.stringify(saved)) as ChatToolTranscript, true);
    await waitFor(() => expect(screen.getByText(COPY[locale].claimed)).toBeVisible());
    expect(screen.queryByRole("button", { name: COPY[locale].approve })).toBeNull();
    expect(connector.decide).toHaveBeenCalledOnce();
  });
});
