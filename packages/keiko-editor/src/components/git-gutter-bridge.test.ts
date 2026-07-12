import { describe, expect, it, vi } from "vitest";
import type { GitEditorDiffHunk } from "@oscharko-dev/keiko-contracts";

import { LARGE_FILE_DEGRADED_BYTES } from "./large-file-mode.js";
import {
  registerEditorGitGutter,
  type EditorGitGutterChanges,
  type MonacoGitGutterEditor,
} from "./git-gutter-bridge.js";

const LABELS = {
  staged: "Staged change",
  unstaged: "Unstaged change",
  added: "Added",
  modified: "Modified",
  deleted: "Deleted",
  openHunk: "Open change hunk",
} as const;

function hunk(kind: "add" | "del", line: number): GitEditorDiffHunk {
  return {
    header: `@@ -${line.toString()},1 +${line.toString()},1 @@`,
    oldStart: line,
    oldCount: 1,
    newStart: line,
    newCount: 1,
    lines: [
      {
        kind,
        text: "change",
        oldLine: kind === "del" ? line : null,
        newLine: kind === "add" ? line : null,
      },
    ],
    truncated: false,
  };
}

interface EditorFixture {
  readonly editor: MonacoGitGutterEditor;
  readonly decorationCalls: (readonly [
    string[],
    Parameters<MonacoGitGutterEditor["deltaDecorations"]>[1],
  ])[];
  focus(): void;
  click(line: number): void;
  rawClick(type: number, line?: number): void;
  runAction(line: number): void;
}

