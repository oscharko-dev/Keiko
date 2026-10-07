import { readFileSync } from "node:fs";
import { importerFor, ledgerCsvImporter } from "./importers/index.ts";
import { Ledger, type Entry } from "./ledger.ts";
import { formatAmount } from "./money.ts";
import { renderAccountReport, renderCategoryReport, renderMonthReport } from "./report.ts";

export const USAGE = [
  "Usage:",
  "  ledger summary <file.csv>                 balance and monthly totals",
  "  ledger accounts <file.csv>                per-account income, expenses and balance",
  "  ledger months <file.csv>                  per-month totals with the largest expense",
  "  ledger categories <file.csv>              expense categories by share",
  "  ledger import --format <id> <file>        summary of a bank export (ledger-csv, bank-b)",
].join("\n");

function readEntries(file: string, format = ledgerCsvImporter.id): Entry[] {
  return importerFor(format).parse(readFileSync(file, "utf8"));
}

function summary(entries: readonly Entry[]): string {
  const ledger = new Ledger();
  for (const entry of entries) {
    ledger.add(entry);
  }
  const lines = [`Balance: ${formatAmount(ledger.balance())}`];
  for (const [month, total] of ledger.monthlyTotals()) {
    lines.push(`${month}: ${formatAmount(total)}`);
  }
  return lines.join("\n");
}

const REPORTS: Readonly<Record<string, (entries: readonly Entry[]) => string>> = {
  summary,
  accounts: renderAccountReport,
  months: renderMonthReport,
  categories: renderCategoryReport,
};

/** Runs the CLI and returns its output text. */
export function run(argv: readonly string[]): string {
  const [command, ...rest] = argv;
  if (command === "import") {
    const formatIndex = rest.indexOf("--format");
    const format = formatIndex === -1 ? undefined : rest[formatIndex + 1];
    const file = rest.find((arg, index) => !arg.startsWith("--") && index !== formatIndex + 1);
    if (format === undefined || file === undefined) {
      return USAGE;
    }
    return summary(readEntries(file, format));
  }
  const report = command === undefined ? undefined : REPORTS[command];
  const file = rest[0];
  if (report === undefined || file === undefined) {
    return USAGE;
  }
  return report(readEntries(file));
}

if (import.meta.main) {
  console.log(run(process.argv.slice(2)));
}
