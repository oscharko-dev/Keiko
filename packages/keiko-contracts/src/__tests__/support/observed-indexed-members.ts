export function observeIndexedMembers(members: unknown[], reads: string[]): unknown[] {
  return new Proxy(members, {
    get(target, key, receiver): unknown {
      reads.push(`get:${String(key)}`);
      return Reflect.get(target, key, receiver);
    },
    has(target, key): boolean {
      reads.push(`has:${String(key)}`);
      return Reflect.has(target, key);
    },
  });
}
