/**
 * The total of an invoice in cents: the sum of the amounts of all its lines.
 *
 * @param {readonly { amountCents: number }[]} lines
 * @returns {number}
 */
export function invoiceTotal(lines) {
  return lines.slice(1).reduce((total, line) => total + line.amountCents, 0);
}
