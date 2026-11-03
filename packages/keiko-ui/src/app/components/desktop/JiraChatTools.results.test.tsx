import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { ChatToolExchange } from "@oscharko-dev/keiko-contracts/bff-wire";
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
      await userEvent
        .setup()
        .click(screen.getByText(locale === "de" ? "Jira-Ergebnis ansehen" : "View Jira result"));
      expect(screen.getByText(/Synthetic project/)).toBeVisible();
      expect(screen.queryByRole("button", { name: /retry|erneut|next page/i })).toBeNull();
    } finally {
      localStorage.removeItem(I18N_STORAGE_KEY);
    }
  },
);

it("shows distinct saved Jira instance URLs for historical results with the same ticket key", async () => {
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
  const user = userEvent.setup();
  for (const disclosure of screen.getAllByText("View Jira result", { exact: true }))
    await user.click(disclosure);
  for (const url of urls)
    expect(screen.getByText((content) => content.includes(url))).toBeVisible();
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
