import ledger from "@acceptance/ledger";

/**
 * The total of a statement, formatted by the internal ledger package: the sum of the amounts of all
 * its lines.
 *
 * @param {readonly { amountCents: number }[]} lines
 * @returns {string}
 */
export function statementTotal(lines) {
  const total = lines.reduce((sum, line) => sum + line.amountCents, 0);
  return ledger.formatCents(total);
}
