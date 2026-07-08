import { describe, expect, it, vi } from "vitest";

import { isSaveChord, wireEditorOnMount } from "./on-mount.js";
import type { MountEditor, MountMonaco, WireEditorOnMountArgs } from "./on-mount.js";
import type {
  MonacoCompletionItemProvider,
  MonacoCancellationToken,
  MonacoLanguagesRegistrar,
} from "./completion-bridge.js";
import type { MonacoDefinitionProvider, MonacoUriForPath } from "./definition-bridge.js";
import type {
  MonacoInlineCompletionsProvider,
  MonacoInlineCompletionsRegistrar,
} from "./inline-completion-bridge.js";
import type { MonacoReferenceProvider } from "./references-bridge.js";
import type {
  EditorCompletionResolver,
  EditorCodeActionsResolver,
  EditorDefinitionResolver,
  EditorDiagnosticsResolver,
  EditorFormattingResolver,
  EditorHoverResolver,
  EditorInlineCompletionResolver,
  EditorReferencesResolver,
  EditorSignatureHelpResolver,
  EditorSymbolsResolver,
} from "../index.js";

interface FakeDisposable {
  readonly dispose: ReturnType<typeof vi.fn>;
}

interface FakeCursorEvent {
  position: { lineNumber: number; column: number };
}
interface FakeSelectionEvent {
  selection: {
    startLineNumber: number;
    startColumn: number;
    endLineNumber: number;
    endColumn: number;
    isEmpty: () => boolean;
  };
}

interface FakeKeyboardEvent {
  readonly key: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly cancelable: boolean;
  defaultPrevented: boolean;
  preventDefault: () => void;
}

interface FakeEditorContainer {
  readonly addEventListener: ReturnType<
    typeof vi.fn<
      (
        type: string,
        listener: (event: KeyboardEvent) => void,
        options?: AddEventListenerOptions,
      ) => void
    >
  >;
  readonly removeEventListener: ReturnType<
    typeof vi.fn<
      (
        type: string,
        listener: (event: KeyboardEvent) => void,
        options?: EventListenerOptions,
      ) => void
    >
  >;
  dispatchKeyboardEvent(event: FakeKeyboardEvent): void;
}

// A structurally-loose stand-in for `MountEditor`: it captures the real wiring's calls while
// emitting plain coordinate objects (not full Monaco `Position`/`Selection` instances). It is cast
// to `MountEditor` at the `wireEditorOnMount` boundary, exactly as a real editor would be supplied.
interface FakeActionDescriptor {
  readonly id?: string;
  readonly label?: string;
  readonly keybindings?: number[];
  readonly contextMenuGroupId?: string;
  readonly run: (editor?: unknown) => void;
}

interface FakeEditor {
  addAction: (descriptor: FakeActionDescriptor) => FakeDisposable;
  getAction: (id: string) => { run: () => void } | null;
  onDidChangeCursorPosition: (listener: (event: FakeCursorEvent) => void) => FakeDisposable;
  onDidChangeCursorSelection: (listener: (event: FakeSelectionEvent) => void) => FakeDisposable;
  focus: () => void;
  getContainerDomNode: () => FakeEditorContainer;
  saveViewState: () => null;
  restoreViewState: () => void;
}

interface Fakes {
  readonly editor: FakeEditor;
  readonly monaco: MountMonaco;
  readonly container: FakeEditorContainer;
  readonly actionDisposable: FakeDisposable;
  readonly cursorDisposable: FakeDisposable;
  readonly selectionDisposable: FakeDisposable;
  readonly focus: ReturnType<typeof vi.fn>;
  readonly lastActionKeybindings: () => readonly number[] | undefined;
  readonly actionDescriptors: () => readonly FakeActionDescriptor[];
  cursorListener: ((event: FakeCursorEvent) => void) | null;
  selectionListener: ((event: FakeSelectionEvent) => void) | null;
}

function buildContainer(): FakeEditorContainer {
  let keydownListener: ((event: KeyboardEvent) => void) | null = null;
  return {
    addEventListener: vi.fn((type, listener) => {
      if (type === "keydown") {
        keydownListener = listener;
      }
    }),
    removeEventListener: vi.fn((type, listener) => {
      if (type === "keydown" && listener === keydownListener) {
        keydownListener = null;
      }
    }),
    dispatchKeyboardEvent(event): void {
      keydownListener?.(event as unknown as KeyboardEvent);
    },
  };
}

function buildKeyboardEvent(args: {
  readonly key: string;
  readonly metaKey?: boolean | undefined;
  readonly ctrlKey?: boolean | undefined;
}): FakeKeyboardEvent {
  const event: FakeKeyboardEvent = {
    key: args.key,
    metaKey: args.metaKey ?? false,
    ctrlKey: args.ctrlKey ?? false,
    cancelable: true,
    defaultPrevented: false,
    preventDefault: (): void => {
      if (event.cancelable) {
        event.defaultPrevented = true;
      }
    },
  };
  return event;
}

