import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { axe } from "jest-axe";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AvailableCodingSafeActivityFeed,
  CodingSafeActivityAnswerPage,
  CodingSafeActivityMessage,
} from "@oscharko-dev/keiko-contracts";
import {
  CODING_SAFE_ACTIVITY_ANSWER_PAGE_MAX_CHARS,
  CODING_SAFE_ACTIVITY_MAX_TEXT_SEGMENT_CHARS,
} from "@oscharko-dev/keiko-contracts/runtime/coding-safe-activity";

import { getCodingAppSessionAnswerPage } from "@/lib/coding-app-session-channel-api";
import {
  resetClientDiagnosticWriter,
  setClientDiagnosticWriter,
  type ClientDiagnosticMeta,
} from "@/lib/client-diagnostics";
import { I18nProvider, I18N_STORAGE_KEY, loadLocaleMessages } from "@/lib/i18n";
import { useCodingWorkbenchModelTexts } from "@/lib/useCodingWorkbenchAnswers";
import type { UseCodingWorkbenchQuestionsResult } from "@/lib/useCodingWorkbenchQuestions";
import type { UseCodingWorkbenchSafeActivityResult } from "@/lib/useCodingWorkbenchSafeActivity";
import { Timeline } from "./CodingWorkbenchTimeline";
import styles from "./CodingWorkbenchWindow.module.css";

vi.mock("@/lib/coding-app-session-channel-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/coding-app-session-channel-api")>();
  return { ...actual, getCodingAppSessionAnswerPage: vi.fn() };
});

const pageRequest = vi.mocked(getCodingAppSessionAnswerPage);
const AT = "2026-07-19T12:00:00.000Z";
const RUN_ID = "run-1";
const MESSAGE_ID = "message-long";

// A Markdown answer far beyond the feed's per-message budget, ending in a line the test can find:
// the owner's defect was a long answer whose end never reached the page.
const LONG_ANSWER = `# Review\n\n${"- **Finding:** the parser keeps every line.\n".repeat(2_800)}\nfinal-line-of-the-answer`;

const IDLE_QUESTIONS: UseCodingWorkbenchQuestionsResult = {
  status: "empty",
  questions: [],
  errorCode: null,
  mutationFailure: null,
  answer: vi.fn(() => Promise.resolve(true)),
  reject: vi.fn(() => Promise.resolve(true)),
  retry: vi.fn(),
};

// The feed message as the projection sends it: a prefix of the answer in its segments and the
// answer's whole length named beside them.
function namedMessage(
  answer: string,
  carried: number,
  truncated = false,
): CodingSafeActivityMessage {
  const prefix = answer.slice(0, carried);
  const segments = [];
  for (let start = 0; start < prefix.length; start += CODING_SAFE_ACTIVITY_MAX_TEXT_SEGMENT_CHARS) {
    const text = prefix.slice(start, start + CODING_SAFE_ACTIVITY_MAX_TEXT_SEGMENT_CHARS);
    segments.push({ kind: "text" as const, text, truncated: false });
  }
  return {
    messageId: MESSAGE_ID,
    role: "assistant",
    occurredAt: AT,
    segments,
    truncated,
    fullAnswer: { length: answer.length, truncated },
  };
}

function feedOf(message: CodingSafeActivityMessage): AvailableCodingSafeActivityFeed {
  return {
    schemaVersion: "1",
    availability: "available",
    runId: RUN_ID,
    updatedAt: AT,
    turns: [{ turnId: "turn-1", messages: [message], tools: [], truncated: false }],
    truncated: false,
    droppedEventCount: 0,
  };
}

// The server's pages of `answer`, cut where the server cuts them.
function servePages(answer: string, truncated = false): void {
  pageRequest.mockImplementation(({ runId, messageId, offset }) => {
    const page: CodingSafeActivityAnswerPage = {
      schemaVersion: "1",
      runId,
      messageId,
      part: "answer",
      offset,
      text: answer.slice(offset, offset + CODING_SAFE_ACTIVITY_ANSWER_PAGE_MAX_CHARS),
      length: answer.length,
      truncated,
    };
    return Promise.resolve({ schemaVersion: "1", page });
  });
}

