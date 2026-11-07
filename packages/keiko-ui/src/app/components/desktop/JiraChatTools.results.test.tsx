import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { axe } from "jest-axe";
import type { ChatToolExchange, ChatToolTranscript } from "@oscharko-dev/keiko-contracts/bff-wire";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import * as diagnostics from "@/lib/client-diagnostics";
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
      expect(screen.getByText("Synthetic project")).toBeVisible();
      expect(screen.getByText("SYN", { exact: true })).toBeVisible();
      expect(document.querySelector("pre")).toBeNull();
      expect(screen.queryByRole("button", { name: /retry|erneut|next page/i })).toBeNull();
    } finally {
      localStorage.removeItem(I18N_STORAGE_KEY);
    }
  },
);

it("links historical results to their saved Jira instance with the same ticket key", () => {
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
  expect(screen.getByText(/LAB-1/u)).toBeVisible();
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

describe.each(["en", "de"] as const)("readable saved Jira results in %s (#4290)", (locale) => {
  it("keeps issue names, status, counts and links after a serialized transcript remount", async () => {
    await Promise.all([loadLocaleMessages(locale), loadOptionalWidgetMessages(locale)]);
    localStorage.setItem(I18N_STORAGE_KEY, locale);
    const transcript: ChatToolTranscript = {
      schemaVersion: 1,
      exchanges: [
        resultExchange("jira_search", {
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

it("keeps every returned issue available behind a readable bounded disclosure", async () => {
  render(
    <JiraChatTools
      transcript={{
        schemaVersion: 1,
        exchanges: [
          resultExchange("jira_search", {
            outcome: "succeeded",
            total: 7,
            startAt: 0,
            items: Array.from({ length: 7 }, (_, index) => ({
              key: `SYN-${String(index + 1)}`,
              summary: `Issue ${String(index + 1)}`,
            })),
          }),
        ],
      }}
      turnState="completed"
    />,
  );
  expect(screen.getByText("SYN-5", { exact: true })).toBeVisible();
  expect(screen.getByText("SYN-7", { exact: true })).not.toBeVisible();
  await userEvent.setup().click(screen.getByText("Show 2 more results"));
  expect(screen.getByText("SYN-7", { exact: true })).toBeVisible();
  expect(screen.queryByRole("button", { name: /retry|next page/iu })).toBeNull();
});

it("records live Jira result counts joined to the parent without private content", () => {
  const report = vi.spyOn(diagnostics, "reportClientDiagnostic");
  try {
    render(
      <JiraChatTools
        messageId="private-message-id"
        transcript={{
          schemaVersion: 1,
          exchanges: [
            resultExchange("jira_issue", {
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
      shownCount: 1,
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
});

it("bounds restored history evidence and deduplicates equivalent live result states", () => {
  const report = vi.spyOn(diagnostics, "reportClientDiagnostic");
  const exchanges = Array.from({ length: 8 }, (_, index) => {
    const result = resultExchange("jira_issue", {
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
          resultExchange("jira_create_fields", {
            outcome: "succeeded",
            items: [{ id: "customfield_123", name: "Epic Name", required: true }],
          }),
          resultExchange("jira_assignable_users", {
            outcome: "succeeded",
            items: [
              { name: "private-account-id", displayName: "Assigned reviewer", active: false },
            ],
          }),
          resultExchange("jira_comments", {
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
    screen.getByText("Verify the Jira Pod connection and its credentials before trying again."),
  ).toBeVisible();
  expect(screen.queryByText("Completed", { exact: true })).toBeNull();
  expect(screen.queryByRole("button", { name: /retry/iu })).toBeNull();
});
