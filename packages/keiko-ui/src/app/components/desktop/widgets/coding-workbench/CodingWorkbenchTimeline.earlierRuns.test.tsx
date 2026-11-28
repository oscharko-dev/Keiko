import { cleanup, render, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AvailableCodingSafeActivityFeed,
  CodingSafeActivityMessage,
  CodingSafeActivityTool,
} from "@oscharko-dev/keiko-contracts";
import type { CodingWorkbenchRuntimeSnapshot } from "@oscharko-dev/keiko-contracts";
import type { ChatMessage, CodingHistoryDetail } from "@oscharko-dev/keiko-contracts/bff-wire";

import { I18nProvider, I18N_STORAGE_KEY } from "@/lib/i18n";
import type { UseCodingWorkbenchQuestionsResult } from "@/lib/useCodingWorkbenchQuestions";
import { Timeline } from "./CodingWorkbenchTimeline";
import { transcriptShows, useRestoredRunTimeline } from "./codingWorkbenchRestoredRun";

// U-11: the rows of the run before a continuation stay, in order, before the continuation's own.

const IDLE_QUESTIONS: UseCodingWorkbenchQuestionsResult = {
  status: "empty",
  questions: [],
  errorCode: null,
  mutationFailure: null,
  answer: vi.fn(() => Promise.resolve(true)),
  reject: vi.fn(() => Promise.resolve(true)),
  retry: vi.fn(),
};

function message(
  id: string,
  role: "user" | "assistant",
  at: string,
  text: string,
): CodingSafeActivityMessage {
  return {
    messageId: id,
    role,
    occurredAt: at,
    segments: [{ kind: "text", text, truncated: false }],
    truncated: false,
  };
}

function tool(callId: string, name: string, at: string): CodingSafeActivityTool {
  return { callId, tool: name, state: "succeeded", occurredAt: at };
}

function feed(
  runId: string,
  messages: readonly CodingSafeActivityMessage[],
  tools: readonly CodingSafeActivityTool[],
): AvailableCodingSafeActivityFeed {
  return {
    schemaVersion: "1",
    availability: "available",
    runId,
    updatedAt: "2026-07-19T12:10:00.000Z",
    turns: [{ turnId: `turn-${runId}`, messages, tools, truncated: false }],
    truncated: false,
    droppedEventCount: 0,
  };
}

const FIRST = feed(
  "run-1",
  [message("m-1", "user", "2026-07-19T12:00:00.000Z", "Fix the bug")],
  [
    tool("call-read", "read", "2026-07-19T12:00:01.000Z"),
    tool("call-edit", "edit", "2026-07-19T12:00:02.000Z"),
  ],
);
const SECOND = feed(
  "run-2",
  [message("m-2", "user", "2026-07-19T12:05:00.000Z", "Continue where you stopped")],
  [tool("call-test", "shell", "2026-07-19T12:05:01.000Z")],
);

afterEach(() => {
  cleanup();
  window.localStorage.removeItem(I18N_STORAGE_KEY);
});

function renderTimeline(earlierFeeds: readonly AvailableCodingSafeActivityFeed[]): HTMLElement {
  return render(
    <I18nProvider>
      <Timeline
        active={false}
        events={[]}
        activity={{ status: "ended", feed: SECOND, earlierFeeds, errorCode: null, retry: vi.fn() }}
        questions={IDLE_QUESTIONS}
      />
    </I18nProvider>,
  ).container;
}

function rowKinds(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll("[data-timeline-kind]")).map(
    (node) => `${node.getAttribute("data-timeline-kind") ?? ""}:${node.textContent.slice(0, 24)}`,
  );
}

describe("a continuation's timeline", () => {
  it("keeps the earlier run's rows before the continuation's own, in order", () => {
    const container = renderTimeline([FIRST]);
    const kinds = rowKinds(container).map((entry) => entry.split(":")[0]);
    expect(kinds).toEqual(["message", "group", "message", "tool"]);
    const text = container.textContent;
    expect(text.indexOf("Fix the bug")).toBeLessThan(text.indexOf("Continue where you stopped"));
  });

  it("shows only the continuation's rows when no earlier run is held", () => {
    const container = renderTimeline([]);
    expect(rowKinds(container)).toHaveLength(2);
    expect(container.textContent).not.toContain("Fix the bug");
  });

  it("keeps distinct rows of different runs that share a message id and a call id", () => {
    const sameIds = feed(
      "run-2",
      [message("m-1", "user", "2026-07-19T12:05:00.000Z", "Continue where you stopped")],
      [tool("call-read", "read", "2026-07-19T12:05:01.000Z")],
    );
    const container = render(
      <I18nProvider>
        <Timeline
          active={false}
          events={[]}
          activity={{
            status: "ended",
            feed: sameIds,
            earlierFeeds: [FIRST],
            errorCode: null,
            retry: vi.fn(),
          }}
          questions={IDLE_QUESTIONS}
        />
      </I18nProvider>,
    ).container;
    const text = container.textContent;
    expect(text).toContain("Fix the bug");
    expect(text).toContain("Continue where you stopped");
    expect(container.querySelectorAll('[data-timeline-kind="message"]')).toHaveLength(2);
    expect(
      container.querySelectorAll('[data-timeline-kind="tool"], [data-timeline-kind="group"]'),
    ).toHaveLength(2);
  });

  it("settles a tool left open on an earlier run while a later run is active", () => {
    const open: CodingSafeActivityTool = {
      callId: "call-open",
      tool: "shell",
      state: "running",
      occurredAt: "2026-07-19T12:00:03.000Z",
    };
    const stopped = feed("run-1", [], [open]);
    const container = render(
      <I18nProvider>
        <Timeline
          active
          events={[]}
          activity={{
            status: "live",
            feed: SECOND,
            earlierFeeds: [stopped],
            errorCode: null,
            retry: vi.fn(),
          }}
          questions={IDLE_QUESTIONS}
        />
      </I18nProvider>,
    ).container;
    expect(container.querySelector('[data-tool-state="running"]')).toBeNull();
    expect(container.querySelector('[aria-busy="true"]')).toBeNull();
    expect(container.querySelector('[data-tool-state="cancelled"]')).not.toBeNull();
  });

  it("puts an earlier run's rows before the continuation's prompt at the same instant", () => {
    const at = "2026-07-19T12:05:00.000Z";
    const stopped = feed("run-1", [], [tool("call-last", "edit", at)]);
    const continued = feed("run-2", [message("m-2", "user", at, "Continue where you stopped")], []);
    const container = render(
      <I18nProvider>
        <Timeline
          active={false}
          events={[]}
          activity={{
            status: "ended",
            feed: continued,
            earlierFeeds: [stopped],
            errorCode: null,
            retry: vi.fn(),
          }}
          questions={IDLE_QUESTIONS}
        />
      </I18nProvider>,
    ).container;
    expect(rowKinds(container).map((entry) => entry.split(":")[0])).toEqual(["tool", "message"]);
  });
});

