import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  type Stats,
} from "node:fs";
import {
  inspectWindowsOwnerPrivateFiles,
  windowsOwnerPrivateVerdict,
  type WindowsOwnerPrivateFacts,
  type WindowsOwnerPrivateInspection,
} from "@oscharko-dev/keiko-security/windows-owner-private";

/**
 * One reader for the operator's registries in Keiko's state directory (the MCP server registry,
 * the native plugin registry): a file owned by the user Keiko runs as and writable by nobody else,
 * opened without following a link and checked on the open descriptor, so the bytes read are the
 * bytes of the file that was checked. A missing file is `undefined`; a file Keiko cannot trust is a
 * closed refusal, never a partial read.
 *
 * POSIX answers "owner-private" from the descriptor's uid and mode. Windows has neither, so there
 * the answer comes from the file's security descriptor, inspected on a handle that does not follow
 * a reparse point and bound to this descriptor by volume serial and file index (#4068).
 */
export const OWNER_PRIVATE_FILE_REFUSALS = [
  "not-regular-file",
  "not-owner-private",
  "too-large",
] as const;
export type OwnerPrivateFileRefusal = (typeof OWNER_PRIVATE_FILE_REFUSALS)[number];

/** A registry file Keiko refuses, with the closed reason; the message never quotes the file. */
export class OwnerPrivateFileRefused extends Error {
  public constructor(public readonly reason: OwnerPrivateFileRefusal) {
    super(`owner-private-file-${reason}`);
    this.name = "OwnerPrivateFileRefused";
  }
}

/** Reads files named up front; on Windows all of them are inspected by one process. */
export interface OwnerPrivateReader {
  readonly read: (path: string, maxBytes: number) => Buffer | undefined;
}

export interface OwnerPrivateReaderOptions {
  readonly platform?: NodeJS.Platform | undefined;
  readonly inspect?: typeof inspectWindowsOwnerPrivateFiles | undefined;
}

type OwnerPrivateCheck = (descriptor: number, stat: Stats) => void;

export function readOwnerPrivateFile(path: string, maxBytes: number): Buffer | undefined {
  return ownerPrivateReaderFor([path]).read(path, maxBytes);
}

/**
 * A reader for `paths`. On Windows the existing ones are inspected by one process on first read,
 * and a path outside the set is refused rather than inspected late; POSIX checks each descriptor.
 */
export function ownerPrivateReaderFor(
  paths: readonly string[],
  options: OwnerPrivateReaderOptions = {},
): OwnerPrivateReader {
  const check =
    (options.platform ?? process.platform) === "win32"
      ? windowsCheck(paths, options.inspect ?? inspectWindowsOwnerPrivateFiles)
      : posixCheck;
  return { read: (path, maxBytes) => readChecked(path, maxBytes, check) };
}

function readChecked(
  path: string,
  maxBytes: number,
  check: (path: string) => OwnerPrivateCheck,
): Buffer | undefined {
  const probe = lstatSync(path, { throwIfNoEntry: false });
  if (probe === undefined) return undefined;
  if (!probe.isFile()) throw new OwnerPrivateFileRefused("not-regular-file");
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return readCheckedDescriptor(descriptor, maxBytes, check(path));
  } finally {
    closeSync(descriptor);
  }
}

function posixCheck(): OwnerPrivateCheck {
  return (_descriptor, stat) => {
    const ownUid = typeof process.getuid === "function" ? process.getuid() : stat.uid;
    if (stat.uid !== ownUid || (stat.mode & 0o022) !== 0)
      throw new OwnerPrivateFileRefused("not-owner-private");
  };
}

function windowsCheck(
  paths: readonly string[],
  inspect: typeof inspectWindowsOwnerPrivateFiles,
): (path: string) => OwnerPrivateCheck {
  const existing = paths.filter((path) => lstatSync(path, { throwIfNoEntry: false })?.isFile());
  let inspection: WindowsOwnerPrivateInspection | undefined;
  const factsFor = (path: string): WindowsOwnerPrivateFacts => {
    const index = existing.indexOf(path);
    if (index < 0) return { kind: "unavailable" };
    inspection ??= inspectOrRefuse(existing, inspect);
    return inspection.files[index] ?? { kind: "unavailable" };
  };
  return (path) => (descriptor) => {
    const facts = factsFor(path);
    const opened = fstatSync(descriptor, { bigint: true });
    const principal = inspection?.principal;
    if (principal === undefined) throw new OwnerPrivateFileRefused("not-owner-private");
    const verdict = windowsOwnerPrivateVerdict(facts, principal, opened);
    if (verdict.kind === "owner-private") return;
    throw new OwnerPrivateFileRefused(
      verdict.reason === "not-regular-file" ? "not-regular-file" : "not-owner-private",
    );
  };
}

// An inspection that cannot run at all proves nothing: every file is refused (owner decision).
function inspectOrRefuse(
  paths: readonly string[],
  inspect: typeof inspectWindowsOwnerPrivateFiles,
): WindowsOwnerPrivateInspection {
  try {
    return inspect(paths);
  } catch {
    throw new OwnerPrivateFileRefused("not-owner-private");
  }
}

function readCheckedDescriptor(
  descriptor: number,
  maxBytes: number,
  ownerPrivate: OwnerPrivateCheck,
): Buffer {
  const stat = fstatSync(descriptor);
  if (!stat.isFile()) throw new OwnerPrivateFileRefused("not-regular-file");
  ownerPrivate(descriptor, stat);
  if (stat.size > maxBytes) throw new OwnerPrivateFileRefused("too-large");
  const buffer = Buffer.alloc(stat.size);
  let offset = 0;
  while (offset < buffer.length) {
    const count = readSync(descriptor, buffer, offset, buffer.length - offset, null);
    if (count === 0) break;
    offset += count;
  }
  return buffer.subarray(0, offset);
}
