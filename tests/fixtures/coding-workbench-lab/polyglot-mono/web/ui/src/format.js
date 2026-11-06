import { clamp } from "@lab/shared";

/** An amount in cents as a decimal price: 1905 -> "19.05". */
export function formatPrice(cents) {
  const whole = Math.floor(cents / 100);
  return `${whole}.${cents % 100}`;
}

/** A quantity limited to what the cart accepts. */
export function cartQuantity(requested) {
  return clamp(requested, 1, 99);
}
