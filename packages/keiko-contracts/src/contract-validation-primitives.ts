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

/** A plain data object: own enumerable data properties only, no accessors, symbols or class. */
export function isOwnDataRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return (
    (prototype === null || prototype === Object.prototype) &&
    Object.getOwnPropertySymbols(value).length === 0 &&
    Object.values(Object.getOwnPropertyDescriptors(value)).every(
      (entry) => "value" in entry && entry.enumerable === true,
    )
  );
}

/** True when the record carries exactly these own keys and no other. */
export function hasExactOwnKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return (
    Reflect.ownKeys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
  );
}

/** A positive safe integer no larger than `maximum`. */
export function isBoundedPositiveInteger(value: unknown, maximum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= maximum;
}

/** True for any C0 control or DEL, including TAB, LF and CR; C1 controls are not covered. */
export function hasAsciiControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint < 32 || codePoint === 127)) return true;
  }
  return false;
}
