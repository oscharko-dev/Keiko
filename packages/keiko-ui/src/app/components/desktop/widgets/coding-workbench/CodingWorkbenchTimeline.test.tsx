import { act, fireEvent, render, screen } from "@testing-library/react";
import { axe } from "jest-axe";
import { describe, expect, it, vi } from "vitest";
import type {
  AvailableCodingSafeActivityFeed,
  CodingWorkbenchRuntimeSseEvent,
} from "@oscharko-dev/keiko-contracts";

import type { UseCodingWorkbenchQuestionsResult } from "@/lib/useCodingWorkbenchQuestions";
import type { UseCodingWorkbenchSafeActivityResult } from "@/lib/useCodingWorkbenchSafeActivity";
import { setClientDiagnosticWriter, resetClientDiagnosticWriter } from "@/lib/client-diagnostics";
import {
  fanOutClientDiagnostic,
  resetClientDiagnosticPostStateForTests,
} from "@/lib/install-client-diagnostics";
import { Timeline } from "./CodingWorkbenchTimeline";
import styles from "./CodingWorkbenchWindow.module.css";

const AT = "2026-07-19T12:00:00.000Z";

function event(sequence: number): CodingWorkbenchRuntimeSseEvent {
  return {
    schemaVersion: "1",
    cursor: `cursor-${String(sequence)}`,
    sequence,
    occurredAt: AT,
    kind: "runtime-event",
    runId: "run-1",
    state: "running",
    revision: sequence,
    eventKind: "observation-streamed",
  };
}

function bareFeed(): AvailableCodingSafeActivityFeed {
  return {
    schemaVersion: "1",
    availability: "available",
    runId: "run-1",
    updatedAt: AT,
    turns: [],
    truncated: false,
    droppedEventCount: 0,
  };
}

function feedWithPlan(steps: number): AvailableCodingSafeActivityFeed {
  return {
    schemaVersion: "1",
    availability: "available",
    runId: "run-1",
    updatedAt: AT,
    turns: [
      {
        turnId: "turn-1",
        messages: [
          {
            messageId: "message-1",
            role: "assistant",
            occurredAt: AT,
            segments: [{ kind: "text", text: "Kicking off the run", truncated: false }],
            truncated: false,
          },
        ],
        tools: [],
        truncated: false,
      },
    ],
    plan: {
      revision: 1,
      anchorMessageId: "message-1",
      updatedAt: AT,
      steps: Array.from({ length: steps }, (_, index) => ({
        text: `Step ${String(index + 1)}`,
        state: "pending" as const,
        truncated: false,
      })),
      truncated: false,
    },
    truncated: false,
    droppedEventCount: 0,
  };
}

function feedWithBlankAgentMessage(): AvailableCodingSafeActivityFeed {
  return {
    schemaVersion: "1",
    availability: "available",
    runId: "run-1",
    updatedAt: AT,
    turns: [
      {
        turnId: "turn-1",
        messages: [
          {
            messageId: "message-blank",
            role: "assistant",
            occurredAt: AT,
            segments: [{ kind: "text", text: "   ", truncated: false }],
            truncated: false,
          },
          {
            messageId: "message-visible",
            role: "assistant",
            occurredAt: AT,
            segments: [{ kind: "text", text: "Visible answer", truncated: false }],
            truncated: false,
          },
        ],
        tools: [],
        truncated: false,
      },
    ],
    truncated: false,
    droppedEventCount: 0,
  };
}

function feedWithMarkdownAnswer(role: "assistant" | "user"): AvailableCodingSafeActivityFeed {
  return {
    schemaVersion: "1",
    availability: "available",
    runId: "run-1",
    updatedAt: AT,
    turns: [
      {
        turnId: "turn-markdown",
        messages: [
          {
            messageId: `message-${role}`,
            role,
            occurredAt: AT,
            segments: [
              {
                kind: "text",
                text: "Uses **TypeScript `~6.0.3`**.\n\n- Read `package.json`",
                truncated: false,
              },
            ],
            truncated: false,
          },
        ],
        tools: [],
        truncated: false,
      },
    ],
    truncated: false,
    droppedEventCount: 0,
  };
}

function feedWithRepeatedTools(): AvailableCodingSafeActivityFeed {
  return {
    schemaVersion: "1",
    availability: "available",
    runId: "run-1",
    updatedAt: AT,
    turns: [
      {
        turnId: "turn-tools",
        messages: [],
        tools: [
          {
            callId: "call-1",
            tool: "keiko_workspace_discover",
            state: "succeeded",
            occurredAt: AT,
          },
          {
            callId: "call-2",
            tool: "keiko_workspace_discover",
            state: "succeeded",
            occurredAt: AT,
          },
          {
            callId: "call-3",
            tool: "keiko_workspace_discover",
            state: "failed",
            occurredAt: AT,
          },
        ],
        truncated: false,
      },
    ],
    truncated: false,
    droppedEventCount: 0,
  };
}

