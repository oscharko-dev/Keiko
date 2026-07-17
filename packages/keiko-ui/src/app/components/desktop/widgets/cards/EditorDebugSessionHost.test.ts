import { createElement } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DebugSessionSnapshot } from "./debugSessionStore";
import {
  BreakpointContextMenu,
  EditorDebugSessionHost,
  debugEditorLabels,
  derivePausedDebugValues,
} from "./EditorDebugSessionHost";
import type { EditorSurfaceProps } from "./EditorSurface";
import { useDebugSession, type DebugSessionActions } from "./useDebugSession";
import { debuggingTranslate } from "../panels/debugging-i18n";

const actions = {
  refreshInstrumentation: vi.fn(async () => {}),
  refreshSession: vi.fn(async () => {}),
  start: vi.fn(async () => {}),
  control: vi.fn<DebugSessionActions["control"]>(async () => {}),
  saveBreakpoints: vi.fn(async () => {}),
  loadStack: vi.fn(async () => {}),
  loadScopes: vi.fn(async () => {}),
  loadVariables: vi.fn(async () => {}),
  saveWatches: vi.fn(async () => {}),
  saveExceptionFilters: vi.fn(async () => {}),
  evaluateWatch: vi.fn(async () => null),
  setVariable: vi.fn(async () => {}),
};

vi.mock("./useDebugSession", () => ({
  useDebugSession: vi.fn(),
}));

function snapshot(sourceFileId = "src/program.ts"): DebugSessionSnapshot {
  const frameRef = "frame-1";
  const scopeRef = "scope-1";
  return {
    instrumentation: null,
    session: {
      schemaVersion: "1",
      sessionId: "session-1",
      workspaceId: "workspace-1",
      status: "paused",
      targetKind: "file",
      activationRevision: 1,
      pauseGeneration: 3,
      startedAtMs: 1,
      wallDeadlineMs: 2,
      inactivityDeadlineMs: 3,
      output: { acceptedBytes: 0, truncated: false },
    },
    stack: {
      frames: [
        {
          frameRef,
          name: {
            value: "main",
            truncated: false,
            originalBytes: 4,
            retainedBytes: 4,
            omittedBytes: 0,
          },
          sourceFileId,
          line: 7,
          column: 2,
        },
      ],
      truncated: false,
      omittedCount: 0,
    },
    scopesByFrame: new Map([
      [
        frameRef,
        {
          frameRef,
          scopes: [
            {
              scopeRef,
              name: {
                value: "Local",
                truncated: false,
                originalBytes: 5,
                retainedBytes: 5,
                omittedBytes: 0,
              },
              expensive: false,
            },
            {
              scopeRef: "scope-2",
              name: {
                value: "Arguments",
                truncated: false,
                originalBytes: 9,
                retainedBytes: 9,
                omittedBytes: 0,
              },
              expensive: false,
            },
          ],
          truncated: false,
          omittedCount: 0,
        },
      ],
    ]),
    variablesByParent: new Map([
      [
        scopeRef,
        {
          parentRef: scopeRef,
          nodes: [
            {
              kind: "variable",
              name: {
                value: "count",
                truncated: false,
                originalBytes: 5,
                retainedBytes: 5,
                omittedBytes: 0,
              },
              value: {
                value: "2",
                truncated: false,
                originalBytes: 1,
                retainedBytes: 1,
                omittedBytes: 0,
              },
              presentation: "data",
              children: [],
              retainedCount: 0,
              omittedCount: 0,
              truncated: false,
            },
          ],
          truncated: false,
          omittedCount: 0,
        },
      ],
      [
        "scope-2",
        {
          parentRef: "scope-2",
          nodes: [
            {
              kind: "variable",
              name: {
                value: "input",
                truncated: false,
                originalBytes: 5,
                retainedBytes: 5,
                omittedBytes: 0,
              },
              value: {
                value: "x",
                truncated: false,
                originalBytes: 1,
                retainedBytes: 1,
                omittedBytes: 0,
              },
              presentation: "data",
              children: [],
              retainedCount: 0,
              omittedCount: 0,
              truncated: false,
            },
          ],
          truncated: false,
          omittedCount: 0,
        },
      ],
    ]),
    watchResults: new Map(),
    console: { entries: [], retainedBytes: 0, evictedEntries: 0, evictedBytes: 0 },
    stopDescription: null,
    sequence: 1,
    streamReady: true,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useDebugSession).mockReturnValue({ snapshot: snapshot(), actions });
});