function historyMessage(
  id: string,
  runId: string,
  role: ChatMessage["role"],
  content: string,
): ChatMessage {
  return {
    id,
    chatId: "task-7",
    role,
    content,
    timestamp: Date.parse("2026-07-19T12:00:00.000Z"),
    runId,
    workflowId: undefined,
    workflowStatus: undefined,
    shortResult: undefined,
    taskType: undefined,
  };
}

function detailOf(messages: readonly ChatMessage[]): CodingHistoryDetail {
  return {
    task: {
      id: "task-7",
      title: "Repair the parser",
      projectPath: "/repo",
      modelId: "gemma-4-31b-it",
      branch: "issue/7",
      workspaceId: "workspace-1",
      taskId: "task-1",
      status: "active",
      createdAt: 1,
      updatedAt: 2,
    },
    messages,
    truncated: false,
  };
}

// The transcript shows a history message unless the timeline shows that very message from an
// earlier run's feed. Coding History's ids are its own, so the run, role and whole text decide.
describe("the transcript beside a continuation's timeline", () => {
  const request = historyMessage("h-1", "run-1", "user", "Fix the bug");
  const answer = historyMessage("h-2", "run-1", "assistant", "I fixed the bug in the parser.");
  const settled = {
    schemaVersion: "1",
    state: "succeeded",
    revision: 9,
    updatedAt: "2026-07-19T12:10:00.000Z",
    runId: "run-2",
  } as CodingWorkbenchRuntimeSnapshot;

  function shownWith(
    earlierFeeds: readonly AvailableCodingSafeActivityFeed[],
    current: AvailableCodingSafeActivityFeed | null = SECOND,
    messages: readonly ChatMessage[] = [request, answer],
  ): ReturnType<typeof useRestoredRunTimeline> {
    return renderHook(() =>
      useRestoredRunTimeline(
        [],
        settled,
        { status: "ended", feed: current, earlierFeeds, errorCode: null, retry: vi.fn() },
        detailOf(messages),
      ),
    ).result.current;
  }

  it("leaves out a message the timeline shows from the earlier run's feed", () => {
    const { shownRun } = shownWith([FIRST]);
    expect(transcriptShows(shownRun, request)).toBe(false);
  });

  it("keeps a message that a partially captured earlier feed never carried", () => {
    // FIRST carries the request only: the answer was never captured (a missed final frame).
    const { shownRun } = shownWith([FIRST]);
    expect(transcriptShows(shownRun, answer)).toBe(true);
  });

  it("keeps a message whose text the earlier feed cut short", () => {
    const cut = feed("run-1", [message("m-1", "user", "2026-07-19T12:00:00.000Z", "Fix the")], []);
    const { shownRun } = shownWith([cut]);
    expect(transcriptShows(shownRun, request)).toBe(true);
  });

  it("keeps the messages an overflowed earlier run's feed no longer holds", () => {
    const overflowed: AvailableCodingSafeActivityFeed = {
      ...feed("run-1", [], [tool("call-edit", "edit", "2026-07-19T12:00:02.000Z")]),
      truncated: true,
      droppedEventCount: 40,
    };
    const { shownRun } = shownWith([overflowed]);
    expect(transcriptShows(shownRun, request)).toBe(true);
    expect(transcriptShows(shownRun, answer)).toBe(true);
  });

  it("keeps a message of the same text from another run", () => {
    const { shownRun } = shownWith([FIRST]);
    expect(transcriptShows(shownRun, { ...request, id: "h-9", runId: "run-0" })).toBe(true);
  });

  it("holds the earlier feeds on when the shown run is restored after a reload", () => {
    // The shown run has no server feed any more; its conversation comes from Coding History.
    const own = historyMessage("h-3", "run-2", "user", "Continue where you stopped");
    const timeline = shownWith([FIRST], null, [request, answer, own]);
    expect(timeline.activity.earlierFeeds).toEqual([FIRST]);
    expect(timeline.activity.feed?.runId).toBe("run-2");
    expect(transcriptShows(timeline.shownRun, request)).toBe(false);
    expect(transcriptShows(timeline.shownRun, answer)).toBe(true);
    expect(transcriptShows(timeline.shownRun, own)).toBe(false);
  });
});
