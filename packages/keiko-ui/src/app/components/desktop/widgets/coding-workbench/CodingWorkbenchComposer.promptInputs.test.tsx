import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type {
  CodingWorkbenchRuntimeStateName,
  ModelCapability,
} from "@oscharko-dev/keiko-contracts";
import type { FilesSearchResponse } from "@/lib/types";
import { I18nProvider, I18N_STORAGE_KEY, loadLocaleMessages } from "@/lib/i18n";
import { resetClientDiagnosticWriter, setClientDiagnosticWriter } from "@/lib/client-diagnostics";

const searchMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, fetchFilesSearch: searchMock };
});

import { TaskStartSection, type TaskComposerActions } from "./CodingWorkbenchSections";

// ADR-0137 D10: the composer takes a message while a turn runs (Send now / Queue) and lets the human
// reference task files with `@`. Both are offered only where the server says the runtime can.

const MODEL: ModelCapability = {
  id: "gpt-5.4",
  kind: "chat",
  contextWindow: 128_000,
  maxOutputTokens: 16_384,
  toolCalling: true,
  structuredOutput: true,
  streaming: true,
  supportsImageInput: false,
  supportsDocumentInput: false,
  workflowEligible: true,
  costClass: "medium",
  latencyClass: "standard",
  throughputHint: "standard",
  preferredUseCases: ["Coding"],
  knownLimitations: [],
  reasoningEfforts: [],
};

const AXE_OPTIONS = { rules: { region: { enabled: false } } } as const;
const ROOT = "/work/space";
const ENABLED = { delivery: true, references: true } as const;

type ComposerProps = Parameters<typeof TaskStartSection>[0];

type Fn<K extends keyof TaskComposerActions> = NonNullable<TaskComposerActions[K]>;

interface ActionMocks extends TaskComposerActions {
  readonly onStart: Mock<Fn<"onStart">>;
  readonly onPause: Mock<Fn<"onPause">>;
  readonly onResume: Mock<Fn<"onResume">>;
  readonly onSend: Mock<Fn<"onSend">>;
  readonly onDeliver: Mock<Fn<"onDeliver">>;
  readonly onStop: Mock<Fn<"onStop">>;
}

function actions(): ActionMocks {
  return {
    onStart: vi.fn<Fn<"onStart">>(),
    onPause: vi.fn<Fn<"onPause">>(),
    onResume: vi.fn<Fn<"onResume">>(),
    onSend: vi.fn<Fn<"onSend">>(),
    onDeliver: vi.fn<Fn<"onDeliver">>(),
    onStop: vi.fn<Fn<"onStop">>(),
  };
}

function props(
  runState: CodingWorkbenchRuntimeStateName,
  taskActions: TaskComposerActions,
  overrides: Partial<ComposerProps> = {},
): ComposerProps {
  return {
    taskIntent: "",
    onTaskIntentChange: vi.fn(),
    actions: taskActions,
    canStart: true,
    canResume: true,
    runState,
    mutationPending: false,
    startBusy: false,
    startBlockedReason: null,
    projectMemoryEnabled: true,
    onProjectMemoryEnabledChange: vi.fn(),
    autonomyMode: "supervised-coding",
    autonomyLabel: "Supervised workspace",
    requestedMode: "supervised-coding",
    runtimePreference: "managed-gateway",
    configurationLocked: runState !== "idle",
    onRequestedModeChange: vi.fn(),
    onRuntimePreferenceChange: vi.fn(),
    models: [MODEL],
    selectedModelId: MODEL.id,
    reasoningEffort: null,
    onSelectedModelChange: vi.fn(),
    onReasoningEffortChange: vi.fn(),
    offeredAgents: ["build"],
    agent: "build",
    agentLocked: false,
    onAgentChange: vi.fn(),
    ...overrides,
  };
}

/** The composer with a real draft, as the window keeps it, so mentions and chips follow the text. */
function Harness(inputProps: {
  readonly runState: CodingWorkbenchRuntimeStateName;
  readonly taskActions: TaskComposerActions;
  readonly initialDraft?: string;
  readonly overrides?: Partial<ComposerProps>;
}): ReactNode {
  const [draft, setDraft] = useState(inputProps.initialDraft ?? "");
  return (
    <TaskStartSection
      {...props(inputProps.runState, inputProps.taskActions, {
        promptInputs: ENABLED,
        referenceRoot: ROOT,
        ...inputProps.overrides,
      })}
      taskIntent={draft}
      onTaskIntentChange={setDraft}
    />
  );
}

