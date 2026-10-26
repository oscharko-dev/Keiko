import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodingWorkbenchRuntimeStateName } from "@oscharko-dev/keiko-contracts";
import type { CodingWorkbenchRuntimeCommandsChannelPayload } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime-api";
import type { FilesSearchResponse } from "@/lib/types";
import { ApiError } from "@/lib/api";
import { I18nProvider, I18N_STORAGE_KEY, loadLocaleMessages } from "@/lib/i18n";
import { resetClientDiagnosticWriter, setClientDiagnosticWriter } from "@/lib/client-diagnostics";

const searchMock = vi.hoisted(() => vi.fn());
const commandsMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, fetchFilesSearch: searchMock };
});
vi.mock("@/lib/coding-workbench-runtime-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/coding-workbench-runtime-api")>()),
  fetchCodingWorkbenchRuntimeCommands: commandsMock,
}));
vi.mock("@/lib/coding-app-session-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/coding-app-session-client")>()),
  codingAppSessionPairingSettled: (): Promise<boolean> => Promise.resolve(true),
}));

import {
  AXE_OPTIONS,
  ENABLED,
  Harness,
  ROOT,
  WITH_COMMANDS,
  actions,
  searchResult,
  textbox,
  type ActionMocks,
  type ComposerProps,
} from "./_composerPromptTestSupport";

// Parity row C02 (ADR-0137 D10): the composer opens a `/` menu of the runtime's slash commands while
// the draft starts with `/`. A new task is offered the built-in commands; a paused run is offered
// what its own runtime lists. A recognized command is sent by name, its text being the arguments.

const LISTING = [
  { name: "init", description: "RUNTIME_INIT_TEXT" },
  { name: "review" },
  { name: "team:deploy-check", description: "Check a deployment" },
] as const;

