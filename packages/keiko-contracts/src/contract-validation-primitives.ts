// Shared structural validation without importing domain codecs.

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

export function isCapturedExtent(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

export function validateStableExtent(
  members: readonly unknown[],
  extent: number,
  field: string,
  errors: string[],
): boolean {
  if (members.length !== extent) {
    errors.push(`${field} must not change length during validation`);
    return false;
  }
  return true;
}