// The Workbench's own wiring: the safe-activity hook reads the answers its feed names.
function LiveTimeline({
  feed,
  generating = false,
}: {
  readonly feed: AvailableCodingSafeActivityFeed;
  readonly generating?: boolean;
}): ReactNode {
  const texts = useCodingWorkbenchModelTexts(feed.runId, feed);
  const activity: UseCodingWorkbenchSafeActivityResult = {
    status: "live",
    feed,
    errorCode: null,
    retry: vi.fn(),
    answers: texts.answers,
    reasoning: texts.reasoning,
    readReasoning: texts.readReasoning,
    retryText: texts.retryText,
  };
  return (
    <Timeline
      active={generating}
      generating={generating}
      events={[]}
      activity={activity}
      questions={IDLE_QUESTIONS}
    />
  );
}

function answerText(container: HTMLElement): string {
  return container.querySelector(`[data-message-role="assistant"] .sm-root`)?.textContent ?? "";
}

function copyButton(): HTMLElement {
  return screen.getByRole("button", { name: "Copy answer as Markdown" });
}

// The copy's own status region, beside its button: the timeline has other status regions.
function copyStatus(): HTMLElement {
  const status = document.querySelector<HTMLElement>(".chat-msg-copy-wrap output");
  if (status === null) throw new TypeError("expected the copy status region");
  return status;
}

let reports: { message: string; meta: ClientDiagnosticMeta | undefined }[] = [];
let writeText: ReturnType<typeof vi.fn<(text: string) => Promise<void>>>;
let clipboardDescriptor: PropertyDescriptor | undefined;

beforeEach(() => {
  reports = [];
  setClientDiagnosticWriter((message, meta) => {
    reports.push({ message, meta });
  });
  writeText = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve());
  clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
});

afterEach(() => {
  cleanup();
  pageRequest.mockReset();
  resetClientDiagnosticWriter();
  if (clipboardDescriptor === undefined) Reflect.deleteProperty(navigator, "clipboard");
  else Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
  window.localStorage.removeItem(I18N_STORAGE_KEY);
});