const IDLE_QUESTIONS: UseCodingWorkbenchQuestionsResult = {
  status: "empty",
  questions: [],
  errorCode: null,
  mutationFailure: null,
  answer: vi.fn(() => Promise.resolve(true)),
  reject: vi.fn(() => Promise.resolve(true)),
  retry: vi.fn(),
};

function activityLike(feed: AvailableCodingSafeActivityFeed): UseCodingWorkbenchSafeActivityResult {
  return { status: "live", feed, errorCode: null, retry: vi.fn() };
}

function spacers(container: HTMLElement): readonly number[] {
  return [...container.querySelectorAll<HTMLElement>(`.${styles.timelineSpacer}`)].map(
    (element) => {
      const raw = element.style.blockSize;
      return raw.endsWith("px") ? Number.parseFloat(raw) : 0;
    },
  );
}

// Overriding offsetHeight per row lets the jsdom test drive the measured-height cache the
// virtualizer actually depends on. The pre-fix uniform-64 px math would ignore this override
// and produce spacers that scale with the row COUNT alone; a variable-height virtualizer must
// scale spacers with real per-item heights.
function overrideOffsetHeight(node: HTMLElement, height: number): void {
  Object.defineProperty(node, "offsetHeight", {
    configurable: true,
    get: () => height,
  });
}

function paintRowHeights(container: HTMLElement, heightFor: (li: HTMLLIElement) => number): number {
  const rows = container.querySelectorAll<HTMLLIElement>(
    `.${styles.timeline} > li:not([aria-hidden])`,
  );
  for (const row of rows) overrideOffsetHeight(row, heightFor(row));
  return rows.length;
}

