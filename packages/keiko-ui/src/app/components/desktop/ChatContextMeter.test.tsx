import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatContextStatusWire } from "@oscharko-dev/keiko-contracts/bff-wire";
import { ChatContextMeter } from "./ChatContextMeter";
import { ChatContextMeterContainer } from "./ChatContextMeterContainer";
import { ApiError } from "@/lib/api-shared-primitives";

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
    expect(knowledge).toHaveTextContent("25 %");
  });

  it("warns when references were left out and states the measured request size", () => {
    const panel = openGroundedPanel();
    expect(within(panel).getByRole("note")).toHaveTextContent(
      "Only 4 of 16 references fit the model's context window. The most relevant were used.",
    );
    expect(
      within(panel).getByText("Last request: 5,901 tokens (measured by the provider)."),
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
        "Last request: 5,901 tokens (measured by the provider). Keiko conservatively estimated 6,420; the breakdown above uses that estimate.",
      ),
    ).toBeInTheDocument();
  });

  it("marks an unmeasured request size as an estimate", () => {
    const panel = openGroundedPanel({
      ...groundedStatus(),
      lastRequest: { promptTokens: 6_420, measured: false },
    });
    expect(
      within(panel).getByText("Last request: about 6,420 tokens (estimated)."),
    ).toBeInTheDocument();
  });

  it("has no accessibility violations", async () => {
    const panel = openGroundedPanel();
    expect(await axe(panel)).toHaveNoViolations();
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

afterEach(() => vi.useRealTimers());
