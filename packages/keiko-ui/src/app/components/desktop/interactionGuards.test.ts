import { afterEach, describe, expect, it } from "vitest";
import {
  acquireGrabbingBodyStyle,
  hasActiveTextSelection,
  isCanvasPanPointer,
  isEmbeddedClipboardSurfaceTarget,
  isInteractiveControlTarget,
  isInteractiveSurfaceTarget,
  isTextEntryTarget,
  isMacContextClick,
  isPrimaryActivationPointer,
  isWindowDragPointer,
} from "./interactionGuards";

const originalPlatform = window.navigator.platform;

function stubPlatform(platform: string): void {
  Object.defineProperty(window.navigator, "platform", {
    value: platform,
    configurable: true,
  });
}

afterEach(() => {
  document.body.style.cursor = "";
  document.body.style.userSelect = "";
  stubPlatform(originalPlatform);
});

describe("pointer guards", () => {
  it("treats a primary click as activation but a macOS ctrl+click as a context click, not a pan", () => {
    stubPlatform("MacIntel");
    expect(isPrimaryActivationPointer({ button: 0, ctrlKey: false })).toBe(true);
    expect(isMacContextClick({ button: 0, ctrlKey: true })).toBe(true);
    expect(isPrimaryActivationPointer({ button: 0, ctrlKey: true })).toBe(false);
    expect(isCanvasPanPointer({ button: 0, ctrlKey: true })).toBe(false);
    // The middle button always pans, regardless of ctrl.
    expect(isCanvasPanPointer({ button: 1, ctrlKey: true })).toBe(true);
    // The secondary (right) button never pans.
    expect(isCanvasPanPointer({ button: 2, ctrlKey: false })).toBe(false);
  });

  it("issue #2150 — on Windows/Linux, ctrl+left-click is NOT a mac context click, so it still activates the canvas (marquee toggle-select modifier)", () => {
    stubPlatform("Win32");
    expect(isMacContextClick({ button: 0, ctrlKey: true })).toBe(false);
    expect(isPrimaryActivationPointer({ button: 0, ctrlKey: true })).toBe(true);
    expect(isCanvasPanPointer({ button: 0, ctrlKey: true })).toBe(true);
  });

  it("allows window header dragging with the primary and middle mouse buttons", () => {
    stubPlatform("MacIntel");
    expect(isWindowDragPointer({ button: 0, ctrlKey: false })).toBe(true);
    // On macOS, ctrl+left-click is the context-click convention, so it must not start a drag.
    expect(isWindowDragPointer({ button: 0, ctrlKey: true })).toBe(false);
    expect(isWindowDragPointer({ button: 1, ctrlKey: false })).toBe(true);
    expect(isWindowDragPointer({ button: 2, ctrlKey: false })).toBe(false);
  });

  it("issue #2150 — on Windows/Linux, ctrl+left-click still drags the window header (no mac context-click reinterpretation)", () => {
    stubPlatform("Win32");
    expect(isWindowDragPointer({ button: 0, ctrlKey: true })).toBe(true);
  });

  it("treats explicitly selectable text surfaces as interactive text targets", () => {
    const host = document.createElement("div");
    host.innerHTML = '<pre data-text-selectable="true">Rendered prompt text</pre>';
    const target = host.querySelector("pre");
    expect(isInteractiveSurfaceTarget(target)).toBe(true);
    expect(isInteractiveControlTarget(target)).toBe(true);
    expect(isTextEntryTarget(target)).toBe(true);
  });
});

describe("embedded clipboard surface guard (issue #2710 / ADR-0123 D6)", () => {
  it("covers text-entry controls, selectable text surfaces, and file trees", () => {
    const host = document.createElement("div");
    host.innerHTML = [
      "<input />",
      '<pre data-text-selectable="true">diff text</pre>',
      '<ul role="tree"><li role="treeitem"><span class="label">src</span></li></ul>',
      "<p>plain window text</p>",
    ].join("");

    expect(isEmbeddedClipboardSurfaceTarget(host.querySelector("input"))).toBe(true);
    expect(isEmbeddedClipboardSurfaceTarget(host.querySelector("pre"))).toBe(true);
    // A descendant of a tree item (the click/focus target in the Files tree).
    expect(isEmbeddedClipboardSurfaceTarget(host.querySelector(".label"))).toBe(true);
    expect(isEmbeddedClipboardSurfaceTarget(host.querySelector("p"))).toBe(false);
    expect(isEmbeddedClipboardSurfaceTarget(null)).toBe(false);
  });
});

describe("hasActiveTextSelection (issue #2710)", () => {
  afterEach(() => {
    window.getSelection()?.removeAllRanges();
  });

  it("reports a live, non-collapsed selection and ignores a collapsed caret", () => {
    const host = document.createElement("p");
    host.textContent = "selectable message text";
    document.body.appendChild(host);
    try {
      expect(hasActiveTextSelection()).toBe(false);

      const range = document.createRange();
      range.selectNodeContents(host);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      expect(hasActiveTextSelection()).toBe(true);

      selection?.collapseToStart();
      expect(hasActiveTextSelection()).toBe(false);
    } finally {
      host.remove();
    }
  });
});

describe("acquireGrabbingBodyStyle", () => {
  it("applies the grabbing override once and restores the ORIGINAL on the last release", () => {
    document.body.style.cursor = "auto";
    document.body.style.userSelect = "text";

    const release = acquireGrabbingBodyStyle();
    expect(document.body.style.cursor).toBe("grabbing");
    expect(document.body.style.userSelect).toBe("none");

    release();
    expect(document.body.style.cursor).toBe("auto");
    expect(document.body.style.userSelect).toBe("text");
  });

  it("ref-counts concurrent gestures so the original is restored only after the LAST release", () => {
    document.body.style.cursor = "auto";

    const releaseA = acquireGrabbingBodyStyle();
    const releaseB = acquireGrabbingBodyStyle();
    expect(document.body.style.cursor).toBe("grabbing");

    // First release must NOT restore — a second gesture is still active. This is the bug the
    // ref-count fixes: independent snapshots would restore "grabbing" (the other gesture's value).
    releaseA();
    expect(document.body.style.cursor).toBe("grabbing");

    releaseB();
    expect(document.body.style.cursor).toBe("auto");
  });

  it("is idempotent per handle — a double release does not underflow the depth", () => {
    document.body.style.cursor = "auto";
    const releaseA = acquireGrabbingBodyStyle();
    const releaseB = acquireGrabbingBodyStyle();

    releaseA();
    releaseA(); // double release of the same handle must be a no-op
    expect(document.body.style.cursor).toBe("grabbing");

    releaseB();
    expect(document.body.style.cursor).toBe("auto");
  });
});
