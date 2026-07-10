// @vitest-environment jsdom
import "../../vitest.setup";

import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { useRef, type ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  EditorCodeActionsResolver,
  EditorDefinitionResolver,
  EditorPosition,
  EditorRange,
  EditorReferencesResolver,
  EditorSaveRequest,
  EditorSignatureHelpResolver,
} from "../index.js";
import { KeikoCodeEditor } from "./KeikoCodeEditor.js";
import { baseProps, buildBuffer, buildFileModel, dirtyFileModel } from "./test-harness.js";
import type { KeikoCodeEditorProps } from "./types.js";

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
  runAction: (id: string, editor: unknown) => void;
  formatRuns: () => number;
  saveKeybinding: () => number | undefined;
  focus: ReturnType<typeof vi.fn>;
  setSelection: ReturnType<typeof vi.fn>;
  setPosition: ReturnType<typeof vi.fn>;
  revealRangeInCenterIfOutsideViewport: ReturnType<typeof vi.fn>;
  deltaDecorations: ReturnType<typeof vi.fn>;
  executeEdits: ReturnType<typeof vi.fn>;
  pushUndoStop: ReturnType<typeof vi.fn>;
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

// A registration captured for the navigation/action/signature providers (#2104): the fake registrar
// records which language it was registered for and exposes a live `disposed()` read so a test can
// assert BOTH that registration happened and that a later `dispose()` call actually fired.
interface CapturedNavigationRegistration {
  readonly language: string;
  readonly disposed: () => boolean;
}

const captured: {
  editor: CapturedEditor | null;
  language: string | null;
  completion: CapturedCompletionRegistration[];
  definition: CapturedNavigationRegistration[];
  references: CapturedNavigationRegistration[];
  codeActions: CapturedNavigationRegistration[];
  signatureHelp: CapturedNavigationRegistration[];
  options: Record<string, unknown> | null;
  keepCurrentModel: boolean | null;
} = {
  editor: null,
  language: null,
  completion: [],
  definition: [],
  references: [],
  codeActions: [],
  signatureHelp: [],
  options: null,
  keepCurrentModel: null,
};

