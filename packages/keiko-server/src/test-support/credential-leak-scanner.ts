// A scanner that looks for a planted credential in everything a run could read (#4522). A test that
// claims "the credential never reached the run" is only as strong as the spellings it can see, so
// the spellings live here, with a unit test that plants each one and proves a leak is reported.
// Shared fixture modules live under `src/test-support/` (KEIKO-0130); this one imports no other
// test-support module (ADR-0019 trust rule 8) and nothing outside tests may import it.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, sep } from "node:path";

/** A spelling shorter than this is ordinary bytes, not evidence of a credential. */
const SPELLING_MIN_CHARS = 8;
const DEFAULT_MAX_FILE_BYTES = 16 * 1024 * 1024;
const DEFAULT_MIN_INTERVAL_MS = 1_000;

function base64Digits(bytes: Buffer, alphabet: "base64" | "base64url"): string {
  return bytes.toString(alphabet);
}

/**
 * Every base64 and base64url spelling a secret can take inside a larger encoded stream. A secret
 * that starts at byte `k` (mod 3) of the encoded data shares only its complete 3-byte groups with
 * its own standalone encoding, so those groups are taken from the encoding of the secret behind
 * `k` filler bytes: alignment 0, 1 and 2, in both alphabets, plus the standalone padded form.
 */
export function base64Spellings(secret: string): readonly string[] {
  const data = Buffer.from(secret, "utf8");
  const found = new Set<string>();
  for (const alphabet of ["base64", "base64url"] as const) {
    found.add(base64Digits(data, alphabet));
    for (const alignment of [0, 1, 2]) {
      const framed = Buffer.concat([Buffer.alloc(alignment, 0x41), data]);
      const encoded = base64Digits(framed, alphabet);
      const firstGroup = alignment === 0 ? 0 : 1;
      const endGroup = Math.floor(framed.length / 3);
      found.add(encoded.slice(4 * firstGroup, 4 * endGroup));
    }
  }
  return [...found].filter((spelling) => spelling.length >= SPELLING_MIN_CHARS);
}

/** The secret as written, and its base64 and base64url spellings at every alignment. */
export function secretSpellings(secret: string): readonly string[] {
  return [secret, ...base64Spellings(secret)];
}

/** A login's password and its `user:password` pair, each in every spelling. */
export function credentialSpellings(secret: string, username?: string): readonly string[] {
  const pair = username === undefined ? [] : secretSpellings(`${username}:${secret}`);
  return [...new Set([...secretSpellings(secret), ...pair])];
}

export interface CredentialFootprint {
  readonly scanCount: number;
  readonly settingsFilesScanned: number;
  readonly leakedFileCount: number;
  readonly leakedLogLineCount: number;
}

export interface CredentialScannerOptions {
  /** Everything below this directory is read. */
  readonly root: string;
  readonly spellings: readonly string[];
  /** Directory names that hold the credential on purpose and are never entered. */
  readonly skipDirectories?: ReadonlySet<string> | undefined;
  /** Files whose path ends with this are counted as settings files, so a scan cannot be vacuous. */
  readonly settingsSuffix?: string | undefined;
  /** At least this long between two scans; zero scans on every call. */
  readonly minIntervalMs?: number | undefined;
  readonly maxFileBytes?: number | undefined;
}

export interface CredentialScanner {
  readonly scan: () => void;
  readonly result: (logEvents: readonly unknown[]) => CredentialFootprint;
}

function filesBelow(
  directory: string,
  skip: ReadonlySet<string>,
  visit: (path: string) => void,
): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) filesBelow(path, skip, visit);
    else if (entry.isFile()) visit(path);
  }
}

export function createCredentialScanner(options: CredentialScannerOptions): CredentialScanner {
  const skip = options.skipDirectories ?? new Set<string>();
  const needles = options.spellings.map((form) => Buffer.from(form));
  const interval = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
  const maxBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const leaked = new Set<string>();
  const settings = new Set<string>();
  let scans = 0;
  let lastScanMs = Number.NEGATIVE_INFINITY;
  const scan = (): void => {
    if (Date.now() - lastScanMs < interval) return;
    lastScanMs = Date.now();
    scans += 1;
    filesBelow(options.root, skip, (path) => {
      if (
        options.settingsSuffix !== undefined &&
        path.endsWith(`${sep}${options.settingsSuffix}`)
      ) {
        settings.add(path);
      }
      if (statSync(path).size > maxBytes) return;
      const bytes = readFileSync(path);
      if (needles.some((needle) => bytes.includes(needle))) leaked.add(path);
    });
  };
  return {
    scan,
    result: (logEvents) => ({
      scanCount: scans,
      settingsFilesScanned: settings.size,
      leakedFileCount: leaked.size,
      leakedLogLineCount: logEvents.filter((event) => {
        const line = JSON.stringify(event);
        return options.spellings.some((form) => line.includes(form));
      }).length,
    }),
  };
}
