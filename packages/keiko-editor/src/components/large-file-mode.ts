/**
 * Large-file render mode for the Keiko editor (Issue #1207, ADR-0042 D3.6).
 *
 * ADR-0042 D3.6 mandates that files **> 500 KB or > 10,000 lines enter read-only/degraded mode**,
 * while files **> 1,000,000 bytes** use the existing server too-large path (a `413` rejection) and
 * never instantiate Monaco. This pure helper derives the *degraded* threshold band — the part the
 * editor owns — from the controlled buffer content; the hard 1 MB boundary is enforced server-side
 * (`packages/keiko-server/src/files.ts`) and surfaced as a load error, and the editor's own
 * read-only/over-limit band is owned by {@link import("./save-state.js").isMaxSizeExceeded}.
 *
 * In degraded mode the editor disables the per-render/per-keystroke-expensive Monaco features
 * (bracket-pair colorization, folding, occurrence highlighting, whitespace rendering) and turns on
 * Monaco's `largeFileOptimizations`, keeping per-keystroke main-thread work within the typing budget
 * (< 50 ms; ADR-0042 D3.6) on large but still-editable buffers. It is computed with a bounded,
 * early-exiting line scan so the derivation itself never dominates a keystroke.
 *
 * Pure and import-side-effect-free (no Monaco, no DOM), so it is node-testable.
 */

/** The editor render mode for the current buffer size. */
export type EditorLargeFileMode = "normal" | "degraded";

/** Byte threshold above which the editor enters degraded mode (ADR-0042 D3.6: > 500 KB). */
export const LARGE_FILE_DEGRADED_BYTES = 500_000;

/** Line threshold above which the editor enters degraded mode (ADR-0042 D3.6: > 10,000 lines). */
export const LARGE_FILE_DEGRADED_LINES = 10_000;

/** The minimal content shape the mode derivation reads (a slice of `EditorFileContent`). */
export interface LargeFileModeInput {
  readonly sizeBytes: number;
  readonly text: string;
}

/**
 * True when `text` contains strictly more than `maxLines` lines. Counts newlines with an early exit
 * the moment the threshold is crossed, so the scan is bounded by `maxLines` newlines rather than the
 * whole buffer — the common (small-file) case returns after one cheap pass and a large file bails out
 * as soon as it is provably over the line budget.
 */
export function exceedsLineCount(text: string, maxLines: number): boolean {
  // `maxLines` lines are separated by `maxLines - 1` newlines; the (maxLines)-th newline starts the
  // (maxLines + 1)-th line, which is the first line over budget.
  let newlines = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10 /* \n */) {
      newlines += 1;
      if (newlines >= maxLines) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Derive the editor render mode for the current buffer. A buffer over the byte threshold is degraded
 * immediately (no line scan needed); otherwise a bounded line scan decides. The byte check first
 * means the line scan only ever runs on buffers already known to be ≤ 500 KB.
 */
export function deriveLargeFileMode(content: LargeFileModeInput): EditorLargeFileMode {
  if (content.sizeBytes > LARGE_FILE_DEGRADED_BYTES) {
    return "degraded";
  }
  return exceedsLineCount(content.text, LARGE_FILE_DEGRADED_LINES) ? "degraded" : "normal";
}

/** Convenience predicate: whether the buffer is in degraded mode. */
export function isLargeFileDegraded(content: LargeFileModeInput): boolean {
  return deriveLargeFileMode(content) === "degraded";
}