function active(
  commands: CodingWorkbenchRuntimeCommandsChannelPayload["commands"] = LISTING,
): CodingWorkbenchRuntimeCommandsChannelPayload {
  return { session: "active", commands };
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

const menu = (): HTMLElement => screen.getByRole("group", { name: "Run a slash command" });
const noMenu = (): void =>
  expect(screen.queryByRole("group", { name: "Run a slash command" })).toBeNull();
const optionLabels = (): string[] =>
  within(screen.getByRole("list", { name: "Matching commands" }))
    .getAllByRole("button")
    .map((button) => button.getAttribute("aria-label") ?? "");

function renderNewTask(
  runState: CodingWorkbenchRuntimeStateName = "idle",
  overrides: Partial<ComposerProps> = {},
  taskActions: ActionMocks = actions(),
): ActionMocks {
  render(
    <Harness
      runState={runState}
      taskActions={taskActions}
      overrides={{ promptInputs: WITH_COMMANDS, ...overrides }}
    />,
  );
  return taskActions;
}

function renderPaused(
  overrides: Partial<ComposerProps> = {},
  taskActions: ActionMocks = actions(),
): ActionMocks {
  render(
    <Harness
      runState="paused"
      taskActions={taskActions}
      overrides={{ promptInputs: WITH_COMMANDS, runId: "run-1", ...overrides }}
    />,
  );
  return taskActions;
}

async function typeInto(text: string): Promise<ReturnType<typeof userEvent.setup>> {
  const user = userEvent.setup();
  await user.click(textbox());
  await user.type(textbox(), text);
  return user;
}

beforeEach(() => {
  searchMock.mockReset();
  searchMock.mockResolvedValue({
    root: ROOT,
    query: "",
    results: [],
    truncated: false,
    scannedFileCount: 0,
  });
  commandsMock.mockReset();
  commandsMock.mockResolvedValue(active());
});

afterEach(() => {
  cleanup();
  window.localStorage.removeItem(I18N_STORAGE_KEY);
  resetClientDiagnosticWriter();
});

describe("the / command menu for a new task", () => {
  it("opens on a slash and lists the built-in commands with their localized descriptions", async () => {
    renderNewTask();
    await typeInto("/");

    expect(optionLabels()).toEqual(["Run command /init", "Run command /review"]);
    const list = screen.getByRole("list", { name: "Matching commands" });
    expect(within(list).getByText("/init")).toBeInTheDocument();
    expect(
      within(list).getByText("Guided AGENTS.md setup for this repository"),
    ).toBeInTheDocument();
    expect(within(list).getByText(/Review changes \[commit\|branch\|pr\]/u)).toBeInTheDocument();
    expect(
      screen.getByText(
        "Commands available: 2. Use the arrow keys to choose and Enter to select one.",
      ),
    ).toBeInTheDocument();
    expect(textbox()).toHaveAttribute("aria-controls", list.id);
    // A new task has no run to ask: the built-ins need no request.
    expect(commandsMock).not.toHaveBeenCalled();
  });

  it("narrows by a case-insensitive part of the name as it is typed", async () => {
    renderNewTask();
    const user = await typeInto("/RE");
    expect(optionLabels()).toEqual(["Run command /review"]);

    await user.clear(textbox());
    await user.type(textbox(), "/nit");
    expect(optionLabels()).toEqual(["Run command /init"]);

    await user.clear(textbox());
    await user.type(textbox(), "/zzz");
    expect(screen.getByText("No matching commands.")).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Matching commands" })).toBeNull();
    expect(textbox()).not.toHaveAttribute("aria-controls");
  });

  it("moves with the arrow keys, wraps, announces the active option and chooses with Enter", async () => {
    const idle = renderNewTask();
    const user = await typeInto("/");
    await screen.findByRole("list", { name: "Matching commands" });
    expect(screen.getByRole("button", { name: "Run command /init" })).toHaveAttribute(
      "data-highlighted",
      "true",
    );

    await user.keyboard("{ArrowUp}");
    expect(screen.getByRole("button", { name: "Run command /review" })).toHaveAttribute(
      "data-highlighted",
      "true",
    );
    expect(screen.getByText("/review, 2 of 2")).toBeInTheDocument();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByText("/init, 1 of 2")).toBeInTheDocument();
    await user.keyboard("{ArrowDown}");
    await user.keyboard("{Enter}");

    expect(textbox().value).toBe("/review ");
    expect(textbox().selectionStart).toBe(8);
    expect(textbox()).toHaveFocus();
    noMenu();
    // Enter chose; it did not start the task.
    expect(idle.onStart).not.toHaveBeenCalled();
  });

  it("chooses with Tab, and with a pointer press that leaves the caret in the draft", async () => {
    const idle = renderNewTask();
    const user = await typeInto("/");
    await screen.findByRole("list", { name: "Matching commands" });
    await user.keyboard("{Tab}");
    expect(textbox().value).toBe("/init ");
    noMenu();

    await user.clear(textbox());
    await user.type(textbox(), "/");
    await user.click(await screen.findByRole("button", { name: "Run command /review" }));
    expect(textbox().value).toBe("/review ");
    expect(textbox()).toHaveFocus();
    expect(idle.onStart).not.toHaveBeenCalled();
  });

  it("keeps the text typed after the command when another command replaces the token", async () => {
    renderNewTask();
    const user = await typeInto("/re some arguments");
    noMenu();
    // Move the caret back into the first token.
    await user.keyboard("{Home}{ArrowRight}{ArrowRight}");
    await screen.findByRole("list", { name: "Matching commands" });
    await user.keyboard("{Enter}");

    expect(textbox().value).toBe("/review some arguments");
    expect(textbox().selectionStart).toBe(8);
  });

  it("closes with Escape without choosing and stays closed for that token", async () => {
    renderNewTask();
    const user = await typeInto("/re");
    await screen.findByRole("list", { name: "Matching commands" });

    await user.keyboard("{Escape}");
    noMenu();
    expect(textbox().value).toBe("/re");
    await user.type(textbox(), "v");
    noMenu();

    // Emptying the draft ends that token; the next slash opens the menu again.
    await user.clear(textbox());
    await user.type(textbox(), "/");
    expect(await screen.findByRole("list", { name: "Matching commands" })).toBeInTheDocument();
  });

  it("closes once whitespace follows the name or the draft does not start with a slash", async () => {
    renderNewTask();
    const user = await typeInto("/review");
    await screen.findByRole("list", { name: "Matching commands" });
    await user.type(textbox(), " ");
    noMenu();
    await user.clear(textbox());

    for (const draft of ["review", "say /review", "/usr/bin", " /"]) {
      await user.type(textbox(), draft);
      noMenu();
      await user.clear(textbox());
    }
    expect(commandsMock).not.toHaveBeenCalled();
  });

  it("is not offered where the runtime offers no commands, whatever else it offers", async () => {
    const cases: Partial<ComposerProps>[] = [
      { promptInputs: ENABLED },
      { promptInputs: { delivery: true, references: true, commands: false } },
      { promptInputs: undefined },
    ];
    for (const overrides of cases) {
      const idle = actions();
      const view = render(<Harness runState="idle" taskActions={idle} overrides={overrides} />);
      const user = await typeInto("/review now");
      noMenu();
      expect(textbox()).not.toHaveAttribute("aria-controls");
      await user.click(screen.getByRole("button", { name: "Start coding run" }));
      // The slash stays the person's own text.
      expect(idle.onStart).toHaveBeenCalledExactlyOnceWith("/review now");
      view.unmount();
    }
  });

  it.each(["running", "starting", "ready", "awaiting-approval", "stopping"] as const)(
    "is not offered while the run is %s",
    async (runState) => {
      renderNewTask(runState, { runId: "run-1" });
      await typeInto("/");
      noMenu();
      expect(commandsMock).not.toHaveBeenCalled();
    },
  );

  it.each(["succeeded", "failed", "cancelled"] as const)(
    "is offered again once the previous run is %s and a new task is next",
    async (runState) => {
      renderNewTask(runState);
      await typeInto("/");
      expect(await screen.findByRole("list", { name: "Matching commands" })).toBeInTheDocument();
    },
  );

  it("leaves no menu behind when the draft is emptied from outside, as a started task does", async () => {
    render(
      <Harness
        runState="idle"
        taskActions={actions()}
        overrides={{ promptInputs: WITH_COMMANDS }}
        clearButton
      />,
    );
    const user = await typeInto("/re");
    await screen.findByRole("list", { name: "Matching commands" });

    await user.click(screen.getByRole("button", { name: "Clear draft from outside" }));

    expect(textbox().value).toBe("");
    noMenu();
    expect(textbox()).not.toHaveAttribute("aria-controls");
  });

  it("has no accessibility violations with the menu open, empty and in German", async () => {
    renderNewTask();
    const user = await typeInto("/");
    await screen.findByRole("list", { name: "Matching commands" });
    expect(await axe(document.body, AXE_OPTIONS)).toHaveNoViolations();
    await user.type(textbox(), "zzz");
    expect(screen.getByText("No matching commands.")).toBeInTheDocument();
    expect(await axe(document.body, AXE_OPTIONS)).toHaveNoViolations();
    cleanup();

    await loadLocaleMessages("de");
    window.localStorage.setItem(I18N_STORAGE_KEY, "de");
    render(
      <I18nProvider>
        <Harness
          runState="idle"
          taskActions={actions()}
          overrides={{ promptInputs: WITH_COMMANDS }}
        />
      </I18nProvider>,
    );
    await typeInto("/");
    expect(
      await screen.findByRole("group", { name: "Einen Slash-Befehl ausführen" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Passende Befehle" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Befehl /review ausführen" })).toBeInTheDocument();
    expect(screen.getByText(/Geführte Einrichtung der AGENTS\.md/u)).toBeInTheDocument();
    expect(screen.getByText(/Verfügbare Befehle: 2/u)).toBeInTheDocument();
    expect(await axe(document.body, AXE_OPTIONS)).toHaveNoViolations();
  });
});

