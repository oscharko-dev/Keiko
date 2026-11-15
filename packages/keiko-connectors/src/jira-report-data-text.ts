/** The longest text of a document that a report carries as data. */
export const JIRA_REPORT_DATA_TEXT_CHARS_MAX = 120;

const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu;
/** Markup, quoting and delimiter characters of the formats a report is rendered in. */
const MARKUP = /[<>[\]{}`"\\|;]+/gu;

/**
 * Text taken from a document (a requirement statement) is untrusted data wherever a report shows
 * it, and `report.figures` is quoted by a model. It is neutralised, never interpreted: control,
 * format and line-break characters, markup and the report's own delimiters become spaces, the
 * rest is bounded. The renderers still delimit it as a quoted value; this keeps it from ending
 * the delimiter or from forming markup of its own.
 */
export function jiraReportDataText(value: string): string {
  const text = value
    .normalize("NFC")
    .replaceAll(INVISIBLE, " ")
    .replaceAll(MARKUP, " ")
    .replaceAll(/\s+/gu, " ")
    .trim();
  // Cut by code point: a UTF-16 cut would split a surrogate pair and leave a lone surrogate.
  const points = Array.from(text);
  return points.length > JIRA_REPORT_DATA_TEXT_CHARS_MAX
    ? `${points
        .slice(0, JIRA_REPORT_DATA_TEXT_CHARS_MAX - 1)
        .join("")
        .trimEnd()}…`
    : text;
}

/** Everything but letters, digits, spaces, dots and commas: nothing Jira wiki markup can use. */
const NOT_WIKI_PLAIN = /[^\p{L}\p{N} .,]+/gu;

/**
 * A name for a Jira comment, which Jira renders as wiki markup: `*`, `_`, `!`, `[`, `{`, `|`, `~`,
 * `+`, `^`, `-`, `?`, `(` and `:` can bold, embed an image, link, start a macro or draw an icon.
 * Only letters, digits, spaces, dots and commas stay, so a name can never be markup.
 */
export function jiraReportWikiPlainText(value: string): string {
  return jiraReportDataText(value.replaceAll(NOT_WIKI_PLAIN, " "));
}
