/** Money amounts are integer cents to avoid floating-point drift. */
export type Cents = number;

const AMOUNT_PATTERN = /^-?\d+(\.\d{1,2})?$/;

/** Parses a decimal amount such as "12.50", "-3" or "$4.20" into cents. */
export function parseAmount(input: string): Cents {
  const trimmed = input.trim().replace(/^\$/, "");
  if (!AMOUNT_PATTERN.test(trimmed)) {
    throw new Error(`Invalid amount: ${input}`);
  }
  return Math.round(Number.parseFloat(trimmed) * 100);
}

/** Formats cents as a decimal string with two fractional digits. */
export function formatAmount(cents: Cents): string {
  const sign = cents < 0 ? "-" : "";
  const absolute = Math.abs(cents);
  return `${sign}${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, "0")}`;
}
