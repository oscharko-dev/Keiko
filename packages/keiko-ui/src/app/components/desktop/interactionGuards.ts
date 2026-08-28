function isPrimaryPointerButton(button: number): boolean {
  return button === 0;
}

function isMiddlePointerButton(button: number): boolean {
  return button === 1;
}

function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mac|iPhone|iPad|iPod/i.test(navigator.platform || "");
}

// Issue #2150 — Ctrl+left-click is the macOS convention for a secondary/context
// click, but on Windows and Linux it is the OS-standard "toggle selection"
// modifier. Without the platform check, isPrimaryActivationPointer rejected
// Ctrl+left-click as a canvas-pan/marquee activation on EVERY platform, so the
// marquee's Ctrl-drag "toggle" mode (see marqueeMode in Workspace.tsx) could
// never start via mouse on Windows.
export function isMacContextClick(event: {
  readonly button: number;
  readonly ctrlKey: boolean;
}): boolean {
  return isMacPlatform() && event.button === 0 && event.ctrlKey;
}

export function isPrimaryActivationPointer(event: {
  readonly button: number;
  readonly ctrlKey: boolean;
}): boolean {
  return isPrimaryPointerButton(event.button) && !isMacContextClick(event);
}

export function isCanvasPanPointer(event: {
  readonly button: number;
  readonly ctrlKey: boolean;
}): boolean {
  return isPrimaryActivationPointer(event) || isMiddlePointerButton(event.button);
}

export function isWindowDragPointer(event: {
  readonly button: number;
  readonly ctrlKey: boolean;
}): boolean {
  return isPrimaryActivationPointer(event) || isMiddlePointerButton(event.button);
}

// Review finding on #3305 — the native text-input surface (input/textarea/select/
// contenteditable) that every guard below needs to recognize, extracted to one
// place so a future addition (or removal) cannot update some guards and miss
// others. Order does not affect matching: Element.closest()'s selector list is a
// set, not a sequence, so composing this into a longer selector list below is
// behavior-preserving regardless of where in that list it lands.
const TEXT_INPUT_SELECTORS: readonly string[] = [
  "input",
  "textarea",
  "select",
  "[contenteditable='true']",
  "[contenteditable='']",
];

export function isInteractiveSurfaceTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return (
    target.closest(
      [
        "button",
        ...TEXT_INPUT_SELECTORS,
        "a[href]",
        "summary",
        "[role='button']",
        "[role='checkbox']",
        "[role='dialog']",
        "[role='link']",
        "[role='menuitem']",
        "[role='option']",
        "[role='radio']",
        "[role='switch']",
        "[role='tab']",
        "[data-text-selectable='true']",
        ".dlg-overlay",
        ".mc-dialog-backdrop",
        ".cmdk-overlay",
        ".window",
        ".ws-zoom",
        ".ws-fab",
        ".empty-workspace-blob",
        ".conn-badge",
      ].join(","),
    ) !== null
  );
}

export function isInteractiveControlTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return (
    target.closest(
      [
        "button",
        ...TEXT_INPUT_SELECTORS,
        "a[href]",
        "summary",
        "[role='button']",
        "[role='checkbox']",
        "[role='link']",
        "[role='menuitem']",
        "[role='option']",
        "[role='radio']",
        "[role='switch']",
        "[role='tab']",
        "[data-text-selectable='true']",
      ].join(","),
    ) !== null
  );
}

export function isTextEntryTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return (
    target.closest([...TEXT_INPUT_SELECTORS, "[data-text-selectable='true']"].join(",")) !== null
  );
}

// Issue #2710 — a control that CONSUMES typed input (and where Escape has its
// own local meaning: dismiss, revert, blur). Deliberately narrower than
// isTextEntryTarget, which also treats a read-only `data-text-selectable`
// surface as text entry: a file preview or diff pane accepts no keystrokes, so
// Escape there must still reach the workspace and clear the window selection
// (ADR-0123 D6 requires selection commands to be keyboard reachable).
export function isTextInputTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return target.closest(TEXT_INPUT_SELECTORS.join(",")) !== null;
}

// ADR-0123 D6 / issue #2710 — surfaces whose clipboard behavior the workspace
// window copy/cut/paste commands must never intercept. D6 names editors,
// terminals, text inputs, file trees, diff viewers, and embedded widgets:
// editors/terminals focus their own textarea/contenteditable and diff viewers
// carry data-text-selectable (both covered by the text-entry selector), so the
// tree roles are the one class the narrower isTextEntryTarget guard missed.
export function isEmbeddedClipboardSurfaceTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return (
    target.closest(
      [
        ...TEXT_INPUT_SELECTORS,
        "[data-text-selectable='true']",
        "[role='tree']",
        "[role='treeitem']",
      ].join(","),
    ) !== null
  );
}

// Issue #2710 — a live, non-collapsed DOM text selection means the user is
// copying text they selected (chat bubbles, markdown, file preview, diff
// lines); the workspace window-clipboard must yield so the native copy/cut
// reaches the OS clipboard.
export function hasActiveTextSelection(): boolean {
  if (typeof window === "undefined") return false;
  const selection = window.getSelection();
  return selection !== null && !selection.isCollapsed && selection.toString().length > 0;
}

export function isHandToolKeyIgnoredTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return (
    target.closest(
      [
        "input",
        "textarea",
        "select",
        "button",
        "a[href]",
        "summary",
        "[contenteditable='true']",
        "[contenteditable='']",
        "[role='button']",
        "[role='checkbox']",
        "[role='dialog']",
        "[role='link']",
        "[role='menuitem']",
        "[role='option']",
        "[role='radio']",
        "[role='switch']",
        "[role='tab']",
        "[data-text-selectable='true']",
      ].join(","),
    ) !== null
  );
}

export function workspaceInteractionLocked(): boolean {
  if (typeof document === "undefined") return false;
  return document.documentElement.dataset.keikoModalOpen === "true";
}

// Ref-counted body cursor/userSelect override shared by every drag/pan gesture (window drag, canvas
// pan, resize-by-pan). Concurrent gestures (e.g. a multitouch pan while a window is mid-drag) would
// otherwise each snapshot the OTHER gesture's "grabbing" value as "previous" and, on release,
// restore "grabbing" instead of the real original — leaving the cursor and text-selection stuck.
// Only the first acquire snapshots and applies the override; only the last release restores it.
let gestureBodyStyleDepth = 0;
let savedBodyCursor = "";
let savedBodyUserSelect = "";

export function acquireGrabbingBodyStyle(): () => void {
  if (typeof document === "undefined") return () => undefined;
  const body = document.body;
  if (gestureBodyStyleDepth === 0) {
    savedBodyCursor = body.style.cursor;
    savedBodyUserSelect = body.style.userSelect;
    body.style.cursor = "grabbing";
    body.style.userSelect = "none";
  }
  gestureBodyStyleDepth += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    gestureBodyStyleDepth = Math.max(0, gestureBodyStyleDepth - 1);
    if (gestureBodyStyleDepth === 0) {
      body.style.cursor = savedBodyCursor;
      body.style.userSelect = savedBodyUserSelect;
    }
  };
}
