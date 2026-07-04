// GEN-PERF-CHAT-012 — the conversation question-map wave must apply in two phases: read ALL button
// rects first, THEN write ALL --wave-width custom properties. Interleaving reads and writes forces a
// synchronous reflow per button because --wave-width drives a transitioned width. This test pins the
// read-before-write ordering (no read-after-write interleave) and the rAF coalescing of a pointer
// burst into a single layout pass.

import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConversationQuestionMap, type ConversationQuestionMapItem } from "./ChatWindow";

function items(count: number): ConversationQuestionMapItem[] {
  return Array.from({ length: count }, (_unused, i) => ({
    id: `q${String(i)}`,
    index: i + 1,
    preview: `Question ${String(i)}`,
    time: "12:00",
  }));
}

type LogEntry = { op: "read" } | { op: "write"; prop: string };

describe("ConversationQuestionMap — two-phase wave (GEN-PERF-CHAT-012)", () => {
  let log: LogEntry[];
  let rafCallbacks: FrameRequestCallback[];
  let realRaf: typeof globalThis.requestAnimationFrame;

  beforeEach(() => {
    log = [];
    rafCallbacks = [];
    realRaf = globalThis.requestAnimationFrame;

    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (
      this: Element,
    ): DOMRect {
      log.push({ op: "read" });
      // Distinct vertical positions so a nearest button exists.
      const y = Array.from(document.querySelectorAll("button")).indexOf(this as HTMLButtonElement);
      return {
        top: y * 30,
        bottom: y * 30 + 24,
        height: 24,
        left: 0,
        right: 100,
        width: 100,
        x: 0,
        y: y * 30,
        toJSON: () => ({}),
      } as DOMRect;
    });

    const realSetProperty = CSSStyleDeclaration.prototype.setProperty;
    vi.spyOn(CSSStyleDeclaration.prototype, "setProperty").mockImplementation(function (
      this: CSSStyleDeclaration,
      prop: string,
      value: string | null,
      priority?: string,
    ): void {
      log.push({ op: "write", prop });
      realSetProperty.call(this, prop, value, priority);
    });

    // Capture rAF callbacks so we can run exactly one frame deterministically.
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback): number => {
      rafCallbacks.push(cb);
      return rafCallbacks.length;
    });
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    globalThis.requestAnimationFrame = realRaf;
  });

  it("reads all rects before writing any --wave-width, coalescing a pointer burst to one frame", () => {
    const { container } = render(
      <ConversationQuestionMap items={items(6)} onJump={() => undefined} />,
    );
    const nav = container.querySelector("nav.chat-question-map");
    expect(nav).not.toBeNull();

    // The initial render writes each button's inline --wave-width default; ignore that by
    // clearing the log right before the pointer interaction.
    log = [];

    // A burst of pointer moves — must schedule at most ONE frame (last-event-wins).
    act(() => {
      for (let y = 0; y < 5; y += 1) {
        nav?.dispatchEvent(new MouseEvent("pointermove", { clientY: 40 + y, bubbles: true }));
      }
    });
    expect(rafCallbacks).toHaveLength(1);
    // No layout work happened yet (still buffered until the frame runs).
    expect(log).toHaveLength(0);

    // Run the single frame.
    act(() => {
      rafCallbacks[0]?.(performance.now());
    });

    // 6 buttons: 6 rect reads, then 6 --wave-width writes. Assert every read precedes every write.
    const waveWrites = log.filter((e) => e.op === "write" && e.prop === "--wave-width");
    const reads = log.filter((e) => e.op === "read");
    expect(reads.length).toBe(6);
    expect(waveWrites.length).toBe(6);

    const firstWriteIndex = log.findIndex((e) => e.op === "write" && e.prop === "--wave-width");
    const lastReadIndex = log.reduce((acc, e, i) => (e.op === "read" ? i : acc), -1);
    // No read occurs after the first --wave-width write — the two phases do not interleave.
    expect(lastReadIndex).toBeLessThan(firstWriteIndex);
  });
});
