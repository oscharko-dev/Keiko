/** The longest one-line summary `jira.discover` returns for an operation. */
export const OPERATION_SUMMARY_MAX_CHARS = 140;

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
  return `${(space > 40 ? cut.slice(0, space) : cut).replace(/[\s,;:(-]+$/u, "")}.`;
}
