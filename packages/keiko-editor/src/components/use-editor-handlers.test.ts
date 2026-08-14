// @vitest-environment jsdom
/**
 * Direct unit coverage for the {@link useEditorHandlers} hook (KEIKO-0407).
 *
 * Every other production file in this directory has a co-located unit test; this file was the
 * outlier, with coverage reaching this hook only indirectly through KeikoCodeEditor.test.tsx's full
 * `@monaco-editor/react` mock (plus two narrowly-scoped files covering one slice each). This suite
 * drives the exported hook (`useEditorHandlers`, `useChangeHandler`) directly through
 * `renderHook`, against a lightweight fake mount/editor double scoped to only the `MountEditor`/
 * `MountMonaco` methods the hook actually calls — distinct from, and much lighter than,
 * KeikoCodeEditor.test.tsx's full component-rendering mock.
 *
 * It exercises four branches the composed-component test does not reach at the hook level:
 *   1. the not-yet-mounted host-edit-request race (a request that arrives before `onMount` fires);
 *   2. the readOnly/hostEditRequest interaction, including that a request marked handled while
 *      read-only never retroactively re-applies once writable;
 *   3. `runtimeWiringAvailabilityKey`'s refresh gating — a language-only `fileModel` swap must NOT
 *      re-run the mount wiring, while a genuine provider-availability change must;
 *   4. `consumeProgrammaticChange`'s edge cases (via the exported `useChangeHandler`): no marker, a
 *      matching marker (with and without `suppress`), a matching marker with no explicit origin, and
 *      a stale (non-matching) marker, which is left untouched rather than cleared.
 *
 * It also carries the KEIKO-0397 regression: `applyRevealRequest`'s safe-range clamp must never hand
 * Monaco's `setSelection`/`deltaDecorations` an inverted range (`endLineNumber < startLineNumber`)
 * for an out-of-range resolved location. KEIKO-0032/0033/0109's mount-wait-retry and read-only-gate
 * fixes (commit 77b01662, #3008) are already pinned at the component level in
 * KeikoCodeEditor.test.tsx; the tests here exercise the same invariants at the hook layer, through a
 * different, lighter double, rather than repeating those exact assertions.
 */
import "../../vitest.setup.js";

import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { editor } from "monaco-editor";

import type { EditorChangeOrigin, EditorHostEditRequest } from "../index.js";
import { createFileModel } from "../index.js";
import { useChangeHandler, useEditorHandlers, type EditorHandlers } from "./use-editor-handlers.js";
import { baseProps } from "./test-harness.js";
import type { EditorContentDelta, EditorRevealRequest, KeikoCodeEditorProps } from "./types.js";
import type { MountEditor, MountMonaco } from "./on-mount.js";

// `EditorHandlers["onMount"]` (not `OnMount` imported directly from `@monaco-editor/react`) so the
// mount-callback shape is derived from the hook's own public surface.
type OnMount = EditorHandlers["onMount"];

// A minimal Monaco content-change event; `useChangeHandler` only reads the emitted `value`.
const CHANGE_EVENT = {} as editor.IModelContentChangedEvent;

// Mirrors the production encoder's job (UTF-8 byte length) without restating a different formula;
// every string below is plain ASCII, so this is exact.
function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

interface FakeMonacoRange {
  readonly startLineNumber: number;
  readonly startColumn: number;
  readonly endLineNumber: number;
  readonly endColumn: number;
}

interface EditorHarness {
  readonly editor: MountEditor;
  readonly monaco: MountMonaco;
  readonly addActionCalls: () => number;
  readonly setSelectionCalls: () => readonly FakeMonacoRange[];
}

function buildFakeContainer(): HTMLElement {
  return {
    addEventListener: (): void => undefined,
    removeEventListener: (): void => undefined,
  } as unknown as HTMLElement;
}

