function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isUnknownRecord(value)) throw new TypeError(`${label} must be a plain record.`);
  return value;
}
