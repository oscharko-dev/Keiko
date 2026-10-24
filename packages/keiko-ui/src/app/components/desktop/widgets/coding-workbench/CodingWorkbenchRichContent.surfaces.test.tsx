import { render, screen, waitFor, within } from "@testing-library/react";
import { axe } from "jest-axe";
import { describe, expect, it, vi } from "vitest";
import type { AvailableCodingSafeActivityFeed } from "@oscharko-dev/keiko-contracts";

import type { UseCodingWorkbenchQuestionsResult } from "@/lib/useCodingWorkbenchQuestions";
import type { UseCodingWorkbenchSafeActivityResult } from "@/lib/useCodingWorkbenchSafeActivity";
import { CodingTaskTranscript } from "./CodingTaskSessionBar";
import { Timeline } from "./CodingWorkbenchTimeline";
import type { CodingTaskSession } from "./useCodingTaskSession";

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

function feedOf(
  messages: readonly {
    readonly id: string;
    readonly role: "assistant" | "user";
    readonly text: string;
  }[],
): AvailableCodingSafeActivityFeed {
  return {
    schemaVersion: "1",
    availability: "available",
    runId: "run-1",
    updatedAt: AT,
    turns: [
      {
        turnId: "turn-1",
        messages: messages.map((message) => ({
          messageId: message.id,
          role: message.role,
          occurredAt: AT,
          segments: [{ kind: "text" as const, text: message.text, truncated: false }],
          truncated: false,
        })),
        tools: [],
        truncated: false,
      },
    ],
    truncated: false,
    droppedEventCount: 0,
  };
}

function renderTimeline(
  feed: AvailableCodingSafeActivityFeed,
  flags: { readonly active: boolean; readonly generating: boolean },
): HTMLElement {
  const activity: UseCodingWorkbenchSafeActivityResult = {
    status: "live",
    feed,
    errorCode: null,
    retry: vi.fn(),
  };
  return render(
    <Timeline
      active={flags.active}
      generating={flags.generating}
      events={[]}
      activity={activity}
      questions={IDLE_QUESTIONS}
    />,
  ).container;
}

const ANSWER = [
  "The cost grows as $O(n^2)$:",
  "",
  "```diff",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1 +1 @@",
  "-const a = 1;",
  "+const a = 2;",
  "```",
].join("\n");

describe("Coding Workbench timeline rich content", () => {
  it("typesets an assistant answer's math and styles its diff like the Changes panel", async () => {
    const container = renderTimeline(feedOf([{ id: "a", role: "assistant", text: ANSWER }]), {
      active: false,
      generating: false,
    });
    await waitFor(() => {
      expect(container.querySelector("math")).not.toBeNull();
    });
    expect(container.textContent).not.toContain("$O(n^2)$");
    expect(container.querySelector(".review .rv-line.rv-add")).not.toBeNull();
    expect(container.querySelector(".review .rv-line.rv-del")).not.toBeNull();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("shows a user message as typed", () => {
    const container = renderTimeline(
      feedOf([{ id: "u", role: "user", text: "Why is $O(n^2)$ slow?" }]),
      { active: false, generating: false },
    );
    expect(container.textContent).toContain("Why is $O(n^2)$ slow?");
    expect(container.querySelector("math")).toBeNull();
  });

  it("waits for the closing fence of the answer a generating run is still streaming", () => {
    const partial = "Plan:\n\n```diff\n-const a = 1;\n+const a = 2;";
    const streaming = renderTimeline(feedOf([{ id: "a", role: "assistant", text: partial }]), {
      active: true,
      generating: true,
    });
    expect(streaming.querySelector(".rv-line")).toBeNull();
    expect(streaming.querySelector("pre")?.textContent).toContain("+const a = 2;");
  });

  it("styles the last fence of a finished answer even when its closing fence is missing", () => {
    const partial = "Plan:\n\n```diff\n-const a = 1;\n+const a = 2;";
    const finished = renderTimeline(feedOf([{ id: "a", role: "assistant", text: partial }]), {
      active: true,
      generating: false,
    });
    expect(finished.querySelectorAll(".rv-line.rv-add")).toHaveLength(1);
  });
});

describe("Coding Workbench transcript rich content", () => {
  function sessionWith(role: "assistant" | "user", content: string): CodingTaskSession {
    return {
      detail: {
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
        messages: [
          {
            id: "m-1",
            chatId: "task-7",
            role,
            content,
            timestamp: Date.parse("2026-10-06T10:00:00.000Z"),
            runId: undefined,
            workflowId: undefined,
            workflowStatus: undefined,
            shortResult: undefined,
            taskType: undefined,
          },
        ],
        truncated: false,
      },
      conversationId: undefined,
      visibleRun: false,
      pending: false,
      error: false,
      newTask: vi.fn(() => Promise.resolve(undefined)),
      finish: vi.fn(() => Promise.resolve(undefined)),
    };
  }

  it("typesets what the agent said earlier in the task", async () => {
    render(
      <CodingTaskTranscript session={sessionWith("assistant", ANSWER)} shownRun={undefined} />,
    );
    const transcript = screen.getByRole("region", { name: "Previous conversation" });
    await waitFor(() => {
      expect(transcript.querySelector("math")).not.toBeNull();
    });
    expect(
      within(transcript).getByRole("region", { name: "Diff shown in the model answer" }),
    ).toBeInTheDocument();
  });

  it("leaves what the person wrote as written", () => {
    render(<CodingTaskTranscript session={sessionWith("user", ANSWER)} shownRun={undefined} />);
    const transcript = screen.getByRole("region", { name: "Previous conversation" });
    expect(transcript.querySelector("math")).toBeNull();
    expect(transcript.querySelector(".rv-line")).toBeNull();
    expect(transcript.textContent).toContain("$O(n^2)$");
  });
});
