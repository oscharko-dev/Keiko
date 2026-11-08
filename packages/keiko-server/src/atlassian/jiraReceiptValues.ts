/** Private structural primitives for original receipt evidence, before any spread/serialization. */
export function receiptOwnData(value: object, key: PropertyKey): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor?.enumerable === true && "value" in descriptor ? descriptor.value : undefined;
}
export function receiptPlainObject(value: unknown): value is object {
  if (value === null || typeof value !== "object") return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
export function receiptFields(value: unknown, required: readonly PropertyKey[], optional: readonly PropertyKey[] = []): value is object {
  if (!receiptPlainObject(value)) return false;
  return Reflect.ownKeys(value).every((key) => (required.includes(key) || optional.includes(key)) && receiptOwnData(value, key) !== undefined) &&
    required.every((key) => receiptOwnData(value, key) !== undefined);
}
export function receiptNativeId(value: unknown): value is string {
  return typeof value === "string" && /^[1-9][0-9]{0,18}$/u.test(value) && BigInt(value) <= 9223372036854775807n;
}
export function receiptInteger(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}
export function receiptDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}
export function receiptArray(value: unknown, minimum: number, maximum: number, item: (value: unknown) => boolean, unique = true): value is readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length < minimum || value.length > maximum ||
      Reflect.ownKeys(value).length !== value.length + 1) return false;
  const seen = new Set<unknown>();
  for (let index = 0; index < value.length; index++) {
    const current = receiptOwnData(value, String(index));
    if (!item(current) || (unique && seen.has(current))) return false;
    seen.add(current);
  }
  return true;
}
/** Only call after all nested values passed the closed own-data guards. */
export function receiptWithinBudget(value: object): boolean {
  return Buffer.byteLength(JSON.stringify(value), "utf8") <= 16_384;
}
