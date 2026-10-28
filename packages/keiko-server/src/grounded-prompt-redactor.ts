import { Buffer } from "node:buffer";
import type { Redactor } from "./deps.js";

/** Reuse immutable redaction results only during one bounded prompt-fitting operation. */
export function promptFitRedactor(redactor: Redactor, byteLimit: number): Redactor {
  const results = new Map<string, string>();
  let retainedBytes = 0;
  return (value: unknown): unknown => {
    if (typeof value !== "string") return redactor(value);
    const previous = results.get(value);
    if (previous !== undefined) return previous;
    const result = redactor(value);
    if (typeof result !== "string") return result;
    const bytes = Buffer.byteLength(value, "utf8") + Buffer.byteLength(result, "utf8");
    if (results.size < 128 && retainedBytes + bytes <= byteLimit) {
      results.set(value, result);
      retainedBytes += bytes;
    }
    return result;
  };
}
