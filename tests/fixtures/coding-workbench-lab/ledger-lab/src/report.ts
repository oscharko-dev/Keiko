import type { Entry } from "./ledger.ts";
import { formatAmount, type Cents } from "./money.ts";

/**
 * Plain-text reporting for ledger entries: fixed-width tables, per-account sections and a
 * month-by-month overview. Everything here is pure; the CLI decides what to print.
 */

export type Alignment = "left" | "right";

export interface Column {
  readonly header: string;
  readonly align: Alignment;
  /** Minimum width; a longer cell widens the column. */
  readonly minWidth?: number;
}

export interface TableOptions {
  /** Separator between columns. Defaults to two spaces. */
  readonly gutter?: string;
  /** Character used for the header underline. Defaults to "-". */
  readonly rule?: string;
}

const DEFAULT_GUTTER = "  ";
const DEFAULT_RULE = "-";

function pad(text: string, width: number, align: Alignment): string {
  if (text.length >= width) {
    return text;
  }
  const fill = " ".repeat(width - text.length);
  return align === "right" ? `${fill}${text}` : `${text}${fill}`;
}

function widthOf(column: Column, cells: readonly string[]): number {
  let width = Math.max(column.header.length, column.minWidth ?? 0);
  for (const cell of cells) {
    if (cell.length > width) {
      width = cell.length;
    }
  }
  return width;
}

/** Renders rows as a fixed-width table with a header and an underline. */
export function renderTable(
  columns: readonly Column[],
  rows: readonly (readonly string[])[],
  options: TableOptions = {},
): string {
  const gutter = options.gutter ?? DEFAULT_GUTTER;
  const rule = options.rule ?? DEFAULT_RULE;
  const widths = columns.map((column, index) =>
    widthOf(
      column,
      rows.map((row) => row[index] ?? ""),
    ),
  );
  const line = (cells: readonly string[]): string =>
    columns.map((column, index) => pad(cells[index] ?? "", widths[index] ?? 0, column.align)).join(gutter);
  const header = line(columns.map((column) => column.header));
  const underline = widths.map((width) => rule.repeat(width)).join(gutter);
  return [header, underline, ...rows.map((row) => line(row))].join("\n");
}

export interface AccountSummary {
  readonly account: string;
  readonly entryCount: number;
  readonly income: Cents;
  readonly expenses: Cents;
  readonly balance: Cents;
}

/** Groups entries by account and sums income (positive) and expenses (negative) separately. */
export function summarizeAccounts(entries: readonly Entry[]): AccountSummary[] {
  const byAccount = new Map<string, { count: number; income: Cents; expenses: Cents }>();
  for (const entry of entries) {
    const current = byAccount.get(entry.account) ?? { count: 0, income: 0, expenses: 0 };
    current.count += 1;
    if (entry.amount >= 0) {
      current.income += entry.amount;
    } else {
      current.expenses += entry.amount;
    }
    byAccount.set(entry.account, current);
  }
  return [...byAccount.entries()]
    .map(([account, totals]) => ({
      account,
      entryCount: totals.count,
      income: totals.income,
      expenses: totals.expenses,
      balance: totals.income + totals.expenses,
    }))
    .sort((left, right) => left.account.localeCompare(right.account));
}

export interface MonthSummary {
  readonly month: string;
  readonly entryCount: number;
  readonly total: Cents;
  /** The single largest expense of the month, or undefined when the month has no expense. */
  readonly largestExpense: Entry | undefined;
}

/** Month keys "YYYY-MM" in chronological order, with the largest expense of each month. */
export function summarizeMonths(entries: readonly Entry[]): MonthSummary[] {
  const byMonth = new Map<string, Entry[]>();
  for (const entry of entries) {
    const month = entry.date.slice(0, 7);
    const list = byMonth.get(month);
    if (list === undefined) {
      byMonth.set(month, [entry]);
    } else {
      list.push(entry);
    }
  }
  return [...byMonth.keys()].sort().map((month) => {
    const list = byMonth.get(month) ?? [];
    let largestExpense: Entry | undefined;
    for (const entry of list) {
      if (entry.amount < 0 && (largestExpense === undefined || entry.amount > largestExpense.amount)) {
        largestExpense = entry;
      }
    }
    return {
      month,
      entryCount: list.length,
      total: list.reduce((sum, entry) => sum + entry.amount, 0),
      largestExpense,
    };
  });
}

/** Percentage share of `part` in `whole`, rounded to one decimal; 0 when `whole` is zero. */
export function share(part: Cents, whole: Cents): number {
  if (whole === 0) {
    return 0;
  }
  return Math.round((Math.abs(part) / Math.abs(whole)) * 1000) / 10;
}