// Owner decision "Work-ending limits": a model's final answer is never cut to fit the bounded live
// feed. The feed carries a prefix and names the answer's length; the page reads the rest and shows
// the whole answer, with a truncation mark only for a real cut.
describe("CodingWorkbenchTimeline complete answers", () => {
  it("shows a 100+ KiB answer live, whole, unmarked, read page by page from where it ends", async () => {
    expect(LONG_ANSWER.length).toBeGreaterThan(100 * 1024);
    servePages(LONG_ANSWER);
    const { container } = render(<LiveTimeline feed={feedOf(namedMessage(LONG_ANSWER, 16_000))} />);

    await waitFor(() => {
      expect(answerText(container)).toContain("final-line-of-the-answer");
    });
    expect(container.querySelector(`.${styles.truncationMark}`)).toBeNull();
    expect(screen.queryByText("Loading the rest…")).not.toBeInTheDocument();
    // Reading starts where the feed's part ends and goes on page by page, never twice.
    const offsets = pageRequest.mock.calls.map(([request]) => request.offset);
    expect(offsets.at(-1)).toBeLessThan(LONG_ANSWER.length);
    for (const [index, offset] of offsets.entries()) {
      expect(offset).toBe(16_000 + index * CODING_SAFE_ACTIVITY_ANSWER_PAGE_MAX_CHARS);
    }
    expect(await axe(container)).toHaveNoViolations();
  });

  it("says the rest is loading, never that the answer was cut, and offers no copy meanwhile", () => {
    pageRequest.mockImplementation(() => new Promise(() => undefined));
    const { container } = render(<LiveTimeline feed={feedOf(namedMessage(LONG_ANSWER, 16_000))} />);

    expect(answerText(container)).toContain("Finding: the parser keeps every line.");
    expect(screen.getByText("Loading the rest…")).toBeInTheDocument();
    expect(container.querySelector(`.${styles.truncationMark}`)).toBeNull();
    expect(screen.queryByRole("button", { name: "Copy answer as Markdown" })).toBeNull();
  });

  it("reads on from where the held text ends while a streaming answer grows", async () => {
    const first = LONG_ANSWER.slice(0, 40_000);
    servePages(first);
    const { container, rerender } = render(
      <LiveTimeline feed={feedOf(namedMessage(first, 16_000))} />,
    );
    await waitFor(() => {
      expect(answerText(container)).toContain(first.slice(-20).trim());
    });

    servePages(LONG_ANSWER);
    rerender(<LiveTimeline feed={feedOf(namedMessage(LONG_ANSWER, 16_000))} />);
    await waitFor(() => {
      expect(answerText(container)).toContain("final-line-of-the-answer");
    });
    const offsets = pageRequest.mock.calls.map(([request]) => request.offset);
    expect(offsets).toContain(first.length);
  });

  it("marks the cut and keeps the carried part when reading the rest fails, body-free", async () => {
    pageRequest.mockRejectedValue(new TypeError("Failed to fetch"));
    const { container } = render(<LiveTimeline feed={feedOf(namedMessage(LONG_ANSWER, 16_000))} />);

    await waitFor(() => {
      expect(container.querySelector(`.${styles.truncationMark}`)).not.toBeNull();
    });
    expect(answerText(container)).toContain("Finding:");
    const report = reports.find(({ message }) => message.includes("rest of a long model text"));
    expect(report?.meta?.errorKind).toBe("unavailable");
    expect(JSON.stringify(report)).not.toContain("parser keeps");
    expect(JSON.stringify(report)).not.toContain(MESSAGE_ID);
  });

  it("marks an answer the server's memory bound cut, once it holds all that was kept", async () => {
    const kept = `${LONG_ANSWER.slice(0, 50_000)}\n\nkept-end`;
    servePages(kept, true);
    const { container } = render(<LiveTimeline feed={feedOf(namedMessage(kept, 16_000, true))} />);

    await waitFor(() => {
      expect(answerText(container)).toContain("kept-end");
    });
    expect(container.querySelectorAll(`.${styles.truncationMark}`)).toHaveLength(1);
  });
});

describe("CodingWorkbenchTimeline answer reading edge cases", () => {
  it("marks the cut when the server no longer has the answer", async () => {
    pageRequest.mockResolvedValue({ schemaVersion: "1", page: null });
    const { container } = render(<LiveTimeline feed={feedOf(namedMessage(LONG_ANSWER, 16_000))} />);

    await waitFor(() => {
      expect(container.querySelector(`.${styles.truncationMark}`)).not.toBeNull();
    });
    expect(pageRequest).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Loading the rest…")).not.toBeInTheDocument();
  });

  it("stops reading a run's answers when another run is shown, and reads that run's own", async () => {
    const pending: ((value: Awaited<ReturnType<typeof getCodingAppSessionAnswerPage>>) => void)[] =
      [];
    const signals: AbortSignal[] = [];
    pageRequest.mockImplementation((_request, signal) => {
      if (signal !== undefined) signals.push(signal);
      return new Promise((resolve) => pending.push(resolve));
    });
    const { rerender } = render(<LiveTimeline feed={feedOf(namedMessage(LONG_ANSWER, 16_000))} />);
    await waitFor(() => {
      expect(pageRequest).toHaveBeenCalledTimes(1);
    });

    rerender(
      <LiveTimeline feed={{ ...feedOf(namedMessage(LONG_ANSWER, 16_000)), runId: "run-2" }} />,
    );
    await waitFor(() => {
      expect(pageRequest).toHaveBeenCalledTimes(2);
    });
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
    expect(pageRequest.mock.calls[1]?.[0]).toMatchObject({ runId: "run-2", offset: 16_000 });
  });
});

