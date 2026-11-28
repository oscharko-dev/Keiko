import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type {
  AvailableCodingSafeActivityFeed,
  CodingSafeActivityMessage,
  CodingSafeActivityTool,
} from "@oscharko-dev/keiko-contracts";

import { I18nProvider, I18N_STORAGE_KEY, loadLocaleMessages } from "@/lib/i18n";
import type { UseCodingWorkbenchQuestionsResult } from "@/lib/useCodingWorkbenchQuestions";
import { useCodingWorkbenchTranslate } from "./coding-workbench-i18n";
import {
  JumpToLatest,
  ListFollowContext,
  feedRowKeys,
  useJoinedFollow,
  type ListFollow,
} from "./CodingWorkbenchJumpToLatest";
import { Timeline } from "./CodingWorkbenchTimeline";
import { failedCommandCount } from "./CodingWorkbenchToolDetail";

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

function tool(
  callId: string,
  name: string,
  state: CodingSafeActivityTool["state"],
  presentation?: CodingSafeActivityTool["presentation"],
): CodingSafeActivityTool {
  return {
    callId,
    tool: name,
    state,
    occurredAt: AT,
    ...(presentation === undefined ? {} : { presentation }),
  };
}

function userMessage(messageId: string): CodingSafeActivityMessage {
  return {
    messageId,
    role: "user",
    occurredAt: AT,
    segments: [{ kind: "text", text: "Fix the failing test", truncated: false }],
    truncated: false,
  };
}

function feedOf(
  tools: readonly CodingSafeActivityTool[],
  messages: readonly CodingSafeActivityMessage[] = [],
): AvailableCodingSafeActivityFeed {
  return {
    schemaVersion: "1",
    availability: "available",
    runId: "run-1",
    updatedAt: AT,
    turns: [{ turnId: "turn-1", messages, tools, truncated: false }],
    truncated: false,
    droppedEventCount: 0,
  };
}

function TimelineOf({
  feed,
  active = false,
}: {
  readonly feed: AvailableCodingSafeActivityFeed;
  readonly active?: boolean;
}): ReactNode {
  return (
    <I18nProvider>
      <Timeline
        active={active}
        events={[]}
        activity={{ status: "live", feed, errorCode: null, retry: vi.fn() }}
        questions={IDLE_QUESTIONS}
      />
    </I18nProvider>
  );
}

const FAILED_TEST = tool("call-test", "shell", "failed", {
  exitCode: 1,
  failureOrigin: "command-failed",
  command: { text: "npm test", truncated: false },
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  window.localStorage.removeItem(I18N_STORAGE_KEY);
});

describe("a folded group of completed steps", () => {
  it("renders its rows only once a reader opens it", () => {
    const { container } = render(
      <TimelineOf
        feed={feedOf([
          tool("call-1", "read", "succeeded"),
          tool("call-2", "grep", "succeeded"),
          tool("call-3", "glob", "succeeded"),
        ])}
      />,
    );
    const group = container.querySelector<HTMLDetailsElement>(
      '[data-timeline-kind="group"] details',
    );
    if (group === null) throw new TypeError("expected a folded group");
    expect(group.querySelectorAll('[data-timeline-kind="tool"]')).toHaveLength(0);
    const summary = group.querySelector("summary");
    if (summary === null) throw new TypeError("expected the group's summary");
    fireEvent.click(summary);
    expect(group.querySelectorAll('[data-timeline-kind="tool"]')).toHaveLength(3);
  });
});

describe("keyboard row navigation", () => {
  it("moves between row summaries with the arrow keys, Home and End", () => {
    const { container } = render(
      <TimelineOf
        feed={feedOf([
          FAILED_TEST,
          tool("call-1", "read", "succeeded"),
          tool("call-2", "grep", "succeeded"),
          { ...FAILED_TEST, callId: "call-test-2" },
        ])}
      />,
    );
    const rows = [...container.querySelectorAll<HTMLElement>("summary[data-timeline-row]")];
    expect(rows.length).toBeGreaterThanOrEqual(3);
    const [first, second] = rows;
    const last = rows.at(-1);
    if (first === undefined || second === undefined || last === undefined) {
      throw new TypeError("expected three rows");
    }
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(document.activeElement).toBe(second);
    fireEvent.keyDown(second, { key: "End" });
    expect(document.activeElement).toBe(last);
    fireEvent.keyDown(last, { key: "Home" });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: "ArrowUp" });
    expect(document.activeElement).toBe(first);
    // A modified key is the browser's or the reader's own, never a row jump.
    fireEvent.keyDown(first, { key: "ArrowDown", ctrlKey: true });
    expect(document.activeElement).toBe(first);
  });
});

