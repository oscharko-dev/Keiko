// @vitest-environment jsdom
/**
 * Per-keystroke allocation regression for the controlled-editor change handler
 * (GEN-PERF-EDITOR-005).
 *
 * The `onChange` handler runs on EVERY keystroke and must compute the UTF-8 `sizeBytes` for the
 * emitted {@link EditorContentDelta}. Computing the byte length requires exactly one
 * `TextEncoder.encode` call, but the previous implementation additionally constructed a fresh
 * `new TextEncoder()` on every change — a throwaway allocation on the hottest editor path. This
 * suite pins that the handler:
 *   1. reuses a single module-scope encoder (zero `new TextEncoder()` constructions per keystroke),
 *   2. still emits the correct UTF-8 byte length (multi-byte characters counted, not UTF-16 units),
 *   3. does not encode at all when the change is ignored (read-only / undefined value).
 *
 * The mechanism (construction count / encode call count) is asserted directly, so the proof does
 * not depend on wall-clock timing.
 */
import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { editor } from "monaco-editor";

import { useChangeHandler } from "./use-editor-handlers.js";
import type { EditorContentDelta } from "./types.js";

// A minimal Monaco content-change event; the handler only reads `value`, never the event.
const CHANGE_EVENT = {} as editor.IModelContentChangedEvent;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useChangeHandler — per-keystroke allocation (GEN-PERF-EDITOR-005)", () => {
  it("never constructs a fresh TextEncoder per change (reuses the module-scope encoder)", () => {
    const realEncoder = new TextEncoder();
    const ctorSpy = vi.fn();
    // Wrap the global so every `new TextEncoder()` inside the handler would be counted. The
    // module-scope encoder is created at import time (before this spy is installed), so a
    // correct handler triggers ZERO constructions across many keystrokes.
    const OriginalTextEncoder = globalThis.TextEncoder;
    class CountingTextEncoder {
      constructor() {
        ctorSpy();
      }
      encode(input: string): Uint8Array {
        return realEncoder.encode(input);
      }
    }
    globalThis.TextEncoder = CountingTextEncoder as unknown as typeof TextEncoder;
    try {
      const onContentChange = vi.fn<(delta: EditorContentDelta, origin: string) => void>();
      const { result } = renderHook(() => useChangeHandler(onContentChange, false));

      for (let index = 0; index < 50; index += 1) {
        result.current(`edit ${String(index)}`, CHANGE_EVENT);
      }

      expect(onContentChange).toHaveBeenCalledTimes(50);
      // The load-bearing assertion: no per-keystroke encoder allocation.
      expect(ctorSpy).not.toHaveBeenCalled();
    } finally {
      globalThis.TextEncoder = OriginalTextEncoder;
    }
  });

  it("emits the correct UTF-8 byte length (multi-byte counted, not UTF-16 units)", () => {
    const onContentChange = vi.fn<(delta: EditorContentDelta, origin: string) => void>();
    const { result } = renderHook(() => useChangeHandler(onContentChange, false));

    // "über" + an emoji: 'ü' is 2 UTF-8 bytes, the emoji is 4 bytes, so the byte count exceeds the
    // string length. This guards against a regression to `value.length`.
    const text = "über😀";
    result.current(text, CHANGE_EVENT);

    expect(onContentChange).toHaveBeenCalledTimes(1);
    const [delta, origin] = onContentChange.mock.calls[0] as [EditorContentDelta, string];
    expect(origin).toBe("human");
    expect(delta.text).toBe(text);
    expect(delta.sizeBytes).toBe(new TextEncoder().encode(text).length);
    expect(delta.sizeBytes).toBeGreaterThan(text.length);
  });

  it("does not emit or encode when the editor is read-only or the value is undefined", () => {
    const realEncoder = new TextEncoder();
    const encodeSpy = vi.spyOn(TextEncoder.prototype, "encode").mockImplementation(function (
      this: TextEncoder,
      input?: string,
    ) {
      return realEncoder.encode(input ?? "");
    });

    const onContentChange = vi.fn<(delta: EditorContentDelta, origin: string) => void>();

    const readOnly = renderHook(() => useChangeHandler(onContentChange, true));
    readOnly.result.current("blocked edit", CHANGE_EVENT);

    const writable = renderHook(() => useChangeHandler(onContentChange, false));
    writable.result.current(undefined, CHANGE_EVENT);

    expect(onContentChange).not.toHaveBeenCalled();
    // A short-circuited change must not touch the encoder at all.
    expect(encodeSpy).not.toHaveBeenCalled();
  });
});
