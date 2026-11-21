import { Buffer } from "node:buffer";
import { deepRedactStrings, type DeepRedacted } from "@oscharko-dev/keiko-security";
import type { Redactor } from "./deps.js";

/** Reuse immutable redaction results only during one bounded prompt-fitting operation. */
export function promptFitRedactor(redactor: Redactor, byteLimit: number): Redactor {
  const results = new Map<string, string>();
  let retainedBytes = 0;
  const redactString = (value: string): string => {
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
  // A string goes through the cache: `deepRedactStrings` hands a string value straight to
  // `redactString`, so the cached path stays one call per string. Any other value goes to the
  // wrapped redactor unchanged.
  return <T>(value: T): DeepRedacted<T> =>
    typeof value === "string" ? deepRedactStrings<T>(value, redactString) : redactor(value);
}