function editorFixture(): EditorFixture {
  let focusListener = (): void => undefined;
  let mouseListener = (_event: {
    readonly target: {
      readonly type: number;
      readonly position?: { readonly lineNumber: number } | undefined;
    };
  }): void => undefined;
  let action = (): void => undefined;
  let position = 1;
  const decorationCalls: EditorFixture["decorationCalls"] = [];
  const deltaDecorations = vi.fn(
    (
      oldDecorations: string[],
      next: Parameters<MonacoGitGutterEditor["deltaDecorations"]>[1],
    ): string[] => {
      decorationCalls.push([oldDecorations, next]);
      return next.map((_, index) => `id-${index.toString()}`);
    },
  );
  const disposable = { dispose: vi.fn() };
  return {
    editor: {
      deltaDecorations,
      onDidFocusEditorWidget: (listener): typeof disposable => {
        focusListener = listener;
        return disposable;
      },
      onMouseDown: (listener): typeof disposable => {
        mouseListener = listener;
        return disposable;
      },
      getPosition: (): { readonly lineNumber: number; readonly column: number } => ({
        lineNumber: position,
        column: 1,
      }),
      addAction: (descriptor): typeof disposable => {
        action = descriptor.run;
        return disposable;
      },
    },
    decorationCalls,
    focus: (): void => {
      focusListener();
    },
    click: (line): void => {
      mouseListener({ target: { type: 7, position: { lineNumber: line } } });
    },
    rawClick: (type, line): void => {
      const position = line === undefined ? undefined : { lineNumber: line };
      mouseListener({ target: { type, ...(position === undefined ? {} : { position }) } });
    },
    runAction: (line): void => {
      position = line;
      action();
    },
  };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("registerEditorGitGutter", () => {
  it("keeps staged and unstaged ids separate with shape and accessible metadata", async () => {
    const fixture = editorFixture();
    const resolve = vi.fn<() => Promise<EditorGitGutterChanges>>().mockResolvedValue({
      staged: [hunk("add", 2)],
      unstaged: [hunk("del", 4)],
    });
    registerEditorGitGutter({
      editor: fixture.editor,
      resolve,
      labels: LABELS,
      glyphMarginTargetType: 7,
      degraded: false,
      onPeek: vi.fn(),
    });
    await flush();

    expect(fixture.decorationCalls).toHaveLength(2);
    const staged = fixture.decorationCalls[0]?.[1][0];
    const unstaged = fixture.decorationCalls[1]?.[1][0];
    expect(staged?.options.description).toBe("Staged change: Added");
    expect(staged?.options.glyphMarginClassName).toContain("keiko-git-gutter-staged");
    expect(staged?.options.glyphMarginHoverMessage).toEqual({
      value: "Staged change: Added",
    });
    expect(unstaged?.options.description).toBe("Unstaged change: Deleted");
    expect(unstaged?.options.glyphMarginClassName).toContain("keiko-git-gutter-deleted");
  });

  it("refreshes only on mount, focus, and explicit refresh and discards stale responses", async () => {
    const fixture = editorFixture();
    let resolveFirst = (_value: EditorGitGutterChanges): void => undefined;
    const first = new Promise<EditorGitGutterChanges>((resolve) => {
      resolveFirst = resolve;
    });
    const latest = { staged: [hunk("add", 8)], unstaged: [] };
    const resolve = vi.fn().mockReturnValueOnce(first).mockResolvedValue(latest);
    const bridge = registerEditorGitGutter({
      editor: fixture.editor,
      resolve,
      labels: LABELS,
      glyphMarginTargetType: 7,
      degraded: false,
      onPeek: vi.fn(),
    });

    expect(resolve).toHaveBeenCalledTimes(1);
    bridge.refresh();
    await flush();
    resolveFirst({ staged: [hunk("del", 2)], unstaged: [] });
    await flush();
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(fixture.decorationCalls).toHaveLength(2);
    expect(fixture.decorationCalls[0]?.[1][0]?.range.startLineNumber).toBe(8);
    fixture.focus();
    await flush();
    expect(resolve).toHaveBeenCalledTimes(3);
  });

  it("opens the matching hunk by glyph click and keyboard palette action", async () => {
    const fixture = editorFixture();
    const onPeek = vi.fn();
    registerEditorGitGutter({
      editor: fixture.editor,
      resolve: () => Promise.resolve({ staged: [hunk("add", 3)], unstaged: [hunk("del", 7)] }),
      labels: LABELS,
      glyphMarginTargetType: 7,
      degraded: false,
      onPeek,
    });
    await flush();
    fixture.click(7);
    fixture.runAction(3);
    expect(onPeek).toHaveBeenNthCalledWith(1, expect.objectContaining({ layer: "unstaged" }));
    expect(onPeek).toHaveBeenNthCalledWith(2, expect.objectContaining({ layer: "staged" }));
  });

  it("does zero work in degraded mode at the large-file boundary", async () => {
    const fixture = editorFixture();
    const resolve = vi.fn().mockResolvedValue({ staged: [], unstaged: [] });
    const degraded = LARGE_FILE_DEGRADED_BYTES + 1 > LARGE_FILE_DEGRADED_BYTES;
    const bridge = registerEditorGitGutter({
      editor: fixture.editor,
      resolve,
      labels: LABELS,
      glyphMarginTargetType: 7,
      degraded,
      onPeek: vi.fn(),
    });
    bridge.refresh();
    bridge.dispose();
    await flush();
    expect(resolve).not.toHaveBeenCalled();
    expect(fixture.decorationCalls).toHaveLength(0);
  });

  it("renders modified hunks and ignores non-glyph or unmatched interactions", async () => {
    const fixture = editorFixture();
    const onPeek = vi.fn();
    const modified: GitEditorDiffHunk = {
      ...hunk("add", 5),
      lines: [...hunk("del", 5).lines, ...hunk("add", 5).lines],
    };
    registerEditorGitGutter({
      editor: fixture.editor,
      resolve: () => Promise.resolve({ staged: [modified], unstaged: [] }),
      labels: LABELS,
      glyphMarginTargetType: 7,
      degraded: false,
      onPeek,
    });
    await flush();
    fixture.rawClick(6, 5);
    fixture.rawClick(7);
    fixture.click(99);
    fixture.runAction(99);
    expect(fixture.decorationCalls[0]?.[1][0]?.options.description).toBe("Staged change: Modified");
    expect(onPeek).not.toHaveBeenCalled();
  });

  it("reports both error shapes and discards failures after disposal", async () => {
    const fixture = editorFixture();
    const onError = vi.fn();
    const resolve = vi
      .fn<() => Promise<EditorGitGutterChanges>>()
      .mockRejectedValueOnce(new Error("diff unavailable"))
      .mockRejectedValueOnce("opaque")
      .mockRejectedValueOnce(new Error("late"));
    const bridge = registerEditorGitGutter({
      editor: fixture.editor,
      resolve,
      labels: LABELS,
      glyphMarginTargetType: 7,
      degraded: false,
      onPeek: vi.fn(),
      onError,
    });
    await flush();
    bridge.refresh();
    await flush();
    bridge.refresh();
    bridge.dispose();
    await flush();
    expect(onError).toHaveBeenNthCalledWith(1, "diff unavailable");
    expect(onError).toHaveBeenNthCalledWith(2, "Git gutter refresh failed");
    expect(onError).toHaveBeenCalledTimes(2);
  });

  it("supports editors without an optional palette action", async () => {
    const fixture = editorFixture();
    const withoutAction: MonacoGitGutterEditor = {
      deltaDecorations: (oldDecorations, newDecorations) =>
        fixture.editor.deltaDecorations(oldDecorations, newDecorations),
      onDidFocusEditorWidget: (listener) => fixture.editor.onDidFocusEditorWidget(listener),
      onMouseDown: (listener) => fixture.editor.onMouseDown(listener),
      getPosition: () => fixture.editor.getPosition?.() ?? null,
    };
    const bridge = registerEditorGitGutter({
      editor: withoutAction,
      resolve: () => Promise.resolve({ staged: [], unstaged: [] }),
      labels: LABELS,
      glyphMarginTargetType: 7,
      degraded: false,
      onPeek: vi.fn(),
    });
    await flush();
    bridge.dispose();
    expect(fixture.decorationCalls).toHaveLength(4);
  });
});
