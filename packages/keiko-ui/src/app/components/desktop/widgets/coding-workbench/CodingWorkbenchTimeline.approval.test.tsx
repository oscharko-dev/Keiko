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

function tool(callId: string, state: CodingSafeActivityTool["state"]): CodingSafeActivityTool {
  return { callId, tool: "shell", state, occurredAt: AT };
}

function renderRows(
  tools: readonly CodingSafeActivityTool[],
  awaitingApprovalCallId: string | undefined,
): HTMLElement {
  const feed: AvailableCodingSafeActivityFeed = {
    schemaVersion: "1",
    availability: "available",
    runId: "run-1",
    updatedAt: AT,
    turns: [{ turnId: "turn-1", messages: [], tools, truncated: false }],
    truncated: false,
    droppedEventCount: 0,
  };
  return render(
    <I18nProvider>
      <Timeline
        active
        events={[]}
        activity={{ status: "live", feed, errorCode: null, retry: vi.fn() }}
        questions={IDLE_QUESTIONS}
        awaitingApprovalCallId={awaitingApprovalCallId}
      />
    </I18nProvider>,
  ).container;
}

function states(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll<HTMLElement>("[data-tool-state]")).map(
    (card) => card.dataset.toolState ?? "",
  );
}

afterEach(() => {
  cleanup();
  window.localStorage.removeItem(I18N_STORAGE_KEY);
});

describe("a tool call held back by a pending approval", () => {
  it("reads Waiting for approval, with no running counter, on exactly the asked call", () => {
    const container = renderRows([tool("call-a", "running")], "call-a");
    expect(states(container)).toEqual(["waiting-for-approval"]);
    expect(container.querySelector('[data-state="waiting-for-approval"]')).toHaveTextContent(
      "Waiting for approval",
    );
    expect(container).not.toHaveTextContent("Running");
  });

  it("keeps every other running call running, whatever its number", () => {
    const container = renderRows(
      [tool("call-a", "running"), tool("call-b", "running"), tool("call-c", "running")],
      "call-b",
    );
    expect(states(container)).toEqual(["running", "waiting-for-approval", "running"]);
  });

  it("keeps a running call running when the pending approval names another call", () => {
    expect(states(renderRows([tool("call-a", "running")], "call-z"))).toEqual(["running"]);
  });

  it("keeps a running call running when no approval is pending or the ask names no call", () => {
    expect(states(renderRows([tool("call-a", "running")], undefined))).toEqual(["running"]);
  });

  it("never rewrites a call that already ended", () => {
    expect(states(renderRows([tool("call-a", "failed")], "call-a"))).toEqual(["failed"]);
  });
});
