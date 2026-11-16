/** Snapshot semantics of createLimitRunIntent, without a second file owner. */
export function memoryLimitIntent(initial = {}, path) {
  let data = structuredClone(initial);
  const records = [];
  return {
    ...(path === undefined ? {} : { path }),
    records,
    get state() {
      return structuredClone(data);
    },
    record(name, value) {
      data[name] = structuredClone(value);
      records.push({ name, value: structuredClone(value) });
    },
    update(patch) {
      data = { ...data, ...structuredClone(patch) };
    },
  };
}
