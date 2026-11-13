/**
 * Jira text as a person reads it. A model often writes a description or comment in Jira's wiki
 * markup (`h2. Goal`, `*bold*`, `{code}` fences, `||table||` rows); shown verbatim it reads as raw
 * markup (#4355). This is a display projection only: it never changes what is sent to Jira, and a
 * text without wiki markup comes back unchanged.
 */

const HEADING = /^h[1-6]\.\s+/u;
const BULLET = /^(\*+)\s+(?=\S)/u;
const RULE = /^-{4,}\s*$/u;
const MACRO_LINE = /^\s*\{(?:code|noformat|quote|panel|toc|anchor)(?::[^}\n]*)?\}\s*$/u;
const TABLE_ROW = /^\|\|?.*\|\s*$/u;
const COLOR_MACRO = /\{color(?::[^}\n]*)?\}/gu;
const MONOSPACE = /\{\{([^{}\n]+)\}\}/gu;
const BOLD = /(?<![*\w])\*(?!\s)([^*\n]+?)(?<!\s)\*(?![*\w])/gu;
const ITALIC = /(?<![_\w])_(?!\s)([^_\n]+?)(?<!\s)_(?![_\w])/gu;
const CITATION = /\?\?(?!\s)([^?\n]+?)(?<!\s)\?\?/gu;
const LABELLED_LINK = /\[([^|\]\n]+)\|([^\]\n]+)\]/gu;
const BARE_LINK = /\[((?:https?:\/\/)[^\]\s|]+)\]/gu;

function inline(line: string): string {
  return line
    .replaceAll(COLOR_MACRO, "")
    .replaceAll(MONOSPACE, "$1")
    .replaceAll(LABELLED_LINK, "$1 ($2)")
    .replaceAll(BARE_LINK, "$1")
    .replaceAll(BOLD, "$1")
    .replaceAll(ITALIC, "$1")
    .replaceAll(CITATION, "$1");
}

function tableRow(line: string): string {
  return line
    .split("|")
    .map((cell) => cell.trim())
    .filter((cell) => cell.length > 0)
    .join(" · ");
}

function readableLine(line: string): string | undefined {
  if (MACRO_LINE.test(line) || RULE.test(line)) return undefined;
  if (HEADING.test(line)) return inline(line.replace(HEADING, ""));
  if (TABLE_ROW.test(line)) return inline(tableRow(line));
  const bullet = BULLET.exec(line);
  if (bullet === null) return inline(line);
  const depth = (bullet[1] ?? "*").length - 1;
  return `${"  ".repeat(depth)}• ${inline(line.slice(bullet[0].length))}`;
}

export function jiraReadableText(text: string): string {
  return text
    .split("\n")
    .flatMap((line) => {
      const readable = readableLine(line);
      return readable === undefined ? [] : [readable];
    })
    .join("\n");
}
