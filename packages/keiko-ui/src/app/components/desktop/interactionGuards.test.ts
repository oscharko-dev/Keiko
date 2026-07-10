import { afterEach, describe, expect, it } from "vitest";
import {
  acquireGrabbingBodyStyle,
  isCanvasPanPointer,
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