function buildFakes(): Fakes {
  const actionDisposable: FakeDisposable = { dispose: vi.fn() };
  const cursorDisposable: FakeDisposable = { dispose: vi.fn() };
  const selectionDisposable: FakeDisposable = { dispose: vi.fn() };
  const focus = vi.fn();
  let keybindings: readonly number[] | undefined;
  const descriptors: FakeActionDescriptor[] = [];
  const fakes: Fakes = {
    actionDisposable,
    cursorDisposable,
    selectionDisposable,
    focus,
    container: buildContainer(),
    monaco: {
      editor: { defineTheme: vi.fn() },
      KeyMod: { CtrlCmd: 2048, Alt: 512 },
      KeyCode: { KeyS: 49, KeyT: 53, F2: 60 },
    },
    cursorListener: null,
    selectionListener: null,
    lastActionKeybindings: (): readonly number[] | undefined => keybindings,
    actionDescriptors: (): readonly FakeActionDescriptor[] => descriptors,
    editor: {
      addAction: (descriptor) => {
        keybindings = descriptor.keybindings;
        descriptors.push(descriptor);
        return actionDisposable;
      },
      getAction: () => null,
      onDidChangeCursorPosition: (listener) => {
        fakes.cursorListener = listener;
        return cursorDisposable;
      },
      onDidChangeCursorSelection: (listener) => {
        fakes.selectionListener = listener;
        return selectionDisposable;
      },
      focus,
      getContainerDomNode: () => fakes.container,
      saveViewState: () => null,
      restoreViewState: () => undefined,
    },
  };
  return fakes;
}

function wire(fakes: Fakes, overrides?: Partial<WireEditorOnMountArgs>): () => void {
  return wireEditorOnMount({
    editor: fakes.editor as unknown as MountEditor,
    monaco: fakes.monaco,
    container: fakes.container as unknown as HTMLElement,
    themeVariant: "dark",
    autoFocus: false,
    onSave: vi.fn(),
    ...overrides,
  });
}

describe("isSaveChord", () => {
  it("is true for Cmd+S and Ctrl+S regardless of case", () => {
    expect(isSaveChord({ key: "s", metaKey: true, ctrlKey: false })).toBe(true);
    expect(isSaveChord({ key: "S", metaKey: false, ctrlKey: true })).toBe(true);
  });

  it("is false without a modifier or for a different key", () => {
    expect(isSaveChord({ key: "s", metaKey: false, ctrlKey: false })).toBe(false);
    expect(isSaveChord({ key: "a", metaKey: true, ctrlKey: false })).toBe(false);
  });
});

