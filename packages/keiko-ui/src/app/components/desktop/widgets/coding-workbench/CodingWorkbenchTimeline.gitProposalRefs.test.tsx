import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AvailableCodingSafeActivityFeed,
  CodingSafeActivityTool,
} from "@oscharko-dev/keiko-contracts";

import { I18nProvider, I18N_STORAGE_KEY } from "@/lib/i18n";
import type { UseCodingWorkbenchQuestionsResult } from "@/lib/useCodingWorkbenchQuestions";
import { Timeline } from "./CodingWorkbenchTimeline";

// A Git execute names the proposal it redeemed by the server's opaque reference, never by order.

const IDLE_QUESTIONS: UseCodingWorkbenchQuestionsResult = {
  status: "empty",
  questions: [],
  errorCode: null,
  mutationFailure: null,
  answer: vi.fn(() => Promise.resolve(true)),
  reject: vi.fn(() => Promise.resolve(true)),
  retry: vi.fn(),
};

const COMMIT_REF = "aaaaaaaaaaaaaaaa";
const STAGE_REF = "bbbbbbbbbbbbbbbb";

function gitTool(
  callId: string,
  tool: string,
  second: number,
  presentation: NonNullable<CodingSafeActivityTool["presentation"]>,
): CodingSafeActivityTool {
  return {
    callId,
    tool,
    state: "succeeded",
    occurredAt: `2026-08-23T09:52:0${String(second)}.000Z`,
    presentation,
  };
}

function feedOf(
  runId: string,
  tools: readonly CodingSafeActivityTool[],
): AvailableCodingSafeActivityFeed {
  return {
    schemaVersion: "1",
    availability: "available",
    runId,
    updatedAt: "2026-08-23T09:53:00.000Z",
    turns: [{ turnId: `turn-${runId}`, messages: [], tools, truncated: false }],
    truncated: false,
    droppedEventCount: 0,
  };
}

function renderFeeds(
  feed: AvailableCodingSafeActivityFeed,
  earlierFeeds: readonly AvailableCodingSafeActivityFeed[] = [],
): HTMLElement {
  return render(
    <I18nProvider>
      <Timeline
        active
        events={[]}
        activity={{ status: "ended", feed, earlierFeeds, errorCode: null, retry: vi.fn() }}
        questions={IDLE_QUESTIONS}
      />
    </I18nProvider>,
  ).container;
}

afterEach(() => {
  cleanup();
  window.localStorage.removeItem(I18N_STORAGE_KEY);
});

describe("Git proposals paired by the server's reference", () => {
  const commit = gitTool("commit-proposal", "keiko_git_commit", 1, {
    gitOutcome: "waiting-for-approval",
    gitProposalRef: COMMIT_REF,
  });
  const stage = gitTool("stage-proposal", "keiko_git_stage", 2, {
    gitOutcome: "waiting-for-approval",
    gitAction: "stage",
    gitProposalRef: STAGE_REF,
  });

  it("names the stage an execute carried out and keeps the unrelated commit proposal waiting", () => {
    const execute = gitTool("execute", "keiko_git_execute", 3, {
      gitOutcome: "completed",
      gitProposalRef: STAGE_REF,
    });
    const container = renderFeeds(feedOf("run-1", [commit, stage, execute]));
    const waiting = container.querySelectorAll('[data-tool-state="waiting-for-approval"]');
    expect(waiting).toHaveLength(1);
    expect(waiting[0]).toHaveTextContent("Git commit");
    expect(container.textContent).not.toContain("Git operation");
  });

  it("never turns an execute into a title or a supersession of a proposal it did not redeem", () => {
    const execute = gitTool("execute", "keiko_git_execute", 3, {
      gitOutcome: "completed",
      gitProposalRef: "cccccccccccccccc",
    });
    const container = renderFeeds(feedOf("run-1", [commit, execute]));
    expect(container.querySelectorAll('[data-tool-state="waiting-for-approval"]')).toHaveLength(1);
    expect(container.textContent).toContain("Git operation");
  });

  it("does not pair an execute with a proposal of another run that shares the reference", () => {
    const earlier = feedOf("run-0", [commit]);
    const execute = gitTool("execute", "keiko_git_execute", 4, {
      gitOutcome: "completed",
      gitProposalRef: COMMIT_REF,
    });
    const container = renderFeeds(feedOf("run-1", [execute]), [earlier]);
    expect(container.querySelectorAll('[data-tool-state="waiting-for-approval"]')).toHaveLength(1);
    expect(container.textContent).toContain("Git operation");
  });
});
