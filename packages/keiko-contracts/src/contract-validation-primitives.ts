// Shared record/key validation without importing domain codecs.

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): string[] {
  const errors: string[] = [];
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) errors.push(`${path}.${key} is not allowed`);
  }
  return errors;
}