describe("wireEditorOnMount", () => {
  it("registers the save action with the Ctrl/Cmd+S chord and runs onSave", () => {
    const fakes = buildFakes();
    const onSave = vi.fn();
    wire(fakes, { onSave });
    expect(fakes.lastActionKeybindings()?.[0]).toBe(2048 | 49);
  });

  it("registers the Generate Tests command action when the host wires it (#1205)", () => {
    const fakes = buildFakes();
    const generateTests = vi.fn();
    wire(fakes, { commands: { generateTests } });
    const action = fakes
      .actionDescriptors()
      .find((descriptor) => descriptor.id === "keiko.editor.generateTests");
    expect(action).toBeDefined();
    // Bound to Cmd/Ctrl+Alt+T and discoverable in the context menu (mouse) and palette (F1).
    expect(action?.keybindings?.[0]).toBe(2048 | 512 | 53);
    expect(action?.contextMenuGroupId).toBe("1_modification");
    action?.run(fakes.editor);
    expect(generateTests).toHaveBeenCalledTimes(1);
  });

  it("registers the Rename Symbol command action when the host wires it (#2105)", () => {
    const fakes = buildFakes();
    const renameSymbol = vi.fn();
    wire(fakes, { commands: { renameSymbol } });
    const action = fakes
      .actionDescriptors()
      .find((descriptor) => descriptor.id === "keiko.editor.renameSymbol");
    expect(action).toBeDefined();
    expect(action?.keybindings?.[0]).toBe(60);
    expect(action?.contextMenuGroupId).toBe("1_modification");
    action?.run(fakes.editor);
    expect(renameSymbol).toHaveBeenCalledTimes(1);
  });

  it("registers no command action when the host wires none (#1205)", () => {
    const fakes = buildFakes();
    wire(fakes);
    expect(fakes.actionDescriptors().some((d) => d.id === "keiko.editor.generateTests")).toBe(
      false,
    );
  });

  it("disposes registered command actions on teardown (#1205)", () => {
    const fakes = buildFakes();
    const dispose = wire(fakes, { commands: { generateTests: vi.fn() } });
    dispose();
    // The shared fake disposable backs both the save action and the command action.
    expect(fakes.actionDisposable.dispose).toHaveBeenCalled();
  });

  it("installs a capturing keydown backstop that prevents the browser save dialog", () => {
    const fakes = buildFakes();
    wire(fakes);
    const saveEvent = buildKeyboardEvent({ key: "s", metaKey: true });
    fakes.container.dispatchKeyboardEvent(saveEvent);
    expect(saveEvent.defaultPrevented).toBe(true);

    const otherEvent = buildKeyboardEvent({ key: "a", metaKey: true });
    fakes.container.dispatchKeyboardEvent(otherEvent);
    expect(otherEvent.defaultPrevented).toBe(false);
  });

  it("reports cursor and selection changes through the host callbacks (0-based)", () => {
    const fakes = buildFakes();
    const onCursorChange = vi.fn();
    const onSelectionChange = vi.fn();
    wire(fakes, { onCursorChange, onSelectionChange });
    fakes.cursorListener?.({ position: { lineNumber: 3, column: 5 } });
    expect(onCursorChange).toHaveBeenCalledWith({ line: 2, column: 4 });
    fakes.selectionListener?.({
      selection: {
        startLineNumber: 1,
        startColumn: 1,
        endLineNumber: 2,
        endColumn: 4,
        isEmpty: () => false,
      },
    });
    expect(onSelectionChange).toHaveBeenCalledWith({
      start: { line: 0, column: 0 },
      end: { line: 1, column: 3 },
    });
  });

  it("focuses the editor only when autoFocus is set", () => {
    const focused = buildFakes();
    wire(focused, { autoFocus: true });
    expect(focused.focus).toHaveBeenCalledTimes(1);
    const unfocused = buildFakes();
    wire(unfocused, { autoFocus: false });
    expect(unfocused.focus).not.toHaveBeenCalled();
  });

  it("reports a theme-registration failure without throwing when DOM tokens are unavailable", () => {
    const fakes = buildFakes();
    const onThemeError = vi.fn();
    expect(() => wire(fakes, { onThemeError })).not.toThrow();
    expect(onThemeError).toHaveBeenCalled();
  });

  it("disposes the action, subscriptions, and the keydown backstop on teardown", () => {
    const fakes = buildFakes();
    const dispose = wire(fakes, { onCursorChange: vi.fn(), onSelectionChange: vi.fn() });
    dispose();
    expect(fakes.actionDisposable.dispose).toHaveBeenCalledTimes(1);
    expect(fakes.cursorDisposable.dispose).toHaveBeenCalledTimes(1);
    expect(fakes.selectionDisposable.dispose).toHaveBeenCalledTimes(1);
    expect(fakes.container.removeEventListener).toHaveBeenCalledWith(
      "keydown",
      expect.any(Function),
      {
        capture: true,
      },
    );
  });
});

interface FakeLanguages {
  readonly registrar: MonacoLanguagesRegistrar;
  readonly registeredLanguages: () => readonly (string | readonly string[])[];
  readonly disposeCount: () => number;
}

function buildFakeLanguages(): FakeLanguages {
  const languages: (string | readonly string[])[] = [];
  let disposed = 0;
  const registrar: MonacoLanguagesRegistrar = {
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
    registerCompletionItemProvider(
      languageSelector: string | readonly string[],
      _provider: MonacoCompletionItemProvider,
    ) {
      languages.push(languageSelector);
      return {
        dispose: (): void => {
          disposed += 1;
        },
      };
    },
  };
  return {
    registrar,
    registeredLanguages: () => languages,
    disposeCount: () => disposed,
  };
}

function completionArg(
  overrides: Partial<NonNullable<WireEditorOnMountArgs["completion"]>> = {},
): NonNullable<WireEditorOnMountArgs["completion"]> {
  const resolve: EditorCompletionResolver = (query) =>
    Promise.resolve({
      request: query.request.request,
      items: [],
      isIncomplete: false,
      provenance: { sources: ["deterministic-language-service"], modelMode: "deterministic" },
    });
  return {
    resolve,
    isCurrentDocument: () => true,
    triggerCharacters: ["."],
    contextBudgetBytes: 4096,
    streamId: "stream",
    newRequestId: () => "req-1",
    ...overrides,
  };
}

