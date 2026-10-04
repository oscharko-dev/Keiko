import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deriveContextProfileFromCapability } from "@oscharko-dev/keiko-contracts/runtime/context-engineering";
import type { ModelCapability } from "@oscharko-dev/keiko-contracts/runtime/gateway";
import type { ChatContextStatusWire } from "@oscharko-dev/keiko-contracts/bff-wire";
import { ChatContextMeter } from "./ChatContextMeter";
import { ChatContextMeterContainer } from "./ChatContextMeterContainer";
import { ApiError } from "@/lib/api-shared-primitives";
import {
  I18N_STORAGE_KEY,
  I18nProvider,
  loadLocaleMessages,
  resetLoadedMessageCatalogs,
} from "@/lib/i18n";

const contextApi = vi.hoisted(() => ({ fetch: vi.fn(), compact: vi.fn(), report: vi.fn() }));
vi.mock("@/lib/api", async () => ({
  ...(await vi.importActual<typeof import("@/lib/api")>("@/lib/api")),
  fetchChatContextStatus: contextApi.fetch,
  compactChatContext: contextApi.compact,
}));
vi.mock("@/lib/client-diagnostics", () => ({ reportClientDiagnostic: contextApi.report }));

function contextSession(): Parameters<typeof ChatContextMeterContainer>[0]["session"] {
  return {
    activeChat: {
      id: "chat-private-canary",
      projectPath: "/private/path-canary",
      title: "Private title canary",
      selectedModel: "fixture",
      branchLabel: undefined,
      status: "open",
      connectedScope: undefined,
      localKnowledgeScope: undefined,
      createdAt: 1,
      updatedAt: 1,
    },
    selectedModel: "fixture",
    messages: [],
    sending: false,
    regeneratingMessageId: undefined,
    loading: false,
  };
}

function status(used: number): ChatContextStatusWire {
  return {
    modelId: "fixture",
    contextWindowTokens: 12_000,
    inputBudgetTokens: 10_000,
    reservedOutputTokens: 1_600,
    safetyMarginTokens: 400,
    estimatedInputTokens: used,
    canCompact: true,
    compaction: {
      tokensBefore: 8_000,
      tokensAfter: 1_000,
      tokensSaved: 7_000,
      messagesCompacted: 30,
    },
  };
}

function fixture(
  used: number | undefined,
  busy = false,
): ReturnType<typeof render> & { compact: ReturnType<typeof vi.fn> } {
  const compact = vi.fn();
  return {
    ...render(
      <ChatContextMeter
        status={used === undefined ? undefined : status(used)}
        busy={busy}
        compacting={false}
        error={false}
        onCompact={compact}
        onRetry={vi.fn()}
      />,
    ),
    compact,
  };
}

// Field report 1.1.13: a grounded chat's meter showed one number although retrieved sources filled
// most of each request. The panel now draws the whole window as ordered shares.
function groundedStatus(): ChatContextStatusWire {
  return {
    ...status(8_000),
    contextWindowTokens: 16_384,
    inputBudgetTokens: 11_776,
    reservedOutputTokens: 4_096,
    safetyMarginTokens: 512,
    estimatedInputTokens: 5_610,
    compaction: undefined,
    knowledgeSources: { tokens: 4_100, sentReferenceCount: 4, availableReferenceCount: 16 },
    lastRequest: { promptTokens: 5_901, measured: true },
    autoCompactionAtTokens: 10_598,
    segments: [
      { id: "system", tokens: 310 },
      { id: "summary", tokens: 0, count: 0 },
      { id: "messages", tokens: 1_200, count: 4 },
      { id: "knowledge", tokens: 4_100, count: 4 },
      { id: "free", tokens: 4_988 },
      { id: "compaction-buffer", tokens: 1_178 },
      { id: "output-reserve", tokens: 4_096 },
      { id: "safety-margin", tokens: 512 },
    ],
  };
}

function openGroundedPanel(status: ChatContextStatusWire = groundedStatus()): HTMLElement {
  render(
    <ChatContextMeter
      status={status}
      busy={false}
      compacting={false}
      error={false}
      onCompact={vi.fn()}
      onRetry={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: /Conversation context:/ }));
  return screen.getByRole("region", { name: "Conversation context" });
}