export interface CategoryRule {
  readonly category: string;
  /** Case-insensitive substring of the description. */
  readonly keyword: string;
}

export const DEFAULT_CATEGORY_RULES: readonly CategoryRule[] = [
  { category: "Housing", keyword: "rent" },
  { category: "Housing", keyword: "electricity" },
  { category: "Food", keyword: "groceries" },
  { category: "Food", keyword: "restaurant" },
  { category: "Transport", keyword: "train" },
  { category: "Transport", keyword: "fuel" },
  { category: "Income", keyword: "salary" },
];

/** Returns the first matching category or "Other". */
export function categorize(entry: Entry, rules: readonly CategoryRule[] = DEFAULT_CATEGORY_RULES): string {
  const description = entry.description.toLowerCase();
  for (const rule of rules) {
    if (description.includes(rule.keyword.toLowerCase())) {
      return rule.category;
    }
  }
  return "Other";
}

export interface CategorySummary {
  readonly category: string;
  readonly total: Cents;
  readonly shareOfExpenses: number;
}

/** Expense totals per category, largest first. Income categories are excluded. */
export function summarizeCategories(
  entries: readonly Entry[],
  rules: readonly CategoryRule[] = DEFAULT_CATEGORY_RULES,
): CategorySummary[] {
  const totals = new Map<string, Cents>();
  let expenses: Cents = 0;
  for (const entry of entries) {
    if (entry.amount >= 0) {
      continue;
    }
    const category = categorize(entry, rules);
    totals.set(category, (totals.get(category) ?? 0) + entry.amount);
    expenses += entry.amount;
  }
  return [...totals.entries()]
    .map(([category, total]) => ({ category, total, shareOfExpenses: share(total, expenses) }))
    .sort((left, right) => left.total - right.total);
}

/** The account report as printed by `ledger accounts`. */
export function renderAccountReport(entries: readonly Entry[]): string {
  const summaries = summarizeAccounts(entries);
  const columns: Column[] = [
    { header: "Account", align: "left" },
    { header: "Entries", align: "right" },
    { header: "Income", align: "right", minWidth: 10 },
    { header: "Expenses", align: "right", minWidth: 10 },
    { header: "Balance", align: "right", minWidth: 10 },
  ];
  const rows = summaries.map((summary) => [
    summary.account,
    String(summary.entryCount),
    formatAmount(summary.income),
    formatAmount(summary.expenses),
    formatAmount(summary.balance),
  ]);
  return renderTable(columns, rows);
}

/** The month report as printed by `ledger months`. */
export function renderMonthReport(entries: readonly Entry[]): string {
  const summaries = summarizeMonths(entries);
  const columns: Column[] = [
    { header: "Month", align: "left" },
    { header: "Entries", align: "right" },
    { header: "Total", align: "right", minWidth: 10 },
    { header: "Largest expense", align: "left" },
  ];
  const rows = summaries.map((summary) => [
    summary.month,
    String(summary.entryCount),
    formatAmount(summary.total),
    summary.largestExpense === undefined
      ? "-"
      : `${summary.largestExpense.description} (${formatAmount(summary.largestExpense.amount)})`,
  ]);
  return renderTable(columns, rows);
}

/** The category report as printed by `ledger categories`. */
export function renderCategoryReport(entries: readonly Entry[]): string {
  const summaries = summarizeCategories(entries);
  const columns: Column[] = [
    { header: "Category", align: "left" },
    { header: "Total", align: "right", minWidth: 10 },
    { header: "Share", align: "right" },
  ];
  const rows = summaries.map((summary) => [
    summary.category,
    formatAmount(summary.total),
    `${String(summary.shareOfExpenses)}%`,
  ]);
  return renderTable(columns, rows);
}

/** Running balance after each entry, in the order given. */
export function runningBalance(entries: readonly Entry[]): readonly { entry: Entry; balance: Cents }[] {
  let balance: Cents = 0;
  return entries.map((entry) => {
    balance += entry.amount;
    return { entry, balance };
  });
}

/** Entries whose description and amount recur in at least `minMonths` distinct months. */
export function recurringEntries(entries: readonly Entry[], minMonths = 2): readonly Entry[] {
  const months = new Map<string, Set<string>>();
  for (const entry of entries) {
    const key = `${entry.description.toLowerCase()}|${String(entry.amount)}`;
    const set = months.get(key) ?? new Set<string>();
    set.add(entry.date.slice(0, 7));
    months.set(key, set);
  }
  const seen = new Set<string>();
  const result: Entry[] = [];
  for (const entry of entries) {
    const key = `${entry.description.toLowerCase()}|${String(entry.amount)}`;
    if ((months.get(key)?.size ?? 0) >= minMonths && !seen.has(key)) {
      seen.add(key);
      result.push(entry);
    }
  }
  return result;
}
