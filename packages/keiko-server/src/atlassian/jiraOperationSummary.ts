/** The longest one-line summary `jira.discover` returns for an operation. */
export const OPERATION_SUMMARY_MAX_CHARS = 140;

const TRAILING_PUNCTUATION = " ,;:(-";

/** A loop, not a pattern: a trailing-class regular expression backtracks super-linearly (S8786). */
function trimTrailingPunctuation(text: string): string {
  let end = text.length;
  while (end > 0 && TRAILING_PUNCTUATION.includes(text.charAt(end - 1))) end -= 1;
  return text.slice(0, end);
}

/**
 * One plain sentence of a Jira operation's descriptor description: its first sentence, whitespace
 * collapsed, cut at a word boundary when longer than one line. `jira.discover` ranks and returns it,
 * and `scripts/generate-jira-operation-summaries.mjs` builds its table from it (#4357).
 */
export function plainOperationSummary(description: string): string {
  const flat = description.replace(/\s+/gu, " ").trim();
  const sentence = /^(.*?[.!?])(?:\s|$)/u.exec(flat)?.[1] ?? flat;
  if (sentence.length <= OPERATION_SUMMARY_MAX_CHARS) return sentence;
  const cut = sentence.slice(0, OPERATION_SUMMARY_MAX_CHARS - 1);
  const space = cut.lastIndexOf(" ");
  return `${trimTrailingPunctuation(space > 40 ? cut.slice(0, space) : cut)}.`;
}
