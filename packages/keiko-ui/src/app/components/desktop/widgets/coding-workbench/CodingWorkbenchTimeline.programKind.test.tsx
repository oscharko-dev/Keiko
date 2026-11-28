import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AvailableCodingSafeActivityFeed,
  CodingSafeActivityTool,
} from "@oscharko-dev/keiko-contracts";

import { I18nProvider, I18N_STORAGE_KEY } from "@/lib/i18n";
import type { UseCodingWorkbenchQuestionsResult } from "@/lib/useCodingWorkbenchQuestions";
import { Timeline } from "./CodingWorkbenchTimeline";

const AT = "2026-07-19T12:00:00.000Z";

const IDLE_QUESTIONS: UseCodingWorkbenchQuestionsResult = {
  status: "empty",
  questions: [],
  errorCode: null,
  mutationFailure: null,
  answer: vi.fn(() => Promise.resolve(true)),
  reject: vi.fn(() => Promise.resolve(true)),
  retry: vi.fn(),
};

function call(tool: string, programKind?: "command" | "schedule" | "tool"): CodingSafeActivityTool {
  return {
    callId: `${tool}-${programKind ?? "none"}`,
    tool,
    state: "succeeded",
    occurredAt: AT,
    ...(programKind === undefined ? {} : { presentation: { programKind } }),
  };
}

function titles(tools: readonly CodingSafeActivityTool[]): readonly string[] {
  const feed: AvailableCodingSafeActivityFeed = {
    schemaVersion: "1",
    availability: "available",
    runId: "run-1",
    updatedAt: AT,
    turns: [{ turnId: "turn-1", messages: [], tools, truncated: false }],
    truncated: false,
    droppedEventCount: 0,
  };
  const { container } = render(
    <I18nProvider>
      <Timeline
        active={false}
        events={[]}
        activity={{ status: "live", feed, errorCode: null, retry: vi.fn() }}
        questions={IDLE_QUESTIONS}
      />
    </I18nProvider>,
  );
  return Array.from(container.querySelectorAll('[data-timeline-kind="tool"] p')).map(
    (node) => node.textContent ?? "",
  );
}

afterEach(() => {
  cleanup();
  window.localStorage.removeItem(I18N_STORAGE_KEY);
});

describe("the name of a Code Mode program row (U-56)", () => {
  it.each([
    [call("execute", "command"), "Ran a command"],
    [call("execute", "schedule"), "Scheduled task"],
    [call("execute", "tool"), "Ran a tool"],
    [call("execute"), "Ran a tool"],
    [call("automation_create"), "Scheduled task"],
    [call("automation_delete"), "Scheduled task"],
  ])("reads %# as its own words, never as the bare label Program", (tool, label) => {
    const [first] = titles([tool]);
    expect(first).toContain(label);
    expect(first).not.toContain("Program");
  });
});