describe("keyboard row navigation past a folded group", () => {
  it("skips the rows of a group a reader opened and closed again", () => {
    const { container } = render(
      <TimelineOf
        feed={feedOf([
          FAILED_TEST,
          tool("call-1", "read", "succeeded"),
          tool("call-2", "grep", "succeeded"),
          tool("call-3", "glob", "succeeded"),
          { ...FAILED_TEST, callId: "call-test-2" },
        ])}
      />,
    );
    const group = container.querySelector<HTMLDetailsElement>(
      '[data-timeline-kind="group"] details',
    );
    const groupSummary = group?.querySelector<HTMLElement>("summary");
    if (group === null || groupSummary === null || groupSummary === undefined) {
      throw new TypeError("expected a folded group");
    }
    fireEvent.click(groupSummary);
    group.open = true;
    const inside = group.querySelectorAll("summary[data-timeline-row]");
    expect(inside.length).toBeGreaterThan(1);
    // Open, the next row is the group's first step.
    groupSummary.focus();
    fireEvent.keyDown(groupSummary, { key: "ArrowDown" });
    expect(document.activeElement).toBe(inside[1]);
    // Closed again, its steps stay mounted but the next row is the one after the group.
    group.open = false;
    groupSummary.focus();
    fireEvent.keyDown(groupSummary, { key: "ArrowDown" });
    const rows = [...container.querySelectorAll<HTMLElement>("summary[data-timeline-row]")];
    expect(document.activeElement).toBe(rows.at(-1));
    expect(group.contains(document.activeElement)).toBe(false);
  });
});

describe("the wait for the model's first step", () => {
  it("says it waits, then after ten seconds that the model is slow, and leaves at the first step", () => {
    vi.useFakeTimers();
    const waiting = feedOf([], [userMessage("msg-1")]);
    const { rerender } = render(<TimelineOf feed={waiting} active />);
    expect(screen.getByRole("status")).toHaveTextContent("Waiting for the model's first step…");
    act(() => {
      vi.advanceTimersByTime(9_999);
    });
    expect(screen.getByRole("status")).toHaveTextContent("Waiting for the model's first step…");
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByRole("status")).toHaveTextContent(
      "Still working — the model is slow to answer.",
    );
    rerender(<TimelineOf feed={feedOf([tool("call-1", "read", "running")])} active />);
    expect(screen.queryByText(/first step|slow to answer/u)).toBeNull();
  });

  it("is not shown for a run that no longer generates", () => {
    render(<TimelineOf feed={feedOf([], [userMessage("msg-1")])} />);
    expect(screen.queryByText("Waiting for the model's first step…")).toBeNull();
  });
});

function rows(count: number): readonly string[] {
  return Array.from({ length: count }, (_, index) => `row:${String(index)}`);
}

function JumpProbe(props: {
  readonly paused: boolean;
  readonly rowKeys: readonly string[];
  readonly onJump: () => void;
}): ReactNode {
  const t = useCodingWorkbenchTranslate();
  return <JumpToLatest {...props} t={t} />;
}

function Jump(props: {
  readonly paused: boolean;
  readonly rowKeys: readonly string[];
  readonly onJump: () => void;
}): ReactNode {
  return (
    <I18nProvider>
      <JumpProbe {...props} />
    </I18nProvider>
  );
}

