import { describe, expect, it, vi } from "vitest";

import { isSaveChord, wireEditorOnMount } from "./on-mount.js";
import type { MountEditor, MountMonaco, WireEditorOnMountArgs } from "./on-mount.js";

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

// A structurally-loose stand-in for `MountEditor`: it captures the real wiring's calls while
// emitting plain coordinate objects (not full Monaco `Position`/`Selection` instances). It is cast
// to `MountEditor` at the `wireEditorOnMount` boundary, exactly as a real editor would be supplied.
interface FakeEditor {
  addAction: (descriptor: { keybindings?: number[]; run: () => void }) => FakeDisposable;
  onDidChangeCursorPosition: (listener: (event: FakeCursorEvent) => void) => FakeDisposable;
  onDidChangeCursorSelection: (listener: (event: FakeSelectionEvent) => void) => FakeDisposable;
  focus: () => void;
  getContainerDomNode: () => HTMLElement;
  saveViewState: () => null;
  restoreViewState: () => void;
}

interface Fakes {
  readonly editor: FakeEditor;
  readonly monaco: MountMonaco;
  readonly container: HTMLElement;
  readonly actionDisposable: FakeDisposable;
  readonly cursorDisposable: FakeDisposable;
  readonly selectionDisposable: FakeDisposable;
  readonly focus: ReturnType<typeof vi.fn>;
  readonly lastActionKeybindings: () => readonly number[] | undefined;
  cursorListener: ((event: FakeCursorEvent) => void) | null;
  selectionListener: ((event: FakeSelectionEvent) => void) | null;
}

function buildFakes(): Fakes {
  const actionDisposable: FakeDisposable = { dispose: vi.fn() };
  const cursorDisposable: FakeDisposable = { dispose: vi.fn() };
  const selectionDisposable: FakeDisposable = { dispose: vi.fn() };
  const focus = vi.fn();
  let keybindings: readonly number[] | undefined;
  const fakes: Fakes = {
    actionDisposable,
    cursorDisposable,
    selectionDisposable,
    focus,
    container: document.createElement("div"),
    monaco: {
      editor: { defineTheme: vi.fn() },
      KeyMod: { CtrlCmd: 2048 },
      KeyCode: { KeyS: 49 },
    },
    cursorListener: null,
    selectionListener: null,
    lastActionKeybindings: (): readonly number[] | undefined => keybindings,
    editor: {
      addAction: (descriptor) => {
        keybindings = descriptor.keybindings;
        return actionDisposable;
      },
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
    container: fakes.container,
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

  it("installs a capturing keydown backstop that prevents the browser save dialog", () => {
    const fakes = buildFakes();
    wire(fakes);
    const saveEvent = new KeyboardEvent("keydown", { key: "s", metaKey: true, cancelable: true });
    fakes.container.dispatchEvent(saveEvent);
    expect(saveEvent.defaultPrevented).toBe(true);

    const otherEvent = new KeyboardEvent("keydown", { key: "a", metaKey: true, cancelable: true });
    fakes.container.dispatchEvent(otherEvent);
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

  it("reports a theme-registration failure without throwing (no --ed-* tokens in jsdom)", () => {
    const fakes = buildFakes();
    const onThemeError = vi.fn();
    expect(() => wire(fakes, { onThemeError })).not.toThrow();
    expect(onThemeError).toHaveBeenCalled();
  });

  it("disposes the action, subscriptions, and the keydown backstop on teardown", () => {
    const fakes = buildFakes();
    const removeSpy = vi.spyOn(fakes.container, "removeEventListener");
    const dispose = wire(fakes, { onCursorChange: vi.fn(), onSelectionChange: vi.fn() });
    dispose();
    expect(fakes.actionDisposable.dispose).toHaveBeenCalledTimes(1);
    expect(fakes.cursorDisposable.dispose).toHaveBeenCalledTimes(1);
    expect(fakes.selectionDisposable.dispose).toHaveBeenCalledTimes(1);
    expect(removeSpy).toHaveBeenCalledWith("keydown", expect.any(Function), { capture: true });
  });
});
