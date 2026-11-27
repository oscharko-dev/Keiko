import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AvailableCodingSafeActivityFeed,
  CodingSafeActivityMessage,
  CodingSafeActivityTool,
} from "@oscharko-dev/keiko-contracts";
import type { ChatMessage } from "@oscharko-dev/keiko-contracts/bff-wire";

import { I18nProvider, I18N_STORAGE_KEY } from "@/lib/i18n";
import type { UseCodingWorkbenchQuestionsResult } from "@/lib/useCodingWorkbenchQuestions";
import { Timeline } from "./CodingWorkbenchTimeline";
import { transcriptShows } from "./codingWorkbenchRestoredRun";

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

  it("shows a row held twice once", () => {
    const container = renderTimeline([FIRST, { ...FIRST, runId: "run-1b" }]);
    expect(container.querySelectorAll('[data-timeline-kind="message"]')).toHaveLength(2);
  });
});

describe("the transcript beside a continuation's timeline", () => {
  const earlierMessage = { id: "history-1", runId: "run-1" } as ChatMessage;

  it("leaves out the messages of an earlier run whose feed the timeline carries", () => {
    const shown = {
      runId: "run-2",
      overflowMessageIds: new Set<string>(),
      earlierRunIds: new Set(["run-1"]),
    };
    expect(transcriptShows(shown, earlierMessage)).toBe(false);
  });

  it("still shows an earlier run's messages when no feed of it is kept", () => {
    const shown = { runId: "run-2", overflowMessageIds: new Set<string>() };
    expect(transcriptShows(shown, earlierMessage)).toBe(true);
  });
});
