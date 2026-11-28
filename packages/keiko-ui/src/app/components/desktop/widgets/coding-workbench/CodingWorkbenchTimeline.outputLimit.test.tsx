import { cleanup, render, screen } from "@testing-library/react";
import { axe } from "jest-axe";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AvailableCodingSafeActivityFeed,
  CodingSafeActivityMessage,
} from "@oscharko-dev/keiko-contracts";
import { I18nProvider, I18N_STORAGE_KEY, loadLocaleMessages } from "@/lib/i18n";
import type { UseCodingWorkbenchQuestionsResult } from "@/lib/useCodingWorkbenchQuestions";
import type { UseCodingWorkbenchSafeActivityResult } from "@/lib/useCodingWorkbenchSafeActivity";
import { Timeline } from "./CodingWorkbenchTimeline";

const AT = "2026-07-19T12:00:00.000Z";
const NOTE_EN = "This answer reached the model's output limit and was cut off.";
const NOTE_DE = "Diese Antwort hat das Ausgabelimit des Modells erreicht und wurde abgeschnitten.";

const IDLE_QUESTIONS: UseCodingWorkbenchQuestionsResult = {
  status: "empty",
  questions: [],
  errorCode: null,
  mutationFailure: null,
  answer: vi.fn(() => Promise.resolve(true)),
  reject: vi.fn(() => Promise.resolve(true)),
  retry: vi.fn(),
};

function assistantMessage(
  outputLimitReached: boolean,
  text = "A partial answer",
): CodingSafeActivityMessage {
  return {
    messageId: "message-1",
    role: "assistant",
    occurredAt: AT,
    segments: text === "" ? [] : [{ kind: "text", text, truncated: false }],
    truncated: false,
    ...(outputLimitReached ? { outputLimitReached: true as const } : {}),
  };
}

function feedOf(message: CodingSafeActivityMessage): AvailableCodingSafeActivityFeed {
  return {
    schemaVersion: "1",
    availability: "available",
    runId: "run-1",
    updatedAt: AT,
    turns: [{ turnId: "turn-1", messages: [message], tools: [], truncated: false }],
    truncated: false,
    droppedEventCount: 0,
  };
}

function Subject({
  limited,
  text,
}: {
  readonly limited: boolean;
  readonly text?: string;
}): React.ReactNode {
  const activity: UseCodingWorkbenchSafeActivityResult = {
    status: "live",
    feed: feedOf(assistantMessage(limited, text)),
    errorCode: null,
    retry: vi.fn(),
    answers: new Map(),
    reasoning: new Map(),
    readReasoning: vi.fn(),
    retryText: vi.fn(),
  };
  return (
    <Timeline
      active={false}
      generating={false}
      events={[]}
      activity={activity}
      questions={IDLE_QUESTIONS}
    />
  );
}

afterEach(() => {
  cleanup();
  window.localStorage.removeItem(I18N_STORAGE_KEY);
});

// The runtime reported the turn's finish as the model's output limit: the answer says so, in the
// person's language, and only then.
describe("CodingWorkbenchTimeline output limit note", () => {
  it("shows the note on an answer that reached the output limit and passes the audit", async () => {
    const { container } = render(<Subject limited />);
    expect(screen.getByText(NOTE_EN)).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("shows the note when the output budget ran out before any answer text arrived", () => {
    render(<Subject limited text="" />);
    expect(screen.getByText(NOTE_EN)).toBeInTheDocument();
  });

  it("shows no row for an empty answer that did not reach the limit", () => {
    render(<Subject limited={false} text="" />);
    expect(screen.queryByText(NOTE_EN)).not.toBeInTheDocument();
    expect(screen.queryByRole("article")).not.toBeInTheDocument();
  });

  it("shows no note on an answer that finished normally", async () => {
    const { container } = render(<Subject limited={false} />);
    expect(screen.getByText("A partial answer")).toBeInTheDocument();
    expect(screen.queryByText(NOTE_EN)).not.toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("says it in German when the interface is German", async () => {
    await loadLocaleMessages("de");
    window.localStorage.setItem(I18N_STORAGE_KEY, "de");
    const { container } = render(
      <I18nProvider>
        <Subject limited />
      </I18nProvider>,
    );
    expect(screen.getByText(NOTE_DE)).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });
});