function renderHost(): {
  readonly host: () => NonNullable<EditorSurfaceProps["debug"]>;
} {
  let current: EditorSurfaceProps["debug"];
  render(
    createElement(EditorDebugSessionHost, {
      root: "/workspace",
      workspaceId: "workspace-1",
      activationRevision: 1,
      enabled: true,
      fileId: "src/program.ts",
      onOpenDebugPanel: vi.fn(),
      onHostChange: (next) => {
        current = next;
      },
      onSessionStateChange: vi.fn(),
    }),
  );
  return {
    host: () => {
      if (current === undefined) throw new Error("Expected debug host");
      return current;
    },
  };
}

describe("derivePausedDebugValues", () => {
  it("projects source-ordered local values only for the active paused source frame", () => {
    expect(derivePausedDebugValues(snapshot(), "src/program.ts", "keiko://program")).toMatchObject({
      paused: true,
      pauseGeneration: 3,
      documentUri: "keiko://program",
      values: [
        {
          line: 7,
          column: 2,
          value: "Local: count: 2",
        },
        {
          line: 7,
          column: 2,
          value: "Arguments: input: x",
        },
      ],
    });
  });

  it("emits exactly 200 bounded source-ordered decorations and drops values beyond the cap", () => {
    const current = snapshot();
    const frame = current.stack?.frames[0];
    const scope = current.scopesByFrame.get("frame-1")?.scopes[0];
    const template = current.variablesByParent.get("scope-1")?.nodes[0];
    if (frame === undefined || scope === undefined || template?.kind !== "variable") {
      throw new Error("Expected paused debug projection fixture");
    }
    const variables = Array.from({ length: 201 }, (_, index) => ({
      ...template,
      name: { ...template.name, value: `inline_${String(index + 1).padStart(3, "0")}` },
      value: { ...template.value, value: String(index + 1) },
    }));
    const capped = {
      ...current,
      scopesByFrame: new Map([
        [
          frame.frameRef,
          {
            frameRef: frame.frameRef,
            scopes: [scope],
            truncated: false,
            omittedCount: 0,
          },
        ],
      ]),
      variablesByParent: new Map([
        [
          scope.scopeRef,
          {
            parentRef: scope.scopeRef,
            nodes: variables,
            truncated: true,
            omittedCount: 1,
          },
        ],
      ]),
    } satisfies DebugSessionSnapshot;

    const values = derivePausedDebugValues(capped, "src/program.ts", "keiko://program").values;

    expect(values).toHaveLength(200);
    expect(values[0]).toMatchObject({ line: 7, value: "Local: inline_001: 1" });
    expect(values[199]).toMatchObject({ line: 7, column: 2, value: "Local: inline_200: 200" });
    expect(
      values.every((value) => value.line === frame.line && value.column === frame.column),
    ).toBe(true);
    expect(values.every((value) => value.value.length <= 320)).toBe(true);
  });

  it("fails closed when the paused frame belongs to another file", () => {
    expect(
      derivePausedDebugValues(snapshot("src/other.ts"), "src/program.ts", "keiko://program"),
    ).toMatchObject({ paused: false, values: [] });
  });
});

