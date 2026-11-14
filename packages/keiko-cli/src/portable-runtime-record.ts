import { lstatSync } from "node:fs";
import { join } from "node:path";
import { readJson } from "./portable-registration.js";

/**
 * Where a portable payload keeps the record of its runtime files, below its resource root. The
 * staging scripts write it (`scripts/runtime-activation-manifest.mjs`); it names every native
 * helper, add-on, tool, licence text and sidecar root the payload ships.
 */
export const RUNTIME_ACTIVATION_RECORD_PATH = ".portable/runtime-activation.json";

const RECORD_MAX_BYTES = 1024 * 1024;
const RECORD_SECTIONS = [
  "nativeHelpers",
  "nativeAddons",
  "nativeTools",
  "sidecarRuntimes",
] as const;
const SEGMENT = "[A-Za-z0-9][A-Za-z0-9._-]*";
// A record may name files below these three runtime folders and nothing else: it can never widen
// what a managed install may hold outside them.
const RUNTIME_FILE = new RegExp(`^runtime/(?:native|licenses|sidecars)(?:/${SEGMENT}){1,8}$`, "u");
const SIDECAR_ROOT = new RegExp(`^runtime/sidecars/${SEGMENT}$`, "u");

export interface PortableRuntimeRecordEntries {
  /** Files the installed record names, relative to the resource root; the record is one of them. */
  readonly files: ReadonlySet<string>;
  /** Folders, with a trailing slash, whose whole content the record covers (sidecar roots). */
  readonly prefixes: readonly string[];
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// The installed record as parsed JSON, or undefined when the payload carries none or carries one
// that is not valid JSON: such a record names nothing, so the runtime files stay unknown entries.
// Only a regular file of bounded size is read; a storage failure is not swallowed.
function installedRecord(resourceRoot: string): unknown {
  const path = join(resourceRoot, ...RUNTIME_ACTIVATION_RECORD_PATH.split("/"));
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat === undefined || !stat.isFile() || stat.size > RECORD_MAX_BYTES) return undefined;
  return readJson(path);
}

function collectEntry(entry: unknown, files: Set<string>, prefixes: Set<string>): void {
  if (!isRecord(entry)) return;
  for (const key of ["executablePath", "licensePath"] as const) {
    const value = entry[key];
    if (typeof value === "string" && RUNTIME_FILE.test(value)) files.add(value);
  }
  const root = entry.payloadRootPath;
  if (typeof root === "string" && SIDECAR_ROOT.test(root)) prefixes.add(`${root}/`);
}

/**
 * The runtime files a managed install may hold, taken from the record its own payload carries: the
 * producer that stages the files writes the record, so the inspection needs no second list of them.
 */
export function portableRuntimeRecordEntries(resourceRoot: string): PortableRuntimeRecordEntries {
  const files = new Set<string>([RUNTIME_ACTIVATION_RECORD_PATH]);
  const prefixes = new Set<string>();
  const record = installedRecord(resourceRoot);
  if (isRecord(record)) {
    for (const section of RECORD_SECTIONS) {
      const entries = record[section];
      if (!Array.isArray(entries)) continue;
      for (const entry of entries as readonly unknown[]) collectEntry(entry, files, prefixes);
    }
  }
  return { files, prefixes: [...prefixes] };
}
