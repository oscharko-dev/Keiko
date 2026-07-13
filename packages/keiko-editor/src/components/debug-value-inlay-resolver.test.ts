import { describe, expect, it } from "vitest";

import {
  MAX_DEBUG_VALUE_DECORATIONS,
  registerDebugValueInlays,
  type EditorDebugValueSnapshot,
  type MonacoDebugValueEditor,
} from "./debug-value-inlay-resolver.js";

function snapshot(overrides: Partial<EditorDebugValueSnapshot> = {}): EditorDebugValueSnapshot {
  return {
    paused: true,
    pauseGeneration: 1,
    documentUri: "keiko-editor://current",
    values: [{ line: 2, column: 8, value: "42" }],
    ...overrides,
  };
}

function decorationRecorder(): {
  readonly editor: MonacoDebugValueEditor;
  decorations(): Parameters<MonacoDebugValueEditor["deltaDecorations"]>[1];
} {
  let current: Parameters<MonacoDebugValueEditor["deltaDecorations"]>[1] = [];
  return {
    editor: {
      deltaDecorations: (_oldDecorations, decorations): string[] => {
        current = decorations;
        return decorations.map((_, index) => `id-${String(index)}`);
      },
    },
    decorations: (): Parameters<MonacoDebugValueEditor["deltaDecorations"]>[1] => current,
  };
}

describe("registerDebugValueInlays", () => {
  it("projects paused values as bounded after-content decorations using the dedicated debug class", () => {
    const recorder = decorationRecorder();
    let resolvedDocumentUri = "";
    registerDebugValueInlays({
      editor: recorder.editor,
      documentUri: () => "keiko-editor://current",
      resolve: (documentUri) => {
        resolvedDocumentUri = documentUri;
        return snapshot();
      },
    });

    expect(resolvedDocumentUri).toBe("keiko-editor://current");

    expect(recorder.decorations()).toEqual([
      {
        range: { startLineNumber: 2, startColumn: 8, endLineNumber: 2, endColumn: 9 },
        options: {
          description: "Paused debug value",
          after: { content: " = 42", inlineClassName: "keiko-debug-inline-value" },
          isWholeLine: true,
        },
      },
    ]);
  });

  it("clears values after resume or a document change and caps paused work at D10's 200 entries", () => {
    let current = snapshot({
      values: Array.from({ length: MAX_DEBUG_VALUE_DECORATIONS + 1 }, (_, index) => ({
        line: index + 1,
        column: 1,
        value: String(index),
      })),
    });
    const recorder = decorationRecorder();
    const bridge = registerDebugValueInlays({
      editor: recorder.editor,
      documentUri: () => "keiko-editor://current",
      resolve: () => current,
    });
    expect(recorder.decorations()).toHaveLength(MAX_DEBUG_VALUE_DECORATIONS);

    current = snapshot({ paused: false });
    bridge.refresh();
    expect(recorder.decorations()).toEqual([]);
    current = snapshot({ documentUri: "keiko-editor://other" });
    bridge.refresh();
    expect(recorder.decorations()).toEqual([]);
  });
});