function searchResult(path: string, root = ROOT): FilesSearchResponse["results"][number] {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const slash = path.lastIndexOf("/");
  return {
    root,
    path,
    name,
    directory: slash < 0 ? "" : path.slice(0, slash),
    extension: name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : null,
    sizeBytes: 10,
    modifiedAt: 1,
  };
}

function respondWith(...paths: string[]): void {
  searchMock.mockResolvedValue({
    root: ROOT,
    query: "app",
    results: paths.map((path) => searchResult(path)),
    truncated: false,
    scannedFileCount: paths.length,
  } satisfies FilesSearchResponse);
}

// The composer's one textbox, whatever the locale names it.
const textbox = (): HTMLTextAreaElement => screen.getByRole("textbox") as HTMLTextAreaElement;

beforeEach(() => {
  searchMock.mockReset();
  searchMock.mockResolvedValue({
    root: ROOT,
    query: "",
    results: [],
    truncated: false,
    scannedFileCount: 0,
  });
});

afterEach(() => {
  cleanup();
  window.localStorage.removeItem(I18N_STORAGE_KEY);
  resetClientDiagnosticWriter();
});

describe("Send now and Queue while a turn runs", () => {
  it("offers both beside Pause and Stop only where the runtime takes messages", () => {
    render(<TaskStartSection {...props("running", actions(), { promptInputs: ENABLED })} />);
    expect(screen.getByRole("button", { name: "Pause run" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Queue message" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send now" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stop run" })).toBeInTheDocument();
    cleanup();

    for (const promptInputs of [
      undefined,
      { delivery: false, references: true },
      { delivery: false, references: false },
    ]) {
      render(<TaskStartSection {...props("running", actions(), { promptInputs })} />);
      expect(screen.queryByRole("button", { name: "Send now" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Queue message" })).toBeNull();
      cleanup();
    }
    // No handler, no buttons: the window decides whether it can deliver.
    const noDeliver = { ...actions(), onDeliver: undefined };
    render(<TaskStartSection {...props("running", noDeliver, { promptInputs: ENABLED })} />);
    expect(screen.queryByRole("button", { name: "Send now" })).toBeNull();
  });

  it.each(["paused", "idle", "awaiting-approval", "stopping"] as const)(
    "does not offer them while the run is %s",
    (runState) => {
      render(<TaskStartSection {...props(runState, actions(), { promptInputs: ENABLED })} />);
      expect(screen.queryByRole("button", { name: "Send now" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Queue message" })).toBeNull();
    },
  );

  it("sends the draft into the turn with Send now and queues it behind the turn with Queue", async () => {
    const user = userEvent.setup();
    const taskActions = actions();
    render(
      <TaskStartSection
        {...props("running", taskActions, {
          promptInputs: ENABLED,
          taskIntent: "also cover empty",
        })}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Send now" }));
    expect(taskActions.onDeliver).toHaveBeenLastCalledWith("also cover empty", "steer", []);
    await user.click(screen.getByRole("button", { name: "Queue message" }));
    expect(taskActions.onDeliver).toHaveBeenLastCalledWith("also cover empty", "queue", []);
    expect(taskActions.onPause).not.toHaveBeenCalled();
  });

  it("explains an empty message instead of sending it, and does not pause", async () => {
    const user = userEvent.setup();
    const taskActions = actions();
    render(<TaskStartSection {...props("running", taskActions, { promptInputs: ENABLED })} />);
    const send = screen.getByRole("button", { name: "Send now" });
    expect(send).toHaveAttribute("aria-disabled", "true");
    await user.click(send);
    expect(screen.getByRole("alert")).toHaveTextContent("Write a message first.");
    expect(taskActions.onDeliver).not.toHaveBeenCalled();
    expect(taskActions.onPause).not.toHaveBeenCalled();
  });

  it("is keyboard accessible: Enter sends now, Ctrl or Cmd+Enter queues, Shift+Enter breaks the line", async () => {
    const user = userEvent.setup();
    const taskActions = actions();
    render(<Harness runState="running" taskActions={taskActions} initialDraft="steer me" />);
    const input = textbox();
    input.focus();
    await user.keyboard("{Shift>}{Enter}{/Shift}");
    expect(taskActions.onDeliver).not.toHaveBeenCalled();
    await user.clear(input);
    await user.type(input, "steer me");
    await user.keyboard("{Enter}");
    expect(taskActions.onDeliver).toHaveBeenLastCalledWith("steer me", "steer", []);
    await user.keyboard("{Control>}{Enter}{/Control}");
    expect(taskActions.onDeliver).toHaveBeenLastCalledWith("steer me", "queue", []);
    await user.keyboard("{Meta>}{Enter}{/Meta}");
    expect(taskActions.onDeliver).toHaveBeenLastCalledWith("steer me", "queue", []);
    expect(taskActions.onDeliver).toHaveBeenCalledTimes(3);
    expect(screen.getByRole("button", { name: "Send now" })).toHaveAttribute(
      "aria-keyshortcuts",
      "Enter",
    );
    expect(screen.getByRole("button", { name: "Queue message" })).toHaveAttribute(
      "aria-keyshortcuts",
      "Control+Enter Meta+Enter",
    );
  });

  it("does not submit while an IME composition is open", () => {
    const taskActions = actions();
    render(
      <TaskStartSection
        {...props("running", taskActions, { promptInputs: ENABLED, taskIntent: "x" })}
      />,
    );
    fireEvent.keyDown(textbox(), { key: "Enter", isComposing: true });
    fireEvent.keyDown(textbox(), { key: "Enter", ctrlKey: true, isComposing: true });
    expect(taskActions.onDeliver).not.toHaveBeenCalled();
    expect(taskActions.onPause).not.toHaveBeenCalled();
  });

  it("keeps Enter on an empty draft pausing the run, and Enter without the capability too", async () => {
    const user = userEvent.setup();
    const empty = actions();
    render(<TaskStartSection {...props("running", empty, { promptInputs: ENABLED })} />);
    textbox().focus();
    await user.keyboard("{Enter}");
    expect(empty.onPause).toHaveBeenCalledOnce();
    expect(empty.onDeliver).not.toHaveBeenCalled();
    cleanup();

    const plain = actions();
    render(<TaskStartSection {...props("running", plain, { taskIntent: "a message" })} />);
    textbox().focus();
    await user.keyboard("{Enter}");
    expect(plain.onPause).toHaveBeenCalledOnce();
    expect(plain.onDeliver).not.toHaveBeenCalled();
    await user.keyboard("{Control>}{Enter}{/Control}");
    expect(plain.onDeliver).not.toHaveBeenCalled();
  });

  it("disables the message buttons, not just blocks them, while an action is pending", () => {
    render(
      <TaskStartSection
        {...props("running", actions(), {
          promptInputs: ENABLED,
          taskIntent: "x",
          mutationPending: true,
        })}
      />,
    );
    expect(screen.getByRole("button", { name: "Send now" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Queue message" })).toBeDisabled();
  });

  it("reports a delivered message as a follow-up submission without its text", async () => {
    const evidence: unknown[] = [];
    setClientDiagnosticWriter((_message, meta): void => {
      if (meta?.composerSubmission !== undefined) evidence.push(meta.composerSubmission);
    });
    const user = userEvent.setup();
    render(
      <TaskStartSection
        {...props("running", actions(), { promptInputs: ENABLED, taskIntent: "PRIVATE_MESSAGE" })}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Send now" }));
    expect(evidence).toMatchObject([{ kind: "follow-up", outcome: "attempted" }]);
    expect(JSON.stringify(evidence)).not.toContain("PRIVATE_MESSAGE");
  });

  it.each([
    ["steer", "Message sent. It joins the running task at its next step."],
    ["queue", "Message queued. It is delivered after the running task's current work."],
  ] as const)("announces a %s message once the server accepted it", (notice, text) => {
    render(
      <TaskStartSection
        {...props("running", actions(), { promptInputs: ENABLED, deliveryNotice: notice })}
      />,
    );
    expect(screen.getByText(text)).toHaveAttribute("role", "status");
  });

  it("keeps a refusal visible, but a sent notice only while the turn runs", () => {
    const failed = render(
      <TaskStartSection
        {...props("idle", actions(), { promptInputs: ENABLED, deliveryNotice: "failed" })}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(/was not sent and your text is kept/u);
    failed.unmount();
    render(
      <TaskStartSection
        {...props("idle", actions(), { promptInputs: ENABLED, deliveryNotice: "steer" })}
      />,
    );
    expect(screen.queryByText(/Message sent/u)).toBeNull();
  });

  it("is labelled in German and has no accessibility violations", async () => {
    await loadLocaleMessages("de");
    window.localStorage.setItem(I18N_STORAGE_KEY, "de");
    render(
      <I18nProvider>
        <TaskStartSection
          {...props("running", actions(), {
            promptInputs: ENABLED,
            taskIntent: "Hallo",
            deliveryNotice: "queue",
          })}
        />
      </I18nProvider>,
    );
    expect(screen.getByRole("button", { name: "Jetzt senden" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Nachricht einreihen" })).toBeInTheDocument();
    expect(screen.getByText(/Nachricht eingereiht/u)).toBeInTheDocument();
    expect(await axe(document.body, AXE_OPTIONS)).toHaveNoViolations();
  });

  it("has no accessibility violations with the message buttons shown", async () => {
    render(
      <TaskStartSection
        {...props("running", actions(), { promptInputs: ENABLED, taskIntent: "x" })}
      />,
    );
    expect(await axe(document.body, AXE_OPTIONS)).toHaveNoViolations();
  });
});

describe("the @ file picker", () => {
  async function typeMention(query = "app"): Promise<ReturnType<typeof userEvent.setup>> {
    const user = userEvent.setup();
    await user.click(textbox());
    await user.type(textbox(), `look at @${query}`);
    return user;
  }

  it("opens on @, searches the run's workspace and lists workspace-relative matches", async () => {
    respondWith("src/app.ts", "src/app.test.ts");
    render(<Harness runState="running" taskActions={actions()} />);
    await typeMention();

    const list = await screen.findByRole("list", { name: "Matching task files" });
    expect(within(list).getAllByRole("button")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Reference src/app.ts" })).toBeInTheDocument();
    expect(searchMock).toHaveBeenLastCalledWith(ROOT, "app", 8, {
      signal: expect.any(AbortSignal) as unknown,
    });
    expect(
      screen.getByText("2 files found. Use the arrow keys to choose and Enter to reference one."),
    ).toBeInTheDocument();
    expect(textbox()).toHaveAttribute("aria-controls", list.id);
  });

  it("picks the highlighted file with Enter: the @path lands in the draft, a chip appears and the caret moves behind it", async () => {
    respondWith("src/app.ts", "src/app.test.ts");
    const taskActions = actions();
    render(<Harness runState="running" taskActions={taskActions} />);
    const user = await typeMention();
    await screen.findByRole("list", { name: "Matching task files" });

    await user.keyboard("{ArrowDown}");
    await user.keyboard("{Enter}");

    expect(textbox().value).toBe("look at @src/app.test.ts ");
    expect(textbox().selectionStart).toBe(textbox().value.length);
    expect(screen.queryByRole("list", { name: "Matching task files" })).toBeNull();
    const chips = screen.getByRole("list", { name: "Referenced files" });
    expect(within(chips).getByText("src/app.test.ts")).toBeInTheDocument();
    // Enter picked; it neither submitted nor paused.
    expect(taskActions.onDeliver).not.toHaveBeenCalled();
    expect(taskActions.onPause).not.toHaveBeenCalled();
  });

  it("wraps the active option with the arrow keys and picks with Tab or a pointer too", async () => {
    respondWith("a.ts", "b.ts", "c.ts");
    render(<Harness runState="paused" taskActions={actions()} />);
    const user = await typeMention("x");
    await screen.findByRole("list", { name: "Matching task files" });

    await user.keyboard("{ArrowUp}");
    expect(screen.getByRole("button", { name: "Reference c.ts" })).toHaveAttribute(
      "data-highlighted",
      "true",
    );
    expect(screen.getByText("c.ts, 3 of 3")).toBeInTheDocument();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("button", { name: "Reference a.ts" })).toHaveAttribute(
      "data-highlighted",
      "true",
    );
    await user.keyboard("{Tab}");
    expect(textbox().value).toContain("@a.ts");

    await user.type(textbox(), "and @b");
    await screen.findByRole("list", { name: "Matching task files" });
    await user.click(screen.getByRole("button", { name: "Reference b.ts" }));
    expect(textbox().value).toContain("@b.ts");
    expect(
      within(screen.getByRole("list", { name: "Referenced files" })).getAllByRole("listitem"),
    ).toHaveLength(2);
  });

  it("sends the picked files with a follow-up to a paused run and with Send now to a running one", async () => {
    respondWith("src/app.ts");
    const paused = actions();
    const first = render(<Harness runState="paused" taskActions={paused} />);
    const user = await typeMention();
    await screen.findByRole("list", { name: "Matching task files" });
    await user.keyboard("{Enter}");
    await user.type(textbox(), "please");
    await user.click(screen.getByRole("button", { name: "Send follow-up" }));
    expect(paused.onSend).toHaveBeenCalledExactlyOnceWith("look at @src/app.ts please", [
      { path: "src/app.ts" },
    ]);
    first.unmount();

    const running = actions();
    render(<Harness runState="running" taskActions={running} />);
    const second = await typeMention();
    await screen.findByRole("list", { name: "Matching task files" });
    await second.keyboard("{Enter}");
    await second.click(screen.getByRole("button", { name: "Queue message" }));
    // The window trims the draft it sends; the composer hands over what the textarea shows.
    expect(running.onDeliver).toHaveBeenCalledExactlyOnceWith("look at @src/app.ts ", "queue", [
      { path: "src/app.ts" },
    ]);
  });

  it("sends an ordinary follow-up with the historical single argument when nothing is referenced", async () => {
    const user = userEvent.setup();
    const paused = actions();
    render(<Harness runState="paused" taskActions={paused} initialDraft="just text" />);
    await user.click(screen.getByRole("button", { name: "Send follow-up" }));
    expect(paused.onSend).toHaveBeenCalledExactlyOnceWith("just text");
  });

  it("drops a reference when its @path token is deleted or its chip removed", async () => {
    respondWith("src/app.ts", "docs/My Notes.md");
    render(<Harness runState="running" taskActions={actions()} />);
    const user = await typeMention();
    await screen.findByRole("list", { name: "Matching task files" });
    await user.keyboard("{Enter}");
    expect(screen.getByRole("list", { name: "Referenced files" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Remove reference to src/app.ts" }));
    expect(textbox().value.includes("@src/app.ts")).toBe(false);
    expect(screen.queryByRole("list", { name: "Referenced files" })).toBeNull();

    await user.clear(textbox());
    await user.type(textbox(), "@app");
    await screen.findByRole("list", { name: "Matching task files" });
    await user.keyboard("{Enter}");
    await user.clear(textbox());
    await waitFor(() =>
      expect(screen.queryByRole("list", { name: "Referenced files" })).toBeNull(),
    );
  });

  it("writes a path with spaces as one quoted token and still references it", async () => {
    respondWith("docs/My Notes.md");
    const running = actions();
    render(<Harness runState="running" taskActions={running} />);
    const user = await typeMention("notes");
    await screen.findByRole("list", { name: "Matching task files" });
    await user.keyboard("{Enter}");
    expect(textbox().value).toBe('look at @"docs/My Notes.md" ');
    await user.click(screen.getByRole("button", { name: "Send now" }));
    expect(running.onDeliver).toHaveBeenCalledWith('look at @"docs/My Notes.md" ', "steer", [
      { path: "docs/My Notes.md" },
    ]);
  });

  it("joins a hit from a nested Git root back onto the run's workspace and drops a foreign one", async () => {
    searchMock.mockResolvedValue({
      root: ROOT,
      query: "index",
      results: [
        searchResult("src/index.ts", `${ROOT}/packages/lib`),
        searchResult("elsewhere/index.ts", "/work/other"),
      ],
      truncated: false,
      scannedFileCount: 2,
    } satisfies FilesSearchResponse);
    render(<Harness runState="running" taskActions={actions()} />);
    await typeMention("index");
    await screen.findByRole("button", { name: "Reference packages/lib/src/index.ts" });
    expect(screen.queryByRole("button", { name: /elsewhere/u })).toBeNull();
  });

  it("closes with Escape without picking and stays closed for that mention", async () => {
    respondWith("src/app.ts");
    render(<Harness runState="running" taskActions={actions()} />);
    const user = await typeMention();
    await screen.findByRole("list", { name: "Matching task files" });
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("group", { name: "Reference a task file" })).toBeNull();
    expect(textbox().value).toBe("look at @app");
    await user.type(textbox(), "l");
    expect(screen.queryByRole("group", { name: "Reference a task file" })).toBeNull();
  });

  it("says when nothing matches and when the search failed, and reports the failure body-free", async () => {
    const evidence: { message: string; meta: unknown }[] = [];
    setClientDiagnosticWriter((message, meta): void => {
      evidence.push({ message, meta });
    });
    searchMock.mockResolvedValueOnce({
      root: ROOT,
      query: "zzz",
      results: [],
      truncated: false,
      scannedFileCount: 0,
    });
    render(<Harness runState="running" taskActions={actions()} />);
    const user = await typeMention("zzz");
    expect(await screen.findByText("No matching files.")).toBeInTheDocument();

    searchMock.mockRejectedValueOnce(new Error("PRIVATE_FAILURE"));
    await user.type(textbox(), "q");
    expect(await screen.findByText(/The file search failed/u)).toBeInTheDocument();
    expect(JSON.stringify(evidence)).toContain("file reference search failed");
    expect(JSON.stringify(evidence)).not.toContain("PRIVATE_FAILURE");
  });

  it("shows a hint for a bare @ and searches nothing until there is a query", async () => {
    render(<Harness runState="running" taskActions={actions()} />);
    const user = userEvent.setup();
    await user.click(textbox());
    await user.type(textbox(), "@");
    expect(await screen.findByText("Type to search the task's files.")).toBeInTheDocument();
    expect(searchMock).not.toHaveBeenCalled();
  });

  it("stops offering files at the contract's bound of sixteen", async () => {
    const paths = Array.from({ length: 17 }, (_, index) => `f${String(index)}.ts`);
    searchMock.mockImplementation((_root: string, query: string) =>
      Promise.resolve({
        root: ROOT,
        query,
        results: paths.filter((path) => path.startsWith(query)).map((path) => searchResult(path)),
        truncated: false,
        scannedFileCount: 17,
      }),
    );
    const mentions = paths.slice(0, 16).map((path) => `@${path}`);
    const running = actions();
    const user = userEvent.setup();
    render(<Harness runState="running" taskActions={running} />);
    for (const path of paths.slice(0, 16)) {
      await user.type(textbox(), `@${path}`);
      await screen.findByRole("button", { name: `Reference ${path}` });
      await user.keyboard("{Enter}");
    }
    expect(textbox().value.trim().split(/\s+/u)).toEqual(mentions);
    await user.type(textbox(), "@f16");
    expect(
      await screen.findByText("At most 16 files can be referenced in one message."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reference f16.ts" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Send now" }));
    const sent = running.onDeliver.mock.calls.at(-1)?.[2] as readonly { path: string }[];
    expect(sent).toHaveLength(16);
  });

  it("is not offered when the runtime takes no references, without a workspace root, or between runs", async () => {
    const cases: Partial<ComposerProps>[] = [
      { promptInputs: { delivery: true, references: false } },
      { promptInputs: undefined },
      { referenceRoot: null },
      { referenceRoot: undefined },
    ];
    for (const overrides of cases) {
      const view = render(
        <Harness runState="running" taskActions={actions()} overrides={overrides} />,
      );
      const user = userEvent.setup();
      await user.click(textbox());
      await user.type(textbox(), "@app");
      expect(screen.queryByRole("group", { name: "Reference a task file" })).toBeNull();
      view.unmount();
    }
    for (const runState of ["idle", "starting", "awaiting-approval"] as const) {
      const view = render(<Harness runState={runState} taskActions={actions()} />);
      const user = userEvent.setup();
      await user.click(textbox());
      await user.type(textbox(), "@app");
      expect(screen.queryByRole("group", { name: "Reference a task file" })).toBeNull();
      view.unmount();
    }
    expect(searchMock).not.toHaveBeenCalled();
  });

  it("does not open for an @ inside a word", async () => {
    render(<Harness runState="running" taskActions={actions()} />);
    const user = userEvent.setup();
    await user.click(textbox());
    await user.type(textbox(), "mail me@example");
    expect(screen.queryByRole("group", { name: "Reference a task file" })).toBeNull();
    expect(searchMock).not.toHaveBeenCalled();
  });

  it("has no accessibility violations with the picker open and a chip shown", async () => {
    respondWith("src/app.ts", "src/app.test.ts");
    render(<Harness runState="running" taskActions={actions()} initialDraft="" />);
    const user = await typeMention();
    await screen.findByRole("list", { name: "Matching task files" });
    expect(await axe(document.body, AXE_OPTIONS)).toHaveNoViolations();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("list", { name: "Referenced files" })).toBeInTheDocument();
    expect(await axe(document.body, AXE_OPTIONS)).toHaveNoViolations();
  });

  it("is labelled in German", async () => {
    await loadLocaleMessages("de");
    window.localStorage.setItem(I18N_STORAGE_KEY, "de");
    respondWith("src/app.ts");
    render(
      <I18nProvider>
        <Harness runState="running" taskActions={actions()} />
      </I18nProvider>,
    );
    await typeMention();
    expect(
      await screen.findByRole("list", { name: "Passende Aufgabendateien" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "src/app.ts referenzieren" })).toBeInTheDocument();
    expect(screen.getByText(/Dateien gefunden|Datei gefunden/u)).toBeInTheDocument();
  });
});