describe("Chat context window breakdown", () => {
  it("lists every non-empty share of the window with its tokens and share", () => {
    const panel = openGroundedPanel();
    const legend = within(panel).getByRole("list", { name: "Context window breakdown" });
    const rows = within(legend).getAllByRole("listitem");
    expect(rows.map((row) => row.getAttribute("data-segment"))).toEqual([
      "system",
      "messages",
      "knowledge",
      "free",
      "compaction-buffer",
      "output-reserve",
      "safety-margin",
    ]);
    expect(
      within(panel).getByText("5,610 of 11,776 usable input tokens · context window 16,384"),
    ).toBeInTheDocument();
    const knowledge = rows.find((row) => row.getAttribute("data-segment") === "knowledge");
    expect(knowledge).toHaveTextContent("Knowledge sources");
    expect(knowledge).toHaveTextContent("4 of 16 references sent");
    expect(knowledge).toHaveTextContent("4,100");
    expect(knowledge).toHaveTextContent("25%");
  });

  it("explains a grounded conversation lane separately from available source capacity", () => {
    const panel = openGroundedPanel({
      ...groundedStatus(),
      conversationInputBudgetTokens: 8_000,
      autoCompactionAtTokens: 8_052,
      contextWindowTokens: 128_000,
      inputBudgetTokens: 116_000,
      reservedOutputTokens: 8_000,
      safetyMarginTokens: 4_000,
      segments: [
        { id: "system", tokens: 310 },
        { id: "messages", tokens: 3_871, count: 4 },
        { id: "knowledge", tokens: 542, count: 4 },
        { id: "free", tokens: 3_329 },
        { id: "compaction-buffer", tokens: 800 },
        { id: "source-capacity", tokens: 107_148 },
        { id: "output-reserve", tokens: 8_000 },
        { id: "safety-margin", tokens: 4_000 },
      ],
      estimatedInputTokens: 4_723,
    });
    expect(within(panel).getByText("Additional source capacity")).toBeInTheDocument();
    expect(within(panel).getByText("Conversation headroom")).toBeInTheDocument();
    expect(
      within(panel).getByText(
        "Keiko compacts the conversation at 90% of its 8,000-token lane. Source capacity is separate.",
      ),
    ).toBeInTheDocument();
    expect(
      within(panel).getByText("3,329 conversation tokens until automatic compaction."),
    ).toBeInTheDocument();
    expect(within(panel).queryByText(/90% of usable input capacity/)).toBeNull();
  });

  it("warns when references were left out and states the measured request size", () => {
    const panel = openGroundedPanel();
    expect(within(panel).getByRole("note")).toHaveTextContent(
      "Only 4 of 16 references fit the model's context window. The most relevant were used.",
    );
    expect(
      within(panel).getByText("Last knowledge request: 5,901 tokens (measured by the provider)."),
    ).toBeInTheDocument();
    expect(within(panel).getByText("4,988 tokens until automatic compaction.")).toBeInTheDocument();
    expect(within(panel).getByText(/never summarized/u)).toBeInTheDocument();
  });

  it("states Keiko's estimate beside a differing provider measurement", () => {
    const panel = openGroundedPanel({
      ...groundedStatus(),
      lastRequest: { promptTokens: 5_901, measured: true, estimatedTokens: 6_420 },
    });
    expect(
      within(panel).getByText(
        "Last knowledge request: 5,901 tokens (measured by the provider). Keiko estimated 6,420; the breakdown above uses that estimate.",
      ),
    ).toBeInTheDocument();
  });

  it("marks an unmeasured request size as an estimate", () => {
    const panel = openGroundedPanel({
      ...groundedStatus(),
      lastRequest: { promptTokens: 6_420, measured: false },
    });
    expect(
      within(panel).getByText("Last knowledge request: about 6,420 tokens (estimated)."),
    ).toBeInTheDocument();
  });

  it("has no accessibility violations", async () => {
    const panel = openGroundedPanel();
    expect(await axe(panel)).toHaveNoViolations();
  });
});

