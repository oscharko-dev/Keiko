import { compareStrings } from "./comparators.js";

// Canonical JSON: recursively sorted plain data objects, preserved array order and JSON's
// undefined/-0 normalization. Unsupported values fail closed rather than colliding with JSON data.
export function canonicalise(value: unknown): string {
  return encode(value, new Set<object>());
}

function encode(value: unknown, ancestors: Set<object>): string {
  if (value === undefined || value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Canonical JSON requires a finite number.");
    return JSON.stringify(value);
  }
  if (typeof value !== "object") throw new TypeError("Unsupported canonical JSON value.");
  if (ancestors.has(value)) throw new TypeError("Canonical JSON cannot contain a cycle.");
  ancestors.add(value);
  try {
    return Array.isArray(value) ? encodeArray(value, ancestors) : encodeObject(value, ancestors);
  } finally {
    ancestors.delete(value);
  }
}

function dataValue(descriptor: PropertyDescriptor | undefined): unknown {
  if (descriptor === undefined) return undefined;
  if (!Object.hasOwn(descriptor, "value"))
    throw new TypeError("Canonical JSON cannot contain an accessor.");
  return descriptor.value;
}

function encodeArray(value: readonly unknown[], ancestors: Set<object>): string {
  return `[${Array.from({ length: value.length }, (_, index) =>
    encode(dataValue(Object.getOwnPropertyDescriptor(value, index)), ancestors),
  ).join(",")}]`;
}

function encodeObject(value: object, ancestors: Set<object>): string {
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype)
    throw new TypeError("Canonical JSON requires a plain object.");
  if (Object.getOwnPropertySymbols(value).length > 0)
    throw new TypeError("Canonical JSON cannot contain symbol keys.");
  const entries: string[] = [];
  for (const key of Object.keys(value).sort(compareStrings)) {
    const item = dataValue(Object.getOwnPropertyDescriptor(value, key));
    if (item !== undefined) entries.push(`${JSON.stringify(key)}:${encode(item, ancestors)}`);
  }
  return `{${entries.join(",")}}`;
}