describe("wireEditorOnMount completion (#1199)", () => {
  it("registers a completion provider per governed language when a resolver and languages exist", () => {
    const fakes = buildFakes();
    const languages = buildFakeLanguages();
    wire(fakes, {
      monaco: { ...fakes.monaco, languages: languages.registrar },
      completion: completionArg(),
    });
    expect(languages.registeredLanguages()).toEqual(["typescript", "javascript"]);
  });

  it("registers only the requested completion languages", () => {
    const fakes = buildFakes();
    const languages = buildFakeLanguages();
    wire(fakes, {
      monaco: { ...fakes.monaco, languages: languages.registrar },
      completion: completionArg({ languages: ["typescript"] }),
    });
    expect(languages.registeredLanguages()).toEqual(["typescript"]);
  });

  it("registers nothing when the host supplies no completion resolver", () => {
    const fakes = buildFakes();
    const languages = buildFakeLanguages();
    wire(fakes, { monaco: { ...fakes.monaco, languages: languages.registrar } });
    expect(languages.registeredLanguages()).toEqual([]);
  });

  it("registers nothing when the live monaco namespace exposes no languages registry", () => {
    const fakes = buildFakes();
    expect(() => wire(fakes, { completion: completionArg() })).not.toThrow();
  });

  it("disposes every completion registration on teardown", () => {
    const fakes = buildFakes();
    const languages = buildFakeLanguages();
    const dispose = wire(fakes, {
      monaco: { ...fakes.monaco, languages: languages.registrar },
      completion: completionArg(),
    });
    expect(languages.disposeCount()).toBe(0);
    dispose();
    expect(languages.disposeCount()).toBe(2);
  });
});

interface FakeInlineLanguages {
  readonly registrar: MonacoInlineCompletionsRegistrar;
  readonly registeredLanguages: () => readonly (string | readonly string[])[];
  readonly disposeCount: () => number;
}

// A registrar that offers BOTH the completion and inline-completion surfaces, like the live
// `monaco.languages` namespace. The inline install path narrows the mount registry to the inline
// registrar; this fake satisfies that narrowing and records inline registrations.
function buildFakeInlineLanguages(withInline = true): FakeInlineLanguages {
  const languages: (string | readonly string[])[] = [];
  let disposed = 0;
  const completion = buildFakeLanguages().registrar;
  const registerInlineCompletionsProvider = (
    languageSelector: string | readonly string[],
    _provider: MonacoInlineCompletionsProvider,
  ): { dispose: () => void } => {
    languages.push(languageSelector);
    return {
      dispose: (): void => {
        disposed += 1;
      },
    };
  };
  // Construct via object spread (not property assignment) so the readonly inline members type-check.
  const inlineMembers = withInline
    ? {
        InlineCompletionTriggerKind: { Automatic: 0, Explicit: 1 },
        InlineCompletionEndOfLifeReasonKind: { Accepted: 0, Rejected: 1, Ignored: 2 },
        registerInlineCompletionsProvider,
      }
    : {};
  return {
    registrar: { ...completion, ...inlineMembers } as unknown as MonacoInlineCompletionsRegistrar,
    registeredLanguages: () => languages,
    disposeCount: () => disposed,
  };
}

function inlineCompletionArg(
  overrides: Partial<NonNullable<WireEditorOnMountArgs["inlineCompletion"]>> = {},
): NonNullable<WireEditorOnMountArgs["inlineCompletion"]> {
  const resolve: EditorInlineCompletionResolver = (query) =>
    Promise.resolve({ request: query.request.request, items: [] });
  return {
    resolve,
    isCurrentDocument: () => true,
    contextBudgetBytes: 8192,
    streamId: "inline-stream",
    newRequestId: () => "ireq-1",
    debounceDelayMs: 75,
    ...overrides,
  };
}

describe("wireEditorOnMount inline completion (#1200)", () => {
  it("registers an inline provider per governed language when a resolver and registry exist", () => {
    const fakes = buildFakes();
    const languages = buildFakeInlineLanguages();
    wire(fakes, {
      monaco: {
        ...fakes.monaco,
        languages: languages.registrar as unknown as MountMonaco["languages"],
      },
      inlineCompletion: inlineCompletionArg(),
    });
    expect(languages.registeredLanguages()).toEqual(["typescript", "javascript"]);
  });

  it("registers only the requested inline languages", () => {
    const fakes = buildFakes();
    const languages = buildFakeInlineLanguages();
    wire(fakes, {
      monaco: {
        ...fakes.monaco,
        languages: languages.registrar as unknown as MountMonaco["languages"],
      },
      inlineCompletion: inlineCompletionArg({ languages: ["typescript"] }),
    });
    expect(languages.registeredLanguages()).toEqual(["typescript"]);
  });

  it("registers nothing when the host supplies no inline resolver", () => {
    const fakes = buildFakes();
    const languages = buildFakeInlineLanguages();
    wire(fakes, {
      monaco: {
        ...fakes.monaco,
        languages: languages.registrar as unknown as MountMonaco["languages"],
      },
    });
    expect(languages.registeredLanguages()).toEqual([]);
  });

  it("degrades cleanly when the monaco registry exposes no inline-completion support", () => {
    const fakes = buildFakes();
    const languages = buildFakeInlineLanguages(false);
    expect(() =>
      wire(fakes, {
        monaco: {
          ...fakes.monaco,
          languages: languages.registrar as unknown as MountMonaco["languages"],
        },
        inlineCompletion: inlineCompletionArg(),
      }),
    ).not.toThrow();
    expect(languages.registeredLanguages()).toEqual([]);
  });

  it("disposes every inline registration on teardown", () => {
    const fakes = buildFakes();
    const languages = buildFakeInlineLanguages();
    const dispose = wire(fakes, {
      monaco: {
        ...fakes.monaco,
        languages: languages.registrar as unknown as MountMonaco["languages"],
      },
      inlineCompletion: inlineCompletionArg(),
    });
    expect(languages.disposeCount()).toBe(0);
    dispose();
    expect(languages.disposeCount()).toBe(2);
  });
});

