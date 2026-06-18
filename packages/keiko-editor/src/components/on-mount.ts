/**
 * Editor mount wiring (Issue #1194).
 *
 * `wireEditorOnMount` runs inside the `onMount(editor, monaco)` callback. It registers the Keiko
 * theme, adds the save action bound to Cmd/Ctrl+S, installs a capturing keydown backstop that
 * prevents the browser "Save page" dialog, subscribes cursor/selection reporting, and optionally
 * focuses the editor. It returns a single disposer that tears down every subscription, the action,
 * and the DOM listener — so the component's unmount effect is a one-liner.
 *
 * The DOM and Monaco edges are reached only through the injected `editor`/`monaco`/`container`
 * arguments (never module-scope globals), so the module is import-side-effect-free.
 */
import type * as monaco from "monaco-editor";

import type { EditorPosition, EditorRange } from "../index.js";
import {
  registerKeikoEditorTheme,
  resolveEditorThemeTokensFromDom,
} from "../index.js";
import type { EditorThemeVariant, MonacoThemeRegistrar } from "../monaco/theme.js";
import { buildSaveActionDescriptor } from "./keybindings.js";
import {
  monacoPositionToEditorPosition,
  monacoSelectionToEditorRange,
} from "./selection-reporting.js";

/** Minimal `monaco` namespace surface the mount wiring needs (the live `onMount` second arg). */
export interface MountMonaco {
  readonly editor: MonacoThemeRegistrar;
  readonly KeyMod: { readonly CtrlCmd: number };
  readonly KeyCode: { readonly KeyS: number };
}

/** Minimal editor surface the mount wiring needs (the live `onMount` first arg). */
export interface MountEditor {
  addAction(descriptor: monaco.editor.IActionDescriptor): monaco.IDisposable;
  onDidChangeCursorPosition(
    listener: (event: { position: monaco.Position }) => void,
  ): monaco.IDisposable;
  onDidChangeCursorSelection(
    listener: (event: { selection: monaco.Selection }) => void,
  ): monaco.IDisposable;
  focus(): void;
  getContainerDomNode(): HTMLElement;
  saveViewState(): unknown;
  restoreViewState(state: unknown): void;
}

export interface WireEditorOnMountArgs {
  readonly editor: MountEditor;
  readonly monaco: MountMonaco;
  readonly container: HTMLElement;
  readonly themeVariant: EditorThemeVariant;
  readonly autoFocus: boolean;
  readonly onSave: () => void;
  readonly onCursorChange?: ((position: EditorPosition) => void) | undefined;
  readonly onSelectionChange?: ((selection: EditorRange | null) => void) | undefined;
  /**
   * Reports a non-fatal theme-registration failure (e.g. the #1212 design tokens are not present in
   * the host stylesheet). The editor still mounts and renders with Monaco's base theme; this is a
   * system-boundary edge (DOM token resolution), so it is reported, not swallowed silently.
   */
  readonly onThemeError?: ((message: string) => void) | undefined;
}

/** True when a keyboard event is the Cmd/Ctrl+S save chord (regardless of platform modifier). */
export function isSaveChord(event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey">): boolean {
  return (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s";
}

function registerTheme(args: WireEditorOnMountArgs): void {
  try {
    const tokens = resolveEditorThemeTokensFromDom(args.container);
    registerKeikoEditorTheme(args.monaco.editor, args.themeVariant, tokens);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Editor theme registration failed";
    args.onThemeError?.(message);
  }
}

function installSaveAction(args: WireEditorOnMountArgs): monaco.IDisposable {
  return args.editor.addAction(
    buildSaveActionDescriptor({
      keys: { KeyMod: args.monaco.KeyMod, KeyCode: args.monaco.KeyCode },
      run: args.onSave,
    }),
  );
}

function installKeydownBackstop(args: WireEditorOnMountArgs): () => void {
  const handler = (event: KeyboardEvent): void => {
    if (isSaveChord(event)) {
      event.preventDefault();
    }
  };
  args.container.addEventListener("keydown", handler, { capture: true });
  return () => {
    args.container.removeEventListener("keydown", handler, { capture: true });
  };
}

function subscribeCursor(args: WireEditorOnMountArgs): monaco.IDisposable | null {
  const handler = args.onCursorChange;
  if (handler === undefined) {
    return null;
  }
  return args.editor.onDidChangeCursorPosition((event) => {
    handler(monacoPositionToEditorPosition(event.position));
  });
}

function subscribeSelection(args: WireEditorOnMountArgs): monaco.IDisposable | null {
  const handler = args.onSelectionChange;
  if (handler === undefined) {
    return null;
  }
  return args.editor.onDidChangeCursorSelection((event) => {
    handler(monacoSelectionToEditorRange(event.selection));
  });
}

/** Wire the editor on mount and return a disposer that tears everything down on unmount. */
export function wireEditorOnMount(args: WireEditorOnMountArgs): () => void {
  registerTheme(args);
  const action = installSaveAction(args);
  const removeBackstop = installKeydownBackstop(args);
  const cursorSub = subscribeCursor(args);
  const selectionSub = subscribeSelection(args);
  if (args.autoFocus) {
    args.editor.focus();
  }
  return () => {
    action.dispose();
    removeBackstop();
    cursorSub?.dispose();
    selectionSub?.dispose();
  };
}
