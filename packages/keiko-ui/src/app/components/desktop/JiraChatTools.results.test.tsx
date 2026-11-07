import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ChatToolExchange } from "@oscharko-dev/keiko-contracts/bff-wire";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { JiraChatTools } from "./JiraChatTools";
import { I18N_STORAGE_KEY, I18nProvider, loadLocaleMessages } from "@/lib/i18n";
import { loadOptionalWidgetMessages } from "@/lib/optional-widget-i18n";

function exchange(outcome: string | undefined): ChatToolExchange {
  return {
    call: { id: "call-1", name: "jira_edit", arguments: { issueKey: "LAB-1" } },
    result: {
      schemaVersion: 1,
      invocationId: "invocation-1",
      toolRef: null,
      projectionDigest: null,
      effectStarted: true,
      metrics: { inputBytes: 10, outputBytes: 10, resultCount: 1, durationMs: 20 },
      status: "completed",
      reason: "none",
      page: { truncated: false, reason: "none", cursor: null },
      data: outcome === undefined ? {} : { outcome },
    },
  };
}

it.each([
  ["en", true],
  ["en", false],
  ["de", true],
  ["de", false],
] as const)(
  "truthfully presents a bounded Jira page in %s with partial=%s",
  async (locale, partial) => {
    await Promise.all([loadLocaleMessages(locale), loadOptionalWidgetMessages(locale)]);
    localStorage.setItem(I18N_STORAGE_KEY, locale);
    const original = exchange(undefined);
    if (original.result?.status !== "completed") throw new Error("Missing completed fixture");
    // localJiraPage/remoteJiraPage expose nextStartAt, and the production Chat adapter
    // maps that nonterminal page to truncated/result-cap without inventing a tool status.
    const read: ChatToolExchange = {
      call: { id: "paged-read", name: "jira_projects", arguments: { startAt: 0, maxResults: 1 } },
      result: {
        ...original.result,
        page: { truncated: partial, reason: partial ? "result-cap" : "none", cursor: null },
        data: {
          outcome: "succeeded",
          items: [{ id: "10001", key: "SYN", name: "Synthetic project" }],
          startAt: 0,
          total: partial ? 2 : 1,
          ...(partial ? { nextStartAt: 1 } : {}),
        },
      },
    };
    const notice =
      locale === "de"
        ? "Jira-Teilergebnis. Nicht alle verfügbaren Daten sind enthalten."
        : "Partial Jira result. Some available data is not included.";
    try {
      render(
        <I18nProvider>
          <JiraChatTools
            transcript={{ schemaVersion: 1, exchanges: [read] }}
            turnState="completed"
          />
        </I18nProvider>,
      );
      expect(screen.getByText(locale === "de" ? "Abgeschlossen" : "Completed")).toBeVisible();
      if (partial) expect(screen.getByText(notice)).toBeVisible();
      else expect(screen.queryByText(notice)).toBeNull();
      // A person reads the state and the note, never the raw tool data (#4173).
      expect(screen.queryByText(/Synthetic project|"outcome"/u)).toBeNull();
      expect(document.querySelector("pre")).toBeNull();
      expect(screen.queryByRole("button", { name: /retry|erneut|next page/i })).toBeNull();
    } finally {
      localStorage.removeItem(I18N_STORAGE_KEY);
    }
  },
);

it("links each historical result to its own saved Jira instance, even with the same key", () => {
  const urls = [
    "https://10.1.2.3:8443/context/browse/SYN-1",
    "https://10.4.5.6:8443/context/browse/SYN-1",
  ];
  const original = exchange("succeeded");
  if (original.result?.status !== "completed") throw new Error("Missing completed test result");
  const result = original.result;
  render(
    <>
      {urls.map((browseUrl, index) => (
        <JiraChatTools
          key={browseUrl}
          transcript={{
            schemaVersion: 1,
            exchanges: [
              {
                call: {
                  id: `historical-${String(index)}`,
                  name: "jira_issue",
                  arguments: { issueKey: "SYN-1" },
                },
                result: {
                  ...result,
                  data: {
                    outcome: "succeeded",
                    items: [{ id: "10001", key: "SYN-1", summary: "Synthetic", browseUrl }],
                  },
                },
              },
            ],
          }}
          turnState="completed"
        />
      ))}
    </>,
  );
  const links = screen.getAllByRole("link", { name: /SYN-1/u });
  expect(links.map((link) => link.getAttribute("href"))).toEqual(urls);
  for (const link of links) expect(link).toHaveTextContent("SYN-1 Synthetic");
  for (const link of links) {
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  }
});

