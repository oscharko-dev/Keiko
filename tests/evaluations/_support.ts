// Shared test helpers for evaluation tests. Not a *.test.ts so vitest does not collect it.

export function must<T>(value: T | undefined, message = "expected a defined value"): T {
  if (value === undefined) {
    throw new Error(message);
  }
  return value;
}