// PR #3678 audit (findings 7, 10, 12): the request line describes the last KNOWLEDGE request, the
// percent sign follows the locale, singular counts use their own strings, and the metric rows and
// footnotes of both presentations are covered.
function renderMeter(
  status: ChatContextStatusWire | undefined,
  locale: "en" | "de" = "en",
): HTMLElement {
  window.localStorage.setItem(I18N_STORAGE_KEY, locale);
  render(
    <I18nProvider>
      <ChatContextMeter
        status={status}
        busy={false}
        compacting={false}
        error={false}
        onCompact={vi.fn()}
        onRetry={vi.fn()}
      />
    </I18nProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: /Gesprächskontext:|Conversation context:/u }));
  return screen.getByRole("region", { name: /Gesprächskontext|Conversation context/u });
}

function withSegments(
  segments: ChatContextStatusWire["segments"],
  overrides: Partial<ChatContextStatusWire> = {},
): ChatContextStatusWire {
  return {
    ...status(735),
    contextWindowTokens: 1_000,
    inputBudgetTokens: 900,
    compaction: undefined,
    segments,
    ...overrides,
  };
}

describe("Chat context meter presentation details", () => {
  afterEach(() => {
    window.localStorage.removeItem(I18N_STORAGE_KEY);
    resetLoadedMessageCatalogs();
  });

  it("puts no space before the percent sign in English and one in German", async () => {
    const english = renderMeter(withSegments([{ id: "messages", tokens: 735, count: 4 }]));
    expect(within(english).getByRole("heading")).toHaveTextContent("Conversation context 81.7%");
    expect(within(english).getByText("73.5%")).toBeInTheDocument();
    cleanup();
    await loadLocaleMessages("de");
    const german = renderMeter(withSegments([{ id: "messages", tokens: 735, count: 4 }]), "de");
    expect(within(german).getByRole("heading")).toHaveTextContent("Gesprächskontext 81,7 %");
    expect(within(german).getByText("73,5 %")).toBeInTheDocument();
  });

  it("writes the German share labels as single compound words", async () => {
    await loadLocaleMessages("de");
    const panel = renderMeter(
      withSegments([
        { id: "system", tokens: 100 },
        { id: "knowledge", tokens: 200, count: 2 },
      ]),
      "de",
    );
    expect(within(panel).getByText("Systemanweisungen")).toBeInTheDocument();
    expect(within(panel).getByText("Wissensquellen")).toBeInTheDocument();
    expect(within(panel).queryByText(/System-Anweisungen|Quellen \(Wissen\)/u)).toBeNull();
  });

  it("uses the singular strings for one message and one summarized message", () => {
    const panel = renderMeter(
      withSegments([
        { id: "summary", tokens: 120, count: 1 },
        { id: "messages", tokens: 300, count: 1 },
      ]),
    );
    const rows = within(panel).getAllByRole("listitem");
    const summary = rows.find((row) => row.getAttribute("data-segment") === "summary");
    const messages = rows.find((row) => row.getAttribute("data-segment") === "messages");
    expect(summary).toHaveTextContent("Summary of earlier messages1 message summarized");
    expect(messages).toHaveTextContent("Messages1 message");
    expect(messages).not.toHaveTextContent("1 messages");
  });

  it("uses the plural strings from two messages on", () => {
    const panel = renderMeter(
      withSegments([
        { id: "summary", tokens: 120, count: 3 },
        { id: "messages", tokens: 300, count: 2 },
      ]),
    );
    expect(within(panel).getByText("3 messages summarized")).toBeInTheDocument();
    expect(within(panel).getByText("2 messages")).toBeInTheDocument();
  });

  it("uses the singular saved-tokens string for one summarized message", () => {
    const panel = renderMeter({
      ...status(8_000),
      compaction: { tokensBefore: 900, tokensAfter: 300, tokensSaved: 600, messagesCompacted: 1 },
    });
    expect(
      within(panel).getByText("600 tokens saved across 1 summarized message."),
    ).toBeInTheDocument();
  });

  it("uses the singular saved-tokens string in German too", async () => {
    await loadLocaleMessages("de");
    const panel = renderMeter(
      {
        ...status(8_000),
        compaction: { tokensBefore: 900, tokensAfter: 300, tokensSaved: 600, messagesCompacted: 1 },
      },
      "de",
    );
    expect(
      within(panel).getByText("600 Tokens bei 1 zusammengefassten Nachricht eingespart."),
    ).toBeInTheDocument();
  });

  it("labels the last request as a knowledge request in German", async () => {
    await loadLocaleMessages("de");
    const panel = renderMeter(
      withSegments([{ id: "knowledge", tokens: 300, count: 4 }], {
        knowledgeSources: { tokens: 300, sentReferenceCount: 4, availableReferenceCount: 4 },
        lastRequest: { promptTokens: 5_901, measured: true, estimatedTokens: 6_420 },
      }),
      "de",
    );
    expect(
      within(panel).getByText(
        "Letzte Wissensanfrage: 5.901 Tokens (vom Anbieter gemessen). Keiko hat 6.420 geschätzt; die Aufteilung oben nutzt diese Schätzung.",
      ),
    ).toBeInTheDocument();
  });

  it("lists the metric rows of a status without segments", () => {
    const panel = renderMeter(status(8_000));
    const rows = within(panel)
      .getAllByRole("term")
      .map((term) => [term.textContent, term.nextElementSibling?.textContent]);
    expect(rows).toEqual([
      ["Estimated tokens used", "8,000"],
      ["Usable input tokens", "10,000"],
      ["Full context window", "12,000"],
      ["Reserved for the answer", "1,600"],
      ["Safety margin", "400"],
    ]);
    expect(within(panel).queryByRole("list", { name: "Context window breakdown" })).toBeNull();
  });

  it("draws the breakdown, including a summary row, instead of the metric rows when segments exist", () => {
    const panel = renderMeter(
      withSegments([
        { id: "system", tokens: 100 },
        { id: "summary", tokens: 120, count: 5 },
        { id: "messages", tokens: 300, count: 4 },
      ]),
    );
    expect(within(panel).queryAllByRole("term")).toHaveLength(0);
    const legend = within(panel).getByRole("list", { name: "Context window breakdown" });
    const summary = within(legend)
      .getAllByRole("listitem")
      .find((row) => row.getAttribute("data-segment") === "summary");
    expect(summary).toHaveTextContent("Summary of earlier messages5 messages summarized12012%");
  });

  it.each([
    ["without segments", undefined],
    ["with segments", [{ id: "messages", tokens: 300, count: 4 }] as const],
  ])("shows the pending compaction and the assumed window %s", (_label, segments) => {
    const panel = renderMeter(
      segments === undefined
        ? {
            ...status(8_000),
            compaction: undefined,
            pendingCompaction: { tokensBefore: 9_400, tokensAfter: 3_100, messagesCompacted: 12 },
            contextWindowAssumed: true,
          }
        : withSegments(segments, {
            pendingCompaction: { tokensBefore: 9_400, tokensAfter: 3_100, messagesCompacted: 12 },
            contextWindowAssumed: true,
          }),
    );
    expect(
      within(panel).getByText(
        "The stored history (9,400 tokens) is compacted automatically to about 3,100 tokens before the next request.",
      ),
    ).toBeInTheDocument();
    expect(
      within(panel).getByText(/declares no context window for this model/u),
    ).toBeInTheDocument();
  });

  it("omits the pending compaction and assumed-window notes when neither applies", () => {
    const panel = renderMeter({ ...status(8_000), compaction: undefined });
    expect(within(panel).queryByText(/compacted automatically to about/u)).toBeNull();
    expect(within(panel).queryByText(/declares no context window/u)).toBeNull();
  });
});

