import { act, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type {
  AvailableCodingSafeActivityFeed,
  CodingWorkbenchRuntimeSseEvent,
} from "@oscharko-dev/keiko-contracts";

import type { UseCodingWorkbenchQuestionsResult } from "@/lib/useCodingWorkbenchQuestions";
import type { UseCodingWorkbenchSafeActivityResult } from "@/lib/useCodingWorkbenchSafeActivity";
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
  it("uses per-kind default heights for the pre-measurement virtualized window", () => {
    // 101 events forces the virtual mode; only 96 rows render and the tail sits behind a spacer.
    const events = Array.from({ length: 101 }, (_, index) => event(index + 1));
    const { container } = render(
      <Timeline events={events} activity={activityLike(bareFeed())} questions={IDLE_QUESTIONS} />,
    );

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
});
