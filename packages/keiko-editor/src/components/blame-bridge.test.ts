import type { GitEditorBlameResponse } from "@oscharko-dev/keiko-contracts";
import { describe, expect, it, vi } from "vitest";

import { registerEditorBlame, type MonacoBlameEditor } from "./blame-bridge.js";

const RESPONSE: GitEditorBlameResponse = {
  schemaVersion: "1",
  path: "src/app.ts",
  startLine: 1,
  lines: [
    {
      line: 2,
      commitHash: "a".repeat(40),
      author: "Ada",
      authorTime: "2026-06-10T10:00:00Z",
      summary: "Explain this line",
    },
  ],
  truncated: true,
  totalLines: 3,
  totalBytes: 120,
  maxBytes: 262_144,
  maxLines: 2_000,
};

function fixture(): {
  readonly editor: MonacoBlameEditor;
  readonly calls: (readonly [string[], Parameters<MonacoBlameEditor["deltaDecorations"]>[1]])[];
  run(id: string): void;
  click(line: number): void;
  rawClick(type: number, line?: number): void;
} {
  const actions = new Map<string, () => void>();
  let mouseListener = (_event: {
    readonly target: {
      readonly type: number;
      readonly position?: { readonly lineNumber: number } | undefined;
    };
  }): void => undefined;
  const calls: (readonly [string[], Parameters<MonacoBlameEditor["deltaDecorations"]>[1]])[] = [];
  return {
    calls,
    editor: {
      deltaDecorations: (oldIds, next): string[] => {
        calls.push([oldIds, next]);
        return next.map((_, index) => `d${String(index)}`);
      },
      getPosition: () => ({ lineNumber: 2, column: 1 }),
      onMouseDown: (listener): { dispose(): void } => {
        mouseListener = listener;
        return { dispose: (): void => undefined };
      },
      addAction: (action): { dispose(): void } => {
        actions.set(action.id, action.run);
        return { dispose: (): void => undefined };
      },
    },
    run: (id): void => {
      actions.get(id)?.();
    },
    click: (line): void => {
      mouseListener({ target: { type: 7, position: { lineNumber: line } } });
    },
    rawClick: (type, line): void => {
      const position = line === undefined ? undefined : { lineNumber: line };
      mouseListener({ target: { type, ...(position === undefined ? {} : { position }) } });
    },
  };
}