describe("Chat context meter", () => {
  it("shows a nonzero fractional estimate for a small occupied context", () => {
    fixture(44);
    fireEvent.click(
      screen.getByRole("button", { name: "Conversation context: approximately 0.4% used" }),
    );
    expect(screen.getByRole("heading", { name: "Conversation context 0.4%" })).toBeInTheDocument();
  });
  it("renders the expanded panel outside the clipping chat canvas", () => {
    const { container } = fixture(8_000);
    fireEvent.click(screen.getByRole("button", { name: /Conversation context:/ }));
    const panel = screen.getByRole("region", { name: "Conversation context" });
    expect(container).not.toContainElement(panel);
    expect(document.body).toContainElement(panel);
  });
  it.each([
    [0, "normal"],
    [7_999, "normal"],
    [8_000, "warning"],
    [8_999, "warning"],
    [9_000, "critical"],
    [12_000, "critical"],
  ])("uses the branding, warning and danger states at %s tokens", (tokens, tone) => {
    const { container } = fixture(Number(tokens));
    expect(container.querySelector("[data-tone]")).toHaveAttribute("data-tone", tone);
  });

  it("shows estimates, reserves and savings with a working manual action", () => {
    const { compact } = fixture(8_000);
    fireEvent.click(screen.getByRole("button", { name: /Conversation context:/ }));
    expect(screen.getByText("8,000")).toBeInTheDocument();
    expect(
      screen.getByText("7,000 tokens saved across 30 summarized messages."),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Compact context now" }));
    expect(compact).toHaveBeenCalledOnce();
  });

  it("blocks manual maintenance during an answer", () => {
    const { compact } = fixture(9_000, true);
    fireEvent.click(screen.getByRole("button", { name: /Conversation context:/ }));
    const button = screen.getByRole("button", { name: "Compact context now" });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(compact).not.toHaveBeenCalled();
  });

  it("uses an unknown state instead of inventing zero usage", () => {
    const { container } = fixture(undefined);
    expect(container.querySelector("[data-tone]")).toHaveAttribute("data-tone", "unknown");
    expect(container.querySelector("button")).toHaveAttribute(
      "aria-label",
      "Context estimate unavailable",
    );
  });

  it("closes on Escape and restores focus to the ring", () => {
    const { container } = fixture(8_000);
    fireEvent.click(screen.getByRole("button", { name: /Conversation context:/ }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("region", { name: "Conversation context" })).not.toBeInTheDocument();
    expect(container.querySelector("button")).toHaveFocus();
  });

  it("lets keyboard users reach the portaled action and return to the composer", async () => {
    const user = userEvent.setup();
    fixture(8_000);
    const trigger = screen.getByRole("button", { name: /Conversation context:/ });
    render(<button type="button">Following composer action</button>);
    await user.click(trigger);
    await user.tab();
    expect(screen.getByRole("button", { name: "Compact context now" })).toHaveFocus();
    await user.tab({ shift: true });
    expect(trigger).toHaveFocus();
    await user.tab();
    await user.tab();
    expect(screen.getByRole("button", { name: "Following composer action" })).toHaveFocus();
    expect(screen.queryByRole("region", { name: "Conversation context" })).not.toBeInTheDocument();
  });

  it("is accessible in both collapsed and expanded states", async () => {
    fixture(9_000);
    expect(await axe(document.body)).toHaveNoViolations();
    fireEvent.click(screen.getByRole("button", { name: /Conversation context:/ }));
    expect(await axe(document.body)).toHaveNoViolations();
  });
});

describe("Chat context request diagnostics", () => {
  beforeEach(() => {
    contextApi.fetch.mockReset().mockResolvedValue(status(8_000));
    contextApi.compact.mockReset().mockResolvedValue(status(1_000));
    contextApi.report.mockClear();
  });

  it("refreshes a newly persisted user turn while the answer is pending without per-token requests", async () => {
    const session = contextSession();
    const view = render(<ChatContextMeterContainer session={session} />);
    await screen.findByRole("button", { name: /approximately 80% used/ });
    contextApi.fetch.mockResolvedValue(status(9_000));
    const message = {
      id: "persisted-user",
      chatId: "chat-private-canary",
      role: "user" as const,
      content: "A long code question",
      timestamp: 1,
      runId: undefined,
      workflowId: undefined,
      workflowStatus: undefined,
      shortResult: undefined,
      taskType: undefined,
    };
    view.rerender(
      <ChatContextMeterContainer session={{ ...session, sending: true, messages: [message] }} />,
    );
    await screen.findByRole("button", { name: /approximately 90% used/ });
    const requests = contextApi.fetch.mock.calls.length;
    view.rerender(
      <ChatContextMeterContainer
        session={{ ...session, sending: true, messages: [{ ...message }] }}
      />,
    );
    expect(contextApi.fetch).toHaveBeenCalledTimes(requests);
  });

  it("refreshes when connected sources change before another message is sent", async () => {
    const session = contextSession();
    if (session.activeChat === undefined) throw new Error("missing fixture chat");
    const view = render(<ChatContextMeterContainer session={session} />);
    await screen.findByRole("button", { name: /approximately 80% used/ });
    contextApi.fetch.mockResolvedValue(status(1_000));
    view.rerender(
      <ChatContextMeterContainer
        session={{
          ...session,
          activeChat: {
            ...session.activeChat,
            connectedScopes: [
              {
                kind: "workspace-root",
                relativePaths: [],
                connectedAtMs: 2,
              },
            ],
          },
        }}
      />,
    );
    await screen.findByRole("button", { name: /approximately 10% used/ });
    expect(contextApi.fetch).toHaveBeenCalledTimes(2);
  });

  it("reports a correlated status failure without its response body or chat identity", async () => {
    const error = new ApiError("INTERNAL", "Private response body canary", 503);
    error.correlationId = "corr-context-status-failure";
    contextApi.fetch.mockRejectedValue(error);
    render(<ChatContextMeterContainer session={contextSession()} />);
    await waitFor(() => expect(contextApi.report).toHaveBeenCalledOnce());
    expect(contextApi.report).toHaveBeenCalledWith(
      "Keiko context status request failed.",
      expect.objectContaining({
        correlationId: "corr-context-status-failure",
        errorKind: "unavailable",
        errorEvidence: expect.objectContaining({ errorClass: "ApiError" }),
      }),
    );
    expect(JSON.stringify(contextApi.report.mock.calls)).not.toContain("canary");
  });

  it("reports a manual maintenance transport failure", async () => {
    contextApi.compact.mockRejectedValue(new TypeError("Private network canary"));
    render(<ChatContextMeterContainer session={contextSession()} />);
    const ring = await screen.findByRole("button", { name: /Conversation context:/ });
    fireEvent.click(ring);
    fireEvent.click(screen.getByRole("button", { name: "Compact context now" }));
    await waitFor(() => expect(contextApi.report).toHaveBeenCalledOnce());
    expect(contextApi.report).toHaveBeenCalledWith(
      "Keiko manual context compaction request failed.",
      expect.objectContaining({ errorKind: "unavailable" }),
    );
    expect(JSON.stringify(contextApi.report.mock.calls)).not.toContain("canary");
  });

  it("runs manual compaction when a status refresh is still pending", async () => {
    const session = contextSession();
    const view = render(<ChatContextMeterContainer session={session} />);
    await screen.findByRole("button", { name: /approximately 80% used/ });
    let finishStatus!: (value: ChatContextStatusWire) => void;
    contextApi.fetch.mockImplementationOnce(
      () =>
        new Promise<ChatContextStatusWire>((resolve) => {
          finishStatus = resolve;
        }),
    );
    view.rerender(
      <ChatContextMeterContainer
        session={{
          ...session,
          messages: [
            {
              id: "new-turn",
              chatId: "chat-private-canary",
              role: "user",
              content: "A new turn",
              timestamp: 1,
              runId: undefined,
              workflowId: undefined,
              workflowStatus: undefined,
              shortResult: undefined,
              taskType: undefined,
            },
          ],
        }}
      />,
    );
    await waitFor(() => expect(contextApi.fetch).toHaveBeenCalledTimes(2));
    const pendingSignal = contextApi.fetch.mock.calls.at(-1)?.[3] as AbortSignal;
    fireEvent.click(screen.getByRole("button", { name: /Conversation context:/ }));
    fireEvent.click(screen.getByRole("button", { name: "Compact context now" }));
    await waitFor(() => expect(contextApi.compact).toHaveBeenCalledOnce());
    expect(pendingSignal.aborted).toBe(true);
    await act(async () => finishStatus(status(9_000)));
    expect(screen.getByRole("button", { name: /approximately 10% used/ })).toBeInTheDocument();
  });

  it("does not report a superseded or unmounted request as a failure", async () => {
    let reject: ((error: Error) => void) | undefined;
    contextApi.fetch.mockImplementation(
      () =>
        new Promise((_, rejectRequest) => {
          reject = rejectRequest;
        }),
    );
    const view = render(<ChatContextMeterContainer session={contextSession()} />);
    view.unmount();
    reject?.(new Error("Private aborted request canary"));
    await waitFor(() => expect(contextApi.fetch).toHaveBeenCalledOnce());
    expect(contextApi.report).not.toHaveBeenCalled();
  });
});

it("lets a slow pending status settle, then stops polling once the persisted context changes", async () => {
  vi.useFakeTimers();
  contextApi.fetch.mockReset().mockResolvedValueOnce(status(8_000));
  const session = contextSession();
  const view = render(<ChatContextMeterContainer session={session} />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  let finish!: (value: ChatContextStatusWire) => void;
  contextApi.fetch.mockImplementation(
    () =>
      new Promise<ChatContextStatusWire>((resolve) => {
        finish = resolve;
      }),
  );
  view.rerender(<ChatContextMeterContainer session={{ ...session, sending: true }} />);
  const signal = contextApi.fetch.mock.calls.at(-1)?.[3] as AbortSignal;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3_000);
  });
  expect(signal.aborted).toBe(false);
  expect(contextApi.fetch).toHaveBeenCalledTimes(2);
  await act(async () => {
    finish(status(9_000));
    await vi.advanceTimersByTimeAsync(0);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(120_000);
  });
  expect(contextApi.fetch).toHaveBeenCalledTimes(2);
  view.unmount();
});