describe("Jira Chat mutation outcomes", () => {
  it.each([
    ["not-dispatched", "Not sent to Jira"],
    ["rejected", "Jira action rejected"],
    ["succeeded", "Jira change confirmed"],
    ["succeeded-unconfirmed", "Jira accepted the change; confirmation incomplete"],
    ["unknown", "Jira outcome unknown"],
    ["pending", "Awaiting a confirmed Jira outcome"],
  ])("renders the %s remote outcome rather than the enclosing tool status", (outcome, label) => {
    render(
      <JiraChatTools
        transcript={{ schemaVersion: 1, exchanges: [exchange(outcome)] }}
        turnState="completed"
      />,
    );
    expect(screen.getByText(label)).toBeVisible();
    expect(screen.queryByText("Completed", { exact: true })).toBeNull();
    expect(screen.queryByRole("button", { name: /retry/i })).toBeNull();
  });
  it.each([undefined, "unsupported-outcome"])("does not infer success from %s", (outcome) => {
    render(<JiraChatTools transcript={{ schemaVersion: 1, exchanges: [exchange(outcome)] }} />);
    expect(screen.getByText("Jira outcome unknown")).toBeVisible();
    expect(screen.getByText(/may have been applied/)).toBeVisible();
  });
  it("explains an open outcome only after the turn, not while it still runs", () => {
    const { rerender } = render(
      <JiraChatTools
        transcript={{ schemaVersion: 1, exchanges: [{ call: exchange("unknown").call }] }}
        turnState="pending"
      />,
    );
    expect(screen.getByText("Awaiting a confirmed Jira outcome")).toBeVisible();
    expect(screen.queryByText(/No final outcome is available/)).toBeNull();
    rerender(
      <JiraChatTools
        transcript={{ schemaVersion: 1, exchanges: [{ call: exchange("unknown").call }] }}
        turnState="failed"
      />,
    );
    expect(screen.getByText(/may have been applied/)).toBeVisible();
  });
  it("does not show an interrupted read as still running", () => {
    render(
      <JiraChatTools
        transcript={{
          schemaVersion: 1,
          exchanges: [{ call: { id: "read-1", name: "jira_projects", arguments: {} } }],
        }}
        turnState="cancelled"
      />,
    );
    expect(screen.getByText("Result unavailable")).toBeVisible();
    expect(screen.queryByText("Running")).toBeNull();
  });
  it("preserves uncertainty when a mutation has no result after interruption", () => {
    render(
      <JiraChatTools
        transcript={{ schemaVersion: 1, exchanges: [{ call: exchange("unknown").call }] }}
        turnState="failed"
      />,
    );
    expect(screen.getByText("Jira outcome unknown")).toBeVisible();
    expect(screen.queryByText("Running")).toBeNull();
  });
});

it.each([
  ["succeeded", "Jira change confirmed"],
  ["succeeded-unconfirmed", "Jira accepted the change; confirmation incomplete"],
  ["unknown", "Jira outcome unknown"],
] as const)("preserves journal outcome %s despite a cancelled tool envelope", (outcome, label) => {
  const original = exchange("unknown");
  if (original.result === undefined) throw new Error("Missing test result");
  render(
    <JiraChatTools
      transcript={{
        schemaVersion: 1,
        exchanges: [
          {
            ...original,
            mutationOutcome: outcome,
            result: {
              ...original.result,
              status: "cancelled",
              reason: "parent-cancelled",
              data: null,
              page: null,
            },
          },
        ],
      }}
      turnState="cancelled"
    />,
  );
  expect(screen.getByText(label)).toBeVisible();
  expect(screen.queryByText("Could not complete")).toBeNull();
});