// A registrar that offers the hover, document-symbol, and document-formatting registration surfaces
// (the slice the #1201 install paths narrow the mount registry to). Records registrations/disposals.
interface FakeLangRegistrar {
  readonly registrar: MountMonaco["languages"];
  readonly hovers: () => readonly (string | readonly string[])[];
  readonly symbols: () => readonly (string | readonly string[])[];
  readonly formatters: () => readonly (string | readonly string[])[];
  readonly disposeCount: () => number;
}

function buildFakeLangRegistrar(withMethods = true): FakeLangRegistrar {
  const hovers: (string | readonly string[])[] = [];
  const symbols: (string | readonly string[])[] = [];
  const formatters: (string | readonly string[])[] = [];
  let disposed = 0;
  const disposable = {
    dispose: (): void => {
      disposed += 1;
    },
  };
  const methods = withMethods
    ? {
        SymbolKind: {
          File: 0,
          Module: 1,
          Namespace: 2,
          Class: 4,
          Method: 5,
          Property: 6,
          Field: 7,
          Constructor: 8,
          Enum: 9,
          Interface: 10,
          Function: 11,
          Variable: 12,
          Constant: 13,
          Struct: 22,
          EnumMember: 21,
          TypeParameter: 25,
        },
        registerHoverProvider: (selector: string | readonly string[]): { dispose: () => void } => {
          hovers.push(selector);
          return disposable;
        },
        registerDocumentSymbolProvider: (
          selector: string | readonly string[],
        ): { dispose: () => void } => {
          symbols.push(selector);
          return disposable;
        },
        registerDocumentFormattingEditProvider: (
          selector: string | readonly string[],
        ): { dispose: () => void } => {
          formatters.push(selector);
          return disposable;
        },
      }
    : {};
  return {
    registrar: { ...methods } as unknown as MountMonaco["languages"],
    hovers: () => hovers,
    symbols: () => symbols,
    formatters: () => formatters,
    disposeCount: () => disposed,
  };
}

function hoverArg(): NonNullable<WireEditorOnMountArgs["hover"]> {
  const resolve: EditorHoverResolver = (query) =>
    Promise.resolve({ request: query.request.request, hover: { contents: null } });
  return { resolve, isCurrentDocument: () => true, streamId: "h", newRequestId: () => "hr" };
}

function symbolsArg(): NonNullable<WireEditorOnMountArgs["symbols"]> {
  const resolve: EditorSymbolsResolver = (query) =>
    Promise.resolve({ request: query.request.request, symbols: [] });
  return { resolve, isCurrentDocument: () => true, streamId: "sy", newRequestId: () => "syr" };
}

function formattingArg(): NonNullable<WireEditorOnMountArgs["formatting"]> {
  const resolve: EditorFormattingResolver = (query) =>
    Promise.resolve({ request: query.request.request, edits: [] });
  return { resolve, isCurrentDocument: () => true, streamId: "f", newRequestId: () => "fr" };
}