// PR #3678 review: an idle chat whose first reading still carries the assumed window reads again
// until the server's window probe is in, instead of keeping the assumption until the next send.
it("reads an idle chat's status again while its window probe is pending", async () => {
  vi.useFakeTimers();
  contextApi.fetch
    .mockReset()
    .mockResolvedValueOnce({
      ...status(8_000),
      contextWindowAssumed: true,
      contextWindowProbePending: true,
    })
    .mockResolvedValueOnce({ ...status(8_000), contextWindowTokens: 32_768 });
  const view = render(<ChatContextMeterContainer session={contextSession()} />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(contextApi.fetch).toHaveBeenCalledTimes(1);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_000);
  });
  expect(contextApi.fetch).toHaveBeenCalledTimes(2);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(120_000);
  });
  expect(contextApi.fetch).toHaveBeenCalledTimes(2);
  view.unmount();
});

// PR #3678 audit (finding 12): the bounded polling cap holds even while the probe never answers.
it("stops reading after the polling cap while the window probe stays pending", async () => {
  vi.useFakeTimers();
  contextApi.fetch.mockReset().mockResolvedValue({
    ...status(8_000),
    contextWindowAssumed: true,
    contextWindowProbePending: true,
  });
  const view = render(<ChatContextMeterContainer session={contextSession()} />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(contextApi.fetch).toHaveBeenCalledTimes(1);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(120_000);
  });
  // One first read and six bounded re-reads (1 s, 2 s, 4 s, then 8 s steps), never more.
  expect(contextApi.fetch).toHaveBeenCalledTimes(7);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(600_000);
  });
  expect(contextApi.fetch).toHaveBeenCalledTimes(7);
  view.unmount();
});

