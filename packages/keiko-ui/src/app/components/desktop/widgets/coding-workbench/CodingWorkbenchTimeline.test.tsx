import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { axe } from "jest-axe";
import type { ReactElement } from "react";
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
import { eventsWithRestoredSettlement } from "./codingWorkbenchRestoredRun";
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

  it("shows a failed run separately from earlier successful workspace calls", () => {
    const failure: CodingWorkbenchRuntimeSseEvent = {
      ...event(5),
      kind: "status",
      state: "failed",
      occurredAt: "2026-07-19T12:00:01.000Z",
      failureCode: "runtime-failed",
    };
    const { container } = render(
      <Timeline
        events={[failure]}
        activity={activityLike(feedWithRepeatedTools())}
        questions={IDLE_QUESTIONS}
      />,
    );

    const rows = container.querySelectorAll("[data-timeline-kind]");
    expect(rows[0]).toHaveTextContent("Workspace discovery");
    expect(rows[0]).toHaveTextContent("2 calls");
    expect(rows[2]).toHaveTextContent("Coding run failed");
    expect(rows[2]).toHaveAttribute("data-event-tone", "attention");
    expect(rows[2]).not.toHaveTextContent("Seq.");
    expect(rows[2]).not.toHaveTextContent("runtime-failed");
  });

  // F9 (#3873, live Gemma qualification): a run its prompt allowance ended read "The model or a
  // Workbench guard rejected this turn" and then "The coding run ended with an internal error". The
  // settled failure now names the exhausted allowance with its next step, and nothing on the
  // timeline claims an internal error.
  it("names the exhausted prompt allowance on the failed run instead of an internal error", async () => {
    const turnRejected: CodingWorkbenchRuntimeSseEvent = {
      schemaVersion: "1",
      cursor: "cursor-4",
      sequence: 4,
      occurredAt: AT,
      kind: "runtime-event",
      runId: "run-1",
      state: "running",
      revision: 4,
      eventKind: "failure-redacted",
      failureCode: "turn-rejected",
    };
    const failure: CodingWorkbenchRuntimeSseEvent = {
      ...event(5),
      kind: "status",
      state: "failed",
      occurredAt: "2026-07-19T12:00:01.000Z",
      failureCode: "prompt-allowance-exhausted",
    };
    const { container } = render(
      <Timeline
        events={[turnRejected, failure]}
        activity={activityLike(bareFeed())}
        questions={IDLE_QUESTIONS}
      />,
    );

    const settled = [...container.querySelectorAll('[data-timeline-kind="event"]')].at(-1);
    expect(settled).toHaveTextContent("Coding run failed");
    expect(settled).toHaveAttribute("data-event-tone", "attention");
    expect(settled).toHaveTextContent(/used up its prompt allowance/iu);
    expect(settled).toHaveTextContent(/start the task again as a new run/iu);
    expect(settled).toHaveTextContent("KEIKO_CODING_RUNTIME_MAX_PROMPT_TOKENS");
    expect(settled).toHaveTextContent(/up to 20,000,000 tokens/iu);
    expect(settled).toHaveTextContent(/restart Keiko after changing it/iu);
    expect(settled).not.toHaveTextContent("prompt-allowance-exhausted");
    expect(container).not.toHaveTextContent(/internal error/iu);

    const report = await axe(container);
    expect(
      report.violations.filter((violation) =>
        ["serious", "critical"].includes(violation.impact ?? ""),
      ),
    ).toEqual([]);
  });

  it.each([
    ["provider-unavailable", /could not be reached or stopped answering/iu],
    ["model-turn-failed", /its last model step failed/iu],
    ["output-exhausted-repeated", /used its whole output budget again/iu],
  ] as const)("names a run that failed with %s by its cause", (failureCode, copy) => {
    const failure: CodingWorkbenchRuntimeSseEvent = {
      ...event(5),
      kind: "status",
      state: "failed",
      failureCode,
    };
    const { container } = render(
      <Timeline
        events={[failure]}
        activity={activityLike(bareFeed())}
        questions={IDLE_QUESTIONS}
      />,
    );
    expect(container).toHaveTextContent(copy);
    expect(container).not.toHaveTextContent(/internal error/iu);
  });

  // F9 (#3873): run `run-272120967981827964065820685403290179367` reached its 30-minute envelope with
  // a model call in flight and read "The coding run ended with an internal error". The settled
  // failure now names the time limit and the setting that lengthens it.
  it("names the exhausted time limit on a run that reached its envelope's end", async () => {
    const failure: CodingWorkbenchRuntimeSseEvent = {
      ...event(5),
      kind: "status",
      state: "failed",
      failureCode: "envelope-duration-exhausted",
    };
    const { container } = render(
      <Timeline
        events={[failure]}
        activity={activityLike(bareFeed())}
        questions={IDLE_QUESTIONS}
      />,
    );

    const settled = [...container.querySelectorAll('[data-timeline-kind="event"]')].at(-1);
    expect(settled).toHaveTextContent("Coding run failed");
    expect(settled).toHaveTextContent(/used up its time limit/iu);
    expect(settled).toHaveTextContent("KEIKO_CODING_RUNTIME_MAX_DURATION_MINUTES");
    expect(settled).toHaveTextContent(/up to 480 minutes/iu);
    expect(settled).toHaveTextContent(/restart Keiko after changing it/iu);
    expect(settled).not.toHaveTextContent("envelope-duration-exhausted");
    expect(container).not.toHaveTextContent(/internal error/iu);
    const report = await axe(container);
    expect(
      report.violations.filter((violation) =>
        ["serious", "critical"].includes(violation.impact ?? ""),
      ),
    ).toEqual([]);
  });

  // #3873 review: a `cancelled` run does not record who stopped it — the operator's Stop and
  // `CodingRuntimeOrchestrator.shutdown()` settle identically — so the terminal row says the run was
  // stopped and never that the operator stopped it.
  it("says a stopped run was stopped, not that it failed, and never who stopped it", async () => {
    const stopped: CodingWorkbenchRuntimeSseEvent = {
      schemaVersion: "1",
      cursor: "cursor-5",
      sequence: 5,
      occurredAt: AT,
      kind: "status",
      runId: "run-1",
      state: "cancelled",
      revision: 5,
    };
    const { container, getByText } = render(
      <Timeline
        events={[stopped]}
        activity={activityLike(bareFeed())}
        questions={IDLE_QUESTIONS}
      />,
    );
    // A stop is not a failure: it needs no attention, so it is one of the run's details.
    expect(container.querySelector('[data-timeline-kind="event"]')).toBeNull();
    fireEvent.click(getByText("Run details"));

    const settled = [...container.querySelectorAll('[data-timeline-kind="event"]')].at(-1);
    expect(settled).toHaveTextContent("Stopped");
    expect(settled).toHaveTextContent(/this run was stopped/iu);
    expect(settled).toHaveTextContent(/nothing failed/iu);
    expect(settled).not.toHaveTextContent(/you stopped/iu);
    expect(settled).not.toHaveAttribute("data-event-tone", "attention");
    expect(container).not.toHaveTextContent(/internal error|run failed/iu);
    const report = await axe(container);
    expect(
      report.violations.filter((violation) =>
        ["serious", "critical"].includes(violation.impact ?? ""),
      ),
    ).toEqual([]);
  });

  // The failure scenario of the review: Keiko is restarted (an update, a crash recovery or a machine
  // shutdown) while a run works. The orchestrator's shutdown ends it through the stop path, and after
  // the restart the Workbench restores the run's terminal row from its settled snapshot — which holds
  // nothing that says who stopped it, so the row must not blame the operator.
  it("does not blame the operator for the stop of a restored run settled by a shutdown", () => {
    const events = eventsWithRestoredSettlement([], {
      schemaVersion: "1",
      state: "cancelled",
      revision: 9,
      updatedAt: AT,
      runId: "run-1",
    });
    const { container } = render(
      <Timeline events={events} activity={activityLike(bareFeed())} questions={IDLE_QUESTIONS} />,
    );
    fireEvent.click(screen.getByText("Run details"));

    const settled = [...container.querySelectorAll('[data-timeline-kind="event"]')].at(-1);
    expect(settled).toHaveTextContent("Stopped");
    expect(settled).toHaveTextContent(/this run was stopped/iu);
    expect(container).not.toHaveTextContent(/you stopped|operator/iu);
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

  // #3873 review: the facts about the model gateway are routine run details with their own titles —
  // an outage being ridden out is no attention-grade failure, and the timeline keeps them out of
  // the way until the run's details are asked for.
  it("shows the model gateway facts as routine run details with their own titles", () => {
    const retrying = { ...event(2), eventKind: "model-gateway-retrying" as const };
    const recovered = { ...event(3), eventKind: "model-gateway-recovered" as const };
    const { container } = render(
      <Timeline
        events={[retrying, recovered]}
        activity={activityLike(bareFeed())}
        questions={IDLE_QUESTIONS}
      />,
    );
    expect(container.querySelector('[data-timeline-kind="event"]')).toBeNull();
    fireEvent.click(screen.getByText("Run details"));

    const rows = [...container.querySelectorAll('[data-timeline-kind="event"]')];
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("Model gateway unavailable, retrying");
    expect(rows[1]).toHaveTextContent("Model gateway answered again");
    for (const row of rows) expect(row).toHaveAttribute("data-event-tone", "routine");
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

// #3878: the model's own reasoning (`reasoning_content`) shows as a collapsible block, labelled as
// unverified model reasoning. #3873 review: the session stream is a `role="log"`, whose additions a
// screen reader announces, so the block stays collapsed until the reader opens it — also while its
// turn streams — and its text never joins the log's announcements.
describe("CodingWorkbenchTimeline model reasoning", () => {
  function feedWithReasoning(
    reasoning: { readonly text: string; readonly truncated: boolean },
    answer = "Fixed the parser.",
  ): AvailableCodingSafeActivityFeed {
    return {
      ...bareFeed(),
      turns: [
        {
          turnId: "turn-reasoning",
          messages: [
            {
              messageId: "message-user",
              role: "user",
              occurredAt: AT,
              segments: [{ kind: "text", text: "Fix the parser", truncated: false }],
              truncated: false,
            },
            {
              messageId: "message-reasoned",
              role: "assistant",
              occurredAt: AT,
              segments:
                answer.length === 0 ? [] : [{ kind: "text", text: answer, truncated: false }],
              truncated: false,
              reasoning,
            },
          ],
          tools: [],
          truncated: false,
        },
      ],
    };
  }

  function reasoningBlock(container: HTMLElement): HTMLDetailsElement {
    const block = container.querySelector<HTMLDetailsElement>(`details.${styles.cmpReasoning}`);
    if (block === null) throw new TypeError("expected the model reasoning block");
    return block;
  }

  // What a screen reader does with an addition: the nearest explicit `aria-live`, else the live
  // politeness of the nearest live-region role, decides whether the text is announced.
  function announcement(element: Element): "off" | "polite" | "assertive" | undefined {
    for (let node: Element | null = element; node !== null; node = node.parentElement) {
      const explicit = node.getAttribute("aria-live");
      if (explicit === "off" || explicit === "polite" || explicit === "assertive") return explicit;
      const role = node.getAttribute("role");
      if (role === "log" || role === "status") return "polite";
      if (role === "alert") return "assertive";
    }
    return undefined;
  }

  // The Workbench renders the timeline inside its session stream, a `role="log"`.
  function renderInLog(ui: ReactElement): ReturnType<typeof render> {
    return render(
      <div role="log" aria-label="Session stream">
        {ui}
      </div>,
    );
  }

  const THOUGHT = { text: "The quoted field splits on its comma.", truncated: false };

  it("labels the reasoning as unverified model reasoning apart from the answer", () => {
    const { container } = render(
      <Timeline
        active
        events={[]}
        activity={activityLike(feedWithReasoning(THOUGHT))}
        questions={IDLE_QUESTIONS}
      />,
    );
    const block = reasoningBlock(container);
    expect(block.querySelector("summary")).toHaveTextContent("Model reasoning");
    expect(block.querySelector("summary")).toHaveTextContent("Unverified");
    expect(block).toHaveTextContent("Unverified model reasoning");
    expect(block).toHaveTextContent(THOUGHT.text);
    const answer = container.querySelector(
      `[data-message-role="assistant"] .${styles.messageText}`,
    );
    expect(answer).toHaveTextContent("Fixed the parser.");
    expect(answer).not.toHaveTextContent(THOUGHT.text);
  });

  it("is collapsed by default, also while its turn streams, and never opens by itself", () => {
    const { container, rerender } = render(
      <Timeline
        active
        events={[]}
        activity={activityLike(feedWithReasoning(THOUGHT, ""))}
        questions={IDLE_QUESTIONS}
      />,
    );
    expect(reasoningBlock(container)).not.toHaveAttribute("open");

    const grown = { text: `${THOUGHT.text} It also drops the escaped quote.`, truncated: false };
    rerender(
      <Timeline
        active
        events={[]}
        activity={activityLike(feedWithReasoning(grown, "Fixing"))}
        questions={IDLE_QUESTIONS}
      />,
    );
    expect(reasoningBlock(container)).toHaveTextContent("drops the escaped quote");
    expect(reasoningBlock(container)).not.toHaveAttribute("open");

    rerender(
      <Timeline
        active={false}
        events={[]}
        activity={activityLike(feedWithReasoning(grown))}
        questions={IDLE_QUESTIONS}
      />,
    );
    expect(reasoningBlock(container)).not.toHaveAttribute("open");
  });

  // #3873 review: a block the reader opened is the reader's: neither the arrival of newer messages
  // nor the end of the turn closes it.
  it("keeps a block the reader opened open while the turn streams and after it completes", () => {
    const feed = feedWithReasoning(THOUGHT);
    const [turn] = feed.turns;
    if (turn === undefined) throw new TypeError("expected a turn");
    const newer: AvailableCodingSafeActivityFeed = {
      ...feed,
      turns: [
        {
          ...turn,
          messages: [
            ...turn.messages,
            {
              messageId: "message-next",
              role: "assistant",
              occurredAt: "2026-07-19T12:00:01.000Z",
              segments: [{ kind: "text", text: "Next step.", truncated: false }],
              truncated: false,
            },
          ],
        },
      ],
    };
    const { container, rerender } = render(
      <Timeline active events={[]} activity={activityLike(feed)} questions={IDLE_QUESTIONS} />,
    );
    const block = reasoningBlock(container);
    block.open = true;
    rerender(
      <Timeline active events={[]} activity={activityLike(newer)} questions={IDLE_QUESTIONS} />,
    );
    expect(reasoningBlock(container)).toBe(block);
    expect(block).toHaveAttribute("open");
    rerender(
      <Timeline
        active={false}
        events={[]}
        activity={activityLike(newer)}
        questions={IDLE_QUESTIONS}
      />,
    );
    expect(block).toHaveAttribute("open");
  });

  // #3873 review: the failure scenario was a screen-reader user starting a task with a reasoning
  // model and hearing several thousand characters of unverified reasoning before every answer. The
  // log announces the answer; the reasoning is collapsed, and an opened block stays out of the
  // announcement as well.
  it("keeps the reasoning out of the log's live announcements while the answer stays in them", async () => {
    const { container } = renderInLog(
      <Timeline
        active
        events={[]}
        activity={activityLike(feedWithReasoning(THOUGHT))}
        questions={IDLE_QUESTIONS}
      />,
    );
    const log = screen.getByRole("log", { name: "Session stream" });
    const block = reasoningBlock(container);
    const reasoningText = within(block).getByText(THOUGHT.text);
    const answer = within(log).getByText("Fixed the parser.");

    expect(announcement(answer)).toBe("polite");
    expect(announcement(reasoningText)).toBe("off");
    expect(announcement(block.querySelector("summary") as Element)).toBe("off");
    expect(block).not.toHaveAttribute("open");
    expect(reasoningText).not.toBeVisible();

    block.open = true;
    expect(reasoningText).toBeVisible();
    expect(announcement(reasoningText)).toBe("off");

    const report = await axe(container);
    expect(
      report.violations.filter((violation) =>
        ["serious", "critical"].includes(violation.impact ?? ""),
      ),
    ).toEqual([]);
  });

  it("shows a reasoning-only message while the answer has not started", () => {
    const { container } = render(
      <Timeline
        active
        events={[]}
        activity={activityLike(feedWithReasoning(THOUGHT, ""))}
        questions={IDLE_QUESTIONS}
      />,
    );
    expect(reasoningBlock(container)).toHaveTextContent(THOUGHT.text);
  });

  it("marks shortened reasoning", () => {
    const { container } = render(
      <Timeline
        events={[]}
        activity={activityLike(feedWithReasoning({ text: "Partial thought", truncated: true }))}
        questions={IDLE_QUESTIONS}
      />,
    );
    expect(reasoningBlock(container)).toHaveTextContent("Output truncated");
  });

  it("reports every toggle, which is always the reader's, and nothing else", () => {
    const writer = vi.fn();
    setClientDiagnosticWriter(writer);
    try {
      const { container, rerender } = render(
        <Timeline
          active
          events={[]}
          activity={activityLike(feedWithReasoning(THOUGHT))}
          questions={IDLE_QUESTIONS}
        />,
      );
      expect(writer).not.toHaveBeenCalledWith(
        "[keiko] coding workbench model reasoning toggled",
        undefined,
      );
      const block = reasoningBlock(container);
      block.open = true;
      fireEvent(block, new Event("toggle"));
      expect(writer).toHaveBeenCalledWith(
        "[keiko] coding workbench model reasoning toggled",
        undefined,
      );
      writer.mockClear();
      rerender(
        <Timeline
          active={false}
          events={[]}
          activity={activityLike(feedWithReasoning(THOUGHT))}
          questions={IDLE_QUESTIONS}
        />,
      );
      expect(writer).not.toHaveBeenCalledWith(
        "[keiko] coding workbench model reasoning toggled",
        undefined,
      );
    } finally {
      resetClientDiagnosticWriter();
    }
  });

  it("has no serious or critical axe violations with a reasoning block rendered", async () => {
    const { container } = render(
      <Timeline
        active
        events={[]}
        activity={activityLike(feedWithReasoning(THOUGHT))}
        questions={IDLE_QUESTIONS}
      />,
    );
    const report = await axe(container);
    expect(
      report.violations.filter((violation) =>
        ["serious", "critical"].includes(violation.impact ?? ""),
      ),
    ).toEqual([]);
  });
});

// #3873 review: `streaming` removes code highlighting and the Copy button, so only text that is
// still being produced may carry it. A finished answer keeps both while the run waits for the
// operator's approval or is stopping. A paused run is not on that list (review thread 6pyds7
// inverted the earlier pin): pausing aborts no call the run had already admitted, so the Workbench
// keeps handing it `generating`, and this component renders what it is told. The Workbench-level
// pins for the paused run are in CodingWorkbenchWindow.test.tsx ("a paused run").
describe("CodingWorkbenchTimeline finished answers", () => {
  const LATER = "2026-07-19T12:00:05.000Z";
  const CODE_ANSWER = "Run the tests:\n\n```sh\nnpm test\n```";

  function feedWithCodeAnswer(
    tool?: { readonly state: "pending" | "running" | "succeeded"; readonly at: string },
    newerAnswer?: string,
  ): AvailableCodingSafeActivityFeed {
    return {
      ...bareFeed(),
      turns: [
        {
          turnId: "turn-code",
          messages: [
            {
              messageId: "message-code",
              role: "assistant",
              occurredAt: AT,
              segments: [{ kind: "text", text: CODE_ANSWER, truncated: false }],
              truncated: false,
            },
            ...(newerAnswer === undefined
              ? []
              : [
                  {
                    messageId: "message-newer",
                    role: "assistant" as const,
                    occurredAt: "2026-07-19T12:00:09.000Z",
                    segments: [{ kind: "text" as const, text: newerAnswer, truncated: false }],
                    truncated: false,
                  },
                ]),
          ],
          tools:
            tool === undefined
              ? []
              : [
                  {
                    callId: "call-command",
                    tool: "keiko_run_command",
                    state: tool.state,
                    occurredAt: tool.at,
                  },
                ],
          truncated: false,
        },
      ],
    };
  }

  function renderTimeline(
    feed: AvailableCodingSafeActivityFeed,
    flags: { readonly active: boolean; readonly generating?: boolean },
  ): HTMLElement {
    return render(
      <Timeline
        active={flags.active}
        {...(flags.generating === undefined ? {} : { generating: flags.generating })}
        events={[]}
        activity={activityLike(feed)}
        questions={IDLE_QUESTIONS}
      />,
    ).container;
  }

  function copyButton(container: HTMLElement): HTMLElement | null {
    return within(container).queryByRole("button", { name: "Copy code block" });
  }

  it("withholds highlighting and Copy from the answer a generating run is still streaming", () => {
    const container = renderTimeline(feedWithCodeAnswer(), { active: true, generating: true });
    expect(copyButton(container)).toBeNull();
    expect(container.querySelector(".sm-code-block-header")).toBeNull();
  });

  it("treats an active run as generating unless the caller says otherwise", () => {
    expect(copyButton(renderTimeline(feedWithCodeAnswer(), { active: true }))).toBeNull();
  });

  // The failure scenario: in Ask for approval the model answers with a code block and then asks for
  // a command approval; the answer is finished, so it keeps its Copy button while the run waits.
  it("gives a finished answer its highlighting and Copy button while the run is not generating", () => {
    const container = renderTimeline(feedWithCodeAnswer(), { active: true, generating: false });
    expect(copyButton(container)).not.toBeNull();
    expect(container.querySelector(".sm-code-block-header")).not.toBeNull();
  });

  it("gives text its Copy button once the model moved on to a tool call, even while generating", () => {
    const container = renderTimeline(feedWithCodeAnswer({ state: "pending", at: LATER }), {
      active: true,
      generating: true,
    });
    expect(copyButton(container)).not.toBeNull();
  });

  it("treats a tool of the same instant as after the text it followed", () => {
    const container = renderTimeline(feedWithCodeAnswer({ state: "running", at: AT }), {
      active: true,
      generating: true,
    });
    expect(copyButton(container)).not.toBeNull();
  });

  it("keeps the newest answer of a generating run live after an earlier tool call", () => {
    const feed = feedWithCodeAnswer(
      { state: "succeeded", at: "2026-07-19T12:00:02.000Z" },
      "Next:\n\n```sh\nnpm run lint\n```",
    );
    const container = renderTimeline(feed, { active: true, generating: true });
    const messages = [
      ...container.querySelectorAll<HTMLElement>('[data-message-role="assistant"]'),
    ];
    expect(messages).toHaveLength(2);
    expect(copyButton(messages[0] as HTMLElement)).not.toBeNull();
    expect(copyButton(messages[1] as HTMLElement)).toBeNull();
  });

  it("settles every answer once the run is no longer active", () => {
    const container = renderTimeline(feedWithCodeAnswer(), { active: false });
    expect(copyButton(container)).not.toBeNull();
  });
});
