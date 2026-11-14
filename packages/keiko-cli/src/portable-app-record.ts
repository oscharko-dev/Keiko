import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { isJsonRecord, readPayloadJson } from "./portable-payload-json.js";

/**
 * A payload's `app/` is the extracted `npm pack` of the root package, and npm packs exactly what
 * the package's own `package.json` names: its `files` list, the files of `bin`, `main` and
 * `browser`, and the entries it always adds (`package.json`, README, COPYING, LICENSE, LICENCE).
 * The installed `app/package.json` is that same input, so the inspection reads it instead of
 * keeping a second list of the package's files (#4358).
 */
export const APP_PACKAGE_JSON_PATH = "app/package.json";

const SEGMENT = "[A-Za-z0-9_][A-Za-z0-9._-]*";
// A `files` entry or a `bin`/`main` path npm packs verbatim: plain relative segments. Globs,
// negations, parent segments and anything else never name an entry, so such a file stays unknown.
const PLAIN_PATH = new RegExp(`^${SEGMENT}(?:/${SEGMENT}){0,7}$`, "u");
// npm-packlist: `!/readme{,.*[^~$]}` and its three siblings, matched without regard to case.
const ALWAYS_PACKED_NAME = /^(?:readme|copying|license|licence)(?:\..*[^~$])?$/iu;

export interface PortableAppEntries {
  /** Files and folders the installed `app/package.json` names, relative to the resource root. */
  readonly files: ReadonlySet<string>;
  /** Folders, with a trailing slash, whose whole content a `files` entry covers. */
  readonly prefixes: readonly string[];
}

function stringValues(value: unknown): readonly string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) {
    return (value as readonly unknown[]).filter(
      (entry): entry is string => typeof entry === "string",
    );
  }
  return isJsonRecord(value)
    ? Object.values(value).filter((entry) => typeof entry === "string")
    : [];
}

// npm reads `files` entries relative to the package root and accepts a leading `./`.
function plainPackedPath(value: string): string | undefined {
  const trimmed = (value.startsWith("./") ? value.slice(2) : value).replace(/\/$/u, "");
  return PLAIN_PATH.test(trimmed) ? trimmed : undefined;
}

function packedPaths(packageJson: Readonly<Record<string, unknown>>): readonly string[] {
  const named = [
    ...stringValues(packageJson.files),
    ...stringValues(packageJson.bin),
    ...stringValues(packageJson.main),
    ...stringValues(packageJson.browser),
  ];
  return named.flatMap((value) => plainPackedPath(value) ?? []);
}

function alwaysPackedNames(appRoot: string): readonly string[] {
  return readdirSync(appRoot).filter((name) => ALWAYS_PACKED_NAME.test(name));
}

/**
 * The entries of `app/` that the payload's own package names, below the resource root. A named
 * entry counts as what it is on disk, the way npm decides it: a file is one file, a folder covers
 * its content, anything else names nothing. Nothing outside what that package packs is admitted.
 */
export function portableAppEntries(resourceRoot: string): PortableAppEntries {
  const files = new Set<string>([APP_PACKAGE_JSON_PATH]);
  const prefixes: string[] = [];
  const packageJson = readPayloadJson(resourceRoot, APP_PACKAGE_JSON_PATH);
  if (!isJsonRecord(packageJson)) return { files, prefixes };
  const appRoot = join(resourceRoot, "app");
  const names = [...packedPaths(packageJson), ...alwaysPackedNames(appRoot)];
  for (const name of names) {
    const stat = lstatSync(join(appRoot, ...name.split("/")), { throwIfNoEntry: false });
    if (stat === undefined) continue;
    if (stat.isFile()) files.add(`app/${name}`);
    else if (stat.isDirectory()) prefixes.push(`app/${name}/`);
  }
  return { files, prefixes };
}
