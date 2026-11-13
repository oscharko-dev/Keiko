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
  return text.length > JIRA_REPORT_DATA_TEXT_CHARS_MAX
    ? `${text.slice(0, JIRA_REPORT_DATA_TEXT_CHARS_MAX - 1).trimEnd()}…`
    : text;
}