// A lightweight `MountEditor`/`MountMonaco` double: only the methods the mount wiring calls
// unconditionally (save action, keydown backstop, reveal/selection) plus a bare `getModel` so the
// controlled-value-sync and host-edit-request effects terminate in one pass instead of polling
// forever. No `@monaco-editor/react` module mock — the hook's `onMount` callback is invoked directly.
function buildEditorHarness(): EditorHarness {
  let addActionCount = 0;
  const setSelectionCalls: FakeMonacoRange[] = [];
  const container = buildFakeContainer();
  const editor: MountEditor = {
    addAction: (): { dispose: () => void } => {
      addActionCount += 1;
      return { dispose: (): void => undefined };
    },
    getAction: (): null => null,
    onDidChangeCursorPosition: (): { dispose: () => void } => ({ dispose: (): void => undefined }),
    onDidChangeCursorSelection: (): { dispose: () => void } => ({ dispose: (): void => undefined }),
    focus: (): void => undefined,
    setSelection: (range): void => {
      setSelectionCalls.push(range);
    },
    setPosition: (): void => undefined,
    revealRangeInCenterIfOutsideViewport: (): void => undefined,
    deltaDecorations: (_old, next): string[] =>
      next.map((_entry, index) => `deco-${String(index)}`),
    getModel: (): {
      getValue: () => string;
      getLineCount: () => number;
      getLineMaxColumn: () => number;
    } => ({
      getValue: (): string => "",
      getLineCount: (): number => 1,
      getLineMaxColumn: (): number => 1,
    }),
    getContainerDomNode: (): HTMLElement => container,
    saveViewState: (): null => null,
    restoreViewState: (): void => undefined,
  };
  const monaco: MountMonaco = {
    editor: { defineTheme: (): void => undefined },
    KeyMod: { CtrlCmd: 2048, Alt: 512, Shift: 1024 },
    KeyCode: { KeyS: 49, KeyK: 41, KeyT: 53, F2: 60, F5: 62, F6: 63, F10: 67, F11: 68 },
  };
  return {
    editor,
    monaco,
    addActionCalls: (): number => addActionCount,
    setSelectionCalls: (): readonly FakeMonacoRange[] => setSelectionCalls,
  };
}

// `EditorHandlers.onMount` is typed against the REAL `@monaco-editor/react` `OnMount` signature
// (`editor.IStandaloneCodeEditor`), not the hook's own narrower `MountEditor` seam — a real `<Editor>`
// supplies that full instance. The lightweight harness intentionally implements only the subset the
// mount wiring calls, so it stands in for the full editor at this single, explicit boundary.
function mountWith(onMount: OnMount, harness: EditorHarness): void {
  onMount(harness.editor as unknown as Parameters<OnMount>[0], harness.monaco);
}

