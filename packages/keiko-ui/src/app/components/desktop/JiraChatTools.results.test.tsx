import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { axe } from "jest-axe";
import type { ChatToolExchange, ChatToolTranscript } from "@oscharko-dev/keiko-contracts/bff-wire";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import * as diagnostics from "@/lib/client-diagnostics";
import { JiraChatTools } from "./JiraChatTools";
import { partialJiraReadPage } from "./jira-result.test-fixture";
import { I18N_STORAGE_KEY, I18nProvider, loadLocaleMessages } from "@/lib/i18n";
import { loadOptionalWidgetMessages } from "@/lib/optional-widget-i18n";

function exchange(
  outcome: string | undefined,
  catalog?: { readonly call: ChatToolExchange["call"]; readonly data: CatalogJsonObject },
): ChatToolExchange {
  return {
    call: catalog?.call ?? { id: "call-1", name: "jira_edit", arguments: { issueKey: "LAB-1" } },
    result: {
      schemaVersion: 1,
      invocationId: "invocation-1",
      toolRef: null,
      projectionDigest: null,
      effectStarted: catalog === undefined,
      metrics: { inputBytes: 10, outputBytes: 10, resultCount: 1, durationMs: 20 },
      status: "completed",
      reason: "none",
      page: { truncated: false, reason: "none", cursor: null },
      data: catalog?.data ?? (outcome === undefined ? {} : { outcome }),
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
      const completed = locale === "de" ? "Abgeschlossen" : "Completed";
      if (partial) {
        expect(screen.getByText(completed)).toBeVisible();
        expect(screen.getByText(notice)).toBeVisible();
        expect(screen.getByText("Synthetic project")).toBeVisible();
        expect(screen.getByText("SYN", { exact: true })).toBeVisible();
      } else {
        // The model answer carries a complete read; progress already records its completion.
        expect(screen.queryByText(completed)).toBeNull();
        expect(screen.queryByText(notice)).toBeNull();
        expect(screen.queryByText("Synthetic project")).toBeNull();
        expect(screen.queryByText("SYN", { exact: true })).toBeNull();
      }
      expect(screen.queryByText(/"outcome"/u)).toBeNull();
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
                  name: "jira_edit",
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
  expect(screen.getByText("Uncertain", { exact: true })).toBeVisible();
  expect(screen.queryByRole("button", { name: /retry/iu })).toBeNull();
  expect(draft.result).toMatchObject({ status: "timeout", data: null });
});

function resultExchange(name: string, data: CatalogJsonObject): ChatToolExchange {
  const original = exchange("succeeded");
  if (original.result?.status !== "completed") throw new TypeError("Missing result fixture");
  return {
    call: { id: `call-${name}`, name, arguments: {} },
    result: { ...original.result, data },
  };
}

function partialResultExchange(name: string, data: CatalogJsonObject): ChatToolExchange {
  const original = resultExchange(name, data);
  if (original.result?.status !== "completed")
    throw new TypeError("Missing partial result fixture");
  return { ...original, result: { ...original.result, page: partialJiraReadPage(name) } };
}

describe.each(["en", "de"] as const)("readable saved Jira results in %s (#4290)", (locale) => {
  it("keeps changed issue names, status, counts and links after a serialized transcript remount", async () => {
    await Promise.all([loadLocaleMessages(locale), loadOptionalWidgetMessages(locale)]);
    localStorage.setItem(I18N_STORAGE_KEY, locale);
    const transcript: ChatToolTranscript = {
      schemaVersion: 1,
      exchanges: [
        resultExchange("jira_edit", {
          outcome: "succeeded",
          startAt: 0,
          total: 1,
          items: [
            {
              key: "SYN-1",
              summary: "Review saved result",
              status: { name: "In Progress" },
              browseUrl: "https://jira.example.test/context/browse/SYN-1",
            },
          ],
        }),
      ],
    };
    try {
      const first = render(
        <I18nProvider>
          <JiraChatTools transcript={transcript} turnState="completed" />
        </I18nProvider>,
      );
      first.unmount();
      const restored = JSON.parse(JSON.stringify(transcript)) as ChatToolTranscript;
      const { container } = render(
        <I18nProvider>
          <JiraChatTools transcript={restored} turnState="completed" />
        </I18nProvider>,
      );
      expect(screen.getByText("Review saved result")).toBeVisible();
      expect(screen.getByText("In Progress", { exact: true })).toBeVisible();
      expect(screen.getByRole("link", { name: /SYN-1/u })).toHaveAttribute(
        "href",
        "https://jira.example.test/context/browse/SYN-1",
      );
      expect(
        screen.getByText(
          locale === "en" ? "1 of 1 results returned." : "1 von 1 Ergebnissen zurückgegeben.",
        ),
      ).toBeVisible();
      expect(container.querySelector("pre")).toBeNull();
      expect(await axe(container)).toHaveNoViolations();
    } finally {
      localStorage.removeItem(I18N_STORAGE_KEY);
    }
  });

  it("shows actionable field and template refusals without raw rule ids", async () => {
    await Promise.all([loadLocaleMessages(locale), loadOptionalWidgetMessages(locale)]);
    localStorage.setItem(I18N_STORAGE_KEY, locale);
    try {
      render(
        <I18nProvider>
          <JiraChatTools
            transcript={{
              schemaVersion: 1,
              exchanges: [
                resultExchange("jira_create", {
                  outcome: "rejected",
                  reason: "field-validation",
                  validation: "required-field",
                  violations: [
                    { ruleId: "field-missing", subject: "Epic Name", template: "SYN/Epic" },
                    { ruleId: "not-a-rule", subject: "ignored" },
                  ],
                  fieldErrors: [
                    {
                      fieldId: "customfield_10104",
                      fieldName: "Epic Name",
                      message: "Required by Jira",
                    },
                  ],
                  guidance: "internal model instructions",
                }),
              ],
            }}
            turnState="completed"
          />
        </I18nProvider>,
      );
      expect(
        screen.getByText(
          locale === "en"
            ? "The field “Epic Name” is required."
            : "Das Feld „Epic Name“ ist erforderlich.",
        ),
      ).toBeVisible();
      expect(screen.getByText("Required by Jira")).toBeVisible();
      expect(
        screen.queryByText(/customfield_10104|field-missing|internal model instructions|ignored/u),
      ).toBeNull();
      expect(document.querySelector("pre")).toBeNull();
    } finally {
      localStorage.removeItem(I18N_STORAGE_KEY);
    }
  });
});

it.each([
  "javascript:alert(1)",
  "http://jira.example.test/browse/SYN-1",
  "https://user:credential@jira.example.test/browse/SYN-1",
  "https://jira.example.test/browse/SYN-2",
  "https://jira.example.test/browse/SYN-1?token=hidden",
  "https://jira.example.test/browse/SYN-1#hidden",
])("keeps the key readable without opening unsafe saved URL %s", (browseUrl) => {
  render(
    <JiraChatTools
      transcript={{
        schemaVersion: 1,
        exchanges: [
          resultExchange("jira_create", {
            outcome: "succeeded",
            issueKey: "SYN-1",
            browseUrl,
          }),
        ],
      }}
      turnState="completed"
    />,
  );
  expect(screen.getByText("SYN-1", { exact: true })).toBeVisible();
  expect(screen.queryByRole("link")).toBeNull();
  expect(document.querySelector("pre")).toBeNull();
});

it("keeps every returned project of a partial read behind a readable bounded disclosure", async () => {
  const keys = ["PA", "PB", "PC", "PD", "PE", "PF", "PG"];
  render(
    <JiraChatTools
      transcript={{
        schemaVersion: 1,
        exchanges: [
          partialResultExchange("jira_projects", {
            outcome: "succeeded",
            total: 7,
            startAt: 0,
            items: keys.map((key) => ({ key, name: `Project ${key}` })),
          }),
        ],
      }}
      turnState="completed"
    />,
  );
  expect(screen.getByText("PE", { exact: true })).toBeVisible();
  expect(screen.getByText("PG", { exact: true })).not.toBeVisible();
  await userEvent.setup().click(screen.getByText("Show 2 more results"));
  expect(screen.getByText("PG", { exact: true })).toBeVisible();
  expect(screen.queryByRole("button", { name: /retry|next page/iu })).toBeNull();
});

it("shows no card for a complete Jira read that has nothing to say beyond the progress", () => {
  render(
    <JiraChatTools
      transcript={{
        schemaVersion: 1,
        exchanges: [resultExchange("jira_search", { outcome: "succeeded", items: [] })],
      }}
      turnState="completed"
    />,
  );
  expect(screen.queryByText("Completed", { exact: true })).toBeNull();
  expect(document.querySelector("pre, details")).toBeNull();
});

it.each([
  [
    "jira_issue",
    { items: [{ key: "SYN-1", summary: "Observed issue", status: { name: "Open" } }] },
  ],
  ["jira_project", { projectId: "10001", projectKey: "SYN", projectName: "Observed project" }],
  ["jira_create_fields", { items: [{ id: "customfield_123", name: "Epic Name", required: true }] }],
  [
    "jira_assignable_users",
    { items: [{ name: "synthetic-user", displayName: "Observed user", active: true }] },
  ],
  ["jira_comments", { items: [{ id: "10000", body: "Observed comment" }] }],
] satisfies readonly (readonly [string, CatalogJsonObject])[])(
  "leaves a complete %s read to the model answer, including after reload",
  (name, data) => {
    const transcript: ChatToolTranscript = {
      schemaVersion: 1,
      exchanges: [resultExchange(name, { outcome: "succeeded", ...data })],
    };
    const first = render(<JiraChatTools transcript={transcript} turnState="pending" />);
    expect(first.container.querySelector("[data-cards]")).toHaveAttribute("data-cards", "false");
    first.unmount();
    const saved = JSON.parse(JSON.stringify(transcript)) as ChatToolTranscript;
    const restored = render(<JiraChatTools transcript={saved} turnState="completed" />);
    expect(restored.container.querySelector("[data-cards]")).toHaveAttribute("data-cards", "false");
    expect(screen.queryByText("Completed", { exact: true })).toBeNull();
    expect(restored.container.querySelector("pre, details, a")).toBeNull();
  },
);

// #4355: the evidence counts what the card opens: 60 rows of a write list, not the old five.
it("records shownCount=60 for a draft write of 200 created issues", () => {
  const report = vi.spyOn(diagnostics, "reportClientDiagnostic");
  try {
    render(
      <JiraChatTools
        messageId="private-message-id"
        transcript={{
          schemaVersion: 1,
          exchanges: [
            resultExchange("jira_draft", {
              outcome: "succeeded",
              items: Array.from({ length: 200 }, (_, index) => ({
                ref: `r${String(index)}`,
                state: "created",
                issueKey: `SYN-${String(index + 1)}`,
              })),
            }),
          ],
        }}
        turnState="pending"
      />,
    );
    const events = report.mock.calls.filter(
      ([, meta]) => meta?.jiraResultPresentation !== undefined,
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.[1]?.jiraResultPresentation).toMatchObject({
      itemCount: 200,
      shownCount: 60,
    });
  } finally {
    report.mockRestore();
  }
});

it.each([
  ["jira_create", 1],
  ["jira_issue", 0],
] as const)(
  "records live %s result counts with shownCount=%s without private content",
  (name, shownCount) => {
    const report = vi.spyOn(diagnostics, "reportClientDiagnostic");
    try {
      render(
        <JiraChatTools
          messageId="private-message-id"
          transcript={{
            schemaVersion: 1,
            exchanges: [
              resultExchange(name, {
                outcome: "succeeded",
                items: [
                  {
                    key: "SYN-1",
                    summary: "Private issue name",
                    browseUrl: "https://jira.example.test/browse/SYN-1",
                  },
                ],
              }),
            ],
          }}
          turnState="pending"
        />,
      );
      const events = report.mock.calls.filter(
        ([, meta]) => meta?.jiraResultPresentation !== undefined,
      );
      expect(events).toHaveLength(1);
      expect(events[0]?.[1]?.jiraResultPresentation).toMatchObject({
        exchangeCount: 1,
        itemCount: 1,
        shownCount,
        returnedCount: 1,
        unreadableCount: 0,
        problemCount: 0,
        ruleCount: 0,
        failure: "none",
        restored: false,
        messageDigest: "4a1187d989622c846f402ce31ebb6bb5e15355cedde1a803d16dfc8943dd87a0",
      });
      expect(JSON.stringify(events)).not.toMatch(
        /SYN-1|Private issue name|jira\.example|call-jira|private-message-id|durationMs/u,
      );
    } finally {
      report.mockRestore();
    }
  },
);

it("bounds restored history evidence and deduplicates equivalent live result states", () => {
  const report = vi.spyOn(diagnostics, "reportClientDiagnostic");
  const exchanges = Array.from({ length: 8 }, (_, index) => {
    const result = resultExchange("jira_edit", {
      items: [{ key: `SYN-${String(index + 1)}`, summary: "Private summary" }],
    });
    return { ...result, call: { ...result.call, id: `private-call-${String(index)}` } };
  });
  const transcript: ChatToolTranscript = { schemaVersion: 1, exchanges };
  const first = exchanges[0];
  if (first === undefined) throw new TypeError("Missing first result fixture");
  const events = (): unknown[] =>
    report.mock.calls.flatMap(([, meta]) =>
      meta?.jiraResultPresentation === undefined ? [] : [meta.jiraResultPresentation],
    );
  try {
    const restored = render(
      <JiraChatTools transcript={transcript} turnState="completed" messageId="saved-parent" />,
    );
    expect(events()).toHaveLength(0);
    restored.rerender(
      <JiraChatTools
        transcript={JSON.parse(JSON.stringify(transcript)) as ChatToolTranscript}
        turnState="completed"
        messageId="saved-parent"
      />,
    );
    expect(events()).toHaveLength(0);
    restored.unmount();
    const reopened = render(
      <>
        <JiraChatTools transcript={transcript} turnState="completed" messageId="saved-parent" />
        <JiraChatTools transcript={transcript} turnState="failed" messageId="second-saved-parent" />
      </>,
    );
    expect(events()).toHaveLength(0);
    reopened.unmount();
    const live = render(
      <JiraChatTools
        transcript={{ schemaVersion: 1, exchanges: [{ call: first.call }] }}
        turnState="pending"
        messageId="live-parent"
      />,
    );
    live.rerender(
      <JiraChatTools
        transcript={{ schemaVersion: 1, exchanges: [first] }}
        turnState="pending"
        messageId="live-parent"
      />,
    );
    expect(events()).toHaveLength(1);
    expect(events().at(-1)).toMatchObject({ exchangeCount: 1, itemCount: 1, restored: false });
    live.rerender(
      <JiraChatTools
        transcript={
          JSON.parse(JSON.stringify({ schemaVersion: 1, exchanges: [first] })) as ChatToolTranscript
        }
        turnState="completed"
        messageId="live-parent"
      />,
    );
    expect(events()).toHaveLength(1);
  } finally {
    report.mockRestore();
  }
});

it("keeps field names, user availability and comment text readable without raw provider objects", () => {
  render(
    <JiraChatTools
      transcript={{
        schemaVersion: 1,
        exchanges: [
          partialResultExchange("jira_create_fields", {
            outcome: "succeeded",
            items: [{ id: "customfield_123", name: "Epic Name", required: true }],
          }),
          partialResultExchange("jira_assignable_users", {
            outcome: "succeeded",
            items: [
              { name: "private-account-id", displayName: "Assigned reviewer", active: false },
            ],
          }),
          partialResultExchange("jira_comments", {
            outcome: "succeeded",
            items: [
              {
                id: "10000",
                body: "Review <script>text</script>",
                author: { displayName: "Comment author" },
              },
            ],
          }),
        ],
      }}
      turnState="completed"
    />,
  );
  for (const label of [
    "Epic Name",
    "Required",
    "Assigned reviewer",
    "Inactive",
    "Comment author",
    "Review <script>text</script>",
  ])
    expect(screen.getByText(label, { exact: true })).toBeVisible();
  expect(screen.queryByText(/customfield_123|private-account-id/u)).toBeNull();
  expect(document.querySelector("script, pre")).toBeNull();
});

it("keeps unavailable saved entries and contradictory totals explicit", () => {
  render(
    <JiraChatTools
      transcript={{
        schemaVersion: 1,
        exchanges: [
          resultExchange("jira_search", {
            outcome: "succeeded",
            total: 1,
            items: [{ key: "SYN-1" }, { opaque: "internal data" }],
          }),
        ],
      }}
      turnState="completed"
    />,
  );
  expect(screen.getByText("Returned results: 2.")).toBeVisible();
  expect(screen.getByText("Saved results without readable details: 1.")).toBeVisible();
  expect(screen.queryByText(/internal data|2 of 1/u)).toBeNull();
});

it("keeps saved draft counts and per-item uncertainty without inventing a dispatch", () => {
  render(
    <JiraChatTools
      transcript={{
        schemaVersion: 1,
        exchanges: [
          resultExchange("jira_draft_stage", {
            outcome: "succeeded",
            itemCount: 3,
            unresolvedRefCount: 1,
          }),
          resultExchange("jira_draft", {
            outcome: "succeeded-unconfirmed",
            items: [
              { ref: "already-created", state: "existing", issueKey: "SYN-1" },
              { ref: "not-selected", state: "excluded" },
            ],
          }),
        ],
      }}
      turnState="completed"
    />,
  );
  for (const label of [
    "Issues in the saved draft: 3.",
    "Draft references still unresolved: 1.",
    "Already exists",
    "Excluded",
  ])
    expect(screen.getByText(label, { exact: true })).toBeVisible();
  expect(screen.getByText("Jira accepted the change; confirmation incomplete")).toBeVisible();
  expect(screen.queryByText("Jira change confirmed")).toBeNull();
});

it("explains a refused Jira read without claiming that it completed", () => {
  const data = { outcome: "failed", reason: "auth-failed" };
  const failed = resultExchange("jira_search", data);
  if (failed.result === undefined) throw new TypeError("Missing result fixture");
  render(
    <JiraChatTools
      transcript={{
        schemaVersion: 1,
        exchanges: [
          {
            ...failed,
            result: {
              ...failed.result,
              status: "failed",
              reason: "provider-reported-error",
              data,
              page: null,
            },
          },
        ],
      }}
      turnState="completed"
    />,
  );
  expect(screen.getByText("Could not complete", { exact: true })).toBeVisible();
  expect(
    screen.getByText(
      "Jira rejected the token. It may have expired or been revoked. Replace it on the Jira Pod, verify the connection and try again.",
    ),
  ).toBeVisible();
  expect(screen.queryByText("Completed", { exact: true })).toBeNull();
  expect(screen.queryByRole("button", { name: /retry/iu })).toBeNull();
});

it("explains an unverifiable Jira authentication as retryable, not as an expired token (#4353)", () => {
  const data = { outcome: "failed", reason: "auth-unverified" };
  const failed = resultExchange("jira_search", data);
  if (failed.result === undefined) throw new TypeError("Missing result fixture");
  render(
    <JiraChatTools
      transcript={{
        schemaVersion: 1,
        exchanges: [
          {
            ...failed,
            result: {
              ...failed.result,
              status: "failed",
              reason: "provider-reported-error",
              data,
              page: null,
            },
          },
        ],
      }}
      turnState="completed"
    />,
  );
  expect(screen.getByText("Could not complete", { exact: true })).toBeVisible();
  expect(
    screen.getByText(
      "Jira could not be verified right now, so this request was not sent on. The connection is unchanged. Try again in a moment.",
    ),
  ).toBeVisible();
  expect(screen.queryByText("Completed", { exact: true })).toBeNull();
  expect(screen.queryByRole("button", { name: /retry/iu })).toBeNull();
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
    expect(screen.getByText("A required Jira field was missing.")).toBeVisible();
    expect(screen.queryByText(/customfield_10103|required-field/u)).toBeNull();
  });

  it("says a refused Jira read changed nothing instead of asking to review a change (#4288)", () => {
    const refused = { outcome: "failed", reason: "field-validation" };
    render(
      <JiraChatTools
        transcript={{
          schemaVersion: 1,
          exchanges: [resultExchange("jira_issue_types", refused), created(refused)],
        }}
        turnState="completed"
      />,
    );
    expect(
      screen.getByText(
        "Jira refused the values of this read. Check the project key, issue type or filter it used; nothing was changed.",
      ),
    ).toBeVisible();
    expect(
      screen.getAllByText(
        "Review the required Jira fields and template rules before requesting the change again.",
      ),
    ).toHaveLength(1);
  });

  // #4355 AC1 supersedes the former five-row bound: every created key is listed with its link. The
  // bound that remains keeps the card finite: 60 rows stand open, the rest sit behind a disclosure.
  it("lists every drafted issue, 60 open and the rest behind a disclosure", async () => {
    const items = Array.from({ length: 70 }, (_, index) => ({
      ref: `item-${String(index)}`,
      state: "created",
      issueKey: `KER-${String(index + 1)}`,
    }));
    render(
      <JiraChatTools
        transcript={{
          schemaVersion: 1,
          exchanges: [
            {
              ...created({ outcome: "succeeded", items }),
              call: { id: "s", name: "jira_draft", arguments: {} },
            },
          ],
        }}
        turnState="completed"
      />,
    );
    const open = screen.getByRole("list", { name: "Jira issues" });
    expect(open).toHaveTextContent("KER-60");
    expect(open).not.toHaveTextContent("KER-61");
    // A closed disclosure mounts none of its rows; opening it mounts all ten.
    expect(screen.getAllByRole("list", { name: "Jira issues", hidden: true })).toHaveLength(1);
    await userEvent.click(screen.getByText("Show 10 more results"));
    await waitFor(() => {
      const rest = screen.getAllByRole("list", { name: "Jira issues", hidden: true })[1];
      expect(rest).toHaveTextContent("KER-61");
      expect(rest).toHaveTextContent("KER-70");
    });
  });
});

