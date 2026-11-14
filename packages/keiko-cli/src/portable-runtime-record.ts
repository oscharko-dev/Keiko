import { isJsonRecord, readPayloadJson } from "./portable-payload-json.js";

/**
 * Where a portable payload keeps the record of its runtime files, below its resource root. The
 * staging scripts write it (`scripts/runtime-activation-manifest.mjs`); it names every native
 * helper, add-on, tool, licence text and sidecar root the payload ships.
 */
export const RUNTIME_ACTIVATION_RECORD_PATH = ".portable/runtime-activation.json";

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

function collectEntry(entry: unknown, files: Set<string>, prefixes: Set<string>): void {
  if (!isJsonRecord(entry)) return;
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
  const record = readPayloadJson(resourceRoot, RUNTIME_ACTIVATION_RECORD_PATH);
  if (isJsonRecord(record)) {
    for (const section of RECORD_SECTIONS) {
      const entries = record[section];
      if (!Array.isArray(entries)) continue;
      for (const entry of entries as readonly unknown[]) collectEntry(entry, files, prefixes);
    }
  }
  return { files, prefixes: [...prefixes] };
}
