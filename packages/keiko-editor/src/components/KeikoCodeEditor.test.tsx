import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { useRef, type ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { EditorPosition, EditorRange, EditorSaveRequest } from "../index.js";
import { KeikoCodeEditor } from "./KeikoCodeEditor.js";
import { baseProps, buildBuffer, buildFileModel, dirtyFileModel } from "./test-harness.js";

// ─── Monaco mock: a <textarea>-backed fake that drives onChange and calls onMount. ───────────────

interface CapturedEditor {
  emitCursor: (p: { lineNumber: number; column: number }) => void;
  emitSelection: (s: {
    startLineNumber: number;
    startColumn: number;
    endLineNumber: number;
    endColumn: number;
    empty: boolean;
  }) => void;
  runSaveAction: () => void;
  saveKeybinding: () => number | undefined;
  focus: ReturnType<typeof vi.fn>;
  disposed: { action: boolean; cursor: boolean; selection: boolean };
}

interface CapturedCompletionRegistration {
  readonly language: string;
  readonly provider: {
    readonly triggerCharacters?: readonly string[];
    provideCompletionItems: (
      model: {
        getValue: () => string;
        getWordUntilPosition: () => { startColumn: number; endColumn: number };
        uri: { toString: () => string };
      },
      position: { lineNumber: number; column: number },
      context: { triggerKind: number; triggerCharacter?: string },
      token: {
        isCancellationRequested: boolean;
        onCancellationRequested: (fn: () => void) => void;
      },
    ) => Promise<{
      suggestions: readonly { label: string; insertText: string }[];
      incomplete: boolean;
    }>;
  };
}

const captured: {
  editor: CapturedEditor | null;
  language: string | null;
  completion: CapturedCompletionRegistration[];
  options: Record<string, unknown> | null;
} = {
  editor: null,
  language: null,
  completion: [],
  options: null,
};

vi.mock("@monaco-editor/react", () => {
  interface FakeSelection {
    startLineNumber: number;
    startColumn: number;
    endLineNumber: number;
    endColumn: number;
    isEmpty: () => boolean;
  }
  interface MockProps {
    value?: string;
    language?: string;
    options?: { ariaLabel?: string; readOnly?: boolean } & Record<string, unknown>;
    onChange?: (value: string | undefined) => void;
    onMount?: (editor: unknown, monaco: unknown) => void;
  }
  const fakeMonaco = {
    editor: { defineTheme: vi.fn() },
    KeyMod: { CtrlCmd: 2048 },
    KeyCode: { KeyS: 49 },
    languages: {
      CompletionItemKind: {
        Text: 1,
        Method: 2,
        Function: 3,
        Constructor: 4,
        Field: 5,
        Variable: 6,
        Class: 7,
        Interface: 8,
        Module: 9,
        Property: 10,
        Keyword: 11,
        Snippet: 12,
      },
      CompletionTriggerKind: { Invoke: 0, TriggerCharacter: 1, TriggerForIncompleteCompletions: 2 },
      registerCompletionItemProvider: (
        language: string,
        provider: CapturedCompletionRegistration["provider"],
      ): { dispose: () => void } => {
        captured.completion.push({ language, provider });
        return { dispose: vi.fn() };
      },
    },
  };
  interface FakeEditorShape {
    addAction: (descriptor: { keybindings?: number[]; run: () => void }) => { dispose: () => void };
    onDidChangeCursorPosition: (
      listener: (e: { position: { lineNumber: number; column: number } }) => void,
    ) => { dispose: () => void };
    onDidChangeCursorSelection: (listener: (e: { selection: FakeSelection }) => void) => {
      dispose: () => void;
    };
    saveViewState: () => { scroll: number };
    restoreViewState: ReturnType<typeof vi.fn>;
    focus: ReturnType<typeof vi.fn>;
    getContainerDomNode: () => HTMLElement;
  }
  interface MockState {
    container: { current: HTMLDivElement | null };
    disposed: { action: boolean; cursor: boolean; selection: boolean };
    saveRun: () => void;
    saveKeybindings: readonly number[] | undefined;
    cursorListener: ((e: { position: { lineNumber: number; column: number } }) => void) | null;
    selectionListener: ((e: { selection: FakeSelection }) => void) | null;
    focus: ReturnType<typeof vi.fn>;
    mounted: boolean;
    fakeEditor: FakeEditorShape;
  }
  const EditorMock = (props: MockProps): ReactElement => {
    // `@monaco-editor/react` invokes `onMount` exactly once and keeps the editor (and its registered
    // save action) across re-renders; only `onChange` is re-subscribed. Persist the fake editor
    // across renders so a save closure captured at mount stays bound — making a stale-text save
    // observable when the controlled `value` prop changes after mount.
    const ref = useRef<MockState | null>(null);
    if (ref.current === null) {
      const s: MockState = {
        container: { current: null },
        disposed: { action: false, cursor: false, selection: false },
        saveRun: (): void => undefined,
        saveKeybindings: undefined,
        cursorListener: null,
        selectionListener: null,
        focus: vi.fn(),
        mounted: false,
        fakeEditor: null as unknown as FakeEditorShape,
      };
      s.fakeEditor = {
        addAction: (descriptor): { dispose: () => void } => {
          s.saveRun = descriptor.run;
          s.saveKeybindings = descriptor.keybindings;
          return {
            dispose: (): void => {
              s.disposed.action = true;
            },
          };
        },
        onDidChangeCursorPosition: (listener): { dispose: () => void } => {
          s.cursorListener = listener;
          return {
            dispose: (): void => {
              s.disposed.cursor = true;
            },
          };
        },
        onDidChangeCursorSelection: (listener): { dispose: () => void } => {
          s.selectionListener = listener;
          return {
            dispose: (): void => {
              s.disposed.selection = true;
            },
          };
        },
        saveViewState: (): { scroll: number } => ({ scroll: 1 }),
        restoreViewState: vi.fn(),
        focus: s.focus,
        getContainerDomNode: (): HTMLElement =>
          s.container.current ?? document.createElement("div"),
      };
      captured.editor = {
        emitCursor: (p): void => {
          s.cursorListener?.({ position: p });
        },
        emitSelection: (sel): void => {
          s.selectionListener?.({
            selection: {
              startLineNumber: sel.startLineNumber,
              startColumn: sel.startColumn,
              endLineNumber: sel.endLineNumber,
              endColumn: sel.endColumn,
              isEmpty: (): boolean => sel.empty,
            },
          });
        },
        runSaveAction: (): void => {
          s.saveRun();
        },
        saveKeybinding: (): number | undefined => s.saveKeybindings?.[0],
        focus: s.focus,
        disposed: s.disposed,
      };
      ref.current = s;
    }
    captured.language = props.language ?? null;
    captured.options = props.options ?? null;
    const state = ref.current;
    if (!state.mounted) {
      state.mounted = true;
      queueMicrotask(() => props.onMount?.(state.fakeEditor, fakeMonaco));
    }
    return (
      <div
        ref={(node): void => {
          state.container.current = node;
        }}
      >
        <textarea
          aria-label={props.options?.ariaLabel ?? "Editor"}
          readOnly={props.options?.readOnly ?? false}
          value={props.value ?? ""}
          onChange={(event): void => {
            props.onChange?.(event.target.value);
          }}
        />
      </div>
    );
  };
  return { Editor: EditorMock, default: EditorMock };
});

// Let queued onMount microtasks flush.
async function flushMount(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  captured.editor = null;
  captured.language = null;
  captured.completion = [];
  captured.options = null;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("KeikoCodeEditor — controlled editing", () => {
  it("emits onContentChange with a human origin on edit", async () => {
    const onContentChange = vi.fn();
    render(<KeikoCodeEditor {...baseProps({ onContentChange })} />);
    const textarea = screen.getByLabelText("Editor: src/a.ts");
    await userEvent.type(textarea, "X");
    expect(onContentChange).toHaveBeenCalled();
    const [delta, origin] = onContentChange.mock.calls.at(-1) as [
      { text: string; sizeBytes: number },
      string,
    ];
    expect(origin).toBe("human");
    expect(typeof delta.text).toBe("string");
    expect(delta.sizeBytes).toBe(new TextEncoder().encode(delta.text).length);
  });

  it("uses a host-provided accessible editor label", () => {
    render(<KeikoCodeEditor {...baseProps({ ariaLabel: "Editor: src/a.ts in /repo" })} />);
    expect(screen.getByLabelText("Editor: src/a.ts in /repo")).toBeInTheDocument();
  });

  it("does not emit onContentChange when read-only", async () => {
    const onContentChange = vi.fn();
    render(
      <KeikoCodeEditor {...baseProps({ onContentChange, fileModel: buildFileModel(true) })} />,
    );
    const textarea = screen.getByLabelText("Editor: src/a.ts");
    await userEvent.type(textarea, "X");
    expect(onContentChange).not.toHaveBeenCalled();
  });

  it("does not emit onContentChange when the buffer is read-only", async () => {
    const onContentChange = vi.fn();
    const buffer = { ...buildBuffer(), readOnly: true };
    render(<KeikoCodeEditor {...baseProps({ onContentChange, buffer })} />);
    const textarea = screen.getByLabelText("Editor: src/a.ts");
    await userEvent.type(textarea, "X");
    expect(onContentChange).not.toHaveBeenCalled();
  });
});

describe("KeikoCodeEditor — save command", () => {
  it("emits onSaveRequested with the file-model identity and current text on Cmd/Ctrl+S", async () => {
    const onSaveRequested = vi.fn();
    const fileModel = buildFileModel();
    render(<KeikoCodeEditor {...baseProps({ onSaveRequested, fileModel })} />);
    await flushMount();
    captured.editor?.runSaveAction();
    expect(onSaveRequested).toHaveBeenCalledTimes(1);
    const request = onSaveRequested.mock.calls[0]?.[0] as EditorSaveRequest;
    expect(request.identity).toBe(fileModel.identity);
    expect(request.content.text).toBe("const a = 1;\n");
    expect(request.content.relativePath).toBe("src/a.ts");
    expect(request.content.sizeBytes).toBe(new TextEncoder().encode("const a = 1;\n").length);
    expect(request.content.truncated).toBe(false);
    expect(request.expectedSavedVersion).toBe(fileModel.savedVersion);
  });

  it("saves the CURRENT text after an edit, not the mount-time text", async () => {
    // Regression guard: `@monaco-editor/react` registers the save action once at mount. The save
    // emitter must read the live buffer (not a closure captured at mount) so Cmd/Ctrl+S persists the
    // latest controlled value rather than silently discarding every edit since mount.
    const onSaveRequested = vi.fn();
    const fileModel = buildFileModel();
    const { rerender } = render(<KeikoCodeEditor {...baseProps({ onSaveRequested, fileModel })} />);
    await flushMount();
    const editedBuffer = buildBuffer({ text: "const a = 2;\n" });
    rerender(
      <KeikoCodeEditor {...baseProps({ onSaveRequested, fileModel, buffer: editedBuffer })} />,
    );
    captured.editor?.runSaveAction();
    const request = onSaveRequested.mock.calls.at(-1)?.[0] as EditorSaveRequest;
    expect(request.content.text).toBe("const a = 2;\n");
    expect(request.content.sizeBytes).toBe(new TextEncoder().encode("const a = 2;\n").length);
    expect(request.expectedSavedVersion).toBe(fileModel.savedVersion);
  });

  it("does not save a read-only buffer", async () => {
    const onSaveRequested = vi.fn();
    render(
      <KeikoCodeEditor {...baseProps({ onSaveRequested, fileModel: buildFileModel(true) })} />,
    );
    await flushMount();
    captured.editor?.runSaveAction();
    expect(onSaveRequested).not.toHaveBeenCalled();
  });

  it("does not save when the buffer is read-only", async () => {
    const onSaveRequested = vi.fn();
    const buffer = { ...buildBuffer(), readOnly: true };
    render(<KeikoCodeEditor {...baseProps({ onSaveRequested, buffer })} />);
    await flushMount();
    captured.editor?.runSaveAction();
    expect(onSaveRequested).not.toHaveBeenCalled();
  });

  it("binds the save action to the Ctrl/Cmd+S chord", async () => {
    render(<KeikoCodeEditor {...baseProps()} />);
    await flushMount();
    // The chord wired into addAction must be CtrlCmd (2048) | KeyS (49) — assert the value, not
    // merely that an editor mounted, so a wrong-key mutation is caught.
    expect(captured.editor?.saveKeybinding()).toBe(2048 | 49);
  });
});

describe("KeikoCodeEditor — selection and cursor reporting", () => {
  it("reports cursor moves as 0-based positions", async () => {
    const onCursorChange = vi.fn();
    render(<KeikoCodeEditor {...baseProps({ onCursorChange })} />);
    await flushMount();
    captured.editor?.emitCursor({ lineNumber: 4, column: 7 });
    expect(onCursorChange).toHaveBeenCalledWith({ line: 3, column: 6 } satisfies EditorPosition);
  });

  it("reports a non-empty selection as a 0-based range", async () => {
    const onSelectionChange = vi.fn();
    render(<KeikoCodeEditor {...baseProps({ onSelectionChange })} />);
    await flushMount();
    captured.editor?.emitSelection({
      startLineNumber: 1,
      startColumn: 2,
      endLineNumber: 3,
      endColumn: 5,
      empty: false,
    });
    expect(onSelectionChange).toHaveBeenCalledWith({
      start: { line: 0, column: 1 },
      end: { line: 2, column: 4 },
    } satisfies EditorRange);
  });

  it("reports null for a collapsed selection", async () => {
    const onSelectionChange = vi.fn();
    render(<KeikoCodeEditor {...baseProps({ onSelectionChange })} />);
    await flushMount();
    captured.editor?.emitSelection({
      startLineNumber: 2,
      startColumn: 2,
      endLineNumber: 2,
      endColumn: 2,
      empty: true,
    });
    expect(onSelectionChange).toHaveBeenCalledWith(null);
  });
});

describe("KeikoCodeEditor — runtime errors", () => {
  it("reports a non-fatal theme-registration failure via onRuntimeError but stays mounted", async () => {
    // jsdom has no --ed-* design tokens, so resolveEditorThemeTokensFromDom throws; the component
    // must surface it through onRuntimeError and keep the editor mounted with Monaco's base theme.
    const onRuntimeError = vi.fn();
    render(<KeikoCodeEditor {...baseProps({ onRuntimeError })} />);
    await flushMount();
    expect(onRuntimeError).toHaveBeenCalled();
    expect(screen.getByLabelText("Editor: src/a.ts")).toBeInTheDocument();
  });
});

describe("KeikoCodeEditor — Monaco language", () => {
  it("infers Monaco language from the file path without changing the governed buffer language", () => {
    const pyBuffer = {
      ...buildBuffer({ relativePath: "scripts/build.py" }),
      language: "plaintext" as const,
    };
    const { rerender } = render(<KeikoCodeEditor {...baseProps({ buffer: pyBuffer })} />);
    expect(captured.language).toBe("python");
    expect(pyBuffer.language).toBe("plaintext");

    const jsonBuffer = {
      ...buildBuffer({ relativePath: "config/settings.json" }),
      language: "plaintext" as const,
    };
    rerender(<KeikoCodeEditor {...baseProps({ buffer: jsonBuffer })} />);
    expect(captured.language).toBe("json");
    expect(jsonBuffer.language).toBe("plaintext");
  });
});

describe("KeikoCodeEditor — lifecycle", () => {
  it("focuses the editor on mount when autoFocus is set", async () => {
    render(<KeikoCodeEditor {...baseProps({ autoFocus: true })} />);
    await flushMount();
    expect(captured.editor?.focus).toHaveBeenCalled();
  });

  it("does not focus when autoFocus is unset", async () => {
    render(<KeikoCodeEditor {...baseProps()} />);
    await flushMount();
    expect(captured.editor?.focus).not.toHaveBeenCalled();
  });

  it("disposes the action and subscriptions on unmount", async () => {
    const { unmount } = render(
      <KeikoCodeEditor {...baseProps({ onCursorChange: vi.fn(), onSelectionChange: vi.fn() })} />,
    );
    await flushMount();
    const editor = captured.editor;
    unmount();
    expect(editor?.disposed.action).toBe(true);
    expect(editor?.disposed.cursor).toBe(true);
    expect(editor?.disposed.selection).toBe(true);
  });
});

describe("KeikoCodeEditor — read-only and error rendering", () => {
  it("keeps the editor mounted (copy/select preserved) when read-only", () => {
    render(<KeikoCodeEditor {...baseProps({ fileModel: buildFileModel(true) })} />);
    expect(screen.getByLabelText("Editor: src/a.ts")).toBeInTheDocument();
  });

  it("keeps the editor mounted when a save error is present", () => {
    render(
      <KeikoCodeEditor
        {...baseProps({ saveStatus: "error", saveError: "disk full", fileModel: dirtyFileModel() })}
      />,
    );
    expect(screen.getByLabelText("Editor: src/a.ts")).toBeInTheDocument();
  });

  it("does not mount Monaco when the load failed", () => {
    const onContentChange = vi.fn();
    render(
      <KeikoCodeEditor
        {...baseProps({ onContentChange, loadState: { status: "error", message: "boot failed" } })}
      />,
    );
    expect(screen.queryByLabelText("Editor: src/a.ts")).not.toBeInTheDocument();
    expect(screen.getByTestId("keiko-editor-runtime-error")).toHaveTextContent("boot failed");
    expect(captured.editor).toBeNull();
    expect(onContentChange).not.toHaveBeenCalled();
  });

  it("does not mount Monaco while the local runtime is still loading", () => {
    render(<KeikoCodeEditor {...baseProps({ loadState: { status: "loading" } })} />);
    expect(screen.queryByLabelText("Editor: src/a.ts")).not.toBeInTheDocument();
    expect(screen.getByTestId("keiko-editor-loading")).toBeInTheDocument();
    expect(captured.editor).toBeNull();
  });
});

describe("KeikoCodeEditor — max size", () => {
  it("renders a read-only limit notice for an oversized buffer", () => {
    const buffer = buildBuffer({ sizeBytes: 999_999, truncated: true });
    render(<KeikoCodeEditor {...baseProps({ buffer })} />);
    expect(screen.getByTestId("keiko-editor-limit")).toBeInTheDocument();
  });

  it("forces the editor read-only when truncated", () => {
    const buffer = buildBuffer({ truncated: true });
    render(<KeikoCodeEditor {...baseProps({ buffer })} />);
    expect(screen.getByLabelText("Editor: src/a.ts")).toHaveAttribute("readonly");
  });

  it("forces read-only and blocks save when sizeBytes exceeds maxSizeBytes without truncation", async () => {
    const onContentChange = vi.fn();
    const onSaveRequested = vi.fn();
    const buffer = buildBuffer({ sizeBytes: 999_999, truncated: false });
    render(
      <KeikoCodeEditor
        {...baseProps({ buffer, maxSizeBytes: 128, onContentChange, onSaveRequested })}
      />,
    );
    const textarea = screen.getByLabelText("Editor: src/a.ts");
    expect(textarea).toHaveAttribute("readonly");
    expect(screen.getByTestId("keiko-editor-limit")).toBeInTheDocument();
    await userEvent.type(textarea, "X");
    expect(onContentChange).not.toHaveBeenCalled();
    await flushMount();
    captured.editor?.runSaveAction();
    expect(onSaveRequested).not.toHaveBeenCalled();
  });
});

describe("KeikoCodeEditor — layout stability", () => {
  it("renders a sized container and a sized loading box (no layout shift)", () => {
    render(<KeikoCodeEditor {...baseProps()} />);
    const shell = screen.getByTestId("keiko-code-editor");
    expect(shell).toHaveStyle({ height: "100%" });
  });
});

describe("KeikoCodeEditor — completion bridge (#1199)", () => {
  it("registers a completion provider per governed language when a resolver is supplied", async () => {
    const provideCompletions = vi.fn();
    render(<KeikoCodeEditor {...baseProps({ provideCompletions })} />);
    await flushMount();
    expect(captured.completion.map((r) => r.language)).toEqual(["typescript", "javascript"]);
  });

  it("registers no completion provider when the host supplies no resolver", async () => {
    render(<KeikoCodeEditor {...baseProps()} />);
    await flushMount();
    expect(captured.completion).toEqual([]);
  });

  it("bridges a Monaco completion call to the host resolver and renders the returned items", async () => {
    const provideCompletions = vi
      .fn()
      .mockImplementation((query: { request: { request: unknown }; documentText: string }) =>
        Promise.resolve({
          request: query.request.request,
          items: [
            {
              label: "render",
              kind: "function",
              insertText: "render()",
              provenance: { origin: "deterministic-completion" },
            },
          ],
          isIncomplete: false,
          provenance: { sources: ["deterministic-language-service"], modelMode: "deterministic" },
        }),
      );
    render(<KeikoCodeEditor {...baseProps({ provideCompletions })} />);
    await flushMount();
    const registration = captured.completion[0];
    expect(registration).toBeDefined();
    if (registration === undefined) return;
    const list = await registration.provider.provideCompletionItems(
      {
        getValue: () => "const a = 1;\n",
        getWordUntilPosition: () => ({ startColumn: 1, endColumn: 1 }),
        uri: { toString: () => "keiko://doc/a" },
      },
      { lineNumber: 1, column: 1 },
      { triggerKind: 0 },
      { isCancellationRequested: false, onCancellationRequested: () => undefined },
    );
    expect(provideCompletions).toHaveBeenCalledTimes(1);
    const [query] = provideCompletions.mock.calls[0] as [{ documentText: string }];
    expect(query.documentText).toBe("const a = 1;\n");
    expect(list.suggestions.map((s) => s.label)).toEqual(["render"]);
  });
});

describe("KeikoCodeEditor — large-file degraded mode (Issue #1207)", () => {
  it("passes normal Monaco options for a small buffer", () => {
    render(<KeikoCodeEditor {...baseProps()} />);
    expect(captured.options?.bracketPairColorization).toEqual({ enabled: true });
    expect(captured.options?.folding).toBe(true);
    expect(captured.options?.largeFileOptimizations).toBe(true);
  });

  it("passes degraded Monaco options for a buffer over the 500 KB size threshold", () => {
    const text = "x".repeat(600_000);
    const buffer = buildBuffer({ text, sizeBytes: 600_000 });
    render(<KeikoCodeEditor {...baseProps({ buffer })} />);
    expect(captured.options?.bracketPairColorization).toEqual({ enabled: false });
    expect(captured.options?.folding).toBe(false);
    expect(captured.options?.matchBrackets).toBe("never");
    expect(captured.options?.renderWhitespace).toBe("none");
    expect(captured.options?.largeFileOptimizations).toBe(true);
  });

  it("passes degraded Monaco options for a buffer over the 10,000-line threshold", () => {
    const text = "x\n".repeat(10_001);
    const buffer = buildBuffer({ text, sizeBytes: new TextEncoder().encode(text).length });
    render(<KeikoCodeEditor {...baseProps({ buffer })} />);
    expect(captured.options?.folding).toBe(false);
    expect(captured.options?.bracketPairColorization).toEqual({ enabled: false });
  });
});