function firstLine(): GitEditorBlameResponse["lines"][number] {
  const line = RESPONSE.lines[0];
  if (line === undefined) throw new Error("fixture line missing");
  return line;
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("registerEditorBlame", () => {
  it("fetches only on toggle, renders bounded metadata, and clears separate ids", async () => {
    const view = fixture();
    const resolve = vi.fn().mockResolvedValue(RESPONSE);
    const bridge = registerEditorBlame({
      editor: view.editor,
      resolve,
      degraded: false,
      glyphMarginTargetType: 7,
      dirty: () => true,
      describe: (line, age) => `${line.author} · ${age}`,
      formatAge: () => "1 month ago",
      labels: {
        toggle: "Toggle blame",
        openCommit: "Open commit",
        dirtyNotice: "Blame reflects HEAD.",
        truncated: "Blame was truncated.",
      },
      onCommit: vi.fn(),
    });

    expect(resolve).not.toHaveBeenCalled();
    view.run("keiko.editor.toggleBlame");
    await flush();
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(view.calls).toHaveLength(2);
    expect(view.calls[0]?.[1][0]?.options.description).toContain("Ada · 1 month ago");
    expect(view.calls[0]?.[1][0]?.options.description).toContain("Blame reflects HEAD.");
    expect(view.calls[1]?.[1][0]?.options.description).toBe("Blame was truncated.");

    bridge.toggle();
    expect(view.calls.at(-2)?.[1]).toEqual([]);
    expect(view.calls.at(-1)?.[1]).toEqual([]);
  });

  it("opens a bounded commit by mouse and keyboard and ignores uncommitted lines", async () => {
    const view = fixture();
    const onCommit = vi.fn();
    const response = {
      ...RESPONSE,
      lines: [firstLine(), { ...firstLine(), line: 3, commitHash: "0".repeat(40) }],
    };
    registerEditorBlame({
      editor: view.editor,
      resolve: () => Promise.resolve(response),
      degraded: false,
      glyphMarginTargetType: 7,
      dirty: () => false,
      describe: (line, age) => `${line.author} ${age}`,
      formatAge: () => "recently",
      labels: { toggle: "Toggle", openCommit: "Open", dirtyNotice: "HEAD", truncated: "More" },
      onCommit,
    });
    view.run("keiko.editor.toggleBlame");
    await flush();
    view.click(2);
    view.run("keiko.editor.openBlameCommit");
    view.click(3);
    expect(onCommit).toHaveBeenCalledTimes(2);
    expect(onCommit).toHaveBeenLastCalledWith("a".repeat(40));
  });

  it("does zero work when degraded and discards a stale response after disable", async () => {
    const degraded = fixture();
    const resolve = vi.fn().mockResolvedValue(RESPONSE);
    registerEditorBlame({
      editor: degraded.editor,
      resolve,
      degraded: true,
      glyphMarginTargetType: 7,
      dirty: () => false,
      describe: () => "line",
      formatAge: () => "age",
      labels: { toggle: "Toggle", openCommit: "Open", dirtyNotice: "HEAD", truncated: "More" },
      onCommit: vi.fn(),
    });
    degraded.run("keiko.editor.toggleBlame");
    await flush();
    expect(resolve).not.toHaveBeenCalled();
    expect(degraded.calls).toHaveLength(0);

    const active = fixture();
    let finish = (_response: GitEditorBlameResponse): void => undefined;
    const pending = new Promise<GitEditorBlameResponse>((resolvePending) => {
      finish = resolvePending;
    });
    const bridge = registerEditorBlame({
      editor: active.editor,
      resolve: () => pending,
      degraded: false,
      glyphMarginTargetType: 7,
      dirty: () => false,
      describe: () => "line",
      formatAge: () => "age",
      labels: { toggle: "Toggle", openCommit: "Open", dirtyNotice: "HEAD", truncated: "More" },
      onCommit: vi.fn(),
    });
    bridge.toggle();
    bridge.toggle();
    finish(RESPONSE);
    await flush();
    expect(active.calls.every((call) => call[1].length === 0)).toBe(true);
  });

  it("handles empty, null, and rejected reads without leaking stale interactions", async () => {
    const empty = fixture();
    registerEditorBlame({
      editor: empty.editor,
      resolve: () => Promise.resolve({ ...RESPONSE, lines: [] }),
      degraded: false,
      glyphMarginTargetType: 7,
      dirty: () => false,
      describe: () => "line",
      formatAge: () => "age",
      labels: { toggle: "Toggle", openCommit: "Open", dirtyNotice: "HEAD", truncated: "More" },
      onCommit: vi.fn(),
    });
    empty.run("keiko.editor.toggleBlame");
    await flush();
    expect(empty.calls[1]?.[1][0]?.range.startLineNumber).toBe(1);

    const absent = fixture();
    registerEditorBlame({
      editor: absent.editor,
      resolve: () => Promise.resolve(null),
      degraded: false,
      glyphMarginTargetType: 7,
      dirty: () => false,
      describe: () => "line",
      formatAge: () => "age",
      labels: { toggle: "Toggle", openCommit: "Open", dirtyNotice: "HEAD", truncated: "More" },
      onCommit: vi.fn(),
    });
    absent.run("keiko.editor.toggleBlame");
    absent.rawClick(6, 2);
    absent.rawClick(7);
    await flush();
    expect(absent.calls).toHaveLength(0);

    const errors = fixture();
    const onError = vi.fn();
    registerEditorBlame({
      editor: errors.editor,
      resolve: vi
        .fn<() => Promise<GitEditorBlameResponse | null>>()
        .mockRejectedValueOnce(new Error("blame unavailable"))
        .mockRejectedValueOnce("opaque"),
      degraded: false,
      glyphMarginTargetType: 7,
      dirty: () => false,
      describe: () => "line",
      formatAge: () => "age",
      labels: { toggle: "Toggle", openCommit: "Open", dirtyNotice: "HEAD", truncated: "More" },
      onCommit: vi.fn(),
      onError,
    });
    errors.run("keiko.editor.toggleBlame");
    await flush();
    errors.run("keiko.editor.toggleBlame");
    errors.run("keiko.editor.toggleBlame");
    await flush();
    expect(onError).toHaveBeenNthCalledWith(1, "blame unavailable");
    expect(onError).toHaveBeenNthCalledWith(2, "Blame read failed");
  });

  it("discards a rejected read after disposal", async () => {
    const view = fixture();
    let reject = (_error: unknown): void => undefined;
    const pending = new Promise<GitEditorBlameResponse>((_resolve, rejectPending) => {
      reject = rejectPending;
    });
    const onError = vi.fn();
    const bridge = registerEditorBlame({
      editor: view.editor,
      resolve: () => pending,
      degraded: false,
      glyphMarginTargetType: 7,
      dirty: () => false,
      describe: () => "line",
      formatAge: () => "age",
      labels: { toggle: "Toggle", openCommit: "Open", dirtyNotice: "HEAD", truncated: "More" },
      onCommit: vi.fn(),
      onError,
    });
    bridge.toggle();
    bridge.dispose();
    reject(new Error("late"));
    await flush();
    expect(onError).not.toHaveBeenCalled();
  });
});