describe("useChangeHandler — consumeProgrammaticChange edge cases (KEIKO-0407)", () => {
  interface FakeProgrammaticChange {
    text: string;
    origin?: EditorChangeOrigin;
    suppress?: boolean;
  }
  function ref(value: FakeProgrammaticChange | null): { current: FakeProgrammaticChange | null } {
    return { current: value };
  }

  it("reports a human edit with no programmatic marker present", () => {
    const onContentChange = vi.fn<(delta: EditorContentDelta, origin: string) => void>();
    const { result } = renderHook(() => useChangeHandler(onContentChange, false, ref(null)));
    result.current("typed", CHANGE_EVENT);
    expect(onContentChange).toHaveBeenCalledWith(
      { text: "typed", sizeBytes: byteLength("typed") },
      "human",
    );
  });

  it("consumes a matching marker, applies its origin, and clears the ref", () => {
    const programmatic = ref({ text: "applied", origin: "applied-patch" });
    const onContentChange = vi.fn<(delta: EditorContentDelta, origin: string) => void>();
    const { result } = renderHook(() => useChangeHandler(onContentChange, false, programmatic));
    result.current("applied", CHANGE_EVENT);
    expect(onContentChange).toHaveBeenCalledWith(
      { text: "applied", sizeBytes: byteLength("applied") },
      "applied-patch",
    );
    expect(programmatic.current).toBeNull();
  });

  it("defaults to human origin when a matching marker carries no explicit origin", () => {
    const programmatic = ref({ text: "no-origin" });
    const onContentChange = vi.fn<(delta: EditorContentDelta, origin: string) => void>();
    const { result } = renderHook(() => useChangeHandler(onContentChange, false, programmatic));
    result.current("no-origin", CHANGE_EVENT);
    expect(onContentChange).toHaveBeenCalledWith(
      { text: "no-origin", sizeBytes: byteLength("no-origin") },
      "human",
    );
  });

  it("suppresses emission for a matching suppress marker but still clears the ref", () => {
    const programmatic = ref({ text: "synced", suppress: true });
    const onContentChange = vi.fn<(delta: EditorContentDelta, origin: string) => void>();
    const { result } = renderHook(() => useChangeHandler(onContentChange, false, programmatic));
    result.current("synced", CHANGE_EVENT);
    expect(onContentChange).not.toHaveBeenCalled();
    expect(programmatic.current).toBeNull();
  });

  it("leaves a stale (non-matching) marker untouched and reports the edit as human", () => {
    const programmatic = ref({ text: "stale", origin: "applied-patch" });
    const onContentChange = vi.fn<(delta: EditorContentDelta, origin: string) => void>();
    const { result } = renderHook(() => useChangeHandler(onContentChange, false, programmatic));
    result.current("interrupting edit", CHANGE_EVENT);
    expect(onContentChange).toHaveBeenCalledWith(
      { text: "interrupting edit", sizeBytes: byteLength("interrupting edit") },
      "human",
    );
    // A change to different text does not consume an unrelated stale marker.
    expect(programmatic.current).toEqual({ text: "stale", origin: "applied-patch" });
  });
});

describe("useEditorHandlers — host edit request (KEIKO-0032, KEIKO-0033)", () => {
  it("applies a host edit request that arrives before the editor has mounted", async () => {
    const onContentChange = vi.fn<(delta: EditorContentDelta, origin: string) => void>();
    const hostEditRequest: EditorHostEditRequest = {
      id: "host-1",
      text: "next content",
      origin: "applied-patch",
    };
    const { result } = renderHook(
      (props: KeikoCodeEditorProps) => useEditorHandlers(props, false),
      { initialProps: baseProps({ onContentChange, hostEditRequest }) },
    );

    // Not mounted yet: the request must not be dropped, but it cannot apply either.
    expect(onContentChange).not.toHaveBeenCalled();

    const harness = buildEditorHarness();
    mountWith(result.current.onMount, harness);

    // The mount-wait poll (a requestAnimationFrame loop, not a single retry) picks the request up
    // once the editor mounts.
    await waitFor(() => {
      expect(onContentChange).toHaveBeenCalledWith(
        { text: "next content", sizeBytes: byteLength("next content") },
        "applied-patch",
      );
    });
  });

  it("ignores a request under read-only and never retroactively re-applies the same id once writable", () => {
    const onContentChange = vi.fn<(delta: EditorContentDelta, origin: string) => void>();
    const onRuntimeError = vi.fn<(message: string) => void>();
    const hostEditRequest: EditorHostEditRequest = {
      id: "host-2",
      text: "blocked",
      origin: "human",
    };
    const { rerender } = renderHook(
      (props: { editorProps: KeikoCodeEditorProps; readOnly: boolean }) =>
        useEditorHandlers(props.editorProps, props.readOnly),
      {
        initialProps: {
          editorProps: baseProps({ onContentChange, onRuntimeError, hostEditRequest }),
          readOnly: true,
        },
      },
    );

    expect(onRuntimeError).toHaveBeenCalledWith("host edit request ignored: buffer is read-only");
    expect(onContentChange).not.toHaveBeenCalled();

    // Flip to writable with the SAME request id: already marked handled, so nothing re-applies.
    rerender({
      editorProps: baseProps({ onContentChange, onRuntimeError, hostEditRequest }),
      readOnly: false,
    });
    expect(onContentChange).not.toHaveBeenCalled();
    expect(onRuntimeError).toHaveBeenCalledTimes(1);
  });

  it("applies a genuinely new request once writable and mounted", () => {
    const onContentChange = vi.fn<(delta: EditorContentDelta, origin: string) => void>();
    const harness = buildEditorHarness();
    const { result, rerender } = renderHook(
      (props: KeikoCodeEditorProps) => useEditorHandlers(props, false),
      { initialProps: baseProps({ onContentChange }) },
    );
    mountWith(result.current.onMount, harness);

    const hostEditRequest: EditorHostEditRequest = {
      id: "host-3",
      text: "writable now",
      origin: "human",
    };
    rerender(baseProps({ onContentChange, hostEditRequest }));

    // Already mounted: the poll's first check succeeds synchronously, no animation frame needed.
    expect(onContentChange).toHaveBeenCalledWith(
      { text: "writable now", sizeBytes: byteLength("writable now") },
      "human",
    );
  });
});

