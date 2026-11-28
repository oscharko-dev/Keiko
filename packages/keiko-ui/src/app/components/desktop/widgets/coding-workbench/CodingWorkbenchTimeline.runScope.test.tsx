import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AvailableCodingSafeActivityFeed,
  CodingSafeActivityMessage,
  CodingSafeActivityPlan,
} from "@oscharko-dev/keiko-contracts";

import { I18nProvider, I18N_STORAGE_KEY } from "@/lib/i18n";
import type { CodingWorkbenchAnswers } from "@/lib/useCodingWorkbenchAnswers";
import type { UseCodingWorkbenchQuestionsResult } from "@/lib/useCodingWorkbenchQuestions";
import type { UseCodingWorkbenchSafeActivityResult } from "@/lib/useCodingWorkbenchSafeActivity";
import { Timeline } from "./CodingWorkbenchTimeline";

// The texts read beside the shown run's feed, the plan and the open reasoning blocks belong to that
// run: an earlier run that shares a message id never borrows them (#4573 review).

const IDLE_QUESTIONS: UseCodingWorkbenchQuestionsResult = {
  status: "empty",
  questions: [],
  errorCode: null,
  mutationFailure: null,
  answer: vi.fn(() => Promise.resolve(true)),
  reject: vi.fn(() => Promise.resolve(true)),
  retry: vi.fn(),
};

function assistant(
  id: string,
  at: string,
  text: string,
  extra: Partial<CodingSafeActivityMessage> = {},
): CodingSafeActivityMessage {
  return {
    messageId: id,
    role: "assistant",
    occurredAt: at,
    segments: [{ kind: "text", text, truncated: false }],
    truncated: false,
    ...extra,
  };
}

function feedOf(
  runId: string,
  messages: readonly CodingSafeActivityMessage[],
  plan?: CodingSafeActivityPlan,
): AvailableCodingSafeActivityFeed {
  return {
    schemaVersion: "1",
    availability: "available",
    runId,
    updatedAt: "2026-07-19T12:10:00.000Z",
    turns: [{ turnId: `turn-${runId}`, messages, tools: [], truncated: false }],
    ...(plan === undefined ? {} : { plan }),
    truncated: false,
    droppedEventCount: 0,
  };
}

function held(text: string): CodingWorkbenchAnswers {
  return new Map([["m-1", { text, complete: true, truncated: false, failed: false }]]);
}

function renderTimeline(
  activity: Partial<UseCodingWorkbenchSafeActivityResult> & {
    readonly feed: AvailableCodingSafeActivityFeed;
  },
): HTMLElement {
  return render(
    <I18nProvider>
      <Timeline
        active={false}
        events={[]}
        activity={{ status: "ended", errorCode: null, retry: vi.fn(), ...activity }}
        questions={IDLE_QUESTIONS}
      />
    </I18nProvider>,
  ).container;
}

afterEach(() => {
  cleanup();
  window.localStorage.removeItem(I18N_STORAGE_KEY);
});

const EARLIER = feedOf("run-1", [
  assistant("m-1", "2026-07-19T12:00:00.000Z", "EARLIER excerpt", {
    fullAnswer: { length: 400, truncated: false },
    fullReasoning: { length: 300, truncated: false },
    reasoning: { text: "earlier thought", truncated: true },
  }),
]);
const CURRENT_TEXT = "CURRENT answer ".repeat(40);

describe("model texts stay with their own run", () => {
  it("shows an earlier run's retained excerpt, settled, never the current run's text", () => {
    const current = feedOf("run-2", [
      assistant("m-1", "2026-07-19T12:05:00.000Z", "CURRENT head", {
        fullAnswer: { length: CURRENT_TEXT.length, truncated: false },
      }),
    ]);
    const container = renderTimeline({
      feed: current,
      earlierFeeds: [EARLIER],
      answers: held(CURRENT_TEXT),
    });
    const text = container.textContent;
    expect(text).toContain("EARLIER excerpt");
    expect(text).not.toContain("Loading the rest");
    expect(text.match(/CURRENT answer/gu)?.length).toBe(40);
  });

  it("does not read the current run's reasoning when an earlier row is opened", () => {
    const readReasoning = vi.fn();
    const current = feedOf("run-2", [
      assistant("m-1", "2026-07-19T12:05:00.000Z", "CURRENT head", {
        fullReasoning: { length: 50, truncated: false },
        reasoning: { text: "current thought", truncated: true },
      }),
    ]);
    const container = renderTimeline({
      feed: current,
      earlierFeeds: [EARLIER],
      reasoning: held("CURRENT reasoning that is long"),
      readReasoning,
    });
    const earlierDetails = container.querySelectorAll("details")[0];
    if (earlierDetails === undefined) throw new Error("no reasoning block");
    earlierDetails.open = true;
    fireEvent(earlierDetails, new Event("toggle"));
    expect(readReasoning).not.toHaveBeenCalled();
    expect(earlierDetails.textContent).toContain("earlier thought");
    expect(earlierDetails.textContent).not.toContain("CURRENT reasoning");
  });

  it("anchors the shown run's plan to the message of its own run", () => {
    const plan: CodingSafeActivityPlan = {
      revision: 1,
      anchorMessageId: "m-1",
      updatedAt: "2026-07-19T12:05:01.000Z",
      steps: [],
      truncated: false,
    };
    const current = feedOf(
      "run-2",
      [assistant("m-1", "2026-07-19T12:05:00.000Z", "CURRENT head")],
      plan,
    );
    const container = renderTimeline({ feed: current, earlierFeeds: [EARLIER] });
    const rows = Array.from(container.querySelectorAll("[data-timeline-kind]"));
    expect(rows.map((node) => node.getAttribute("data-timeline-kind"))).toEqual([
      "message",
      "message",
      "plan",
    ]);
    expect(rows[1]?.textContent).toContain("CURRENT head");
  });
});
