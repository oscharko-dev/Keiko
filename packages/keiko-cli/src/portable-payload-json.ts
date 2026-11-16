import { lstatSync } from "node:fs";
import { join } from "node:path";
import { readJson } from "./portable-registration.js";

const PAYLOAD_JSON_MAX_BYTES = 1024 * 1024;

export function isJsonRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A JSON file a payload carries below its resource root, as parsed JSON: undefined when the payload
 * has none or has one that is not valid JSON, so what the file would name stays unknown. Only a
 * regular file of bounded size is read; a storage failure is not swallowed.
 */
export function readPayloadJson(resourceRoot: string, relativePath: string): unknown {
  const path = join(resourceRoot, ...relativePath.split("/"));
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat === undefined || !stat.isFile() || stat.size > PAYLOAD_JSON_MAX_BYTES) return undefined;
  return readJson(path);
}
