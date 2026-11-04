// Merged cells of a worksheet (#4235).
//
// A merged range stores its value in the top-left cell and nothing in the cells it covers. Read
// as stored, a requirement whose ID, title and priority are merged over the rows that list its
// acceptance criteria loses all but the first criterion: the following rows have no ID at all.
//
// Two shapes of vertical merge exist, and they mean different things:
//
//   * Grouping (a chapter merged over several requirements): every covered row is its own
//     record. The value is projected into the covered cells, so each row reads in full.
//   * Continuation (ID, title, description merged over the rows of one requirement; only the
//     criterion column differs): the covered rows are further lines of ONE record. They are
//     folded into the anchor row, cell by cell, as extra lines of the cell (a multi-line cell is
//     how the projection already carries a list of criteria). Repeating the ID instead would
//     present several records with the same identifier.
//
// A row continues its anchor when the merged columns outnumber the cells the row holds itself.
// A horizontal-only merge (a banner over several columns) is one cell and is left alone.

export interface MergeRange {
  readonly firstRow: number;
  readonly lastRow: number;
  readonly firstColumn: number;
  readonly lastColumn: number;
}

export interface MergeCell {
  readonly columnIndex: number;
  value: string;
}

export interface MergeRow<TCell extends MergeCell> {
  readonly rowNumber: number;
  cells: TCell[];
  // Set when the row was folded into its anchor; the caller drops it.
  folded: boolean;
}

// Upper bounds so a hostile `mergeCell` list cannot turn a small sheet into unbounded work. The
// budget counts every cell a row holds and every column a range covers on that row, so thousands of
// overlapping ranges over thousands of rows exhaust it instead of multiplying out.
const MERGE_WORK_BUDGET = 5_000_000;
const MERGE_MAX_COLUMNS = 256;
const MERGE_MAX_RANGES = 50_000;

function firstRowAtOrAfter<TCell extends MergeCell>(
  rows: readonly MergeRow<TCell>[],
  target: number,
): number {
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((rows[middle]?.rowNumber ?? 0) < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

interface Spread {
  readonly range: MergeRange;
  readonly value: string;
}

function rangeKey(range: MergeRange): string {
  return `${String(range.firstRow)}:${String(range.lastRow)}:${String(range.firstColumn)}:${String(range.lastColumn)}`;
}

// The vertical ranges worth projecting, grouped by the row that holds their value. A range listed
// twice is one range.
function groupRanges(ranges: readonly MergeRange[]): ReadonlyMap<number, readonly MergeRange[]> {
  const groups = new Map<number, MergeRange[]>();
  const seen = new Set<string>();
  for (const range of ranges) {
    if (range.lastRow <= range.firstRow) continue;
    if (range.lastColumn - range.firstColumn >= MERGE_MAX_COLUMNS) continue;
    if (seen.size >= MERGE_MAX_RANGES || seen.has(rangeKey(range))) continue;
    seen.add(rangeKey(range));
    const group = groups.get(range.firstRow);
    if (group === undefined) groups.set(range.firstRow, [range]);
    else group.push(range);
  }
  return groups;
}

function spreadsOf<TCell extends MergeCell>(
  anchor: MergeRow<TCell>,
  group: readonly MergeRange[],
): readonly Spread[] {
  return group
    .flatMap((range) => {
      const value = anchor.cells.find((cell) => cell.columnIndex === range.firstColumn)?.value;
      return value === undefined ? [] : [{ range, value }];
    })
    .sort((a, b) => a.range.firstColumn - b.range.firstColumn);
}

// The number of distinct columns the spreads cover; they are ordered by their first column.
function coveredColumns(active: readonly Spread[]): number {
  let total = 0;
  let end = -1;
  for (const { range } of active) {
    const from = Math.max(range.firstColumn, end + 1);
    if (range.lastColumn >= from) total += range.lastColumn - from + 1;
    end = Math.max(end, range.lastColumn);
  }
  return total;
}

// What filling the row costs: every column of every range that reaches it.
function coveredWidth(active: readonly Spread[]): number {
  return active.reduce((sum, { range }) => sum + range.lastColumn - range.firstColumn + 1, 0);
}

function foldIntoAnchor<TCell extends MergeCell>(
  anchor: MergeRow<TCell>,
  row: MergeRow<TCell>,
  makeCell: (columnIndex: number, value: string) => TCell,
): void {
  const byColumn = new Map(anchor.cells.map((cell) => [cell.columnIndex, cell] as const));
  for (const own of row.cells) {
    const existing = byColumn.get(own.columnIndex);
    if (existing === undefined) {
      const added = makeCell(own.columnIndex, own.value);
      byColumn.set(own.columnIndex, added);
      anchor.cells.push(added);
    } else {
      existing.value = `${existing.value}\n${own.value}`;
    }
  }
  anchor.cells.sort((a, b) => a.columnIndex - b.columnIndex);
  row.folded = true;
}

function fillCovered<TCell extends MergeCell>(
  row: MergeRow<TCell>,
  active: readonly Spread[],
  makeCell: (columnIndex: number, value: string) => TCell,
): void {
  const present = new Set(row.cells.map((cell) => cell.columnIndex));
  for (const { range, value } of active) {
    for (let column = range.firstColumn; column <= range.lastColumn; column += 1) {
      if (!present.has(column)) {
        present.add(column);
        row.cells.push(makeCell(column, value));
      }
    }
  }
  row.cells.sort((a, b) => a.columnIndex - b.columnIndex);
}

function projectGroup<TCell extends MergeCell>(
  rows: readonly MergeRow<TCell>[],
  anchor: MergeRow<TCell>,
  group: readonly MergeRange[],
  makeCell: (columnIndex: number, value: string) => TCell,
  budget: number,
): number {
  const spreads = spreadsOf(anchor, group);
  const lastRow = spreads.reduce((last, { range }) => Math.max(last, range.lastRow), 0);
  let remaining = budget;
  // Rows are visited in order, so a range that ended above the row is dropped for good.
  let live = spreads;
  for (let i = firstRowAtOrAfter(rows, anchor.rowNumber + 1); i < rows.length; i += 1) {
    const row = rows[i];
    if (row === undefined || row.rowNumber > lastRow) break;
    live = live.filter(({ range }) => range.lastRow >= row.rowNumber);
    const cost = row.cells.length + 1 + coveredWidth(live);
    if (cost > remaining) break;
    remaining -= cost;
    if (coveredColumns(live) > row.cells.length) foldIntoAnchor(anchor, row, makeCell);
    else fillCovered(row, live, makeCell);
  }
  return remaining;
}

/**
 * Applies the merged ranges to rows sorted by row number. Grouping merges fill their covered
 * cells; continuation rows are folded into their anchor and marked `folded`.
 */
export function applyMergedCells<TCell extends MergeCell>(
  rows: readonly MergeRow<TCell>[],
  ranges: readonly MergeRange[],
  makeCell: (columnIndex: number, value: string) => TCell,
): void {
  let budget = MERGE_WORK_BUDGET;
  const groups = groupRanges(ranges);
  for (const anchorRowNumber of [...groups.keys()].sort((a, b) => a - b)) {
    const anchor = rows[firstRowAtOrAfter(rows, anchorRowNumber)];
    if (anchor?.rowNumber !== anchorRowNumber || anchor.folded) continue;
    budget = projectGroup(rows, anchor, groups.get(anchorRowNumber) ?? [], makeCell, budget);
  }
}