describe("useEditorHandlers — runtimeWiringAvailabilityKey refresh gating", () => {
  it("does not refresh the mount wiring for a language-only fileModel swap, but does for an availability change", () => {
    const harness = buildEditorHarness();
    const initialFileModel = createFileModel({
      uri: "keiko://doc/a",
      language: "typescript",
      version: 1,
    });
    const { result, rerender } = renderHook(
      (props: KeikoCodeEditorProps) => useEditorHandlers(props, false),
      { initialProps: baseProps({ fileModel: initialFileModel }) },
    );
    mountWith(result.current.onMount, harness);
    expect(harness.addActionCalls()).toBe(1);

    // `runtimeWiringAvailabilityKey` never reads `fileModel.identity.language` — only the provider/
    // capability props and the derived large-file mode — so this swap must not re-run the wiring.
    const languageSwapped = {
      ...initialFileModel,
      identity: { ...initialFileModel.identity, language: "python" as const },
    };
    rerender(baseProps({ fileModel: languageSwapped }));
    expect(harness.addActionCalls()).toBe(1);

    // A genuine availability change (a provider resolver appearing) IS part of the key and must
    // trigger exactly one refresh.
    rerender(
      baseProps({
        fileModel: languageSwapped,
        provideHover: (query) =>
          Promise.resolve({ request: query.request.request, hover: { contents: null } }),
      }),
    );
    expect(harness.addActionCalls()).toBe(2);
  });
});

describe("useEditorHandlers — applyRevealRequest out-of-range clamp (KEIKO-0397)", () => {
  it("never hands Monaco an inverted range for a resolved location that clamps below line 1", () => {
    const harness = buildEditorHarness();
    const revealRequest: EditorRevealRequest = {
      id: "reveal-1",
      // start.line: -1 -> editorRangeToMonaco's +1 offset -> monacoRange.startLineNumber: 0, an
      // out-of-range location (e.g. from an untrusted definition/reference resolver).
      range: { start: { line: -1, column: 4 }, end: { line: -1, column: 9 } },
    };
    const { result } = renderHook(
      (props: KeikoCodeEditorProps) => useEditorHandlers(props, false),
      { initialProps: baseProps({ revealRequest }) },
    );

    mountWith(result.current.onMount, harness);

    const calls = harness.setSelectionCalls();
    expect(calls).toHaveLength(1);
    const selection = calls[0];
    if (selection === undefined) throw new Error("expected a captured setSelection call");
    expect(selection.startLineNumber).toBeGreaterThanOrEqual(1);
    expect(selection.endLineNumber).toBeGreaterThanOrEqual(selection.startLineNumber);
  });
});