describe("debug editor localization", () => {
  it("injects complete English and German gutter and command labels", () => {
    const english = debugEditorLabels(debuggingTranslate("en"));
    const german = debugEditorLabels(debuggingTranslate("de"));

    expect(english.gutter.conditional).toBe("Set conditional breakpoint");
    expect(english.commands.stepOver).toBe("Debug: Step Over");
    expect(german.gutter.conditional).toBe("Bedingten Haltepunkt setzen");
    expect(german.commands.stepOver).toBe("Debuggen: Überspringen");
  });
});

describe("EditorDebugSessionHost", () => {
  it("does not request variables for scopes whose canonical count is zero", async () => {
    const current = snapshot();
    const scopes = current.scopesByFrame.get("frame-1");
    if (scopes === undefined) throw new Error("Expected scope fixture");
    vi.mocked(useDebugSession).mockReturnValue({
      snapshot: {
        ...current,
        scopesByFrame: new Map([
          [
            "frame-1",
            {
              ...scopes,
              scopes: scopes.scopes.map((scope, index) => ({
                ...scope,
                ...(index === 0 ? { variableCount: 1 } : { variableCount: 0 }),
              })),
            },
          ],
        ]),
      },
      actions,
    });

    renderHost();

    await waitFor(() => {
      expect(actions.loadVariables).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ sessionId: "session-1" }),
        "scope-1",
      );
    });
    expect(actions.loadVariables).not.toHaveBeenCalledWith(expect.anything(), "scope-2");
  });

  it("sends only paused-state controls and blocks Pause while already paused", async () => {
    const rendered = renderHost();
    await waitFor(() => expect(rendered.host()).toBeDefined());

    act(() => {
      rendered.host().commands.continue();
      rendered.host().commands.pause();
      rendered.host().commands.stepOver();
      rendered.host().commands.stepInto();
      rendered.host().commands.stepOut();
      rendered.host().commands.stop();
    });

    expect(actions.control.mock.calls.map((call) => call[1])).toEqual([
      "continue",
      "next",
      "stepIn",
      "stepOut",
      "stop",
    ]);
    expect(rendered.host().commands.isAvailable?.("pause")).toBe(false);
    expect(rendered.host().commands.isAvailable?.("continue")).toBe(true);
  });

  it("reports an exception pause distinctly from an ordinary pause via onExceptionPauseChange", async () => {
    // Feeds status-bar.ts's isExceptionPause so the shared live region can distinguish an uncaught
    // exception from a routine breakpoint hit (Epic #2096 a11y-sweep finding 3). Without this signal
    // reaching the host, the status bar cannot announce anything beyond the generic "paused" state.
    const onExceptionPauseChange = vi.fn();
    render(
      createElement(EditorDebugSessionHost, {
        root: "/workspace",
        workspaceId: "workspace-1",
        activationRevision: 1,
        enabled: true,
        fileId: "src/program.ts",
        onOpenDebugPanel: vi.fn(),
        onHostChange: vi.fn(),
        onSessionStateChange: vi.fn(),
        onExceptionPauseChange,
      }),
    );

    await waitFor(() => expect(onExceptionPauseChange).toHaveBeenCalledWith(false));

    onExceptionPauseChange.mockClear();
    vi.mocked(useDebugSession).mockReturnValue({
      snapshot: {
        ...snapshot(),
        stopDescription: {
          value: "boom",
          truncated: false,
          originalBytes: 4,
          retainedBytes: 4,
          omittedBytes: 0,
        },
      },
      actions,
    });
    render(
      createElement(EditorDebugSessionHost, {
        root: "/workspace",
        workspaceId: "workspace-1",
        activationRevision: 1,
        enabled: true,
        fileId: "src/program.ts",
        onOpenDebugPanel: vi.fn(),
        onHostChange: vi.fn(),
        onSessionStateChange: vi.fn(),
        onExceptionPauseChange,
      }),
    );

    await waitFor(() => expect(onExceptionPauseChange).toHaveBeenCalledWith(true));
  });

  it("allows only Pause and Stop while running and sends no paused-only requests", async () => {
    const running = snapshot();
    if (running.session === null) throw new Error("Expected fixture session");
    vi.mocked(useDebugSession).mockReturnValue({
      snapshot: { ...running, session: { ...running.session, status: "running" } },
      actions,
    });
    const rendered = renderHost();
    await waitFor(() => expect(rendered.host()).toBeDefined());

    act(() => {
      rendered.host().commands.continue();
      rendered.host().commands.pause();
      rendered.host().commands.stepOver();
      rendered.host().commands.stepInto();
      rendered.host().commands.stepOut();
      rendered.host().commands.stop();
    });

    expect(actions.start).not.toHaveBeenCalled();
    expect(actions.control.mock.calls.map((call) => call[1])).toEqual(["pause", "stop"]);
    expect(rendered.host().commands.isAvailable?.("continue")).toBe(false);
    expect(rendered.host().commands.isAvailable?.("pause")).toBe(true);
  });

  it("starts only without a session and rejects terminal-session restart attempts", async () => {
    vi.mocked(useDebugSession).mockReturnValue({
      snapshot: { ...snapshot(), session: null },
      actions,
    });
    const withoutSession = renderHost();
    await waitFor(() => expect(withoutSession.host()).toBeDefined());
    act(() => withoutSession.host().commands.continue());
    // The launch target now resolves asynchronously (`resolveDebugLaunchTarget`) before `start` is
    // invoked, even for a non-test file that never reaches the catalog-discovery branch.
    await waitFor(() => expect(actions.start).toHaveBeenCalledOnce());

    vi.clearAllMocks();
    const failed = snapshot();
    if (failed.session === null) throw new Error("Expected fixture session");
    vi.mocked(useDebugSession).mockReturnValue({
      snapshot: { ...failed, session: { ...failed.session, status: "failed" } },
      actions,
    });
    const terminalSession = renderHost();
    await waitFor(() => expect(terminalSession.host()).toBeDefined());
    act(() => terminalSession.host().commands.continue());

    expect(actions.start).not.toHaveBeenCalled();
    expect(actions.control).not.toHaveBeenCalled();
    expect(terminalSession.host().commands.isAvailable?.("continue")).toBe(false);
  });

  it("surfaces a redacted visible error when an editor command fails, without a second live region", async () => {
    actions.control.mockRejectedValueOnce(new Error("private adapter details"));
    const rendered = renderHost();
    await waitFor(() => expect(rendered.host()).toBeDefined());

    act(() => rendered.host().commands.continue());

    expect(
      await screen.findByText("The debug action failed. The server state remains authoritative."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/private adapter details/u)).toBeNull();
    // The editor's status bar owns the single aria-live announcement surface for debug state; this
    // panel must never introduce a second one (role="alert" or any other implicit live region).
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("never uses window.prompt for conditional-breakpoint text entry and stays axe-clean", async () => {
    const user = userEvent.setup();
    const promptSpy = vi.spyOn(window, "prompt");
    const trigger = document.createElement("button");
    trigger.textContent = "Open breakpoint menu";
    document.body.append(trigger);
    trigger.focus();
    const rendered = renderHost();
    await waitFor(() => expect(rendered.host()).toBeDefined());

    act(() => {
      rendered.host().gutter.onOpenContextMenu({
        line: 7,
        breakpoint: undefined,
        actions: ["toggle", "toggleConditional", "editLogpoint", "toggleEnabled"],
      });
    });
    await user.click(screen.getByRole("menuitem", { name: "Set conditional breakpoint" }));

    // This exercises the REAL action path (context-menu click -> runBreakpointAction), not a mock
    // standing in for it, so it actually proves the prompt-triggering flow never calls
    // window.prompt() and renders an accessible, axe-clean dialog instead.
    const dialog = await screen.findByRole("dialog", { name: "Set conditional breakpoint" });
    expect(promptSpy).not.toHaveBeenCalled();
    expect(dialog).toHaveFocus();
    expect(await axe(document.body)).toHaveNoViolations();

    await user.type(screen.getByLabelText("Breakpoint condition"), "count > 1");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(actions.saveBreakpoints).toHaveBeenCalledWith(
      "src/program.ts",
      expect.arrayContaining([
        expect.objectContaining({ line: 7, kind: "conditional", condition: "count > 1" }),
      ]),
    );
    expect(trigger).toHaveFocus();
    trigger.remove();
  });

  it("never uses window.prompt for a logpoint message triggered directly from the gutter", async () => {
    const user = userEvent.setup();
    const promptSpy = vi.spyOn(window, "prompt");
    const rendered = renderHost();
    await waitFor(() => expect(rendered.host()).toBeDefined());

    act(() => rendered.host().gutter.onEditLogpoint(9));

    expect(await screen.findByRole("dialog", { name: "Set logpoint" })).toBeInTheDocument();
    expect(promptSpy).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText("Logpoint message"), "hit line 9");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(actions.saveBreakpoints).toHaveBeenCalledWith(
      "src/program.ts",
      expect.arrayContaining([
        expect.objectContaining({ line: 9, kind: "logpoint", logMessage: "hit line 9" }),
      ]),
    );
  });

  it("discards a blank conditional-breakpoint entry and closes on Escape without saving", async () => {
    const user = userEvent.setup();
    const rendered = renderHost();
    await waitFor(() => expect(rendered.host()).toBeDefined());

    act(() => rendered.host().gutter.onToggleConditionalBreakpoint(3));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(actions.saveBreakpoints).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();

    act(() => rendered.host().gutter.onToggleConditionalBreakpoint(3));
    await screen.findByRole("dialog");
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(actions.saveBreakpoints).not.toHaveBeenCalled();
  });
});

