import { afterEach, describe, expect, it } from "vitest";
import {
  acquireGrabbingBodyStyle,
  hasActiveTextSelection,
  isCanvasPanPointer,
  isEmbeddedClipboardSurfaceTarget,
  isInteractiveControlTarget,
  isInteractiveSurfaceTarget,
  isTextEntryTarget,
  isTextInputTarget,
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

  // Reviewer finding on PR #3305 — both guards explicitly type their parameter as
  // `EventTarget | null`, not `Element | null`, and guard with `instanceof Element` rather than
  // assuming every EventTarget is one. Every case above (and every case for isTextInputTarget
  // anywhere in this file) passes an Element or `null`, so none of them exercises that branch —
  // a `Text` node (a real EventTarget: selection/copy events fire with one) and `document` itself
  // (the target of a document-level listener) are both non-Element EventTargets in real usage.
  it("returns false for a Text node and for document — neither is an Element", () => {
    const textNode = document.createTextNode("plain text");

    expect(isEmbeddedClipboardSurfaceTarget(textNode)).toBe(false);
    expect(isEmbeddedClipboardSurfaceTarget(document)).toBe(false);
    expect(isTextInputTarget(textNode)).toBe(false);
    expect(isTextInputTarget(document)).toBe(false);
  });
});

// Review finding on #3305 — isTextInputTarget, isEmbeddedClipboardSurfaceTarget,
// isTextEntryTarget, isInteractiveSurfaceTarget and isInteractiveControlTarget all
// compose the same five text-input selectors from one shared module constant.
// Pins the composition rather than the constant's private name: every one of
// those guards must keep matching every native text-input surface, so a future
// edit that narrows the shared base (or a guard that stops composing from it)
// fails here instead of silently diverging.
describe("shared text-input selector composition (review finding on #3305)", () => {
  const textInputSamples: ReadonlyArray<{ readonly label: string; readonly build: () => Element }> =
    [
      { label: "input", build: () => document.createElement("input") },
      { label: "textarea", build: () => document.createElement("textarea") },
      { label: "select", build: () => document.createElement("select") },
      {
        label: "[contenteditable='true']",
        build: (): Element => {
          const el = document.createElement("div");
          el.setAttribute("contenteditable", "true");
          return el;
        },
      },
      {
        label: "[contenteditable='']",
        build: (): Element => {
          const el = document.createElement("div");
          el.setAttribute("contenteditable", "");
          return el;
        },
      },
    ];

  const composingGuards: ReadonlyArray<{
    readonly name: string;
    readonly guard: (target: EventTarget | null) => boolean;
  }> = [
    { name: "isTextInputTarget", guard: isTextInputTarget },
    { name: "isEmbeddedClipboardSurfaceTarget", guard: isEmbeddedClipboardSurfaceTarget },
    { name: "isTextEntryTarget", guard: isTextEntryTarget },
    { name: "isInteractiveSurfaceTarget", guard: isInteractiveSurfaceTarget },
    { name: "isInteractiveControlTarget", guard: isInteractiveControlTarget },
  ];

  it.each(composingGuards)("$name matches every shared text-input selector", ({ guard }) => {
    for (const sample of textInputSamples) {
      expect(guard(sample.build())).toBe(true);
    }
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