describe("the way back to the newest step", () => {
  it("appears only while following paused and counts the rows that arrived since", () => {
    const onJump = vi.fn();
    const { rerender } = render(<Jump paused={false} rowKeys={rows(5)} onJump={onJump} />);
    expect(screen.queryByRole("button")).toBeNull();
    rerender(<Jump paused rowKeys={rows(5)} onJump={onJump} />);
    expect(screen.getByRole("button")).toHaveTextContent("Jump to latest");
    rerender(<Jump paused rowKeys={rows(6)} onJump={onJump} />);
    expect(screen.getByRole("button")).toHaveTextContent("1 new step · Jump to latest");
    rerender(<Jump paused rowKeys={rows(8)} onJump={onJump} />);
    expect(screen.getByRole("button")).toHaveTextContent("3 new steps · Jump to latest");
    fireEvent.click(screen.getByRole("button"));
    expect(onJump).toHaveBeenCalledOnce();
    rerender(<Jump paused={false} rowKeys={rows(8)} onJump={onJump} />);
    expect(screen.queryByRole("button")).toBeNull();
    // A later pause counts from its own start, not from the first one.
    rerender(<Jump paused rowKeys={rows(9)} onJump={onJump} />);
    expect(screen.getByRole("button")).toHaveTextContent(/^Jump to latest$/u);
  });

  it("speaks German", async () => {
    await loadLocaleMessages("de");
    window.localStorage.setItem(I18N_STORAGE_KEY, "de");
    const { rerender } = render(<Jump paused rowKeys={rows(1)} onJump={vi.fn()} />);
    rerender(<Jump paused rowKeys={rows(3)} onJump={vi.fn()} />);
    expect(screen.getByRole("button")).toHaveTextContent("2 neue Schritte · Zum Neuesten");
  });

  it("names a feed's messages and tool calls as its rows", () => {
    expect(feedRowKeys(null)).toEqual([]);
    expect(feedRowKeys(feedOf([FAILED_TEST], [userMessage("msg-1")]))).toEqual([
      "message:msg-1",
      `tool:${FAILED_TEST.callId}`,
    ]);
  });

  it("counts an arrival that came with the eviction of an old row", () => {
    const { rerender } = render(<Jump paused rowKeys={rows(5)} onJump={vi.fn()} />);
    // The oldest row leaves as a new one arrives: the row count stays 5.
    rerender(<Jump paused rowKeys={[...rows(6)].slice(1)} onJump={vi.fn()} />);
    expect(screen.getByRole("button")).toHaveTextContent("1 new step · Jump to latest");
  });
});

describe("the way back to the newest step of a long, windowed timeline", () => {
  it("shows while either the stream or the list stopped following, and resumes both", () => {
    const resumeStream = vi.fn();
    const resumeList = vi.fn();
    const { result, rerender } = renderHook(
      ({ streamPaused }: { readonly streamPaused: boolean }) =>
        useJoinedFollow(streamPaused, resumeStream),
      { initialProps: { streamPaused: false } },
    );
    expect(result.current.paused).toBe(false);
    act(() => {
      result.current.reportList({ paused: true, resume: resumeList });
    });
    // The reader scrolled up inside the list while the stream itself stayed at its end.
    expect(result.current.paused).toBe(true);
    act(() => {
      result.current.jump();
    });
    expect(resumeStream).toHaveBeenCalledOnce();
    expect(resumeList).toHaveBeenCalledOnce();
    act(() => {
      result.current.reportList({ paused: false, resume: resumeList });
    });
    expect(result.current.paused).toBe(false);
    rerender({ streamPaused: true });
    expect(result.current.paused).toBe(true);
  });

  it("hears when a windowed timeline stops following, resumes it, and hears it leave", () => {
    const reports: ListFollow[] = [];
    const report = (follow: ListFollow): void => {
      reports.push(follow);
    };
    const many = Array.from({ length: 70 }, (_, index) =>
      tool(`call-${String(index)}`, "shell", "failed", {
        exitCode: 1,
        failureOrigin: "command-failed",
      }),
    );
    const { unmount } = render(
      <ListFollowContext.Provider value={report}>
        <TimelineOf feed={feedOf(many)} active />
      </ListFollowContext.Provider>,
    );
    expect(reports.at(-1)?.paused).toBe(false);
    const list = document.querySelector<HTMLElement>("[data-timeline-rows]");
    if (list === null) throw new TypeError("expected the windowed list");
    list.scrollTo = vi.fn();
    // Home inside the list leaves its newest row; the stream itself never moved.
    fireEvent.keyDown(list, { key: "Home" });
    expect(reports.at(-1)?.paused).toBe(true);
    act(() => {
      reports.at(-1)?.resume();
    });
    expect(reports.at(-1)?.paused).toBe(false);
    unmount();
    expect(reports.at(-1)?.paused).toBe(false);
  });
});

describe("the run's failed commands", () => {
  it("counts the commands that failed or ran out of time, never a stop, a block or a tool's error", () => {
    const feed = feedOf([
      FAILED_TEST,
      { ...FAILED_TEST, callId: "call-test-2" },
      tool("call-slow", "shell", "failed", { failureOrigin: "timed-out" }),
      tool("call-stop", "shell", "cancelled", { failureOrigin: "cancelled" }),
      tool("call-push", "shell", "denied", { failureOrigin: "keiko-refused" }),
      tool("call-spawn", "shell", "failed", { failureOrigin: "tool-error" }),
      tool("call-read", "read", "failed", { failureOrigin: "command-failed" }),
      tool("call-ok", "shell", "succeeded", { exitCode: 0 }),
    ]);
    expect(failedCommandCount(feed)).toBe(3);
    expect(failedCommandCount(null)).toBe(0);
  });
});

