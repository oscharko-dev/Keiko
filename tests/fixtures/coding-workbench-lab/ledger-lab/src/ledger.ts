import type { Cents } from "./money.ts";

export interface Entry {
  /** ISO calendar date, YYYY-MM-DD. */
  readonly date: string;
  readonly account: string;
  readonly description: string;
  /** Positive values are income, negative values are expenses. */
  readonly amount: Cents;
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export class Ledger {
  readonly #entries: Entry[] = [];

  add(entry: Entry): void {
    if (!DATE_PATTERN.test(entry.date)) {
      throw new Error(`Invalid date: ${entry.date}`);
    }
    if (entry.account.trim() === "") {
      throw new Error("Account is required");
    }
    this.#entries.push(entry);
  }

  get entries(): readonly Entry[] {
    return this.#entries;
  }

  /** Sum of all entries, optionally restricted to one account. */
  balance(account?: string): Cents {
    return this.#entries
      .filter((entry) => account === undefined || entry.account === account)
      .reduce((sum, entry) => sum + entry.amount, 0);
  }

  /** Totals per calendar month keyed "YYYY-MM", in chronological order. */
  monthlyTotals(): Map<string, Cents> {
    const totals = new Map<string, Cents>();
    for (const entry of this.#entries) {
      const key = entry.date.slice(0, 7);
      totals.set(key, (totals.get(key) ?? 0) + entry.amount);
    }

    const sortedKeys = Array.from(totals.keys()).sort();
    const sortedTotals = new Map<string, Cents>();
    for (const key of sortedKeys) {
      sortedTotals.set(key, totals.get(key)!);
    }
    return sortedTotals;
  }
}
