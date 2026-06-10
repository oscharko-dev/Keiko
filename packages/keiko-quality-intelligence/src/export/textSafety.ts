// Inline-field sanitisation for Quality Intelligence export serializers (Epic #711).
//
// Candidate fields (title, steps, preconditions, expected results, tags) are free text. A value that
// contains a line break or tab would break the structure of a line-oriented serializer — a newline
// inside a Markdown list item silently terminates the list; a newline inside a plain-text or
// key/value row splits one field across two lines. `inlineField` folds any run of line-breaking or
// tab whitespace into a single space so each field renders as exactly one logical unit, without
// otherwise altering the content. Pure, deterministic; NO IO, NO new runtime dependency.

// Matching control whitespace (CR, LF, tab, vertical tab, form feed) and the Unicode line
// separators is the entire purpose of this helper, so the control characters are intentional.
// eslint-disable-next-line no-control-regex
const LINE_BREAKING_RUN = /[\r\n\t\u000b\f\u0085\u2028\u2029]+/gu;

/**
 * Collapse embedded line-breaking / tab whitespace in a single field value to one space. Leaves all
 * other characters (including ordinary spaces and non-ASCII text) untouched.
 */
export function inlineField(value: string): string {
  return value.replace(LINE_BREAKING_RUN, " ");
}

/** Apply {@link inlineField} across a list of field values. */
export function inlineFields(values: readonly string[]): string[] {
  return values.map(inlineField);
}