describe("the / command menu for a paused run", () => {
  it("reads the run's own listing the first time the menu opens, and only then", async () => {
    renderPaused();
    await Promise.resolve();
    expect(commandsMock).not.toHaveBeenCalled();

    const user = await typeInto("/");
    expect(await screen.findByRole("list", { name: "Matching commands" })).toBeInTheDocument();
    expect(commandsMock).toHaveBeenCalledExactlyOnceWith("run-1", {
      signal: expect.any(AbortSignal) as unknown,
    });
    expect(optionLabels()).toEqual([
      "Run command /init",
      "Run command /review",
      "Run command /team:deploy-check",
    ]);

    // Closing and opening the menu again asks nothing more.
    await user.clear(textbox());
    await user.type(textbox(), "/team");
    expect(optionLabels()).toEqual(["Run command /team:deploy-check"]);
    expect(commandsMock).toHaveBeenCalledOnce();
  });

  it("describes the built-ins in the person's words and any other command with the runtime's own", async () => {
    renderPaused();
    await typeInto("/");
    const list = await screen.findByRole("list", { name: "Matching commands" });

    expect(
      within(list).getByText("Guided AGENTS.md setup for this repository"),
    ).toBeInTheDocument();
    expect(within(list).queryByText("RUNTIME_INIT_TEXT")).toBeNull();
    expect(within(list).getByText("Check a deployment")).toBeInTheDocument();
  });

  it("shows a runtime's description as plain text, whatever the name or the text looks like", async () => {
    commandsMock.mockResolvedValue(
      active([
        { name: "constructor", description: "RUNTIME_CONSTRUCTOR_TEXT" },
        { name: "toString", description: "<img src=x onerror=alert(1)>" },
      ]),
    );
    renderPaused();
    await typeInto("/");
    const list = await screen.findByRole("list", { name: "Matching commands" });

    expect(within(list).getByText("RUNTIME_CONSTRUCTOR_TEXT")).toBeInTheDocument();
    expect(within(list).getByText("<img src=x onerror=alert(1)>")).toBeInTheDocument();
    expect(list.querySelector("img")).toBeNull();
  });

  it("offers only what the run lists, not the built-ins the run does not", async () => {
    commandsMock.mockResolvedValue(active([{ name: "team:deploy-check" }]));
    renderPaused();
    await typeInto("/");
    await screen.findByRole("list", { name: "Matching commands" });
    expect(optionLabels()).toEqual(["Run command /team:deploy-check"]);
  });

  it("says it is loading, then lists", async () => {
    let settle: ((payload: CodingWorkbenchRuntimeCommandsChannelPayload) => void) | undefined;
    commandsMock.mockReturnValue(
      new Promise<CodingWorkbenchRuntimeCommandsChannelPayload>((resolve) => {
        settle = resolve;
      }),
    );
    renderPaused();
    await typeInto("/");

    expect(await screen.findByText("Loading commands...")).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Matching commands" })).toBeNull();
    settle?.(active());
    expect(await screen.findByRole("list", { name: "Matching commands" })).toBeInTheDocument();
  });

  it("says a run that offers none offers none", async () => {
    commandsMock.mockResolvedValue({ session: "active" });
    renderPaused();
    await typeInto("/");
    expect(await screen.findByText("This task offers no slash commands.")).toBeInTheDocument();
  });

  it("says the listing could not be loaded, never that there are no commands, and retries on request", async () => {
    const evidence: { message: string; meta: unknown }[] = [];
    setClientDiagnosticWriter((message, meta): void => {
      evidence.push({ message, meta });
    });
    commandsMock.mockRejectedValueOnce(new ApiError("INTERNAL", "PRIVATE_FAILURE", 503));
    renderPaused();
    const user = await typeInto("/");

    expect(await screen.findByText("The commands could not be loaded.")).toBeInTheDocument();
    expect(screen.queryByText("This task offers no slash commands.")).toBeNull();
    expect(screen.queryByRole("list", { name: "Matching commands" })).toBeNull();
    expect(JSON.stringify(evidence)).toContain("commands channel read failed");
    expect(JSON.stringify(evidence)).not.toContain("PRIVATE_FAILURE");
    expect(await axe(document.body, AXE_OPTIONS)).toHaveNoViolations();

    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("list", { name: "Matching commands" })).toBeInTheDocument();
    expect(commandsMock).toHaveBeenCalledTimes(2);
    expect(textbox()).toHaveFocus();
  });

  it("treats an unpaired window as a failed read", async () => {
    commandsMock.mockResolvedValue({ session: "unpaired" });
    renderPaused();
    await typeInto("/");
    expect(await screen.findByText("The commands could not be loaded.")).toBeInTheDocument();
  });

  it("is not offered without a run to ask, and reads nothing", async () => {
    renderPaused({ runId: undefined });
    await typeInto("/");
    noMenu();
    expect(commandsMock).not.toHaveBeenCalled();
  });

  it("is not offered where the runtime offers no commands", async () => {
    renderPaused({ promptInputs: ENABLED });
    await typeInto("/");
    noMenu();
    expect(commandsMock).not.toHaveBeenCalled();
  });
});