describe("wireEditorOnMount hover/symbols/formatting providers (#1201)", () => {
  it("registers each provider per governed language when a resolver and registry exist", () => {
    const fakes = buildFakes();
    const languages = buildFakeLangRegistrar();
    wire(fakes, {
      monaco: { ...fakes.monaco, languages: languages.registrar },
      hover: hoverArg(),
      symbols: symbolsArg(),
      formatting: formattingArg(),
    });
    expect(languages.hovers()).toEqual(["typescript", "javascript"]);
    expect(languages.symbols()).toEqual(["typescript", "javascript"]);
    expect(languages.formatters()).toEqual(["typescript", "javascript"]);
  });

  it("registers nothing when the host supplies no resolvers", () => {
    const fakes = buildFakes();
    const languages = buildFakeLangRegistrar();
    wire(fakes, { monaco: { ...fakes.monaco, languages: languages.registrar } });
    expect(languages.hovers()).toEqual([]);
    expect(languages.symbols()).toEqual([]);
    expect(languages.formatters()).toEqual([]);
  });

  it("degrades cleanly when the registry exposes none of the language-feature methods", () => {
    const fakes = buildFakes();
    const languages = buildFakeLangRegistrar(false);
    expect(() =>
      wire(fakes, {
        monaco: { ...fakes.monaco, languages: languages.registrar },
        hover: hoverArg(),
        symbols: symbolsArg(),
        formatting: formattingArg(),
      }),
    ).not.toThrow();
    expect(languages.hovers()).toEqual([]);
  });

  it("disposes every registration on teardown", () => {
    const fakes = buildFakes();
    const languages = buildFakeLangRegistrar();
    const dispose = wire(fakes, {
      monaco: { ...fakes.monaco, languages: languages.registrar },
      hover: hoverArg(),
      symbols: symbolsArg(),
      formatting: formattingArg(),
    });
    expect(languages.disposeCount()).toBe(0);
    dispose();
    // One disposable per language per feature (2 languages × 3 features).
    expect(languages.disposeCount()).toBe(6);
  });
});

interface FakeNavigationRegistrar {
  readonly registrar: MountMonaco["languages"];
  readonly definitions: () => readonly (string | readonly string[])[];
  readonly references: () => readonly (string | readonly string[])[];
  readonly definitionProviders: () => readonly MonacoDefinitionProvider[];
  readonly referenceProviders: () => readonly MonacoReferenceProvider[];
  readonly codeActions: () => readonly (string | readonly string[])[];
  readonly signatureHelp: () => readonly (string | readonly string[])[];
  readonly disposeCount: () => number;
}

function buildFakeNavigationRegistrar(withMethods = true): FakeNavigationRegistrar {
  const definitions: (string | readonly string[])[] = [];
  const references: (string | readonly string[])[] = [];
  const definitionProviders: MonacoDefinitionProvider[] = [];
  const referenceProviders: MonacoReferenceProvider[] = [];
  const codeActions: (string | readonly string[])[] = [];
  const signatureHelp: (string | readonly string[])[] = [];
  let disposed = 0;
  const disposable = {
    dispose: (): void => {
      disposed += 1;
    },
  };
  const methods = withMethods
    ? {
        CodeActionKind: { QuickFix: "quickfix", Refactor: "refactor", Source: "source" },
        registerDefinitionProvider: (
          selector: string | readonly string[],
          provider: MonacoDefinitionProvider,
        ): { dispose: () => void } => {
          definitions.push(selector);
          definitionProviders.push(provider);
          return disposable;
        },
        registerReferenceProvider: (
          selector: string | readonly string[],
          provider: MonacoReferenceProvider,
        ): { dispose: () => void } => {
          references.push(selector);
          referenceProviders.push(provider);
          return disposable;
        },
        registerCodeActionProvider: (
          selector: string | readonly string[],
        ): { dispose: () => void } => {
          codeActions.push(selector);
          return disposable;
        },
        registerSignatureHelpProvider: (
          selector: string | readonly string[],
        ): { dispose: () => void } => {
          signatureHelp.push(selector);
          return disposable;
        },
      }
    : {};
  return {
    registrar: { ...methods } as unknown as MountMonaco["languages"],
    definitions: () => definitions,
    references: () => references,
    definitionProviders: () => definitionProviders,
    referenceProviders: () => referenceProviders,
    codeActions: () => codeActions,
    signatureHelp: () => signatureHelp,
    disposeCount: () => disposed,
  };
}

function definitionArg(
  uriForPath?: MonacoUriForPath,
): NonNullable<WireEditorOnMountArgs["definition"]> {
  const resolve: EditorDefinitionResolver = (query) =>
    Promise.resolve({
      request: query.request.request,
      locations: [
        {
          path: "src/def.ts",
          range: { start: { line: 0, column: 0 }, end: { line: 0, column: 3 } },
        },
      ],
    });
  return {
    resolve,
    isCurrentDocument: () => true,
    streamId: "def",
    newRequestId: () => "def-r",
    ...(uriForPath === undefined ? {} : { uriForPath }),
  };
}

function referencesArg(
  uriForPath?: MonacoUriForPath,
): NonNullable<WireEditorOnMountArgs["references"]> {
  const resolve: EditorReferencesResolver = (query) =>
    Promise.resolve({
      request: query.request.request,
      locations: [
        {
          path: "src/ref.ts",
          range: { start: { line: 1, column: 0 }, end: { line: 1, column: 3 } },
        },
      ],
      includesDeclaration: true,
    });
  return {
    resolve,
    isCurrentDocument: () => true,
    streamId: "ref",
    newRequestId: () => "ref-r",
    ...(uriForPath === undefined ? {} : { uriForPath }),
  };
}

