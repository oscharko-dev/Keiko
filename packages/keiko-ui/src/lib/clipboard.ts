/**
 * Copies arbitrary text to the clipboard, preferring the async Clipboard API and
 * falling back to a hidden, off-screen `<textarea>` + `document.execCommand("copy")`
 * when `navigator.clipboard.writeText` is unavailable or throws (restricted or
 * insecure contexts still allow the selection-backed fallback).
 *
 * Consolidates four near-identical hand-rolled copy-with-fallback implementations
 * that previously lived in ChatWindow, FilePreview, PromptEnhancerPanel, and
 * SettingsPanel (AGENTS.md §5 — reuse/consolidate instead of a second copy).
 *
 * `document.execCommand("copy")` is deprecated (typescript:S1874), but there is no
 * non-deprecated browser API that performs a synchronous, DOM-selection-based
 * clipboard copy as a fallback for contexts where the async Clipboard API is
 * unavailable or denied — `execCommand` remains the only mechanism for that "last
 * resort" role, which is why it is kept here rather than removed.
 */
export interface CopyTextToClipboardOptions {
  /**
   * When true (the default), the element focused before the copy attempt is
   * explicitly refocused afterward, and the hidden textarea is explicitly focused
   * before `.select()`. Some call sites intentionally have no visible focus change
   * to restore; pass `false` to preserve that behavior exactly.
   */
  readonly restoreFocus?: boolean;
}

async function copyViaHiddenTextarea(text: string, restoreFocus: boolean): Promise<void> {
  const previousFocus =
    restoreFocus && document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.inset = "0 auto auto -9999px";
  textarea.style.width = "1px";
  textarea.style.height = "1px";
  textarea.style.opacity = "0";
  textarea.style.pointerEvents = "none";
  document.body.appendChild(textarea);
  try {
    if (restoreFocus) textarea.focus();
    textarea.select();
    const copied = typeof document.execCommand === "function" && document.execCommand("copy");
    if (!copied) throw new Error("clipboard-fallback-failed");
  } finally {
    textarea.remove();
    if (restoreFocus) previousFocus?.focus();
  }
}

export async function copyTextToClipboard(
  text: string,
  options?: CopyTextToClipboardOptions,
): Promise<void> {
  const restoreFocus = options?.restoreFocus ?? true;
  const writeText = typeof navigator === "undefined" ? undefined : navigator.clipboard?.writeText;
  if (writeText !== undefined && navigator.clipboard !== undefined) {
    try {
      await writeText.call(navigator.clipboard, text);
      return;
    } catch {
      // Fall through to the selection-backed copy path below (restricted clipboard contexts).
    }
  }

  if (typeof document === "undefined" || document.body === null) {
    throw new Error("clipboard-unavailable");
  }

  await copyViaHiddenTextarea(text, restoreFocus);
}
