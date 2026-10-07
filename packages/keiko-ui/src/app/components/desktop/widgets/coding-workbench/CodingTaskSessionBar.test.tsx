import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CodingTaskSessionBar, CodingTaskTranscript } from "./CodingTaskSessionBar";
import { CodingWorkbenchProgress } from "./CodingWorkbenchProgress";
import type { ShownRun } from "./codingWorkbenchRestoredRun";
import type { CodingTaskSession } from "./useCodingTaskSession";

function session(): CodingTaskSession {
  return {
    detail: null,
    conversationId: undefined,
    visibleRun: false,
    pending: false,
    error: false,
    newTask: vi.fn(async () => undefined),
    finish: vi.fn(async () => undefined),
  };
}

type HistoryMessage = NonNullable<CodingTaskSession["detail"]>["messages"][number];

function historyMessage(id: string, runId: string | undefined, text: string): HistoryMessage {
  return {
    id,
    chatId: "task-7",
    role: "user",
    content: text,
    timestamp: Date.parse("2026-10-06T10:00:00.000Z"),
    runId,
    workflowId: undefined,
    workflowStatus: undefined,
    shortResult: undefined,
    taskType: undefined,
  };
}

function sessionWith(messages: readonly HistoryMessage[], truncated = false): CodingTaskSession {
  return {
    ...session(),
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
      messages,
      truncated,
    },
  };
}

// #3876 review: the transcript hid every message of the shown run, so a message the timeline's feed
// could not carry was shown in neither place. It now hides only what the timeline carries.
describe("CodingTaskTranscript", () => {
  const messages = [
    historyMessage("m-1", "run-6", "Earlier request"),
    historyMessage("m-2", "run-7", "First prompt of the run"),
    historyMessage("m-3", "run-7", "Answer the feed carries"),
    historyMessage("m-4", "run-7", "Answer without text"),
    historyMessage("m-5", undefined, "Loose message"),
  ];
  const overflowOnly: ShownRun = { runId: "run-7", overflowMessageIds: new Set(["m-2"]) };

  it("shows every message when the timeline shows no run", () => {
    render(<CodingTaskTranscript session={sessionWith(messages)} shownRun={undefined} />);
    const transcript = screen.getByRole("region", { name: "Previous conversation" });
    for (const text of [
      "Earlier request",
      "First prompt of the run",
      "Answer the feed carries",
      "Answer without text",
      "Loose message",
    ]) {
      expect(transcript).toHaveTextContent(text);
    }
  });

  it("shows the shown run's overflow, every other run's messages, and nothing else of the run", () => {
    render(<CodingTaskTranscript session={sessionWith(messages)} shownRun={overflowOnly} />);
    const transcript = screen.getByRole("region", { name: "Previous conversation" });
    expect(transcript).toHaveTextContent("Earlier request");
    expect(transcript).toHaveTextContent("First prompt of the run");
    expect(transcript).toHaveTextContent("Loose message");
    expect(transcript).not.toHaveTextContent("Answer the feed carries");
    expect(transcript).not.toHaveTextContent("Answer without text");
  });

  it("shows nothing of a run whose feed carries the whole conversation, other runs excepted", () => {
    const wholeRun: ShownRun = { runId: "run-7", overflowMessageIds: new Set() };
    render(<CodingTaskTranscript session={sessionWith(messages)} shownRun={wholeRun} />);
    const transcript = screen.getByRole("region", { name: "Previous conversation" });
    expect(transcript).toHaveTextContent("Earlier request");
    expect(transcript).not.toHaveTextContent("First prompt of the run");
  });

  it("renders no region when the timeline carries every message, and says history was cut", () => {
    const own = [historyMessage("m-2", "run-7", "First prompt of the run")];
    const wholeRun: ShownRun = { runId: "run-7", overflowMessageIds: new Set() };
    const { container, rerender } = render(
      <CodingTaskTranscript session={sessionWith(own)} shownRun={wholeRun} />,
    );
    expect(container).toBeEmptyDOMElement();

    rerender(<CodingTaskTranscript session={sessionWith(messages, true)} shownRun={wholeRun} />);
    expect(screen.getByText("Only the most recent saved messages are shown.")).toBeVisible();
  });
});

describe("quiet coding task chrome", () => {
  it("leaves the empty composer free of redundant task actions and idle banners", () => {
    const { container } = render(
      <>
        <CodingTaskSessionBar session={session()} active={false} onHistory={vi.fn()} />
        <CodingWorkbenchProgress state={undefined} review={false} questions={0} starting={false} />
      </>,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("keeps loading and failure feedback visible without a selected task", () => {
    render(
      <CodingTaskSessionBar
        session={{ ...session(), error: true, pending: true }}
        active={false}
        onHistory={vi.fn()}
      />,
    );
    expect(screen.getByRole("alert")).toBeVisible();
    expect(screen.getByText("Loading task…")).toBeVisible();
  });

  it("keeps real work and pending operator decisions visible", () => {
    const { rerender } = render(
      <CodingWorkbenchProgress state="running" review={false} questions={0} starting={false} />,
    );
    expect(screen.getByText("Working")).toBeVisible();
    rerender(
      <CodingWorkbenchProgress
        state="awaiting-approval"
        review={false}
        questions={0}
        starting={false}
      />,
    );
    expect(screen.getByRole("button", { name: "Review now" })).toBeVisible();
  });
});
