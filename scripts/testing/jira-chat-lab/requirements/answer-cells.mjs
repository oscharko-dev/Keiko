// The one reader of numbers and table rows in a Chat answer that every report grader shares.
// A correct answer may format a count the German way (`1.170`), separate cells by `;`, a TAB or `|`,
// and wrap a row in Markdown pipes or bold markers. A grader that reads these with its own pattern
// grades a correct answer 0 of N (2026-11-08), so no grader parses a number or a row by itself.

/** Integer counts reject decimals, including .0; locale thousands remain whole counts. */
export function integerCell(value) {
  const text = value.trim();
  if (/^(?:0|[1-9]\d*)$/u.test(text))
    return Number.isSafeInteger(Number(text)) ? Number(text) : undefined;
  if (!/^[1-9]\d{0,2}([.,])\d{3}(?:\1\d{3})*$/u.test(text)) return undefined;
  const number = Number(text.replaceAll(/[.,]/gu, ""));
  return Number.isSafeInteger(number) ? number : undefined;
}

export function decimalCell(value) {
  const text = value.trim();
  const integer = integerCell(text);
  if (integer !== undefined) return integer;
  const match = /^(\d+|[1-9]\d{0,2}(?:[.,]\d{3})+)([.,])(\d+)$/u.exec(text);
  if (match === null || match[1].includes(match[2])) return undefined;
  const number = Number(match[1].replaceAll(/[.,]/gu, "") + "." + match[3]);
  return Number.isFinite(number) ? number : undefined;
}

export function cellsOf(line) {
  const text = line.trim().replace(/^\|/u, "").replace(/\|$/u, "");
  const cells = text.split(/[;\t|]/u).map((cell) => cell.trim().replaceAll(/\*\*|\x60/gu, ""));
  return cells.length > 1 ? cells : undefined;
}