afterEach(() => vi.useRealTimers());

describe("independent model input ceilings", () => {
  it("shows the physical window, usable input and unavailable share without inventing free capacity", () => {
    render(
      <ChatContextMeter
        status={{
          ...status(2_000),
          contextWindowTokens: 32_000,
          inputBudgetTokens: 8_000,
          inputLimitTokens: 8_000,
          reservedOutputTokens: 2_000,
          safetyMarginTokens: 1_000,
          compaction: undefined,
          segments: [
            { id: "system", tokens: 300 },
            { id: "messages", tokens: 1_700, count: 2 },
            { id: "free", tokens: 5_200 },
            { id: "compaction-buffer", tokens: 800 },
            { id: "input-capacity-unavailable", tokens: 21_000 },
            { id: "output-reserve", tokens: 2_000 },
            { id: "safety-margin", tokens: 1_000 },
          ],
        }}
        busy={false}
        compacting={false}
        error={false}
        onCompact={vi.fn()}
        onRetry={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Conversation context:/ }));
    const panel = screen.getByRole("region", { name: "Conversation context" });
    expect(within(panel).getByText("Unavailable for input")).toBeInTheDocument();
    expect(within(panel).getByText("Model input limit: 8,000 tokens.")).toBeInTheDocument();
    expect(within(panel).getByText("21,000")).toBeInTheDocument();
    expect(panel.textContent).toContain("32,000");
    expect(screen.getByRole("button", { name: /approximately 25% used/ })).toBeInTheDocument();
  });
});

