// A string-keyed record without Object.prototype. A lookup or write keyed by an untrusted name such
// as `constructor`, `toString` or `__proto__` then reads or creates an own entry instead of reaching
// a prototype member (KEIKO-0657, #2802). The editor layout, language-mode map and built-in
// capability index share this one owner.
export function nullPrototypeRecord<V>(): Record<string, V> {
  return withoutPrototype<Record<string, V>>({});
}

function withoutPrototype<T extends object>(value: T): T {
  Object.setPrototypeOf(value, null);
  return value;
}
