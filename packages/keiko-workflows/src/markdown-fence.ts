// Shared Markdown code-fence rules for the workflows' model-output parsers (bug investigation and
// unit tests). Plain character scans, no regex, so hostile model output cannot backtrack.
//
// A fence opens with a run of at least three backticks. It closes only on a line that is nothing
// but a run of backticks at least as long as the opener. A diff context line such as " ```bash"
// therefore stays part of the diff body, and a four-backtick fence can wrap a diff that itself
// contains three-backtick lines.

const MIN_FENCE = 3;

function backtickRun(text: string): number {
  let count = 0;
  while (text.charAt(count) === "`") count += 1;
  return count;
}

/** Length of the backtick run that opens a fence on `line`, or 0 when the line is not a fence. */
export function openingFenceLength(line: string): number {
  const run = backtickRun(line.trimStart());
  return run >= MIN_FENCE ? run : 0;
}

function isClosingFence(line: string, openLength: number): boolean {
  const trimmed = line.trim();
  return trimmed.length >= openLength && backtickRun(trimmed) === trimmed.length;
}

/** Index of the line that closes the fence opened at `openIndex`, or undefined when it never closes. */
export function closingFenceIndex(lines: readonly string[], openIndex: number): number | undefined {
  const openLength = openingFenceLength(lines[openIndex] ?? "");
  for (let index = openIndex + 1; index < lines.length; index += 1) {
    if (isClosingFence(lines[index] ?? "", openLength)) return index;
  }
  return undefined;
}
