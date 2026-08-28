// Shared markdown-table reading for the gates that enforce a decision recorded in a document.
//
// Extracted because two gates parsed the same tables with two copies of this helper, and the copies
// had already diverged — one filtered separator rows internally, the other did not, and a defect in
// the shared shape had to be found twice. `scripts/lib/` is where `json.mjs` and
// `host-executable.mjs` already live for exactly this reason.
//
// Two properties matter more than they look:
//
//   - **The trailing pipe is optional in GFM.** `| a | b | c` is a legal row, and the obvious
//     `split("|").slice(1, -1)` silently discards its LAST cell rather than an empty segment. A
//     four-column row then reads as three, drops below every schema check, and leaves enforcement
//     without a sound — the worst failure a gate can have, because it looks exactly like agreement.
//   - **Fenced code blocks are not content.** A document that shows an example row inside a
//     ``` fence would otherwise have that example parsed as a real decision. In a document whose
//     whole purpose is recording decisions, an illustration must never become one.

const SEPARATOR_ROW = /^\|[\s:|-]*$/u;
const FENCE = /^\s*(?:```|~~~)/u;

// Strips any number of backtick layers: CommonMark escapes a code span containing a backtick by
// doubling the delimiter, so a single-layer strip leaves one behind and pollutes the cell value.
export function unquote(cell) {
  // Character walk rather than /^`+|`+$/g: that alternation backtracks super-linearly on a cell
  // that is nothing but backticks, and this runs over every row of an attacker-editable document.
  let value = cell.trim();
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === "`") start += 1;
  while (end > start && value[end - 1] === "`") end -= 1;
  value = value.slice(start, end);
  return value.trim();
}

function tableCells(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|")) return null;
  const inner = trimmed.endsWith("|") ? trimmed.slice(1, -1) : trimmed.slice(1);
  return inner.split("|").map((cell) => cell.trim());
}

export function isSeparatorRow(line) {
  return SEPARATOR_ROW.test(line.trim());
}

// Yields every line of the document with its parsed cells (null when the line is not a table row),
// skipping anything inside a fenced code block.
export function* documentLines(markdown) {
  let fenced = false;
  for (const line of markdown.split(/\r?\n/)) {
    if (FENCE.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    yield { line, cells: tableCells(line) };
  }
}
