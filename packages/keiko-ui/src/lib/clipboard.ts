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
   * When true (the default), the element focused before the copy attempt is saved and
   * explicitly refocused afterward. The hidden textarea is always focused before
   * `.select()` regardless of this option — `execCommand("copy")` needs the textarea to
   * actually hold focus, not merely a `Selection` range, to copy reliably across
   * browsers. Some call sites intentionally have no visible focus change to restore;
   * pass `false` to skip only the save/restore step.
   */
  readonly restoreFocus?: boolean;
}

async function copyViaHiddenTextarea(
  text: string,
  restoreFocus: boolean,
  writeTextFailure: unknown,
): Promise<void> {
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
    textarea.focus();
    textarea.select();
    const copied = typeof document.execCommand === "function" && document.execCommand("copy");
    if (!copied) {
      throw new Error("clipboard-fallback-failed", { cause: writeTextFailure });
    }
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
  let writeTextFailure: unknown;
  if (writeText !== undefined && navigator.clipboard !== undefined) {
    try {
      await writeText.call(navigator.clipboard, text);
      return;
    } catch (caught) {
      // Restricted/insecure clipboard contexts routinely reject the async API; fall
      // through to the selection-backed copy below, but keep the reason in case that
      // fallback fails too (`copyViaHiddenTextarea` attaches it as `cause`).
      writeTextFailure = caught;
    }
  }

  if (typeof document === "undefined" || document.body === null) {
    throw new Error("clipboard-unavailable", { cause: writeTextFailure });
  }

  await copyViaHiddenTextarea(text, restoreFocus, writeTextFailure);
}
