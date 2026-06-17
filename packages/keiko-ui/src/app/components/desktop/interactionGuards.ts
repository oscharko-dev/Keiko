export function isPrimaryPointerButton(button: number): boolean {
  return button === 0;
}

export function isMiddlePointerButton(button: number): boolean {
  return button === 1;
}

export function isSecondaryPointerButton(button: number): boolean {
  return button === 2;
}

export function isMacContextClick(event: {
  readonly button: number;
  readonly ctrlKey: boolean;
}): boolean {
  return event.button === 0 && event.ctrlKey;
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
  return isCanvasPanPointer(event);
}

export function isInteractiveSurfaceTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return (
    target.closest(
      [
        "button",
        "input",
        "textarea",
        "select",
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
        ".dlg-overlay",
        ".mc-dialog-backdrop",
        ".cmdk-overlay",
        ".window",
        ".ws-zoom",
        ".ws-fab",
        ".empty-workspace-blob",
        ".ws-outline",
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
        "input",
        "textarea",
        "select",
        "a[href]",
        "summary",
        "[contenteditable='true']",
        "[contenteditable='']",
        "[role='button']",
        "[role='checkbox']",
        "[role='link']",
        "[role='menuitem']",
        "[role='option']",
        "[role='radio']",
        "[role='switch']",
        "[role='tab']",
      ].join(","),
    ) !== null
  );
}

export function isTextEntryTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return (
    target.closest("input, textarea, select, [contenteditable='true'], [contenteditable='']") !==
    null
  );
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
      ].join(","),
    ) !== null
  );
}

export function workspaceInteractionLocked(): boolean {
  if (typeof document === "undefined") return false;
  return document.documentElement.getAttribute("data-keiko-modal-open") === "true";
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