// Registers a fake navigation/action/signature provider: pushes a `CapturedNavigationRegistration`
// into `sink` and returns a disposable whose `dispose()` flips that entry's `disposed()` read to
// `true` — the same registrar/disposable shape `on-mount.test.ts` uses for these bridges.
function registerFakeNavigationProvider(
  sink: CapturedNavigationRegistration[],
  language: string,
): { dispose: () => void } {
  let disposedFlag = false;
  sink.push({ language, disposed: (): boolean => disposedFlag });
  return {
    dispose: (): void => {
      disposedFlag = true;
    },
  };
}

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
    keepCurrentModel?: boolean;
    onChange?: (value: string | undefined) => void;
    onMount?: (editor: unknown, monaco: unknown) => void;
  }
  const fakeMonaco = {
    editor: { defineTheme: vi.fn(), setModelMarkers: vi.fn() },
    MarkerSeverity: { Hint: 1, Info: 2, Warning: 4, Error: 8 },
    KeyMod: { CtrlCmd: 2048, Alt: 512 },
    KeyCode: { KeyS: 49, KeyK: 41, KeyT: 53, F2: 60 },
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
      // Navigation/action/signature registration surface (#2104): registration/disposal only — the
      // provider bodies themselves are exercised at the bridge-unit level (definition-bridge.test.ts,
      // references-bridge.test.ts, code-action-bridge.test.ts, signature-help-bridge.test.ts).
      registerDefinitionProvider: (language: string): { dispose: () => void } =>
        registerFakeNavigationProvider(captured.definition, language),
      registerReferenceProvider: (language: string): { dispose: () => void } =>
        registerFakeNavigationProvider(captured.references, language),
      registerCodeActionProvider: (language: string): { dispose: () => void } =>
        registerFakeNavigationProvider(captured.codeActions, language),
      registerSignatureHelpProvider: (language: string): { dispose: () => void } =>
        registerFakeNavigationProvider(captured.signatureHelp, language),
    },
  };
  interface FakeEditorShape {
    addAction: (descriptor: {
      id: string;
      keybindings?: number[];
      run: (editor?: unknown) => void;
    }) => { dispose: () => void };
    getAction: (id: string) => { run: () => void } | null;
    onDidChangeCursorPosition: (
      listener: (e: { position: { lineNumber: number; column: number } }) => void,
    ) => { dispose: () => void };
    onDidChangeCursorSelection: (listener: (e: { selection: FakeSelection }) => void) => {
      dispose: () => void;
    };
    saveViewState: () => { scroll: number };
    restoreViewState: ReturnType<typeof vi.fn>;
    focus: ReturnType<typeof vi.fn>;
    setSelection: ReturnType<typeof vi.fn>;
    setPosition: ReturnType<typeof vi.fn>;
    revealRangeInCenterIfOutsideViewport: ReturnType<typeof vi.fn>;
    deltaDecorations: ReturnType<typeof vi.fn>;
    executeEdits: ReturnType<typeof vi.fn>;
    pushUndoStop: ReturnType<typeof vi.fn>;
    getModel: () => {
      getValue: () => string;
      getVersionId: () => number;
      getLanguageId: () => string;
      getLineCount: () => number;
      getLineMaxColumn: (lineNumber: number) => number;
      onDidChangeContent: (listener: () => void) => { dispose: () => void };
      uri: { toString: () => string };
    };
    onDidChangeModel: (listener: () => void) => { dispose: () => void };
    getContainerDomNode: () => HTMLElement;
  }
  interface FakeModelShape {
    getValue: () => string;
    getVersionId: () => number;
    getLanguageId: () => string;
    getLineCount: () => number;
    getLineMaxColumn: (lineNumber: number) => number;
    onDidChangeContent: (listener: () => void) => { dispose: () => void };
    uri: { toString: () => string };
  }
  interface MockState {
    container: { current: HTMLDivElement | null };
    disposed: { action: boolean; cursor: boolean; selection: boolean };
    saveRun: () => void;
    actionRuns: Map<string, (editor?: unknown) => void>;
    formatRunCount: number;
    saveKeybindings: readonly number[] | undefined;
    cursorListener: ((e: { position: { lineNumber: number; column: number } }) => void) | null;
    selectionListener: ((e: { selection: FakeSelection }) => void) | null;
    focus: ReturnType<typeof vi.fn>;
    setSelection: ReturnType<typeof vi.fn>;
    setPosition: ReturnType<typeof vi.fn>;
    revealRangeInCenterIfOutsideViewport: ReturnType<typeof vi.fn>;
    deltaDecorations: ReturnType<typeof vi.fn>;
    executeEdits: ReturnType<typeof vi.fn>;
    pushUndoStop: ReturnType<typeof vi.fn>;
    modelText: string;
    modelLanguage: string;
    modelVersion: number;
    modelContentListener: (() => void) | null;
    onChange: MockProps["onChange"] | null;
    mounted: boolean;
    fakeEditor: FakeEditorShape;
  }
  function createMockState(): MockState {
    const s: MockState = {
      container: { current: null },
      disposed: { action: false, cursor: false, selection: false },
      saveRun: (): void => undefined,
      actionRuns: new Map(),
      formatRunCount: 0,
      saveKeybindings: undefined,
      cursorListener: null,
      selectionListener: null,
      focus: vi.fn(),
      setSelection: vi.fn(),
      setPosition: vi.fn(),
      revealRangeInCenterIfOutsideViewport: vi.fn(),
      deltaDecorations: vi.fn(
        (_oldDecorations: readonly string[], newDecorations: readonly unknown[]) =>
          newDecorations.length > 0 ? ["reference-decoration"] : [],
      ),
      executeEdits: vi.fn(),
      pushUndoStop: vi.fn(() => true),
      modelText: "",
      modelLanguage: "plaintext",
      modelVersion: 1,
      modelContentListener: null,
      onChange: null,
      mounted: false,
      fakeEditor: null as unknown as FakeEditorShape,
    };
    s.executeEdits.mockImplementation(
      (_source: string, edits: readonly { readonly text: string }[]): boolean => {
        const text = edits[0]?.text;
        if (text === undefined) return false;
        s.modelText = text;
        s.modelVersion += 1;
        s.modelContentListener?.();
        s.onChange?.(text);
        return true;
      },
    );
    s.fakeEditor = {
      addAction: (descriptor): { dispose: () => void } => {
        s.actionRuns.set(descriptor.id, descriptor.run);
        if (descriptor.id === "keiko.editor.save") {
          s.saveRun = (): void => {
            descriptor.run();
          };
          s.saveKeybindings = descriptor.keybindings;
        }
        return {
          dispose: (): void => {
            s.disposed.action = true;
          },
        };
      },
      getAction: (id): { run: () => void } | null =>
        id === "editor.action.formatDocument"
          ? {
              run: (): void => {
                s.formatRunCount += 1;
              },
            }
          : null,
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
      setSelection: s.setSelection,
      setPosition: s.setPosition,
      revealRangeInCenterIfOutsideViewport: s.revealRangeInCenterIfOutsideViewport,
      deltaDecorations: s.deltaDecorations,
      executeEdits: s.executeEdits,
      pushUndoStop: s.pushUndoStop,
      getModel: (): FakeModelShape => ({
        getValue: (): string => s.modelText,
        getVersionId: (): number => s.modelVersion,
        getLanguageId: (): string => s.modelLanguage,
        getLineCount: (): number => Math.max(1, s.modelText.split("\n").length),
        getLineMaxColumn: (lineNumber: number): number =>
          (s.modelText.split("\n")[lineNumber - 1]?.length ?? 0) + 1,
        onDidChangeContent: (listener): { dispose: () => void } => {
          s.modelContentListener = listener;
          return { dispose: vi.fn() };
        },
        uri: { toString: (): string => "inmemory://test/src/a.ts" },
      }),
      onDidChangeModel: (): { dispose: () => void } => ({ dispose: vi.fn() }),
      getContainerDomNode: (): HTMLElement => s.container.current ?? document.createElement("div"),
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
      runAction: (id, editor): void => {
        const run = s.actionRuns.get(id);
        if (run === undefined) throw new Error(`missing editor action ${id}`);
        run(editor);
      },
      formatRuns: (): number => s.formatRunCount,
      saveKeybinding: (): number | undefined => s.saveKeybindings?.[0],
      focus: s.focus,
      setSelection: s.setSelection,
      setPosition: s.setPosition,
      revealRangeInCenterIfOutsideViewport: s.revealRangeInCenterIfOutsideViewport,
      deltaDecorations: s.deltaDecorations,
      executeEdits: s.executeEdits,
      pushUndoStop: s.pushUndoStop,
      disposed: s.disposed,
    };
    return s;
  }
  function scheduleMountOnce(state: MockState, onMount: MockProps["onMount"]): void {
    if (!state.mounted) {
      state.mounted = true;
      queueMicrotask(() => onMount?.(state.fakeEditor, fakeMonaco));
    }
  }

  function syncMockStateFromProps(state: MockState, props: MockProps): void {
    captured.language = props.language ?? null;
    captured.options = props.options ?? null;
    captured.keepCurrentModel = props.keepCurrentModel ?? null;
    state.modelText = props.value ?? "";
    state.modelLanguage = props.language ?? "plaintext";
    state.onChange = props.onChange ?? null;
    scheduleMountOnce(state, props.onMount);
  }

  function MockEditorDom(props: {
    readonly state: MockState;
    readonly editorProps: MockProps;
  }): ReactElement {
    return (
      <div
        ref={(node): void => {
          props.state.container.current = node;
        }}
      >
        <textarea
          aria-label={props.editorProps.options?.ariaLabel ?? "Editor"}
          readOnly={props.editorProps.options?.readOnly ?? false}
          value={props.editorProps.value ?? ""}
          onChange={(event): void => {
            props.editorProps.onChange?.(event.target.value);
          }}
        />
      </div>
    );
  }

  const EditorMock = (props: MockProps): ReactElement => {
    // `@monaco-editor/react` invokes `onMount` exactly once and keeps the editor (and its registered
    // save action) across re-renders; only `onChange` is re-subscribed. Persist the fake editor
    // across renders so a save closure captured at mount stays bound — making a stale-text save
    // observable when the controlled `value` prop changes after mount.
    const ref = useRef<MockState | null>(null);
    const state = (ref.current ??= createMockState());
    syncMockStateFromProps(state, props);
    return <MockEditorDom state={state} editorProps={props} />;
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
  captured.definition = [];
  captured.references = [];
  captured.codeActions = [];
  captured.signatureHelp = [];
  captured.options = null;
  captured.keepCurrentModel = null;
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

  it("applies host edit requests through Monaco edits with undo stops", async () => {
    const onContentChange = vi.fn();
    render(
      <KeikoCodeEditor
        {...baseProps({
          onContentChange,
          hostEditRequest: {
            id: "rename-1",
            text: "const renamed = 1;\n",
            origin: "applied-patch",
          },
        })}
      />,
    );

    await waitFor(() => {
      expect(captured.editor?.executeEdits).toHaveBeenCalledWith("keiko.host-edit", [
        {
          range: { startLineNumber: 1, startColumn: 1, endLineNumber: 2, endColumn: 1 },
          text: "const renamed = 1;\n",
        },
      ]);
    });
    expect(captured.editor?.pushUndoStop).toHaveBeenCalledTimes(2);
    const [delta, origin] = onContentChange.mock.calls.at(-1) as [
      { text: string; sizeBytes: number },
      string,
    ];
    expect(delta.text).toBe("const renamed = 1;\n");
    expect(origin).toBe("applied-patch");
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

  it("runs Monaco format document when the host format request nonce changes", async () => {
    const { rerender } = render(<KeikoCodeEditor {...baseProps({ formatRequestNonce: 0 })} />);
    await flushMount();
    expect(captured.editor?.formatRuns()).toBe(0);

    rerender(<KeikoCodeEditor {...baseProps({ formatRequestNonce: 1 })} />);
    expect(captured.editor?.formatRuns()).toBe(1);

    rerender(<KeikoCodeEditor {...baseProps({ formatRequestNonce: 1 })} />);
    expect(captured.editor?.formatRuns()).toBe(1);
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

  it("runs Ask Keiko through the mounted action with the latest host callback", async () => {
    const initialHandler = vi.fn();
    const latestHandler = vi.fn();
    const { rerender } = render(
      <KeikoCodeEditor {...baseProps({ onAskKeikoAboutSelection: initialHandler })} />,
    );
    await flushMount();
    rerender(<KeikoCodeEditor {...baseProps({ onAskKeikoAboutSelection: latestHandler })} />);
    const selection = {
      startLineNumber: 1,
      startColumn: 7,
      endLineNumber: 1,
      endColumn: 12,
      isEmpty: (): boolean => false,
    };
    const getValueInRange = vi.fn(() => "value");

    captured.editor?.runAction("keiko.editor.askKeikoAboutSelection", {
      getSelection: () => selection,
      getModel: () => ({ getValueInRange }),
    });

    expect(initialHandler).not.toHaveBeenCalled();
    expect(getValueInRange).toHaveBeenCalledWith(selection);
    expect(latestHandler).toHaveBeenCalledWith({
      textMode: "selection",
      range: { start: { line: 0, column: 6 }, end: { line: 0, column: 11 } },
      text: "value",
    });
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

  it("re-applies the theme on a theme-variant change without remounting (Issue 2.2)", async () => {
    // A light/dark toggle must re-theme the SAME live editor (preserving the undo stack + view state),
    // not remount it. The re-apply re-attempts theme registration; in jsdom that surfaces again
    // through onRuntimeError — the observable that the re-theme path ran on the live instance.
    const onRuntimeError = vi.fn();
    const { rerender } = render(
      <KeikoCodeEditor {...baseProps({ onRuntimeError, themeVariant: "dark" })} />,
    );
    await flushMount();
    expect(onRuntimeError).toHaveBeenCalled();
    onRuntimeError.mockClear();

    rerender(<KeikoCodeEditor {...baseProps({ onRuntimeError, themeVariant: "light" })} />);
    await flushMount();
    expect(onRuntimeError).toHaveBeenCalled();
    // Still the same mounted editor — no remount.
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

describe("KeikoCodeEditor — reference reveal", () => {
  it("focuses, selects, scrolls to, and decorates the requested reference range", async () => {
    render(
      <KeikoCodeEditor
        {...baseProps({
          revealRequest: {
            id: "ref-1",
            range: { start: { line: 49, column: 0 }, end: { line: 56, column: 0 } },
          },
        })}
      />,
    );
    await flushMount();

    const expectedRange = {
      startLineNumber: 50,
      startColumn: 1,
      endLineNumber: 57,
      endColumn: 1,
    };
    expect(captured.editor?.focus).toHaveBeenCalled();
    expect(captured.editor?.setSelection).toHaveBeenCalledWith(expectedRange);
    expect(captured.editor?.setPosition).toHaveBeenCalledWith({
      lineNumber: expectedRange.startLineNumber,
      column: expectedRange.startColumn,
    });
    expect(captured.editor?.revealRangeInCenterIfOutsideViewport).toHaveBeenCalledWith(
      expectedRange,
    );
    expect(captured.editor?.deltaDecorations).toHaveBeenCalledWith(
      [],
      [
        {
          range: expectedRange,
          options: { isWholeLine: true, className: "keiko-editor-reference-target" },
        },
      ],
    );
  });

  it("keeps the cursor on an indented symbol while highlighting its whole line", async () => {
    render(
      <KeikoCodeEditor
        {...baseProps({
          revealRequest: {
            id: "nested-symbol",
            range: { start: { line: 16, column: 2 }, end: { line: 18, column: 3 } },
          },
        })}
      />,
    );
    await flushMount();

    expect(captured.editor?.setSelection).toHaveBeenCalledWith({
      startLineNumber: 17,
      startColumn: 1,
      endLineNumber: 19,
      endColumn: 4,
    });
    expect(captured.editor?.setPosition).toHaveBeenCalledWith({ lineNumber: 17, column: 3 });
  });

  it("replays the same range when the host sends a new reveal request id", async () => {
    const revealRequest = {
      id: "ref-1",
      range: { start: { line: 9, column: 0 }, end: { line: 9, column: 0 } },
    };
    const { rerender } = render(<KeikoCodeEditor {...baseProps({ revealRequest })} />);
    await flushMount();
    const firstRevealCount = captured.editor?.setSelection.mock.calls.length ?? 0;

    rerender(
      <KeikoCodeEditor {...baseProps({ revealRequest: { ...revealRequest, id: "ref-2" } })} />,
    );

    expect(captured.editor?.setSelection).toHaveBeenCalledTimes(firstRevealCount + 1);
    expect(captured.editor?.setSelection).toHaveBeenLastCalledWith({
      startLineNumber: 10,
      startColumn: 1,
      endLineNumber: 10,
      endColumn: 1,
    });
    expect(captured.editor?.setPosition).toHaveBeenLastCalledWith({
      lineNumber: 10,
      column: 1,
    });
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

describe("KeikoCodeEditor — diagnostic overview markers", () => {
  it("renders short rounded marker pills with hover content and click-to-line navigation", async () => {
    const user = userEvent.setup();
    render(
      <KeikoCodeEditor
        {...baseProps({
          buffer: buildBuffer({ text: "const x = 1;\nconst y = x;\n" }),
          provideDiagnostics: () =>
            Promise.resolve({
              request: {
                requestId: "req",
                streamId: "stream",
                sequence: 1,
              },
              diagnostics: [
                {
                  severity: "error",
                  message: "Type error",
                  source: "typescript",
                  code: "2322",
                  range: { start: { line: 1, column: 0 }, end: { line: 1, column: 5 } },
                },
              ],
            }),
        })}
      />,
    );
    await flushMount();

    const overview = await screen.findByTestId("keiko-editor-diagnostic-overview");
    expect(overview).toHaveStyle({
      right: "0px",
      width: "8px",
      pointerEvents: "none",
      zIndex: "var(--z-tooltip)",
    });
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /error diagnostic on line 2 .* type error/i }),
      ).toBeInTheDocument();
    });
    const marker = screen.getByRole("button", {
      name: /error diagnostic on line 2 .* type error/i,
    });
    expect(marker).toHaveAttribute("data-severity", "error");
    expect(marker).not.toHaveAttribute("title");
    expect(marker).toHaveStyle({
      width: "100%",
      height: "4px",
      borderRadius: "999px",
      background: "var(--ed-error, var(--feedback-danger, var(--danger)))",
      pointerEvents: "auto",
    });
    expect(screen.getByText("Type error")).toHaveClass("keiko-editor-diagnostic-tooltip-message");
    expect(screen.getByText("Line 2 · typescript(2322)")).toHaveClass(
      "keiko-editor-diagnostic-tooltip-meta",
    );

    await user.click(marker);
    const expectedRange = {
      startLineNumber: 2,
      startColumn: 1,
      endLineNumber: 2,
      endColumn: 6,
    };
    expect(captured.editor?.focus).toHaveBeenCalled();
    expect(captured.editor?.setSelection).toHaveBeenCalledWith(expectedRange);
    expect(captured.editor?.setPosition).toHaveBeenCalledWith({
      lineNumber: expectedRange.startLineNumber,
      column: expectedRange.startColumn,
    });
    expect(captured.editor?.revealRangeInCenterIfOutsideViewport).toHaveBeenCalledWith(
      expectedRange,
    );
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
      { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: vi.fn() }) },
    );
    expect(provideCompletions).toHaveBeenCalledTimes(1);
    const [query] = provideCompletions.mock.calls[0] as [{ documentText: string }];
    expect(query.documentText).toBe("const a = 1;\n");
    expect(list.suggestions.map((s) => s.label)).toEqual(["render"]);
  });
});

describe("KeikoCodeEditor — navigation/action/signature providers (#2104)", () => {
  function definitionResolver(): EditorDefinitionResolver {
    return (query) => Promise.resolve({ request: query.request.request, locations: [] });
  }
  function referencesResolver(): EditorReferencesResolver {
    return (query) =>
      Promise.resolve({
        request: query.request.request,
        locations: [],
        includesDeclaration: true,
      });
  }
  function codeActionsResolver(): EditorCodeActionsResolver {
    return (query) => Promise.resolve({ request: query.request.request, actions: [] });
  }
  function signatureHelpResolver(): EditorSignatureHelpResolver {
    return (query) =>
      Promise.resolve({
        request: query.request.request,
        signatures: [],
        activeSignature: null,
        activeParameter: null,
      });
  }
  function navigationProps(): Partial<KeikoCodeEditorProps> {
    return {
      provideDefinition: definitionResolver(),
      provideReferences: referencesResolver(),
      provideCodeActions: codeActionsResolver(),
      provideSignatureHelp: signatureHelpResolver(),
    };
  }

  it("registers a definition/references/codeActions/signatureHelp provider per governed language when the resolver props are supplied", async () => {
    render(<KeikoCodeEditor {...baseProps(navigationProps())} />);
    await flushMount();
    expect(captured.definition.map((r) => r.language)).toEqual(["typescript", "javascript"]);
    expect(captured.references.map((r) => r.language)).toEqual(["typescript", "javascript"]);
    expect(captured.codeActions.map((r) => r.language)).toEqual(["typescript", "javascript"]);
    expect(captured.signatureHelp.map((r) => r.language)).toEqual(["typescript", "javascript"]);
  });

  it("registers no navigation/action/signature providers when the host supplies no resolvers", async () => {
    render(<KeikoCodeEditor {...baseProps()} />);
    await flushMount();
    expect(captured.definition).toEqual([]);
    expect(captured.references).toEqual([]);
    expect(captured.codeActions).toEqual([]);
    expect(captured.signatureHelp).toEqual([]);
  });

  it("disposes every definition/references/codeActions/signatureHelp registration on unmount", async () => {
    const { unmount } = render(<KeikoCodeEditor {...baseProps(navigationProps())} />);
    await flushMount();
    expect(captured.definition.every((r) => r.disposed())).toBe(false);
    expect(captured.references.every((r) => r.disposed())).toBe(false);
    expect(captured.codeActions.every((r) => r.disposed())).toBe(false);
    expect(captured.signatureHelp.every((r) => r.disposed())).toBe(false);

    unmount();

    expect(captured.definition.every((r) => r.disposed())).toBe(true);
    expect(captured.references.every((r) => r.disposed())).toBe(true);
    expect(captured.codeActions.every((r) => r.disposed())).toBe(true);
    expect(captured.signatureHelp.every((r) => r.disposed())).toBe(true);
  });

  it("disposes navigation/action/signature providers when their resolver props are removed", async () => {
    const { rerender } = render(<KeikoCodeEditor {...baseProps(navigationProps())} />);
    await flushMount();
    expect(captured.definition).toHaveLength(2);

    rerender(<KeikoCodeEditor {...baseProps()} />);
    await flushMount();

    await waitFor(() => {
      expect(captured.definition.every((r) => r.disposed())).toBe(true);
    });
    expect(captured.definition).toHaveLength(2);
    expect(captured.references.every((r) => r.disposed())).toBe(true);
    expect(captured.codeActions.every((r) => r.disposed())).toBe(true);
    expect(captured.signatureHelp.every((r) => r.disposed())).toBe(true);

    rerender(<KeikoCodeEditor {...baseProps(navigationProps())} />);
    await flushMount();

    await waitFor(() => {
      expect(captured.definition).toHaveLength(4);
    });
    expect(captured.definition.slice(2).every((r) => r.disposed())).toBe(false);
    expect(captured.references.slice(2).every((r) => r.disposed())).toBe(false);
    expect(captured.codeActions.slice(2).every((r) => r.disposed())).toBe(false);
    expect(captured.signatureHelp.slice(2).every((r) => r.disposed())).toBe(false);
  });
});

describe("KeikoCodeEditor — large-file degraded mode (Issue #1207)", () => {
  it("passes normal Monaco options for a small buffer", () => {
    render(<KeikoCodeEditor {...baseProps()} />);
    expect(captured.options?.bracketPairColorization).toEqual({ enabled: true });
    expect(captured.options?.folding).toBe(true);
    expect(captured.options?.largeFileOptimizations).toBe(true);
  });

  it("lets @monaco-editor/react dispose the current model when the editor unmounts", () => {
    render(<KeikoCodeEditor {...baseProps()} />);
    expect(captured.keepCurrentModel).toBe(false);
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