it.each([
  ["succeeded", "Action confirmed"],
  ["unknown", "MCP action outcome unknown"],
] as const)(
  "renders the recorded MCP %s outcome without Jira labels or automatic retries",
  (outcome, label) => {
    const original = exchange("succeeded");
    render(
      <JiraChatTools
        transcript={{
          schemaVersion: 1,
          exchanges: [
            {
              ...original,
              call: {
                id: "mcp-call",
                name: "mcp_fixture_create_note",
                arguments: { text: "Synthetic" },
              },
              mutationOutcome: outcome,
            },
          ],
        }}
        turnState="completed"
      />,
    );
    expect(screen.getByRole("region", { name: "MCP action" })).toBeVisible();
    expect(screen.getByText(label)).toBeVisible();
    expect(screen.queryByText("Jira change confirmed")).toBeNull();
    expect(screen.queryByRole("button", { name: /retry/i })).toBeNull();
  },
);

it("shows a recorded pre-dispatch timeout as not sent without remote uncertainty", () => {
  const original = exchange(undefined);
  if (original.result === undefined) throw new Error("Missing test result");
  render(
    <JiraChatTools
      transcript={{
        schemaVersion: 1,
        exchanges: [
          {
            ...original,
            mutationOutcome: "not-dispatched",
            result: {
              ...original.result,
              effectStarted: false,
              status: "timeout",
              reason: "deadline-exceeded",
              data: null,
              page: null,
            },
          },
        ],
      }}
      turnState="completed"
    />,
  );
  expect(screen.getByText("Not sent to Jira")).toBeVisible();
  expect(screen.queryByText("Jira outcome unknown")).toBeNull();
  expect(screen.queryByText(/may have been applied/)).toBeNull();
});

it("keeps known unconfirmed draft keys visible beside a timeout with no result data", () => {
  const original = exchange(undefined);
  if (original.result === undefined) throw new TypeError("Missing timeout fixture");
  const draft: ChatToolExchange = {
    call: { id: "draft-call", name: "jira_draft", arguments: { draftId: "reviewed-draft" } },
    mutationOutcome: "succeeded-unconfirmed",
    result: {
      ...original.result,
      status: "timeout",
      reason: "deadline-exceeded",
      data: null,
      page: null,
    },
    draftProgress: {
      items: [
        { ref: "epic", state: "uncertain", outcome: "succeeded-unconfirmed", issueKey: "LAB-1" },
      ],
    },
  };
  render(
    <JiraChatTools transcript={{ schemaVersion: 1, exchanges: [draft] }} turnState="completed" />,
  );
  expect(screen.getByText("Jira accepted the change; confirmation incomplete")).toBeVisible();
  expect(screen.queryByText("Jira change confirmed")).toBeNull();
  expect(screen.getByRole("list", { name: "Jira issues" })).toHaveTextContent("LAB-1");
  expect(screen.queryByRole("button", { name: /retry/iu })).toBeNull();
  expect(draft.result).toMatchObject({ status: "timeout", data: null });
});