function meterCapability(id: string, window: number): ModelCapability {
  return {
    id,
    kind: "chat",
    contextWindow: window,
    maxInputTokens: Math.floor(window / 2),
    maxOutputTokens: Math.floor(window / 8),
    toolCalling: false,
    structuredOutput: false,
    streaming: true,
    supportsImageInput: false,
    supportsDocumentInput: false,
    workflowEligible: false,
    costClass: "medium",
    latencyClass: "standard",
    throughputHint: "",
    preferredUseCases: [],
    knownLimitations: [],
  };
}

function meterModelStatus(model: ModelCapability): ChatContextStatusWire {
  const profile = deriveContextProfileFromCapability(model);
  return {
    modelId: model.id,
    contextWindowTokens: profile.maxInputTokens,
    inputLimitTokens: model.maxInputTokens,
    inputBudgetTokens: profile.effectiveInputBudget,
    reservedOutputTokens: profile.reservedOutputTokens,
    safetyMarginTokens: profile.safetyMarginTokens,
    estimatedInputTokens: 100,
    canCompact: false,
  };
}

it("refreshes an idle selected alias when its catalog geometry changes", async () => {
  const session = contextSession();
  const initial = meterCapability("fixture", 12_000);
  const updated = meterCapability("fixture", 48_000);
  contextApi.fetch
    .mockReset()
    .mockResolvedValueOnce(meterModelStatus(initial))
    .mockResolvedValueOnce(meterModelStatus(updated));
  const view = render(<ChatContextMeterContainer session={{ ...session, models: [initial] }} />);
  await waitFor(() => expect(contextApi.fetch).toHaveBeenCalledOnce());
  view.rerender(<ChatContextMeterContainer session={{ ...session, models: [updated] }} />);
  await waitFor(() => expect(contextApi.fetch).toHaveBeenCalledTimes(2));
  fireEvent.click(screen.getByRole("button", { name: /Conversation context:/ }));
  const panel = screen.getByRole("region", { name: "Conversation context" });
  expect(within(panel).getByText("48,000")).toBeInTheDocument();
  expect(within(panel).getByText("Model input limit: 24,000 tokens.")).toBeInTheDocument();
});