describe("a running call", () => {
  it("shows how long it has run from one second on and stops at its end", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(AT));
    const running = tool("call-run", "shell", "running", {
      command: { text: "npm test", truncated: false },
    });
    const { container, rerender } = render(<TimelineOf feed={feedOf([running])} active />);
    expect(container.querySelector('[role="timer"]')).toBeNull();
    act(() => {
      vi.advanceTimersByTime(12_000);
    });
    expect(container.querySelector('[role="timer"]')).toHaveTextContent(/^12 s$/u);
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(container.querySelector('[role="timer"]')).toHaveTextContent(/^1 min 12 s$/u);
    rerender(
      <TimelineOf
        feed={feedOf([{ ...running, state: "succeeded", presentation: { exitCode: 0 } }])}
        active
      />,
    );
    expect(container.querySelector('[role="timer"]')).toBeNull();
  });

  // U-18: the timer reads the call's own start, so a row that unmounts (scrolled out of the
  // virtualized list, collapsed, regrouped) and mounts again keeps counting from that start.
  it("keeps the elapsed time across an unmount and remount of the row", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(AT));
    const running = tool("call-run", "shell", "running");
    const first = render(<TimelineOf feed={feedOf([running])} active />);
    act(() => {
      vi.advanceTimersByTime(36_000);
    });
    expect(first.container.querySelector('[role="timer"]')).toHaveTextContent(/^36 s$/u);
    first.unmount();
    const second = render(<TimelineOf feed={feedOf([running])} active />);
    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    expect(second.container.querySelector('[role="timer"]')).toHaveTextContent(/^39 s$/u);
  });

  it("shows an open call as waiting for the decision, without a timer, while the run is held", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(AT));
    const open = tool("call-verify", "keiko_verification", "running");
    const { container } = render(
      <I18nProvider>
        <Timeline
          active
          pausedForTrust
          events={[]}
          activity={{ status: "live", feed: feedOf([open]), errorCode: null, retry: vi.fn() }}
          questions={IDLE_QUESTIONS}
        />
      </I18nProvider>,
    );
    act(() => {
      vi.advanceTimersByTime(12_000);
    });
    expect(container.querySelector('[role="timer"]')).toBeNull();
    expect(container.querySelector('[data-state="waiting-for-trust"]')).not.toBeNull();
    expect(container.querySelector('[data-state="running"]')).toBeNull();
  });

  // Parallel calls: only the call the trust decision gates is held; a shell step open beside it keeps
  // its own running state and timer.
  it("keeps the running timer of an open call that the trust decision does not gate", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(AT));
    const feed = feedOf([
      tool("call-verify", "keiko_verification", "running"),
      tool("call-shell", "shell", "running", { command: { text: "npm test", truncated: false } }),
    ]);
    const { container } = render(
      <I18nProvider>
        <Timeline
          active
          pausedForTrust
          events={[]}
          activity={{ status: "live", feed, errorCode: null, retry: vi.fn() }}
          questions={IDLE_QUESTIONS}
        />
      </I18nProvider>,
    );
    act(() => {
      vi.advanceTimersByTime(12_000);
    });
    expect(container.querySelectorAll('[data-state="waiting-for-trust"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-state="running"]')).toHaveLength(1);
    expect(container.querySelectorAll('[role="timer"]')).toHaveLength(1);
  });

  // #4491: a call that never reported its end must not keep "Running" and a ticking clock once the
  // run is over.
  it.each(["running", "pending"] as const)(
    "shows a %s call as ended and stops its clock once the run has settled",
    (state) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(AT));
      const open = tool("call-open", "shell", state, {
        command: { text: "npm test", truncated: false },
      });
      const { container } = render(<TimelineOf feed={feedOf([open])} active={false} />);
      act(() => {
        vi.advanceTimersByTime(12_000);
      });
      expect(container.querySelector('[role="timer"]')).toBeNull();
      expect(container.querySelector('[data-state="running"]')).toBeNull();
      expect(container.querySelector('[data-state="pending"]')).toBeNull();
      expect(container.textContent).not.toMatch(/Running|Pending/u);
      expect(container.textContent).toMatch(/Cancelled|Stopped/u);
    },
  );
});