describe("Jira tool outcome for a business user (#4173)", () => {
  function created(data: CatalogJsonObject): ChatToolExchange {
    const original = exchange("succeeded");
    if (original.result?.status !== "completed") throw new Error("Missing completed fixture");
    return {
      call: { id: "create-1", name: "jira_create", arguments: { projectKey: "KER" } },
      result: { ...original.result, data },
    };
  }

  it("names the created issue and links it to Jira instead of showing raw data", () => {
    render(
      <JiraChatTools
        transcript={{
          schemaVersion: 1,
          exchanges: [
            created({
              outcome: "succeeded",
              issueKey: "KER-3",
              issueId: "10203",
              browseUrl: "https://jira.example.test/browse/KER-3",
            }),
          ],
        }}
        turnState="completed"
      />,
    );
    expect(screen.getByRole("link", { name: /KER-3/u })).toHaveAttribute(
      "href",
      "https://jira.example.test/browse/KER-3",
    );
    expect(screen.queryByText(/10203|"outcome"/u)).toBeNull();
    expect(document.querySelector("pre, details")).toBeNull();
  });

  it("says in Jira's words which field it refused, and never links a non-web URL", () => {
    render(
      <JiraChatTools
        transcript={{
          schemaVersion: 1,
          exchanges: [
            created({
              outcome: "rejected",
              issueKey: "KER-4",
              browseUrl: "javascript:alert(1)",
              fieldErrors: [
                { fieldId: "customfield_10104", fieldName: "Epic Name", message: "required" },
              ],
              messages: ["Nothing was changed."],
              guidance: "internal instruction for the model",
            }),
          ],
        }}
        turnState="completed"
      />,
    );
    const problems = screen.getByRole("list", { name: "What Jira said" });
    expect(problems).toHaveTextContent("Epic Name: required");
    expect(problems).toHaveTextContent("Nothing was changed.");
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("KER-4")).toBeVisible();
    expect(screen.queryByText(/internal instruction/u)).toBeNull();
  });

  it("names the project lead's broken template rules as sentences, never as rule ids", () => {
    render(
      <JiraChatTools
        transcript={{
          schemaVersion: 1,
          exchanges: [
            created({
              outcome: "rejected",
              reason: "field-validation",
              violations: [
                { ruleId: "field-missing", subject: "Epic Name", template: "KER/Epic" },
                { ruleId: "section-missing", subject: "Ziel", template: "KER/Epic" },
                { ruleId: "summary-pattern", subject: "^[A-Z].*$", template: "KER/Epic" },
                { ruleId: "not-a-rule", subject: "ignored", template: "KER/Epic" },
              ],
            }),
            {
              ...created({
                outcome: "rejected",
                items: [
                  {
                    ref: "epic",
                    state: "failed",
                    violations: [
                      { ruleId: "field-missing", subject: "Epic Name", template: "KER/Epic" },
                      { ruleId: "parent-missing", subject: "Epic Link", template: "KER/Task" },
                    ],
                  },
                ],
              }),
              call: { id: "draft", name: "jira_draft", arguments: {} },
            },
          ],
        }}
        turnState="completed"
      />,
    );
    const [create, draft] = screen.getAllByRole("list", { name: "Template rules not met" });
    expect(create).toHaveTextContent("The field \u201cEpic Name\u201d is required.");
    expect(create).toHaveTextContent("The description lacks the section \u201cZiel\u201d.");
    expect(create).toHaveTextContent("The summary does not follow the required pattern.");
    expect(create).not.toHaveTextContent(/ignored|\^\[A-Z\]|field-missing/u);
    expect(draft?.querySelectorAll("li")).toHaveLength(2);
    expect(draft).toHaveTextContent("The issue needs a parent (Epic Link).");
  });

  it("explains a change Keiko's own field check stopped before Jira saw it", () => {
    render(
      <JiraChatTools
        transcript={{
          schemaVersion: 1,
          exchanges: [
            created({
              outcome: "rejected",
              reason: "field-validation",
              fieldId: "customfield_10103",
              validation: "required-field",
            }),
          ],
        }}
        turnState="completed"
      />,
    );
    expect(
      screen.getByText("A required Jira field was missing, so nothing was sent."),
    ).toBeVisible();
    expect(screen.queryByText(/customfield_10103|required-field/u)).toBeNull();
  });

  it("shows at most five read issues and counts the rest", () => {
    const items = Array.from({ length: 7 }, (_, index) => ({ key: `KER-${String(index + 1)}` }));
    render(
      <JiraChatTools
        transcript={{
          schemaVersion: 1,
          exchanges: [
            {
              ...created({ outcome: "succeeded", items }),
              call: { id: "s", name: "jira_search", arguments: {} },
            },
          ],
        }}
        turnState="completed"
      />,
    );
    const list = screen.getByRole("list", { name: "Jira issues" });
    expect(list).toHaveTextContent("KER-5");
    expect(list).not.toHaveTextContent("KER-6");
    expect(list).toHaveTextContent("and 2 more");
  });
});