describe.each(["en", "de"] as const)("local Jira catalog results in %s", (locale) => {
  beforeEach(async () => {
    await Promise.all([loadLocaleMessages(locale), loadOptionalWidgetMessages(locale)]);
    localStorage.setItem(I18N_STORAGE_KEY, locale);
  });
  afterEach(() => localStorage.removeItem(I18N_STORAGE_KEY));

  it.each(["jira_discover", "jira_describe"] as const)(
    "keeps a readable %s result through history restoration without exposing schemas",
    async (name) => {
      const discover = name === "jira_discover";
      const entry = { identity: "GET /rest/api/2/project", tool: "jira_projects" };
      const data: CatalogJsonObject = {
        outcome: "succeeded",
        items: [
          {
            ...entry,
            ...(discover
              ? {
                  description: "List projects available to this Jira connection.",
                  kind: "native",
                  effects: ["remote-read"],
                }
              : {}),
            inputSchema: { properties: { hidden: { description: "schema-marker" } } },
            url: "https://metadata.example.invalid/execute",
          },
          {
            identity: "POST /unowned",
            tool: "jira_unowned_execute",
            description: "unowned-marker",
          },
        ],
        ...(discover ? { startAt: 0, total: 2 } : { selectedFor: "next-round" }),
        resultSchema: { description: "schema-marker" },
      };
      const transcript: ChatToolTranscript = {
        schemaVersion: 1,
        exchanges: [
          exchange("succeeded", {
            call: { id: name, name, arguments: {} },
            data,
          }),
        ],
      };
      const title =
        locale === "en"
          ? discover
            ? "Find Jira actions"
            : "Select Jira actions"
          : discover
            ? "Jira-Aktionen finden"
            : "Jira-Aktionen auswählen";
      const show = (): ReturnType<typeof render> =>
        render(
          <I18nProvider>
            <JiraChatTools
              transcript={JSON.parse(JSON.stringify(transcript)) as ChatToolTranscript}
              turnState="completed"
            />
          </I18nProvider>,
        );
      const first = show();
      const previous = first.container.textContent;
      first.unmount();
      const { container } = show();
      const card = screen.getByRole("group", { name: title });
      expect(card).toHaveTextContent(title);
      const rows = within(card).getByRole("list", {
        name: locale === "en" ? "Jira actions" : "Jira-Aktionen",
      });
      expect(rows).toHaveTextContent(
        locale === "en" ? "Read Jira projects" : "Jira-Projekte lesen",
      );
      if (discover)
        expect(rows).toHaveTextContent("List projects available to this Jira connection.");
      else
        expect(card).toHaveTextContent(
          locale === "en" ? "Action selection updated" : "Aktionsauswahl aktualisiert",
        );
      expect(container.textContent).toBe(previous);
      expect(container.textContent).not.toMatch(
        /schema-marker|unowned-marker|metadata\.example|A readable view|keine lesbare Ansicht/u,
      );
      expect(container.querySelector("pre, code, a, img, script")).toBeNull();
      expect(await axe(container)).toHaveNoViolations();
    },
  );

  it("shows an empty successful selection without inventing an action or a Jira effect", () => {
    render(
      <I18nProvider>
        <JiraChatTools
          transcript={{
            schemaVersion: 1,
            exchanges: [
              exchange("succeeded", {
                call: {
                  id: "empty-selection",
                  name: "jira_describe",
                  arguments: { identities: [] },
                },
                data: { outcome: "succeeded", items: [], selectedFor: "next-round" },
              }),
            ],
          }}
          turnState="completed"
        />
      </I18nProvider>,
    );
    const card = screen.getByRole("group", {
      name: locale === "en" ? "Select Jira actions" : "Jira-Aktionen auswählen",
    });
    expect(card).toHaveTextContent(
      locale === "en" ? "Action selection updated" : "Aktionsauswahl aktualisiert",
    );
    expect(within(card).queryByRole("list")).toBeNull();
    expect(card).not.toHaveTextContent(
      locale === "en" ? "Jira action rejected" : "Jira-Aktion abgelehnt",
    );
  });

  it("explains an invalid action selection without claiming that it was applied", () => {
    render(
      <I18nProvider>
        <JiraChatTools
          transcript={{
            schemaVersion: 1,
            exchanges: [
              exchange("failed", {
                call: { id: "invalid-selection", name: "jira_describe", arguments: {} },
                data: {
                  outcome: "failed",
                  reason: "invalid-arguments",
                  items: [],
                  guidance: "<a href='https://metadata.example.invalid'>guidance-marker</a>",
                },
              }),
            ],
          }}
          turnState="completed"
        />
      </I18nProvider>,
    );
    const card = screen.getByRole("group", {
      name: locale === "en" ? "Select Jira actions" : "Jira-Aktionen auswählen",
    });
    expect(card).toHaveTextContent(
      locale === "en"
        ? "The Jira action selection was invalid. Find available actions and select them again."
        : "Die Jira-Aktionsauswahl war ungültig. Suche verfügbare Aktionen und wähle sie erneut aus.",
    );
    expect(card).not.toHaveTextContent(
      /guidance-marker|metadata\.example|invalid-arguments|Action selection updated|Aktionsauswahl aktualisiert/u,
    );
    expect(card).not.toHaveTextContent(locale === "en" ? "Completed" : "Abgeschlossen");
    expect(within(card).queryByRole("list")).toBeNull();
    expect(card.querySelector("a, pre, code")).toBeNull();
  });
});
