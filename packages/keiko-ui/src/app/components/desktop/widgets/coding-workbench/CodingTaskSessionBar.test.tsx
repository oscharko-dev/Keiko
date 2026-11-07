import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { axe } from "jest-axe";
import type { ChatToolExchange } from "@oscharko-dev/keiko-contracts/bff-wire";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { I18N_STORAGE_KEY, I18nProvider, loadLocaleMessages } from "@/lib/i18n";
import { loadOptionalWidgetMessages } from "@/lib/optional-widget-i18n";
import {
  CodingTaskSessionBar,
  CodingTaskTranscript,
  TRANSCRIPT_WINDOW_MESSAGES,
} from "./CodingTaskSessionBar";
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
    fork: null,
    beginFork: vi.fn(),
    cancelFork: vi.fn(),
    forkTargets: [],
    continueIn: vi.fn(() => Promise.resolve()),
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

  it("labels a scheduled-continuation message with the scheduled label, not as the user", () => {
    const scheduled: HistoryMessage = {
      ...historyMessage("m-s", undefined, "Wake-up prompt"),
      taskType: "scheduled-continuation",
    };
    render(
      <CodingTaskTranscript
        session={sessionWith([scheduled, historyMessage("m-u", undefined, "Typed by a person")])}
        shownRun={undefined}
      />,
    );
    const transcript = screen.getByRole("region", { name: "Previous conversation" });
    expect(within(transcript).getAllByText("Scheduled continuation")).toHaveLength(1);
    expect(within(transcript).getAllByText("You")).toHaveLength(1);
  });

  it("shows nothing of a run whose feed carries the whole conversation, other runs excepted", () => {
    const wholeRun: ShownRun = { runId: "run-7", overflowMessageIds: new Set() };
    render(<CodingTaskTranscript session={sessionWith(messages)} shownRun={wholeRun} />);
    const transcript = screen.getByRole("region", { name: "Previous conversation" });
    expect(transcript).toHaveTextContent("Earlier request");
    expect(transcript).not.toHaveTextContent("First prompt of the run");
  });

  // Stability audit item 9: a task of up to 200 long messages mounted all of them at once.
  describe("with a long task", () => {
    const many = Array.from({ length: 130 }, (_, index) =>
      historyMessage(`m-${String(index + 1)}`, undefined, `Message number ${String(index + 1)}`),
    );

    it("mounts only the newest window and reveals earlier messages on request", () => {
      render(<CodingTaskTranscript session={sessionWith(many)} shownRun={undefined} />);
      const transcript = screen.getByRole("region", { name: "Previous conversation" });

      expect(transcript.querySelectorAll("article")).toHaveLength(TRANSCRIPT_WINDOW_MESSAGES);
      expect(transcript).toHaveTextContent("Message number 130");
      expect(transcript).not.toHaveTextContent("Message number 1 ");
      const more = screen.getByRole("button", { name: "Show earlier messages (90 hidden)" });

      fireEvent.click(more);

      expect(transcript.querySelectorAll("article")).toHaveLength(2 * TRANSCRIPT_WINDOW_MESSAGES);
      fireEvent.click(screen.getByRole("button", { name: "Show earlier messages (50 hidden)" }));
      fireEvent.click(screen.getByRole("button", { name: "Show earlier messages (10 hidden)" }));
      expect(transcript.querySelectorAll("article")).toHaveLength(130);
      expect(screen.queryByRole("button", { name: /Show earlier messages/u })).toBeNull();
    });

    it("offers nothing to reveal for a task that fits one window", () => {
      render(<CodingTaskTranscript session={sessionWith(many.slice(0, 5))} shownRun={undefined} />);
      expect(screen.queryByRole("button", { name: /Show earlier messages/u })).toBeNull();
    });
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

function savedJiraResult(
  id: string,
  name: string,
  mutationOutcome: ChatToolExchange["mutationOutcome"],
  data: CatalogJsonObject,
): ChatToolExchange {
  return {
    call: { id, name, arguments: {} },
    ...(mutationOutcome === undefined ? {} : { mutationOutcome }),
    result: {
      schemaVersion: 1,
      invocationId: id,
      toolRef: null,
      projectionDigest: null,
      effectStarted: mutationOutcome !== undefined && mutationOutcome !== "rejected",
      metrics: { inputBytes: 10, outputBytes: 10, resultCount: 1, durationMs: 20 },
      status: "completed",
      reason: "none",
      page: { truncated: false, reason: "none", cursor: null },
      data,
    },
  };
}

function jiraHistoryMessage(): HistoryMessage {
  return {
    ...historyMessage("jira-turn", "run-7", "The live feed already carries this request"),
    toolTranscript: {
      schemaVersion: 1,
      exchanges: [
        savedJiraResult("created", "jira_create", "succeeded", {
          outcome: "succeeded",
          issueId: "10001",
          issueKey: "SYN-1",
          summary: "Saved Jira issue",
          browseUrl: "https://jira.example.invalid/context/browse/SYN-1",
        }),
        savedJiraResult("invalid", "jira_comment", "rejected", {
          outcome: "rejected",
          reason: "field-validation",
          fieldErrors: [
            { fieldId: "body", fieldName: "Comment", message: "A reviewed comment is required." },
          ],
          guidance: "Private model guidance is not a result card",
        }),
        // The journal remains authoritative over an optimistic or stale result payload.
        savedJiraResult("unknown", "jira_set_app_monitoring", "unknown", {
          outcome: "succeeded",
          monitoringEnabled: false,
        }),
        savedJiraResult("unconfirmed", "jira_edit", "succeeded-unconfirmed", {
          outcome: "succeeded-unconfirmed",
          reason: "unavailable",
          issueId: "10002",
          issueKey: "SYN-2",
          browseUrl: "https://jira.example.invalid/context/browse/SYN-2",
        }),
      ],
    },
  };
}

describe.each(["en", "de"] as const)("stored Coding Jira results in %s", (locale) => {
  const wholeRun: ShownRun = { runId: "run-7", overflowMessageIds: new Set() };
  const labels = locale === "en" ? {
    transcript: "Previous conversation",
    you: "You",
    confirmed: "Jira change confirmed",
    rejected: "Jira action rejected",
    unknown: "Jira outcome unknown",
    unconfirmed: "Jira accepted the change; confirmation incomplete",
    requested: "Requested target: disabled",
    observed: "Confirmed state: disabled",
  } : {
    transcript: "Bisheriger Verlauf",
    you: "Du",
    confirmed: "Jira-Änderung bestätigt",
    rejected: "Jira-Aktion abgelehnt",
    unknown: "Ausgang der Jira-Aktion unbekannt",
    unconfirmed: "Jira hat die Änderung angenommen; Bestätigung unvollständig",
    requested: "Angeforderter Zielzustand: deaktiviert",
    observed: "Bestätigter Zustand: deaktiviert",
  };
  beforeEach(async () => {
    await Promise.all([loadLocaleMessages(locale), loadOptionalWidgetMessages(locale)]);
    localStorage.setItem(I18N_STORAGE_KEY, locale);
  });
  afterEach(() => localStorage.removeItem(I18N_STORAGE_KEY));

  it("keeps result cards when the live timeline already carries the user text", async () => {
    const onFork = vi.fn();
    const { container } = render(
      <I18nProvider>
        <CodingTaskTranscript
          session={sessionWith([jiraHistoryMessage()])}
          shownRun={wholeRun}
          onFork={onFork}
        />
      </I18nProvider>,
    );
    const transcript = screen.getByRole("region", { name: labels.transcript });
    expect(transcript).not.toHaveTextContent("The live feed already carries this request");
    expect(screen.queryByText(labels.you, { exact: true })).toBeNull();
    for (const status of [labels.confirmed, labels.rejected, labels.unknown, labels.unconfirmed])
      expect(screen.getByText(status)).toBeVisible();
    expect(screen.getByText("A reviewed comment is required.")).toBeVisible();
    expect(screen.getByText(labels.requested)).toBeVisible();
    expect(screen.queryByText(labels.observed)).toBeNull();
    for (const key of ["SYN-1", "SYN-2"]) {
      const link = screen.getByRole("link", { name: new RegExp(key, "u") });
      expect(link).toHaveAttribute("href", `https://jira.example.invalid/context/browse/${key}`);
      expect(link).toHaveAttribute("target", "_blank");
      expect(link).toHaveAttribute("rel", "noopener noreferrer");
    }
    expect(container.querySelector("pre, button, img")).toBeNull();
    expect(container.textContent).not.toContain("Private model guidance");
    expect(onFork).not.toHaveBeenCalled();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("restores identical receipt cards from saved history without a visible run or replay controls", () => {
    const saved = sessionWith([jiraHistoryMessage()]);
    const detail = JSON.parse(JSON.stringify(saved.detail)) as NonNullable<
      CodingTaskSession["detail"]
    >;
    const show = (): ReturnType<typeof render> =>
      render(
        <I18nProvider>
          <CodingTaskTranscript session={{ ...session(), detail }} shownRun={undefined} />
        </I18nProvider>,
      );
    const first = show();
    const text = first.container.textContent;
    first.unmount();
    const second = show();
    expect(second.container.textContent).toBe(text);
    expect(screen.getAllByText("The live feed already carries this request")).toHaveLength(1);
    expect(screen.getByRole("link", { name: /SYN-1/u })).toBeVisible();
    expect(screen.getByText("A reviewed comment is required.")).toBeVisible();
    expect(second.container.querySelector("pre, button")).toBeNull();
  });

  it("restores report read progress and a partial read page without inventing totals or mutation state", async () => {
    const message: HistoryMessage = {
      ...historyMessage("read-turn", "run-7", "The live feed already carries the reading request"),
      toolTranscript: { schemaVersion: 1, exchanges: [
        savedJiraResult("report-read", "jira_report", undefined, {
          outcome: "succeeded", status: "reading", reportId: "11111111-2222-4333-8444-555555555555",
          progress: { issuesRead: 25, pageCount: 2, elapsedMs: 10 },
        }),
        savedJiraResult("version-read", "jira_global_version_page", undefined, {
          outcome: "succeeded", startAt: 1, nextStartAt: 2,
          items: [{ versionId: "9001", name: "Observed release", released: false }],
        }),
      ] },
    };
    const detail = JSON.parse(JSON.stringify(sessionWith([message]).detail)) as NonNullable<CodingTaskSession["detail"]>;
    const show = (): ReturnType<typeof render> => render(<I18nProvider>
      <CodingTaskTranscript session={{ ...session(), detail }} shownRun={wholeRun} />
    </I18nProvider>);
    const first = show();
    const savedText = first.container.textContent;
    first.unmount();
    const { container } = show();
    expect(container.textContent).toBe(savedText);
    expect(screen.getByText(locale === "en" ? "Reading Jira: 25 issues" : "Jira wird gelesen: 25 Vorgänge")).toBeVisible();
    expect(screen.getByText(locale === "en" ? "Partial Jira result. Some available data is not included."
      : "Jira-Teilergebnis. Nicht alle verfügbaren Daten sind enthalten.")).toBeVisible();
    expect(container.textContent).toContain("Observed release");
    expect(container.textContent).not.toContain("The live feed already carries the reading request");
    expect(screen.queryByText(labels.confirmed)).toBeNull();
    expect(screen.queryByText(labels.unknown)).toBeNull();
    expect(container.querySelector("pre, button")).toBeNull();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("preserves text for other runs while refusing an unsafe saved receipt link", () => {
    const unsafe: HistoryMessage = {
      ...historyMessage("unsafe-turn", "run-7", "Another already displayed request"),
      toolTranscript: {
        schemaVersion: 1,
        exchanges: [
          savedJiraResult("unsafe", "jira_create", "succeeded", {
            outcome: "succeeded",
            issueId: "10003",
            issueKey: "SYN-3",
            browseUrl: "javascript:alert(1)",
          }),
        ],
      },
    };
    render(
      <I18nProvider>
        <CodingTaskTranscript
          session={sessionWith([historyMessage("earlier", "run-6", "Earlier request"), unsafe])}
          shownRun={wholeRun}
        />
      </I18nProvider>,
    );
    expect(screen.getAllByText("Earlier request")).toHaveLength(1);
    expect(screen.queryByText("Another already displayed request")).toBeNull();
    expect(screen.getByText("SYN-3", { exact: true })).toBeVisible();
    expect(screen.queryByRole("link", { name: /SYN-3/u })).toBeNull();
    expect(document.querySelector("pre, img")).toBeNull();
  });
});

// S03 (#3904): forking is the person's own request, from a settled task or from one of its user
// messages. Nothing offers it while a run is active, and it never changes the task it forks.
describe("forking from the task chrome", () => {
  it("forks the loaded task as it ended", () => {
    const forked = sessionWith([historyMessage("m-1", "run-6", "Earlier request")]);
    render(<CodingTaskSessionBar session={forked} active={false} onHistory={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Fork task" }));

    expect(forked.beginFork).toHaveBeenCalledOnce();
    expect(forked.beginFork).toHaveBeenCalledWith();
  });

  it.each([
    ["a run is active", sessionWith([]), true],
    ["the task is still loading", { ...sessionWith([]), pending: true }, false],
    [
      "a fork is already pending",
      { ...sessionWith([]), fork: { taskId: "task-7", title: "t" } },
      false,
    ],
  ])("cannot fork while %s", (_name, current, active) => {
    render(<CodingTaskSessionBar session={current} active={active} onHistory={vi.fn()} />);

    expect(screen.getByRole("button", { name: "Fork task" })).toBeDisabled();
  });

  // #3903 AC4: a workspace provisioned from the task's own is offered for the task to continue in.
  it("offers each workspace provisioned from the task's own to continue the task in", () => {
    const target = { workspaceId: "workspace-2", name: "feature-x" };
    const offered = { ...sessionWith([]), forkTargets: [target] };
    const { rerender } = render(
      <CodingTaskSessionBar session={offered} active={false} onHistory={vi.fn()} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Continue in “feature-x”" }));

    expect(offered.continueIn).toHaveBeenCalledWith(target);
    rerender(<CodingTaskSessionBar session={offered} active onHistory={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Continue in “feature-x”" })).toBeDisabled();
  });

  // #3904 AC4: an imported task's implicit fork does not hold continuing it in another workspace.
  it("keeps continuing an imported task elsewhere open beside its implicit fork", () => {
    const target = { workspaceId: "workspace-2", name: "feature-x" };
    const imported = {
      ...sessionWith([]),
      fork: { taskId: "task-7", title: "t", implicit: true as const },
      forkTargets: [target],
    };
    const { rerender } = render(
      <CodingTaskSessionBar session={imported} active={false} onHistory={vi.fn()} />,
    );

    expect(screen.getByRole("button", { name: "Fork task" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Continue in “feature-x”" })).toBeEnabled();
    const requested = { ...imported, fork: { taskId: "task-7", title: "t" } };
    rerender(<CodingTaskSessionBar session={requested} active={false} onHistory={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Continue in “feature-x”" })).toBeDisabled();
  });

  it("offers a fork before each user message, and only to a caller that can fork", () => {
    const assistant = {
      ...historyMessage("m-2", "run-6", "An answer"),
      role: "assistant" as const,
    };
    const current = sessionWith([historyMessage("m-1", "run-6", "Earlier request"), assistant]);
    const onFork = vi.fn();
    const { rerender } = render(
      <CodingTaskTranscript session={current} shownRun={undefined} onFork={onFork} />,
    );

    const forks = screen.getAllByRole("button", { name: "Fork from here" });
    expect(forks).toHaveLength(1);
    fireEvent.click(forks[0] as HTMLElement);
    expect(onFork).toHaveBeenCalledExactlyOnceWith("m-1");

    rerender(<CodingTaskTranscript session={current} shownRun={undefined} />);
    expect(screen.queryByRole("button", { name: "Fork from here" })).toBeNull();
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
