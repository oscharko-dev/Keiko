import type { Entry } from "./ledger.ts";
import { parseAmount } from "./money.ts";

const HEADER = "date,account,description,amount";

/** Parses a single CSV line following RFC 4180 rules. */
function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let currentCell = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (inQuotes) {
      if (char === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          currentCell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        currentCell += char;
      }
    } else {
      if (char === '"') {
        inQuotes = true;
      } else if (char === ',') {
        cells.push(currentCell);
        currentCell = "";
      } else {
        currentCell += char;
      }
    }
  }
  cells.push(currentCell);
  return cells;
}

/** Parses a ledger CSV export (header row + one entry per line). */
export function parseCsv(text: string): Entry[] {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== "");
  const [header, ...rows] = lines;
  if (header?.trim() !== HEADER) {
    throw new Error(`Unexpected CSV header, expected "${HEADER}"`);
  }
  return rows.map((row, index) => {
    const cells = splitCsvLine(row);
    if (cells.length !== 4) {
      throw new Error(`Line ${index + 2}: expected 4 columns, got ${cells.length}`);
    }
    const [date, account, description, amount] = cells as [string, string, string, string];
    return {
      date: date.trim(),
      account: account.trim(),
      description: description.trim(),
      amount: parseAmount(amount),
    };
  });
}