describe("BreakpointContextMenu", () => {
  it("supports arrow navigation, action dispatch, Escape close, and focus return", async () => {
    const user = userEvent.setup();
    const returnFocus = document.createElement("button");
    document.body.append(returnFocus);
    returnFocus.focus();
    const onAction = vi.fn();
    const onClose = vi.fn();
    const labels = debugEditorLabels(debuggingTranslate("en")).gutter;
    const { container, rerender } = render(
      createElement(BreakpointContextMenu, {
        context: {
          line: 7,
          breakpoint: {
            id: "line-7",
            fileId: "src/program.ts",
            line: 7,
            enabled: true,
            kind: "line",
            verification: "verified",
          },
          actions: ["toggle", "toggleConditional", "editLogpoint", "toggleEnabled"],
        },
        labels,
        ariaLabel: "Breakpoint actions for line 7",
        returnFocus,
        onAction,
        onClose,
      }),
    );

    expect(screen.getByRole("menuitem", { name: "Toggle breakpoint" })).toHaveFocus();
    expect(screen.getByRole("menuitem", { name: "Disable breakpoint" })).toBeEnabled();
    await user.keyboard("{ArrowDown}{Enter}");
    expect(onAction).toHaveBeenCalledWith(
      "toggleConditional",
      expect.objectContaining({ line: 7 }),
    );
    expect(onClose).toHaveBeenCalledOnce();
    expect(returnFocus).toHaveFocus();
    expect(await axe(container)).toHaveNoViolations();

    rerender(
      createElement(BreakpointContextMenu, {
        context: { line: 7, breakpoint: undefined, actions: ["toggle", "toggleEnabled"] },
        labels,
        ariaLabel: "Breakpoint actions for line 7",
        returnFocus,
        onAction,
        onClose,
      }),
    );
    screen.getByRole("menuitem", { name: "Toggle breakpoint" }).focus();
    await user.keyboard("{Escape}");
    expect(returnFocus).toHaveFocus();
    expect(screen.queryByRole("menuitem", { name: "Disable breakpoint" })).toBeNull();
    returnFocus.remove();
  });
});
