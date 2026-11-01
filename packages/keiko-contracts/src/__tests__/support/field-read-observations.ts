/** Replaces each listed field of `record` with an enumerable getter that records its reads. */
export function observeFieldReads<T extends object>(
  record: T,
  fields: readonly (keyof T & string)[],
  trace: string[],
): void {
  for (const field of fields) {
    const value: unknown = record[field];
    Object.defineProperty(record, field, {
      enumerable: true,
      get: (): unknown => {
        trace.push(field);
        return value;
      },
    });
  }
}
