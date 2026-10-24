// Code-task acceptance boundaries require plain records and closed own string/symbol keys.
// Reject non-default prototypes before field admission: own-name scans cannot see an inherited
// extra field. Scan all own names (including non-enumerable names) and symbols when closing a
// schema. This complements, and does not replace, ownField protection against global pollution.
// Keep prototype admission separate from key scanning: schema owners retain their own field reads,
// allowed keys, error paths and checks for inherited facts through the existing ownField primitive.

export function isCodeTaskRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

export function validateCodeTaskOwnKeys(
  errors: string[],
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): boolean {
  const unknownErrors = Object.getOwnPropertyNames(value)
    .filter((key) => !allowed.includes(key))
    .map((key) => `${path}.${key} is not allowed`);
  if (Object.getOwnPropertySymbols(value).length > 0) {
    unknownErrors.push(`${path} must not carry symbol-keyed properties`);
  }
  errors.push(...unknownErrors);
  return unknownErrors.length === 0;
}