it("ignores catalog geometry changes for an unselected alias", async () => {
  const session = contextSession();
  const selected = meterCapability("fixture", 12_000);
  contextApi.fetch.mockReset().mockResolvedValue(meterModelStatus(selected));
  const view = render(
    <ChatContextMeterContainer
      session={{ ...session, models: [selected, meterCapability("other", 32_000)] }}
    />,
  );
  await waitFor(() => expect(contextApi.fetch).toHaveBeenCalledOnce());
  view.rerender(
    <ChatContextMeterContainer
      session={{ ...session, models: [selected, meterCapability("other", 96_000)] }}
    />,
  );
  await act(async () => Promise.resolve());
  expect(contextApi.fetch).toHaveBeenCalledOnce();
});

it("shows fifteen selected models' distinct geometry without reusing the previous model", async () => {
  const windows = [
    4_096, 8_192, 16_384, 24_576, 32_768, 48_000, 64_000, 96_000, 128_000, 160_000, 200_000,
    256_000, 500_000, 1_000_000, 2_000_000,
  ];
  const models = windows.map((window, index) => meterCapability(`alias-${String(index)}`, window));
  const session = contextSession();
  contextApi.fetch
    .mockReset()
    .mockImplementation((_chat: string, _path: string, modelId: string) => {
      const model = models.find((candidate) => candidate.id === modelId);
      if (model === undefined) throw new Error("Missing selected test model");
      return Promise.resolve(meterModelStatus(model));
    });
  const view = render(
    <ChatContextMeterContainer session={{ ...session, selectedModel: models[0]?.id, models }} />,
  );
  for (const model of models) {
    view.rerender(
      <ChatContextMeterContainer session={{ ...session, selectedModel: model.id, models }} />,
    );
    await waitFor(() =>
      expect(contextApi.fetch).toHaveBeenLastCalledWith(
        session.activeChat?.id,
        session.activeChat?.projectPath,
        model.id,
        expect.any(AbortSignal),
      ),
    );
    await screen.findByRole("button", { name: /Conversation context: approximately/ });
    fireEvent.click(screen.getByRole("button", { name: /Conversation context:/ }));
    const panel = screen.getByRole("region", { name: "Conversation context" });
    expect(within(panel).getByText(model.contextWindow.toLocaleString("en"))).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Conversation context:/ }));
  }
});
