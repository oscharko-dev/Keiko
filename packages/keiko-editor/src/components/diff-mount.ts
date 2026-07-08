/**
 * Diff-editor mount wiring (Issue #1195).
 *
 * `wireDiffEditorOnMount` runs inside the diff editor's `onMount(diffEditor, monaco)` callback. It
 * registers the Keiko theme from the live DOM tokens (mirroring the code editor's mount) and returns
 * a small controller the toolbar uses to jump between hunks via Monaco's built-in `goToDiff`. The DOM
 * and Monaco edges are reached only through the injected arguments, never module-scope globals, so the
 * module is import-side-effect-free.
 */
import { registerKeikoEditorTheme, resolveEditorThemeTokensFromDom } from "../index.js";
import type { EditorThemeVariant, MonacoThemeRegistrar } from "../monaco/theme.js";

/** Minimal `monaco` namespace surface the diff mount needs (the live `onMount` second arg). */
export interface MountDiffMonaco {
  readonly editor: MonacoThemeRegistrar;
}

/** Minimal diff-editor surface the mount wiring needs (the live `onMount` first arg). */
export interface MountDiffEditor {
  getContainerDomNode(): HTMLElement;
  goToDiff(target: "next" | "previous"): void;
  setModel?: ((model: null) => void) | undefined;
}

/** Imperative handle the toolbar uses to navigate hunks. */
export interface DiffMountController {
  goToNextDiff(): void;
  goToPreviousDiff(): void;
  dispose(): void;
}

export interface WireDiffEditorOnMountArgs {
  readonly editor: MountDiffEditor;
  readonly monaco: MountDiffMonaco;
  readonly themeVariant: EditorThemeVariant;
  /**
   * Reports a non-fatal theme-registration failure (e.g. the #1212 design tokens are absent from the
   * host stylesheet). The diff editor still renders with Monaco's base theme; this is a
   * system-boundary edge (DOM token resolution), so it is reported, not swallowed silently.
   */
  readonly onThemeError?: ((message: string) => void) | undefined;
}

function registerTheme(args: WireDiffEditorOnMountArgs): void {
  try {
    const tokens = resolveEditorThemeTokensFromDom(args.editor.getContainerDomNode());
    registerKeikoEditorTheme(args.monaco.editor, args.themeVariant, tokens);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Diff theme registration failed";
    args.onThemeError?.(message);
  }
}

/** Register the theme on mount and return the hunk-navigation controller. */
export function wireDiffEditorOnMount(args: WireDiffEditorOnMountArgs): DiffMountController {
  registerTheme(args);
  return {
    goToNextDiff: (): void => {
      args.editor.goToDiff("next");
    },
    goToPreviousDiff: (): void => {
      args.editor.goToDiff("previous");
    },
    dispose: (): void => {
      args.editor.setModel?.(null);
    },
  };
}