describe("CodingWorkbenchTimeline", () => {
  it.each([false, true])(
    "retains terminal activity recovery with existing content: %s",
    (hasContent) => {
      const activity = {
        ...activityLike(hasContent ? feedWithBlankAgentMessage() : bareFeed()),
        status: "disconnected" as const,
      };
      render(
        <Timeline active={false} events={[]} activity={activity} questions={IDLE_QUESTIONS} />,
      );
      fireEvent.click(screen.getByRole("button", { name: "Reconnect activity" }));
      expect(activity.retry).toHaveBeenCalledOnce();
    },
  );

  it.each([
    [{ truncated: true }, "Activity truncated."],
    [{ droppedEventCount: 2 }, "2 update(s) omitted."],
  ])("retains terminal reconstruction warnings for an empty feed: %s", (loss, warning) => {
    render(
      <Timeline
        active={false}
        events={[]}
        activity={activityLike({ ...bareFeed(), ...loss })}
        questions={IDLE_QUESTIONS}
      />,
    );
    expect(screen.getByText(warning)).toBeVisible();
  });

  it("uses per-kind default heights for the pre-measurement virtualized window", () => {
    // 101 events forces the virtual mode; only 96 rows render and the tail sits behind a spacer.
    const events = Array.from({ length: 101 }, (_, index) => event(index + 1));
    const { container } = render(
      <Timeline events={events} activity={activityLike(bareFeed())} questions={IDLE_QUESTIONS} />,
    );
    fireEvent.click(screen.getByText("Run details"));

    const [tailSpacer] = spacers(container);
    // Pre-fix behaviour was `(items - end) * 64` = 5 * 64 = 320. The event default is 88, so the
    // tail spacer for 5 event rows must be 440 (5 * 88) — this assertion fails with the old
    // uniform-64 arithmetic and passes with the per-kind-defaults virtualizer.
    expect(tailSpacer).toBe(440);
  });

  it("uses measured row heights when translating scroll offsets to a start index", () => {
    // Two paint-and-rerender passes are required for the measurement cache to converge here:
    // the first pass measures the initially rendered rows (0..95); the second pass — after
    // scrolling shifts the visible window — measures the newly rendered rows. Rows that are
    // never in either window (skipped middle rows) stay at the per-kind default height, which
    // is correct behaviour and does not affect this assertion because the head spacer only
    // sums cumulative heights up to the start index, and after a deep scroll the start index
    // lands inside the measured tail window.
    // With 500 events measured at 240 px each, scrolling to y = 50000 must land the start
    // index deep in the measured range: 50000/240 = 208, minus overscan → ~200. The head
    // spacer is then cumulative[200] = 200 * 240 = 48 000. The pre-fix uniform 64 px caps
    // start at items.length - VISIBLE_ROWS = 404 and produces 404 * 64 = 25 856 — which is
    // strictly less than any assertion above 40 000.
    const events = Array.from({ length: 500 }, (_, index) => event(index + 1));
    const view = render(
      <Timeline events={events} activity={activityLike(bareFeed())} questions={IDLE_QUESTIONS} />,
    );
    fireEvent.click(screen.getByText("Run details"));
    paintRowHeights(view.container, () => 240);
    view.rerender(
      <Timeline events={events} activity={activityLike(bareFeed())} questions={IDLE_QUESTIONS} />,
    );
    const list = view.container.querySelector<HTMLElement>(`.${styles.timeline}`);
    if (list === null) throw new Error("timeline list not found");
    Object.defineProperty(list, "scrollTop", { configurable: true, value: 50_000 });
    act(() => {
      list.dispatchEvent(new UIEvent("scroll", { bubbles: true }));
    });
    paintRowHeights(view.container, () => 240);
    view.rerender(
      <Timeline events={events} activity={activityLike(bareFeed())} questions={IDLE_QUESTIONS} />,
    );

    const [headSpacer] = spacers(view.container);
    expect(headSpacer).toBeGreaterThan(40_000);
  });

  it("virtualizes at most 96 rows even when the pre-measurement estimate would round differently", () => {
    const events = Array.from({ length: 500 }, (_, index) => event(index + 1));
    const { container } = render(
      <Timeline events={events} activity={activityLike(bareFeed())} questions={IDLE_QUESTIONS} />,
    );
    fireEvent.click(screen.getByText("Run details"));

    const rows = container.querySelectorAll(`.${styles.timeline} > li:not([aria-hidden])`);
    expect(rows).toHaveLength(96);
  });

  it("renders a tall plan card in the non-virtualized window", () => {
    // A 64-step plan card is one row logically but visually 800+ px tall; it must render in a
    // short feed regardless of how far off the pre-fix fixed-row estimate would be.
    const events = Array.from({ length: 10 }, (_, index) => event(index + 1));
    const { container } = render(
      <Timeline
        events={events}
        activity={activityLike(feedWithPlan(64))}
        questions={IDLE_QUESTIONS}
      />,
    );
    const planRow = container.querySelector('[data-timeline-kind="plan"]');
    expect(planRow).not.toBeNull();
    expect(planRow?.querySelectorAll("[data-plan-state]")).toHaveLength(64);
  });

  it("does not render empty coding-agent message rows", () => {
    const { container } = render(
      <Timeline
        events={[]}
        activity={activityLike(feedWithBlankAgentMessage())}
        questions={IDLE_QUESTIONS}
      />,
    );

    expect(container.querySelectorAll('[data-timeline-kind="message"]')).toHaveLength(1);
    expect(container).toHaveTextContent("Visible answer");
  });

  it("renders assistant activity messages with the safe markdown renderer", () => {
    const { container } = render(
      <Timeline
        events={[]}
        activity={activityLike(feedWithMarkdownAnswer("assistant"))}
        questions={IDLE_QUESTIONS}
      />,
    );

    const message = container.querySelector('[data-message-role="assistant"]');
    expect(message?.querySelector(".sm-root")).not.toBeNull();
    expect(message?.querySelector("strong")?.textContent).toBe("TypeScript ~6.0.3");
    expect(message?.querySelector(".sm-inline-code")?.textContent).toBe("~6.0.3");
    expect(message?.querySelector("li")?.textContent).toBe("Read package.json");
    expect(message?.textContent).not.toContain("**TypeScript");
  });

  it("keeps operator activity messages as plain text, not markdown", () => {
    const { container } = render(
      <Timeline
        events={[]}
        activity={activityLike(feedWithMarkdownAnswer("user"))}
        questions={IDLE_QUESTIONS}
      />,
    );

    const message = container.querySelector('[data-message-role="user"]');
    expect(message?.querySelector(".sm-root")).toBeNull();
    expect(message?.querySelector("strong")).toBeNull();
    expect(message?.textContent).toContain("**TypeScript `~6.0.3`**");
  });

  it("groups repeated successful tool activity without hiding failures", () => {
    const { container } = render(
      <Timeline
        events={[]}
        activity={activityLike(feedWithRepeatedTools())}
        questions={IDLE_QUESTIONS}
      />,
    );

    const rows = container.querySelectorAll('[data-timeline-kind="tool"]');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("Workspace discovery");
    expect(rows[0]).toHaveTextContent("2 calls");
    expect(rows[1]).toHaveTextContent("Failed");
  });

  it("groups completed work between answers and keeps failures outside the disclosure", () => {
    const repeated = feedWithRepeatedTools();
    const turn = repeated.turns[0];
    if (turn === undefined) throw new Error("expected a fixture turn");
    const feed = {
      ...repeated,
      turns: [
        {
          ...turn,
          tools: turn.tools.map((tool, index) =>
            index === 1 ? { ...tool, tool: "keiko_git_status" } : tool,
          ),
        },
      ],
    };
    const { container, getByText } = render(
      <Timeline events={[event(1)]} activity={activityLike(feed)} questions={IDLE_QUESTIONS} />,
    );
    const group = container.querySelector('[data-timeline-kind="group"] details');
    expect(group).not.toHaveAttribute("open");
    expect(group).toHaveTextContent("2 actions completed");
    expect(group).not.toHaveTextContent("Failed");
    expect(container.querySelector('[data-tool-state="failed"]')).toBeVisible();
    expect(container.querySelector('[data-event-tone="routine"]')).toBeNull();
    fireEvent.click(getByText("Run details"));
    expect(container.querySelector('[data-event-tone="routine"]')).toBeVisible();
  });

  it("marks routine, success, and attention events for quieter visual treatment", () => {
    const failed = { ...event(2), failureCode: "runtime-failed" as const };
    const succeeded = { ...event(3), state: "succeeded" as const };
    const { container } = render(
      <Timeline
        events={[event(1), failed, succeeded]}
        activity={activityLike(bareFeed())}
        questions={IDLE_QUESTIONS}
      />,
    );
    fireEvent.click(screen.getByText("Run details"));

    expect(container.querySelector('[data-event-tone="routine"]')).not.toBeNull();
    expect(container.querySelector('[data-event-tone="attention"]')).not.toBeNull();
    expect(container.querySelector('[data-event-tone="success"]')).not.toBeNull();
  });

  it("collapses successful tool details while leaving failed work expanded", () => {
    const { container } = render(
      <Timeline
        events={[]}
        activity={activityLike(feedWithRepeatedTools())}
        questions={IDLE_QUESTIONS}
      />,
    );
    const rows = container.querySelectorAll('[data-timeline-kind="tool"] details');
    expect(rows).toHaveLength(2);
    expect(rows[0]).not.toHaveAttribute("open");
    expect(rows[1]).toHaveAttribute("open");
    const detail = rows[0] as HTMLDetailsElement;
    detail.open = true;
    fireEvent(detail, new Event("toggle"));
    expect(detail).toHaveTextContent("keiko_workspace_discover");
  });

  // The tool-call card (`.toolCard`) and plan card rows are otherwise exercised only indirectly
  // through CodingWorkbenchWindow.test.tsx's full-window axe pass; this pins the Timeline's own
  // rendering of both directly, matching the per-component axe suites of its siblings.
  it("has no serious or critical axe violations with a tool card and a plan card rendered", async () => {
    const events = [event(1)];
    const feed: AvailableCodingSafeActivityFeed = {
      schemaVersion: "1",
      availability: "available",
      runId: "run-1",
      updatedAt: AT,
      turns: [
        {
          turnId: "turn-1",
          messages: [
            {
              messageId: "message-1",
              role: "assistant",
              occurredAt: AT,
              segments: [{ kind: "text", text: "Kicking off the run", truncated: false }],
              truncated: false,
            },
          ],
          tools: [{ callId: "call-1", tool: "run_tests", state: "succeeded", occurredAt: AT }],
          truncated: false,
        },
      ],
      plan: {
        revision: 1,
        anchorMessageId: "message-1",
        updatedAt: AT,
        steps: [{ text: "Step 1", state: "pending", truncated: false }],
        truncated: false,
      },
      truncated: false,
      droppedEventCount: 0,
    };
    const { container } = render(
      <Timeline events={events} activity={activityLike(feed)} questions={IDLE_QUESTIONS} />,
    );
    expect(container.querySelector('[data-timeline-kind="tool"]')).not.toBeNull();
    expect(container.querySelector('[data-timeline-kind="plan"]')).not.toBeNull();

    const report = await axe(container);
    expect(
      report.violations.filter((violation) =>
        ["serious", "critical"].includes(violation.impact ?? ""),
      ),
    ).toEqual([]);
  });
});

it("joins short provider message IDs through the real diagnostic transport", () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  setClientDiagnosticWriter(fanOutClientDiagnostic);
  try {
    const feed = feedWithPlan(0);
    const turns = feed.turns.map((turn) => ({
      ...turn,
      messages: turn.messages.map((message) => ({
        ...message,
        messageId: "msg_1",
        segments: [{ kind: "text" as const, text: "5. Continued item", truncated: false }],
      })),
    }));
    render(
      <Timeline
        events={[]}
        activity={activityLike({ ...feed, runId: "coding-run-1", turns })}
        questions={IDLE_QUESTIONS}
      />,
    );
    const call = fetchMock.mock.calls.find(([url]) => url === "/api/diagnostics/client");
    const body: unknown = JSON.parse((call?.[1] as RequestInit).body as string);
    expect(body).toMatchObject({
      kind: "markdown-layout",
      correlationId: "coding-run-1",
      markdownLayout: { messageId: "msg_1", listStart: 5 },
    });
  } finally {
    resetClientDiagnosticWriter();
    resetClientDiagnosticPostStateForTests();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  }
});