describe("sending a command", () => {
  it("starts a bare command with an empty text and the command's name", async () => {
    const idle = renderNewTask();
    const user = await typeInto("/review");
    await user.keyboard("{Enter}");
    expect(idle.onStart).not.toHaveBeenCalled();
    expect(textbox().value).toBe("/review ");

    await user.keyboard("{Enter}");

    expect(idle.onStart).toHaveBeenCalledExactlyOnceWith("", {
      references: [],
      command: { name: "review" },
    });
  });

  it("starts a command with the text after it as its arguments", async () => {
    const idle = renderNewTask();
    const user = await typeInto("/review  branch main ");
    await user.click(screen.getByRole("button", { name: "Start coding run" }));
    expect(idle.onStart).toHaveBeenCalledExactlyOnceWith("branch main", {
      references: [],
      command: { name: "review" },
    });
  });

  it("starts a bare command from the button without opening the menu first", async () => {
    const user = userEvent.setup();
    const idle = actions();
    render(
      <Harness
        runState="idle"
        taskActions={idle}
        overrides={{ promptInputs: WITH_COMMANDS }}
        initialDraft="/init"
      />,
    );
    await user.click(screen.getByRole("button", { name: "Start coding run" }));
    expect(idle.onStart).toHaveBeenCalledExactlyOnceWith("", {
      references: [],
      command: { name: "init" },
    });
  });

  it("sends a name that is not offered as the ordinary text it is", async () => {
    const idle = renderNewTask();
    const user = await typeInto("/foo bar");
    await user.click(screen.getByRole("button", { name: "Start coding run" }));
    expect(idle.onStart).toHaveBeenCalledExactlyOnceWith("/foo bar");
  });

  it("matches the offered name exactly: another spelling is ordinary text", async () => {
    const idle = renderNewTask();
    const user = await typeInto("/Review the diff");
    await user.click(screen.getByRole("button", { name: "Start coding run" }));
    expect(idle.onStart).toHaveBeenCalledExactlyOnceWith("/Review the diff");
  });

  it("carries the referenced files along with a command", async () => {
    respondWith("src/app.ts");
    const idle = renderNewTask();
    const user = await typeInto("/review @app");
    await screen.findByRole("list", { name: "Matching task files" });
    await user.keyboard("{Enter}");
    expect(textbox().value).toBe("/review @src/app.ts ");

    await user.click(screen.getByRole("button", { name: "Start coding run" }));

    expect(idle.onStart).toHaveBeenCalledExactlyOnceWith("@src/app.ts", {
      references: [{ path: "src/app.ts" }],
      command: { name: "review" },
    });
  });

  it("keeps an empty draft blocked, and tells the person to describe the task", async () => {
    const user = userEvent.setup();
    const idle = renderNewTask();
    await user.click(screen.getByRole("button", { name: "Start coding run" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Describe what Keiko should do first.");
    expect(idle.onStart).not.toHaveBeenCalled();
  });

  it("sends a command to a paused run as a follow-up with the command's name", async () => {
    const paused = renderPaused();
    const user = await typeInto("/review");
    await screen.findByRole("list", { name: "Matching commands" });
    await user.keyboard("{Enter}");
    await user.keyboard("{Enter}");

    expect(paused.onSend).toHaveBeenCalledExactlyOnceWith("", [], { name: "review" });
    expect(paused.onStart).not.toHaveBeenCalled();
  });

  it("sends a command's arguments and files to a paused run", async () => {
    respondWith("src/app.ts");
    const paused = renderPaused();
    const user = await typeInto("/review pr @app");
    await screen.findByRole("list", { name: "Matching task files" });
    await user.keyboard("{Enter}");
    await user.click(screen.getByRole("button", { name: "Send follow-up" }));

    expect(paused.onSend).toHaveBeenCalledExactlyOnceWith(
      "pr @src/app.ts",
      [{ path: "src/app.ts" }],
      { name: "review" },
    );
  });

  it("sends a name the run does not list to a paused run as ordinary text", async () => {
    const paused = renderPaused();
    const user = await typeInto("/foo");
    // The run's listing has been read and has no such command.
    await screen.findByText("No matching commands.");
    await user.type(textbox(), " bar");
    await user.click(screen.getByRole("button", { name: "Send follow-up" }));
    expect(paused.onSend).toHaveBeenCalledExactlyOnceWith("/foo bar");
  });

  it("waits for the run's listing before sending a draft that opens like a command", async () => {
    let settle: ((payload: CodingWorkbenchRuntimeCommandsChannelPayload) => void) | undefined;
    commandsMock.mockReturnValue(
      new Promise<CodingWorkbenchRuntimeCommandsChannelPayload>((resolve) => {
        settle = resolve;
      }),
    );
    const paused = renderPaused();
    const user = userEvent.setup();
    await user.click(textbox());
    await user.paste("/review");
    await screen.findByText("Loading commands...");

    await user.click(screen.getByRole("button", { name: "Send follow-up" }));

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Keiko is still loading this task's commands. Send again in a moment.",
    );
    expect(paused.onSend).not.toHaveBeenCalled();

    settle?.(active());
    await waitFor(() =>
      expect(screen.getByRole("list", { name: "Matching commands" })).toBeInTheDocument(),
    );
    await user.click(screen.getByRole("button", { name: "Send follow-up" }));
    expect(paused.onSend).toHaveBeenCalledExactlyOnceWith("", [], { name: "review" });
  });

  it("sends the draft as ordinary text when the run's listing could not be read", async () => {
    commandsMock.mockRejectedValue(new Error("offline"));
    const paused = renderPaused();
    const user = await typeInto("/review");
    await screen.findByText("The commands could not be loaded.");

    await user.click(screen.getByRole("button", { name: "Send follow-up" }));

    expect(paused.onSend).toHaveBeenCalledExactlyOnceWith("/review");
  });

  it("never reads a draft that does not open like a command as one, and waits for nothing", async () => {
    const paused = renderPaused();
    const user = await typeInto("see /review for details");
    await user.click(screen.getByRole("button", { name: "Send follow-up" }));
    expect(paused.onSend).toHaveBeenCalledExactlyOnceWith("see /review for details");
    expect(commandsMock).not.toHaveBeenCalled();
  });

  it("delivers a slash to a running turn as the plain message it is", async () => {
    const running = actions();
    render(
      <Harness
        runState="running"
        taskActions={running}
        overrides={{ promptInputs: WITH_COMMANDS, runId: "run-1" }}
        initialDraft="/review"
      />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Send now" }));
    expect(running.onDeliver).toHaveBeenCalledExactlyOnceWith("/review", "steer", []);
    await user.click(screen.getByRole("button", { name: "Queue message" }));
    expect(running.onDeliver).toHaveBeenLastCalledWith("/review", "queue", []);
    expect(commandsMock).not.toHaveBeenCalled();
  });

  it("reports the submission without the command or its text", async () => {
    const evidence: unknown[] = [];
    setClientDiagnosticWriter((_message, meta): void => {
      if (meta?.composerSubmission !== undefined) evidence.push(meta.composerSubmission);
    });
    renderNewTask();
    const user = await typeInto("/review PRIVATE_ARGUMENT");
    await user.click(screen.getByRole("button", { name: "Start coding run" }));
    expect(evidence).toMatchObject([{ kind: "start", outcome: "attempted" }]);
    expect(JSON.stringify(evidence)).not.toContain("PRIVATE_ARGUMENT");
    expect(JSON.stringify(evidence)).not.toContain("review");
  });
});