describe("CodingWorkbenchTimeline answer copy", () => {
  const MARKDOWN = "Run the **tests**:\n\n```sh\nnpm test\n```\n\n- [x] done";

  function feedWithAnswer(text: string): AvailableCodingSafeActivityFeed {
    return feedOf({
      messageId: "message-short",
      role: "assistant",
      occurredAt: AT,
      segments: [{ kind: "text", text, truncated: false }],
      truncated: false,
    });
  }

  it("copies the answer's Markdown source, not its rendered text, and confirms it", async () => {
    const { container } = render(<LiveTimeline feed={feedWithAnswer(MARKDOWN)} />);

    fireEvent.click(copyButton());
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Copied" })).toHaveAttribute("data-copied", "true");
    });
    expect(writeText).toHaveBeenCalledWith(MARKDOWN);
    expect(copyStatus()).toHaveTextContent("Answer copied as Markdown");
    const report = reports.find(({ message }) => message.includes("answer copied"));
    expect(report?.meta?.answerCopy).toEqual({
      outcome: "copied",
      grounded: false,
      strippedGroupCount: 0,
      keptGroupCount: 0,
    });
    expect(JSON.stringify(report)).not.toContain("npm test");
    expect(await axe(container)).toHaveNoViolations();
  });

  it("copies a 100+ KiB answer whole once it is read", async () => {
    servePages(LONG_ANSWER);
    render(<LiveTimeline feed={feedOf(namedMessage(LONG_ANSWER, 16_000))} />);

    fireEvent.click(await screen.findByRole("button", { name: "Copy answer as Markdown" }));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledTimes(1);
    });
    expect(writeText.mock.calls[0]?.[0]).toBe(LONG_ANSWER);
  });

  it("says when the clipboard refused the copy and records the failure body-free", async () => {
    writeText.mockRejectedValue(new DOMException("denied", "NotAllowedError"));
    const execCommand = vi.fn(() => false);
    Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });
    try {
      render(<LiveTimeline feed={feedWithAnswer(MARKDOWN)} />);
      fireEvent.click(copyButton());
      await waitFor(() => {
        expect(copyStatus()).toHaveTextContent("Clipboard access failed.");
      });
      expect(copyButton()).toHaveAttribute("data-failed", "true");
      const report = reports.find(({ message }) => message.includes("answer copy failed"));
      expect(report?.meta?.answerCopy?.outcome).toBe("failed");
      expect(report?.meta?.errorKind).toBe("unavailable");
    } finally {
      Reflect.deleteProperty(document, "execCommand");
    }
  });

  it("offers no copy while the answer still streams, and one per finished answer", () => {
    const { rerender } = render(<LiveTimeline feed={feedWithAnswer(MARKDOWN)} generating />);
    expect(screen.queryByRole("button", { name: "Copy answer as Markdown" })).toBeNull();

    rerender(<LiveTimeline feed={feedWithAnswer(MARKDOWN)} />);
    expect(screen.getAllByRole("button", { name: "Copy answer as Markdown" })).toHaveLength(1);
  });

  it("names the copy in German", async () => {
    await loadLocaleMessages("de");
    window.localStorage.setItem(I18N_STORAGE_KEY, "de");
    render(
      <I18nProvider>
        <LiveTimeline feed={feedWithAnswer(MARKDOWN)} />
      </I18nProvider>,
    );

    const button = screen.getByRole("button", { name: "Antwort als Markdown kopieren" });
    await act(async () => {
      fireEvent.click(button);
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(copyStatus()).toHaveTextContent("Antwort als Markdown kopiert");
    });
  });
});