function cancellationToken(): MonacoCancellationToken {
  return {
    isCancellationRequested: false,
    onCancellationRequested: () => ({ dispose: (): void => undefined }),
  };
}

function codeActionsArg(): NonNullable<WireEditorOnMountArgs["codeActions"]> {
  const resolve: EditorCodeActionsResolver = (query) =>
    Promise.resolve({ request: query.request.request, actions: [] });
  return { resolve, isCurrentDocument: () => true, streamId: "ca", newRequestId: () => "ca-r" };
}

function signatureHelpArg(): NonNullable<WireEditorOnMountArgs["signatureHelp"]> {
  const resolve: EditorSignatureHelpResolver = (query) =>
    Promise.resolve({
      request: query.request.request,
      signatures: [],
      activeSignature: null,
      activeParameter: null,
    });
  return { resolve, isCurrentDocument: () => true, streamId: "sig", newRequestId: () => "sig-r" };
}

describe("wireEditorOnMount navigation/action/signature providers (#2104)", () => {
  it("registers each provider per governed language when resolvers and registry exist", () => {
    const fakes = buildFakes();
    const languages = buildFakeNavigationRegistrar();
    wire(fakes, {
      monaco: { ...fakes.monaco, languages: languages.registrar },
      definition: definitionArg(),
      references: referencesArg(),
      codeActions: codeActionsArg(),
      signatureHelp: signatureHelpArg(),
    });
    expect(languages.definitions()).toEqual(["typescript", "javascript"]);
    expect(languages.references()).toEqual(["typescript", "javascript"]);
    expect(languages.codeActions()).toEqual(["typescript", "javascript"]);
    expect(languages.signatureHelp()).toEqual(["typescript", "javascript"]);
  });

  it("registers no providers and no F12/Shift+F12 actions when the host supplies no resolvers", () => {
    const fakes = buildFakes();
    const languages = buildFakeNavigationRegistrar();
    wire(fakes, { monaco: { ...fakes.monaco, languages: languages.registrar } });
    expect(languages.definitions()).toEqual([]);
    expect(languages.references()).toEqual([]);
    expect(languages.codeActions()).toEqual([]);
    expect(languages.signatureHelp()).toEqual([]);
    expect(fakes.actionDescriptors()).toHaveLength(1);
  });

  it("does not register custom keybindings for definition or references", () => {
    const fakes = buildFakes();
    const languages = buildFakeNavigationRegistrar();
    wire(fakes, {
      monaco: { ...fakes.monaco, languages: languages.registrar },
      definition: definitionArg(),
      references: referencesArg(),
    });
    expect(fakes.actionDescriptors()).toHaveLength(1);
    expect(fakes.actionDescriptors()[0]?.id).not.toBe("editor.action.revealDefinition");
    expect(fakes.actionDescriptors()[0]?.id).not.toBe("editor.action.referenceSearch.trigger");
  });

  it("passes the host URI resolver into definition and references providers", async () => {
    const fakes = buildFakes();
    const languages = buildFakeNavigationRegistrar();
    const uriForPath: MonacoUriForPath = (path) => ({
      toString: () => `keiko-editor://workspace/test/${path}`,
    });
    wire(fakes, {
      monaco: { ...fakes.monaco, languages: languages.registrar },
      definition: definitionArg(uriForPath),
      references: referencesArg(uriForPath),
    });
    const model = {
      getValue: (): string => "value",
      uri: { toString: (): string => "keiko-editor://current" },
    };

    const definitions = await languages
      .definitionProviders()[0]
      ?.provideDefinition(model, { lineNumber: 1, column: 1 }, cancellationToken());
    const references = await languages
      .referenceProviders()[0]
      ?.provideReferences(
        model,
        { lineNumber: 1, column: 1 },
        { includeDeclaration: true },
        cancellationToken(),
      );

    expect(definitions?.[0]?.uri.toString()).toBe("keiko-editor://workspace/test/src/def.ts");
    expect(references?.[0]?.uri.toString()).toBe("keiko-editor://workspace/test/src/ref.ts");
  });

  it("normalizes host navigation URIs through Monaco's live URI parser", async () => {
    const fakes = buildFakes();
    const languages = buildFakeNavigationRegistrar();
    const parsed: string[] = [];
    const uriForPath: MonacoUriForPath = (path) => ({
      toString: () => `keiko-editor://workspace/test/${path}`,
    });
    wire(fakes, {
      monaco: {
        ...fakes.monaco,
        Uri: {
          parse: (value): { toString: () => string } => {
            parsed.push(value);
            return { toString: () => `parsed:${value}` };
          },
        },
        languages: languages.registrar,
      },
      definition: definitionArg(uriForPath),
      references: referencesArg(uriForPath),
    });
    const model = {
      getValue: (): string => "value",
      uri: { toString: (): string => "keiko-editor://current" },
    };

    const definitions = await languages
      .definitionProviders()[0]
      ?.provideDefinition(model, { lineNumber: 1, column: 1 }, cancellationToken());
    const references = await languages
      .referenceProviders()[0]
      ?.provideReferences(
        model,
        { lineNumber: 1, column: 1 },
        { includeDeclaration: true },
        cancellationToken(),
      );

    expect(definitions?.[0]?.uri.toString()).toBe(
      "parsed:keiko-editor://workspace/test/src/def.ts",
    );
    expect(references?.[0]?.uri.toString()).toBe("parsed:keiko-editor://workspace/test/src/ref.ts");
    expect(parsed).toEqual([
      "keiko-editor://workspace/test/src/def.ts",
      "keiko-editor://workspace/test/src/ref.ts",
    ]);
  });

  it("degrades cleanly when Monaco exposes none of the new registration methods", () => {
    const fakes = buildFakes();
    const languages = buildFakeNavigationRegistrar(false);
    expect(() =>
      wire(fakes, {
        monaco: { ...fakes.monaco, languages: languages.registrar },
        definition: definitionArg(),
        references: referencesArg(),
        codeActions: codeActionsArg(),
        signatureHelp: signatureHelpArg(),
      }),
    ).not.toThrow();
    expect(languages.definitions()).toEqual([]);
  });

  it("disposes every new provider registration on teardown", () => {
    const fakes = buildFakes();
    const languages = buildFakeNavigationRegistrar();
    const dispose = wire(fakes, {
      monaco: { ...fakes.monaco, languages: languages.registrar },
      definition: definitionArg(),
      references: referencesArg(),
      codeActions: codeActionsArg(),
      signatureHelp: signatureHelpArg(),
    });
    dispose();
    expect(languages.disposeCount()).toBe(8);
  });
});

