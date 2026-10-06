import type { Entry } from "../ledger.ts";
import type { Cents } from "../money.ts";
import type { Importer } from "./index.ts";

/**
 * Bank B exports: semicolon-separated, dates as DD.MM.YYYY, amounts in the German notation with a
 * comma as the decimal separator and an optional dot as the thousands separator ("1.234,50").
 * Lines before the header carry account metadata and are skipped.
 */

const HEADER = "Datum;Konto;Verwendungszweck;Betrag";
const DATE_PATTERN = /^(\d{2})\.(\d{2})\.(\d{4})$/;

function isoDate(input: string): string {
  const match = DATE_PATTERN.exec(input.trim());
  if (match === null) {
    throw new Error(`Invalid Bank B date: ${input}`);
  }
  const [, day, month, year] = match as unknown as [string, string, string, string];
  return `${year}-${month}-${day}`;
}

function germanAmountToCents(input: string): Cents {
  const value = Number.parseFloat(input.trim().replace(",", "."));
  if (Number.isNaN(value)) {
    throw new Error(`Invalid Bank B amount: ${input}`);
  }
  return Math.round(value * 100);
}

function entryFromRow(row: string, lineNumber: number): Entry {
  const cells = row.split(";");
  if (cells.length !== 4) {
    throw new Error(`Line ${lineNumber}: expected 4 columns, got ${cells.length}`);
  }
  const [date, account, description, amount] = cells as [string, string, string, string];
  return {
    date: isoDate(date),
    account: account.trim(),
    description: description.trim(),
    amount: germanAmountToCents(amount),
  };
}

export const bankBImporter: Importer = {
  id: "bank-b",
  describe: "Bank B export (semicolon-separated, DD.MM.YYYY, German amounts)",
  parse(text: string): Entry[] {
    const lines = text.split(/\r?\n/);
    const headerIndex = lines.findIndex((line) => line.trim() === HEADER);
    if (headerIndex === -1) {
      throw new Error(`Bank B header "${HEADER}" not found`);
    }
    return lines
      .slice(headerIndex + 1)
      .map((line, offset) => ({ line, lineNumber: headerIndex + offset + 2 }))
      .filter(({ line }) => line.trim() !== "")
      .map(({ line, lineNumber }) => entryFromRow(line, lineNumber));
  },
};
