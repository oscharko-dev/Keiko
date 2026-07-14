import type { MonacoDisposable, MonacoRange } from "./completion-bridge.js";

export const MAX_DEBUG_VALUE_DECORATIONS = 200;

export interface EditorDebugPausedValue {
  readonly line: number;
  readonly column: number;
  readonly value: string;
}

export interface EditorDebugValueSnapshot {
  readonly paused: boolean;
  readonly pauseGeneration: number;
  readonly documentUri: string;
  readonly description?: string | undefined;
  readonly values: readonly EditorDebugPausedValue[];
}

interface MonacoAfterContentDecoration {
  readonly range: MonacoRange;
  readonly options: {
    readonly description: string;
    readonly after: { readonly content: string; readonly inlineClassName: string };
    readonly isWholeLine: boolean;
  };
}

export interface MonacoDebugValueEditor {
  deltaDecorations(
    oldDecorations: string[],
    newDecorations: readonly MonacoAfterContentDecoration[],
  ): string[];
}

export interface DebugValueInlayBridge extends MonacoDisposable {
  refresh(): void;
}

export interface RegisterDebugValueInlaysArgs {
  readonly editor: MonacoDebugValueEditor;
  readonly documentUri: () => string;
  readonly resolve: (documentUri: string) => EditorDebugValueSnapshot;
}

function isRenderable(value: EditorDebugPausedValue): boolean {
  return value.line >= 1 && value.column >= 1 && value.value.length > 0;
}

function projection(
  snapshot: EditorDebugValueSnapshot,
  documentUri: string,
): readonly MonacoAfterContentDecoration[] {
  if (documentUri.length === 0 || !snapshot.paused || snapshot.documentUri !== documentUri)
    return [];
  return snapshot.values
    .filter(isRenderable)
    .slice(0, MAX_DEBUG_VALUE_DECORATIONS)
    .map((value) => ({
      range: {
        startLineNumber: value.line,
        startColumn: value.column,
        endLineNumber: value.line,
        endColumn: value.column + 1,
      },
      options: {
        description: snapshot.description ?? "",
        after: { content: ` = ${value.value}`, inlineClassName: "keiko-debug-inline-value" },
        isWholeLine: true,
      },
    }));
}

/**
 * Projects only the current paused snapshot into Monaco after-content decorations. The bridge has no
 * polling or evaluate operation: callers refresh it when their already-bounded debug projection changes.
 */
export function registerDebugValueInlays(
  args: RegisterDebugValueInlaysArgs,
): DebugValueInlayBridge {
  let decorationIds: string[] = [];
  const refresh = (): void => {
    const documentUri = args.documentUri();
    decorationIds = args.editor.deltaDecorations(
      decorationIds,
      projection(args.resolve(documentUri), documentUri),
    );
  };
  refresh();
  return {
    refresh,
    dispose(): void {
      decorationIds = args.editor.deltaDecorations(decorationIds, []);
    },
  };
}
