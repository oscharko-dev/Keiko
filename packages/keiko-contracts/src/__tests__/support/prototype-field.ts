// Defines `key` on Object.prototype while `read` runs, as a polluted prototype would. The property is
// not enumerable, so own-key checks cannot see it: only a read that falls through to the prototype
// does (REVIEW-3918-072).
export function withPrototypeField<T>(
  key: string,
  value: string | number | boolean,
  read: () => T,
): T {
  Object.defineProperty(Object.prototype, key, { value, configurable: true, writable: true });
  try {
    return read();
  } finally {
    Reflect.deleteProperty(Object.prototype, key);
  }
}