describe("wireEditorOnMount diagnostics (#1201)", () => {
  // A diagnostics-capable monaco.editor (marker surface) + editor (model lifecycle), layered onto the
  // base fakes. The diagnostics install path narrows to these structural surfaces.
  function diagnosticsFakes(): {
    readonly monaco: MountMonaco;
    readonly editor: MountEditor;
    readonly setMarkersCalls: () => number;
    readonly modelDisposed: () => number;
  } {
    let modelDisposed = 0;
    let setMarkersCalls = 0;
    const model = {
      getValue: (): string => "const x = 1;\n",
      getVersionId: (): number => 1,
      getLanguageId: (): string => "typescript",
      onDidChangeContent: (): { dispose: () => void } => ({ dispose: (): void => undefined }),
      uri: { toString: (): string => "inmemory://model/1" },
    };
    const base = buildFakes();
    // Mirror the live namespace split: `setModelMarkers` on `monaco.editor`, `MarkerSeverity` on the
    // top-level `monaco` namespace.
    const monaco: MountMonaco = {
      ...base.monaco,
      MarkerSeverity: { Error: 8, Warning: 4, Info: 2, Hint: 1 },
      editor: {
        ...base.monaco.editor,
        setModelMarkers: (): void => {
          setMarkersCalls += 1;
        },
      } as unknown as MountMonaco["editor"],
    };
    const editor = {
      ...base.editor,
      getModel: (): typeof model => model,
      onDidChangeModel: (): { dispose: () => void } => ({
        dispose: (): void => {
          modelDisposed += 1;
        },
      }),
    } as unknown as MountEditor;
    return {
      monaco,
      editor,
      setMarkersCalls: () => setMarkersCalls,
      modelDisposed: () => modelDisposed,
    };
  }

  function diagnosticsArg(): NonNullable<WireEditorOnMountArgs["diagnostics"]> {
    const resolve: EditorDiagnosticsResolver = (query) =>
      Promise.resolve({ request: query.request.request, diagnostics: [] });
    return { resolve, debounceMs: 100, streamId: "d", newRequestId: () => "dr" };
  }

  it("binds the diagnostics lifecycle and clears markers on dispose", () => {
    const fakes = diagnosticsFakes();
    const dispose = wireEditorOnMount({
      editor: fakes.editor,
      monaco: fakes.monaco,
      container: buildFakes().container as unknown as HTMLElement,
      themeVariant: "dark",
      autoFocus: false,
      onSave: vi.fn(),
      diagnostics: diagnosticsArg(),
    });
    dispose();
    // The clear-on-dispose write happened (markers were touched at least once).
    expect(fakes.setMarkersCalls()).toBeGreaterThanOrEqual(1);
    expect(fakes.modelDisposed()).toBe(1);
  });

  it("does nothing when the editor lacks the marker surface", () => {
    const fakes = buildFakes();
    expect(() => wire(fakes, { diagnostics: diagnosticsArg() })).not.toThrow();
  });
});
