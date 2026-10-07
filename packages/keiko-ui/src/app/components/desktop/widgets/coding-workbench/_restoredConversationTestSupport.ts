// Fixtures for the restored-run suites (#3876 review). A restored conversation is judged by where
// each of its messages is shown, so every message here carries a label at its start and at its end:
// a test can tell which message it is looking at, whether the whole text is shown or only a cut of
// it, and whether the same message is shown twice. Sizes are chosen by the callers from the safe
// activity contract's own constants; nothing here restates a bound.

/** A text of exactly `chars` ASCII characters whose first and last words name it. */
export function labelledText(label: string, chars: number): string {
  const head = `${label}-begin `;
  const tail = ` ${label}-end`;
  const filler = chars - head.length - tail.length;
  if (filler < 0) throw new RangeError(`a ${String(chars)}-character text cannot carry ${label}`);
  return `${head}${"x".repeat(filler)}${tail}`;
}

/** How many times the message labelled `label` starts in `shown`. */
export function startsShown(shown: string | null | undefined, label: string): number {
  return (shown ?? "").split(`${label}-begin`).length - 1;
}

/** Whether the message labelled `label` is shown to its end, not cut. */
export function endShown(shown: string | null | undefined, label: string): boolean {
  return (shown ?? "").includes(`${label}-end`);
}

/** The label of the `index`-th message of a conversation that alternates prompts and answers. */
export function conversationLabel(index: number): string {
  return `${index % 2 === 0 ? "P" : "A"}${String(Math.floor(index / 2) + 1)}`;
}

/**
 * The largest integer in `[low, high]` for which `holds` is true, given that it holds up to some
 * value and not beyond it. Finds where production draws a bound without restating the bound: the
 * caller asks the production entry point and only searches for the line.
 */
export function largestHolding(
  low: number,
  high: number,
  holds: (value: number) => boolean,
): number {
  let fits = low;
  let overflows = high + 1;
  while (overflows - fits > 1) {
    const middle = Math.floor((fits + overflows) / 2);
    if (holds(middle)) fits = middle;
    else overflows = middle;
  }
  return fits;
}
